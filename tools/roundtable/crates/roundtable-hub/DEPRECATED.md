# roundtable-hub (Rust) — DEPRECATED / FROZEN

**Status:** frozen as of Citadel Phase 0 (2026-08-01).

The deployed and maintained hub is the **Node.js service** at `packages/hub/`. It runs under pm2 in production (`ops/ecosystem.config.cjs`) and is the only hub that should receive contract changes, bug fixes, or new routes.

This Rust crate (`crates/roundtable-hub`) was a parallel implementation kept in sync by hand. That duplication produced permanent PWA↔hub DTO drift (Citadel defect 6.5) and is retired—not deleted yet so `roundtable-node` integration tests and protocol references stay buildable, but **no new features land here**.

| Concern | Canonical location |
|---|---|
| HTTP + WebSocket server | `packages/hub/src/server.mjs` |
| SQLite store | `packages/hub/src/store.mjs` + `crates/roundtable-store/migrations/` |
| Wire protocol types | `crates/roundtable-protocol/` |
| Production process | `packages/hub/main.mjs` via pm2 |

Do not deploy `roundtable-hub` binary to production. Do not port Phase 0+ contract repairs back into this crate unless explicitly resurrecting it—which requires Adrian's approval.
