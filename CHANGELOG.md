# Changelog

All notable changes to this repo. Categories follow [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — Node hub port + first real end-to-end proof, 2026-07-25

Full narrative in `HANDOVER.md`; measured detail in `STATUS.md`. This entry is the chronological
summary of one day's work, in order.

### Decided

- **Port the hub from Rust to Node/TypeScript; keep `roundtable-node` in Rust.** The hub is
  I/O-bound, the deploy target (Hetzner) runs Node already, and there is no viable Rust deploy
  path: no builds on the box, no hosted CI (standing workspace policy), and no cross-compile
  tooling from this arm64 Mac to the box's x86_64. The node stays Rust — a small login-time
  binary with no runtime, where Rust earns its keep.
- **`roundtable.spoares.com`, a subdomain — not `spoares.com/roundtable`.** The path mount is
  operationally simpler, but same-origin would put Roundtable's session cookie on the same
  trust boundary as the memory dashboard, and `Path=/roundtable` does not fix that (cookie path
  matching is by request path, not page path).

### Added

- **`packages/hub`** — a complete Node.js port of the hub, zero npm dependencies
  (`node:sqlite`, `node:http`, `node:crypto`, a hand-rolled RFC 6455 WebSocket server — pnpm is
  broken locally and npm fails on certificate trust, so dependency-free was the only thing
  buildable here). All 16 HTTP routes, session auth, the WebSocket upgrade and node handshake,
  rooms/seats/messages, handoffs/approvals, durable delivery dispatch with reconnect replay, and
  serving the built PWA directly.
- **`ops/ecosystem.config.cjs`, `ops/nginx-roundtable.conf`, `ops/backup.sh`** — pm2 config, the
  nginx vhost (with its Dockerfile-COPY safety check), and a `.backup`-based SQLite backup
  script. Locally smoke-tested; none has touched Hetzner (gated behind an explicit
  `DEPLOY TASK 11`, not yet given).
- **`CodexAdapter` response correlation and `execute()`** in `roundtable-node` — a reader-loop
  task that resolves pending JSON-RPC requests and routes turn-lifecycle notifications to a
  seat, plus a new `CodexCommand::CreateThread` variant (the enum previously had no way to
  create a seat's first thread).
- **`main.rs` now does something.** It was a stub that logged "ready" and exited. It now
  connects to the hub over a real `WsHubChannel`, and its event loop handles `DeliveryAssign` by
  routing to the seat's `CodexAdapter` and posting the resulting reply back to the hub.
- **`tools/agent-room/`** — the multi-party agent+human broker, absorbed from a branch that
  predated this repo's proper git connection.

### Fixed — five real wire-protocol bugs, found only by driving a real binary against a real Codex process

No amount of JS-only or Rust-only testing caught any of these: each side's tests were internally
self-consistent with the same wrong shared assumption.

1. The hub never sent `hello.accepted` at all.
2. Once added, the handshake direction was backwards — sent unprompted instead of waiting for
   the node's `node.hello` first.
3. Every `HubCommand`/`HubEvent` payload is wrapped one level deeper than assumed: Rust's serde
   default externally-tagged enum representation nests each variant's fields under its own
   snake_case key (e.g. `{"hello": {node_id, ...}}`), not flat. `DeliveryAssign` also needed its
   full field set (`delivery`, `message`, `parent`, `context_messages`, `room_slug`,
   `room_title`, `room_objective`, `seats`), not the two-field shape every JS test asserted on.
4. `Message.actor_id` is typed `Uuid` — a human-readable placeholder like `'adrian'` fails
   deserialization. Every actor, human included, needs a genuine UUID on the wire.
5. The seat default state, `'attached'`, isn't a valid `SeatState` variant; defaulted to `'idle'`.

Plus two bugs found along the way, both fixed permanently rather than left as scaffolding:

- **Silent frame drops.** `roundtable-node`'s event-reader loop discarded any undeserializable
  `HubEvent` via bare `.ok()`, with zero logging — the reason the five bugs above took as long
  as they did to find. Now logs the frame kind and the real serde error.
- **A crash on disconnect.** An abrupt node disconnect (`ECONNRESET`) crashed the entire Node hub
  process, not just that connection — an unhandled `EventEmitter` `'error'` event. Fixed with a
  no-op listener in `attachWebSocket`.

### Verified

- `cargo test --workspace`: 66/66 (was 62 at the start of the day).
- The 8 stable `packages/hub` test files together: 72/72.
- **`e2e-rust-node.test.mjs`**: the real compiled `roundtable-node` binary, a real Node hub, and
  the real Codex fixture — a message posted in a room reaches Codex through a real turn and the
  reply is persisted back as an `agent`-authored message. 1/1 pass.

### Known limitation

The reply that lands is a synthetic status string (`"[roundtable-node] turn Completed..."`), not
Codex's real output. `CodexEvent::body` stays empty because App Server's actual text-delta field
shape isn't documented anywhere available here, and guessing it would repeat the exact mistake
this day's investigation was about. The transport and routing are proven; relaying real agent
content is the next gap.

### Known, unresolved (not a protocol defect)

`dispatch.test.mjs`'s reconnect test reproducibly hangs `node --test` when run anywhere but first
in a batch. Confirmed via extensive isolation to be a test-runner/environment interaction on this
machine — every test passes alone, the real e2e test is unaffected. Run this file alone or last
in a batch until diagnosed.

### Earlier the same day — repo reconciliation corrections

### Fixed

- **Status claims reconciled against `main`.** The 0.1.0 entry below describes work as it existed
  in the agent worktrees that produced each slice. The hub, store, and PWA slices were never
  merged, so those descriptions do not hold for `main`. Measured on a clean `main`: 31 tests, 0
  failures (protocol 5, node 24, store 1, hub 0, web 1) against the 72 previously claimed.
  [`STATUS.md`](./STATUS.md) is now the authoritative status document.
- **Push history reinstated as accurate.** An earlier correction in this entry claimed the
  commits below (`3455587`, `2b3c0c2`, `2c3140f`, `6e5ac7a`, `210047f`) did not exist. That was
  wrong: all five are ancestors of `main` in this repository. The check had been run from a copy
  of this tree that sat inside the `bogusyogi/claude` workspace with no `.git` of its own, so it
  resolved against that repo instead of this one.
- **Corrected `.agent/reconcile.json` → `.agent/stale.json`** in README, SUMMARY, and this file;
  the former never existed.
- **Pinned the cargo workspace members explicitly** instead of globbing `crates/*`, which failed
  the whole workspace whenever a tooling scratch directory appeared under `crates/`.

## [0.1.0] — 2026-07-24

> These entries describe the **producing worktrees**, not `main`. See [`STATUS.md`](./STATUS.md).

### Added

- **Architecture spec** — `2026-07-22-roundtable-cross-device-architecture.md`: the canonical cross-device design (Locked Protocol, Security Contract, Delivery/Recovery, Cancellation, Tasks 0–13). Sister spec `2026-07-14-agent-room-architecture.md` retained for context.
- **`roundtable-protocol`** — locked v1 types: `ActorKind`, `MessageKind`, `DeliveryReason`, `DeliveryState`, `SeatProvider`, `SeatState`; `Room`, `Message`, `Seat`, `DeliveryRecord`, `Context*` records; WebSocket envelopes; canonical JSON + SHA-256 helpers; stable uuid-v7 actor identities; validation limits (message body, room, alias, handoff, page). `MessageMutation` payloads use `deny_unknown_fields`. WS upgrade enforces protocol version + rejects unknown frame types.
- **`roundtable-store`** — dedicated SQLite actor over a single connection. WAL + `foreign_keys` + `busy_timeout`. Migration `0001_initial.sql` is the exact schema. Transactional room sequences; atomic inserts for messages, mentions, deliveries, events. Request dedupe via `(actor_id, request_id)` — same payload returns the original result; different payload returns HTTP 409 `request_id_reused`. Typed human mentions; no-wake agent prose; structured handoffs with exclusive `task_key` + depth limit 8; approvals; lease retry/dead-letter; replay cursor; bounded context construction.
- **`roundtable-hub`** — Axum router. Two auth surfaces: admin-token (browser session) + exact-origin mutation guard. `__Host-roundtable` cookie. CSP / X-Content-Type-Options / Referrer-Policy headers. Payload size cap. Full HTTP surface: room create / list / read / message send / message get / mention / approval / handoff / cursor. Node WebSocket upgrade with protocol version + frame type rejection. Durable targeted event replay. Heartbeat pings. Node-offline seat marking.
- **`roundtable-node`** — typed Codex App Server JSONL adapter. Hub WebSocket client with reconnect + durable cursor replay. OS-keyring secrets. Lease retry. IPC server for the Claude channel shim.
- **`packages/web` (PWA)** — Vite + React + TypeScript. Composer, RoomList, RoomView, MessageList, SeatPanel, Login. IndexedDB offline queue. Service worker. Manifest.
- **`packages/claude-channel`** — MCP server with 7 roundtable_* tools (`roundtable_join`, `roundtable_leave`, `roundtable_read`, `roundtable_search`, `roundtable_reply`, `roundtable_handoff`, `roundtable_approval`). Zod schemas mirror the Rust protocol types. IPC client opens the node's IPC socket.
- **`fixtures/`** — `fake-hub.mjs` (TCP NDJSON) and `fake-codex.mjs` (stdio JSON-RPC) for roundtrip testing.
- **Generated docs** — `docs/product.md`, `docs/architecture.md` (Blueprint-generated, code-grounded).
- **`README.md`** — repo landing page; architecture + tests + spec debt pointers.
- **`SUMMARY.md`** — repo summary (this changelog's companion).
- **`CHANGELOG.md`** — this file.
- **`.gitignore`** — excludes `target/`, `node_modules/`, `dist/`, `.cache/`, `.DS_Store`, local artifacts (`_test.txt`, `_mockups/`), and Blueprint workspace artifacts (`.agent/`, `.blueprint/`) that are regenerable locally.

### Tests

- `roundtable-protocol`: 5/5
- `roundtable-store`: 9/9
- `roundtable-hub`: 24/24 (auth, delivery, http, reconnect)
- `roundtable-node`: 24/24 (ipc, reconnect, codex_contract)
- `packages/web`: 10/10
- `packages/claude-channel`: tsx test pass

Total: 72/72 in the agent worktrees that produced each slice. End-to-end acceptance (Task 12) deferred per the user's "we will test it at the end" directive.

### Documented debt (5 stale claims, CODE-FELL-SHORT)

Each item below is verified against the spec as not yet implemented; tracked in the workspace `.agent/stale.json` (regenerable, not pushed).

- Hub adoption of `rightkit-logs` (architecture §"RightKit reuse")
- `MessageKind::SeatInterrupt` + interrupt handler
- `ApprovalResolution::AfterCancel` + cancel-while-waiting-approval flow
- `DeliveryRecord.no_rollback` enforcement
- `tools/roundtable/ops/observability.md` (log field schema, sampling, on-call runbook)

### Known limits

- **End-to-end (Task 12) deferred.** Real Codex-attach + scripted roundtrip is the next engineering block.
- **Hetzner deployment (Task 11) deferred.** `docker-compose`, `nginx-roundtable.conf`, `install-macos.sh` / `install-windows.ps1`, `backup.sh` are scoped by the architecture but not generated.
- **OKF emission deferred.** `skill-emit blueprint` requires out-of-sandbox execution; the artifacts are present locally in `.agent/`.

### Push history (verified — all five are ancestors of `main`)

- `3455587` — docs(roundtable): cross-device architecture and generated overview docs
- `2b3c0c2` — tools(roundtable): scaffold hub, store, protocol, node, PWA, Claude channel, fixtures
- `2c3140f` — docs(roundtable): add README pointing at the architecture spec
- `6e5ac7a` — docs(roundtable): document push path to Orthic-Labs/roundtable
- `210047f` — docs(roundtable): close out push status
- pending push (this commit) — docs(roundtable): SUMMARY + CHANGELOG
