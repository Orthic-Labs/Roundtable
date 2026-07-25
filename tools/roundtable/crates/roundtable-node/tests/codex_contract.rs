//! Contract tests for the Codex App-Server protocol: spawn the fake-codex fixture, speak
//! JSON-RPC 2.0 over stdio directly (no adapter in between), and verify the fixture emits the
//! REAL wire shapes from `fixtures/app-server/schema/`.
//!
//! This file is the fixture's own contract test. It deliberately bypasses `CodexAdapter` so an
//! adapter bug and a fixture bug cannot cancel each other out — which is exactly what happened
//! before the real schema was generated: the adapter read a flat `threadId`/`turnId`, the fixture
//! emitted a flat `threadId`/`turnId`, every test passed, and both were wrong.

use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};

fn fixture_path() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.parent().unwrap().parent().unwrap()
        .join("fixtures").join("app-server").join("fake-codex.mjs")
}

async fn send(stdin: &mut ChildStdin, frame: serde_json::Value) {
    stdin.write_all(serde_json::to_vec(&frame).unwrap().as_slice()).await.unwrap();
    stdin.write_all(b"\n").await.unwrap();
}

async fn next_frame(lines: &mut Lines<BufReader<ChildStdout>>) -> serde_json::Value {
    let line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await.expect("fixture must not stall").unwrap().expect("fixture must not close");
    serde_json::from_str(&line).expect("every fixture frame is valid JSON")
}

#[tokio::test]
async fn fake_codex_speaks_the_real_thread_and_turn_shapes() {
    let mut child = Command::new("node")
        .arg(fixture_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn().expect("spawn fake-codex");
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

    send(&mut stdin, serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}
    })).await;
    let resp = next_frame(&mut lines).await;
    assert_eq!(resp["jsonrpc"], "2.0");
    assert_eq!(resp["id"], 1);
    assert_eq!(resp["result"]["serverInfo"]["name"], "fake-codex");

    // thread/start: config only, returns {thread: {id}}, and starts NO turn.
    send(&mut stdin, serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {"cwd": "/tmp"}
    })).await;
    let resp = next_frame(&mut lines).await;
    assert_eq!(resp["id"], 2);
    assert!(
        resp["result"]["threadId"].is_null(),
        "thread/start must NOT return a flat threadId — the id lives at thread.id",
    );
    let thread_id = resp["result"]["thread"]["id"].as_str()
        .expect("thread/start returns {thread: {id}}").to_string();

    // turn/start: returns {turn: {id}}, then turn/started -> item/completed -> turn/completed.
    send(&mut stdin, serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": "hi"}]}
    })).await;
    let resp = next_frame(&mut lines).await;
    assert_eq!(resp["id"], 3);
    assert!(
        resp["result"]["turnId"].is_null(),
        "turn/start must NOT return a flat turnId — the id lives at turn.id",
    );
    let turn_id = resp["result"]["turn"]["id"].as_str()
        .expect("turn/start returns {turn: {id}}").to_string();

    let started = next_frame(&mut lines).await;
    assert_eq!(started["method"], "turn/started");
    assert_eq!(started["params"]["threadId"], thread_id.as_str());
    assert_eq!(started["params"]["turn"]["id"], turn_id.as_str());
    assert_eq!(started["params"]["turn"]["status"], "inProgress");
    assert!(
        started["params"]["turnId"].is_null(),
        "turn/started nests the turn — there is no flat turnId",
    );

    let item = next_frame(&mut lines).await;
    assert_eq!(item["method"], "item/completed");
    assert_eq!(item["params"]["item"]["type"], "agentMessage");
    assert_eq!(item["params"]["item"]["text"], "echo: hi", "the fixture echoes the text UserInput");

    let completed = next_frame(&mut lines).await;
    assert_eq!(completed["method"], "turn/completed");
    assert_eq!(completed["params"]["turn"]["status"], "completed");

    let _ = child.kill().await;
}

#[tokio::test]
async fn fake_codex_emits_a_denied_guardian_review_on_demand() {
    let mut child = Command::new("node")
        .arg(fixture_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn().expect("spawn fake-codex");
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

    send(&mut stdin, serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}
    })).await;
    next_frame(&mut lines).await;
    send(&mut stdin, serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}
    })).await;
    let thread_id = next_frame(&mut lines).await["result"]["thread"]["id"]
        .as_str().unwrap().to_string();
    send(&mut stdin, serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": "@@deny@@ me"}]}
    })).await;

    let mut review = None;
    for _ in 0..5 {
        let f = next_frame(&mut lines).await;
        if f["method"] == "item/autoApprovalReview/completed" {
            review = Some(f);
            break;
        }
    }
    let review = review.expect("the @@deny@@ hook must produce a denied guardian review");
    assert_eq!(review["params"]["review"]["status"], "denied");
    assert_eq!(review["params"]["action"]["type"], "command");
    assert!(review["params"]["reviewId"].is_string());

    let _ = child.kill().await;
}
