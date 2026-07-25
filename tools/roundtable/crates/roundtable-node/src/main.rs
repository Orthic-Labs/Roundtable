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
    let routing = Arc::new(SeatRouting::default());

    // Drain hub events and Codex events concurrently for the life of the process. HubClient::new
    // already spawned the driver, which owns reconnect and cursor replay.
    loop {
        tokio::select! {
            hub_event = client.next_event() => {
                let Some(event) = hub_event else {
                    tracing::warn!("hub event stream ended; exiting");
                    break;
                };
                handle_hub_event(event, &client, &codex, &routing).await;
            }
            codex_event = codex_events.recv() => {
                match codex_event {
                    Ok(event) => handle_codex_event(event, &client, &routing).await,
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

/// Per-seat routing state this node keeps for the life of the process.
///
/// `CodexAdapter` is a protocol-agnostic App Server client and deliberately knows nothing about
/// rooms, deliveries, or approvals; those are Roundtable concepts, so they live here instead of
/// being threaded through it.
#[derive(Default)]
struct SeatRouting {
    /// seat -> room, so a Codex event knows where to post. Set on DeliveryAssign.
    rooms: Mutex<HashMap<Uuid, Uuid>>,
    /// seat -> the delivery currently being worked. `ApprovalRequest` requires a delivery_id, and
    /// an approval only ever arises while a delivery is in flight.
    deliveries: Mutex<HashMap<Uuid, Uuid>>,
    /// hub approval_id -> what it takes to act on the decision. `event` is the Guardian
    /// assessment passed straight back to `thread/approveGuardianDeniedAction`.
    approvals: Mutex<HashMap<Uuid, PendingApproval>>,
}

struct PendingApproval {
    seat_id: Uuid,
    thread_id: String,
    event: serde_json::Value,
}

/// Handles `DeliveryAssign` for Codex seats, `ApprovalResolve`, and `SeatDetach`. Claude seats go
/// through the Channel integration (`packages/claude-channel`), not this adapter — routing a
/// Claude delivery here would be silently wrong, so it is logged as explicitly unhandled instead.
async fn handle_hub_event(
    event: HubEvent,
    client: &HubClient,
    codex: &Arc<CodexAdapter>,
    routing: &Arc<SeatRouting>,
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
            routing.rooms.lock().await.insert(delivery.seat_id, message.room_id);
            routing.deliveries.lock().await.insert(delivery.seat_id, delivery.id);
            dispatch_to_codex(delivery.seat_id, message.body, codex).await;
        }
        // A human answered a Guardian denial in the room. Approving replays the assessment event
        // back to Codex; any other decision is recorded and the action simply stays denied —
        // there is no "deny" call to make, because Guardian already denied it.
        HubEvent::ApprovalResolve { approval_id, decision } => {
            let Some(pending) = routing.approvals.lock().await.remove(&approval_id) else {
                tracing::warn!(%approval_id, "approval resolve for an unknown approval; dropping");
                return;
            };
            if decision != "approve" {
                tracing::info!(%approval_id, %decision, "approval not granted; action stays denied");
                return;
            }
            let cmd = CodexCommand::ApproveGuardianDeniedAction {
                thread_id: pending.thread_id,
                event: pending.event,
            };
            if let Err(e) = codex.execute(pending.seat_id, cmd).await {
                tracing::warn!(%approval_id, error = %e, "approving the denied action failed");
            }
        }
        // Cancellation contract §2: the operator canceled a delivery this node is running.
        // Translate to Codex's native interrupt. Work already done is NOT rolled back (§5) — the
        // interrupt only prevents further work, and anything already posted stays in the room.
        HubEvent::SeatInterrupt { delivery_id, reason } => {
            let seat_id = routing.deliveries.lock().await.iter()
                .find(|(_, d)| **d == delivery_id).map(|(seat, _)| *seat);
            let Some(seat_id) = seat_id else {
                tracing::warn!(%delivery_id, "interrupt for a delivery this node is not running; ignoring");
                return;
            };
            let Some(state) = codex.seat(seat_id).await else {
                tracing::warn!(%delivery_id, %seat_id, "interrupt for a seat with no codex thread; ignoring");
                return;
            };
            tracing::info!(%delivery_id, %seat_id, %reason, "interrupting turn");
            let cmd = CodexCommand::InterruptTurn { thread_id: state.thread_id };
            if let Err(e) = codex.execute(seat_id, cmd).await {
                tracing::warn!(%delivery_id, error = %e, "turn/interrupt failed");
            }
            // The delivery is over either way — the hub already moved it to `failed`.
            routing.deliveries.lock().await.remove(&seat_id);
        }
        // The hub is taking this seat away from this node. Interrupt any running turn, then drop
        // every trace of the seat so a late Codex event can't post into a room we no longer serve.
        HubEvent::SeatDetach { seat_id, reason } => {
            tracing::info!(%seat_id, %reason, "seat detached");
            if let Some(state) = codex.seat(seat_id).await {
                if state.active_turn_id.is_some() {
                    let cmd = CodexCommand::InterruptTurn { thread_id: state.thread_id };
                    if let Err(e) = codex.execute(seat_id, cmd).await {
                        tracing::warn!(%seat_id, error = %e, "interrupting the detached seat's turn failed");
                    }
                }
            }
            routing.rooms.lock().await.remove(&seat_id);
            routing.deliveries.lock().await.remove(&seat_id);
            routing.approvals.lock().await.retain(|_, p| p.seat_id != seat_id);
            client.unregister_seat(seat_id).await;
        }
    }
}

/// Sends a delivery's body to the seat's Codex thread.
///
/// A seat with no thread yet needs TWO calls: `thread/start` creates the thread and takes no
/// input at all, then `turn/start` actually says something. (An earlier version passed the input
/// to `thread/start`, which the real params have no field for.) Splitting them this way also
/// removes the old CreateThread notification race for free: `thread/start` starts no turn, so
/// there are no turn notifications to arrive before the seat->thread mapping exists.
///
/// Errors are logged, not propagated — a failed turn on one seat must not take down the node's
/// connection to every other seat.
async fn dispatch_to_codex(seat_id: uuid::Uuid, input: String, codex: &Arc<CodexAdapter>) {
    let existing = codex.seat(seat_id).await;
    let thread_id = match existing {
        Some(ref state) => state.thread_id.clone(),
        None => {
            let create = CodexCommand::CreateThread { cwd: None };
            if let Err(e) = codex.execute(seat_id, create).await {
                tracing::warn!(seat_id = %seat_id, error = %e, "thread/start failed");
                return;
            }
            match codex.seat(seat_id).await {
                Some(state) => state.thread_id,
                None => {
                    tracing::warn!(seat_id = %seat_id, "thread/start left no seat state; cannot start a turn");
                    return;
                }
            }
        }
    };
    // Steer only an actually-running turn; otherwise start a fresh one.
    let cmd = match existing.and_then(|s| s.active_turn_id) {
        Some(active_turn_id) => CodexCommand::SteerTurn { thread_id, expected_turn_id: active_turn_id, input },
        None => CodexCommand::StartTurn { thread_id, input },
    };
    if let Err(e) = codex.execute(seat_id, cmd).await {
        tracing::warn!(seat_id = %seat_id, error = %e, "codex command failed");
    }
}

/// Posts a routed CodexEvent into the seat's room.
///
/// Three shapes, in priority order:
/// - **Guardian approval** (`event.approval`): a DENIED action becomes a real hub
///   `ApprovalRequest` so a human can override it in the room; other review states are logged
///   only, since nothing is blocked on them.
/// - **Content** (`event.body` non-empty): an agent message posts as `Chat`; any other summarized
///   item (a command, a file edit, a tool call — see codex.rs::summarize_item) posts as
///   `Progress`, so activity is visible without being mistaken for the agent speaking.
/// - **Lifecycle** (empty body): a short status line, so a turn starting/ending is visible.
async fn handle_codex_event(
    event: CodexEvent,
    client: &HubClient,
    routing: &Arc<SeatRouting>,
) {
    let Some(room_id) = routing.rooms.lock().await.get(&event.seat_id).copied() else {
        // A DeliveryAssign always records this before dispatch_to_codex runs, so this means an
        // event arrived for a seat this node never received a delivery for (or one since
        // detached). Drop rather than post with a placeholder room_id — the hub validates seat_id
        // against room_id and would reject it anyway (see packages/hub/src/server.mjs's
        // handleNodeMessagePost), so sending a wrong room_id would fail the same way, less
        // honestly.
        tracing::warn!(seat_id = %event.seat_id, "codex event for a seat with no known room; dropping");
        return;
    };

    if let Some(approval) = event.approval {
        if approval.status != "denied" {
            tracing::debug!(
                seat_id = %event.seat_id, status = %approval.status, action = %approval.action_type,
                "guardian review (nothing blocked)",
            );
            return;
        }
        let Some(delivery_id) = routing.deliveries.lock().await.get(&event.seat_id).copied() else {
            tracing::warn!(seat_id = %event.seat_id, "denied action with no in-flight delivery; cannot raise an approval");
            return;
        };
        let description = match &approval.rationale {
            Some(why) => format!("Codex was blocked from an action: {}. Reason: {why}", approval.summary),
            None => format!("Codex was blocked from an action: {}", approval.summary),
        };
        let (response, rx) = tokio::sync::oneshot::channel();
        client.send(ClientCommand::ApprovalRequest {
            seat_id: event.seat_id,
            delivery_id,
            provider_request_id: approval.review_id.clone(),
            description,
            input_preview: approval.summary.clone(),
            decisions: vec!["approve".into(), "deny".into()],
            response,
        }).await;
        // The hub's approval_id is what a later ApprovalResolve refers to, so the mapping to what
        // it takes to act (thread + the Guardian event to replay) has to be recorded under it.
        match rx.await {
            Ok(Ok(approval_id)) => {
                routing.approvals.lock().await.insert(approval_id, PendingApproval {
                    seat_id: event.seat_id,
                    thread_id: event.thread_id.clone(),
                    event: approval.raw_event,
                });
                tracing::info!(%approval_id, seat_id = %event.seat_id, "raised an approval for a denied action");
            }
            Ok(Err(e)) => tracing::warn!(seat_id = %event.seat_id, error = %e, "hub rejected the approval request"),
            Err(_) => tracing::warn!(seat_id = %event.seat_id, "hub dropped the approval request without responding"),
        }
        return;
    }

    let (body, kind) = if !event.body.is_empty() {
        // The agent actually speaking is `Chat`; every other item is activity, so `Progress`.
        let kind = match event.item_type.as_deref() {
            Some("agentMessage") => MessageKind::Chat,
            _ => MessageKind::Progress,
        };
        (event.body.clone(), kind)
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
