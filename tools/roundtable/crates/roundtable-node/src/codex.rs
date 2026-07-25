//! Codex App Server adapter - manages a child process speaking JSONL on stdio.
//!
//! Production: spawns the real `codex app-server` on the user machine.
//! Tests: spawns the Node.js fixture at fixtures/app-server/fake-codex.mjs, which implements
//! `initialize`, `thread/start`, `turn/start`, and `shutdown` — everything else returns a
//! JSON-RPC error, matching what a real App Server would do for an unrecognized method.
//!
//! Method names (`thread/start`, `thread/resume`, `thread/list`, `turn/start`, `turn/steer`,
//! `turn/interrupt`) are taken from `2026-07-22-roundtable-cross-device-architecture.md` and
//! from the fixture above — not invented here.
//!
//! Wire shapes for `input` params and turn-lifecycle notifications are grounded in
//! `fixtures/app-server/schema/` — a real schema generated from a real, locally-installed
//! `codex` CLI (`codex app-server generate-json-schema --experimental`), not guessed. See that
//! directory's README for what it corrected relative to `fake-codex.mjs` and this file's
//! earlier assumptions (flat `turnId`/`status` fields, bare-string `input`).
//!
//! Still NOT implemented, and deliberately not pretended: approval requests and
//! `tool/requestUserInput`. Routed notifications: `turn/started`, `turn/completed`,
//! `turn/interrupted`, `turn/failed` (turn lifecycle), and `item/completed` where
//! `item.type == "agentMessage"` (real agent reply text, via `CodexEvent::body`).
//! `item/agentMessage/delta` (live-streaming chunks) is intentionally not consumed here.
//!
//! Persists (seat_id, thread_id, cwd, model, active_turn_id) in `seats`, in memory only —
//! nothing here yet persists to `NodeState`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, oneshot, Mutex};
use tokio::time::timeout;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::{NodeError, NodeResult};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexTurnStatus {
    Running,
    Completed,
    Failed,
    WaitingApproval,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexEvent {
    pub seat_id: Uuid,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub status: CodexTurnStatus,
    /// The real agent reply text, from an `item/completed` notification's `item.text` (see the
    /// module doc). Empty for every other routed event (turn/started, turn/completed, etc.) —
    /// those carry only lifecycle status, not content.
    pub body: String,
    pub kind: String,
    pub provider_request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum CodexCommand {
    Connect,
    ListThreads,
    /// Creates a brand-new App Server thread (`thread/start`). Added alongside this file's other
    /// changes: the enum previously had no way to create a first thread for a seat, only
    /// `ResumeThread` for an existing one and `StartTurn`, which itself requires a `thread_id`
    /// that must already exist.
    CreateThread { input: String, cwd: Option<String> },
    ResumeThread { thread_id: String },
    StartTurn { thread_id: String, input: String },
    SteerTurn { thread_id: String, expected_turn_id: String, input: String },
    InterruptTurn { thread_id: String },
    Shutdown,
}

/// Wraps a plain string as the real `UserInput` array shape App Server's `input` params require
/// (`TurnStartParams.input: UserInput[]`, tagged union with a `text` variant — see
/// `fixtures/app-server/schema/README.md`). `CodexCommand`'s own `input: String` fields stay
/// plain strings; this is the wire-boundary conversion, done once, here.
fn text_input(text: &str) -> Value {
    serde_json::json!([{ "type": "text", "text": text }])
}

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;
type StdoutLines = Arc<Mutex<Option<tokio::io::Lines<BufReader<tokio::process::ChildStdout>>>>>;

pub struct CodexAdapter {
    command: Vec<String>,
    cwd: Option<PathBuf>,
    process: Arc<Mutex<Option<Child>>>,
    stdin_tx: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    stdout_rx: StdoutLines,
    request_id: Arc<Mutex<i64>>,
    pending: PendingMap,
    /// broadcast, not mpsc: `subscribe()` may be called any number of times (including after
    /// events have already been sent), and each caller needs its own live receiver. An earlier
    /// mpsc-based version constructed a fresh (tx, rx) pair per subscribe() call but only ever
    /// returned `rx` — the paired `tx` was a local variable dropped when the function returned,
    /// so every returned receiver was orphaned before its first event. Found by the tests below,
    /// which are the first thing to ever exercise subscribe() against real events.
    pubsub: broadcast::Sender<CodexEvent>,
    seats: Arc<Mutex<HashMap<Uuid, SeatState>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeatState {
    pub seat_id: Uuid,
    pub thread_id: String,
    pub cwd: Option<String>,
    pub model: String,
    pub active_turn_id: Option<String>,
    pub last_progress_ms: i64,
}

impl CodexAdapter {
    pub fn new(command: Vec<String>, cwd: Option<PathBuf>) -> Self {
        let (pubsub, _first_receiver) = broadcast::channel(256);
        Self {
            command,
            cwd,
            process: Arc::new(Mutex::new(None)),
            stdin_tx: Arc::new(Mutex::new(None)),
            stdout_rx: Arc::new(Mutex::new(None)),
            request_id: Arc::new(Mutex::new(0)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            pubsub,
            seats: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Each call returns its own live receiver; a `send()` before or after a given `subscribe()`
    /// call is delivered to every receiver still alive at send time (broadcast semantics — a
    /// slow/absent subscriber does not see events sent before it subscribed, matching mpsc).
    pub async fn subscribe(&self) -> broadcast::Receiver<CodexEvent> {
        self.pubsub.subscribe()
    }

    /// Current state for a seat, if `execute()` has created or resumed a thread for it.
    pub async fn seat(&self, seat_id: Uuid) -> Option<SeatState> {
        self.seats.lock().await.get(&seat_id).cloned()
    }

    pub async fn connect(&mut self) -> NodeResult<()> {
        if !self.command.is_empty() {
            let mut cmd = Command::new(&self.command[0]);
            if self.command.len() > 1 {
                cmd.args(&self.command[1..]);
            }
            if let Some(cwd) = &self.cwd {
                cmd.current_dir(cwd);
            }
            cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            let mut child = cmd.spawn().map_err(|e| NodeError::Provider(format!("spawn: {e}")))?;
            let stdin = child.stdin.take().ok_or_else(|| NodeError::Provider("no stdin".into()))?;
            let stdout = child.stdout.take().ok_or_else(|| NodeError::Provider("no stdout".into()))?;
            *self.process.lock().await = Some(child);
            *self.stdin_tx.lock().await = Some(stdin);
            *self.stdout_rx.lock().await = Some(BufReader::new(stdout).lines());
            Self::spawn_reader_loop(
                self.stdout_rx.clone(), self.pending.clone(), self.pubsub.clone(), self.seats.clone(),
            );
        }
        // Previously fire-and-forget (`send_request` wrote the frame and returned `Value::Null`
        // without reading a response). Now genuinely awaits the handshake response via `call()`,
        // which requires the reader loop above to already be running to resolve it.
        self.call("initialize", serde_json::json!({"clientInfo": {"name": "roundtable-node"}})).await?;
        self.send_notification("initialized", serde_json::json!({})).await?;
        info!("codex app server connected");
        Ok(())
    }

    /// Background task: reads one JSONL line at a time for the life of the process.
    /// A line with an `id` resolves the matching pending `call()`. A line with a `method` and no
    /// `id` is a notification; turn-lifecycle ones are converted to a `CodexEvent` when their
    /// `threadId` matches a known seat, and dropped otherwise (there is no seat to route to yet).
    fn spawn_reader_loop(
        stdout_rx: StdoutLines,
        pending: PendingMap,
        pubsub: broadcast::Sender<CodexEvent>,
        seats: Arc<Mutex<HashMap<Uuid, SeatState>>>,
    ) {
        tokio::spawn(async move {
            loop {
                let line = {
                    let mut guard = stdout_rx.lock().await;
                    let lines = match guard.as_mut() {
                        Some(l) => l,
                        None => break,
                    };
                    match lines.next_line().await {
                        Ok(Some(l)) => l,
                        Ok(None) => break, // EOF — the App Server process exited.
                        Err(e) => {
                            warn!(error = %e, "codex stdout read error");
                            break;
                        }
                    }
                };
                if line.trim().is_empty() {
                    continue;
                }
                let frame: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(error = %e, raw = %line, "codex emitted a non-JSON line");
                        continue;
                    }
                };
                if let Some(id) = frame.get("id").and_then(Value::as_i64) {
                    let Some(tx) = pending.lock().await.remove(&id) else { continue };
                    let resolved = if let Some(err) = frame.get("error") {
                        let msg = err.get("message").and_then(Value::as_str)
                            .unwrap_or("app server returned an error").to_string();
                        Err(msg)
                    } else {
                        Ok(frame.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = tx.send(resolved);
                    continue;
                }
                if let Some(method) = frame.get("method").and_then(Value::as_str) {
                    let params = frame.get("params").cloned().unwrap_or(Value::Null);
                    if let Some(event) = Self::notification_to_event(method, &params, &seats).await {
                        let _ = pubsub.send(event);
                    }
                }
            }
            debug!("codex reader loop ended");
        });
    }

    /// Routes turn-lifecycle and agent-content notifications; anything else returns `None` and
    /// is dropped. Requires a `threadId` in `params` that matches a seat already known to
    /// `seats` — a notification for an unrecognized thread has nowhere to go and is not an
    /// error, just not yet routable (this happens for `turn/start`'s own completion
    /// notification in the fixture, which omits `threadId` entirely).
    ///
    /// Shapes below are grounded in `fixtures/app-server/schema/` — the REAL protocol, generated
    /// from a real `codex app-server generate-json-schema` run, not the simplified fixture. Two
    /// things the fixture gets wrong that this function must not repeat:
    /// - `turn/started`/`turn/completed` carry `{threadId, turn: Turn}` — turn_id and status
    ///   live inside the nested `turn` object (`turn.id`, `turn.status`), never at the top level.
    ///   `TurnStatus` is exactly `completed | interrupted | failed | inProgress`.
    /// - The real agent reply text is `item/completed` with `item.type == "agentMessage"` and a
    ///   flat `item.text` — not something accumulated from delta chunks. `item/agentMessage/delta`
    ///   exists for live-streaming UI and is intentionally NOT handled here; the completed item
    ///   already carries the full text once, which is what a delivery reply needs.
    async fn notification_to_event(
        method: &str,
        params: &Value,
        seats: &Arc<Mutex<HashMap<Uuid, SeatState>>>,
    ) -> Option<CodexEvent> {
        let (thread_id, turn_id, status, body) = match method {
            "turn/started" => {
                let thread_id = params.get("threadId").and_then(Value::as_str)?.to_string();
                let turn = params.get("turn")?;
                let turn_id = turn.get("id").and_then(Value::as_str).map(str::to_string);
                (thread_id, turn_id, CodexTurnStatus::Running, String::new())
            }
            "turn/completed" => {
                let thread_id = params.get("threadId").and_then(Value::as_str)?.to_string();
                let turn = params.get("turn")?;
                let turn_id = turn.get("id").and_then(Value::as_str).map(str::to_string);
                let status = match turn.get("status").and_then(Value::as_str) {
                    Some("failed") => CodexTurnStatus::Failed,
                    Some("interrupted") => CodexTurnStatus::Cancelled,
                    Some("inProgress") => CodexTurnStatus::Running,
                    _ => CodexTurnStatus::Completed, // "completed", or an unrecognized future value
                };
                (thread_id, turn_id, status, String::new())
            }
            "item/completed" => {
                let item = params.get("item")?;
                if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
                    return None; // tool calls, file changes, reasoning, etc. — not handled here
                }
                let thread_id = params.get("threadId").and_then(Value::as_str)?.to_string();
                let turn_id = params.get("turnId").and_then(Value::as_str).map(str::to_string);
                let text = item.get("text").and_then(Value::as_str)?.to_string();
                (thread_id, turn_id, CodexTurnStatus::Running, text)
            }
            _ => return None,
        };
        let seat_id = seats.lock().await.values()
            .find(|s| s.thread_id == thread_id).map(|s| s.seat_id)?;
        Some(CodexEvent {
            seat_id, thread_id, turn_id, status, body,
            kind: method.to_string(),
            provider_request_id: None,
        })
    }

    async fn write_frame(&self, bytes: &[u8]) -> NodeResult<()> {
        let mut stdin = self.stdin_tx.lock().await;
        let stdin = stdin.as_mut().ok_or_else(|| NodeError::Provider("not connected".into()))?;
        stdin.write_all(bytes).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    /// Sends a JSON-RPC request and awaits its correlated response (or a 30s timeout).
    async fn call(&self, method: &str, params: Value) -> NodeResult<Value> {
        let req_id = {
            let mut id = self.request_id.lock().await;
            *id += 1;
            *id
        };
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(req_id, tx);
        let frame = serde_json::json!({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params});
        let bytes = serde_json::to_vec(&frame)?;
        if let Err(e) = self.write_frame(&bytes).await {
            self.pending.lock().await.remove(&req_id);
            return Err(e);
        }
        match timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(msg))) => Err(NodeError::Provider(msg)),
            Ok(Err(_)) => Err(NodeError::Provider(format!("app server closed before responding to {method}"))),
            Err(_) => {
                self.pending.lock().await.remove(&req_id);
                Err(NodeError::Provider(format!("{method} timed out waiting for a response")))
            }
        }
    }

    async fn send_notification(&self, method: &str, params: Value) -> NodeResult<()> {
        let frame = serde_json::json!({"jsonrpc": "2.0", "method": method, "params": params});
        let bytes = serde_json::to_vec(&frame)?;
        self.write_frame(&bytes).await
    }

    /// Sends one `CodexCommand` to the App Server and returns its result.
    ///
    /// `Connect` and `Shutdown` are rejected here — they go through `connect()`/`shutdown()`,
    /// which manage the child process itself, not just a JSON-RPC round trip.
    pub async fn execute(&self, seat_id: Uuid, cmd: CodexCommand) -> NodeResult<Value> {
        match cmd {
            CodexCommand::Connect | CodexCommand::Shutdown => Err(NodeError::Provider(
                "Connect and Shutdown go through CodexAdapter::connect()/shutdown(), not execute()".into(),
            )),
            CodexCommand::ListThreads => self.call("thread/list", serde_json::json!({})).await,
            CodexCommand::CreateThread { input, cwd } => {
                let result = self.call(
                    "thread/start", serde_json::json!({"input": text_input(&input), "cwd": cwd}),
                ).await?;
                if let Some(thread_id) = result.get("threadId").and_then(Value::as_str) {
                    let mut seats = self.seats.lock().await;
                    seats.insert(seat_id, SeatState {
                        seat_id, thread_id: thread_id.to_string(), cwd,
                        model: String::new(), active_turn_id: None, last_progress_ms: 0,
                    });
                }
                Ok(result)
            }
            CodexCommand::ResumeThread { thread_id } => {
                let result = self.call("thread/resume", serde_json::json!({"threadId": thread_id})).await?;
                self.upsert_seat_thread(seat_id, &thread_id).await;
                Ok(result)
            }
            CodexCommand::StartTurn { thread_id, input } => {
                let result = self.call(
                    "turn/start", serde_json::json!({"threadId": thread_id, "input": text_input(&input)}),
                ).await?;
                self.upsert_seat_thread(seat_id, &thread_id).await;
                if let Some(turn_id) = result.get("turnId").and_then(Value::as_str) {
                    self.set_active_turn(seat_id, Some(turn_id.to_string())).await;
                }
                Ok(result)
            }
            CodexCommand::SteerTurn { thread_id, expected_turn_id, input } => {
                self.call("turn/steer", serde_json::json!({
                    "threadId": thread_id, "expectedTurnId": expected_turn_id, "input": text_input(&input),
                })).await
            }
            CodexCommand::InterruptTurn { thread_id } => {
                self.call("turn/interrupt", serde_json::json!({"threadId": thread_id})).await
            }
        }
    }

    async fn upsert_seat_thread(&self, seat_id: Uuid, thread_id: &str) {
        let mut seats = self.seats.lock().await;
        seats.entry(seat_id).and_modify(|s| s.thread_id = thread_id.to_string())
            .or_insert_with(|| SeatState {
                seat_id, thread_id: thread_id.to_string(), cwd: None,
                model: String::new(), active_turn_id: None, last_progress_ms: 0,
            });
    }

    async fn set_active_turn(&self, seat_id: Uuid, turn_id: Option<String>) {
        if let Some(entry) = self.seats.lock().await.get_mut(&seat_id) {
            entry.active_turn_id = turn_id;
        }
    }

    pub async fn shutdown(&mut self) -> NodeResult<()> {
        let _ = self.send_notification("shutdown", serde_json::json!({})).await;
        let mut proc = self.process.lock().await;
        if let Some(mut child) = proc.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_path() -> PathBuf {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest.parent().unwrap().parent().unwrap()
            .join("fixtures").join("app-server").join("fake-codex.mjs")
    }

    fn fixture_adapter() -> CodexAdapter {
        CodexAdapter::new(vec!["node".into(), fixture_path().to_string_lossy().into_owned()], None)
    }

    #[test]
    fn turn_status_serializes_snake_case() {
        let s = serde_json::to_string(&CodexTurnStatus::WaitingApproval).unwrap();
        assert_eq!(s, "\"waiting_approval\"");
    }

    #[test]
    fn seat_state_round_trips() {
        let s = SeatState {
            seat_id: Uuid::now_v7(),
            thread_id: "thr-1".into(),
            cwd: Some("/tmp".into()),
            model: "gpt-5".into(),
            active_turn_id: Some("turn-1".into()),
            last_progress_ms: 0,
        };
        let bytes = serde_json::to_vec(&s).unwrap();
        let back: SeatState = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.thread_id, "thr-1");
    }

    #[test]
    fn command_serializes_with_op_tag() {
        let cmd = CodexCommand::SteerTurn {
            thread_id: "thr-1".into(),
            expected_turn_id: "turn-1".into(),
            input: "hi".into(),
        };
        let bytes = serde_json::to_vec(&cmd).unwrap();
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.contains("\"op\":\"steer_turn\""), "unexpected: {}", s);
    }

    /// The genuinely new behavior: connect() now AWAITS the initialize response via the reader
    /// loop and call(), rather than firing the request and moving on regardless of what (or
    /// whether) the App Server replied.
    #[tokio::test]
    async fn connect_awaits_the_real_initialize_response() {
        let mut adapter = fixture_adapter();
        adapter.connect().await.expect("handshake with the real fixture process must succeed");
        adapter.shutdown().await.unwrap();
    }

    /// Proves a full round trip end-to-end: execute() sends the real `thread/start` frame to a
    /// real child process, the reader loop parses the response and notifications the fixture
    /// emits, and a resulting CodexEvent comes out the subscribe() channel routed to the correct
    /// seat_id — the exact path a DeliveryAssign handler will need. Also surfaces a real ordering
    /// race (documented inline below) rather than hiding it.
    #[tokio::test]
    async fn create_thread_round_trips_and_routes_events_to_the_seat() {
        let mut adapter = fixture_adapter();
        let mut events = adapter.subscribe().await;
        adapter.connect().await.unwrap();

        let seat_id = Uuid::now_v7();
        let result = adapter.execute(
            seat_id,
            CodexCommand::CreateThread { input: "hello".into(), cwd: None },
        ).await.expect("thread/start must succeed against the fixture");
        let thread_id = result.get("threadId").and_then(Value::as_str)
            .expect("fixture always returns a threadId").to_string();

        let seat = adapter.seat(seat_id).await.expect("execute() must register the seat");
        assert_eq!(seat.thread_id, thread_id);

        // REAL RACE, not a test artifact: the fixture's thread/start handler sends turn/started
        // on the wire BEFORE the id-response that `call()` is waiting on (see fake-codex.mjs).
        // The reader loop processes turn/started as soon as it arrives — which is BEFORE
        // execute()'s `seats.insert(seat_id, ...)` below has run, because that insert only
        // happens after `call()` resolves. notification_to_event() therefore finds no seat
        // matching this thread_id yet and correctly drops it (there is genuinely nowhere to
        // route it — the seat_id<->thread_id mapping does not exist until the response arrives).
        // Only the pair sent ~10ms later — item/completed then turn/completed — lands after the
        // mapping exists.
        //
        // This is a real limitation of CreateThread specifically: the very first notification
        // for a brand-new thread can race ahead of the response that makes it routable. Fixing it
        // properly needs a "pending creation" table keyed by request_id so an early notification
        // can be buffered until the create resolves — not implemented here; do not paper over it
        // by guessing at a client-supplied thread ID for thread/start without confirming that's
        // real App Server behavior rather than fixture convenience.
        let first = timeout(Duration::from_secs(2), events.recv()).await
            .expect("must not time out").expect("channel must not close");
        assert_eq!(first.seat_id, seat_id);
        assert_eq!(first.thread_id, thread_id);
        assert_eq!(first.kind, "item/completed", "turn/started is lost to the race described above");
        assert_eq!(first.body, "echo: hello", "item/completed must carry the real agentMessage text");

        let second = timeout(Duration::from_secs(2), events.recv()).await
            .expect("must not time out").expect("channel must not close");
        assert_eq!(second.seat_id, seat_id);
        assert_eq!(second.thread_id, thread_id);
        assert_eq!(second.kind, "turn/completed");
        assert_eq!(second.status, CodexTurnStatus::Completed);

        adapter.shutdown().await.unwrap();
    }

    /// The fixture returns a JSON-RPC error for any method it does not implement — this proves
    /// `call()` surfaces that as an `Err` with the App Server's own message, not a silent Ok or a
    /// panic. `thread/resume` is a real App Server method; it is simply not in this fixture.
    #[tokio::test]
    async fn an_unimplemented_method_surfaces_as_a_real_error() {
        let mut adapter = fixture_adapter();
        adapter.connect().await.unwrap();
        let err = adapter.execute(
            Uuid::now_v7(),
            CodexCommand::ResumeThread { thread_id: "thr-1".into() },
        ).await.expect_err("the fixture does not implement thread/resume");
        assert!(
            err.to_string().contains("thread/resume"),
            "error should name the method that failed: {err}",
        );
        adapter.shutdown().await.unwrap();
    }

    /// Direct unit coverage of the drop path in `notification_to_event`: a `turn/completed`
    /// missing `threadId` entirely genuinely cannot be routed to any seat and must return `None`,
    /// not panic or guess. (Previously exercised by relying on a fixture gap where turn/start's
    /// own completion omitted threadId — fixed in fake-codex.mjs once the real, schema-grounded
    /// shape was known, so this is now a direct call against crafted params instead.)
    #[tokio::test]
    async fn a_notification_missing_thread_id_is_dropped_not_misrouted() {
        let seats: Arc<Mutex<HashMap<Uuid, SeatState>>> = Arc::new(Mutex::new(HashMap::new()));
        let params = serde_json::json!({ "turn": { "id": "turn-1", "status": "completed" } });
        let outcome = CodexAdapter::notification_to_event("turn/completed", &params, &seats).await;
        assert!(outcome.is_none(), "a threadId-less notification must not produce a CodexEvent");
    }

    /// Direct unit coverage of the `item/completed` path: only `item.type == "agentMessage"` is
    /// routed (tool calls, file changes, reasoning, etc. are real `ThreadItem` variants that this
    /// adapter deliberately does not surface as chat content — see the module doc comment).
    #[tokio::test]
    async fn item_completed_with_a_non_agent_message_type_is_dropped() {
        let seats: Arc<Mutex<HashMap<Uuid, SeatState>>> = Arc::new(Mutex::new(HashMap::new()));
        let params = serde_json::json!({
            "threadId": "thr-1", "turnId": "turn-1",
            "item": { "id": "item-1", "type": "commandExecution", "command": "ls" },
        });
        let outcome = CodexAdapter::notification_to_event("item/completed", &params, &seats).await;
        assert!(outcome.is_none(), "a non-agentMessage item must not produce a CodexEvent");
    }
}
