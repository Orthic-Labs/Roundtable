# Citadel on Windows — handoff

Everything below is for whoever brings `citadel-node` up on Adrian's Windows machine. The hub
is already deployed and working; nothing on the server side needs to change. Read `HANDOVER.md`
first for the system as a whole, then this.

**Status: not started.** The Mac node is live and answering. Windows has never been built or run.

Two things are already known-broken and are NOT your fault — read
"Known broken BEFORE you touch anything" below before you run the test suite.

---

## The blocker you will hit in the first 30 seconds

**`citadel-node` does not compile on Windows today** — but as of 2026-07-26 the reason is much
smaller than it was, and the remaining gap is one named function.

**What was already done on the Mac** (verified green: `cargo test --workspace` → 73 passed, the
same as before the change, so it is behaviour-preserving on Unix):

- The Unix-only imports in `ipc.rs` are now `#[cfg(unix)]`-gated. `UnixStream` is gone entirely.
- `handle_connection` is now **generic** — `<S: AsyncRead + AsyncWrite + Send + 'static>` — and
  uses `tokio::io::split` instead of `UnixStream::into_split`. A `NamedPipeServer` satisfies those
  bounds, so this function needs **no further change**; it is shared verbatim by both platforms.
- The bind/accept loop moved into `IpcServer::spawn_listener`, which is `#[cfg(unix)]`. Binding
  still happens inside `start()` so a bind/permissions failure surfaces from `start()` rather than
  from a detached task.
- The socket-file pre-clean in `start()` and the unlink in `stop()` are `#[cfg(unix)]`. A pipe name
  is not a filesystem entry, so `remove_file` on it would only ever be an error.

**What is left:** write `#[cfg(windows)] fn spawn_listener` — the one missing arm. On Windows the
build now fails with "no method named `spawn_listener`", pointing straight at it. See "The fix".

**Verified, not assumed:** tokio exports the Unix types under `#[cfg(all(unix, feature = "net"))]`
(`tokio/src/net/mod.rs`, via the `cfg_net_unix!` macro); `tokio::io::split` requires only
`AsyncRead + AsyncWrite` (no `Unpin`); and `NamedPipeServer` has **no `into_split`**, which is why
the generic split was necessary rather than cosmetic.

**You must build ON Windows.** Cross-compiling from the Mac was attempted and does not work:
`cargo check --target x86_64-pc-windows-msvc` dies in `ring`'s build script long before reaching
this code, because there is no Windows C toolchain here. So `cargo check` on the Mac will never
tell you whether the Windows build is fixed — only a build on the machine itself will.

`main.rs` line 1 already carries `#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]`,
so somebody intended this to run there; the IPC layer just never followed.

## What the IPC layer is for

The node's local socket is how a **Claude** session joins a room. `packages/claude-channel` (an MCP
server running inside the Claude session) connects to it, receives `delivery.assign` notifications,
and posts replies back with `message.reply`. Codex seats do not use it at all — they are driven by
a child `codex app-server` process over stdio, which is already cross-platform.

So: **if you only need Codex seats on Windows, you still have to make the file compile, but the
transport choice barely matters.** If you want Claude seats there too, it matters a lot.

## The fix

Named pipes are the Windows equivalent, and tokio ships them:
`tokio::net::windows::named_pipe::{NamedPipeServer, NamedPipeClient, ServerOptions, ClientOptions}`.

The shape that will hurt least:

1. **Done already** — the `#[cfg]` seam exists and `handle_connection` is generic. All that remains
   is `#[cfg(windows)] fn spawn_listener`, with the same signature as the Unix one. Its loop differs
   in shape: a named pipe is not a listener you accept repeatedly, it is one server instance per
   client. So: create an instance with `ServerOptions::new().first_pipe_instance(true)` (the `true`
   only on the first — it makes a squatter on the name fail loudly instead of silently sharing it),
   `connect().await` it, then **create the next instance before spawning the handler for the current
   one**, or you drop the client that arrives during handling.
2. `config.ipc_socket_path` stays a single field. On Windows it holds a pipe name like
   `\\.\pipe\roundtable-<node-id>`; on Unix it stays a filesystem path. Do not add a second config
   field — one path, interpreted per platform, keeps `install-*.ps1`/`install-macos.sh` symmetrical.
3. **Security is not automatic, and this is the part to not rush.** The Unix path sets mode `0600`
   (in `spawn_listener`), which is what keeps the socket owner-only. A named pipe created with
   default security is far more permissive: `ServerOptions::create()` passes NULL security
   attributes, and Win32 documents that default as granting full control to SYSTEM/Administrators/
   creator-owner **and read access to Everyone and the anonymous account**. Read access is enough to
   siphon `delivery.assign` bodies — the room transcript — off the machine.

   So the only usable creation path is the `unsafe` `create_with_security_attributes_raw`, with a
   descriptor you build. The least error-prone construction is SDDL rather than hand-rolled ACLs:
   get the current user's SID (`OpenProcessToken` → `GetTokenInformation(TokenUser)` →
   `ConvertSidToStringSidW`) and build `D:P(A;;GA;;;<sid>)` — `P` protects the DACL from
   inheritance, and the single ACE grants GENERIC_ALL to exactly that user — then
   `ConvertStringSecurityDescriptorToSecurityDescriptorW`. Needs `windows-sys` under
   `[target.'cfg(windows)'.dependencies]` (0.59/0.60/0.61 are all already in the local cargo cache).

   **Make it fail closed:** if the descriptor cannot be built, return `Err` and refuse to serve.
   Never fall back to `ServerOptions::create()` — a permissive pipe that works looks exactly like a
   correct one. Mirror `unix_socket_owner_only` with a Windows test that reads the descriptor back
   and asserts the DACL holds only that one SID.

   This was deliberately **not** written on the Mac: it is unverifiable `unsafe` FFI here (the
   cross-compile dies in `ring`, confirmed), and blind unsafe security code that compiles is worse
   than none. Write it on the machine that can compile and run it.
4. `packages/claude-channel` needs **no change**. Node's `net.connect()` accepts a `\\.\pipe\...`
   name transparently, and `src/ipc.ts` already passes `socketPath` straight through.

## Then the installer

`ops/install-windows.ps1` does not exist. `ops/install-macos.sh` is the model — read it; the
PowerShell version needs the same five jobs:

1. Build the release binary (`cargo build --release -p citadel-node`).
2. Copy it out of `target/` to a stable location. **Copy, do not point the service at the build
   output** — a rebuild mid-session would swap the binary under a running service.
3. Write `config.json` and the token file with an ACL restricted to the current user (the Unix
   script uses `chmod 600`; the equivalent here is `icacls` or a `Set-Acl` with inheritance
   disabled). The token is a real credential — it is what the hub authenticates the node with.
4. Resolve `codex`'s absolute path at install time. The macOS script does this because a launchd
   agent does not inherit an interactive shell's `PATH`; a Windows service or scheduled task has
   exactly the same problem.
5. Register it to start at login and stay up. **Per CLAUDE.md §4A, it must never flash a console
   window** — Task Scheduler's "Hidden" checkbox alone does not hide a spawned console. Use a
   genuinely windowless launch and then confirm by watching a login: no flash, or it is wrong.
   `windows_subsystem = "windows"` in `main.rs` already helps, but verify rather than assume.

## Enrolment (no code needed)

Same as the Mac. On the box:

```bash
ssh vendure 'node ~/sites/citadel/tools/citadel/ops/enrol-node.mjs node windows'
ssh vendure 'node ~/sites/citadel/tools/citadel/ops/enrol-node.mjs seat main windows win-codex codex'
```

That prints a `node_id` and a `token`, once. The token is not recoverable — if it is lost, enrol
again. Feed both to the installer.

Hub URL is `wss://citadel.spoares.com/node/connect`. No tunnel, no VPN; the node dials outbound.

## Things that will waste your time if nobody tells you

- **rustls has no default crypto provider.** Already fixed in `main.rs` (`ring` installed
  explicitly before the first dial) — do not remove it. Without it the node runs fine over `ws://`
  and panics on the first `wss://`, exiting 0, so a keep-alive supervisor will not even restart it.
  `ring` was chosen over `aws-lc-rs` because aws-lc-rs additionally needs cmake and NASM. `ring`
  still needs a **C compiler** — that is exactly what the failed cross-compile above hit — but on
  Windows the MSVC build tools you already need for Rust provide it. Do not switch it.
- **Never pipe the Codex child's stderr without draining it.** `codex.rs` spawns a drain task; a
  full pipe buffer blocks the child forever and presents as "handshake succeeds, then everything
  hangs". This is platform-independent and already handled — just do not undo it.
- **The fixture agreeing with the code proves nothing.** Wire shapes come from
  `fixtures/app-server/schema/`, generated from a real `codex` binary. If Windows Codex is a
  different version, regenerate and diff rather than assuming:
  `codex app-server generate-json-schema --experimental --out <dir>`.

## Known broken BEFORE you touch anything

Read this before you run the test suite, or you will spend an afternoon debugging something you
did not cause.

- ~~**`packages/hub/src/replay.test.mjs` wedges the whole run at process exit.**~~ **FIXED
  2026-07-26 — run the suite as one command now: `node --test src/*.test.mjs` → 100 passed.**

  It was never an environment quirk and never really a leak. The first test asserted
  `hub.flushDeliveries() === 1`, but the hub also auto-flushes on node connect from a deferred
  `setTimeout(..., 0)`; the two raced, and whichever ran second returned 0. That failed roughly one
  run in three, and a *failing* test never reached its trailing `await hub.close()` — which is what
  left the listening server and two sockets that stopped the runner exiting. The unclosed server was
  the symptom; the flaky assertion was the cause. Now the test asserts the delivery's actual state
  (`'sent'`) rather than which flush won, and cleanup moved into `t.after()` so it runs on failure.
  Verified: 12/12 clean for that file, 8/8 clean for the full suite. Details in STATUS.md.

  Still true, and worth keeping: do not "fix" any future hang with `server.unref()` or a bounded
  resolve. That was tried and reverted — it made things worse and resolved `close()` before the
  server had actually closed.

- ~~**`transcript.read`, `transcript.search` and `handoff.create` return "not implemented".**~~
  **IMPLEMENTED 2026-07-26.** The node now has a read path to the hub: a `node.query` /
  `query.result` frame pair over the socket it is already authenticated on, correlated by
  `request_id`. It is the only request/response pair in the protocol — every other node command is
  fire-and-forget. Reads are scoped hub-side to rooms the node holds a seat in (a node authenticates
  as itself, not as an operator), and an unknown room returns the same `room_not_accessible` as an
  unauthorised one so a node cannot probe which rooms exist. `handoff.create` resolves its target
  alias against a roster read per handoff rather than caching one, because a cached roster is stale
  exactly when it matters. Nothing here is platform-specific — it works on Windows as soon as the
  node compiles there.

- **Working IPC methods: `message.reply`, `transcript.read`, `transcript.search`, `handoff.create`,
  `ping`.** Still refused: `session.join`/`session.leave` (seats are enrolled with
  `ops/enrol-node.mjs`, and the node holds no admin credential) and `approval.verdict`.

## What a healthy run looks like

Before you change anything, get a baseline on the machine you are working on:

```
cargo test --workspace                                  → 73 passed, 0 failed
node --test src/*.test.mjs                              → 100 passed, 0 failed
```

If those numbers do not match on a clean checkout, something is wrong with the environment rather
than with your change — sort that out first. A wedge at exit is no longer expected: if you see one,
it is new, and the first thing to check is whether a test failed before its `t.after()` cleanup.

## How you will know it worked

Same proof used for the Mac — do not settle for "the service is running":

1. `ssh vendure 'grep node.connected ~/.pm2/logs/citadel-hub-out.log | tail -1'` shows the
   Windows `node_id`.
2. Post to its seat and read the reply back out of the production database:

```bash
ssh vendure 'cd ~/sites/citadel/tools/citadel && node -e "
import(\"./packages/hub/src/store.mjs\").then(({Store})=>{
  const s=Store.open(process.env.HOME+\"/.local/share/roundtable/roundtable.sqlite3\");
  const room=s.getRoomBySlug(\"main\");
  const seat=s.listSeats(room.id).find(x=>x.alias===\"win-codex\");
  s.postMessage({roomId:room.id,actorId:crypto.randomUUID(),body:\"Say exactly: WINDOWS\",mentionSeatIds:[seat.id]});
  s.close();
});"'
```

Then re-read the room and confirm `WINDOWS` came back from the Windows machine. A green build and a
running service are not evidence; a message making the round trip is.
