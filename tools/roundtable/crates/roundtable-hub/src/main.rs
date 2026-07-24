use axum::{routing::get, Router};
use std::net::SocketAddr;

async fn healthz() -> &'static str {
    "ok"
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(healthz));
    let address: SocketAddr = "127.0.0.1:8460".parse().expect("valid bind address");
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("bind hub");
    axum::serve(listener, app).await.expect("serve hub");
}
