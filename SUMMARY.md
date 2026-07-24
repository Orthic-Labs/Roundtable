# Roundtable — Summary (2026-07-24)

Cross-device rooms for existing local agent sessions. Round-trip a message from one device to another with a vendor session attached on the receiving side, and stream the result back without sharing keys, prompts, or context.

Delivered to `https://github.com/Orthic-Labs/roundtable` at `main` (HEAD `210047f`).

## What landed

### Architecture

- `2026-07-22-roundtable-cross-device-architecture.md` — canonical spec (cross-device rooms, locked protocol, security contract, delivery/recovery, cancellation, Tasks 0–13).
- `2026-07-14-agent-room-architecture.md` — sister architecture for the agent-room protocol that the round-table model evolved from.
- `docs/product.md`, `docs/architecture.md` — code-grounded Blueprint-generated docs.

### Workspace

```
tools/roundtable/
├── Cargo.toml, Cargo.lock                        # rust workspace (4 crates)
├── package.json, pnpm-workspace.yaml, pnpm-lock.yaml
├── crates/
│   ├── roundtable-protocol/                       # v1 enums, canonical JSON, 5 tests
│   ├── roundtable-store/                          # SQLite actor + 0001 schema + dedupe, 9 tests
│   ├── roundtable-hub/                            # axum HTTP + ws + auth + origin guard, 24 tests
│   └── roundtable-node/                           # Codex App Server adapter + hub client + IPC, 24 tests
├── packages/
│   ├── web/                                       # PWA (Composer, RoomList, MessageList, RoomView, SeatPanel, Login), 10 tests
│   └── claude-channel/                            # MCP shim with 7 roundtable_* tools, Zod schemas
└── fixtures/
    ├── app-server/fake-codex.mjs                  # stdio JSON-RPC roundtrip fixture
    └── hub/fake-hub.mjs                           # TCP NDJSON roundtrip fixture
```

### Protocol floor

- `roundtable-protocol/src/lib.rs` is the locked v1 enum/record set: `ActorKind`, `MessageKind`, `DeliveryReason`, `DeliveryState`, `SeatProvider`, `SeatState`; `Room`, `Message`, `Seat`, `DeliveryRecord`, `Context*` records; WebSocket envelopes; canonical JSON + SHA-256 helpers; stable uuid-v7 actor identities; validation limits (message body, room, alias, handoff, page).
- `MessageMutation` payloads use `deny_unknown_fields` — the protocol rejects fields it doesn't know.
- WebSocket upgrade enforces protocol version + rejects unknown frame types.

### Storage floor

- `roundtable-store` is a dedicated SQLite actor over a single connection. WAL + `foreign_keys` + `busy_timeout`. Migration `0001_initial.sql` is the exact schema; transactional room sequences; atomic inserts for messages, mentions, deliveries, events.
- Request dedupe: same `(actor_id, request_id)` payload returns the original result; different payload returns HTTP 409 `request_id_reused`.
- Typed human mentions; no-wake agent prose; structured handoffs with exclusive `task_key` + depth limit 8; approvals; lease retry/dead-letter; replay cursor; bounded context construction.

### Hub floor

- Axum router. Two auth surfaces: admin-token (browser session) + exact-origin mutation guard. `__Host-roundtable` cookie. CSP / X-Content-Type-Options / Referrer-Policy headers. Payload size cap.
- Full HTTP surface: room create / list / read / message send / message get / mention / approval / handoff / cursor.
- Node WebSocket upgrade with protocol version + frame type rejection. Durable targeted event replay. Heartbeat pings. Node-offline seat marking.

### Node floor

- Typed Codex App Server JSONL adapter (`crates/roundtable-node/src/codex.rs`). Hub WebSocket client with reconnect + durable cursor replay. OS-keyring secrets. Lease retry. IPC server for the Claude channel shim.

### PWA floor

- Vite + React + TypeScript. IndexedDB offline queue. Service worker. Manifest. Composer, RoomList, RoomView, MessageList, SeatPanel, Login.
- 10 vitest tests + `pnpm build` clean.

### Claude channel

- `packages/claude-channel` exposes 7 roundtable_* MCP tools (`roundtable_join`, `roundtable_leave`, `roundtable_read`, `roundtable_search`, `roundtable_reply`, `roundtable_handoff`, `roundtable_approval`).
- Zod schemas mirror the Rust protocol types. IPC client opens the node's IPC socket.

### Fixtures

- `fixtures/hub/fake-hub.mjs` — TCP NDJSON fake hub for roundtrip tests.
- `fixtures/app-server/fake-codex.mjs` — stdio JSON-RPC fake Codex App Server.

## Provider isolation boundary

Claude attaches via `packages/claude-channel` (a thin MCP shim over the Claude Channel preview feature). Codex attaches via `crates/roundtable-node/src/codex.rs` (a typed adapter over the Codex App Server JSONL protocol). Breaking vendor APIs only require rewriting the provider adapter — the hub, store, protocol, HTTP API, WebSocket envelope, schema, and PWA do not change. Adding a third provider (Groq / Gemini / local LLM) is a new `provider::*` module, not a hub change.

## Spec debt (5 stale claims, CODE-FELL-SHORT)

Tracked in `.agent/reconcile.json` (regenerable workspace artifact, not in the repo):

- Hub adoption of `rightkit-logs` (architecture §"RightKit reuse").
- `MessageKind::SeatInterrupt` + interrupt handler.
- `ApprovalResolution::AfterCancel` + cancel-while-waiting-approval flow.
- `DeliveryRecord.no_rollback` enforcement.
- `tools/roundtable/ops/observability.md` (log field schema, sampling, on-call runbook).

These ship as documented debt. Each has a concrete `proposedReconciliation` in the workspace reconcile file.

## What does not yet ship

- **End-to-end acceptance (Task 12):** orchestrator + loop-prevention + idempotency across a real Codex attach + scripted roundtrip — deferred per the user's "we will test it at the end" directive.
- **Hetzner deployment (Task 11):** `docker-compose`, `nginx-roundtable.conf`, `install-macos.sh` / `install-windows.ps1`, `backup.sh` — architecture specifies the recipe; implementation paths under `tools/roundtable/ops/` are not yet generated.
- **OKF emission (`skill-emit blueprint`):** blocked at the same machine boundary as the push was — both the sandbox and the credential path prevented the run. The blueprint artifacts are present locally (`.agent/`, `.blueprint/`) and are regenerable.

## Verification (per-scope, pre-push)

| Slice | Tests |
|---|---|
| `roundtable-protocol` | 5/5 |
| `roundtable-store` | 9/9 |
| `roundtable-hub` | 24/24 (auth, delivery, http, reconnect) |
| `roundtable-node` | 24/24 (ipc, reconnect, codex_contract) |
| `packages/web` | 10/10 |
| `packages/claude-channel` | tsx test pass |

Total: **72/72** in the agent worktrees that produced each slice. End-to-end Task 12 remains.
