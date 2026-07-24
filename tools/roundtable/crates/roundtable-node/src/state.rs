//! Durable node state - cursor + delivery records persisted before acknowledgement.
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct NodeState {
    pub cursors: HashMap<Uuid, CursorRecord>,
    pub deliveries: HashMap<Uuid, DeliveryRecord>,
    pub completed_deliveries: HashMap<Uuid, i64>,
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
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub fn save(&self, path: &Path) -> NodeResult<()> {
        let bytes = serde_json::to_vec(self)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn mark_event_acked(&mut self, event_id: Uuid, cursor: i64) {
        self.cursors.insert(event_id, CursorRecord {
            event_id,
            cursor,
            persisted_at_ms: now_ms(),
        });
    }

    pub fn last_cursor(&self) -> Option<i64> {
        self.cursors.values().map(|r| r.cursor).max()
    }

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

    pub fn already_acked(&self, event_id: &Uuid) -> bool {
        self.cursors.contains_key(event_id)
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn cursor_persists_before_ack() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.json");
        let mut s = NodeState::default();
        let eid = Uuid::now_v7();
        s.mark_event_acked(eid, 42);
        s.save(&path).unwrap();
        let back = NodeState::load_or_default(&path).unwrap();
        assert!(back.already_acked(&eid));
        assert_eq!(back.last_cursor(), Some(42));
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
}
