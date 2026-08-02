//! Node configuration loaded from file + env. No secrets in the config file.
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NodeConfig {
    pub hub_url: String,
    pub node_id: uuid::Uuid,
    pub hostname: String,
    pub os: String,
    pub version: String,
    pub ipc_socket_path: PathBuf,
    pub state_path: PathBuf,
    pub codex_command: Vec<String>,
    pub codex_cwd: Option<PathBuf>,
    pub reconnect_base_ms: u64,
    pub heartbeat_ms: u64,
    pub heartbeat_offline_after_ms: u64,
}

impl NodeConfig {
    pub fn reconnect_sequence_ms(&self) -> Vec<u64> {
        vec![
            self.reconnect_base_ms,
            self.reconnect_base_ms * 2,
            self.reconnect_base_ms * 4,
            self.reconnect_base_ms * 8,
            self.reconnect_base_ms * 15,
            self.reconnect_base_ms * 30,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_sequence_is_locked() {
        let cfg = NodeConfig {
            hub_url: "ws://localhost".into(),
            node_id: uuid::Uuid::nil(),
            hostname: "t".into(),
            os: "test".into(),
            version: "0".into(),
            ipc_socket_path: PathBuf::from("/tmp/x"),
            state_path: PathBuf::from("/tmp/y"),
            codex_command: vec!["fake".into()],
            codex_cwd: None,
            reconnect_base_ms: 1000,
            heartbeat_ms: 15000,
            heartbeat_offline_after_ms: 45000,
        };
        assert_eq!(cfg.reconnect_sequence_ms(), vec![1000, 2000, 4000, 8000, 15000, 30000]);
    }

    #[test]
    fn config_round_trips_via_json() {
        let cfg = NodeConfig {
            hub_url: "ws://localhost".into(),
            node_id: uuid::Uuid::nil(),
            hostname: "t".into(),
            os: "test".into(),
            version: "0".into(),
            ipc_socket_path: PathBuf::from("/tmp/x"),
            state_path: PathBuf::from("/tmp/y"),
            codex_command: vec!["fake".into()],
            codex_cwd: None,
            reconnect_base_ms: 1000,
            heartbeat_ms: 15000,
            heartbeat_offline_after_ms: 45000,
        };
        let bytes = serde_json::to_vec(&cfg).unwrap();
        let back: NodeConfig = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(cfg, back);
    }
}
