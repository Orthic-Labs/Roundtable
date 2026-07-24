#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use roundtable_node::{
    config::NodeConfig,
    secrets::BearerToken,
    state::NodeState,
};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config_path = std::env::var("ROUNDTABLE_NODE_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("config.json"));
    let config_bytes = std::fs::read(&config_path)?;
    let cfg: NodeConfig = serde_json::from_slice(&config_bytes)?;
    let state = Arc::new(Mutex::new(NodeState::load_or_default(&cfg.state_path)?));
    let token = BearerToken::load("ROUNDTABLE_NODE_TOKEN", &PathBuf::from("node.token"))?;
    tracing::info!(node_id = %cfg.node_id, "roundtable-node ready");
    let _ = (cfg, state, token);
    Ok(())
}
