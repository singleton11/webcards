use super::*;
use axum::extract::Query;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::NaiveTime;
use futures_util::{StreamExt, stream};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use web_push::{
    ContentEncoding, PartialVapidSignatureBuilder, SubscriptionInfo, VapidSignatureBuilder,
    WebPushMessageBuilder, request_builder,
};

pub(crate) struct Push {
    key: PartialVapidSignatureBuilder,
    public_key: String,
    subject: String,
}

impl Push {
    pub(crate) fn from_env(origin: &str) -> std::result::Result<Option<Self>, String> {
        let private = Zeroizing::new(env_default("WEBCARDS_VAPID_PRIVATE_KEY", ""));
        if private.is_empty() {
            return Ok(None);
        }
        let key = VapidSignatureBuilder::from_base64_no_sub(&private)
            .map_err(|_| "Invalid WEBCARDS_VAPID_PRIVATE_KEY.")?;
        let public_key = URL_SAFE_NO_PAD.encode(key.get_public_key());
        Ok(Some(Self {
            key,
            public_key,
            subject: origin.to_owned(),
        }))
    }

    fn message(
        &self,
        subscription: &SubscriptionInfo,
    ) -> std::result::Result<reqwest::Request, web_push::WebPushError> {
        let mut signature = self.key.clone().add_sub_info(subscription);
        signature.add_claim("sub", self.subject.as_str());
        let mut builder = WebPushMessageBuilder::new(subscription);
        builder.set_vapid_signature(signature.build()?);
        builder.set_ttl(1800);
        builder.set_topic("webcards-evening-review".into());
        builder.set_payload(ContentEncoding::Aes128Gcm, b"review");
        let request = request_builder::build_request::<reqwest::Body>(builder.build()?);
        let (parts, body) = request.into_parts();
        let mut request = reqwest::Request::new(
            Method::POST,
            reqwest::Url::parse(subscription.endpoint.as_str())
                .map_err(|_| web_push::WebPushError::InvalidUri)?,
        );
        for (name, value) in &parts.headers {
            if let (Ok(name), Ok(value)) = (
                header::HeaderName::from_bytes(name.as_str().as_bytes()),
                HeaderValue::from_bytes(value.as_bytes()),
            ) {
                request.headers_mut().append(name, value);
            }
        }
        *request.body_mut() = Some(body);
        *request.timeout_mut() = Some(Duration::from_secs(10));
        Ok(request)
    }
}

#[derive(Deserialize)]
pub(crate) struct Device {
    device: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum Command {
    Enable {
        time: String,
        #[serde(rename = "timeZone")]
        time_zone: String,
        subscription: SubscriptionInfo,
    },
    Disable,
}

fn valid_endpoint(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.as_str() == endpoint
        && url.host_str().is_some_and(|host| {
            matches!(
                host,
                "fcm.googleapis.com" | "updates.push.services.mozilla.com"
            ) || host.ends_with(".push.apple.com")
                || host.ends_with(".notify.windows.com")
        })
}

pub(crate) async fn route(
    State(app): State<Arc<App>>,
    Query(Device { device }): Query<Device>,
    request: Request,
) -> Result<Response> {
    method_allowed(request.method(), &[Method::GET, Method::POST])?;
    let write = request.method() == Method::POST;
    if write {
        app.check_origin(request.headers())?;
    }
    let owner = app
        .owner(request.headers())
        .await?
        .ok_or_else(|| ApiError::new(401, "unauthorized", "Sign in to manage reminders."))?;
    let id = device.as_deref();
    if id.is_some_and(|id| id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit())) {
        return Err(validation("Invalid reminder device."));
    }
    if !write {
        let reminder = if let Some(id) = id {
            sqlx::query_as::<_, (NaiveTime, String)>(
                "SELECT local_time, time_zone FROM push_reminders WHERE device=$1 AND owner_id=$2",
            )
            .bind(id)
            .bind(&owner.user_id)
            .fetch_optional(&app.db)
            .await?
            .map(|(time, zone)| json!({"time": time.format("%H:%M").to_string(), "timeZone": zone}))
        } else {
            None
        };
        return Ok(json_response(
            json!({"publicKey": app.push.as_ref().map(|p| &p.public_key), "reminder": reminder}),
        ));
    }

    let id = id.ok_or_else(|| validation("Missing reminder device."))?;
    let command = serde_json::from_value(read_json(request, 4096).await?)
        .map_err(|_| validation("Invalid reminder settings."))?;
    match command {
        Command::Enable {
            time,
            time_zone,
            subscription,
        } => {
            let push = app.push.as_ref().ok_or_else(|| {
                ApiError::new(
                    503,
                    "push_unavailable",
                    "Evening reminders are temporarily unavailable.",
                )
            })?;
            let time_value = NaiveTime::parse_from_str(&time, "%H:%M")
                .ok()
                .filter(|value| value.format("%H:%M").to_string() == time)
                .ok_or_else(|| validation("Choose a valid reminder time."))?;
            if time_zone.parse::<chrono_tz::Tz>().is_err() {
                return Err(validation("Invalid reminder time zone."));
            }
            if subscription.endpoint.len() > 2048
                || !valid_endpoint(&subscription.endpoint)
                || hex::encode(Sha256::digest(subscription.endpoint.as_bytes())) != id
                || push.message(&subscription).is_err()
            {
                return Err(validation(
                    "This browser push subscription could not be used.",
                ));
            }
            let mut tx = app.transaction(&owner.user_id).await?;
            let changed = sqlx::query(
                "WITH schedule AS (
                    SELECT ((now() AT TIME ZONE $5)::date + $4::time) AT TIME ZONE $5 AS today,
                           (((now() AT TIME ZONE $5)::date + 1) + $4::time) AT TIME ZONE $5 AS tomorrow
                )
                INSERT INTO push_reminders AS r (device, owner_id, subscription, local_time, time_zone, next_at, revision)
                SELECT $1, $2, $3, $4, $5, CASE WHEN today > now() THEN today ELSE tomorrow END, $6
                FROM schedule
                WHERE EXISTS (SELECT 1 FROM push_reminders WHERE device=$1 AND owner_id=$2)
                   OR (SELECT count(*) FROM push_reminders WHERE owner_id=$2) < 10
                ON CONFLICT (device) DO UPDATE SET
                    subscription=EXCLUDED.subscription,
                    local_time=EXCLUDED.local_time,
                    time_zone=EXCLUDED.time_zone,
                    next_at=CASE
                        WHEN r.local_time=$4 AND r.time_zone=$5 THEN r.next_at
                        WHEN (r.last_attempt_at AT TIME ZONE $5)::date = (now() AT TIME ZONE $5)::date
                            THEN (SELECT tomorrow FROM schedule)
                        ELSE EXCLUDED.next_at END,
                    revision=EXCLUDED.revision
                WHERE r.owner_id=EXCLUDED.owner_id AND
                    (r.subscription, r.local_time, r.time_zone) IS DISTINCT FROM
                    (EXCLUDED.subscription, EXCLUDED.local_time, EXCLUDED.time_zone)
                RETURNING device",
            )
            .bind(id)
            .bind(&owner.user_id)
            .bind(sqlx::types::Json(subscription))
            .bind(time_value)
            .bind(&time_zone)
            .bind(Uuid::new_v4())
            .fetch_optional(&mut *tx)
            .await?;
            if changed.is_none()
                && !sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS (SELECT 1 FROM push_reminders WHERE device=$1 AND owner_id=$2)",
                )
                .bind(id)
                .bind(&owner.user_id)
                .fetch_one(&mut *tx)
                .await?
            {
                return Err(ApiError::new(
                    409,
                    "reminder_conflict",
                    "This browser is linked to another Webcards account, or your account has reached its reminder device limit.",
                ));
            }
            tx.commit().await?;
            Ok(json_response(
                json!({"reminder": {"time": time, "timeZone": time_zone}}),
            ))
        }
        Command::Disable => {
            let mut tx = app.transaction(&owner.user_id).await?;
            sqlx::query("DELETE FROM push_reminders WHERE device=$1 AND owner_id=$2")
                .bind(id)
                .bind(&owner.user_id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            Ok(json_response(json!({"reminder": null})))
        }
    }
}

impl App {
    pub async fn run_reminders(self) {
        let Some(push) = &self.push else { return };
        let mut ticks = tokio::time::interval(Duration::from_secs(30));
        loop {
            ticks.tick().await;
            if self.deliver_reminders(push).await.is_err() {
                tracing::warn!(event = "reminder_poll_failed");
            }
        }
    }

    async fn deliver_reminders(&self, push: &Push) -> std::result::Result<(), sqlx::Error> {
        // Advance the schedule before sending so concurrent workers and restarts cannot resend a claim.
        // An overdue reminder expires after an hour. Recompute from the current local date after downtime.
        let reminders = sqlx::query_as::<_, (String, Uuid, sqlx::types::Json<SubscriptionInfo>, bool)>(
            "WITH due AS (
                SELECT device, next_at >= now() - interval '1 hour' AS fresh,
                       ((now() AT TIME ZONE time_zone)::date + local_time) AT TIME ZONE time_zone AS today,
                       (((now() AT TIME ZONE time_zone)::date + 1) + local_time) AT TIME ZONE time_zone AS tomorrow
                FROM push_reminders WHERE next_at <= now()
                ORDER BY next_at LIMIT 20 FOR UPDATE SKIP LOCKED
            )
            UPDATE push_reminders AS r SET
                next_at=CASE WHEN due.today > now() THEN due.today ELSE due.tomorrow END,
                last_attempt_at=CASE WHEN due.fresh THEN now() ELSE r.last_attempt_at END
            FROM due WHERE r.device=due.device
            RETURNING r.device, r.revision, r.subscription, due.fresh",
        )
        .fetch_all(&self.db)
        .await?;
        stream::iter(reminders)
            .filter(|(_, _, _, fresh)| std::future::ready(*fresh))
            .for_each_concurrent(5, |(id, revision, subscription, _)| async move {
                if let Err(error) = self.send_reminder(push, &id, revision, &subscription).await {
                    tracing::warn!(event = "reminder_delivery_failed", reason = error);
                }
            })
            .await;
        Ok(())
    }

    async fn send_reminder(
        &self,
        push: &Push,
        id: &str,
        revision: Uuid,
        subscription: &SubscriptionInfo,
    ) -> std::result::Result<(), &'static str> {
        if !valid_endpoint(&subscription.endpoint) {
            return Err("invalid_endpoint");
        }
        if !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM push_reminders WHERE device=$1 AND revision=$2)",
        )
        .bind(id)
        .bind(revision)
        .fetch_one(&self.db)
        .await
        .map_err(|_| "database")?
        {
            return Ok(());
        }
        let response = self
            .client
            .execute(push.message(subscription).map_err(|_| "encryption")?)
            .await
            .map_err(|_| "transport")?;
        match response.status() {
            StatusCode::NOT_FOUND | StatusCode::GONE => {
                sqlx::query("DELETE FROM push_reminders WHERE device=$1 AND revision=$2")
                    .bind(id)
                    .bind(revision)
                    .execute(&self.db)
                    .await
                    .map_err(|_| "database")?;
            }
            status if status.is_success() => {}
            _ => return Err("push_service"),
        }
        Ok(())
    }
}
