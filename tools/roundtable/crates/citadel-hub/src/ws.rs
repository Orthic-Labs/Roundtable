use crate::http::{authenticate_node_headers, require_session, ApiError};
use crate::router;
use crate::state::AppState;
use axum::extract::ws::{
    close_code, CloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade,
};
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use citadel_protocol::{
    new_id, DeliveryState, DeliveryStateUpdate, HubEvent, NodeEvent, WsEnvelope, PROTOCOL_VERSION,
};
use citadel_store::{now_ms, DeliveryUpdate, NewApproval};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time::{interval, Instant};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct NodeConnectQuery {
    pub node_id: Uuid,
    #[serde(default)]
    pub resume_cursor: i64,
}

pub async fn node_connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<NodeConnectQuery>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    authenticate_node_headers(&state, &headers, query.node_id).await?;
    Ok(upgrade
        .on_upgrade(move |socket| serve_node(socket, state, query.node_id, query.resume_cursor)))
}

pub async fn browser_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    require_session(&state, &headers).await?;
    Ok(upgrade.on_upgrade(move |mut socket| async move {
        let _ = socket
            .send(WsMessage::Text(
                json!({"type":"connected","sent_at_ms":now_ms()})
                    .to_string()
                    .into(),
            ))
            .await;
        while let Some(Ok(message)) = socket.recv().await {
            if matches!(message, WsMessage::Close(_)) {
                break;
            }
        }
    }))
}

async fn serve_node(mut socket: WebSocket, state: AppState, node_id: Uuid, resume_cursor: i64) {
    let hello = WsEnvelope {
        version: PROTOCOL_VERSION,
        event_id: new_id(),
        sent_at_ms: now_ms(),
        event: HubEvent::HelloAccepted {
            node_id,
            heartbeat_ms: state.config.heartbeat_ms,
            resume_cursor,
        },
    };
    if send_json(&mut socket, &hello).await.is_err() {
        return;
    }
    match state.store.replay_events(node_id, resume_cursor).await {
        Ok(events) => {
            for event in events {
                let frame = json!({
                    "version": PROTOCOL_VERSION,
                    "event_id": event.event_id,
                    "sent_at_ms": event.created_at_ms,
                    "type": event.event_type,
                    "payload": event.payload,
                    "cursor": event.cursor,
                });
                if send_json(&mut socket, &frame).await.is_err() {
                    let _ = state.store.mark_node_offline(node_id, now_ms()).await;
                    return;
                }
            }
        }
        Err(_) => {
            close_protocol(&mut socket, "event_replay").await;
            return;
        }
    }

    let mut heartbeat = interval(Duration::from_millis(state.config.heartbeat_ms as u64));
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > Duration::from_millis(state.config.node_timeout_ms as u64) {
                    close_protocol(&mut socket, "heartbeat_timeout").await;
                    break;
                }
                let ping = WsEnvelope {
                    version: PROTOCOL_VERSION,
                    event_id: new_id(),
                    sent_at_ms: now_ms(),
                    event: HubEvent::Ping { nonce: new_id().to_string() },
                };
                if send_json(&mut socket, &ping).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(WsMessage::Text(text))) => {
                        last_seen = Instant::now();
                        match decode_node_frame(&text) {
                            Ok(frame) => {
                                if process_node_event(&state, node_id, frame.event).await.is_err() {
                                    close_protocol(&mut socket, "protocol_event").await;
                                    break;
                                }
                            }
                            Err(code) => {
                                close_protocol(&mut socket, code).await;
                                break;
                            }
                        }
                    }
                    Some(Ok(WsMessage::Pong(_))) => last_seen = Instant::now(),
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
    let _ = state.store.mark_node_offline(node_id, now_ms()).await;
}

async fn process_node_event(
    state: &AppState,
    node_id: Uuid,
    event: NodeEvent,
) -> Result<(), ApiError> {
    match event {
        NodeEvent::DeliveryAck(payload) => {
            state
                .store
                .update_delivery(DeliveryUpdate {
                    delivery_id: payload.delivery_id,
                    node_id,
                    state: DeliveryState::Acked,
                    error_code: None,
                    now_ms: now_ms(),
                })
                .await?;
        }
        NodeEvent::DeliveryState(DeliveryStateUpdate {
            delivery_id,
            state: delivery_state,
            error_code,
        }) => {
            state
                .store
                .update_delivery(DeliveryUpdate {
                    delivery_id,
                    node_id,
                    state: delivery_state,
                    error_code,
                    now_ms: now_ms(),
                })
                .await?;
        }
        NodeEvent::MessagePost(payload) => {
            router::post_agent_message(
                state,
                router::AgentMessageInput {
                    node_id,
                    room_id: payload.room_id,
                    seat_id: payload.seat_id,
                    request_id: payload.request_id,
                    kind: payload.kind,
                    body: payload.body,
                    reply_to: payload.reply_to,
                    now_ms: now_ms(),
                },
            )
            .await?;
        }
        NodeEvent::HandoffCreate(payload) => {
            let seat = state.store.get_seat(payload.from_seat_id).await?;
            if seat.node_id != node_id {
                return Err(ApiError::Forbidden);
            }
            router::create_handoff(
                state,
                seat.room_id,
                citadel_protocol::CreateHandoffRequest {
                    request_id: payload.request_id,
                    from_seat_id: payload.from_seat_id,
                    to_seat_id: payload.to_seat_id,
                    body: payload.body,
                    evidence_refs: payload.evidence_refs,
                    task_key: payload.task_key,
                },
                now_ms(),
            )
            .await?;
        }
        NodeEvent::ApprovalRequest(payload) => {
            state
                .store
                .create_approval(NewApproval {
                    request_id: payload.request_id,
                    node_id,
                    seat_id: payload.seat_id,
                    delivery_id: payload.delivery_id,
                    provider_request_id: payload.provider_request_id,
                    description: payload.description,
                    input_preview: payload.input_preview,
                    decisions: payload.decisions,
                    now_ms: now_ms(),
                })
                .await?;
        }
        NodeEvent::SeatPresence(payload) => {
            let seat = state.store.get_seat(payload.seat_id).await?;
            if seat.node_id != node_id {
                return Err(ApiError::Forbidden);
            }
        }
        NodeEvent::SessionCatalog(_) | NodeEvent::Hello(_) | NodeEvent::Pong(_) => {}
    }
    Ok(())
}

pub fn decode_node_frame(text: &str) -> Result<WsEnvelope<NodeEvent>, &'static str> {
    let value: Value = serde_json::from_str(text).map_err(|_| "protocol_json")?;
    if value.get("version").and_then(Value::as_u64) != Some(u64::from(PROTOCOL_VERSION)) {
        return Err("protocol_version");
    }
    serde_json::from_value(value).map_err(|_| "protocol_type")
}

pub fn heartbeat_timed_out(last_seen_ms: i64, now_ms: i64, timeout_ms: i64) -> bool {
    now_ms.saturating_sub(last_seen_ms) > timeout_ms
}

async fn send_json(socket: &mut WebSocket, value: &impl serde::Serialize) -> Result<(), ()> {
    let text = serde_json::to_string(value).map_err(|_| ())?;
    socket
        .send(WsMessage::Text(text.into()))
        .await
        .map_err(|_| ())
}

async fn close_protocol(socket: &mut WebSocket, reason: &str) {
    let _ = socket
        .send(WsMessage::Close(Some(CloseFrame {
            code: close_code::PROTOCOL,
            reason: reason.to_owned().into(),
        })))
        .await;
}
