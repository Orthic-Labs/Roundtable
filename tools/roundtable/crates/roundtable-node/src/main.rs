#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use roundtable_node::{
    codex::{CodexAdapter, CodexCommand, CodexEvent, CodexTurnStatus},
    config::NodeConfig,
    hub::{ClientCommand, HubClient, HubEvent, HubTransport, TcpHubChannel, WsHubChannel},
    secrets::BearerToken,
    state::NodeState,
    NodeError, NodeResult,
};
use roundtable_protocol::{MessageKind, SeatProvider};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

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

    // One CodexAdapter for the process. connect() needs &mut self and is only called here, once,
    // before anything shares it; execute()/subscribe()/seat() all take &self (their mutable state
    // is behind internal Mutexes), so wrapping in Arc afterward is enough for the select! loop
    // below to call them from multiple event arms without a lock around the adapter itself.
    let mut codex = CodexAdapter::new(cfg.codex_command.clone(), cfg.codex_cwd.clone());
    let mut codex_events = codex.subscribe().await;
    if let Err(e) = codex.connect().await {
        // Codex is optional infrastructure from the node's point of view — a hub connection with
        // no local Codex available should still run (e.g. a Claude-only seat), so this does not
        // exit the process. Every DeliveryAssign for a Codex seat will fail loudly instead.
        tracing::warn!(error = %e, "codex app server did not start; codex seats will fail");
    }
    let codex = Arc::new(codex);

    // CodexEvent (codex.rs) deliberately knows nothing about rooms — it is a generic App Server
    // adapter. DeliveryAssign is where the room_id for a seat is actually known, so it is
    // recorded here and looked up when a reply needs to be posted, rather than threading a
    // Roundtable-specific field through an otherwise protocol-agnostic module.
    let seat_rooms: Arc<Mutex<HashMap<Uuid, Uuid>>> = Arc::new(Mutex::new(HashMap::new()));

    // Drain hub events and Codex events concurrently for the life of the process. HubClient::new
    // already spawned the driver, which owns reconnect and cursor replay.
    loop {
        tokio::select! {
            hub_event = client.next_event() => {
                let Some(event) = hub_event else {
                    tracing::warn!("hub event stream ended; exiting");
                    break;
                };
                handle_hub_event(event, &client, &codex, &seat_rooms).await;
            }
            codex_event = codex_events.recv() => {
                match codex_event {
                    Ok(event) => handle_codex_event(event, &client, &seat_rooms).await,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "codex event channel lagged; some turn events were dropped");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // The adapter itself is never dropped (it's held in `codex` for the
                        // process lifetime), so this arm is unreachable in practice; treated as
                        // non-fatal rather than assumed impossible.
                        tracing::warn!("codex event channel closed");
                    }
                }
            }
        }
    }

    Ok(())
}

/// Only `DeliveryAssign` for a Codex-provider seat is handled. Claude seats go through the
/// Channel integration (`packages/claude-channel`), not this adapter — routing a Claude delivery
/// here would be silently wrong, so it is logged as explicitly unhandled instead.
/// `ApprovalResolve` and `SeatDetach` are not implemented; see STATUS.md.
async fn handle_hub_event(
    event: HubEvent,
    client: &HubClient,
    codex: &Arc<CodexAdapter>,
    seat_rooms: &Arc<Mutex<HashMap<Uuid, Uuid>>>,
) {
    match event {
        HubEvent::HelloAccepted(accepted) => {
            tracing::info!(
                seats = accepted.seat_tokens.len(),
                resume_cursor = accepted.resume_cursor,
                "hub accepted",
            );
        }
        HubEvent::Ping { nonce } => tracing::debug!(%nonce, "ping"),
        HubEvent::DeliveryAssign { delivery, message, seats, .. } => {
            let Some(seat) = seats.iter().find(|s| s.id == delivery.seat_id) else {
                tracing::warn!(seat_id = %delivery.seat_id, "delivery for a seat not in its own roster");
                return;
            };
            if seat.provider != SeatProvider::Codex {
                tracing::info!(
                    seat_id = %seat.id, provider = ?seat.provider,
                    "delivery for a non-Codex seat — not handled by this adapter",
                );
                return;
            }
            // Must happen before any reply is posted: PostMessage refuses an unowned seat_id.
            client.register_seat(delivery.seat_id).await;
            seat_rooms.lock().await.insert(delivery.seat_id, message.room_id);
            dispatch_to_codex(delivery.seat_id, message.body, codex).await;
        }
        other => tracing::info!(?other, "hub event not yet handled"),
    }
}

/// Picks CreateThread / StartTurn / SteerTurn based on what this node already knows about the
/// seat, then sends it. Errors are logged, not propagated — a failed turn on one seat must not
/// take down the node's connection to every other seat.
async fn dispatch_to_codex(seat_id: uuid::Uuid, input: String, codex: &Arc<CodexAdapter>) {
    let cmd = match codex.seat(seat_id).await {
        None => CodexCommand::CreateThread { input, cwd: None },
        Some(existing) if existing.active_turn_id.is_some() => CodexCommand::SteerTurn {
            thread_id: existing.thread_id,
            expected_turn_id: existing.active_turn_id.unwrap(),
            input,
        },
        Some(existing) => CodexCommand::StartTurn { thread_id: existing.thread_id, input },
    };
    if let Err(e) = codex.execute(seat_id, cmd).await {
        tracing::warn!(seat_id = %seat_id, error = %e, "codex command failed");
    }
}

/// Posts a message back into the room for any routed CodexEvent with a seat_id — every event
/// `notification_to_event` in codex.rs emits (see its doc comment). When the event carries real
/// agent content (`item/completed`'s agentMessage text), that's what gets posted, as a `Chat`
/// message. Otherwise (turn/started, turn/completed, etc.) a synthetic status line is posted
/// instead, so the turn's lifecycle is still visible in the room even between agent replies.
async fn handle_codex_event(
    event: CodexEvent,
    client: &HubClient,
    seat_rooms: &Arc<Mutex<HashMap<Uuid, Uuid>>>,
) {
    let Some(room_id) = seat_rooms.lock().await.get(&event.seat_id).copied() else {
        // A DeliveryAssign always records this before dispatch_to_codex runs, so this means an
        // event arrived for a seat this node never received a delivery for. Drop rather than post
        // with a placeholder room_id — the hub validates seat_id against room_id and would reject
        // it anyway (see packages/hub/src/server.mjs's handleNodeMessagePost), so sending a wrong
        // room_id would fail exactly the same way but less honestly.
        tracing::warn!(seat_id = %event.seat_id, "codex event for a seat with no known room; dropping");
        return;
    };
    // `item/completed` (agentMessage) carries real reply text in `event.body`; every other
    // routed event (turn/started, turn/completed, turn/interrupted, turn/failed) leaves `body`
    // empty and gets a synthetic status line instead — see codex.rs::notification_to_event.
    let (body, kind) = if !event.body.is_empty() {
        (event.body.clone(), MessageKind::Chat)
    } else {
        let synthetic_body = format!(
            "[roundtable-node] turn {status:?} (thread {thread})",
            status = event.status, thread = event.thread_id,
        );
        let kind = match event.status {
            CodexTurnStatus::Failed | CodexTurnStatus::WaitingApproval => MessageKind::System,
            _ => MessageKind::Progress,
        };
        (synthetic_body, kind)
    };
    let (response, _rx) = tokio::sync::oneshot::channel();
    client.send(ClientCommand::PostMessage {
        seat_id: event.seat_id,
        room_id,
        kind,
        body,
        reply_to: None,
        response,
    }).await;
    // actor_kind is not part of ClientCommand::PostMessage — the hub derives it server-side from
    // seat_id (see handleNodeMessagePost's `actorKind: 'agent'`), so there is nothing to set here.
}
