use citadel_protocol::human_actor_id;
use citadel_store::Store;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub origin: String,
    pub secure_cookie: bool,
    pub session_ttl_ms: i64,
    pub heartbeat_ms: i64,
    pub node_timeout_ms: i64,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            origin: "https://citadel.spoares.com".into(),
            secure_cookie: true,
            session_ttl_ms: 30 * 24 * 60 * 60 * 1_000,
            heartbeat_ms: 15_000,
            node_timeout_ms: 45_000,
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub admin_token_hash: Arc<[u8; 32]>,
    pub config: Arc<AppConfig>,
    pub human_actor_id: Uuid,
}

impl AppState {
    pub fn new(store: Store, admin_token: &str, config: AppConfig) -> Self {
        Self {
            store,
            admin_token_hash: Arc::new(crate::auth::hash_secret_bytes(admin_token)),
            config: Arc::new(config),
            human_actor_id: human_actor_id(),
        }
    }
}
