#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use roundtable_node::{
    codex::{CodexAdapter, CodexCommand, CodexEvent, CodexTurnStatus},
    config::NodeConfig,
    hub::{ClientCommand, HubClient, HubEvent, HubTransport, TcpHubChannel, WsHubChannel},
    ipc::{IpcNotification, IpcRequest, IpcResponse, IpcServer},
    secrets::BearerToken,
    state::NodeState,
    NodeError, NodeResult,
};
use roundtable_protocol::{DeliveryState, MessageKind, SeatProvider};
use std::collections::{HashMap, HashSet};
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

    // Must happen before the first TLS dial. rustls 0.23 has no implicit provider, so a `wss://`
    // hub URL panics without this — the node ran fine against a plain `ws://` tunnel for the whole
    // of development and then died on its first real connection to the deployed hub.
    if rustls::crypto::ring::default_provider().install_default().is_err() {
        // Only fails if something already installed one, which is fine.
        tracing::debug!("a rustls crypto provider was already installed");
    }

    let config_path = std::env::var("ROUNDTABLE_NODE_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("config.json"));
    let config_bytes = std::fs::read(&config_path)?;
    let cfg: NodeConfig = serde_json::from_slice(&config_bytes)?;
    let state = Arc::new(Mutex::new(NodeState::load_or_default(&cfg.state_path)?));
    // ROUNDTABLE_NODE_TOKEN_FILE keeps the secret out of the working directory (which is also the
    // data directory, holding state.json and the IPC socket) and out of the process environment,
    // where any child — including the Codex app-server this spawns — would inherit it. Mirrors the
    // hub's ROUND_TABLE_ADMIN_TOKEN_FILE. Falls back to ./node.token for local runs.
    let token_path = std::env::var("ROUNDTABLE_NODE_TOKEN_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("node.token"));
    let token = BearerToken::load("ROUNDTABLE_NODE_TOKEN", &token_path)?;

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

    // The local IPC socket is how a Claude session joins a room: `packages/claude-channel` (an MCP
    // server running inside that session) connects here. Without it, Claude seats receive nothing
    // — the socket was never even opened before, so every Claude delivery went nowhere.
    let ipc = Arc::new(IpcServer::new(PathBuf::from(&cfg.ipc_socket_path)));
    let (ipc_tx, mut ipc_rx) = tokio::sync::mpsc::unbounded_channel();
    ipc.set_request_handler(ipc_tx).await;
    if let Err(e) = ipc.start().await {
        // Non-fatal for the same reason Codex is: a node with only Codex seats does not need it.
        tracing::warn!(error = %e, "ipc server did not start; claude seats will not work");
    }

    // Drain hub events and Codex events concurrently for the life of the process. HubClient::new
    // already spawned the driver, which owns reconnect and cursor replay.
    loop {
        tokio::select! {
            hub_event = client.next_event() => {
                let Some((event, event_id)) = hub_event else {
                    tracing::warn!("hub event stream ended; exiting");
                    break;
                };
                handle_hub_event(event, event_id, &client, &codex, &ipc, &routing).await;
            }
            ipc_request = ipc_rx.recv() => {
                let Some((req, respond)) = ipc_request else {
                    tracing::warn!("ipc request channel closed");
                    continue;
                };
                let response = handle_ipc_request(req, &client, &routing).await;
                let _ = respond.send(response);
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
    /// Deliveries backed by a Run keep lifecycle/tool activity in RunEvents, not chat.
    run_deliveries: Mutex<HashSet<Uuid>>,
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
    event_id: uuid::Uuid,
    client: &HubClient,
    codex: &Arc<CodexAdapter>,
    ipc: &Arc<IpcServer>,
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
                client.mark_applied(event_id).await;
                return;
            };
            // Must happen before any reply is posted: PostMessage refuses an unowned seat_id.
            client.register_seat(delivery.seat_id).await;
            routing.rooms.lock().await.insert(delivery.seat_id, message.room_id);
            routing.deliveries.lock().await.insert(delivery.seat_id, delivery.id);
            if delivery.run_id.is_some() {
                routing.run_deliveries.lock().await.insert(delivery.id);
            }
            client.send(ClientCommand::DeliveryState {
                delivery_id: delivery.id,
                state: DeliveryState::Running,
                error_code: None,
            }).await;

            match seat.provider {
                SeatProvider::Codex => {
                    dispatch_to_codex(delivery.seat_id, message.body, codex).await;
                }
                // Claude-shaped and third-party harness seats (ccx/cdx/minimax/other) are driven
                // by an attached local session over IPC, not by a child process this node spawns.
                SeatProvider::Claude
                | SeatProvider::Minimax
                | SeatProvider::Ccx
                | SeatProvider::Cdx
                | SeatProvider::Other => {
                    ipc.notify(delivery.seat_id, IpcNotification::DeliveryAssign {
                        delivery_id: delivery.id,
                        room_id: message.room_id,
                        body: message.body,
                    }).await;
                    tracing::info!(seat_id = %delivery.seat_id, provider = ?seat.provider, "delivery handed to the local channel");
                }
            }
        }
        HubEvent::ApprovalResolve { approval_id, decision } => {
            let Some(pending) = routing.approvals.lock().await.remove(&approval_id) else {
                tracing::warn!(%approval_id, "approval resolve for an unknown approval; dropping");
                client.mark_applied(event_id).await;
                return;
            };
            if decision != "approve" {
                tracing::info!(%approval_id, %decision, "approval not granted; action stays denied");
                client.mark_applied(event_id).await;
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
        HubEvent::QueryResult { request_id, .. } => {
            tracing::warn!(%request_id, "query result reached the event stream; this should be impossible");
        }
        HubEvent::MutationResult { request_id, .. } => {
            tracing::warn!(%request_id, "mutation result reached the event stream; this should be impossible");
        }
        HubEvent::SeatInterrupt { delivery_id, reason } => {
            let seat_id = routing.deliveries.lock().await.iter()
                .find(|(_, d)| **d == delivery_id).map(|(seat, _)| *seat);
            let Some(seat_id) = seat_id else {
                tracing::warn!(%delivery_id, "interrupt for a delivery this node is not running; ignoring");
                client.mark_applied(event_id).await;
                return;
            };
            let Some(state) = codex.seat(seat_id).await else {
                tracing::warn!(%delivery_id, %seat_id, "interrupt for a seat with no codex thread; ignoring");
                client.mark_applied(event_id).await;
                return;
            };
            tracing::info!(%delivery_id, %seat_id, %reason, "interrupting turn");
            let cmd = CodexCommand::InterruptTurn { thread_id: state.thread_id };
            if let Err(e) = codex.execute(seat_id, cmd).await {
                tracing::warn!(%delivery_id, error = %e, "turn/interrupt failed");
            }
            routing.deliveries.lock().await.remove(&seat_id);
        }
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
    if !event_id.is_nil() {
        client.mark_applied(event_id).await;
    }
}

/// Turns an IPC request from an attached Claude channel into real hub traffic.
///
/// Every arm used to return a canned success — `message.reply` answered `{"posted": true}` having
/// posted nothing. What is implemented here is what the hub actually supports today; anything else
/// returns an explicit error rather than pretending, because a channel that believes a silent
/// no-op succeeded is worse than one that gets told no.
async fn handle_ipc_request(
    req: IpcRequest,
    client: &HubClient,
    routing: &Arc<SeatRouting>,
) -> IpcResponse {
    let id = Uuid::now_v7();
    match req {
        IpcRequest::MessageReply { seat_id, delivery_id, body, kind } => {
            let Some(room_id) = routing.rooms.lock().await.get(&seat_id).copied() else {
                return IpcResponse::err(id, "unknown seat — this node has no delivery for it");
            };
            if !client.owns_seat(seat_id).await {
                return IpcResponse::err(id, "this node does not own that seat");
            }
            let message_kind = match kind.as_str() {
                "progress" => MessageKind::Progress,
                "completion" => MessageKind::Completion,
                "question" => MessageKind::Question,
                "system" => MessageKind::System,
                _ => MessageKind::Chat,
            };
            let (response, rx) = tokio::sync::oneshot::channel();
            client.send(ClientCommand::PostMessage {
                seat_id, room_id, kind: message_kind, body, reply_to: None, response,
            }).await;
            match rx.await {
                Ok(Ok(message_id)) => {
                    // The delivery is done the moment its reply lands; leaving it open would keep
                    // the lease alive and eventually retry work already completed.
                    routing.deliveries.lock().await.remove(&seat_id);
                    client.send(ClientCommand::DeliveryState {
                        delivery_id,
                        state: DeliveryState::Completed,
                        error_code: None,
                    }).await;
                    IpcResponse::ok(id, serde_json::json!({ "message_id": message_id }))
                }
                Ok(Err(e)) => IpcResponse::err(id, format!("hub rejected the reply: {e}")),
                Err(_) => IpcResponse::err(id, "hub dropped the reply without responding"),
            }
        }
        IpcRequest::HandoffCreate { from_seat_id, to_alias, body, evidence_refs } => {
            // The hub's Handoff command needs a target seat UUID and the channel only knows an
            // alias. The node still holds no roster — it asks the hub for one per handoff rather
            // than caching it, because a cached roster goes stale exactly when it matters (a seat
            // added or detached mid-session) and a handoff to a stale seat_id fails silently.
            let Some(room_id) = routing.rooms.lock().await.get(&from_seat_id).copied() else {
                return IpcResponse::err(id, "unknown seat — this node has no delivery for it");
            };
            if !client.owns_seat(from_seat_id).await {
                return IpcResponse::err(id, "this node does not own that seat");
            }
            let roster = match client
                .query(serde_json::json!({ "roster_read": { "room_id": room_id } }))
                .await
            {
                Ok(v) => v,
                Err(e) => return IpcResponse::err(id, format!("could not read the room roster: {e}")),
            };
            let to_seat_id = roster["seats"]
                .as_array()
                .and_then(|seats| {
                    seats
                        .iter()
                        .find(|s| s["alias"].as_str() == Some(to_alias.as_str()))
                        .and_then(|s| s["id"].as_str())
                        .and_then(|s| Uuid::parse_str(s).ok())
                });
            let Some(to_seat_id) = to_seat_id else {
                return IpcResponse::err(id, format!("no seat with alias '{to_alias}' in this room"));
            };
            let (response, rx) = tokio::sync::oneshot::channel();
            client.send(ClientCommand::Handoff {
                from_seat_id, to_seat_id, body, evidence_refs, response,
            }).await;
            match rx.await {
                Ok(Ok(handoff_id)) => IpcResponse::ok(
                    id,
                    serde_json::json!({ "handoff_id": handoff_id, "to_seat_id": to_seat_id }),
                ),
                Ok(Err(e)) => IpcResponse::err(id, format!("hub rejected the handoff: {e}")),
                Err(_) => IpcResponse::err(id, "hub dropped the handoff without responding"),
            }
        }
        IpcRequest::RunCreate { from_seat_id, executor_alias, title, instructions } => {
            let Some(room_id) = routing.rooms.lock().await.get(&from_seat_id).copied() else {
                return IpcResponse::err(id, "unknown seat — this node has no delivery for it");
            };
            if !client.owns_seat(from_seat_id).await {
                return IpcResponse::err(id, "this node does not own that seat");
            }
            let roster = match client
                .query(serde_json::json!({ "roster_read": { "room_id": room_id } }))
                .await
            {
                Ok(v) => v,
                Err(e) => return IpcResponse::err(id, format!("could not read the room roster: {e}")),
            };
            let executor_seat_id = roster["seats"]
                .as_array()
                .and_then(|seats| {
                    seats
                        .iter()
                        .find(|s| s["alias"].as_str() == Some(executor_alias.as_str()))
                        .and_then(|s| s["id"].as_str())
                        .and_then(|s| Uuid::parse_str(s).ok())
                });
            let Some(executor_seat_id) = executor_seat_id else {
                return IpcResponse::err(id, format!("no seat with alias '{executor_alias}' in this room"));
            };
            let (response, rx) = tokio::sync::oneshot::channel();
            client.send(ClientCommand::RunCreate {
                room_id,
                from_seat_id,
                executor_seat_id,
                title,
                instructions,
                response,
            }).await;
            match rx.await {
                Ok(Ok(run_id)) => IpcResponse::ok(
                    id,
                    serde_json::json!({ "run_id": run_id, "executor_seat_id": executor_seat_id }),
                ),
                Ok(Err(e)) => IpcResponse::err(id, format!("hub rejected the delegate: {e}")),
                Err(_) => IpcResponse::err(id, "hub dropped the delegate without responding"),
            }
        }
        IpcRequest::ApprovalVerdict { .. } => {
            IpcResponse::err(id, "approval.verdict is not implemented for claude seats")
        }
        IpcRequest::SessionJoin { .. } | IpcRequest::SessionLeave { .. } => {
            // Seats are created out-of-band with ops/enrol-node.mjs; the node has no HTTP client
            // and no admin credential with which to create one.
            IpcResponse::err(id, "seats are enrolled on the hub (ops/enrol-node.mjs), not over IPC")
        }
        // The node holds no transcript; the hub does. Both of these forward to it over the same
        // authenticated socket the node already has, and the hub refuses any room this node holds
        // no seat in — the node is not an operator and must not read the whole hub.
        IpcRequest::TranscriptRead { room_id, after_seq, limit, .. } => {
            match client.query(serde_json::json!({
                "transcript_read": {
                    "room_id": room_id,
                    "after_seq": after_seq.unwrap_or(0),
                    "limit": limit,
                },
            })).await {
                Ok(v) => IpcResponse::ok(id, v),
                Err(e) => IpcResponse::err(id, format!("transcript.read failed: {e}")),
            }
        }
        IpcRequest::TranscriptSearch { room_id, query, limit } => {
            match client.query(serde_json::json!({
                "transcript_search": { "room_id": room_id, "query": query, "limit": limit },
            })).await {
                Ok(v) => IpcResponse::ok(id, v),
                Err(e) => IpcResponse::err(id, format!("transcript.search failed: {e}")),
            }
        }
        IpcRequest::Ping { nonce } => IpcResponse::ok(id, serde_json::json!({ "pong": nonce })),
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
    let delivery_id = routing.deliveries.lock().await.get(&event.seat_id).copied();
    let has_run = match delivery_id {
        Some(id) => routing.run_deliveries.lock().await.contains(&id),
        None => false,
    };
    if let Some(delivery_id) = delivery_id {
        client.send(ClientCommand::RunEvent {
            delivery_id,
            event_key: event.event_key.clone(),
            event_type: event.item_type.clone().unwrap_or_else(|| event.kind.clone()),
            payload: serde_json::json!({
                "thread_id": event.thread_id.clone(),
                "turn_id": event.turn_id.clone(),
                "status": format!("{:?}", event.status),
                "body": event.body.clone(),
                "item_type": event.item_type.clone(),
            }),
        }).await;
        let terminal = match event.status {
            CodexTurnStatus::Completed => Some(DeliveryState::Completed),
            CodexTurnStatus::Failed | CodexTurnStatus::Cancelled => Some(DeliveryState::Failed),
            _ => None,
        };
        if let Some(state) = terminal {
            client.send(ClientCommand::DeliveryState { delivery_id, state, error_code: None }).await;
            routing.deliveries.lock().await.remove(&event.seat_id);
            routing.run_deliveries.lock().await.remove(&delivery_id);
        }
    }

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

    if has_run && (event.item_type.as_deref().is_some_and(|item| item != "agentMessage") || event.body.is_empty()) {
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
