use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Duration,
};
use webcards_api::App;
#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter("webcards_api=info")
        .with_current_span(false)
        .init();
    let app = App::from_env().await.map_err(std::io::Error::other)?;
    let port = std::env::var("PORT")
        .unwrap_or_else(|_| "3001".into())
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)
        .ok_or("Invalid PORT.")?;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(event = "api_listening", address = "127.0.0.1", port);
    let db = app.db.clone();
    let reminder_worker = tokio::spawn(app.clone().run_reminders());
    let result = axum::serve(listener, app.router())
        .with_graceful_shutdown(async {
            #[cfg(unix)]
            {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("SIGTERM handler");
                tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            tokio::spawn(async {
                tokio::time::sleep(Duration::from_secs(25)).await;
                std::process::exit(1);
            });
        })
        .await;
    reminder_worker.abort();
    let _ = reminder_worker.await;
    db.close().await;
    result?;
    Ok(())
}
