use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use thiserror::Error;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MESSAGE_BODY_MAX_BYTES: usize = 64 * 1024;
pub const ROOM_TITLE_MAX_CHARS: usize = 120;
pub const ROOM_OBJECTIVE_MAX_CHARS: usize = 4_000;
pub const SEAT_ALIAS_MAX_CHARS: usize = 48;
pub const PAGE_LIMIT_MAX: u16 = 100;
pub const CONTEXT_MAX_BYTES: usize = 32 * 1024;
pub const CONTEXT_MAX_MESSAGES: usize = 20;
pub const HANDOFF_DEPTH_LIMIT: i64 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    Human,
    Agent,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Chat,
    Question,
    Progress,
    Completion,
    Handoff,
    Approval,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryReason {
    HumanMention,
    StructuredHandoff,
    HumanFollowup,
    ApprovalResolved,
    OperatorResume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Queued,
    Sent,
    Acked,
    Running,
    WaitingApproval,
    Completed,
    Failed,
    DeadLetter,
}

/// Seat runtime family — not a one-to-one model identity.
///
/// Citadel splits identity as model / harness / session. `SeatProvider` names the harness
/// family a seat is attached through; the concrete model (e.g. MiniMax-M3) and session live
/// on `session_ref` / free-text run attribution fields until RuntimeProfile lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeatProvider {
    Claude,
    Codex,
    /// MiniMax-shaped seat (direct or via a MiniMax-aware harness).
    Minimax,
    /// Claude Code X (`ccx`) third-party harness seat.
    Ccx,
    /// Codex-proxy (`cdx`) third-party harness seat.
    Cdx,
    /// Escape hatch for a CLI/generic harness not yet given a dedicated variant.
    Other,
}

/// Harness shape a seat runs through — orthogonal to which model answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeatHarness {
    ClaudeCode,
    CodexAppServer,
    Ccx,
    Cdx,
    GenericCli,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeatState {
    Detached,
    Offline,
    Idle,
    Running,
    WaitingApproval,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Room {
    pub id: Uuid,
    pub slug: String,
    pub title: String,
    pub objective: String,
    pub next_seq: i64,
    pub archived_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub id: Uuid,
    pub room_id: Uuid,
    pub seq: i64,
    pub actor_id: Uuid,
    pub actor_kind: ActorKind,
    pub kind: MessageKind,
    pub body: String,
    pub reply_to: Option<Uuid>,
    pub mentioned_seat_ids: Vec<Uuid>,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seat {
    pub id: Uuid,
    pub room_id: Uuid,
    pub node_id: Uuid,
    pub alias: String,
    pub provider: SeatProvider,
    pub session_ref: String,
    pub state: SeatState,
    pub last_seen_ms: i64,
    pub last_ack_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Delivery {
    pub id: Uuid,
    pub room_id: Uuid,
    pub message_id: Uuid,
    pub seat_id: Uuid,
    pub reason: DeliveryReason,
    pub state: DeliveryState,
    pub attempt: i64,
    pub lease_until_ms: Option<i64>,
    pub error_code: Option<String>,
    #[serde(default)]
    pub run_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Node {
    pub id: Uuid,
    pub name: String,
    pub created_at_ms: i64,
    pub revoked_at_ms: Option<i64>,
    pub last_seen_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Approval {
    pub id: Uuid,
    pub room_id: Uuid,
    pub seat_id: Uuid,
    pub delivery_id: Uuid,
    pub provider_request_id: String,
    pub description: String,
    pub input_preview: String,
    pub decisions: Vec<String>,
    pub state: String,
    pub resolution: Option<String>,
    pub created_at_ms: i64,
    pub resolved_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventRecord {
    pub cursor: i64,
    pub event_id: Uuid,
    pub target_node_id: Option<Uuid>,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    CommitSha,
    TestCommand,
    ArtifactPath,
    Url,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceRef {
    pub kind: EvidenceKind,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRoomRequest {
    pub request_id: Uuid,
    pub slug: String,
    pub title: String,
    pub objective: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateRoomRequest {
    pub request_id: Uuid,
    pub title: Option<String>,
    pub objective: Option<String>,
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostMessageRequest {
    pub request_id: Uuid,
    pub kind: MessageKind,
    pub body: String,
    pub reply_to: Option<Uuid>,
    #[serde(default)]
    pub mentioned_seat_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateSeatRequest {
    pub request_id: Uuid,
    pub node_id: Uuid,
    pub alias: String,
    pub provider: SeatProvider,
    pub session_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateHandoffRequest {
    pub request_id: Uuid,
    pub from_seat_id: Uuid,
    pub to_seat_id: Uuid,
    pub body: String,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
    pub task_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveApprovalRequest {
    pub request_id: Uuid,
    pub decision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginRequest {
    pub request_id: Uuid,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateNodeRequest {
    pub request_id: Uuid,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsEnvelope<E> {
    pub version: u16,
    pub event_id: Uuid,
    pub sent_at_ms: i64,
    #[serde(flatten)]
    pub event: E,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryAssignment {
    pub delivery: Delivery,
    pub message: Message,
    pub parent: Option<Message>,
    pub context_messages: Vec<Message>,
    pub room: Room,
    pub seats: Vec<Seat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum HubEvent {
    #[serde(rename = "hello.accepted")]
    HelloAccepted {
        node_id: Uuid,
        heartbeat_ms: i64,
        resume_cursor: i64,
    },
    #[serde(rename = "delivery.assign")]
    DeliveryAssign(Box<DeliveryAssignment>),
    #[serde(rename = "approval.resolve")]
    ApprovalResolve { approval_id: Uuid, decision: String },
    #[serde(rename = "seat.detach")]
    SeatDetach { seat_id: Uuid, reason: String },
    #[serde(rename = "seat.interrupt")]
    SeatInterrupt { delivery_id: Uuid, reason: String },
    #[serde(rename = "ping")]
    Ping { nonce: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum NodeEvent {
    #[serde(rename = "hello")]
    Hello(NodeHello),
    #[serde(rename = "delivery.ack")]
    DeliveryAck(DeliveryAck),
    #[serde(rename = "delivery.state")]
    DeliveryState(DeliveryStateUpdate),
    #[serde(rename = "message.post")]
    MessagePost(NodeMessagePost),
    #[serde(rename = "handoff.create")]
    HandoffCreate(NodeHandoffCreate),
    #[serde(rename = "approval.request")]
    ApprovalRequest(NodeApprovalRequest),
    #[serde(rename = "seat.presence")]
    SeatPresence(SeatPresenceUpdate),
    #[serde(rename = "session.catalog")]
    SessionCatalog(SessionCatalog),
    #[serde(rename = "pong")]
    Pong(Pong),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeHello {
    pub node_id: Uuid,
    pub token: String,
    pub hostname: String,
    pub os: String,
    pub version: String,
    pub resume_cursor: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryAck {
    pub delivery_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryStateUpdate {
    pub delivery_id: Uuid,
    pub state: DeliveryState,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeMessagePost {
    pub request_id: Uuid,
    pub seat_id: Uuid,
    pub room_id: Uuid,
    pub kind: MessageKind,
    pub body: String,
    pub reply_to: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeHandoffCreate {
    pub request_id: Uuid,
    pub from_seat_id: Uuid,
    pub to_seat_id: Uuid,
    pub body: String,
    pub evidence_refs: Vec<EvidenceRef>,
    pub task_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeApprovalRequest {
    pub request_id: Uuid,
    pub seat_id: Uuid,
    pub delivery_id: Uuid,
    pub provider_request_id: String,
    pub description: String,
    pub input_preview: String,
    pub decisions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionCatalog {
    pub provider: SeatProvider,
    pub sessions: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeatPresenceUpdate {
    pub seat_id: Uuid,
    pub state: SeatState,
    pub last_ack_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pong {
    pub nonce: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("message_too_large")]
    MessageTooLarge,
    #[error("title_too_long")]
    TitleTooLong,
    #[error("objective_too_long")]
    ObjectiveTooLong,
    #[error("invalid_alias")]
    InvalidAlias,
    #[error("invalid_slug")]
    InvalidSlug,
    #[error("invalid_handoff")]
    InvalidHandoff,
    #[error("page_limit")]
    PageLimit,
}

pub fn validate_message_body(body: &str) -> Result<(), ValidationError> {
    if body.len() > MESSAGE_BODY_MAX_BYTES {
        Err(ValidationError::MessageTooLarge)
    } else {
        Ok(())
    }
}

pub fn validate_room(slug: &str, title: &str, objective: &str) -> Result<(), ValidationError> {
    if title.chars().count() > ROOM_TITLE_MAX_CHARS {
        return Err(ValidationError::TitleTooLong);
    }
    if objective.chars().count() > ROOM_OBJECTIVE_MAX_CHARS {
        return Err(ValidationError::ObjectiveTooLong);
    }
    if !valid_kebab(slug, 80) {
        return Err(ValidationError::InvalidSlug);
    }
    Ok(())
}

pub fn validate_alias(alias: &str) -> Result<(), ValidationError> {
    if valid_kebab(alias, SEAT_ALIAS_MAX_CHARS) {
        Ok(())
    } else {
        Err(ValidationError::InvalidAlias)
    }
}

pub fn validate_handoff(body: &str, evidence: &[EvidenceRef]) -> Result<(), ValidationError> {
    validate_message_body(body)?;
    if body.trim().is_empty()
        || evidence
            .iter()
            .any(|item| item.value.trim().is_empty() || item.value.len() > 4_096)
    {
        return Err(ValidationError::InvalidHandoff);
    }
    Ok(())
}

fn valid_kebab(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub fn human_selected_targets(actor: ActorKind, selected: &[Uuid]) -> Vec<Uuid> {
    if actor != ActorKind::Human {
        return Vec::new();
    }
    selected
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub fn canonical_json(value: &impl Serialize) -> Result<Vec<u8>, serde_json::Error> {
    let value = serde_json::to_value(value)?;
    serde_json::to_vec(&sort_json(value))
}

pub fn canonical_sha256(value: &impl Serialize) -> Result<String, serde_json::Error> {
    let bytes = canonical_json(value)?;
    let digest = Sha256::digest(bytes);
    Ok(format!("{digest:x}"))
}

fn sort_json(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.into_iter().collect();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            let mut sorted = Map::new();
            for (key, value) in entries {
                sorted.insert(key, sort_json(value));
            }
            Value::Object(sorted)
        }
        Value::Array(values) => Value::Array(values.into_iter().map(sort_json).collect()),
        other => other,
    }
}

pub fn new_id() -> Uuid {
    Uuid::now_v7()
}

pub fn human_actor_id() -> Uuid {
    Uuid::parse_str("01900000-0000-7000-8000-000000000001").expect("valid human actor UUID")
}

pub fn system_actor_id() -> Uuid {
    Uuid::parse_str("01900000-0000-7000-8000-000000000002").expect("valid system actor UUID")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_v7_round_trips() {
        let id = new_id();
        assert_eq!(id.get_version_num(), 7);
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(serde_json::from_str::<Uuid>(&json).unwrap(), id);
    }

    #[test]
    fn unknown_mutation_field_rejects() {
        let json = format!(
            r#"{{"request_id":"{}","kind":"chat","body":"ok","reply_to":null,"mentioned_seat_ids":[],"surprise":true}}"#,
            new_id()
        );
        assert!(serde_json::from_str::<PostMessageRequest>(&json).is_err());
    }

    #[test]
    fn websocket_envelope_round_trips() {
        let event = WsEnvelope {
            version: PROTOCOL_VERSION,
            event_id: new_id(),
            sent_at_ms: 42,
            event: HubEvent::Ping { nonce: "n".into() },
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"ping""#));
        let decoded: WsEnvelope<HubEvent> = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.version, PROTOCOL_VERSION);
    }

    #[test]
    fn message_size_limit_is_bytes_not_chars() {
        let body = "é".repeat(MESSAGE_BODY_MAX_BYTES / 2 + 1);
        assert_eq!(body.chars().count(), MESSAGE_BODY_MAX_BYTES / 2 + 1);
        assert_eq!(
            validate_message_body(&body),
            Err(ValidationError::MessageTooLarge)
        );
    }

    #[test]
    fn agent_prose_mentions_do_not_create_targets() {
        let seats = [new_id(), new_id()];
        assert!(human_selected_targets(ActorKind::Agent, &seats).is_empty());
        assert_eq!(human_selected_targets(ActorKind::Human, &seats).len(), 2);
    }
}
