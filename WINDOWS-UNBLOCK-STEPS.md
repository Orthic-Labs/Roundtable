# Windows unblock — DONE 2026-07-26. Kept as the record of how, not as a to-do list.

> **Everything below was completed.** `6fc9b70 feat(node): support Windows Roundtable nodes` shipped
> the `#[cfg(windows)] spawn_listener` with the SDDL owner-only DACL, `tests/ipc_windows_integration.rs`,
> and `ops/install-windows.ps1`. Verified on this Mac after pulling: **76 cargo tests, 0 failures** —
> the Windows arm did not disturb the Unix one. The Windows node is enrolled and live: hub log shows
> `node.connected` for `21da2b39-67f8-4ff3-85db-4fae7e320102`.
>
> Read this for WHY the shape is what it is (especially the bypass-before-gate ordering and the
> `into_split` trap). Do not read it as work outstanding.

---


2026-07-26. Every claim in `WINDOWS-HANDOFF.md` was checked against the repo on this Mac; the
verdict is below, then the ordered steps.

**Update — the Mac-side half of Step 1 is now done and verified.** `ipc.rs` was refactored so the
platform seam is a single function: Unix imports are cfg-gated, `handle_connection` is generic over
`AsyncRead + AsyncWrite` via `tokio::io::split` (no more `into_split`), the accept loop lives in
`#[cfg(unix)] IpcServer::spawn_listener`, and the socket-file cleanup in `start()`/`stop()` is
Unix-only. `cargo test --workspace` → **73 passed**, identical to the pre-change baseline, so it is
behaviour-preserving. What remains on Windows is `#[cfg(windows)] fn spawn_listener` and its DACL.

## Validation verdict: the handoff is accurate

| Handoff claim | Checked against | Verdict |
|---|---|---|
| `ipc.rs:16` imports `UnixListener/UnixStream` with no cfg gate | `crates/citadel-node/src/ipc.rs:16` | Confirmed — hard Windows build failure |
| Only 3 platform-gated spots exist in the whole node crate | `rg 'cfg\(unix\)|cfg\(windows\)|target_os'` over `src/*.rs` | Confirmed (`ipc.rs:120`, `ipc.rs:289`, `main.rs:1`) — the rest is portable |
| tokio ships named pipes and the crate already has what it needs | `Cargo.toml`: tokio `=1.52.3` with `net` feature; registry source has `src/net/windows/named_pipe.rs` | Confirmed — **no dependency bump needed for the transport itself** |
| rustls provider installed before first dial; `ring` chosen deliberately | `main.rs:33-37`, `Cargo.toml` rustls comment | Confirmed — do not touch |
| Codex stderr drain exists | `codex.rs:317-321` | Confirmed |
| `windows_subsystem = "windows"` already set | `main.rs:1` | Confirmed |
| claude-channel needs no change for pipes | `packages/claude-channel/src/ipc.ts:19` passes `socketPath` straight to `net.connect()`; Node accepts `\\.\pipe\...` there | Confirmed |
| Working IPC methods are `message.reply` + `ping`; transcript/handoff return "not implemented" | `main.rs:295-343`, `ipc.rs:222` | Confirmed |
| replay.test.mjs wedge is pre-existing | `STATUS.md:94-140` (same numbers) | Confirmed — not a Windows problem |
| `install-macos.sh` is the model; `enrol-node.mjs` exists | `ops/` listing | Confirmed at the time; `ops/install-windows.ps1` has since been written and shipped |

## Three things the handoff understates (found in this investigation)

These don't change the plan's shape, but whoever implements it will hit all three:

1. **"handle_connection needs only a type change" is optimistic.** It calls
   `stream.into_split()` (`ipc.rs:187`). `NamedPipeServer` has **no `into_split`** (verified in
   tokio 1.52.3 source). The portable form is `tokio::io::split(stream)` over a generic
   `AsyncRead + AsyncWrite + Unpin` stream — a one-line restructure, but a real one, and it is the
   right shape for both platforms anyway.
2. **The accept loop is a different shape on Windows.** `UnixListener::bind` once, `accept()` in a
   loop. Named pipes instead: create a server instance (`ServerOptions::new()
   .first_pipe_instance(true).create(name)`), `connect().await`, then **create the next instance
   before handling the current connection**. The handoff's proposed `listen()` abstraction covers
   this, but the loop body is per-platform, not shared. Also: `start()`'s
   `socket_path.exists()/remove_file` pre-clean and `stop()`'s unlink (`ipc.rs:116-118,166-168`)
   are Unix-only — a pipe name is not a filesystem entry; both must go inside the `#[cfg(unix)]`
   side.
3. **The owner-only DACL needs one new (Windows-only) dependency.** tokio 1.52.3 exposes exactly
   two creation paths: `create()` (NULL security attributes → **default DACL, which grants
   Everyone read** — an eavesdropping hole for `delivery.assign` bodies) and the unsafe
   `create_with_security_attributes_raw()`. Building the restricted `SECURITY_ATTRIBUTES` needs
   `windows-sys` (or equivalent) under `[target.'cfg(windows)'.dependencies]`. The mirror of
   `unix_socket_owner_only` on Windows is: read the pipe's security descriptor back and assert the
   DACL contains only the current user's SID (+ SYSTEM/Administrators if you choose to allow them).

## The steps, in order

### Step 0 — prerequisites on the Windows machine (no repo work)

1. Install Rust via rustup with the default `x86_64-pc-windows-msvc` toolchain.
2. Install **Visual Studio Build Tools** with the "Desktop development with C++" workload — this
   is both what rustup requires and the C compiler `ring` needs. No cmake, no NASM (that is why
   `ring` was chosen; do not switch to aws-lc-rs).
3. Node.js ≥ 20 (for `packages/claude-channel` build and hub tests if run locally).
4. Codex CLI installed; note the path of the **real executable** (`where codex` — if it resolves
   to a `codex.cmd` npm shim, chase it to the underlying `codex.exe`/`cli.js`, because the node
   spawns `codex_command` directly and a `.cmd` shim through Rust's `Command` is the fragile
   BatBadBut-adjacent path. Point config at the real binary).
5. Clone the repo and get the baseline: `cargo test --workspace` — expect the Rust suite to pass
   **except** it will not compile until Step 1 is done, which is the point. On the Mac the
   baseline is 73 passed; record the Windows number once it compiles.

### Step 1 — make `ipc.rs` compile on Windows

**1a–1c are already done on the Mac** (see the update at the top; verified 73/73):

- ~~Gate the Unix imports.~~ Done — `UnixStream` removed outright, `UnixListener` under `#[cfg(unix)]`.
- ~~Make `handle_connection` generic and swap `into_split` for `tokio::io::split`.~~ Done. Bound is
  `S: AsyncRead + AsyncWrite + Send + 'static` — no `Unpin` needed, since `split`'s halves are
  `Unpin` regardless (confirmed against tokio 1.52.3 source).
- ~~Move the socket-file cleanup under `#[cfg(unix)]` and extract the accept loop.~~ Done — it is
  `#[cfg(unix)] IpcServer::spawn_listener`, and `start()` still binds synchronously so failures
  surface from `start()`.

**What was left at the time, and what Windows then did (all of it, in `6fc9b70`):**

1. Write `#[cfg(windows)] fn spawn_listener` with the same signature as the Unix one. The build
   currently fails there with "no method named `spawn_listener`", which points exactly at it. Loop
   shape: create instance (`ServerOptions::new().first_pipe_instance(true)` on the first only) →
   `connect().await` → create the NEXT instance → spawn `handle_connection` on the current one.
   Add `#[cfg(windows)] use tokio::net::windows::named_pipe::ServerOptions;`.
2. Build the owner-only DACL and pass it via the unsafe `create_with_security_attributes_raw` —
   never plain `create()`, whose NULL attributes grant Everyone read. SDDL `D:P(A;;GA;;;<user-sid>)`
   is the low-risk construction; full rationale and call sequence in `WINDOWS-HANDOFF.md` → "The
   fix" item 3. **Fail closed** if the descriptor cannot be built.
3. Add `[target.'cfg(windows)'.dependencies] windows-sys = { version = "0.61", features = [...] }`
   — pick features off the version you resolve; 0.52/0.59/0.60.2/0.61.2 are all already in the local
   cargo cache, so this resolves offline.
4. Keep `config.ipc_socket_path` as the single field (handoff step 2 is right). Windows configs
   carry `\\\\.\\pipe\\roundtable-<node-id>` (JSON-escaped); Unix configs keep the filesystem path.
5. Tests: `unix_socket_owner_only` is already `#[cfg(unix)]`-safe; add the Windows mirror
   (`pipe_dacl_owner_only`) reading the descriptor back. The three serde tests are platform-free
   and pass anywhere.

Definition of done: `cargo test --workspace` green **on the Windows machine**. Do not trust any Mac
`cargo check --target x86_64-pc-windows-msvc` — re-confirmed here on 2026-07-26 that it dies in
`ring`'s build script (`error: failed to run custom build command for ring v0.17.14`) before
reaching this code. There is no mingw-w64 on this Mac either, so the `-gnu` target is not a
shortcut without installing one.

### Step 2 — regenerate and diff the Codex schema fixtures on Windows

Before wiring seats, confirm the Windows Codex speaks the same wire shapes:

```
codex app-server generate-json-schema --experimental --out <tmpdir>
```

Diff against `fixtures/app-server/schema/`. Same → proceed. Different → regenerate fixtures and
review the diff; do not assume.

### Step 3 — `ops/install-windows.ps1` (mirror of `install-macos.sh`) — DONE, shipped in `6fc9b70`

The macOS script's five jobs translate as:

1. `cargo build --release -p citadel-node`.
2. Copy `target\release\citadel-node.exe` to a stable path (e.g.
   `%LOCALAPPDATA%\roundtable\bin\`) — never point the service at `target\`.
3. Write `config.json` + `node.token` under `%APPDATA%\roundtable\` (or `%LOCALAPPDATA%`), then
   lock both with `icacls <file> /inheritance:r /grant:r "$env:USERNAME:(F)"` — the `chmod 600`
   equivalent. Config fields identical to the Mac's, except `"os": "windows"` and
   `"ipc_socket_path": "\\\\.\\pipe\\roundtable-<node-id>"`.
4. Resolve Codex's absolute path at install time (`Get-Command codex`, chased to the real
   executable per Step 0.4) into `codex_command` — a scheduled task inherits no interactive PATH,
   same as launchd.
5. Register a **logon-triggered Task Scheduler task that launches the exe directly** — no
   `cmd /c`, no `powershell -File`, no `.bat` wrapper, ever (CLAUDE.md §4A). The binary is already
   `windows_subsystem = "windows"`, so launched directly it allocates no console. Set the task's
   restart-on-failure settings (e.g. restart every 1 min, 3 attempts) as the KeepAlive analogue —
   the node's own `reconnect_base_ms` handles network drops; the restart policy only covers
   crashes/panics. Then **watch one real login**: any console flash means a wrapper snuck in.

### Step 4 — enrol and verify (no code)

Exactly the handoff's recipe:

1. On the box: `enrol-node.mjs node windows` and `enrol-node.mjs seat main windows win-codex codex`;
   feed `node_id` + token to the installer. Token is printed once — if lost, enrol again.
2. Proof #1: `grep node.connected ~/.pm2/logs/citadel-hub-out.log | tail -1` shows the Windows
   `node_id`.
3. Proof #2: post `"Say exactly: WINDOWS"` at the `win-codex` seat via the store snippet in the
   handoff and read the reply back out of the production DB. **The round trip is the acceptance
   test; a running service is not.**

### Step 5 (optional, only if Claude seats on Windows are wanted)

Nothing extra on the node — the pipe from Step 1 is the same transport. Point the claude-channel
MCP server's `socketPath` at `\\.\pipe\roundtable-<node-id>`; `net.connect()` takes it as-is
(verified in `ipc.ts`). The working method set is `message.reply` + `ping`, which is the entire
Claude flow today; `transcript.*`/`handoff.create` stay "not implemented" by design — do not stub
them in as part of the Windows work.

## Traps already known — do not rediscover them

- Hub test suite: `node --test src/*.test.mjs` → 100 passed, one command. The old "97 + 3" split
  and the wedge that forced it were fixed on 2026-07-26 (flaky assertion in `replay.test.mjs`
  racing the hub's on-connect auto-flush; a failing test skipped its own `hub.close()`). A wedge is
  no longer expected — if you see one it is new.
- Never remove the rustls `ring` provider install in `main.rs` — the failure mode is a clean-looking
  exit-0 panic on the first `wss://` dial that a supervisor will not restart.
- Never undo the Codex stderr drain in `codex.rs` — a full pipe presents as "handshake OK, then
  everything hangs".
