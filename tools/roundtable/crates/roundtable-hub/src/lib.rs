#[deprecated(note = "Citadel Phase 0 froze the Rust hub; use packages/hub for all new hub work.")]
pub const CITADEL_RUST_HUB_FROZEN: () = ();

pub mod auth;
pub mod http;
pub mod router;
pub mod state;
pub mod ws;

pub use http::app;
pub use state::{AppConfig, AppState};
