mod auth;
mod cards;
mod model;
mod reviews;
pub mod scheduler;
#[cfg(test)]
mod tests;

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::any,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool, Postgres, Transaction, postgres::PgPoolOptions};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct App {
    pub db: PgPool,
    origin: String,
    secure: bool,
    secret: Arc<Zeroizing<String>>,
    config: Config,
    client: reqwest::Client,
    translations: Arc<Mutex<HashMap<String, model::TranslationEntry>>>,
    translation_slots: Arc<Semaphore>,
    grading: Arc<Mutex<HashMap<String, model::GradeEntry>>>,
    login_rate: Arc<Mutex<HashMap<String, (Instant, usize)>>>,
    password_slots: Arc<Semaphore>,
    fixture: bool,
}
#[derive(Clone)]
struct Config {
    model_url: String,
    model_key: Arc<Zeroizing<String>>,
    translations_per_day: i32,
    gradings_per_day: i32,
}
#[derive(Clone, Debug)]
pub struct ApiError {
    status: u16,
    code: &'static str,
    message: String,
}
impl ApiError {
    fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(json!({"error":self.message,"code":self.code})),
        )
            .into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        tracing::error!(event = "api_error", category = "database");
        internal()
    }
}
type Result<T> = std::result::Result<T, ApiError>;
impl App {
    pub async fn from_env() -> std::result::Result<Self, String> {
        let database_url = env("DATABASE_URL")?;
        if !database_url.starts_with("postgresql://") && !database_url.starts_with("postgres://") {
            return Err("Invalid DATABASE_URL.".into());
        }
        let origin_url =
            reqwest::Url::parse(&env("BETTER_AUTH_URL")?).map_err(|_| "Invalid BETTER_AUTH_URL")?;
        if !matches!(origin_url.scheme(), "https" | "http") || origin_url.host_str().is_none() {
            return Err("Invalid BETTER_AUTH_URL.".into());
        }
        let origin = origin_url.origin().ascii_serialization();
        if origin_url.scheme() != "https"
            && !matches!(
                origin_url.host_str(),
                Some("localhost" | "127.0.0.1" | "[::1]")
            )
        {
            return Err("Non-local access requires HTTPS.".into());
        }
        let secret = env("BETTER_AUTH_SECRET")?;
        if secret.encode_utf16().count() < 32 || secret.starts_with("replace-") {
            return Err("Invalid BETTER_AUTH_SECRET.".into());
        }
        if env_default("MODEL_NAME", model::MODEL) != model::MODEL {
            return Err("Invalid MODEL_NAME.".into());
        }
        let model_url = env_default("MODEL_BASE_URL", "http://127.0.0.1:18317/v1");
        let parsed = reqwest::Url::parse(&model_url).map_err(|_| "Invalid MODEL_BASE_URL")?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err("Invalid MODEL_BASE_URL.".into());
        }
        let db = PgPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(5))
            .idle_timeout(Duration::from_secs(30))
            .after_connect(|c, _| {
                Box::pin(async move {
                    sqlx::query("SET statement_timeout='5s'").execute(c).await?;
                    Ok(())
                })
            })
            .connect(&database_url)
            .await
            .map_err(|_| "Could not connect to the application database.")?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(2)
            .build()
            .map_err(|_| "Could not initialize the model HTTP client.")?;
        Ok(Self {
            db,
            origin,
            secure: origin_url.scheme() == "https",
            secret: Arc::new(Zeroizing::new(secret)),
            config: Config {
                model_url,
                model_key: Arc::new(Zeroizing::new(env_default("MODEL_API_KEY", ""))),
                translations_per_day: env_num("TRANSLATIONS_PER_DAY", 100, 1, 1000)?,
                gradings_per_day: env_num("GRADINGS_PER_DAY", 100, 2, 1000)?,
            },
            client,
            translations: Arc::new(Mutex::new(HashMap::new())),
            translation_slots: Arc::new(Semaphore::new(2)),
            grading: Arc::new(Mutex::new(HashMap::new())),
            login_rate: Arc::new(Mutex::new(HashMap::new())),
            password_slots: Arc::new(Semaphore::new(2)),
            fixture: std::env::var("NODE_ENV").as_deref() != Ok("production")
                && std::env::var("WEBCARDS_E2E_FIXTURE").as_deref() == Ok("1"),
        })
    }
    pub fn router(self) -> Router {
        Router::new()
            .route("/api/session", any(session_route))
            .route("/api/auth/{*path}", any(auth_route))
            .route("/api/cards", any(cards_route))
            .route("/api/cards/{id}", any(card_route))
            .route("/api/reviews", any(reviews_route))
            .route("/api/translate", any(translate_route))
            .fallback(not_found)
            .layer(middleware::from_fn(security_headers))
            .with_state(Arc::new(self))
    }
    fn check_origin(&self, h: &HeaderMap) -> Result<()> {
        if h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(self.origin.as_str()) {
            return Err(ApiError::new(403, "origin", "Untrusted origin."));
        }
        Ok(())
    }
    async fn transaction(&self, owner: &str) -> Result<Transaction<'_, Postgres>> {
        let mut tx = self.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,7422026))")
            .bind(owner)
            .execute(&mut *tx)
            .await?;
        Ok(tx)
    }
}
#[derive(Clone)]
struct Session {
    id: String,
    user_id: String,
    public: Value,
    cookie: String,
}
fn json_response(value: Value) -> Response {
    Json(value).into_response()
}
fn internal() -> ApiError {
    ApiError::new(
        503,
        "unavailable",
        "Webcards is temporarily unavailable. Please retry.",
    )
}
fn validation(message: &str) -> ApiError {
    ApiError::new(400, "validation", message)
}
fn env(key: &str) -> std::result::Result<String, String> {
    std::env::var(key).map_err(|_| format!("Missing required configuration: {key}"))
}
fn env_default(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.into())
}
fn env_num(key: &str, default: i32, min: i32, max: i32) -> std::result::Result<i32, String> {
    let v = std::env::var(key)
        .map(|s| s.parse().map_err(|_| format!("Invalid {key}")))
        .unwrap_or(Ok(default))?;
    if !(min..=max).contains(&v) {
        return Err(format!("Invalid {key}"));
    }
    Ok(v)
}
fn iso(date: DateTime<Utc>) -> String {
    date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn method_allowed(method: &Method, allowed: &[Method]) -> Result<()> {
    if !allowed.contains(method) {
        return Err(ApiError::new(405, "method", "Method not allowed."));
    }
    Ok(())
}
async fn read_json(request: Request, max: usize) -> Result<Value> {
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .map(str::trim)
        != Some("application/json")
    {
        return Err(ApiError::new(415, "content_type", "Expected JSON."));
    }
    let bytes = to_bytes(request.into_body(), max)
        .await
        .map_err(|_| ApiError::new(413, "too_large", "Request is too large."))?;
    serde_json::from_slice(&bytes).map_err(|_| ApiError::new(400, "invalid_json", "Invalid JSON."))
}
async fn security_headers(request: Request, next: Next) -> Response {
    let (parts, body) = request.into_parts();
    let mut response =
        match tokio::time::timeout(Duration::from_secs(15), to_bytes(body, 16_384)).await {
            Ok(Ok(bytes)) => {
                next.run(Request::from_parts(parts, Body::from(bytes)))
                    .await
            }
            Ok(Err(_)) => ApiError::new(413, "too_large", "Request is too large.").into_response(),
            Err(_) => ApiError::new(408, "timeout", "Request body timed out.").into_response(),
        };
    let h = response.headers_mut();
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("same-origin"));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    h.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    response
}
async fn not_found() -> ApiError {
    ApiError::new(404, "not_found", "Not found.")
}
async fn session_route(State(app): State<Arc<App>>, request: Request) -> Result<Response> {
    method_allowed(request.method(), &[Method::GET, Method::HEAD])?;
    let session = app.owner(request.headers()).await?;
    let mut response = json_response(json!({"authenticated":session.is_some()}));
    if let Some(session) = session {
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&session.cookie).map_err(|_| internal())?,
        );
    }
    Ok(response)
}
async fn auth_route(
    State(app): State<Arc<App>>,
    Path(path): Path<String>,
    request: Request,
) -> Result<Response> {
    app.auth(request, &path).await
}
async fn card_route(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response> {
    cards::handler(app, Some(id), request).await
}
async fn cards_route(State(app): State<Arc<App>>, request: Request) -> Result<Response> {
    cards::handler(app, None, request).await
}
async fn reviews_route(State(app): State<Arc<App>>, request: Request) -> Result<Response> {
    reviews::handler(app, request).await
}
async fn translate_route(State(app): State<Arc<App>>, request: Request) -> Result<Response> {
    model::translation_handler(app, request).await
}
