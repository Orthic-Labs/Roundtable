# Roundtable on Windows — handoff

Everything below is for whoever brings `roundtable-node` up on Adrian's Windows machine. The hub
is already deployed and working; nothing on the server side needs to change. Read `HANDOVER.md`
first for the system as a whole, then this.

**Status: not started.** The Mac node is live and answering. Windows has never been built or run.

---

## The blocker you will hit in the first 30 seconds

**`roundtable-node` does not compile on Windows today.** `crates/roundtable-node/src/ipc.rs`
imports `tokio::net::{UnixListener, UnixStream}` unconditionally (line 16) and uses them in
`IpcServer::start` and `handle_connection`. Those types do not exist on Windows.

This is not a lurking edge case — it is a hard build failure, and it is the whole of the Windows
work. Everything else in the node is already portable.

**Verified, not assumed:** tokio exports both types under `#[cfg(all(unix, feature = "net"))]`
(`tokio/src/net/mod.rs`, via the `cfg_net_unix!` macro), and the import at `ipc.rs:16` carries no
cfg gate.

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

1. Put the two transports behind a small `#[cfg]` split in `ipc.rs` — a `listen()` returning a
   stream of connections and a per-connection `(reader, writer)` pair. `handle_connection` itself is
   already generic over `AsyncRead + AsyncWrite` in everything but its signature; it needs no logic
   change, only a type change.
2. `config.ipc_socket_path` stays a single field. On Windows it holds a pipe name like
   `\\.\pipe\roundtable-<node-id>`; on Unix it stays a filesystem path. Do not add a second config
   field — one path, interpreted per platform, keeps `install-*.ps1`/`install-macos.sh` symmetrical.
3. **Security is not automatic.** The Unix path sets mode `0600` (`ipc.rs`, the `#[cfg(unix)]` block
   in `start()`), which is what keeps the socket owner-only. A named pipe created with default
   options is far more permissive. Set an explicit DACL granting only the current user, or you have
   opened a local privilege boundary — anything on that machine could drive Adrian's agents. The
   existing test `unix_socket_owner_only` is the one to mirror.
4. `packages/claude-channel` needs **no change**. Node's `net.connect()` accepts a `\\.\pipe\...`
   name transparently, and `src/ipc.ts` already passes `socketPath` straight through.

## Then the installer

`ops/install-windows.ps1` does not exist. `ops/install-macos.sh` is the model — read it; the
PowerShell version needs the same five jobs:

1. Build the release binary (`cargo build --release -p roundtable-node`).
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
ssh vendure 'node ~/sites/roundtable/tools/roundtable/ops/enrol-node.mjs node windows'
ssh vendure 'node ~/sites/roundtable/tools/roundtable/ops/enrol-node.mjs seat main windows win-codex codex'
```

That prints a `node_id` and a `token`, once. The token is not recoverable — if it is lost, enrol
again. Feed both to the installer.

Hub URL is `wss://roundtable.spoares.com/node/connect`. No tunnel, no VPN; the node dials outbound.

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
- The node holds no transcript and no room roster, so `transcript.read`, `transcript.search` and
  `handoff.create` return explicit "not implemented" over IPC. That is current behaviour on every
  platform, not a Windows gap.

## How you will know it worked

Same proof used for the Mac — do not settle for "the service is running":

1. `ssh vendure 'grep node.connected ~/.pm2/logs/roundtable-hub-out.log | tail -1'` shows the
   Windows `node_id`.
2. Post to its seat and read the reply back out of the production database:

```bash
ssh vendure 'cd ~/sites/roundtable/tools/roundtable && node -e "
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
