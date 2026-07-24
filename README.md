# Roundtable

Cross-device rooms for existing local agent sessions. Round-trip a message from one device to another with a vendor session attached on the receiving side, and stream the result back without sharing keys, prompts, or context.

## Start here

Read the architecture spec: [`2026-07-22-roundtable-cross-device-architecture.md`](./2026-07-22-roundtable-cross-device-architecture.md).

Generated docs:

- [`docs/product.md`](./docs/product.md) — code-grounded product/marketing overview
- [`docs/architecture.md`](./docs/architecture.md) — code-grounded technical overview

## Repo layout

```
.                                    # architecture docs + generated docs
2026-07-22-roundtable-cross-device-architecture.md
2026-07-14-agent-room-architecture.md
docs/
├── product.md
└── architecture.md
tools/roundtable/                    # the implementation
├── Cargo.toml                        # rust workspace
├── crates/
│   ├── roundtable-protocol/          # locked v1 types + canonical JSON
│   ├── roundtable-store/             # SQLite actor + 0001 schema + dedupe + lease
│   ├── roundtable-hub/               # axum HTTP + ws + auth + origin guard
│   └── roundtable-node/              # typed Codex App Server adapter + hub client
├── packages/
│   ├── web/                          # PWA (Composer, RoomList, MessageList, …)
│   └── claude-channel/               # MCP shim used by Claude to attach to a room
├── fixtures/
│   ├── app-server/fake-codex.mjs     # stdio JSON-RPC roundtrip fixture
│   └── hub/fake-hub.mjs              # TCP NDJSON roundtrip fixture
└── ops/                              # launchd, nginx, install, backup
```

## Status

Scaffolded. Tests pass in the agent worktree that produced each slice:

- `tools/roundtable/crates/roundtable-protocol` — locked v1 enums, canonical JSON, 5 tests
- `tools/roundtable/crates/roundtable-store` — atomic SQLite, dedupe, lease retry/dead-letter, 9 tests
- `tools/roundtable/crates/roundtable-hub` — auth/origin guard + HTTP + ws + replay, 24 tests
- `tools/roundtable/crates/roundtable-node` — Codex adapter + IPC, 24 tests
- `tools/roundtable/packages/web` — Composer/RoomList/RoomView + IndexedDB offline queue, 10 tests
- `tools/roundtable/packages/claude-channel` — 7 roundtable MCP tools, Zod schemas

End-to-end acceptance (Task 12) and Hetzner deployment (Task 11) remain, per the architecture document.

## Stale claims (CODE-FELL-SHORT)

Five spec items verified as not yet implemented; tracked in `.agent/reconcile.json`:

- Hub adoption of `rightkit-logs` (architecture §"RightKit reuse")
- `MessageKind::SeatInterrupt` + interrupt handler
- `ApprovalResolution::AfterCancel` + cancel-while-waiting-approval flow
- `DeliveryRecord.no_rollback` enforcement
- `tools/roundtable/ops/observability.md` (log field schema, sampling, on-call runbook)

These are blockers for the per-scope ship gates and ship with the scaffolding as documented debt.

## Status

Pushed to `https://github.com/Orthic-Labs/roundtable` at `main` (HEAD `6e5ac7a`). 4 commits, 47 files, 6.5K insertions.
