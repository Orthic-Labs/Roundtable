use citadel_protocol::{
    canonical_sha256, human_selected_targets, new_id, ActorKind, Approval, Delivery,
    DeliveryReason, DeliveryState, EventRecord, Message, MessageKind, Node, Room, Seat,
    SeatProvider, HANDOFF_DEPTH_LIMIT,
};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

const MIGRATION_V1: &str = include_str!("../migrations/0001_initial.sql");
const MIGRATION_V2: &str = include_str!("../migrations/0002_task_runs.sql");
const LEASE_MS: i64 = 10 * 60 * 1_000;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("serialization: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("store actor stopped")]
    ActorStopped,
    #[error("not_found")]
    NotFound,
    #[error("request_id_reused")]
    RequestIdReused,
    #[error("seat_not_owned")]
    SeatNotOwned,
    #[error("task_key_claimed")]
    TaskKeyClaimed,
    #[error("invalid_state")]
    InvalidState,
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostMessageCommand {
    pub actor_id: Uuid,
    pub request_id: Uuid,
    pub room_id: Uuid,
    pub actor_kind: ActorKind,
    pub kind: MessageKind,
    pub body: String,
    pub reply_to: Option<Uuid>,
    pub selected_seat_ids: Vec<Uuid>,
    pub reason: DeliveryReason,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PostMessageResult {
    pub message: Message,
    pub deliveries: Vec<Delivery>,
    pub evidence_missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffCommand {
    pub actor_id: Uuid,
    pub request_id: Uuid,
    pub room_id: Uuid,
    pub from_seat_id: Uuid,
    pub to_seat_id: Uuid,
    pub body: String,
    pub evidence_refs: Vec<citadel_protocol::EvidenceRef>,
    pub task_key: Option<String>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HandoffResult {
    pub message: Message,
    pub delivery: Option<Delivery>,
    pub depth: i64,
    pub error_code: Option<String>,
    pub evidence_missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSeat {
    pub id: Uuid,
    pub room_id: Uuid,
    pub node_id: Uuid,
    pub alias: String,
    pub provider: SeatProvider,
    pub session_ref: String,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewNode {
    pub id: Uuid,
    pub name: String,
    pub token_hash: String,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryUpdate {
    pub delivery_id: Uuid,
    pub node_id: Uuid,
    pub state: DeliveryState,
    pub error_code: Option<String>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewApproval {
    pub request_id: Uuid,
    pub node_id: Uuid,
    pub seat_id: Uuid,
    pub delivery_id: Uuid,
    pub provider_request_id: String,
    pub description: String,
    pub input_preview: String,
    pub decisions: Vec<String>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveApproval {
    pub actor_id: Uuid,
    pub request_id: Uuid,
    pub approval_id: Uuid,
    pub decision: String,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRoomMutation {
    pub actor_id: Uuid,
    pub request_id: Uuid,
    pub id: Uuid,
    pub slug: String,
    pub title: String,
    pub objective: String,
    pub now_ms: i64,
}

#[derive(Clone)]
pub struct Store {
    tx: mpsc::Sender<Command>,
}

enum Command {
    CreateRoomDedup {
        mutation: CreateRoomMutation,
        reply: oneshot::Sender<Result<Room>>,
    },
    CreateRoom {
        id: Uuid,
        slug: String,
        title: String,
        objective: String,
        now_ms: i64,
        reply: oneshot::Sender<Result<Room>>,
    },
    GetRoom {
        id: Uuid,
        reply: oneshot::Sender<Result<Room>>,
    },
    ListRooms {
        reply: oneshot::Sender<Result<Vec<Room>>>,
    },
    UpdateRoom {
        id: Uuid,
        title: Option<String>,
        objective: Option<String>,
        archived: Option<bool>,
        now_ms: i64,
        reply: oneshot::Sender<Result<Room>>,
    },
    PostMessage {
        command: PostMessageCommand,
        reply: oneshot::Sender<Result<PostMessageResult>>,
    },
    ListMessages {
        room_id: Uuid,
        after_seq: Option<i64>,
        before_seq: Option<i64>,
        limit: u16,
        reply: oneshot::Sender<Result<Vec<Message>>>,
    },
    AddNode {
        node: NewNode,
        reply: oneshot::Sender<Result<Node>>,
    },
    ListNodes {
        reply: oneshot::Sender<Result<Vec<Node>>>,
    },
    AuthenticateNode {
        id: Uuid,
        token_hash: String,
        now_ms: i64,
        reply: oneshot::Sender<Result<bool>>,
    },
    RevokeNode {
        id: Uuid,
        now_ms: i64,
        reply: oneshot::Sender<Result<()>>,
    },
    AddSeat {
        seat: NewSeat,
        reply: oneshot::Sender<Result<Seat>>,
    },
    GetSeat {
        id: Uuid,
        reply: oneshot::Sender<Result<Seat>>,
    },
    ListSeats {
        room_id: Uuid,
        reply: oneshot::Sender<Result<Vec<Seat>>>,
    },
    DeleteSeat {
        room_id: Uuid,
        seat_id: Uuid,
        reply: oneshot::Sender<Result<()>>,
    },
    BrowserSessionPut {
        hash: String,
        expires_at_ms: i64,
        now_ms: i64,
        reply: oneshot::Sender<Result<()>>,
    },
    BrowserSessionValid {
        hash: String,
        now_ms: i64,
        reply: oneshot::Sender<Result<bool>>,
    },
    Handoff {
        command: HandoffCommand,
        reply: oneshot::Sender<Result<HandoffResult>>,
    },
    DeliveryState {
        update: DeliveryUpdate,
        reply: oneshot::Sender<Result<Delivery>>,
    },
    ReplayEvents {
        node_id: Uuid,
        after_cursor: i64,
        reply: oneshot::Sender<Result<Vec<EventRecord>>>,
    },
    RetryExpired {
        now_ms: i64,
        reply: oneshot::Sender<Result<Vec<Delivery>>>,
    },
    MarkNodeOffline {
        node_id: Uuid,
        now_ms: i64,
        reply: oneshot::Sender<Result<usize>>,
    },
    CreateApproval {
        approval: NewApproval,
        reply: oneshot::Sender<Result<Approval>>,
    },
    ResolveApproval {
        resolution: ResolveApproval,
        reply: oneshot::Sender<Result<Approval>>,
    },
    InspectSchema {
        reply: oneshot::Sender<Result<Vec<String>>>,
    },
}

impl Store {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let (tx, rx) = mpsc::channel(256);
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        thread::Builder::new()
            .name("roundtable-sqlite".into())
            .spawn(move || actor(path, rx, ready_tx))
            .map_err(|_| StoreError::ActorStopped)?;
        ready_rx.recv().map_err(|_| StoreError::ActorStopped)??;
        Ok(Self { tx })
    }

    pub async fn memory() -> Result<Self> {
        Self::open(":memory:").await
    }

    pub async fn create_room_dedup(&self, mutation: CreateRoomMutation) -> Result<Room> {
        self.call(|reply| Command::CreateRoomDedup { mutation, reply })
            .await
    }

    pub async fn create_room(
        &self,
        id: Uuid,
        slug: String,
        title: String,
        objective: String,
        now_ms: i64,
    ) -> Result<Room> {
        self.call(|reply| Command::CreateRoom {
            id,
            slug,
            title,
            objective,
            now_ms,
            reply,
        })
        .await
    }

    pub async fn get_room(&self, id: Uuid) -> Result<Room> {
        self.call(|reply| Command::GetRoom { id, reply }).await
    }

    pub async fn list_rooms(&self) -> Result<Vec<Room>> {
        self.call(|reply| Command::ListRooms { reply }).await
    }

    pub async fn update_room(
        &self,
        id: Uuid,
        title: Option<String>,
        objective: Option<String>,
        archived: Option<bool>,
        now_ms: i64,
    ) -> Result<Room> {
        self.call(|reply| Command::UpdateRoom {
            id,
            title,
            objective,
            archived,
            now_ms,
            reply,
        })
        .await
    }

    pub async fn post_message(&self, command: PostMessageCommand) -> Result<PostMessageResult> {
        self.call(|reply| Command::PostMessage { command, reply })
            .await
    }

    pub async fn list_messages(
        &self,
        room_id: Uuid,
        after_seq: Option<i64>,
        before_seq: Option<i64>,
        limit: u16,
    ) -> Result<Vec<Message>> {
        self.call(|reply| Command::ListMessages {
            room_id,
            after_seq,
            before_seq,
            limit,
            reply,
        })
        .await
    }

    pub async fn add_node(&self, node: NewNode) -> Result<Node> {
        self.call(|reply| Command::AddNode { node, reply }).await
    }

    pub async fn list_nodes(&self) -> Result<Vec<Node>> {
        self.call(|reply| Command::ListNodes { reply }).await
    }

    pub async fn authenticate_node(
        &self,
        id: Uuid,
        token_hash: String,
        now_ms: i64,
    ) -> Result<bool> {
        self.call(|reply| Command::AuthenticateNode {
            id,
            token_hash,
            now_ms,
            reply,
        })
        .await
    }

    pub async fn revoke_node(&self, id: Uuid, now_ms: i64) -> Result<()> {
        self.call(|reply| Command::RevokeNode { id, now_ms, reply })
            .await
    }

    pub async fn add_seat(&self, seat: NewSeat) -> Result<Seat> {
        self.call(|reply| Command::AddSeat { seat, reply }).await
    }

    pub async fn get_seat(&self, id: Uuid) -> Result<Seat> {
        self.call(|reply| Command::GetSeat { id, reply }).await
    }

    pub async fn list_seats(&self, room_id: Uuid) -> Result<Vec<Seat>> {
        self.call(|reply| Command::ListSeats { room_id, reply })
            .await
    }

    pub async fn delete_seat(&self, room_id: Uuid, seat_id: Uuid) -> Result<()> {
        self.call(|reply| Command::DeleteSeat {
            room_id,
            seat_id,
            reply,
        })
        .await
    }

    pub async fn put_browser_session(
        &self,
        hash: String,
        expires_at_ms: i64,
        now_ms: i64,
    ) -> Result<()> {
        self.call(|reply| Command::BrowserSessionPut {
            hash,
            expires_at_ms,
            now_ms,
            reply,
        })
        .await
    }

    pub async fn browser_session_valid(&self, hash: String, now_ms: i64) -> Result<bool> {
        self.call(|reply| Command::BrowserSessionValid {
            hash,
            now_ms,
            reply,
        })
        .await
    }

    pub async fn create_handoff(&self, command: HandoffCommand) -> Result<HandoffResult> {
        self.call(|reply| Command::Handoff { command, reply }).await
    }

    pub async fn update_delivery(&self, update: DeliveryUpdate) -> Result<Delivery> {
        self.call(|reply| Command::DeliveryState { update, reply })
            .await
    }

    pub async fn replay_events(
        &self,
        node_id: Uuid,
        after_cursor: i64,
    ) -> Result<Vec<EventRecord>> {
        self.call(|reply| Command::ReplayEvents {
            node_id,
            after_cursor,
            reply,
        })
        .await
    }

    pub async fn retry_expired(&self, now_ms: i64) -> Result<Vec<Delivery>> {
        self.call(|reply| Command::RetryExpired { now_ms, reply })
            .await
    }

    pub async fn mark_node_offline(&self, node_id: Uuid, now_ms: i64) -> Result<usize> {
        self.call(|reply| Command::MarkNodeOffline {
            node_id,
            now_ms,
            reply,
        })
        .await
    }

    pub async fn create_approval(&self, approval: NewApproval) -> Result<Approval> {
        self.call(|reply| Command::CreateApproval { approval, reply })
            .await
    }

    pub async fn resolve_approval(&self, resolution: ResolveApproval) -> Result<Approval> {
        self.call(|reply| Command::ResolveApproval { resolution, reply })
            .await
    }

    pub async fn inspect_schema(&self) -> Result<Vec<String>> {
        self.call(|reply| Command::InspectSchema { reply }).await
    }

    async fn call<T>(&self, make: impl FnOnce(oneshot::Sender<Result<T>>) -> Command) -> Result<T> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(make(reply_tx))
            .await
            .map_err(|_| StoreError::ActorStopped)?;
        reply_rx.await.map_err(|_| StoreError::ActorStopped)?
    }
}

fn actor(
    path: PathBuf,
    mut rx: mpsc::Receiver<Command>,
    ready: std::sync::mpsc::SyncSender<Result<()>>,
) {
    let opened = open_connection(&path);
    let mut connection = match opened {
        Ok(connection) => {
            let _ = ready.send(Ok(()));
            connection
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };

    while let Some(command) = rx.blocking_recv() {
        match command {
            Command::CreateRoomDedup { mutation, reply } => {
                let _ = reply.send(create_room_dedup(&mut connection, mutation));
            }
            Command::CreateRoom {
                id,
                slug,
                title,
                objective,
                now_ms,
                reply,
            } => {
                let _ = reply.send(create_room(
                    &connection,
                    id,
                    &slug,
                    &title,
                    &objective,
                    now_ms,
                ));
            }
            Command::GetRoom { id, reply } => {
                let _ = reply.send(get_room(&connection, id));
            }
            Command::ListRooms { reply } => {
                let _ = reply.send(list_rooms(&connection));
            }
            Command::UpdateRoom {
                id,
                title,
                objective,
                archived,
                now_ms,
                reply,
            } => {
                let _ = reply.send(update_room(
                    &connection,
                    id,
                    title,
                    objective,
                    archived,
                    now_ms,
                ));
            }
            Command::PostMessage { command, reply } => {
                let _ = reply.send(post_message(&mut connection, command));
            }
            Command::ListMessages {
                room_id,
                after_seq,
                before_seq,
                limit,
                reply,
            } => {
                let _ = reply.send(list_messages(
                    &connection,
                    room_id,
                    after_seq,
                    before_seq,
                    limit,
                ));
            }
            Command::AddNode { node, reply } => {
                let _ = reply.send(add_node(&connection, node));
            }
            Command::ListNodes { reply } => {
                let _ = reply.send(list_nodes(&connection));
            }
            Command::AuthenticateNode {
                id,
                token_hash,
                now_ms,
                reply,
            } => {
                let _ = reply.send(authenticate_node(&connection, id, &token_hash, now_ms));
            }
            Command::RevokeNode { id, now_ms, reply } => {
                let _ = reply.send(revoke_node(&connection, id, now_ms));
            }
            Command::AddSeat { seat, reply } => {
                let _ = reply.send(add_seat(&connection, seat));
            }
            Command::GetSeat { id, reply } => {
                let _ = reply.send(get_seat(&connection, id));
            }
            Command::ListSeats { room_id, reply } => {
                let _ = reply.send(list_seats(&connection, room_id));
            }
            Command::DeleteSeat {
                room_id,
                seat_id,
                reply,
            } => {
                let _ = reply.send(delete_seat(&connection, room_id, seat_id));
            }
            Command::BrowserSessionPut {
                hash,
                expires_at_ms,
                now_ms,
                reply,
            } => {
                let _ = reply.send(put_browser_session(
                    &connection,
                    &hash,
                    expires_at_ms,
                    now_ms,
                ));
            }
            Command::BrowserSessionValid {
                hash,
                now_ms,
                reply,
            } => {
                let _ = reply.send(browser_session_valid(&connection, &hash, now_ms));
            }
            Command::Handoff { command, reply } => {
                let _ = reply.send(create_handoff(&mut connection, command));
            }
            Command::DeliveryState { update, reply } => {
                let _ = reply.send(update_delivery(&mut connection, update));
            }
            Command::ReplayEvents {
                node_id,
                after_cursor,
                reply,
            } => {
                let _ = reply.send(replay_events(&connection, node_id, after_cursor));
            }
            Command::RetryExpired { now_ms, reply } => {
                let _ = reply.send(retry_expired(&mut connection, now_ms));
            }
            Command::MarkNodeOffline {
                node_id,
                now_ms,
                reply,
            } => {
                let _ = reply.send(mark_node_offline(&mut connection, node_id, now_ms));
            }
            Command::CreateApproval { approval, reply } => {
                let _ = reply.send(create_approval(&mut connection, approval));
            }
            Command::ResolveApproval { resolution, reply } => {
                let _ = reply.send(resolve_approval(&mut connection, resolution));
            }
            Command::InspectSchema { reply } => {
                let _ = reply.send(inspect_schema(&connection));
            }
        }
    }
}

fn open_connection(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "busy_timeout", 5_000)?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version == 0 {
        connection.execute_batch(MIGRATION_V1)?;
        connection.pragma_update(None, "user_version", 1)?;
    }
    if version < 2 {
        connection.execute_batch(MIGRATION_V2)?;
        connection.pragma_update(None, "user_version", 2)?;
    }
    Ok(connection)
}

fn create_room_dedup(connection: &mut Connection, mutation: CreateRoomMutation) -> Result<Room> {
    let payload_hash = canonical_sha256(&json!({
        "actor_id": mutation.actor_id,
        "request_id": mutation.request_id,
        "slug": mutation.slug,
        "title": mutation.title,
        "objective": mutation.objective,
    }))?;
    let tx = connection.transaction()?;
    if let Some(room) =
        dedupe_lookup::<Room>(&tx, mutation.actor_id, mutation.request_id, &payload_hash)?
    {
        return Ok(room);
    }
    tx.execute(
        "INSERT INTO rooms(id, slug, title, objective, next_seq, created_at_ms) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
        params![mutation.id.to_string(), mutation.slug, mutation.title, mutation.objective, mutation.now_ms],
    )?;
    let room = tx.query_row(
        "SELECT id, slug, title, objective, next_seq, archived_at_ms FROM rooms WHERE id = ?1",
        [mutation.id.to_string()],
        room_row,
    )?;
    dedupe_save(
        &tx,
        mutation.actor_id,
        mutation.request_id,
        &payload_hash,
        &room,
        mutation.now_ms,
    )?;
    tx.commit()?;
    Ok(room)
}

fn create_room(
    connection: &Connection,
    id: Uuid,
    slug: &str,
    title: &str,
    objective: &str,
    now_ms: i64,
) -> Result<Room> {
    connection.execute(
        "INSERT INTO rooms(id, slug, title, objective, next_seq, created_at_ms) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
        params![id.to_string(), slug, title, objective, now_ms],
    )?;
    get_room(connection, id)
}

fn get_room(connection: &Connection, id: Uuid) -> Result<Room> {
    connection
        .query_row(
            "SELECT id, slug, title, objective, next_seq, archived_at_ms FROM rooms WHERE id = ?1",
            [id.to_string()],
            room_row,
        )
        .optional()?
        .ok_or(StoreError::NotFound)
}

fn list_rooms(connection: &Connection) -> Result<Vec<Room>> {
    let mut statement = connection.prepare(
        "SELECT id, slug, title, objective, next_seq, archived_at_ms FROM rooms ORDER BY created_at_ms",
    )?;
    let rows = statement.query_map([], room_row)?;
    collect_rows(rows)
}

fn update_room(
    connection: &Connection,
    id: Uuid,
    title: Option<String>,
    objective: Option<String>,
    archived: Option<bool>,
    now_ms: i64,
) -> Result<Room> {
    let current = get_room(connection, id)?;
    let title = title.unwrap_or(current.title);
    let objective = objective.unwrap_or(current.objective);
    let archived_at = archived.map(|value| if value { Some(now_ms) } else { None });
    connection.execute(
        "UPDATE rooms SET title = ?2, objective = ?3, archived_at_ms = COALESCE(?4, archived_at_ms) WHERE id = ?1",
        params![id.to_string(), title, objective, archived_at.flatten()],
    )?;
    if archived == Some(false) {
        connection.execute(
            "UPDATE rooms SET archived_at_ms = NULL WHERE id = ?1",
            [id.to_string()],
        )?;
    }
    get_room(connection, id)
}

fn post_message(
    connection: &mut Connection,
    command: PostMessageCommand,
) -> Result<PostMessageResult> {
    let payload_hash = canonical_sha256(&json!({
        "actor_id": command.actor_id,
        "request_id": command.request_id,
        "room_id": command.room_id,
        "actor_kind": command.actor_kind,
        "kind": command.kind,
        "body": command.body,
        "reply_to": command.reply_to,
        "selected_seat_ids": command.selected_seat_ids,
        "reason": command.reason,
    }))?;
    let tx = connection.transaction()?;
    if let Some(result) = dedupe_lookup::<PostMessageResult>(
        &tx,
        command.actor_id,
        command.request_id,
        &payload_hash,
    )? {
        return Ok(result);
    }

    let targets = human_selected_targets(command.actor_kind, &command.selected_seat_ids);
    let message = insert_message(
        &tx,
        MessageInsert {
            room_id: command.room_id,
            actor_id: command.actor_id,
            actor_kind: command.actor_kind,
            kind: command.kind,
            body: &command.body,
            reply_to: command.reply_to,
            mentioned_seat_ids: &targets,
            now_ms: command.now_ms,
        },
    )?;
    let mut deliveries = Vec::new();
    for seat_id in &targets {
        let seat = get_seat_tx(&tx, *seat_id)?;
        if seat.room_id != command.room_id {
            return Err(StoreError::NotFound);
        }
        let delivery = insert_delivery(&tx, &message, &seat, command.reason, command.now_ms)?;
        insert_assignment_event(&tx, &delivery, &message, &seat, command.now_ms)?;
        deliveries.push(delivery);
    }

    if command.actor_kind == ActorKind::Human {
        let unbound = unbound_aliases_tx(&tx, command.room_id, &command.body, &targets)?;
        if !unbound.is_empty() {
            insert_system_message(
                &tx,
                command.room_id,
                &format!(
                    "mentions_unbound: {} was mentioned in prose but no wake was created; use a structured handoff",
                    unbound.join(", ")
                ),
                command.now_ms,
            )?;
        }
    }

    let evidence_missing =
        command.actor_kind == ActorKind::Agent && command.kind == MessageKind::Completion;
    if evidence_missing {
        insert_system_message(&tx, command.room_id, "evidence_missing", command.now_ms)?;
    }

    let result = PostMessageResult {
        message,
        deliveries,
        evidence_missing,
    };
    dedupe_save(
        &tx,
        command.actor_id,
        command.request_id,
        &payload_hash,
        &result,
        command.now_ms,
    )?;
    tx.commit()?;
    Ok(result)
}

fn list_messages(
    connection: &Connection,
    room_id: Uuid,
    after_seq: Option<i64>,
    before_seq: Option<i64>,
    limit: u16,
) -> Result<Vec<Message>> {
    let after = after_seq.unwrap_or(-1);
    let before = before_seq.unwrap_or(i64::MAX);
    let mut statement = connection.prepare(
        "SELECT id, room_id, seq, actor_id, actor_kind, kind, body, reply_to, created_at_ms
         FROM messages WHERE room_id = ?1 AND seq > ?2 AND seq < ?3 ORDER BY seq ASC LIMIT ?4",
    )?;
    let rows = statement.query_map(
        params![room_id.to_string(), after, before, i64::from(limit)],
        |row| message_row(connection, row),
    )?;
    collect_rows(rows)
}

fn add_node(connection: &Connection, node: NewNode) -> Result<Node> {
    connection.execute(
        "INSERT INTO nodes(id, name, token_hash, created_at_ms, last_seen_ms) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![node.id.to_string(), node.name, node.token_hash, node.now_ms],
    )?;
    get_node(connection, node.id)
}

fn get_node(connection: &Connection, id: Uuid) -> Result<Node> {
    connection
        .query_row(
            "SELECT id, name, created_at_ms, revoked_at_ms, last_seen_ms FROM nodes WHERE id = ?1",
            [id.to_string()],
            node_row,
        )
        .optional()?
        .ok_or(StoreError::NotFound)
}

fn list_nodes(connection: &Connection) -> Result<Vec<Node>> {
    let mut statement = connection.prepare(
        "SELECT id, name, created_at_ms, revoked_at_ms, last_seen_ms FROM nodes ORDER BY created_at_ms",
    )?;
    let rows = statement.query_map([], node_row)?;
    collect_rows(rows)
}

fn authenticate_node(
    connection: &Connection,
    id: Uuid,
    token_hash: &str,
    now_ms: i64,
) -> Result<bool> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT token_hash FROM nodes WHERE id = ?1 AND revoked_at_ms IS NULL",
            [id.to_string()],
            |row| row.get(0),
        )
        .optional()?;
    let valid = stored.as_deref() == Some(token_hash);
    if valid {
        connection.execute(
            "UPDATE nodes SET last_seen_ms = ?2 WHERE id = ?1",
            params![id.to_string(), now_ms],
        )?;
    }
    Ok(valid)
}

fn revoke_node(connection: &Connection, id: Uuid, now_ms: i64) -> Result<()> {
    let changed = connection.execute(
        "UPDATE nodes SET revoked_at_ms = ?2 WHERE id = ?1",
        params![id.to_string(), now_ms],
    )?;
    if changed == 0 {
        Err(StoreError::NotFound)
    } else {
        Ok(())
    }
}

fn add_seat(connection: &Connection, seat: NewSeat) -> Result<Seat> {
    connection.execute(
        "INSERT INTO seats(id, room_id, node_id, alias, provider, session_ref, state, last_seen_ms, last_ack_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'offline', ?7, 0)",
        params![
            seat.id.to_string(),
            seat.room_id.to_string(),
            seat.node_id.to_string(),
            seat.alias,
            enum_text(seat.provider),
            seat.session_ref,
            seat.now_ms,
        ],
    )?;
    get_seat(connection, seat.id)
}

fn get_seat(connection: &Connection, id: Uuid) -> Result<Seat> {
    connection
        .query_row(
            "SELECT id, room_id, node_id, alias, provider, session_ref, state, last_seen_ms, last_ack_seq FROM seats WHERE id = ?1",
            [id.to_string()],
            seat_row,
        )
        .optional()?
        .ok_or(StoreError::NotFound)
}

fn get_seat_tx(tx: &Transaction<'_>, id: Uuid) -> Result<Seat> {
    tx.query_row(
        "SELECT id, room_id, node_id, alias, provider, session_ref, state, last_seen_ms, last_ack_seq FROM seats WHERE id = ?1",
        [id.to_string()],
        seat_row,
    )
    .optional()?
    .ok_or(StoreError::NotFound)
}

fn list_seats(connection: &Connection, room_id: Uuid) -> Result<Vec<Seat>> {
    let mut statement = connection.prepare(
        "SELECT id, room_id, node_id, alias, provider, session_ref, state, last_seen_ms, last_ack_seq
         FROM seats WHERE room_id = ?1 ORDER BY alias",
    )?;
    let rows = statement.query_map([room_id.to_string()], seat_row)?;
    collect_rows(rows)
}

fn delete_seat(connection: &Connection, room_id: Uuid, seat_id: Uuid) -> Result<()> {
    let changed = connection.execute(
        "DELETE FROM seats WHERE room_id = ?1 AND id = ?2",
        params![room_id.to_string(), seat_id.to_string()],
    )?;
    if changed == 0 {
        Err(StoreError::NotFound)
    } else {
        Ok(())
    }
}

fn put_browser_session(
    connection: &Connection,
    hash: &str,
    expires_at_ms: i64,
    now_ms: i64,
) -> Result<()> {
    connection.execute(
        "INSERT INTO browser_sessions(id_hash, expires_at_ms, created_at_ms, last_seen_ms) VALUES (?1, ?2, ?3, ?3)",
        params![hash, expires_at_ms, now_ms],
    )?;
    Ok(())
}

fn browser_session_valid(connection: &Connection, hash: &str, now_ms: i64) -> Result<bool> {
    let valid = connection
        .query_row(
            "SELECT 1 FROM browser_sessions WHERE id_hash = ?1 AND expires_at_ms > ?2",
            params![hash, now_ms],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if valid {
        connection.execute(
            "UPDATE browser_sessions SET last_seen_ms = ?2 WHERE id_hash = ?1",
            params![hash, now_ms],
        )?;
    }
    Ok(valid)
}

fn create_handoff(connection: &mut Connection, command: HandoffCommand) -> Result<HandoffResult> {
    let payload_hash = canonical_sha256(&json!({
        "actor_id": command.actor_id,
        "request_id": command.request_id,
        "room_id": command.room_id,
        "from_seat_id": command.from_seat_id,
        "to_seat_id": command.to_seat_id,
        "body": command.body,
        "evidence_refs": command.evidence_refs,
        "task_key": command.task_key,
    }))?;
    let tx = connection.transaction()?;
    if let Some(result) =
        dedupe_lookup::<HandoffResult>(&tx, command.actor_id, command.request_id, &payload_hash)?
    {
        return Ok(result);
    }
    let from = get_seat_tx(&tx, command.from_seat_id)?;
    let to = get_seat_tx(&tx, command.to_seat_id)?;
    if from.room_id != command.room_id || to.room_id != command.room_id {
        return Err(StoreError::NotFound);
    }
    if let Some(task_key) = command.task_key.as_deref() {
        ensure_task_key_free(&tx, command.room_id, task_key)?;
    }
    let depth = next_handoff_depth(&tx, command.room_id, command.from_seat_id)?;
    if depth > HANDOFF_DEPTH_LIMIT {
        let message = insert_system_message(
            &tx,
            command.room_id,
            "handoff_depth_exceeded",
            command.now_ms,
        )?;
        let result = HandoffResult {
            message,
            delivery: None,
            depth,
            error_code: Some("handoff_depth_exceeded".into()),
            evidence_missing: command.evidence_refs.is_empty(),
        };
        dedupe_save(
            &tx,
            command.actor_id,
            command.request_id,
            &payload_hash,
            &result,
            command.now_ms,
        )?;
        tx.commit()?;
        return Ok(result);
    }

    let target = [command.to_seat_id];
    let message = insert_message(
        &tx,
        MessageInsert {
            room_id: command.room_id,
            actor_id: command.from_seat_id,
            actor_kind: ActorKind::Agent,
            kind: MessageKind::Handoff,
            body: &command.body,
            reply_to: None,
            mentioned_seat_ids: &target,
            now_ms: command.now_ms,
        },
    )?;
    let metadata = json!({
        "evidence_refs": command.evidence_refs,
        "task_key": command.task_key,
        "depth": depth,
    });
    tx.execute(
        "INSERT INTO handoffs(id, room_id, message_id, from_seat_id, to_seat_id, evidence_json, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            new_id().to_string(),
            command.room_id.to_string(),
            message.id.to_string(),
            command.from_seat_id.to_string(),
            command.to_seat_id.to_string(),
            serde_json::to_string(&metadata)?,
            command.now_ms,
        ],
    )?;
    let delivery = insert_delivery(
        &tx,
        &message,
        &to,
        DeliveryReason::StructuredHandoff,
        command.now_ms,
    )?;
    insert_assignment_event(&tx, &delivery, &message, &to, command.now_ms)?;
    tx.execute(
        "UPDATE deliveries SET state = 'completed', lease_until_ms = NULL, updated_at_ms = ?2
         WHERE seat_id = ?1 AND state IN ('acked', 'running', 'waiting_approval')",
        params![command.from_seat_id.to_string(), command.now_ms],
    )?;
    let result = HandoffResult {
        message,
        delivery: Some(delivery),
        depth,
        error_code: None,
        evidence_missing: command.evidence_refs.is_empty(),
    };
    if result.evidence_missing {
        insert_system_message(&tx, command.room_id, "evidence_missing", command.now_ms)?;
    }
    dedupe_save(
        &tx,
        command.actor_id,
        command.request_id,
        &payload_hash,
        &result,
        command.now_ms,
    )?;
    tx.commit()?;
    Ok(result)
}

fn ensure_task_key_free(tx: &Transaction<'_>, room_id: Uuid, task_key: &str) -> Result<()> {
    let mut statement = tx.prepare("SELECT evidence_json FROM handoffs WHERE room_id = ?1")?;
    let rows = statement.query_map([room_id.to_string()], |row| row.get::<_, String>(0))?;
    for row in rows {
        let value: Value = serde_json::from_str(&row?)?;
        if value.get("task_key").and_then(Value::as_str) == Some(task_key) {
            return Err(StoreError::TaskKeyClaimed);
        }
    }
    Ok(())
}

fn next_handoff_depth(tx: &Transaction<'_>, room_id: Uuid, from_seat_id: Uuid) -> Result<i64> {
    let mut statement = tx.prepare(
        "SELECT evidence_json FROM handoffs WHERE room_id = ?1 AND to_seat_id = ?2 ORDER BY created_at_ms DESC",
    )?;
    let rows = statement.query_map(
        params![room_id.to_string(), from_seat_id.to_string()],
        |row| row.get::<_, String>(0),
    )?;
    let mut maximum = 0;
    for row in rows {
        let value: Value = serde_json::from_str(&row?)?;
        maximum = maximum.max(value.get("depth").and_then(Value::as_i64).unwrap_or(0));
    }
    Ok(maximum + 1)
}

fn update_delivery(connection: &mut Connection, update: DeliveryUpdate) -> Result<Delivery> {
    let tx = connection.transaction()?;
    let owner: Option<String> = tx
        .query_row(
            "SELECT seats.node_id FROM deliveries JOIN seats ON seats.id = deliveries.seat_id WHERE deliveries.id = ?1",
            [update.delivery_id.to_string()],
            |row| row.get(0),
        )
        .optional()?;
    if owner.as_deref() != Some(update.node_id.to_string().as_str()) {
        return Err(StoreError::SeatNotOwned);
    }
    let lease_until = match update.state {
        DeliveryState::Acked | DeliveryState::Running | DeliveryState::WaitingApproval => {
            Some(update.now_ms + LEASE_MS)
        }
        _ => None,
    };
    tx.execute(
        "UPDATE deliveries SET state = ?2, lease_until_ms = ?3, error_code = ?4, updated_at_ms = ?5 WHERE id = ?1",
        params![
            update.delivery_id.to_string(),
            enum_text(update.state),
            lease_until,
            update.error_code,
            update.now_ms,
        ],
    )?;
    let delivery = get_delivery_tx(&tx, update.delivery_id)?;
    if delivery.state == DeliveryState::Completed {
        tx.execute(
            "UPDATE seats SET state = 'idle', last_ack_seq = MAX(last_ack_seq, (SELECT seq FROM messages WHERE id = ?2)), last_seen_ms = ?3 WHERE id = ?1",
            params![delivery.seat_id.to_string(), delivery.message_id.to_string(), update.now_ms],
        )?;
    }
    tx.commit()?;
    Ok(delivery)
}

fn replay_events(
    connection: &Connection,
    node_id: Uuid,
    after_cursor: i64,
) -> Result<Vec<EventRecord>> {
    let mut statement = connection.prepare(
        "SELECT cursor, event_id, target_node_id, type, payload_json, created_at_ms
         FROM events WHERE cursor > ?1 AND (target_node_id IS NULL OR target_node_id = ?2) ORDER BY cursor",
    )?;
    let rows = statement.query_map(params![after_cursor, node_id.to_string()], |row| {
        Ok(EventRecord {
            cursor: row.get(0)?,
            event_id: parse_uuid(row.get::<_, String>(1)?)?,
            target_node_id: row
                .get::<_, Option<String>>(2)?
                .map(parse_uuid)
                .transpose()?,
            event_type: row.get(3)?,
            payload: serde_json::from_str(&row.get::<_, String>(4)?).map_err(to_sql_error)?,
            created_at_ms: row.get(5)?,
        })
    })?;
    collect_rows(rows)
}

fn retry_expired(connection: &mut Connection, now_ms: i64) -> Result<Vec<Delivery>> {
    let tx = connection.transaction()?;
    let ids = {
        let mut statement = tx.prepare(
            "SELECT id FROM deliveries WHERE state IN ('acked', 'running', 'waiting_approval') AND lease_until_ms <= ?1 ORDER BY updated_at_ms",
        )?;
        let rows = statement.query_map([now_ms], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut changed = Vec::new();
    for id in ids {
        let id = Uuid::parse_str(&id).map_err(to_sql_error)?;
        let current = get_delivery_tx(&tx, id)?;
        if current.attempt >= 2 {
            tx.execute(
                "UPDATE deliveries SET state = 'dead_letter', attempt = 3, lease_until_ms = NULL, error_code = 'lease_expired', updated_at_ms = ?2 WHERE id = ?1",
                params![id.to_string(), now_ms],
            )?;
            insert_system_message(&tx, current.room_id, "dead_letter", now_ms)?;
        } else {
            tx.execute(
                "UPDATE deliveries SET state = 'queued', attempt = attempt + 1, lease_until_ms = NULL, error_code = 'lease_expired', updated_at_ms = ?2 WHERE id = ?1",
                params![id.to_string(), now_ms],
            )?;
            let delivery = get_delivery_tx(&tx, id)?;
            let message = get_message_tx(&tx, delivery.message_id)?;
            let seat = get_seat_tx(&tx, delivery.seat_id)?;
            insert_assignment_event(&tx, &delivery, &message, &seat, now_ms)?;
        }
        changed.push(get_delivery_tx(&tx, id)?);
    }
    tx.commit()?;
    Ok(changed)
}

fn mark_node_offline(connection: &mut Connection, node_id: Uuid, now_ms: i64) -> Result<usize> {
    let tx = connection.transaction()?;
    let changed = tx.execute(
        "UPDATE seats SET state = 'offline', last_seen_ms = ?2 WHERE node_id = ?1 AND state != 'detached'",
        params![node_id.to_string(), now_ms],
    )?;
    tx.execute(
        "UPDATE nodes SET last_seen_ms = ?2 WHERE id = ?1",
        params![node_id.to_string(), now_ms],
    )?;
    tx.commit()?;
    Ok(changed)
}

fn create_approval(connection: &mut Connection, approval: NewApproval) -> Result<Approval> {
    let tx = connection.transaction()?;
    let seat = get_seat_tx(&tx, approval.seat_id)?;
    if seat.node_id != approval.node_id {
        return Err(StoreError::SeatNotOwned);
    }
    let delivery = get_delivery_tx(&tx, approval.delivery_id)?;
    if delivery.seat_id != approval.seat_id {
        return Err(StoreError::SeatNotOwned);
    }
    let id = new_id();
    tx.execute(
        "INSERT INTO approvals(id, room_id, seat_id, delivery_id, provider_request_id, description, input_preview, decisions_json, state, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9)",
        params![
            id.to_string(),
            seat.room_id.to_string(),
            seat.id.to_string(),
            approval.delivery_id.to_string(),
            approval.provider_request_id,
            approval.description,
            approval.input_preview,
            serde_json::to_string(&approval.decisions)?,
            approval.now_ms,
        ],
    )?;
    tx.execute(
        "UPDATE deliveries SET state = 'waiting_approval', lease_until_ms = ?2, updated_at_ms = ?3 WHERE id = ?1",
        params![approval.delivery_id.to_string(), approval.now_ms + LEASE_MS, approval.now_ms],
    )?;
    insert_message(
        &tx,
        MessageInsert {
            room_id: seat.room_id,
            actor_id: seat.id,
            actor_kind: ActorKind::Agent,
            kind: MessageKind::Approval,
            body: &format!("approval_requested:{id}"),
            reply_to: None,
            mentioned_seat_ids: &[],
            now_ms: approval.now_ms,
        },
    )?;
    let result = get_approval_tx(&tx, id)?;
    tx.commit()?;
    Ok(result)
}

fn resolve_approval(connection: &mut Connection, resolution: ResolveApproval) -> Result<Approval> {
    let payload_hash = canonical_sha256(&json!({
        "actor_id": resolution.actor_id,
        "request_id": resolution.request_id,
        "approval_id": resolution.approval_id,
        "decision": resolution.decision,
    }))?;
    let tx = connection.transaction()?;
    if let Some(result) = dedupe_lookup::<Approval>(
        &tx,
        resolution.actor_id,
        resolution.request_id,
        &payload_hash,
    )? {
        return Ok(result);
    }
    let current = get_approval_tx(&tx, resolution.approval_id)?;
    if current.state != "pending" || !current.decisions.contains(&resolution.decision) {
        return Err(StoreError::InvalidState);
    }
    tx.execute(
        "UPDATE approvals SET state = 'resolved', resolution = ?2, resolved_at_ms = ?3 WHERE id = ?1",
        params![resolution.approval_id.to_string(), resolution.decision, resolution.now_ms],
    )?;
    tx.execute(
        "UPDATE deliveries SET state = 'queued', lease_until_ms = NULL, updated_at_ms = ?2 WHERE id = ?1 AND state = 'waiting_approval'",
        params![current.delivery_id.to_string(), resolution.now_ms],
    )?;
    let seat = get_seat_tx(&tx, current.seat_id)?;
    tx.execute(
        "INSERT INTO events(event_id, target_node_id, type, payload_json, created_at_ms)
         VALUES (?1, ?2, 'approval.resolve', ?3, ?4)",
        params![
            new_id().to_string(),
            seat.node_id.to_string(),
            serde_json::to_string(
                &json!({"approval_id": current.id, "decision": resolution.decision})
            )?,
            resolution.now_ms,
        ],
    )?;
    let result = get_approval_tx(&tx, resolution.approval_id)?;
    dedupe_save(
        &tx,
        resolution.actor_id,
        resolution.request_id,
        &payload_hash,
        &result,
        resolution.now_ms,
    )?;
    tx.commit()?;
    Ok(result)
}

fn inspect_schema(connection: &Connection) -> Result<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

struct MessageInsert<'a> {
    room_id: Uuid,
    actor_id: Uuid,
    actor_kind: ActorKind,
    kind: MessageKind,
    body: &'a str,
    reply_to: Option<Uuid>,
    mentioned_seat_ids: &'a [Uuid],
    now_ms: i64,
}

fn insert_message(tx: &Transaction<'_>, input: MessageInsert<'_>) -> Result<Message> {
    let seq: i64 = tx.query_row(
        "UPDATE rooms SET next_seq = next_seq + 1 WHERE id = ?1 RETURNING next_seq - 1",
        [input.room_id.to_string()],
        |row| row.get(0),
    )?;
    let message = Message {
        id: new_id(),
        room_id: input.room_id,
        seq,
        actor_id: input.actor_id,
        actor_kind: input.actor_kind,
        kind: input.kind,
        body: input.body.to_owned(),
        reply_to: input.reply_to,
        mentioned_seat_ids: input.mentioned_seat_ids.to_vec(),
        created_at_ms: input.now_ms,
    };
    tx.execute(
        "INSERT INTO messages(id, room_id, seq, actor_id, actor_kind, kind, body, reply_to, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            message.id.to_string(),
            input.room_id.to_string(),
            seq,
            input.actor_id.to_string(),
            enum_text(input.actor_kind),
            enum_text(input.kind),
            input.body,
            input.reply_to.map(|id| id.to_string()),
            input.now_ms,
        ],
    )?;
    for seat_id in input.mentioned_seat_ids {
        tx.execute(
            "INSERT INTO message_mentions(message_id, seat_id) VALUES (?1, ?2)",
            params![message.id.to_string(), seat_id.to_string()],
        )?;
    }
    Ok(message)
}

fn insert_system_message(
    tx: &Transaction<'_>,
    room_id: Uuid,
    body: &str,
    now_ms: i64,
) -> Result<Message> {
    insert_message(
        tx,
        MessageInsert {
            room_id,
            actor_id: citadel_protocol::system_actor_id(),
            actor_kind: ActorKind::System,
            kind: MessageKind::System,
            body,
            reply_to: None,
            mentioned_seat_ids: &[],
            now_ms,
        },
    )
}

fn insert_delivery(
    tx: &Transaction<'_>,
    message: &Message,
    seat: &Seat,
    reason: DeliveryReason,
    now_ms: i64,
) -> Result<Delivery> {
    let delivery = Delivery {
        id: new_id(),
        room_id: message.room_id,
        message_id: message.id,
        seat_id: seat.id,
        reason,
        state: DeliveryState::Queued,
        attempt: 1,
        lease_until_ms: None,
        error_code: None,
        run_id: None,
    };
    tx.execute(
        "INSERT INTO deliveries(id, room_id, message_id, seat_id, reason, state, attempt, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, 'queued', 1, ?6, ?6)",
        params![
            delivery.id.to_string(),
            delivery.room_id.to_string(),
            delivery.message_id.to_string(),
            delivery.seat_id.to_string(),
            enum_text(reason),
            now_ms,
        ],
    )?;
    Ok(delivery)
}

fn insert_assignment_event(
    tx: &Transaction<'_>,
    delivery: &Delivery,
    message: &Message,
    seat: &Seat,
    now_ms: i64,
) -> Result<()> {
    let room = tx.query_row(
        "SELECT id, slug, title, objective, next_seq, archived_at_ms FROM rooms WHERE id = ?1",
        [delivery.room_id.to_string()],
        room_row,
    )?;
    let seats = list_seats_tx(tx, delivery.room_id)?;
    let context_messages = list_context_tx(tx, delivery.room_id, seat.last_ack_seq)?;
    let parent = message
        .reply_to
        .map(|id| get_message_tx(tx, id))
        .transpose()?;
    let payload = json!({
        "delivery": delivery,
        "message": message,
        "parent": parent,
        "context_messages": context_messages,
        "room": room,
        "seats": seats,
    });
    tx.execute(
        "INSERT INTO events(event_id, target_node_id, type, payload_json, created_at_ms) VALUES (?1, ?2, 'delivery.assign', ?3, ?4)",
        params![
            new_id().to_string(),
            seat.node_id.to_string(),
            serde_json::to_string(&payload)?,
            now_ms,
        ],
    )?;
    Ok(())
}

fn list_context_tx(tx: &Transaction<'_>, room_id: Uuid, after_seq: i64) -> Result<Vec<Message>> {
    let mut statement = tx.prepare(
        "SELECT id, room_id, seq, actor_id, actor_kind, kind, body, reply_to, created_at_ms
         FROM messages WHERE room_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT 20",
    )?;
    let rows = statement.query_map(params![room_id.to_string(), after_seq], |row| {
        message_row(tx, row)
    })?;
    let mut messages = collect_rows(rows)?;
    while serde_json::to_vec(&messages)?.len() > citadel_protocol::CONTEXT_MAX_BYTES {
        if messages.is_empty() {
            break;
        }
        messages.remove(0);
    }
    Ok(messages)
}

fn unbound_aliases_tx(
    tx: &Transaction<'_>,
    room_id: Uuid,
    body: &str,
    selected: &[Uuid],
) -> Result<Vec<String>> {
    let seats = list_seats_tx(tx, room_id)?;
    Ok(seats
        .into_iter()
        .filter(|seat| body.contains(&format!("@{}", seat.alias)) && !selected.contains(&seat.id))
        .map(|seat| seat.alias)
        .collect())
}

fn list_seats_tx(tx: &Transaction<'_>, room_id: Uuid) -> Result<Vec<Seat>> {
    let mut statement = tx.prepare(
        "SELECT id, room_id, node_id, alias, provider, session_ref, state, last_seen_ms, last_ack_seq FROM seats WHERE room_id = ?1 ORDER BY alias",
    )?;
    let rows = statement.query_map([room_id.to_string()], seat_row)?;
    collect_rows(rows)
}

fn get_delivery_tx(tx: &Transaction<'_>, id: Uuid) -> Result<Delivery> {
    tx.query_row(
        "SELECT id, room_id, message_id, seat_id, reason, state, attempt, lease_until_ms, error_code FROM deliveries WHERE id = ?1",
        [id.to_string()],
        delivery_row,
    )
    .optional()?
    .ok_or(StoreError::NotFound)
}

fn get_message_tx(tx: &Transaction<'_>, id: Uuid) -> Result<Message> {
    tx.query_row(
        "SELECT id, room_id, seq, actor_id, actor_kind, kind, body, reply_to, created_at_ms FROM messages WHERE id = ?1",
        [id.to_string()],
        |row| message_row(tx, row),
    )
    .optional()?
    .ok_or(StoreError::NotFound)
}

fn dedupe_lookup<T: DeserializeOwned>(
    tx: &Transaction<'_>,
    actor_id: Uuid,
    request_id: Uuid,
    payload_hash: &str,
) -> Result<Option<T>> {
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT payload_sha256, response_json FROM request_dedupe WHERE actor_id = ?1 AND request_id = ?2",
            params![actor_id.to_string(), request_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match existing {
        Some((stored_hash, response)) if stored_hash == payload_hash => {
            Ok(Some(serde_json::from_str(&response)?))
        }
        Some(_) => Err(StoreError::RequestIdReused),
        None => Ok(None),
    }
}

fn dedupe_save<T: Serialize>(
    tx: &Transaction<'_>,
    actor_id: Uuid,
    request_id: Uuid,
    payload_hash: &str,
    response: &T,
    now_ms: i64,
) -> Result<()> {
    tx.execute(
        "INSERT INTO request_dedupe(actor_id, request_id, payload_sha256, response_json, created_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            actor_id.to_string(),
            request_id.to_string(),
            payload_hash,
            serde_json::to_string(response)?,
            now_ms,
        ],
    )?;
    Ok(())
}

fn room_row(row: &Row<'_>) -> rusqlite::Result<Room> {
    Ok(Room {
        id: parse_uuid(row.get(0)?)?,
        slug: row.get(1)?,
        title: row.get(2)?,
        objective: row.get(3)?,
        next_seq: row.get(4)?,
        archived_at: row.get(5)?,
    })
}

fn node_row(row: &Row<'_>) -> rusqlite::Result<Node> {
    Ok(Node {
        id: parse_uuid(row.get(0)?)?,
        name: row.get(1)?,
        created_at_ms: row.get(2)?,
        revoked_at_ms: row.get(3)?,
        last_seen_ms: row.get(4)?,
    })
}

fn seat_row(row: &Row<'_>) -> rusqlite::Result<Seat> {
    Ok(Seat {
        id: parse_uuid(row.get(0)?)?,
        room_id: parse_uuid(row.get(1)?)?,
        node_id: parse_uuid(row.get(2)?)?,
        alias: row.get(3)?,
        provider: parse_enum(&row.get::<_, String>(4)?)?,
        session_ref: row.get(5)?,
        state: parse_enum(&row.get::<_, String>(6)?)?,
        last_seen_ms: row.get(7)?,
        last_ack_seq: row.get(8)?,
    })
}

fn message_row(connection: &Connection, row: &Row<'_>) -> rusqlite::Result<Message> {
    let id = parse_uuid(row.get(0)?)?;
    let mut mention_statement = connection
        .prepare("SELECT seat_id FROM message_mentions WHERE message_id = ?1 ORDER BY seat_id")?;
    let mentions = mention_statement
        .query_map([id.to_string()], |mention| {
            parse_uuid(mention.get::<_, String>(0)?)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(Message {
        id,
        room_id: parse_uuid(row.get(1)?)?,
        seq: row.get(2)?,
        actor_id: parse_uuid(row.get(3)?)?,
        actor_kind: parse_enum(&row.get::<_, String>(4)?)?,
        kind: parse_enum(&row.get::<_, String>(5)?)?,
        body: row.get(6)?,
        reply_to: row
            .get::<_, Option<String>>(7)?
            .map(parse_uuid)
            .transpose()?,
        mentioned_seat_ids: mentions,
        created_at_ms: row.get(8)?,
    })
}

fn approval_row(row: &Row<'_>) -> rusqlite::Result<Approval> {
    Ok(Approval {
        id: parse_uuid(row.get(0)?)?,
        room_id: parse_uuid(row.get(1)?)?,
        seat_id: parse_uuid(row.get(2)?)?,
        delivery_id: parse_uuid(row.get(3)?)?,
        provider_request_id: row.get(4)?,
        description: row.get(5)?,
        input_preview: row.get(6)?,
        decisions: serde_json::from_str(&row.get::<_, String>(7)?).map_err(to_sql_error)?,
        state: row.get(8)?,
        resolution: row.get(9)?,
        created_at_ms: row.get(10)?,
        resolved_at_ms: row.get(11)?,
    })
}

fn get_approval_tx(tx: &Transaction<'_>, id: Uuid) -> Result<Approval> {
    tx.query_row(
        "SELECT id, room_id, seat_id, delivery_id, provider_request_id, description, input_preview, decisions_json, state, resolution, created_at_ms, resolved_at_ms
         FROM approvals WHERE id = ?1",
        [id.to_string()],
        approval_row,
    )
    .optional()?
    .ok_or(StoreError::NotFound)
}

fn delivery_row(row: &Row<'_>) -> rusqlite::Result<Delivery> {
    Ok(Delivery {
        id: parse_uuid(row.get(0)?)?,
        room_id: parse_uuid(row.get(1)?)?,
        message_id: parse_uuid(row.get(2)?)?,
        seat_id: parse_uuid(row.get(3)?)?,
        reason: parse_enum(&row.get::<_, String>(4)?)?,
        state: parse_enum(&row.get::<_, String>(5)?)?,
        attempt: row.get(6)?,
        lease_until_ms: row.get(7)?,
        error_code: row.get(8)?,
        run_id: None,
    })
}

fn enum_text<T: Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .expect("enum serialization")
        .as_str()
        .expect("string enum")
        .to_owned()
}

fn parse_enum<T: DeserializeOwned>(value: &str) -> rusqlite::Result<T> {
    serde_json::from_value(Value::String(value.to_owned())).map_err(to_sql_error)
}

fn parse_uuid(value: String) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(&value).map_err(to_sql_error)
}

fn to_sql_error(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn collect_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&Row<'_>) -> rusqlite::Result<T>>,
) -> Result<Vec<T>> {
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    async fn fixture() -> (Store, Room, Node, Seat) {
        let store = Store::memory().await.unwrap();
        let room = store
            .create_room(new_id(), "room".into(), "Room".into(), "Goal".into(), 1)
            .await
            .unwrap();
        let node = store
            .add_node(NewNode {
                id: new_id(),
                name: "mac".into(),
                token_hash: "hash".into(),
                now_ms: 1,
            })
            .await
            .unwrap();
        let seat = store
            .add_seat(NewSeat {
                id: new_id(),
                room_id: room.id,
                node_id: node.id,
                alias: "mac-claude".into(),
                provider: SeatProvider::Claude,
                session_ref: "session".into(),
                now_ms: 1,
            })
            .await
            .unwrap();
        (store, room, node, seat)
    }

    #[tokio::test]
    async fn migration_creates_exact_schema() {
        let store = Store::memory().await.unwrap();
        let expected = vec![
            "approvals",
            "artifacts",
            "browser_sessions",
            "deliveries",
            "events",
            "handoffs",
            "message_mentions",
            "messages",
            "nodes",
            "request_dedupe",
            "rooms",
            "run_events",
            "runs",
            "seats",
            "tasks",
        ];
        assert_eq!(store.inspect_schema().await.unwrap(), expected);
    }

    #[tokio::test]
    async fn message_and_deliveries_commit_atomically() {
        let (store, room, _, seat) = fixture().await;
        let result = store
            .post_message(PostMessageCommand {
                actor_id: new_id(),
                request_id: new_id(),
                room_id: room.id,
                actor_kind: ActorKind::Human,
                kind: MessageKind::Chat,
                body: "go".into(),
                reply_to: None,
                selected_seat_ids: vec![seat.id],
                reason: DeliveryReason::HumanMention,
                now_ms: 2,
            })
            .await
            .unwrap();
        assert_eq!(result.deliveries.len(), 1);
        assert_eq!(store.replay_events(seat.node_id, 0).await.unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn room_sequence_is_gap_free_under_concurrency() {
        let (store, room, _, _) = fixture().await;
        let store = Arc::new(store);
        let mut tasks = Vec::new();
        for index in 0..32 {
            let store = store.clone();
            tasks.push(tokio::spawn(async move {
                store
                    .post_message(PostMessageCommand {
                        actor_id: new_id(),
                        request_id: new_id(),
                        room_id: room.id,
                        actor_kind: ActorKind::Human,
                        kind: MessageKind::Chat,
                        body: index.to_string(),
                        reply_to: None,
                        selected_seat_ids: vec![],
                        reason: DeliveryReason::HumanMention,
                        now_ms: index,
                    })
                    .await
                    .unwrap();
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        let messages = store.list_messages(room.id, None, None, 100).await.unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|message| message.seq)
                .collect::<Vec<_>>(),
            (1..=32).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn same_request_same_payload_replays_response() {
        let (store, room, _, _) = fixture().await;
        let command = PostMessageCommand {
            actor_id: new_id(),
            request_id: new_id(),
            room_id: room.id,
            actor_kind: ActorKind::Human,
            kind: MessageKind::Chat,
            body: "same".into(),
            reply_to: None,
            selected_seat_ids: vec![],
            reason: DeliveryReason::HumanMention,
            now_ms: 2,
        };
        let first = store.post_message(command.clone()).await.unwrap();
        let second = store.post_message(command).await.unwrap();
        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn same_request_different_payload_conflicts() {
        let (store, room, _, _) = fixture().await;
        let request_id = new_id();
        let actor_id = new_id();
        let mut command = PostMessageCommand {
            actor_id,
            request_id,
            room_id: room.id,
            actor_kind: ActorKind::Human,
            kind: MessageKind::Chat,
            body: "one".into(),
            reply_to: None,
            selected_seat_ids: vec![],
            reason: DeliveryReason::HumanMention,
            now_ms: 2,
        };
        store.post_message(command.clone()).await.unwrap();
        command.body = "two".into();
        assert!(matches!(
            store.post_message(command).await,
            Err(StoreError::RequestIdReused)
        ));
    }

    #[tokio::test]
    async fn lease_expiry_requeues_once() {
        let (store, room, node, seat) = fixture().await;
        let posted = store
            .post_message(PostMessageCommand {
                actor_id: new_id(),
                request_id: new_id(),
                room_id: room.id,
                actor_kind: ActorKind::Human,
                kind: MessageKind::Chat,
                body: "go".into(),
                reply_to: None,
                selected_seat_ids: vec![seat.id],
                reason: DeliveryReason::HumanMention,
                now_ms: 1,
            })
            .await
            .unwrap();
        let delivery = store
            .update_delivery(DeliveryUpdate {
                delivery_id: posted.deliveries[0].id,
                node_id: node.id,
                state: DeliveryState::Acked,
                error_code: None,
                now_ms: 2,
            })
            .await
            .unwrap();
        let retried = store
            .retry_expired(delivery.lease_until_ms.unwrap())
            .await
            .unwrap();
        assert_eq!(retried[0].id, delivery.id);
        assert_eq!(retried[0].attempt, 2);
        assert_eq!(retried[0].state, DeliveryState::Queued);
    }

    #[tokio::test]
    async fn third_failure_dead_letters() {
        let (store, room, node, seat) = fixture().await;
        let posted = store
            .post_message(PostMessageCommand {
                actor_id: new_id(),
                request_id: new_id(),
                room_id: room.id,
                actor_kind: ActorKind::Human,
                kind: MessageKind::Chat,
                body: "go".into(),
                reply_to: None,
                selected_seat_ids: vec![seat.id],
                reason: DeliveryReason::HumanMention,
                now_ms: 1,
            })
            .await
            .unwrap();
        let first = store
            .update_delivery(DeliveryUpdate {
                delivery_id: posted.deliveries[0].id,
                node_id: node.id,
                state: DeliveryState::Acked,
                error_code: None,
                now_ms: 2,
            })
            .await
            .unwrap();
        store
            .retry_expired(first.lease_until_ms.unwrap())
            .await
            .unwrap();
        let second = store
            .update_delivery(DeliveryUpdate {
                delivery_id: first.id,
                node_id: node.id,
                state: DeliveryState::Acked,
                error_code: None,
                now_ms: first.lease_until_ms.unwrap() + 1,
            })
            .await
            .unwrap();
        let result = store
            .retry_expired(second.lease_until_ms.unwrap())
            .await
            .unwrap();
        assert_eq!(result[0].state, DeliveryState::DeadLetter);
        assert_eq!(result[0].attempt, 3);
    }

    #[tokio::test]
    async fn temporary_database_survives_close_and_reopen() {
        let path = std::env::temp_dir().join(format!("roundtable-{}.sqlite3", new_id()));
        let room_id = new_id();
        {
            let store = Store::open(&path).await.unwrap();
            store
                .create_room(
                    room_id,
                    "persist".into(),
                    "Persist".into(),
                    "Goal".into(),
                    1,
                )
                .await
                .unwrap();
            store
                .post_message(PostMessageCommand {
                    actor_id: new_id(),
                    request_id: new_id(),
                    room_id,
                    actor_kind: ActorKind::Human,
                    kind: MessageKind::Chat,
                    body: "durable".into(),
                    reply_to: None,
                    selected_seat_ids: vec![],
                    reason: DeliveryReason::HumanMention,
                    now_ms: 2,
                })
                .await
                .unwrap();
        }
        tokio::task::yield_now().await;
        let reopened = Store::open(&path).await.unwrap();
        assert_eq!(
            reopened
                .list_messages(room_id, None, None, 100)
                .await
                .unwrap()[0]
                .body,
            "durable"
        );
        drop(reopened);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[tokio::test]
    async fn foreign_keys_reject_orphans() {
        let store = Store::memory().await.unwrap();
        let result = store
            .add_seat(NewSeat {
                id: new_id(),
                room_id: new_id(),
                node_id: new_id(),
                alias: "orphan".into(),
                provider: SeatProvider::Claude,
                session_ref: "x".into(),
                now_ms: 1,
            })
            .await;
        assert!(matches!(result, Err(StoreError::Sqlite(_))));
    }
}
