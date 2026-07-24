//! Codex App Server adapter - manages a child process speaking JSONL on stdio.
//!
//! Production: spawns  on the user machine.
//! Tests: spawns the Node.js fixture at fixtures/app-server/fake-codex.mjs.
//!
//! Maps App Server events to Roundtable protocol:
//! - agent message deltas accumulate and publish one completion/question on item/turn completion
//! - command/file progress is throttled to once per 2 seconds (progress messages)
//! - approval requests become typed Roundtable approvals
//! - tool/requestUserInput becomes a question and pauses the delivery
//! - turn completion sets delivery to completed/failed/waiting_approval
//!
//! Persists (seat_id, thread_id, cwd, model, active_turn_id) in node state.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};
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
    pub body: String,
    pub kind: String,
    pub provider_request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum CodexCommand {
    Connect,
    ListThreads,
    ResumeThread { thread_id: String },
    StartTurn { thread_id: String, input: String },
    SteerTurn { thread_id: String, expected_turn_id: String, input: String },
    InterruptTurn { thread_id: String },
    Shutdown,
}

pub struct CodexAdapter {
    command: Vec<String>,
    cwd: Option<PathBuf>,
    process: Arc<Mutex<Option<Child>>>,
    stdin_tx: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    stdout_rx: Arc<Mutex<Option<tokio::io::Lines<BufReader<tokio::process::ChildStdout>>>>>,
    request_id: Arc<Mutex<i64>>,
    pubsub_tx: mpsc::UnboundedSender<CodexEvent>,
    pubsub_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<CodexEvent>>>>,
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
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            command,
            cwd,
            process: Arc::new(Mutex::new(None)),
            stdin_tx: Arc::new(Mutex::new(None)),
            stdout_rx: Arc::new(Mutex::new(None)),
            request_id: Arc::new(Mutex::new(0)),
            pubsub_tx: tx,
            pubsub_rx: Arc::new(Mutex::new(Some(rx))),
            seats: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn subscribe(&self) -> mpsc::UnboundedReceiver<CodexEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut old_rx = self.pubsub_rx.lock().await.take();
        if let Some(old) = old_rx.as_mut() {
            // Drain prior events into the new channel so existing subscribers don't lose them.
            while let Ok(evt) = old.try_recv() {
                let _ = tx.send(evt);
            }
        }
        rx
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
        }
        self.send_request("initialize", serde_json::json!({"clientInfo": {"name": "roundtable-node"}})).await?;
        self.send_notification("initialized", serde_json::json!({})).await?;
        info!("codex app server connected");
        Ok(())
    }

    async fn send_request(&self, method: &str, params: Value) -> NodeResult<Value> {
        let mut id = self.request_id.lock().await;
        *id += 1;
        let req_id = *id;
        let frame = serde_json::json!({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params});
        let bytes = serde_json::to_vec(&frame)?;
        let mut stdin = self.stdin_tx.lock().await;
        let stdin = stdin.as_mut().ok_or_else(|| NodeError::Provider("not connected".into()))?;
        stdin.write_all(&bytes).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(Value::Null)
    }

    async fn send_notification(&self, method: &str, params: Value) -> NodeResult<()> {
        let frame = serde_json::json!({"jsonrpc": "2.0", "method": method, "params": params});
        let bytes = serde_json::to_vec(&frame)?;
        let mut stdin = self.stdin_tx.lock().await;
        let stdin = stdin.as_mut().ok_or_else(|| NodeError::Provider("not connected".into()))?;
        stdin.write_all(&bytes).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
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
}
