---
type: design
title: TDD tasks
description: TDD tasks
tags: [design, roundtable]
---

## TDD tasks

1. Add failing Node tests that authenticate two nodes and prove a foreign node cannot post, update delivery state, raise an approval, or update presence for another node’s seat. Add matching handlers and wire constants; run `node --test src/{dispatch,query,wire}.test.mjs`.
2. Add failing migration/store tests for exactly one task/run, ordered/deduplicated run events, terminal result, and a transaction rollback. Add `0002_task_runs.sql` plus versioned Node/Rust migration application; run `node --test src/store.test.mjs` and `cargo test -p citadel-store`.
3. Add a failing node-state test that requires a persisted cursor/delivery before ACK. Persist state atomically in the driver and use the received event cursor rather than the handshake cursor; run `cargo test -p citadel-node`.
4. Add a failing hub-node fixture test for task assignment and a normalized `run.event`. Extend the Rust envelope and node adapter to send lifecycle/activity into ordered run events; run `node --test src/e2e-rust-node.test.mjs`.
5. Add failing web tests for a separate run inspector that never injects activity into the room transcript. Add minimal task/run API/types/panel; run `npm test -- --run` from `packages/web`.
6. Run full Rust, hub, and web suites; run `git diff --check`. No deployment or live database migration occurs in this change.

### Critical Files for Implementation

- tools/citadel/packages/hub/src/store.mjs
- tools/citadel/packages/hub/src/server.mjs
- tools/citadel/crates/citadel-node/src/hub.rs
- tools/citadel/crates/citadel-node/src/main.rs
- tools/citadel/crates/citadel-store/migrations/0002_task_runs.sql
