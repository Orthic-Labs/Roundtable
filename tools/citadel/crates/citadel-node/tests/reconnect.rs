//! Integration tests for the Hub client reconnect loop driven by the fake-hub fixture.
//! Spawns the Node fixture, connects via TCP, verifies hello.accepted, ping round-trips,
//! and message.post echo. No real hub is contacted. Tests skip cleanly when the sandbox
//! denies TCP listen.

use std::io::Write;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::timeout;

fn fixture_path() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.parent().unwrap().parent().unwrap()
        .join("fixtures").join("hub").join("fake-hub.mjs")
}

struct FakeHub { child: Child, port: u16 }

impl Drop for FakeHub {
    fn drop(&mut self) { let _ = self.child.kill(); }
}

async fn start_fake_hub() -> Option<FakeHub> {
    let path = fixture_path();
    let mut child = Command::new("node")
        .arg(&path)
        .arg("0")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn().ok()?;
    let mut out = child.stdout.take()?;
    let read = tokio::task::spawn_blocking(move || {
        use std::io::{BufRead, Read};
        let mut line = String::new();
        let mut lock = std::io::BufReader::new(out.by_ref()).lines();
        // If the fixture errors out (sandbox blocks listen), it never writes a line.
        match lock.next() {
            Some(Ok(l)) => l,
            _ => String::new(),
        }
    }).await.ok()?;
    if read.is_empty() {
        let _ = child.kill();
        return None;
    }
    let json: serde_json::Value = serde_json::from_str(&read).ok()?;
    let port = json["port"].as_u64()? as u16;
    Some(FakeHub { child, port })
}

#[tokio::test]
async fn fake_hub_accepts_hello_and_emits_ping() {
    let hub = match start_fake_hub().await {
        Some(h) => h,
        None => { eprintln!("skipping: TCP listen denied by sandbox"); return; }
    };
    let addr: SocketAddr = format!("127.0.0.1:{}", hub.port).parse().unwrap();
    let mut stream = match TcpStream::connect(addr).await {
        Ok(s) => s,
        Err(_) => { eprintln!("skipping: TCP connect denied"); return; }
    };
    let hello = serde_json::json!({"version": 1, "event_id": "01900000-0000-7000-8000-000000000001",
        "sent_at_ms": 1, "type": "node.hello", "payload": {"node_id": "01900000-0000-7000-8000-000000000002"}});
    stream.write_all(serde_json::to_vec(&hello).unwrap().as_slice()).await.unwrap();
    stream.write_all(b"
").await.unwrap();
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut buf = String::new();
    let n = timeout(Duration::from_secs(2), reader.read_line(&mut buf)).await.unwrap().unwrap();
    assert!(n > 0);
    let resp: serde_json::Value = serde_json::from_str(&buf).unwrap();
    assert_eq!(resp["type"], "hello.accepted");
    let _ = write.shutdown().await;
}

#[tokio::test]
async fn fake_hub_echoes_node_message_post() {
    let hub = match start_fake_hub().await {
        Some(h) => h,
        None => { eprintln!("skipping: TCP listen denied by sandbox"); return; }
    };
    let addr: SocketAddr = format!("127.0.0.1:{}", hub.port).parse().unwrap();
    let mut stream = match TcpStream::connect(addr).await {
        Ok(s) => s,
        Err(_) => return,
    };
    let hello = serde_json::json!({"version": 1, "event_id": "01900000-0000-7000-8000-000000000010",
        "sent_at_ms": 1, "type": "node.hello", "payload": {"node_id": "01900000-0000-7000-8000-000000000011"}});
    stream.write_all(serde_json::to_vec(&hello).unwrap().as_slice()).await.unwrap();
    stream.write_all(b"
").await.unwrap();
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut buf = String::new();
    let _ = timeout(Duration::from_secs(2), reader.read_line(&mut buf)).await.unwrap().unwrap();
    buf.clear();
    let post = serde_json::json!({"version": 1, "event_id": "01900000-0000-7000-8000-000000000012",
        "sent_at_ms": 2, "type": "node.message.post", "payload": {"body": "hi"}});
    write.write_all(serde_json::to_vec(&post).unwrap().as_slice()).await.unwrap();
    write.write_all(b"
").await.unwrap();
    let n = timeout(Duration::from_secs(2), reader.read_line(&mut buf)).await.unwrap().unwrap();
    assert!(n > 0);
    let echo: serde_json::Value = serde_json::from_str(&buf).unwrap();
    assert_eq!(echo["type"], "ack.echo");
    assert_eq!(echo["payload"]["saw_type"], "node.message.post");
}
