# Changelog

All notable changes to this repo. Categories follow [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] — 2026-07-24

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

Each item below is verified against the spec as not yet implemented; tracked in the workspace `.agent/reconcile.json` (regenerable, not pushed).

- Hub adoption of `rightkit-logs` (architecture §"RightKit reuse")
- `MessageKind::SeatInterrupt` + interrupt handler
- `ApprovalResolution::AfterCancel` + cancel-while-waiting-approval flow
- `DeliveryRecord.no_rollback` enforcement
- `tools/roundtable/ops/observability.md` (log field schema, sampling, on-call runbook)

### Known limits

- **End-to-end (Task 12) deferred.** Real Codex-attach + scripted roundtrip is the next engineering block.
- **Hetzner deployment (Task 11) deferred.** `docker-compose`, `nginx-roundtable.conf`, `install-macos.sh` / `install-windows.ps1`, `backup.sh` are scoped by the architecture but not generated.
- **OKF emission deferred.** `skill-emit blueprint` requires out-of-sandbox execution; the artifacts are present locally in `.agent/`.

### Push history

- `3455587` — docs(roundtable): cross-device architecture and generated overview docs
- `2b3c0c2` — tools(roundtable): scaffold hub, store, protocol, node, PWA, Claude channel, fixtures
- `2c3140f` — docs(roundtable): add README pointing at the architecture spec
- `6e5ac7a` — docs(roundtable): document push path to Orthic-Labs/roundtable
- `210047f` — docs(roundtable): close out push status
- pending push (this commit) — docs(roundtable): SUMMARY + CHANGELOG
