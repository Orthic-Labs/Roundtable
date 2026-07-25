//! Hub client - NDJSON envelopes over a transport.
//!
//! Production uses WSS; unit tests use TcpHubChannel (plain TCP speaking
//! the same envelope shape) driven by the fake hub fixture. Both share
//! HubTransport so the reconnect loop is identical.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, info, warn};
use uuid::Uuid;

use roundtable_protocol::{
    canonical_sha256, validate_message_body, ActorKind, Delivery, DeliveryReason,
    DeliveryState, Message, MessageKind, PROTOCOL_VERSION, Seat,
    SeatProvider, SeatState,
};
use crate::config::NodeConfig;
use crate::state::NodeState;
use crate::{NodeError, NodeResult};

/// Node's legacy wire envelope: `{version, event_id, sent_at_ms, type, payload}`.
///
/// NOT the same shape as `roundtable_protocol::WsEnvelope`, which carries a
/// `#[serde(flatten)]` event instead of a nested `payload` and a `type` tag. The node
/// client and the hub were built in different eras against different framings and have
/// never been integration-tested against each other; node's fixtures
/// (`fixtures/hub/fake-hub.mjs`) speak this shape.
///
/// Kept local to the node so the crate compiles and its 24 tests keep passing without
/// silently claiming a wire compatibility that has not been verified. Aligning the two
/// framings is tracked in `roundtable/STATUS.md`; do not "fix" this by swapping in
/// `WsEnvelope` without also porting the fixtures and adding a real node<->hub test.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Envelope<T> {
    version: u16,
    event_id: Uuid,
    sent_at_ms: i64,
    #[serde(rename = "type")]
    kind: String,
    payload: T,
}

#[async_trait]
pub trait HubTransport: Send + Sync {
    async fn send_frame(&self, frame: &[u8]) -> NodeResult<()>;
    async fn recv_frame(&self) -> NodeResult<Option<Vec<u8>>>;
    async fn close(&self) -> NodeResult<()>;
}

pub struct TcpHubChannel {
    reader: Mutex<BufReader<OwnedReadHalf>>,
    writer: Mutex<OwnedWriteHalf>,
}

impl TcpHubChannel {
    pub fn new(stream: TcpStream) -> Self {
        let (r, w) = stream.into_split();
        Self { reader: Mutex::new(BufReader::new(r)), writer: Mutex::new(w) }
    }
}

#[async_trait]
impl HubTransport for TcpHubChannel {
    async fn send_frame(&self, frame: &[u8]) -> NodeResult<()> {
        let mut w = self.writer.lock().await;
        w.write_all(frame).await?;
        w.write_all(b"\n").await?;
        w.flush().await?;
        Ok(())
    }
    async fn recv_frame(&self) -> NodeResult<Option<Vec<u8>>> {
        let mut r = self.reader.lock().await;
        let mut buf = Vec::new();
        let n = r.read_until(b'\n', &mut buf).await?;
        if n == 0 { return Ok(None); }
        while matches!(buf.last(), Some(b'\n')) { buf.pop(); }
        Ok(Some(buf))
    }
    async fn close(&self) -> NodeResult<()> {
        let mut w = self.writer.lock().await;
        w.shutdown().await?;
        Ok(())
    }
}

/// WebSocket transport — the production path.
///
/// `TcpHubChannel` above speaks raw TCP with newline framing and is what the local
/// `fixtures/hub/fake-hub.mjs` uses. It cannot traverse nginx, so it is a test transport only.
/// This one carries the same JSON frames as WebSocket text messages, which is what the hub
/// exposes at `/node/connect` and what nginx proxies with the Upgrade/Connection pair.
pub struct WsHubChannel {
    sink: Mutex<futures_util::stream::SplitSink<WsStream, WsMessage>>,
    stream: Mutex<futures_util::stream::SplitStream<WsStream>>,
}

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

impl WsHubChannel {
    /// Dial `url` (ws:// or wss://) and complete the handshake.
    pub async fn connect(url: &str) -> NodeResult<Self> {
        let (ws, _response) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| NodeError::InvalidFrame(format!("websocket connect {url}: {e}")))?;
        let (sink, stream) = futures_util::StreamExt::split(ws);
        Ok(Self { sink: Mutex::new(sink), stream: Mutex::new(stream) })
    }
}

#[async_trait]
impl HubTransport for WsHubChannel {
    async fn send_frame(&self, frame: &[u8]) -> NodeResult<()> {
        use futures_util::SinkExt;
        let text = String::from_utf8(frame.to_vec())
            .map_err(|e| NodeError::InvalidFrame(format!("frame is not utf8: {e}")))?;
        let mut sink = self.sink.lock().await;
        sink.send(WsMessage::Text(text.into()))
            .await
            .map_err(|e| NodeError::InvalidFrame(format!("websocket send: {e}")))?;
        Ok(())
    }

    async fn recv_frame(&self) -> NodeResult<Option<Vec<u8>>> {
        use futures_util::StreamExt;
        let mut stream = self.stream.lock().await;
        loop {
            match stream.next().await {
                Some(Ok(WsMessage::Text(t))) => return Ok(Some(t.as_bytes().to_vec())),
                Some(Ok(WsMessage::Binary(b))) => return Ok(Some(b.to_vec())),
                // Ping/Pong are handled by tungstenite; Close ends the stream. Keep waiting on
                // anything else rather than reporting a spurious disconnect to the reconnect loop.
                Some(Ok(WsMessage::Close(_))) | None => return Ok(None),
                Some(Ok(_)) => continue,
                Some(Err(e)) => {
                    return Err(NodeError::InvalidFrame(format!("websocket recv: {e}")))
                }
            }
        }
    }

    async fn close(&self) -> NodeResult<()> {
        use futures_util::SinkExt;
        let mut sink = self.sink.lock().await;
        let _ = sink.close().await;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloFrame {
    pub node_id: Uuid,
    pub token: String,
    pub hostname: String,
    pub os: String,
    pub version: String,
    pub resume_cursor: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloAccepted {
    pub node_id: Uuid,
    pub heartbeat_ms: u64,
    pub resume_cursor: i64,
    #[serde(default)]
    pub seat_tokens: Vec<SeatToken>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeatToken { pub seat_id: Uuid, pub token: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HubEvent {
    HelloAccepted(HelloAccepted),
    DeliveryAssign {
        delivery: Delivery,
        message: Message,
        parent: Option<Message>,
        context_messages: Vec<Message>,
        room_slug: String,
        room_title: String,
        room_objective: String,
        seats: Vec<Seat>,
    },
    ApprovalResolve { approval_id: Uuid, decision: String },
    SeatDetach { seat_id: Uuid, reason: String },
    /// Cancellation contract §2 — the operator canceled a delivery this node is actively running.
    /// The node translates it to the provider's native interrupt (Codex `turn/interrupt`).
    SeatInterrupt { delivery_id: Uuid, reason: String },
    /// The hub's answer to a `node.query`, correlated by `request_id`.
    ///
    /// The only hub->node frame that is a response rather than an event: it is routed to the
    /// waiting caller through `pending_queries` and deliberately not published on the event
    /// stream, which carries things that happen TO this node, not replies it asked for.
    QueryResult {
        request_id: Uuid,
        ok: bool,
        result: Option<serde_json::Value>,
        error: Option<String>,
    },
    Ping { nonce: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HubCommand {
    Hello(HelloFrame),
    /// A read request. Answered by exactly one `query.result` carrying the same `request_id`.
    QueryRequest { request_id: Uuid, query: Value },
    DeliveryAck { delivery_id: Uuid },
    DeliveryState {
        delivery_id: Uuid,
        state: DeliveryState,
        error_code: Option<String>,
    },
    MessagePost {
        request_id: Uuid,
        seat_id: Uuid,
        room_id: Uuid,
        message_kind: MessageKind,
        body: String,
        reply_to: Option<Uuid>,
        request_payload_sha256: String,
    },
    HandoffCreate {
        request_id: Uuid,
        from_seat_id: Uuid,
        to_seat_id: Uuid,
        body: String,
        evidence_refs: Vec<String>,
        request_payload_sha256: String,
    },
    ApprovalRequest {
        request_id: Uuid,
        seat_id: Uuid,
        delivery_id: Uuid,
        provider_request_id: String,
        description: String,
        input_preview: String,
        decisions: Vec<String>,
    },
    SeatPresence {
        seat_id: Uuid,
        state: SeatState,
        last_ack_seq: i64,
    },
    SessionCatalog {
        provider: SeatProvider,
        sessions: Vec<SessionCatalogEntry>,
    },
    Pong { nonce: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCatalogEntry {
    pub session_ref: String,
    pub title: String,
    pub cwd: Option<String>,
    pub last_active_ms: i64,
}

#[derive(Debug, Clone)]
pub struct ReconnectPolicy {
    pub base_ms: Vec<u64>,
    pub max_attempts: Option<u64>,
}

impl ReconnectPolicy {
    pub fn from_config(cfg: &NodeConfig) -> Self {
        Self { base_ms: cfg.reconnect_sequence_ms(), max_attempts: None }
    }

    pub fn delay_ms(&self, attempt: u64) -> Duration {
        let idx = (attempt as usize).min(self.base_ms.len().saturating_sub(1));
        let base = self.base_ms[idx];
        let jitter_factor = pseudo_jitter(attempt);
        Duration::from_millis(base.saturating_add(jitter_factor))
    }
}

fn pseudo_jitter(attempt: u64) -> u64 {
    let window = 200u64;
    let raw = (attempt.wrapping_mul(2654435761)) % (window * 2 + 1);
    raw.saturating_sub(window)
}

#[derive(Debug)]
pub enum ClientCommand {
    /// Ask the hub to read something this node does not hold: transcript, search, room roster.
    ///
    /// Unlike every other command here, this one waits for an answer — the node has no local copy
    /// of a room, so there is nothing to resolve optimistically against.
    Query {
        query: Value,
        response: oneshot::Sender<NodeResult<Value>>,
    },
    PostMessage {
        seat_id: Uuid,
        room_id: Uuid,
        kind: MessageKind,
        body: String,
        reply_to: Option<Uuid>,
        response: oneshot::Sender<NodeResult<Uuid>>,
    },
    Handoff {
        from_seat_id: Uuid,
        to_seat_id: Uuid,
        body: String,
        evidence_refs: Vec<String>,
        response: oneshot::Sender<NodeResult<Uuid>>,
    },
    ApprovalRequest {
        seat_id: Uuid,
        delivery_id: Uuid,
        provider_request_id: String,
        description: String,
        input_preview: String,
        decisions: Vec<String>,
        response: oneshot::Sender<NodeResult<Uuid>>,
    },
    SeatPresence {
        seat_id: Uuid,
        state: SeatState,
        last_ack_seq: i64,
    },
    Shutdown,
}

pub struct HubClient {
    cfg: NodeConfig,
    token: String,
    state: Arc<Mutex<NodeState>>,
    command_tx: mpsc::UnboundedSender<ClientCommand>,
    event_rx: Arc<Mutex<mpsc::UnboundedReceiver<HubEvent>>>,
    owned_seats: Arc<Mutex<Vec<Uuid>>>,
    transport_factory: Arc<dyn Fn() -> NodeResult<Box<dyn HubTransport>> + Send + Sync>,
}

impl HubClient {
    pub fn new(
        cfg: NodeConfig,
        token: String,
        state: Arc<Mutex<NodeState>>,
        transport_factory: Arc<dyn Fn() -> NodeResult<Box<dyn HubTransport>> + Send + Sync>,
    ) -> Self {
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let owned_seats = Arc::new(Mutex::new(Vec::new()));

        let client = Self {
            cfg: cfg.clone(),
            token,
            state: state.clone(),
            command_tx,
            event_rx: Arc::new(Mutex::new(event_rx)),
            owned_seats: owned_seats.clone(),
            transport_factory,
        };

        let driver = HubDriver {
            cfg: cfg.clone(),
            token: client.token.clone(),
            state,
            owned_seats,
            transport_factory: client.transport_factory.clone(),
            command_rx,
            event_tx,
            pending_queries: HashMap::new(),
        };
        let policy = ReconnectPolicy::from_config(&driver.cfg);
        tokio::spawn(async move {
            driver.run(policy).await;
        });

        client
    }

    pub fn command_tx(&self) -> mpsc::UnboundedSender<ClientCommand> {
        self.command_tx.clone()
    }

    pub async fn next_event(&self) -> Option<HubEvent> {
        let mut rx = self.event_rx.lock().await;
        rx.recv().await
    }

    /// Idempotent: a seat receiving many deliveries must not grow this vec without bound (it is
    /// scanned by `owns_seat` on every outbound post).
    pub async fn register_seat(&self, seat_id: Uuid) {
        let mut seats = self.owned_seats.lock().await;
        if !seats.contains(&seat_id) {
            seats.push(seat_id);
        }
    }

    /// Drops ownership of a seat — used when the hub detaches it. A later post for this seat is
    /// then correctly refused rather than silently accepted for a seat we no longer serve.
    pub async fn unregister_seat(&self, seat_id: Uuid) {
        self.owned_seats.lock().await.retain(|s| *s != seat_id);
    }

    pub async fn owns_seat(&self, seat_id: Uuid) -> bool {
        self.owned_seats.lock().await.contains(&seat_id)
    }

    pub async fn send(&self, cmd: ClientCommand) {
        let _ = self.command_tx.send(cmd);
    }

    /// Ask the hub to read something, and wait for the answer.
    ///
    /// `query` is the serde-tagged body, e.g. `{"transcript_read": {"room_id": ..., "limit": 50}}`.
    /// Errors rather than hangs if the driver is gone or the connection dies mid-flight, because
    /// the caller is a blocking MCP tool call inside a live agent session.
    pub async fn query(&self, query: Value) -> NodeResult<Value> {
        let (response, rx) = oneshot::channel();
        if self.command_tx.send(ClientCommand::Query { query, response }).is_err() {
            return Err(NodeError::Provider("node is shutting down".into()));
        }
        match rx.await {
            Ok(result) => result,
            Err(_) => Err(NodeError::Provider("hub dropped the query without answering".into())),
        }
    }
}

struct HubDriver {
    cfg: NodeConfig,
    token: String,
    state: Arc<Mutex<NodeState>>,
    owned_seats: Arc<Mutex<Vec<Uuid>>>,
    transport_factory: Arc<dyn Fn() -> NodeResult<Box<dyn HubTransport>> + Send + Sync>,
    command_rx: mpsc::UnboundedReceiver<ClientCommand>,
    event_tx: mpsc::UnboundedSender<HubEvent>,
    /// In-flight `node.query` requests, keyed by the `request_id` the answer will carry.
    ///
    /// Drained with an error whenever a connection ends: a caller blocked on a read whose answer
    /// died with the socket would otherwise wait forever, and that caller is an MCP tool call
    /// inside a live Claude session.
    pending_queries: HashMap<Uuid, oneshot::Sender<NodeResult<Value>>>,
}

impl HubDriver {
    async fn run(mut self, policy: ReconnectPolicy) {
        let mut attempt: u64 = 0;
        loop {
            match self.connect_and_drive().await {
                Ok(()) => { info!("hub connection closed cleanly"); attempt = 0; }
                Err(e) => warn!(error = %e, "hub connection failed"),
            }
            // Answers to in-flight reads died with the socket. Fail them explicitly — the caller
            // is a blocking MCP tool call, and silence there is indistinguishable from a hang.
            for (_, tx) in self.pending_queries.drain() {
                let _ = tx.send(Err(NodeError::Provider("hub connection lost".into())));
            }
            while self.command_rx.try_recv().is_ok() {}
            let delay = policy.delay_ms(attempt);
            debug!(?delay, attempt, "reconnecting");
            sleep(delay).await;
            attempt = attempt.saturating_add(1);
        }
    }
    async fn connect_and_drive(&mut self) -> NodeResult<()> {
        let transport = (self.transport_factory)()?;
        let resume_cursor = self.state.lock().await.last_cursor();
        let hello = HubCommand::Hello(HelloFrame {
            node_id: self.cfg.node_id,
            token: self.token.clone(),
            hostname: self.cfg.hostname.clone(),
            os: self.cfg.os.clone(),
            version: self.cfg.version.clone(),
            resume_cursor,
        });
        let frame = encode_frame("node.hello", &hello)?;
        transport.send_frame(&frame).await?;
        let raw = match transport.recv_frame().await? {
            Some(b) => b,
            None => return Err(NodeError::HubClosed),
        };
        let env: Envelope<Value> = serde_json::from_slice(&raw)
            .map_err(|e| NodeError::InvalidFrame(format!("hello.accepted: {e}")))?;
        if env.version != PROTOCOL_VERSION {
            return Err(NodeError::ProtocolVersion { hub: env.version, node: PROTOCOL_VERSION });
        }
        if env.kind != "hello.accepted" {
            return Err(NodeError::HubRejected(format!("expected hello.accepted, got {}", env.kind)));
        }
        let accepted: HelloAccepted = serde_json::from_value(env.payload)
            .map_err(|e| NodeError::InvalidFrame(format!("hello.accepted payload: {e}")))?;
        self.serve(transport, accepted).await
    }

    async fn serve(&mut self, transport: Box<dyn HubTransport>, accepted: HelloAccepted) -> NodeResult<()> {
        let transport_arc: Arc<dyn HubTransport> = Arc::from(transport);
        let (mut reader_tx, mut reader_rx) = mpsc::unbounded_channel::<HubEvent>();
        let transport_for_reader = transport_arc.clone();
        tokio::spawn(async move {
            loop {
                let raw = match transport_for_reader.recv_frame().await {
                    Ok(Some(b)) => b,
                    Ok(None) => break,
                    Err(_) => break,
                };
                let env: Envelope<Value> = match serde_json::from_slice(&raw) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if env.version != PROTOCOL_VERSION { continue; }
                // A deserialization failure here used to be entirely silent (`.ok()` alone,
                // dropping the Err with no trace at all): a hub frame whose shape didn't match
                // HubEvent's field names/types just vanished, and nothing distinguished "the hub
                // never sent this" from "the hub sent it and this node silently failed to parse
                // it" — which cost real debugging time chasing what turned out to be exactly the
                // latter. Every failure now logs the kind and the serde error before being
                // dropped; the drop-and-continue behavior itself is unchanged.
                let kind = env.kind.clone();
                let evt: Option<HubEvent> = match kind.as_str() {
                    // "seat.interrupt" was missing from this list while `HubEvent::SeatInterrupt`
                    // was fully handled in main.rs: the hub sent the frame, this arm fell through
                    // to the catch-all, and every operator cancellation was dropped with nothing
                    // but a "unrecognized hub frame kind" line. Cancellation looked implemented
                    // end to end and did nothing on the node.
                    "delivery.assign" | "approval.resolve" | "seat.detach" | "seat.interrupt"
                    | "query.result" | "ping" => {
                        match serde_json::from_value(env.payload) {
                            Ok(evt) => Some(evt),
                            Err(e) => {
                                warn!(kind = %kind, error = %e, "failed to parse hub event; dropping");
                                None
                            }
                        }
                    }
                    _ => {
                        warn!(kind = %kind, "unrecognized hub frame kind; dropping");
                        None
                    }
                };
                if let Some(evt) = evt {
                    if reader_tx.send(evt).is_err() { break; }
                }
            }
        });
        let transport_for_writer = transport_arc.clone();
        let event_tx_for_ping = self.event_tx.clone();
        let heartbeat_ms = accepted.heartbeat_ms.max(self.cfg.heartbeat_ms);
        tokio::spawn(async move {
            loop {
                sleep(Duration::from_millis(heartbeat_ms)).await;
                let pong = HubCommand::Pong { nonce: Uuid::now_v7().to_string() };
                if let Ok(bytes) = encode_frame("node.pong", &pong) {
                    if transport_for_writer.send_frame(&bytes).await.is_err() { break; }
                }
                let _ = event_tx_for_ping.send(HubEvent::Ping { nonce: Uuid::now_v7().to_string() });
            }
        });
        loop {
            tokio::select! {
                evt = reader_rx.recv() => {
                    match evt {
                        Some(e) => {
                            // A query answer belongs to one waiting caller, not to the event
                            // stream. Routed and consumed here.
                            if let HubEvent::QueryResult { request_id, ok, result, error } = &e {
                                if let Some(tx) = self.pending_queries.remove(request_id) {
                                    let outcome = if *ok {
                                        Ok(result.clone().unwrap_or(Value::Null))
                                    } else {
                                        Err(NodeError::Provider(
                                            error.clone().unwrap_or_else(|| "query failed".into()),
                                        ))
                                    };
                                    let _ = tx.send(outcome);
                                } else {
                                    warn!(%request_id, "query result for an unknown request; dropping");
                                }
                                continue;
                            }
                            if let HubEvent::DeliveryAssign { ref delivery, .. } = e {
                                let mut s = self.state.lock().await;
                                s.upsert_delivery(crate::state::DeliveryRecord {
                                    delivery_id: delivery.id,
                                    room_id: delivery.room_id,
                                    seat_id: delivery.seat_id,
                                    state: "queued".into(),
                                    attempt: delivery.attempt,
                                    last_event_id: None,
                                });
                                s.mark_event_acked(Uuid::now_v7(), accepted.resume_cursor);
                            }
                            let _ = self.event_tx.send(e.clone());
                            if let HubEvent::DeliveryAssign { delivery, .. } = e {
                                let ack = HubCommand::DeliveryAck { delivery_id: delivery.id };
                                if let Ok(bytes) = encode_frame("node.delivery.ack", &ack) {
                                    let _ = transport_arc.send_frame(&bytes).await;
                                }
                                let mut s = self.state.lock().await;
                                if let Some(rec) = s.deliveries.get_mut(&delivery.id) {
                                    rec.state = "acked".into();
                                }
                            }
                        }
                        None => return Ok(()),
                    }
                }
                cmd = self.command_rx.recv() => self.handle_command(cmd, &transport_arc).await?,
            }
        }
    }

    async fn handle_command(&mut self, cmd: Option<ClientCommand>, transport_arc: &Arc<dyn HubTransport>) -> NodeResult<()> {
        match cmd {
            Some(ClientCommand::Query { query, response }) => {
                let request_id = Uuid::now_v7();
                let frame = HubCommand::QueryRequest { request_id, query };
                let bytes = encode_frame("node.query", &frame)?;
                // Register BEFORE the write: the answer can arrive on the reader task the moment
                // the bytes land, and a result for an unregistered request is dropped.
                self.pending_queries.insert(request_id, response);
                if transport_arc.send_frame(&bytes).await.is_err() {
                    if let Some(tx) = self.pending_queries.remove(&request_id) {
                        let _ = tx.send(Err(NodeError::Provider("hub connection lost".into())));
                    }
                }
            }
            Some(ClientCommand::PostMessage { seat_id, room_id, kind, body, reply_to, response }) => {
                if !self.owned_seats.lock().await.contains(&seat_id) {
                    let _ = response.send(Err(NodeError::UnknownSeat(seat_id)));
                    return Ok(());
                }
                if validate_message_body(&body).is_err() {
                    let _ = response.send(Err(NodeError::Provider("invalid body".into())));
                    return Ok(());
                }
                let req_id = Uuid::now_v7();
                let payload = serde_json::json!({"kind": kind, "body": body, "reply_to": reply_to});
                let sha = canonical_sha256(&payload).unwrap_or_default();
                let frame = HubCommand::MessagePost {
                    request_id: req_id, seat_id, room_id, message_kind: kind, body, reply_to,
                    request_payload_sha256: sha,
                };
                if let Ok(b) = encode_frame("node.message.post", &frame) {
                    let _ = transport_arc.send_frame(&b).await;
                }
                let _ = response.send(Ok(req_id));
            }
            Some(ClientCommand::Handoff { from_seat_id, to_seat_id, body, evidence_refs, response }) => {
                if !self.owned_seats.lock().await.contains(&from_seat_id) {
                    let _ = response.send(Err(NodeError::UnknownSeat(from_seat_id)));
                    return Ok(());
                }
                if validate_message_body(&body).is_err() {
                    let _ = response.send(Err(NodeError::Provider("invalid body".into())));
                    return Ok(());
                }
                let req_id = Uuid::now_v7();
                let payload = serde_json::json!({"body": body, "evidence_refs": evidence_refs});
                let sha = canonical_sha256(&payload).unwrap_or_default();
                let frame = HubCommand::HandoffCreate {
                    request_id: req_id, from_seat_id, to_seat_id, body, evidence_refs,
                    request_payload_sha256: sha,
                };
                if let Ok(b) = encode_frame("node.handoff.create", &frame) {
                    let _ = transport_arc.send_frame(&b).await;
                }
                let _ = response.send(Ok(req_id));
            }
            Some(ClientCommand::ApprovalRequest { seat_id, delivery_id, provider_request_id, description, input_preview, decisions, response }) => {
                if !self.owned_seats.lock().await.contains(&seat_id) {
                    let _ = response.send(Err(NodeError::UnknownSeat(seat_id)));
                    return Ok(());
                }
                let req_id = Uuid::now_v7();
                let frame = HubCommand::ApprovalRequest {
                    request_id: req_id, seat_id, delivery_id, provider_request_id,
                    description, input_preview, decisions,
                };
                if let Ok(b) = encode_frame("node.approval.request", &frame) {
                    let _ = transport_arc.send_frame(&b).await;
                }
                let _ = response.send(Ok(req_id));
            }
            Some(ClientCommand::SeatPresence { seat_id, state, last_ack_seq }) => {
                let frame = HubCommand::SeatPresence { seat_id, state, last_ack_seq };
                if let Ok(b) = encode_frame("node.seat.presence", &frame) {
                    let _ = transport_arc.send_frame(&b).await;
                }
            }
            Some(ClientCommand::Shutdown) => {
                let _ = transport_arc.close().await;
                return Err(NodeError::Cancelled);
            }
            None => return Err(NodeError::HubClosed),
        }
        Ok(())
    }
}

fn encode_frame<T: Serialize>(kind: &str, payload: &T) -> NodeResult<Vec<u8>> {
    let env = Envelope {
        version: PROTOCOL_VERSION,
        event_id: Uuid::now_v7(),
        sent_at_ms: now_ms(),
        kind: kind.into(),
        payload,
    };
    Ok(serde_json::to_vec(&env)?)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub async fn connect_tcp(addr: std::net::SocketAddr) -> NodeResult<TcpHubChannel> {
    let stream = timeout(Duration::from_secs(5), TcpStream::connect(addr))
        .await
        .map_err(|_| NodeError::HubClosed)??;
    Ok(TcpHubChannel::new(stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NodeConfig;
    use std::path::PathBuf;

    fn test_config() -> NodeConfig {
        NodeConfig {
            hub_url: "ws://localhost".into(),
            node_id: Uuid::now_v7(),
            hostname: "t".into(),
            os: "test".into(),
            version: "0.0.1".into(),
            ipc_socket_path: PathBuf::from("/tmp/roundtable-ipc"),
            state_path: PathBuf::from("/tmp/roundtable-state"),
            codex_command: vec!["fake-codex.mjs".into()],
            codex_cwd: None,
            reconnect_base_ms: 1000,
            heartbeat_ms: 50,
            heartbeat_offline_after_ms: 200,
        }
    }

    /// The hub reads `frame.payload.query_request` (packages/hub/src/server.mjs). serde's external
    /// tagging is what puts it there, and nothing in Rust would catch a rename — the symptom would
    /// be a silently ignored read in production, so pin the wire key here.
    #[test]
    fn query_request_serializes_under_the_key_the_hub_reads() {
        let cmd = HubCommand::QueryRequest {
            request_id: Uuid::now_v7(),
            query: serde_json::json!({ "transcript_read": { "room_id": "r", "limit": 10 } }),
        };
        let v: Value = serde_json::to_value(&cmd).unwrap();
        assert!(v.get("query_request").is_some(), "hub reads payload.query_request; got {v}");
        assert_eq!(v["query_request"]["query"]["transcript_read"]["limit"], 10);
    }

    /// Mirror of the above for the response direction: the hub sends
    /// `payload.query_result = { request_id, ok, result, error }`.
    #[test]
    fn query_result_parses_the_frame_the_hub_sends() {
        let request_id = Uuid::now_v7();
        let payload = serde_json::json!({
            "query_result": {
                "request_id": request_id,
                "ok": true,
                "result": { "messages": [] },
                "error": null,
            },
        });
        let evt: HubEvent = serde_json::from_value(payload).unwrap();
        match evt {
            HubEvent::QueryResult { request_id: got, ok, result, error } => {
                assert_eq!(got, request_id);
                assert!(ok);
                assert!(error.is_none());
                assert!(result.unwrap()["messages"].is_array());
            }
            other => panic!("expected QueryResult, got {other:?}"),
        }
    }

    /// A refusal must parse too — `room_not_accessible` is how the hub denies a room this node
    /// holds no seat in, and it arrives with `result: null`.
    #[test]
    fn query_result_parses_a_refusal() {
        let payload = serde_json::json!({
            "query_result": {
                "request_id": Uuid::now_v7(),
                "ok": false,
                "result": null,
                "error": "room_not_accessible",
            },
        });
        let evt: HubEvent = serde_json::from_value(payload).unwrap();
        match evt {
            HubEvent::QueryResult { ok, error, .. } => {
                assert!(!ok);
                assert_eq!(error.as_deref(), Some("room_not_accessible"));
            }
            other => panic!("expected QueryResult, got {other:?}"),
        }
    }

    #[test]
    fn reconnect_delay_uses_locked_sequence() {
        let policy = ReconnectPolicy {
            base_ms: test_config().reconnect_sequence_ms(),
            max_attempts: None,
        };
        assert!(policy.delay_ms(0).as_millis() >= 800 && policy.delay_ms(0).as_millis() <= 1200);
        assert!(policy.delay_ms(1).as_millis() >= 1800 && policy.delay_ms(1).as_millis() <= 2200);
        assert!(policy.delay_ms(2).as_millis() >= 3800 && policy.delay_ms(2).as_millis() <= 4200);
        assert!(policy.delay_ms(10).as_millis() >= 29800 && policy.delay_ms(10).as_millis() <= 30200);
    }

    #[test]
    fn hello_frame_round_trips() {
        let frame = HelloFrame {
            node_id: Uuid::now_v7(),
            token: "secret".into(),
            hostname: "t".into(),
            os: "test".into(),
            version: "0.0.1".into(),
            resume_cursor: Some(42),
        };
        let bytes = serde_json::to_vec(&frame).unwrap();
        let back: HelloFrame = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.token, "secret");
        assert_eq!(back.resume_cursor, Some(42));
    }

    #[test]
    fn jitter_is_deterministic_for_test_repeatability() {
        assert_eq!(pseudo_jitter(0), pseudo_jitter(0));
        assert_eq!(pseudo_jitter(7), pseudo_jitter(7));
        for attempt in 0..20u64 {
            let j = pseudo_jitter(attempt);
            assert!(j <= 200, "jitter out of range for attempt {}: {}", attempt, j);
        }
    }

    #[test]
    fn hub_command_post_message_serializes() {
        let frame = HubCommand::MessagePost {
            request_id: Uuid::now_v7(),
            seat_id: Uuid::now_v7(),
            room_id: Uuid::now_v7(),
            message_kind: MessageKind::Chat,
            body: "hi".into(),
            reply_to: None,
            request_payload_sha256: "abc".into(),
        };
        let bytes = serde_json::to_vec(&frame).unwrap();
        let back: HubCommand = serde_json::from_slice(&bytes).unwrap();
        match back {
            HubCommand::MessagePost { body, .. } => assert_eq!(body, "hi"),
            _ => panic!("wrong variant"),
        }
    }
}
