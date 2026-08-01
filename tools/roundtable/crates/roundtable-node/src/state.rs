//! Durable node state — inbox, outbox, and contiguous applied cursor.
//!
//! Citadel 6.7–6.8 / P1 item 9:
//! - Outbox entries persist before send and clear only after a hub-commit ack
//!   (`mutation.result`), so callers cannot observe false success on a write that never committed.
//! - Inbox stores the envelope's real `event_id` and full payload; the resume cursor advances
//!   only after apply, and accepted-but-unapplied work is replayed on startup.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use crate::NodeResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CursorRecord {
    pub event_id: Uuid,
    pub cursor: i64,
    pub persisted_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeliveryRecord {
    pub delivery_id: Uuid,
    pub room_id: Uuid,
    pub seat_id: Uuid,
    pub state: String,
    pub attempt: i64,
    pub last_event_id: Option<Uuid>,
}

/// Inbound hub envelope awaiting or finishing local apply.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InboxRecord {
    pub event_id: Uuid,
    pub cursor: i64,
    pub kind: String,
    /// Envelope payload JSON (the nested `payload` object).
    pub payload_json: String,
    /// `received` → `accepted` → `applied` | `terminal`
    pub state: String,
    pub persisted_at_ms: i64,
}

/// Outbound mutation waiting for hub commit acknowledgement.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutboxRecord {
    pub request_id: Uuid,
    pub kind: String,
    pub wire_type: String,
    pub payload_json: String,
    pub payload_hash: String,
    /// `pending` → `sent` → `acked` (acked rows are removed)
    pub state: String,
    pub created_at_ms: i64,
    pub last_sent_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NodeState {
    /// Contiguous applied cursor — the only value used as `resume_cursor` on reconnect.
    #[serde(default)]
    pub contiguous_cursor: i64,
    /// Legacy map retained for migration from older state files; no longer written.
    #[serde(default)]
    pub cursors: HashMap<Uuid, CursorRecord>,
    #[serde(default)]
    pub inbox: HashMap<Uuid, InboxRecord>,
    #[serde(default)]
    pub outbox: HashMap<Uuid, OutboxRecord>,
    pub deliveries: HashMap<Uuid, DeliveryRecord>,
    pub completed_deliveries: HashMap<Uuid, i64>,
}

impl Default for NodeState {
    fn default() -> Self {
        Self {
            contiguous_cursor: 0,
            cursors: HashMap::new(),
            inbox: HashMap::new(),
            outbox: HashMap::new(),
            deliveries: HashMap::new(),
            completed_deliveries: HashMap::new(),
        }
    }
}

impl NodeState {
    pub fn load_or_default(path: &Path) -> NodeResult<Self> {
        if !path.exists() {
            return Ok(NodeState::default());
        }
        let bytes = std::fs::read(path)?;
        if bytes.is_empty() {
            return Ok(NodeState::default());
        }
        let mut state: NodeState = serde_json::from_slice(&bytes)?;
        state.migrate_legacy_cursors();
        Ok(state)
    }

    pub fn save(&self, path: &Path) -> NodeResult<()> {
        let bytes = serde_json::to_vec(self)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Older state files only had `cursors` keyed by a fabricated UUID. Promote the max cursor
    /// into `contiguous_cursor` once so reconnect does not rewind to 0.
    fn migrate_legacy_cursors(&mut self) {
        if self.contiguous_cursor == 0 {
            if let Some(max) = self.cursors.values().map(|r| r.cursor).max() {
                self.contiguous_cursor = max;
            }
        }
    }

    /// Resume cursor for `node.hello` — only fully applied work.
    pub fn last_cursor(&self) -> Option<i64> {
        if self.contiguous_cursor > 0 {
            Some(self.contiguous_cursor)
        } else {
            None
        }
    }

    pub fn contiguous_cursor(&self) -> i64 {
        self.contiguous_cursor
    }

    /// Persist an inbound envelope before any local apply. Idempotent on `event_id`.
    pub fn receive_inbox(
        &mut self,
        event_id: Uuid,
        cursor: i64,
        kind: impl Into<String>,
        payload: &Value,
    ) -> &InboxRecord {
        if self.inbox.contains_key(&event_id) {
            return self.inbox.get(&event_id).expect("just checked");
        }
        let rec = InboxRecord {
            event_id,
            cursor,
            kind: kind.into(),
            payload_json: payload.to_string(),
            state: "received".into(),
            persisted_at_ms: now_ms(),
        };
        self.inbox.insert(event_id, rec);
        self.inbox.get(&event_id).expect("just inserted")
    }

    pub fn mark_inbox_accepted(&mut self, event_id: Uuid) {
        if let Some(rec) = self.inbox.get_mut(&event_id) {
            if rec.state == "received" {
                rec.state = "accepted".into();
            }
        }
    }

    pub fn mark_inbox_applied(&mut self, event_id: Uuid) {
        if let Some(rec) = self.inbox.get_mut(&event_id) {
            if rec.state != "terminal" {
                rec.state = "applied".into();
            }
        }
        self.recompute_contiguous_cursor();
    }

    pub fn mark_inbox_terminal(&mut self, event_id: Uuid) {
        if let Some(rec) = self.inbox.get_mut(&event_id) {
            rec.state = "terminal".into();
        }
        self.recompute_contiguous_cursor();
    }

    pub fn inbox_already_applied(&self, event_id: &Uuid) -> bool {
        self.inbox.get(event_id).is_some_and(|r| {
            r.state == "applied" || r.state == "terminal"
        })
    }

    /// Accepted (or received) work that has not been applied — replayed after restart.
    pub fn unapplied_inbox(&self) -> Vec<InboxRecord> {
        let mut rows: Vec<_> = self
            .inbox
            .values()
            .filter(|r| r.state == "accepted" || r.state == "received")
            .cloned()
            .collect();
        rows.sort_by_key(|r| r.cursor);
        rows
    }

    fn recompute_contiguous_cursor(&mut self) {
        let mut blocking: Vec<i64> = self
            .inbox
            .values()
            .filter(|r| r.state != "applied" && r.state != "terminal")
            .map(|r| r.cursor)
            .collect();
        blocking.sort_unstable();
        let applied: Vec<i64> = self
            .inbox
            .values()
            .filter(|r| r.state == "applied" || r.state == "terminal")
            .map(|r| r.cursor)
            .collect();
        let next = if let Some(&min_block) = blocking.first() {
            applied.into_iter().filter(|&c| c < min_block).max().unwrap_or(0)
        } else {
            applied.into_iter().max().unwrap_or(self.contiguous_cursor)
        };
        if next > self.contiguous_cursor {
            self.contiguous_cursor = next;
        }
    }

    /// Persist an outbound mutation before the first socket write.
    pub fn enqueue_outbox(
        &mut self,
        request_id: Uuid,
        kind: impl Into<String>,
        wire_type: impl Into<String>,
        payload: &Value,
        payload_hash: impl Into<String>,
    ) {
        if self.outbox.contains_key(&request_id) {
            return;
        }
        self.outbox.insert(
            request_id,
            OutboxRecord {
                request_id,
                kind: kind.into(),
                wire_type: wire_type.into(),
                payload_json: payload.to_string(),
                payload_hash: payload_hash.into(),
                state: "pending".into(),
                created_at_ms: now_ms(),
                last_sent_at_ms: None,
            },
        );
    }

    pub fn mark_outbox_sent(&mut self, request_id: Uuid) {
        if let Some(rec) = self.outbox.get_mut(&request_id) {
            rec.state = "sent".into();
            rec.last_sent_at_ms = Some(now_ms());
        }
    }

    /// Hub committed (or replayed) the mutation — drop the outbox row.
    pub fn ack_outbox(&mut self, request_id: Uuid) -> Option<OutboxRecord> {
        self.outbox.remove(&request_id)
    }

    pub fn pending_outbox(&self) -> Vec<OutboxRecord> {
        let mut rows: Vec<_> = self
            .outbox
            .values()
            .filter(|r| r.state == "pending" || r.state == "sent")
            .cloned()
            .collect();
        rows.sort_by_key(|r| r.created_at_ms);
        rows
    }

    pub fn outbox_has(&self, request_id: &Uuid) -> bool {
        self.outbox.contains_key(request_id)
    }

    // ---- delivery helpers (unchanged contract) ---------------------------

    pub fn is_completed(&self, delivery_id: &Uuid) -> bool {
        self.completed_deliveries.contains_key(delivery_id)
    }

    pub fn mark_completed(&mut self, delivery_id: Uuid) {
        self.completed_deliveries.insert(delivery_id, now_ms());
        if let Some(rec) = self.deliveries.get_mut(&delivery_id) {
            rec.state = "completed".into();
        }
    }

    pub fn upsert_delivery(&mut self, rec: DeliveryRecord) {
        self.deliveries.insert(rec.delivery_id, rec);
    }

    pub fn delivery(&self, delivery_id: &Uuid) -> Option<&DeliveryRecord> {
        self.deliveries.get(delivery_id)
    }

    /// Legacy helper — prefer inbox APIs. Kept so older call sites compile during the cutover.
    pub fn mark_event_acked(&mut self, event_id: Uuid, cursor: i64) {
        self.receive_inbox(event_id, cursor, "legacy", &Value::Null);
        self.mark_inbox_accepted(event_id);
        self.mark_inbox_applied(event_id);
    }

    pub fn already_acked(&self, event_id: &Uuid) -> bool {
        self.inbox_already_applied(event_id)
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut s = NodeState::default();
        let did = Uuid::now_v7();
        s.upsert_delivery(DeliveryRecord {
            delivery_id: did,
            room_id: Uuid::now_v7(),
            seat_id: Uuid::now_v7(),
            state: "running".into(),
            attempt: 1,
            last_event_id: None,
        });
        s.save(&path).unwrap();
        let back = NodeState::load_or_default(&path).unwrap();
        assert_eq!(back.deliveries.get(&did).unwrap().attempt, 1);
    }

    #[test]
    fn contiguous_cursor_advances_only_after_apply() {
        let mut s = NodeState::default();
        let e1 = Uuid::now_v7();
        let e2 = Uuid::now_v7();
        s.receive_inbox(e1, 10, "delivery.assign", &json!({"a": 1}));
        s.mark_inbox_accepted(e1);
        assert_eq!(s.last_cursor(), None, "accepted is not applied");
        s.mark_inbox_applied(e1);
        assert_eq!(s.last_cursor(), Some(10));

        s.receive_inbox(e2, 11, "seat.detach", &json!({}));
        s.mark_inbox_accepted(e2);
        assert_eq!(s.last_cursor(), Some(10), "blocked by unapplied 11");
        s.mark_inbox_applied(e2);
        assert_eq!(s.last_cursor(), Some(11));
    }

    #[test]
    fn unapplied_gap_blocks_contiguous_cursor() {
        let mut s = NodeState::default();
        let early = Uuid::now_v7();
        let mid = Uuid::now_v7();
        let late = Uuid::now_v7();
        s.receive_inbox(early, 5, "a", &json!({}));
        s.mark_inbox_accepted(early);
        s.mark_inbox_applied(early);
        s.receive_inbox(mid, 7, "b", &json!({}));
        s.mark_inbox_accepted(mid);
        s.receive_inbox(late, 8, "c", &json!({}));
        s.mark_inbox_accepted(late);
        s.mark_inbox_applied(late);
        assert_eq!(s.last_cursor(), Some(5));
        assert_eq!(s.unapplied_inbox().len(), 1);
        assert_eq!(s.unapplied_inbox()[0].event_id, mid);
    }

    #[test]
    fn inbox_persists_real_event_id() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut s = NodeState::default();
        let eid = Uuid::parse_str("01900000-0000-7000-8000-000000000099").unwrap();
        s.receive_inbox(eid, 42, "delivery.assign", &json!({"x": true}));
        s.mark_inbox_accepted(eid);
        s.save(&path).unwrap();
        let back = NodeState::load_or_default(&path).unwrap();
        let rec = back.inbox.get(&eid).unwrap();
        assert_eq!(rec.event_id, eid);
        assert_eq!(rec.cursor, 42);
        assert_eq!(rec.state, "accepted");
        assert!(rec.payload_json.contains("\"x\":true") || rec.payload_json.contains("\"x\": true"));
    }

    #[test]
    fn outbox_survives_until_hub_ack() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut s = NodeState::default();
        let rid = Uuid::now_v7();
        let payload = json!({"message_post": {"body": "hi"}});
        s.enqueue_outbox(rid, "message_post", "node.message.post", &payload, "hash");
        s.mark_outbox_sent(rid);
        s.save(&path).unwrap();
        let mut back = NodeState::load_or_default(&path).unwrap();
        assert_eq!(back.pending_outbox().len(), 1);
        assert!(back.ack_outbox(rid).is_some());
        assert!(back.pending_outbox().is_empty());
    }

    #[test]
    fn completed_is_not_retried() {
        let mut s = NodeState::default();
        let did = Uuid::now_v7();
        s.mark_completed(did);
        assert!(s.is_completed(&did));
    }

    #[test]
    fn empty_state_file_loads_as_default() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, b"").unwrap();
        let back = NodeState::load_or_default(&path).unwrap();
        assert!(back.deliveries.is_empty());
    }

    #[test]
    fn legacy_cursors_migrate_into_contiguous() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.json");
        let eid = Uuid::now_v7();
        let legacy = json!({
            "cursors": {
                eid.to_string(): {
                    "event_id": eid,
                    "cursor": 99,
                    "persisted_at_ms": 1
                }
            },
            "deliveries": {},
            "completed_deliveries": {}
        });
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let back = NodeState::load_or_default(&path).unwrap();
        assert_eq!(back.contiguous_cursor, 99);
        assert_eq!(back.last_cursor(), Some(99));
    }
}
