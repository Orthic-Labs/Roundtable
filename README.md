# Roundtable

> **TL;DR:** Roundtable lets you continue an existing local AI coding session from another device without copying API keys or full prompt history to a cloud service.

Roundtable creates cross-device rooms around agent sessions already running on your machines. Send a
message from phone, laptop or browser; a node on the machine holding the real Codex or Claude session
forwards it locally, then streams response back into room.

Technically, a Rust hub handles authenticated rooms, delivery & WebSocket transport; local nodes
adapt vendor session protocols; a PWA provides remote interface; an MCP channel lets Claude attach.
Hub routes messages, not provider credentials or hidden model context.

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

**[`STATUS.md`](./STATUS.md) is authoritative.** The numbers below are measured on `main`, not in
a worktree.

`cargo test --workspace` on a clean `main`: **62 tests, 0 failures.**

| Slice | Tests on `main` | State |
|---|---|---|
| `crates/roundtable-protocol` | 5 | real — locked v1 types, canonical JSON |
| `crates/roundtable-store` | 9 | real — 66KB implementation over the 11-table schema |
| `crates/roundtable-hub` | 24 | real — axum: auth, http, router, state, ws + 4 suites |
| `crates/roundtable-node` | 24 | real — Codex JSONL adapter, WS client w/ reconnect, IPC, keyring |
| `packages/web` | 2 files, unrun | real PWA — no working local package manager, see STATUS |
| `packages/claude-channel` | — | real — 7 `roundtable_*` MCP tools, Zod schemas |

`main` is the only branch. The hub, store, protocol, PWA, and `tools/agent-room/` broker work
that previously sat on unmerged branches has been absorbed; those branches are deleted.
**One real gap:** node and hub speak different wire framings and have never been tested against
each other — see [`STATUS.md`](./STATUS.md) before touching either.

End-to-end acceptance (Task 12) and Hetzner deployment (Task 11) remain, per the architecture document.

## Stale claims (CODE-FELL-SHORT)

Five spec items verified as not yet implemented; tracked in `.agent/stale.json`:

- Hub adoption of `rightkit-logs` (architecture §"RightKit reuse")
- `MessageKind::SeatInterrupt` + interrupt handler
- `ApprovalResolution::AfterCancel` + cancel-while-waiting-approval flow
- `DeliveryRecord.no_rollback` enforcement
- `tools/roundtable/ops/observability.md` (log field schema, sampling, on-call runbook)

These are blockers for the per-scope ship gates and ship with the scaffolding as documented debt.

## Status

Canonical repository: `github.com/Orthic-Labs/roundtable`. See [`STATUS.md`](./STATUS.md).

The push history in CHANGELOG (`3455587` … `210047f`) is genuine — all five commits are ancestors
of `main` here. A revision of these docs briefly called it fabricated; that check had been run
from a disconnected copy of this tree inside another workspace and was wrong.

<!-- blueprint:docs:start -->
## Repository truth docs
- [Product overview](docs/product.md) — what this is and does (generated, code-grounded)
- [Architecture](docs/architecture.md) — components, flows, interfaces (generated, code-grounded)
<!-- blueprint:docs:end -->
