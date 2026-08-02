use citadel_hub::{app, AppConfig, AppState};
use citadel_store::Store;
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let database =
        std::env::var("ROUND_TABLE_DATABASE").unwrap_or_else(|_| "roundtable.sqlite3".into());
    let admin_token =
        std::env::var("ROUND_TABLE_ADMIN_TOKEN").expect("ROUND_TABLE_ADMIN_TOKEN is required");
    let bind = std::env::var("ROUND_TABLE_BIND").unwrap_or_else(|_| "127.0.0.1:8460".into());
    let store = Store::open(database).await.expect("open Citadel store");
    let state = AppState::new(store, &admin_token, AppConfig::default());
    let listener =
        tokio::net::TcpListener::bind(bind.parse::<SocketAddr>().expect("valid ROUND_TABLE_BIND"))
            .await
            .expect("bind Citadel hub");
    axum::serve(listener, app(state)).await.expect("serve hub");
}
