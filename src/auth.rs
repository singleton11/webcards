use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use rand::{Rng, distr::Alphanumeric};
use scrypt::{Params, scrypt};
use sha2::Sha256;
use sqlx::Row;
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;

impl App {
    pub(crate) async fn owner(&self, headers: &HeaderMap) -> Result<Option<Session>> {
        let name = if self.secure {
            "__Secure-better-auth.session_token"
        } else {
            "better-auth.session_token"
        };
        let Some(cookie) = cookie_value(headers, name) else {
            return Ok(None);
        };
        let Some(token) = verify_cookie(&cookie, &self.secret) else {
            return Ok(None);
        };
        let row=sqlx::query("SELECT s.id,s.\"userId\" AS user_id,s.token,s.\"expiresAt\" AS expires,s.\"createdAt\" AS created,s.\"updatedAt\" AS updated,s.\"ipAddress\" AS ip,s.\"userAgent\" AS agent,u.name,u.email,u.\"emailVerified\" AS verified,u.\"createdAt\" AS user_created,u.\"updatedAt\" AS user_updated,u.username,u.\"displayUsername\" AS display FROM session s JOIN \"user\" u ON u.id=s.\"userId\" JOIN owner_preferences p ON p.owner_id=u.id WHERE s.token=$1 AND s.\"expiresAt\">now() LIMIT 1").bind(&token).fetch_optional(&self.db).await?;
        let Some(r) = row else { return Ok(None) };
        let id: String = r.try_get("id")?;
        let user_id: String = r.try_get("user_id")?;
        let mut expires: DateTime<Utc> = auth_date(&r, "expires")?;
        let created = auth_date(&r, "created")?;
        let mut updated = auth_date(&r, "updated")?;
        let now = Utc::now();
        if now.signed_duration_since(updated) >= chrono::Duration::days(1) {
            expires = now + chrono::Duration::days(7);
            updated = now;
            let changed=sqlx::query("UPDATE session SET \"expiresAt\"=$2,\"updatedAt\"=$3 WHERE id=$1 AND \"expiresAt\">now()")
                .bind(&id).bind(expires).bind(updated).execute(&self.db).await?;
            if changed.rows_affected() == 0 {
                return Ok(None);
            }
        }
        let public = json!({"session":{"id":id,"userId":user_id,"token":token,"expiresAt":iso(expires),"createdAt":iso(created),"updatedAt":iso(updated),"ipAddress":r.try_get::<Option<String>,_>("ip")?,"userAgent":r.try_get::<Option<String>,_>("agent")?},"user":{"id":user_id,"name":r.try_get::<String,_>("name")?,"email":r.try_get::<String,_>("email")?,"emailVerified":r.try_get::<bool,_>("verified")?,"createdAt":iso(auth_date(&r,"user_created")?),"updatedAt":iso(auth_date(&r,"user_updated")?),"username":r.try_get::<Option<String>,_>("username")?,"displayUsername":r.try_get::<Option<String>,_>("display")?}});
        Ok(Some(Session {
            id,
            user_id,
            public,
            cookie: self.session_cookie(
                &sign_cookie(&token, &self.secret),
                (expires - Utc::now()).num_seconds().max(0) as u32,
            ),
        }))
    }
    pub(crate) async fn auth(&self, request: Request, path: &str) -> Result<Response> {
        method_allowed(request.method(), &[Method::GET, Method::POST])?;
        match (request.method().as_str(), path) {
            ("GET", "get-session") => {
                self.auth_rate("get-session", 20).await?;
                let s = self.owner(request.headers()).await?;
                let mut response =
                    json_response(s.as_ref().map(|s| s.public.clone()).unwrap_or(Value::Null));
                if let Some(s) = s {
                    response.headers_mut().insert(
                        header::SET_COOKIE,
                        HeaderValue::from_str(&s.cookie).map_err(|_| internal())?,
                    );
                }
                Ok(response)
            }
            ("POST", "sign-in/username") => {
                self.check_origin(request.headers())?;
                self.sign_in(request).await
            }
            ("POST", "sign-out") => {
                self.check_origin(request.headers())?;
                self.auth_rate("sign-out", 20).await?;
                self.sign_out(request).await
            }
            _ => Err(ApiError::new(404, "not_found", "Not found.")),
        }
    }
    async fn auth_rate(&self, path: &str, limit: usize) -> Result<()> {
        // The shared loopback budget cannot be bypassed with forwarded headers.
        let mut rate = self.login_rate.lock().await;
        let now = Instant::now();
        rate.retain(|_, (start, _)| now.duration_since(*start) < Duration::from_secs(60));
        let entry = rate.entry(path.to_owned()).or_insert((now, 0));
        if entry.1 >= if self.fixture { 100 } else { limit } {
            return Err(ApiError::new(
                429,
                "rate_limit",
                "Too many attempts. Wait a minute before trying again.",
            ));
        }
        entry.1 += 1;
        Ok(())
    }
    async fn sign_in(&self, request: Request) -> Result<Response> {
        self.auth_rate("sign-in", 5).await?;
        let _permit = self
            .password_slots
            .try_acquire()
            .map_err(|_| ApiError::new(429, "busy", "Sign-in is busy. Please retry."))?;
        let agent = request
            .headers()
            .get(header::USER_AGENT)
            .and_then(|s| s.to_str().ok())
            .map(str::to_owned);
        let v = read_json(request, 16_384).await?;
        let username = v["username"]
            .as_str()
            .filter(|s| s.len() <= 30)
            .ok_or_else(invalid_login)?
            .to_lowercase();
        let password = v["password"]
            .as_str()
            .filter(|s| s.encode_utf16().count() <= 128)
            .ok_or_else(invalid_login)?;
        let r=sqlx::query("SELECT u.id,a.password FROM \"user\" u JOIN account a ON a.\"userId\"=u.id AND a.\"providerId\"='credential' JOIN owner_preferences p ON p.owner_id=u.id WHERE u.username=$1 LIMIT 1").bind(&username).fetch_optional(&self.db).await?;
        // An unknown account still incurs the same scrypt work.
        let hash = r
            .as_ref()
            .and_then(|r| r.try_get::<String, _>("password").ok())
            .unwrap_or_else(|| format!("{}:{}", "0".repeat(32), "0".repeat(128)));
        let password = Zeroizing::new(password.to_owned());
        let valid = tokio::task::spawn_blocking(move || verify_password(&password, &hash))
            .await
            .map_err(|_| internal())?;
        if !valid || r.is_none() {
            return Err(invalid_login());
        }
        let user_id: String = r.ok_or_else(invalid_login)?.try_get("id")?;
        let token: String = rand::rng()
            .sample_iter(&Alphanumeric)
            .take(64)
            .map(char::from)
            .collect();
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();
        let expires = now + chrono::Duration::days(7);
        sqlx::query("INSERT INTO session(id,token,\"userId\",\"expiresAt\",\"createdAt\",\"updatedAt\",\"ipAddress\",\"userAgent\") VALUES($1,$2,$3,$4,$5,$5,NULL,$6)").bind(id).bind(&token).bind(&user_id).bind(expires).bind(now).bind(agent).execute(&self.db).await?;
        let mut response = json_response(json!({"redirect":false,"token":token,"url":"/"}));
        let signed = sign_cookie(&token, &self.secret);
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&self.session_cookie(&signed, 604800)).map_err(|_| internal())?,
        );
        Ok(response)
    }
    async fn sign_out(&self, request: Request) -> Result<Response> {
        if let Some(s) = self.owner(request.headers()).await? {
            sqlx::query("DELETE FROM session WHERE id=$1")
                .bind(s.id)
                .execute(&self.db)
                .await?;
        }
        let mut response = json_response(json!({"success":true}));
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&self.session_cookie("", 0)).map_err(|_| internal())?,
        );
        Ok(response)
    }
    fn session_cookie(&self, value: &str, max_age: u32) -> String {
        format!(
            "{}={value}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Lax{}",
            if self.secure {
                "__Secure-better-auth.session_token"
            } else {
                "better-auth.session_token"
            },
            if self.secure { "; Secure" } else { "" }
        )
    }
}
fn auth_date(r: &sqlx::postgres::PgRow, name: &str) -> Result<DateTime<Utc>> {
    Ok(r.try_get(name)?)
}
fn invalid_login() -> ApiError {
    ApiError::new(
        401,
        "INVALID_USERNAME_OR_PASSWORD",
        "Invalid username or password.",
    )
}
fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (k, v) = part.trim().split_once('=')?;
            (k == name).then(|| v.to_owned())
        })
}
fn sign_cookie(token: &str, secret: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC supports any key size");
    mac.update(token.as_bytes());
    let value = format!("{token}.{}", STANDARD.encode(mac.finalize().into_bytes()));
    utf8_percent_encode(&value, NON_ALPHANUMERIC).to_string()
}
fn verify_cookie(cookie: &str, secret: &str) -> Option<String> {
    let decoded = percent_decode_str(cookie).decode_utf8().ok()?;
    let (token, signature) = decoded.rsplit_once('.')?;
    if token.is_empty() {
        return None;
    }
    let signature = STANDARD.decode(signature).ok()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(token.as_bytes());
    mac.verify_slice(&signature).ok()?;
    Some(token.into())
}
fn verify_password(password: &str, encoded: &str) -> bool {
    let Some((salt, key)) = encoded.split_once(':') else {
        return false;
    };
    if salt.len() != 32 || !salt.bytes().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let Ok(key) = hex::decode(key) else {
        return false;
    };
    if key.len() != 64 {
        return false;
    }
    let params = Params::new(14, 16, 1, 64).expect("fixed scrypt parameters");
    let mut out = Zeroizing::new([0u8; 64]);
    let password = Zeroizing::new(password.nfkc().collect::<String>());
    // The salt is the ASCII hex string, not decoded salt bytes.
    scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut *out).is_ok()
        && bool::from(out.as_slice().ct_eq(key.as_slice()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cookies_are_signed_and_tampering_fails() {
        let secret = "test secret";
        let c = sign_cookie("token", secret);
        assert_eq!(verify_cookie(&c, secret).as_deref(), Some("token"));
        assert!(verify_cookie(&c, "wrong").is_none());
        assert!(verify_cookie("token.unsigned", secret).is_none());
    }
    #[test]
    fn node_password_vector() {
        let hash = include_str!("../fixtures/password.txt").trim();
        assert!(verify_password("isolated-password-1234", hash));
        assert!(!verify_password("wrong", hash));
    }
}
