#![cfg(windows)]

use citadel_node::ipc::IpcServer;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;
use uuid::Uuid;

#[tokio::test]
async fn named_pipe_responds_to_ping() {
    let path = format!(r"\\.\pipe\roundtable-test-{}", Uuid::now_v7());
    let server = IpcServer::new(path.clone().into());
    server.start().await.expect("owner-only named pipe starts");

    let client = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if let Ok(client) = ClientOptions::new().open(&path) { return client; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("client connects to named pipe");
    let (read, mut write) = tokio::io::split(client);
    let mut reader = BufReader::new(read);
    write.write_all(br#"{"method":"ping","nonce":"windows"}"#).await.unwrap();
    write.write_all(b"\n").await.unwrap();
    let mut line = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(2), reader.read_line(&mut line))
        .await.expect("ping response arrives").unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&line).unwrap()["payload"]["pong"], "windows");
    server.stop().await.unwrap();
}
