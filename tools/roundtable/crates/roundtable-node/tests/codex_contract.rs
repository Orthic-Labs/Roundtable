//! Contract tests for the Codex App-Server protocol: spawn fake-codex fixture,
//! speak JSON-RPC 2.0 over stdio via the CodexAdapter, verify request/response framing.

use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

fn fixture_path() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.parent().unwrap().parent().unwrap()
        .join("fixtures").join("app-server").join("fake-codex.mjs")
}

#[tokio::test]
async fn fake_codex_handles_initialize_and_thread_start() {
    let mut child = Command::new("node")
        .arg(fixture_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn().expect("spawn fake-codex");
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    // initialize
    let init = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}});
    stdin.write_all(serde_json::to_vec(&init).unwrap().as_slice()).await.unwrap();
    stdin.write_all(b"\n").await.unwrap();
    let mut buf = String::new();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), reader.read_line(&mut buf)).await.unwrap().unwrap();
    let resp: serde_json::Value = serde_json::from_str(&buf).unwrap();
    assert_eq!(resp["jsonrpc"], "2.0");
    assert_eq!(resp["id"], 1);
    assert_eq!(resp["result"]["serverInfo"]["name"], "fake-codex");
    // thread/start
    buf.clear();
    let ts = serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}});
    stdin.write_all(serde_json::to_vec(&ts).unwrap().as_slice()).await.unwrap();
    stdin.write_all(b"\n").await.unwrap();
    let mut saw_turn_started = false;
    let mut saw_thread_result = false;
    for _ in 0..3 {
        buf.clear();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), reader.read_line(&mut buf)).await.unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&buf).unwrap();
        if v["method"] == "turn/started" { saw_turn_started = true; }
        if v["id"] == 2 && v["result"]["threadId"].is_string() { saw_thread_result = true; }
    }
    assert!(saw_turn_started);
    assert!(saw_thread_result);
    let _ = child.kill().await;
}
