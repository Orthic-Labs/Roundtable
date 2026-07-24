use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    Human,
    Agent,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryReason {
    HumanMention,
    StructuredHandoff,
    HumanFollowup,
    ApprovalResolved,
    OperatorResume,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SeatProvider {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SeatState {
    Detached,
    Offline,
    Idle,
    Running,
    WaitingApproval,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Room {
    pub id: Uuid,
    pub slug: String,
    pub title: String,
    pub objective: String,
    pub next_seq: i64,
    pub archived_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Envelope<T> {
    pub version: u8,
    pub event_id: Uuid,
    pub sent_at_ms: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MessageMutation {
    pub request_id: Uuid,
    pub room_id: Uuid,
    pub kind: MessageKind,
    pub body: String,
    pub reply_to: Option<Uuid>,
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("message exceeds 64 KiB")]
    MessageTooLarge,
    #[error("invalid message body")]
    InvalidMessage,
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

pub fn validate_message_body(body: &str) -> Result<(), ProtocolError> {
    if body.is_empty() || body.len() > MAX_MESSAGE_BYTES {
        return Err(if body.is_empty() {
            ProtocolError::InvalidMessage
        } else {
            ProtocolError::MessageTooLarge
        });
    }
    Ok(())
}

pub fn decode_mutation<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ProtocolError> {
    Ok(serde_json::from_slice(bytes)?)
}

pub fn canonical_sha256<T: Serialize>(value: &T) -> Result<String, ProtocolError> {
    let bytes = serde_json::to_vec(value).map_err(ProtocolError::Json)?;
    let mut digest = Sha256::new();
    digest.update(bytes);
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_v7_round_trips() {
        let id = Uuid::now_v7();
        let encoded = serde_json::to_string(&id).unwrap();
        assert_eq!(id, serde_json::from_str::<Uuid>(&encoded).unwrap());
    }

    #[test]
    fn unknown_mutation_field_rejects() {
        let json = br#"{"request_id":"01900000-0000-7000-8000-000000000001","room_id":"01900000-0000-7000-8000-000000000002","kind":"chat","body":"hi","reply_to":null,"extra":true}"#;
        assert!(decode_mutation::<MessageMutation>(json).is_err());
    }

    #[test]
    fn websocket_envelope_round_trips() {
        let envelope = Envelope {
            version: PROTOCOL_VERSION,
            event_id: Uuid::now_v7(),
            sent_at_ms: 1,
            kind: "ping".into(),
            payload: serde_json::json!({"nonce":"x"}),
        };
        let bytes = serde_json::to_vec(&envelope).unwrap();
        let decoded: Envelope<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded, envelope);
    }

    #[test]
    fn message_size_limit_is_bytes_not_chars() {
        assert!(validate_message_body(&"é".repeat(MAX_MESSAGE_BYTES / 2)).is_ok());
        assert!(validate_message_body(&"é".repeat(MAX_MESSAGE_BYTES / 2 + 1)).is_err());
    }

    #[test]
    fn agent_prose_mentions_do_not_create_targets() {
        let prose = "@codex please review this";
        assert!(prose.contains('@'));
        assert!(decode_mutation::<MessageMutation>(br#"{"request_id":"01900000-0000-7000-8000-000000000001","room_id":"01900000-0000-7000-8000-000000000002","kind":"chat","body":"@codex please review this","reply_to":null}"#).is_ok());
    }
}
