//! Citadel node library entry point.
pub mod config;
pub mod env_compat;
pub mod hub;
pub mod ipc;
pub mod secrets;
pub mod state;
pub mod codex;

pub use config::NodeConfig;
pub use state::{NodeState, DeliveryRecord, CursorRecord};
pub use hub::{HubClient, HubEvent, HubCommand, HubTransport, TcpHubChannel, ReconnectPolicy, ClientCommand};
pub use secrets::BearerToken;
pub use ipc::{IpcServer, IpcRequest, IpcResponse, IpcNotification};
pub use codex::{CodexAdapter, CodexEvent, CodexCommand, CodexTurnStatus};

#[derive(Debug, thiserror::Error)]
pub enum NodeError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("hub transport closed")]
    HubClosed,
    #[error("hub rejected hello: {0}")]
    HubRejected(String),
    #[error("protocol version mismatch: hub={hub} node={node}")]
    ProtocolVersion { hub: u16, node: u16 },
    #[error("invalid frame: {0}")]
    InvalidFrame(String),
    #[error("provider error: {0}")]
    Provider(String),
    #[error("unknown seat {0}")]
    UnknownSeat(uuid::Uuid),
    #[error("lease expired for delivery {0}")]
    LeaseExpired(uuid::Uuid),
    #[error("cancelled by hub")]
    Cancelled,
    #[error("duplicate delivery {0}")]
    DuplicateDelivery(uuid::Uuid),
}

pub type NodeResult<T> = Result<T, NodeError>;
