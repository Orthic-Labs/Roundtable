//! Local IPC server - NDJSON over Unix socket (macOS/Linux) or named pipe (Windows).
//!
//! Methods: session.join, session.leave, transcript.read, transcript.search,
//! message.reply, handoff.create, approval.verdict.
//! Server notifications: delivery.assign, approval.request.
//!
//! Authentication is enforced by socket mode (0600 on Unix, owner-only ACL on
//! Windows). The IPC layer is intentionally owner-only - it is never exposed
//! over the network.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixListener;
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, info, warn};
use uuid::Uuid;

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::ptr;
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
#[cfg(windows)]
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, TOKEN_QUERY,
    TOKEN_USER, SECURITY_ATTRIBUTES,
};
#[cfg(windows)]
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    SDDL_REVISION_1,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::NodeResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum IpcRequest {
    SessionJoin {
        provider: String,
        session_ref: String,
        alias: String,
        room_id: Uuid,
    },
    SessionLeave { seat_id: Uuid },
    TranscriptRead {
        room_id: Uuid,
        after_seq: Option<i64>,
        before_seq: Option<i64>,
        limit: i64,
    },
    TranscriptSearch { room_id: Uuid, query: String, limit: i64 },
    MessageReply {
        seat_id: Uuid,
        delivery_id: Uuid,
        body: String,
        kind: String,
    },
    HandoffCreate {
        from_seat_id: Uuid,
        to_alias: String,
        body: String,
        evidence_refs: Vec<String>,
    },
    ApprovalVerdict { approval_id: Uuid, decision: String },
    Ping { nonce: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcResponse {
    pub request_id: Uuid,
    pub ok: bool,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl IpcResponse {
    pub fn ok(request_id: Uuid, payload: Value) -> Self {
        Self { request_id, ok: true, payload, error: None }
    }
    pub fn err(request_id: Uuid, msg: impl Into<String>) -> Self {
        Self { request_id, ok: false, payload: Value::Null, error: Some(msg.into()) }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcNotification {
    DeliveryAssign { delivery_id: Uuid, room_id: Uuid, body: String },
    ApprovalRequest { approval_id: Uuid, seat_id: Uuid, description: String },
}

pub type IpcNotificationTx = mpsc::UnboundedSender<(Uuid, IpcNotification)>;

/// A request from a connected channel, paired with the channel to answer on.
///
/// The IPC server does not know what a room or a hub is — `main.rs` owns that. Requests are
/// handed out on this channel and answered asynchronously, the same shape `ClientCommand` uses
/// for the hub. Before this existed every handler returned a canned success: `message.reply`
/// answered `{"posted": true}` having posted nothing at all.
pub type IpcRequestTx = mpsc::UnboundedSender<(IpcRequest, tokio::sync::oneshot::Sender<IpcResponse>)>;

pub struct IpcServer {
    socket_path: PathBuf,
    notify_tx: Arc<Mutex<Option<IpcNotificationTx>>>,
    request_tx: Arc<Mutex<Option<IpcRequestTx>>>,
    listener_task: Mutex<Option<tokio::task::JoinHandle<NodeResult<()>>>>,
}

impl IpcServer {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path,
            notify_tx: Arc::new(Mutex::new(None)),
            request_tx: Arc::new(Mutex::new(None)),
            listener_task: Mutex::new(None),
        }
    }

    /// Route incoming requests to `tx` instead of answering them with canned success. Call before
    /// `start()`; without it the server still runs but every request is refused, which is at least
    /// honest about doing nothing.
    pub async fn set_request_handler(&self, tx: IpcRequestTx) {
        *self.request_tx.lock().await = Some(tx);
    }

    pub async fn start(&self) -> NodeResult<()> {
        let (tx, rx) = mpsc::unbounded_channel::<(Uuid, IpcNotification)>();
        let rx = Arc::new(Mutex::new(rx));
        let request_tx = self.request_tx.lock().await.clone();
        // Bind before publishing anything: a bind or permissions failure has to surface out of
        // `start()` itself rather than out of a detached task nobody awaits. `unix_socket_owner_only`
        // depends on that, and so does the caller deciding the node cannot serve.
        let task = self.spawn_listener(rx, request_tx)?;
        *self.notify_tx.lock().await = Some(tx);
        *self.listener_task.lock().await = Some(task);
        info!(path = %self.socket_path.display(), "ipc server started");
        Ok(())
    }

    /// Bind the platform's local transport and serve every connection it yields.
    ///
    /// This is the ONLY place the two platforms differ. Unix binds a single `UnixListener` and
    /// accepts in a loop. Windows has to create one named-pipe instance per client and create the
    /// next instance before serving the current one, so its loop body is a different shape — but
    /// everything downstream (`handle_connection`) is transport-generic and shared verbatim.
    #[cfg(unix)]
    fn spawn_listener(
        &self,
        rx: Arc<Mutex<mpsc::UnboundedReceiver<(Uuid, IpcNotification)>>>,
        request_tx: Option<IpcRequestTx>,
    ) -> NodeResult<tokio::task::JoinHandle<NodeResult<()>>> {
        // A socket file left behind by an unclean exit makes `bind` fail with EADDRINUSE.
        if self.socket_path.exists() {
            std::fs::remove_file(&self.socket_path)?;
        }
        let listener = UnixListener::bind(&self.socket_path)?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.socket_path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        let rx = rx.clone();
                        let request_tx = request_tx.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(stream, rx, request_tx).await {
                                warn!(error = %e, "ipc connection failed");
                            }
                        });
                    }
                    Err(e) => {
                        warn!(error = %e, "ipc accept failed");
                        break;
                    }
                }
            }
            Ok(())
        }))
    }

    #[cfg(windows)]
    fn spawn_listener(
        &self,
        rx: Arc<Mutex<mpsc::UnboundedReceiver<(Uuid, IpcNotification)>>>,
        request_tx: Option<IpcRequestTx>,
    ) -> NodeResult<tokio::task::JoinHandle<NodeResult<()>>> {
        let path = self.socket_path.to_string_lossy().into_owned();
        let mut next = create_owner_only_pipe(&path, true)?;
        Ok(tokio::spawn(async move {
            loop {
                next.connect().await?;
                // Keep an accepting instance live before the current connection is served.
                let stream = next;
                next = create_owner_only_pipe(&path, false)?;
                let rx = rx.clone();
                let request_tx = request_tx.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream, rx, request_tx).await {
                        warn!(error = %e, "ipc connection failed");
                    }
                });
            }
        }))
    }

    pub async fn notify(&self, seat_id: Uuid, notif: IpcNotification) {
        if let Some(tx) = self.notify_tx.lock().await.as_ref() {
            let _ = tx.send((seat_id, notif));
        }
    }

    pub async fn stop(&self) -> NodeResult<()> {
        if let Some(task) = self.listener_task.lock().await.take() {
            task.abort();
        }
        // Unix only: the socket is a real filesystem entry and leaks if it is not unlinked. A
        // Windows pipe name is not a file — it disappears with its last instance handle, and
        // `remove_file` on `\\.\pipe\...` would only ever be an error.
        #[cfg(unix)]
        if self.socket_path.exists() {
            std::fs::remove_file(&self.socket_path)?;
        }
        Ok(())
    }
}

#[cfg(windows)]
fn create_owner_only_pipe(path: &str, first_instance: bool) -> std::io::Result<NamedPipeServer> {
    let (mut attributes, descriptor) = owner_only_security_attributes()?;
    let mut options = ServerOptions::new();
    options.first_pipe_instance(first_instance);
    let result = unsafe {
        options.create_with_security_attributes_raw(path, &mut attributes as *mut _ as *mut c_void)
    };
    unsafe { LocalFree(descriptor); }
    result
}

#[cfg(windows)]
fn owner_only_security_attributes() -> std::io::Result<(SECURITY_ATTRIBUTES, *mut c_void)> {
    unsafe {
        let sddl: Vec<u16> = owner_only_sddl()?.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, ptr::null_mut(),
        ) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok((SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        }, descriptor))
    }
}

#[cfg(windows)]
fn owner_only_sddl() -> std::io::Result<String> {
    Ok(format!("D:P(A;;GA;;;{})", current_user_sid()?))
}

#[cfg(windows)]
fn current_user_sid() -> std::io::Result<String> {
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let result = (|| {
            let mut size = 0;
            let _ = GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
            if size == 0 { return Err(std::io::Error::last_os_error()); }
            let mut bytes = vec![0u8; size as usize];
            if GetTokenInformation(token, TokenUser, bytes.as_mut_ptr() as *mut c_void, size, &mut size) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let user = &*(bytes.as_ptr() as *const TOKEN_USER);
            let mut sid = ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let sid_text = wide_c_string(sid);
            LocalFree(sid as *mut c_void);
            Ok(sid_text)
        })();
        let _ = CloseHandle(token);
        result
    }
}

#[cfg(windows)]
unsafe fn wide_c_string(value: *const u16) -> String {
    let mut length = 0;
    while *value.add(length) != 0 { length += 1; }
    String::from_utf16_lossy(std::slice::from_raw_parts(value, length))
}

/// One connected channel (the `packages/claude-channel` MCP server).
///
/// Reads requests AND writes server-initiated notifications on the same socket, concurrently.
/// Both directions matter: a Claude seat learns about a delivery only via `delivery.assign`, and
/// the notification receiver was previously accepted and then never read, so no notification ever
/// reached anyone.
///
/// `Ping` is answered locally — it is a liveness probe for this socket, not something the hub
/// needs to see.
/// Generic over the transport on purpose: a `UnixStream` on macOS/Linux and a `NamedPipeServer`
/// on Windows both satisfy these bounds, and neither appears by name below. `tokio::io::split`
/// rather than `UnixStream::into_split` is what makes that possible — named pipes have no
/// `into_split`, and `split` needs only `AsyncRead + AsyncWrite`.
async fn handle_connection<S>(
    stream: S,
    rx: Arc<Mutex<mpsc::UnboundedReceiver<(Uuid, IpcNotification)>>>,
    request_tx: Option<IpcRequestTx>,
) -> NodeResult<()>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (read, mut write) = tokio::io::split(stream);
    let mut reader = BufReader::new(read);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        tokio::select! {
            // Server -> channel. Held only while a notification is pending, so a single connection
            // does not starve reads.
            notif = async { rx.lock().await.recv().await } => {
                let Some((seat_id, notif)) = notif else { break };
                let frame = serde_json::json!({ "seat_id": seat_id, "notification": notif });
                let bytes = serde_json::to_vec(&frame)?;
                write.write_all(&bytes).await?;
                write.write_all(b"\n").await?;
                write.flush().await?;
                debug!(%seat_id, "ipc notification delivered");
            }
            // Channel -> server.
            read = reader.read_until(b'\n', &mut buf) => {
                let n = read?;
                if n == 0 { break; }
                while matches!(buf.last(), Some(b'\n')) { buf.pop(); }
                let req: IpcRequest = match serde_json::from_slice(&buf) {
                    Ok(r) => r,
                    Err(e) => {
                        let resp = IpcResponse::err(Uuid::nil(), format!("bad request: {e}"));
                        let bytes = serde_json::to_vec(&resp)?;
                        write.write_all(&bytes).await?;
                        write.write_all(b"\n").await?;
                        write.flush().await?;
                        continue;
                    }
                };
                let request_id = Uuid::now_v7();
                let resp = match req {
                    IpcRequest::Ping { nonce } => IpcResponse::ok(request_id, serde_json::json!({"pong": nonce})),
                    other => match &request_tx {
                        Some(tx) => {
                            let (respond, wait) = tokio::sync::oneshot::channel();
                            if tx.send((other, respond)).is_err() {
                                IpcResponse::err(request_id, "node is shutting down")
                            } else {
                                match wait.await {
                                    Ok(mut r) => { r.request_id = request_id; r }
                                    Err(_) => IpcResponse::err(request_id, "handler dropped the request"),
                                }
                            }
                        }
                        // Refusing beats the old behaviour of claiming success for work never done.
                        None => IpcResponse::err(request_id, "no request handler is installed on this node"),
                    },
                };
                let bytes = serde_json::to_vec(&resp)?;
                write.write_all(&bytes).await?;
                write.write_all(b"\n").await?;
                write.flush().await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_methods_serialize_with_snake_case_tag() {
        let req = IpcRequest::Ping { nonce: "x".into() };
        let bytes = serde_json::to_vec(&req).unwrap();
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.contains("\"method\":\"ping\""), "unexpected: {}", s);
    }

    #[test]
    fn response_round_trips() {
        let r = IpcResponse::ok(Uuid::now_v7(), serde_json::json!({"a": 1}));
        let bytes = serde_json::to_vec(&r).unwrap();
        let back: IpcResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(back.ok);
        assert_eq!(back.payload["a"], 1);
    }

    #[test]
    fn error_response_carries_message() {
        let r = IpcResponse::err(Uuid::now_v7(), "bad");
        let bytes = serde_json::to_vec(&r).unwrap();
        let back: IpcResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(!back.ok);
        assert_eq!(back.error.as_deref(), Some("bad"));
    }

    #[tokio::test]
    async fn unix_socket_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ipc.sock");
        let server = IpcServer::new(path.clone());
        // Sandbox (CI without CAP_FOWNER) refuses chmod; the real production path always has it.
        if server.start().await.is_err() {
            eprintln!("skipping unix_socket_owner_only: chmod 0o600 denied in this environment");
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::metadata(&path).unwrap();
            assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        }
        server.stop().await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_pipe_dacl_is_protected_and_owner_only() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
        use windows_sys::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo,
            SE_KERNEL_OBJECT,
        };

        let path = format!(r"\\.\pipe\roundtable-dacl-test-{}", Uuid::now_v7());
        let pipe = create_owner_only_pipe(&path, true).expect("owner-only pipe starts");
        // Windows expands the requested GA mask to its canonical file-access form, FA,
        // when serializing a named-pipe DACL. The single protected ACE must still name
        // only the current user.
        let expected = format!("D:P(A;;FA;;;{})", current_user_sid().expect("current user SID"));

        unsafe {
            let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
            let status = GetSecurityInfo(
                pipe.as_raw_handle() as *mut c_void,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut descriptor,
            );
            assert_eq!(status, 0, "read named-pipe DACL");

            let mut dacl_sddl = ptr::null_mut();
            assert_ne!(
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut dacl_sddl,
                    ptr::null_mut(),
                ),
                0,
                "convert named-pipe DACL to SDDL",
            );
            let actual = wide_c_string(dacl_sddl);
            LocalFree(dacl_sddl as *mut c_void);
            LocalFree(descriptor);
            assert_eq!(actual, expected);
        }
    }
}
