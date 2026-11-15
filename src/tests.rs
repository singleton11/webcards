use super::*;
use tower::ServiceExt;
fn app() -> App {
    App {
        db: PgPoolOptions::new()
            .connect_lazy("postgresql://fixture@127.0.0.1:1/unused")
            .unwrap(),
        origin: "http://127.0.0.1:3000".into(),
        secure: false,
        secret: Arc::new(Zeroizing::new(
            "isolated-test-secret-not-for-deployment-1234".into(),
        )),
        config: Config {
            model_url: "http://127.0.0.1:1/v1".into(),
            model_key: Arc::new(Zeroizing::new("fixture-only".into())),
            translations_per_day: 100,
            gradings_per_day: 100,
        },
        client: reqwest::Client::new(),
        translations: Arc::new(Mutex::new(HashMap::new())),
        translation_slots: Arc::new(Semaphore::new(2)),
        grading: Arc::new(Mutex::new(HashMap::new())),
        login_rate: Arc::new(Mutex::new(HashMap::new())),
        password_slots: Arc::new(Semaphore::new(2)),
        fixture: false,
    }
}
#[tokio::test]
async fn rejects_missing_routes_and_unsupported_methods_without_database_access() {
    let router = app().router();
    for (method, path, status) in [
        ("GET", "/api/no-such-route", 404),
        ("GET", "/api/translate", 405),
        ("DELETE", "/api/cards", 405),
        ("PUT", "/api/reviews", 405),
        ("POST", "/api/session", 405),
        ("DELETE", "/api/auth/sign-out", 405),
        ("GET", "/", 404),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status, "{method} {path}");
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    }
}
#[tokio::test]
async fn body_limit_precedes_authentication() {
    let response = app()
        .router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/sign-in/username")
                .body(Body::from(vec![b'x'; 20_000]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 413);
}
#[tokio::test]
async fn sessions_fail_closed_and_mutations_require_origin() {
    let router = app().router();
    let r = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/session")
                .header("cookie", "better-auth.session_token=unsigned.attacker")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let json: Value =
        serde_json::from_slice(&to_bytes(r.into_body(), 8192).await.unwrap()).unwrap();
    assert_eq!(json, json!({"authenticated":false}));
    for path in [
        "/api/auth/sign-in/username",
        "/api/auth/sign-out",
        "/api/translate",
        "/api/reviews",
        "/api/cards",
    ] {
        let r = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("origin", "https://attacker.invalid")
                    .header("x-forwarded-for", "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), 403, "{path}");
    }
}
#[tokio::test]
async fn spoofed_forwarding_headers_cannot_bypass_login_limit() {
    let router = app().router();
    for i in 0..6 {
        let r = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/sign-in/username")
                    .header("origin", "http://127.0.0.1:3000")
                    .header("content-type", "application/json")
                    .header("x-forwarded-for", format!("192.0.2.{i}"))
                    .header("user-agent", format!("fixture-{i}"))
                    .body(Body::from(r#"{"username":"missing-password"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), if i < 5 { 401 } else { 429 });
    }
}
