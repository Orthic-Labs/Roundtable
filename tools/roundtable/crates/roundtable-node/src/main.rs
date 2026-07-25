#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use roundtable_node::{
    config::NodeConfig,
    hub::{HubClient, HubEvent, HubTransport, TcpHubChannel, WsHubChannel},
    secrets::BearerToken,
    state::NodeState,
    NodeError, NodeResult,
};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Without this the node runs completely silent — every tracing call is discarded and an
    // operator has no way to tell a connected node from a wedged one. Defaults to info.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config_path = std::env::var("ROUNDTABLE_NODE_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("config.json"));
    let config_bytes = std::fs::read(&config_path)?;
    let cfg: NodeConfig = serde_json::from_slice(&config_bytes)?;
    let state = Arc::new(Mutex::new(NodeState::load_or_default(&cfg.state_path)?));
    let token = BearerToken::load("ROUNDTABLE_NODE_TOKEN", &PathBuf::from("node.token"))?;

    let url = cfg.hub_url.clone();

    // The driver asks for a transport synchronously — `(self.transport_factory)()` — but dialling
    // a WebSocket is async. `block_in_place` hands this worker thread to a blocking call while the
    // rest of the runtime carries on; it needs the multi-thread runtime, which `#[tokio::main]`
    // provides. This runs once per connect attempt, not per frame.
    let factory: Arc<dyn Fn() -> NodeResult<Box<dyn HubTransport>> + Send + Sync> =
        Arc::new(move || {
            let url = url.clone();
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async move {
                    if url.starts_with("ws://") || url.starts_with("wss://") {
                        Ok(Box::new(WsHubChannel::connect(&url).await?) as Box<dyn HubTransport>)
                    } else {
                        // A bare host:port keeps the raw-TCP fixture path usable for local tests.
                        let stream = tokio::net::TcpStream::connect(&url).await.map_err(|e| {
                            NodeError::InvalidFrame(format!("tcp connect {url}: {e}"))
                        })?;
                        Ok(Box::new(TcpHubChannel::new(stream)) as Box<dyn HubTransport>)
                    }
                })
            })
        });

    let client = HubClient::new(cfg.clone(), token.expose().to_string(), state, factory);
    tracing::info!(node_id = %cfg.node_id, hub = %cfg.hub_url, "roundtable-node connecting");

    // Drain hub events for the life of the process. HubClient::new already spawned the driver,
    // which owns reconnect and cursor replay; this loop keeps the binary alive and is where seat
    // routing attaches next.
    while let Some(event) = client.next_event().await {
        match event {
            HubEvent::HelloAccepted(accepted) => {
                tracing::info!(
                    seats = accepted.seat_tokens.len(),
                    resume_cursor = accepted.resume_cursor,
                    "hub accepted",
                );
            }
            HubEvent::Ping { nonce } => tracing::debug!(%nonce, "ping"),
            other => tracing::info!(?other, "hub event"),
        }
    }

    tracing::warn!("hub event stream ended; exiting");
    Ok(())
}
