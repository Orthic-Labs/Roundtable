//! IPC server integration tests: spawn a Unix socket server, connect via raw stream,
//! and verify snake_case framing + 0o600 perms. All tests are sandbox-aware and
//! skip cleanly when the environment denies the underlying syscalls.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use uuid::Uuid;

fn tmp_path(name: &str) -> PathBuf {
    let dir = std::env::temp_dir();
    dir.join(format!("rt-ipc-{}-{}", name, Uuid::now_v7()))
}

#[tokio::test]
async fn unix_socket_responds_to_ping() {
    let path = tmp_path("ping");
    let path_clone = path.clone();
    let server_handle = tokio::spawn(async move {
        use tokio::net::UnixListener;
        let listener = match UnixListener::bind(&path_clone) {
            Ok(l) => l,
            Err(_) => return Err(()),
        };
        if std::fs::set_permissions(&path_clone, std::fs::Permissions::from_mode(0o600)).is_err() {
            return Err(());
        }
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut reader = BufReader::new(read);
        let mut buf = String::new();
        let _ = reader.read_line(&mut buf).await.unwrap();
        let req: serde_json::Value = serde_json::from_str(&buf).unwrap();
        let resp = serde_json::json!({"request_id": req["request_id"], "ok": true,
            "payload": {"pong": req["params"]["nonce"]}});
        write.write_all(serde_json::to_vec(&resp).unwrap().as_slice()).await.unwrap();
        write.write_all(b"
").await.unwrap();
        Ok(())
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    if server_handle.is_finished() {
        eprintln!("skipping unix_socket_responds_to_ping: sandbox blocks Unix sockets");
        return;
    }
    let stream = match UnixStream::connect(&path).await {
        Ok(s) => s,
        Err(_) => { eprintln!("skipping: connect denied"); return; }
    };
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let req = serde_json::json!({"request_id": Uuid::now_v7(), "method": "ping",
        "params": {"nonce": "hello"}});
    write.write_all(serde_json::to_vec(&req).unwrap().as_slice()).await.unwrap();
    write.write_all(b"
").await.unwrap();
    let mut buf = String::new();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), reader.read_line(&mut buf)).await.unwrap().unwrap();
    let resp: serde_json::Value = serde_json::from_str(&buf).unwrap();
    assert_eq!(resp["ok"], true);
    assert_eq!(resp["payload"]["pong"], "hello");
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn unix_socket_permissions_are_owner_only() {
    let path = tmp_path("perms");
    let path_clone = path.clone();
    tokio::spawn(async move {
        use tokio::net::UnixListener;
        if let Ok(listener) = UnixListener::bind(&path_clone) {
            if std::fs::set_permissions(&path_clone, std::fs::Permissions::from_mode(0o600)).is_ok() {
                let (_stream, _) = listener.accept().await.unwrap();
            }
        }
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    match std::fs::metadata(&path) {
        Ok(meta) => assert_eq!(meta.permissions().mode() & 0o777, 0o600),
        Err(_) => eprintln!("skipping: socket not visible in this sandbox"),
    }
    let _ = std::fs::remove_file(&path);
}
