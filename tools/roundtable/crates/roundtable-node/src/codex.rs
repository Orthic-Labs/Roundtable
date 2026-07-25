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
//! Every wire shape here is grounded in `fixtures/app-server/schema/` — a real schema generated
//! from a real, locally-installed `codex` CLI (`codex app-server generate-json-schema
//! --experimental`), not guessed. See that directory's README for the full list of what it
//! corrected. The load-bearing ones:
//! - `thread/start` takes **configuration only** — no `input` — and returns `{thread: Thread}`.
//!   Creating a thread does not start a turn.
//! - `turn/start` returns `{turn: Turn}`; ids live at `thread.id` / `turn.id`, never top-level.
//! - `turn/started`/`turn/completed` carry `{threadId, turn: Turn}`; status is `turn.status`,
//!   one of `completed | interrupted | failed | inProgress`.
//! - Every `input` param is an array of `UserInput` (tagged union), not a string.
//!
//! Routed notifications: `turn/started`, `turn/completed` (lifecycle); `item/completed` (real
//! content — agent messages, commands, file edits, tool calls, searches, plans, via
//! `summarize_item`); and `item/autoApprovalReview/started|completed` (Guardian approvals, via
//! `CodexEvent::approval`).
//!
//! **`tool/requestUserInput` does not exist in this protocol version** — verified absent from the
//! generated schema. The architecture doc's reference to it predates this App Server. Approvals
//! run through Guardian instead; see `CodexApproval`.
//!
//! Deliberately NOT consumed: `item/agentMessage/delta` and the other `*/delta` streams (this is
//! a message-passing bridge, not a live-typing UI — the completed item carries the full text
//! once), `reasoning` items (the model's private scratchpad), and `userMessage` items (the
//! message we ourselves just sent, which would echo back into the room).
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

/// A Guardian approval review, from `item/autoApprovalReview/started|completed`.
///
/// This Codex version has **no** classic "server asks the client to approve an exec" JSON-RPC
/// request, and no `tool/requestUserInput` method at all (verified absent from the generated
/// schema — see `fixtures/app-server/schema/README.md`). Approvals instead run through a
/// Guardian that auto-reviews each risky action and reports the outcome; a human overrides a
/// **denied** action by calling `thread/approveGuardianDeniedAction`. That is the only
/// human-in-the-loop approval path that actually exists here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexApproval {
    pub review_id: String,
    /// `command` | `execve` | `applyPatch` | `networkAccess` | `mcpToolCall` | `requestPermissions`
    pub action_type: String,
    /// Human-readable one-liner for the action, built from the variant's own fields.
    pub summary: String,
    /// `inProgress` | `approved` | `denied` | `timedOut` | `aborted`
    pub status: String,
    pub risk_level: Option<String>,
    pub rationale: Option<String>,
    /// The full notification `params`, kept verbatim so an override can be replayed to
    /// `thread/approveGuardianDeniedAction` without this adapter having to model
    /// `GuardianAssessmentEvent` — a type the schema declares only as "serialized", with no
    /// shape. Passing through what we received is honest; inventing a shape would not be.
    pub raw_event: Value,
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
    /// The `ThreadItem` variant this event came from, for `item/completed` only — e.g.
    /// `agentMessage`, `commandExecution`, `fileChange`. Lets a consumer distinguish the agent
    /// actually speaking from the agent doing something, without pattern-matching on `body`.
    #[serde(default)]
    pub item_type: Option<String>,
    /// Set only for `item/autoApprovalReview/*` events.
    #[serde(default)]
    pub approval: Option<CodexApproval>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum CodexCommand {
    Connect,
    ListThreads,
    /// Creates a brand-new App Server thread (`thread/start`).
    ///
    /// **Takes no input.** `ThreadStartParams` is configuration only (`cwd`, `model`, `sandbox`,
    /// `approvalPolicy`, …) — verified against the real schema. Creating a thread does NOT start
    /// a turn; send `StartTurn` afterward to actually say something. An earlier version of this
    /// enum carried an `input: String` here and sent it on the wire, which a real App Server
    /// would have ignored or rejected.
    CreateThread { cwd: Option<String> },
    ResumeThread { thread_id: String },
    StartTurn { thread_id: String, input: String },
    SteerTurn { thread_id: String, expected_turn_id: String, input: String },
    InterruptTurn { thread_id: String },
    /// Human override for an action Guardian denied (`thread/approveGuardianDeniedAction`).
    /// `event` is the `GuardianAssessmentEvent` passed straight back from the review
    /// notification that reported the denial.
    ApproveGuardianDeniedAction { thread_id: String, event: Value },
    Shutdown,
}

/// Wraps a plain string as the real `UserInput` array shape App Server's `input` params require
/// (`TurnStartParams.input: UserInput[]`, tagged union with a `text` variant — see
/// `fixtures/app-server/schema/README.md`). `CodexCommand`'s own `input: String` fields stay
/// plain strings; this is the wire-boundary conversion, done once, here.
fn text_input(text: &str) -> Value {
    serde_json::json!([{ "type": "text", "text": text }])
}

/// Trims a string to `max` chars for a room-readable one-liner, collapsing newlines.
fn brief(s: &str, max: usize) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        return one_line;
    }
    let cut: String = one_line.chars().take(max).collect();
    format!("{cut}…")
}

/// Renders a completed `ThreadItem` as room-readable text, or `None` for item types that carry no
/// useful standalone content.
///
/// Variant names and fields are exactly those in the real `ThreadItem` union
/// (`fixtures/app-server/schema/`). `agentMessage` returns its text bare — that is the agent
/// actually speaking. Everything else is prefixed so a reader can tell activity from speech;
/// `main.rs` posts the bare case as `Chat` and the rest as `Progress`.
fn summarize_item(item: &Value) -> Option<String> {
    let get = |k: &str| item.get(k).and_then(Value::as_str).unwrap_or_default();
    Some(match item.get("type").and_then(Value::as_str)? {
        "agentMessage" => item.get("text").and_then(Value::as_str)?.to_string(),
        "commandExecution" => {
            let exit = item.get("exitCode").and_then(Value::as_i64);
            let status = get("status");
            let tail = match exit {
                Some(0) => " (ok)".to_string(),
                Some(code) => format!(" (exit {code})"),
                None if !status.is_empty() => format!(" ({status})"),
                None => String::new(),
            };
            format!("$ {}{}", brief(get("command"), 200), tail)
        }
        "fileChange" => {
            let files: Vec<String> = item.get("changes").and_then(Value::as_array)
                .map(|cs| cs.iter()
                    .filter_map(|c| c.get("path").and_then(Value::as_str))
                    .map(|p| p.rsplit('/').next().unwrap_or(p).to_string())
                    .collect())
                .unwrap_or_default();
            let n = files.len();
            if files.is_empty() {
                "edited files".to_string()
            } else {
                format!("edited {} file{}: {}", n, if n == 1 { "" } else { "s" }, brief(&files.join(", "), 200))
            }
        }
        "mcpToolCall" => format!("tool {}::{} ({})", get("server"), get("tool"), get("status")),
        "dynamicToolCall" => format!("tool {} ({})", get("tool"), get("status")),
        "webSearch" => format!("searched: {}", brief(get("query"), 160)),
        "imageGeneration" => format!("generated an image ({})", get("status")),
        "imageView" => format!("viewed image {}", brief(get("path"), 160)),
        "plan" => format!("plan: {}", brief(get("text"), 400)),
        // Deliberately not surfaced as room content: reasoning is the model's private scratchpad,
        // userMessage is the message we ourselves just sent, and the rest are UI-only lifecycle
        // markers. Returning None drops them rather than filling the room with noise.
        _ => return None,
    })
}

/// One-line description of a Guardian-reviewed action, per `GuardianApprovalReviewAction`'s real
/// variants (command | execve | applyPatch | networkAccess | mcpToolCall | requestPermissions).
fn summarize_approval_action(action: &Value) -> String {
    let get = |k: &str| action.get(k).and_then(Value::as_str).unwrap_or_default();
    match action.get("type").and_then(Value::as_str).unwrap_or("unknown") {
        "command" => format!("run: {}", brief(get("command"), 300)),
        "execve" => {
            let argv: Vec<&str> = action.get("argv").and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            format!("exec: {} {}", get("program"), brief(&argv.join(" "), 260))
        }
        "applyPatch" => {
            let n = action.get("files").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
            format!("patch {} file{}", n, if n == 1 { "" } else { "s" })
        }
        "networkAccess" => format!(
            "network: {}://{}:{}",
            get("protocol"), get("host"),
            action.get("port").and_then(Value::as_u64).unwrap_or(0),
        ),
        "mcpToolCall" => format!("mcp tool: {}::{}", get("server"), get("toolName")),
        "requestPermissions" => {
            let reason = get("reason");
            if reason.is_empty() {
                "requests additional permissions".to_string()
            } else {
                format!("requests additional permissions: {}", brief(reason, 240))
            }
        }
        other => format!("{other} action"),
    }
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
        let mut item_type = None;
        let (thread_id, turn_id, status, body, approval) = match method {
            "turn/started" => {
                let thread_id = params.get("threadId").and_then(Value::as_str)?.to_string();
                let turn = params.get("turn")?;
                let turn_id = turn.get("id").and_then(Value::as_str).map(str::to_string);
                (thread_id, turn_id, CodexTurnStatus::Running, String::new(), None)
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
                (thread_id, turn_id, status, String::new(), None)
            }
            "item/completed" => {
                let item = params.get("item")?;
                let thread_id = params.get("threadId").and_then(Value::as_str)?.to_string();
                let turn_id = params.get("turnId").and_then(Value::as_str).map(str::to_string);
                let body = summarize_item(item)?;
                item_type = item.get("type").and_then(Value::as_str).map(str::to_string);
                (thread_id, turn_id, CodexTurnStatus::Running, body, None)
            }
            "item/autoApprovalReview/started" | "item/autoApprovalReview/completed" => {
                let thread_id = params.get("threadId").and_then(Value::as_str)?.to_string();
                let turn_id = params.get("turnId").and_then(Value::as_str).map(str::to_string);
                let review = params.get("review")?;
                let review_status = review.get("status").and_then(Value::as_str)
                    .unwrap_or("inProgress").to_string();
                let action = params.get("action")?;
                let approval = CodexApproval {
                    review_id: params.get("reviewId").and_then(Value::as_str)
                        .unwrap_or_default().to_string(),
                    action_type: action.get("type").and_then(Value::as_str)
                        .unwrap_or("unknown").to_string(),
                    summary: summarize_approval_action(action),
                    status: review_status.clone(),
                    risk_level: review.get("riskLevel").and_then(Value::as_str).map(str::to_string),
                    rationale: review.get("rationale").and_then(Value::as_str).map(str::to_string),
                    raw_event: params.clone(),
                };
                // Only a DENIED action is actually blocked pending a human — that is the one
                // state Roundtable must surface as an approval. Everything else is informational.
                let status = if review_status == "denied" {
                    CodexTurnStatus::WaitingApproval
                } else {
                    CodexTurnStatus::Running
                };
                (thread_id, turn_id, status, String::new(), Some(approval))
            }
            _ => return None,
        };
        let seat_id = seats.lock().await.values()
            .find(|s| s.thread_id == thread_id).map(|s| s.seat_id)?;
        Some(CodexEvent {
            seat_id, thread_id, turn_id, status, body,
            kind: method.to_string(),
            provider_request_id: None,
            item_type,
            approval,
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
            // `thread/start` is CONFIGURATION ONLY — no input, and it starts no turn. Its
            // response is `{thread: Thread}`, so the id is `thread.id`, never a top-level
            // `threadId`. Both facts verified against the real schema; the previous code sent an
            // `input` the params have no field for and then read a `threadId` that is never there.
            CodexCommand::CreateThread { cwd } => {
                let mut params = serde_json::Map::new();
                if let Some(cwd) = &cwd {
                    params.insert("cwd".into(), Value::String(cwd.clone()));
                }
                let result = self.call("thread/start", Value::Object(params)).await?;
                let thread_id = result.get("thread").and_then(|t| t.get("id"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| NodeError::Provider(
                        "thread/start response had no thread.id".into(),
                    ))?;
                self.seats.lock().await.insert(seat_id, SeatState {
                    seat_id, thread_id: thread_id.to_string(), cwd,
                    model: String::new(), active_turn_id: None, last_progress_ms: 0,
                });
                Ok(result)
            }
            CodexCommand::ResumeThread { thread_id } => {
                let result = self.call("thread/resume", serde_json::json!({"threadId": thread_id})).await?;
                self.upsert_seat_thread(seat_id, &thread_id).await;
                Ok(result)
            }
            // Response is `{turn: Turn}` — the id is `turn.id`, not a top-level `turnId`.
            CodexCommand::StartTurn { thread_id, input } => {
                let result = self.call(
                    "turn/start", serde_json::json!({"threadId": thread_id, "input": text_input(&input)}),
                ).await?;
                self.upsert_seat_thread(seat_id, &thread_id).await;
                if let Some(turn_id) = result.get("turn").and_then(|t| t.get("id")).and_then(Value::as_str) {
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
                let result = self.call("turn/interrupt", serde_json::json!({"threadId": thread_id})).await?;
                // The turn is over; a later delivery for this seat must start a fresh turn rather
                // than try to steer the one just interrupted.
                self.set_active_turn(seat_id, None).await;
                Ok(result)
            }
            CodexCommand::ApproveGuardianDeniedAction { thread_id, event } => {
                self.call("thread/approveGuardianDeniedAction", serde_json::json!({
                    "threadId": thread_id, "event": event,
                })).await
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

    /// Proves the real two-call round trip end-to-end against a real child process: `thread/start`
    /// creates a thread and starts NOTHING, then `turn/start` runs a turn whose notifications come
    /// back out the subscribe() channel routed to the correct seat_id — the exact path a
    /// DeliveryAssign handler takes.
    ///
    /// This also documents the death of a race the previous version of this test asserted on. When
    /// `thread/start` was (wrongly) believed to take `input` and start a turn, its `turn/started`
    /// notification could arrive before the response carrying the thread id, so the seat mapping
    /// did not exist yet and the event was dropped. The real protocol has no such window:
    /// `thread/start` emits no turn notifications at all, so by the time `turn/start` is sent the
    /// mapping is already in place and `turn/started` is delivered like everything else.
    #[tokio::test]
    async fn create_thread_then_turn_round_trips_and_routes_events_to_the_seat() {
        let mut adapter = fixture_adapter();
        let mut events = adapter.subscribe().await;
        adapter.connect().await.unwrap();

        let seat_id = Uuid::now_v7();
        let result = adapter.execute(seat_id, CodexCommand::CreateThread { cwd: None })
            .await.expect("thread/start must succeed against the fixture");
        let thread_id = result.get("thread").and_then(|t| t.get("id")).and_then(Value::as_str)
            .expect("thread/start returns {thread: {id}}").to_string();

        let seat = adapter.seat(seat_id).await.expect("execute() must register the seat");
        assert_eq!(seat.thread_id, thread_id);

        // thread/start starts no turn, so nothing has been emitted yet.
        assert!(
            timeout(Duration::from_millis(150), events.recv()).await.is_err(),
            "thread/start must not produce any turn notification",
        );

        adapter.execute(seat_id, CodexCommand::StartTurn {
            thread_id: thread_id.clone(), input: "hello".into(),
        }).await.expect("turn/start must succeed");

        // No race now: turn/started arrives after the mapping already exists, so it is delivered.
        let first = timeout(Duration::from_secs(2), events.recv()).await
            .expect("must not time out").expect("channel must not close");
        assert_eq!(first.seat_id, seat_id);
        assert_eq!(first.thread_id, thread_id);
        assert_eq!(first.kind, "turn/started");
        assert_eq!(first.status, CodexTurnStatus::Running);

        let second = timeout(Duration::from_secs(2), events.recv()).await
            .expect("must not time out").expect("channel must not close");
        assert_eq!(second.kind, "item/completed");
        assert_eq!(second.item_type.as_deref(), Some("agentMessage"));
        assert_eq!(second.body, "echo: hello", "must carry the real agentMessage text");

        let third = timeout(Duration::from_secs(2), events.recv()).await
            .expect("must not time out").expect("channel must not close");
        assert_eq!(third.kind, "turn/completed");
        assert_eq!(third.status, CodexTurnStatus::Completed);

        adapter.shutdown().await.unwrap();
    }

    /// The Guardian approval path: a denied action surfaces as a `WaitingApproval` event carrying
    /// a `CodexApproval`, and the raw event it carries can be replayed to
    /// `thread/approveGuardianDeniedAction` as a human override.
    #[tokio::test]
    async fn a_denied_guardian_action_surfaces_as_an_approval() {
        let mut adapter = fixture_adapter();
        let mut events = adapter.subscribe().await;
        adapter.connect().await.unwrap();

        let seat_id = Uuid::now_v7();
        let result = adapter.execute(seat_id, CodexCommand::CreateThread { cwd: None }).await.unwrap();
        let thread_id = result.get("thread").and_then(|t| t.get("id"))
            .and_then(Value::as_str).unwrap().to_string();
        adapter.execute(seat_id, CodexCommand::StartTurn {
            thread_id: thread_id.clone(), input: "please @@deny@@ this".into(),
        }).await.unwrap();

        // turn/started, then the denied review.
        let mut approval = None;
        for _ in 0..4 {
            let ev = timeout(Duration::from_secs(2), events.recv()).await
                .expect("must not time out").expect("channel must not close");
            if let Some(a) = ev.approval {
                assert_eq!(ev.status, CodexTurnStatus::WaitingApproval);
                approval = Some(a);
                break;
            }
        }
        let approval = approval.expect("a denied guardian review must produce an approval event");
        assert_eq!(approval.status, "denied");
        assert_eq!(approval.action_type, "command");
        assert_eq!(approval.summary, "run: rm -rf /tmp/x");
        assert_eq!(approval.risk_level.as_deref(), Some("high"));

        // The override replays the raw event verbatim — the fixture accepts it.
        adapter.execute(seat_id, CodexCommand::ApproveGuardianDeniedAction {
            thread_id, event: approval.raw_event,
        }).await.expect("approving a denied action must succeed");

        adapter.shutdown().await.unwrap();
    }

    /// The fixture returns a JSON-RPC error for any method it does not implement — this proves
    /// `call()` surfaces that as an `Err` with the App Server's own message, not a silent Ok or a
    /// panic. `thread/list` is a real App Server method; it is simply not in this fixture.
    #[tokio::test]
    async fn an_unimplemented_method_surfaces_as_a_real_error() {
        let mut adapter = fixture_adapter();
        adapter.connect().await.unwrap();
        let err = adapter.execute(Uuid::now_v7(), CodexCommand::ListThreads)
            .await.expect_err("the fixture does not implement thread/list");
        assert!(
            err.to_string().contains("thread/list"),
            "error should name the method that failed: {err}",
        );
        adapter.shutdown().await.unwrap();
    }

    /// Resuming an existing thread binds it to the seat, so a delivery for a seat whose thread
    /// already exists starts a turn on that thread rather than creating a second one.
    #[tokio::test]
    async fn resume_thread_binds_the_existing_thread_to_the_seat() {
        let mut adapter = fixture_adapter();
        adapter.connect().await.unwrap();
        let seat_id = Uuid::now_v7();
        adapter.execute(seat_id, CodexCommand::ResumeThread { thread_id: "thr-1".into() })
            .await.expect("thread/resume must succeed against the fixture");
        let seat = adapter.seat(seat_id).await.expect("resume must register the seat");
        assert_eq!(seat.thread_id, "thr-1");
        assert!(seat.active_turn_id.is_none(), "resuming does not start a turn");
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
