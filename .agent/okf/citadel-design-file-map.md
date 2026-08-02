---
type: design
title: File map
description: File map
tags: [design, roundtable]
---

## File map

- `tools/citadel/crates/citadel-store/migrations/0002_task_runs.sql` — additive shared task/run schema.
- `tools/citadel/packages/hub/src/store.mjs` — ordered migrations, task/run/event transactions, node ownership checks.
- `tools/citadel/packages/hub/src/server.mjs` — task API, node approval/presence/state/event handlers, ownership enforcement.
- `tools/citadel/packages/hub/src/wire.mjs` — explicit delivery-state and run-event frames.
- `tools/citadel/packages/hub/src/*.test.mjs` — Node-hub regression and contract tests.
- `tools/citadel/crates/citadel-node/src/{hub.rs,state.rs,main.rs}` — persist-before-ACK, cursor progression, run-event forwarding.
- `tools/citadel/crates/citadel-store/src/lib.rs` — apply shared migration in the Rust reference store.
- `tools/citadel/packages/web/src/{types.ts,api.ts,App.tsx,components/RunPanel.tsx}` — task list/run inspector separated from transcript.
