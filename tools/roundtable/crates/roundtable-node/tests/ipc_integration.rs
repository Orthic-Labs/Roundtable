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

/// Drives the REAL `IpcServer` — not a hand-rolled stand-in like the tests above.
///
/// Covers the two halves that were both missing until Claude seats were wired: a server-initiated
/// `delivery.assign` actually reaching a connected channel (the notification receiver used to be
/// created and then never read), and a request actually reaching a handler (every method used to
/// return canned success — `message.reply` answered `{"posted": true}` having posted nothing).
#[tokio::test]
async fn real_ipc_server_delivers_notifications_and_routes_requests() {
    use roundtable_node::ipc::{IpcNotification, IpcRequest, IpcResponse, IpcServer};
    use std::sync::Arc;

    let path = tmp_path("real");
    let server = Arc::new(IpcServer::new(path.clone()));

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    server.set_request_handler(tx).await;
    if server.start().await.is_err() {
        eprintln!("skipping: sandbox refused the unix socket");
        return;
    }

    // Stand-in for main.rs's handler loop.
    tokio::spawn(async move {
        while let Some((req, respond)) = rx.recv().await {
            let resp = match req {
                IpcRequest::MessageReply { body, .. } => IpcResponse::ok(
                    Uuid::now_v7(), serde_json::json!({ "echoed": body }),
                ),
                _ => IpcResponse::err(Uuid::now_v7(), "not implemented"),
            };
            let _ = respond.send(resp);
        }
    });

    let stream = UnixStream::connect(&path).await.expect("connect to the real server");
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);

    // 1. A notification must actually arrive.
    let seat_id = Uuid::now_v7();
    server.notify(seat_id, IpcNotification::DeliveryAssign {
        delivery_id: Uuid::now_v7(),
        room_id: Uuid::now_v7(),
        body: "please look at this".into(),
    }).await;

    let mut line = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(2), reader.read_line(&mut line))
        .await.expect("notification must arrive").expect("read ok");
    let notif: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(notif["seat_id"].as_str().unwrap(), seat_id.to_string());
    assert_eq!(notif["notification"]["type"], "delivery_assign");
    assert_eq!(notif["notification"]["body"], "please look at this");

    // 2. A request must reach the handler and return ITS answer, not a canned one.
    let req = serde_json::json!({
        "method": "message_reply",
        "seat_id": Uuid::now_v7(), "delivery_id": Uuid::now_v7(),
        "body": "on it", "kind": "chat",
    });
    write.write_all(serde_json::to_vec(&req).unwrap().as_slice()).await.unwrap();
    write.write_all(b"\n").await.unwrap();

    line.clear();
    tokio::time::timeout(std::time::Duration::from_secs(2), reader.read_line(&mut line))
        .await.expect("response must arrive").expect("read ok");
    let resp: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(resp["ok"], true);
    assert_eq!(resp["payload"]["echoed"], "on it", "the handler's answer must be what comes back");

    server.stop().await.unwrap();
}

/// With no handler installed, a request is REFUSED rather than answered with a fake success.
#[tokio::test]
async fn real_ipc_server_refuses_requests_when_no_handler_is_installed() {
    use roundtable_node::ipc::IpcServer;

    let path = tmp_path("nohandler");
    let server = IpcServer::new(path.clone());
    if server.start().await.is_err() {
        eprintln!("skipping: sandbox refused the unix socket");
        return;
    }

    let stream = UnixStream::connect(&path).await.unwrap();
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let req = serde_json::json!({
        "method": "message_reply",
        "seat_id": Uuid::now_v7(), "delivery_id": Uuid::now_v7(),
        "body": "hello", "kind": "chat",
    });
    write.write_all(serde_json::to_vec(&req).unwrap().as_slice()).await.unwrap();
    write.write_all(b"\n").await.unwrap();

    let mut line = String::new();
    tokio::time::timeout(std::time::Duration::from_secs(2), reader.read_line(&mut line))
        .await.expect("must answer").expect("read ok");
    let resp: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(resp["ok"], false, "a no-op must never report success");
    assert!(resp["error"].as_str().unwrap().contains("no request handler"));

    server.stop().await.unwrap();
}
