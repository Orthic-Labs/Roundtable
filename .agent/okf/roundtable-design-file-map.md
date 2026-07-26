---
type: design
title: File map
description: File map
tags: [design, roundtable]
---

## File map

- `tools/roundtable/crates/roundtable-store/migrations/0002_task_runs.sql` — additive shared task/run schema.
- `tools/roundtable/packages/hub/src/store.mjs` — ordered migrations, task/run/event transactions, node ownership checks.
- `tools/roundtable/packages/hub/src/server.mjs` — task API, node approval/presence/state/event handlers, ownership enforcement.
- `tools/roundtable/packages/hub/src/wire.mjs` — explicit delivery-state and run-event frames.
- `tools/roundtable/packages/hub/src/*.test.mjs` — Node-hub regression and contract tests.
- `tools/roundtable/crates/roundtable-node/src/{hub.rs,state.rs,main.rs}` — persist-before-ACK, cursor progression, run-event forwarding.
- `tools/roundtable/crates/roundtable-store/src/lib.rs` — apply shared migration in the Rust reference store.
- `tools/roundtable/packages/web/src/{types.ts,api.ts,App.tsx,components/RunPanel.tsx}` — task list/run inspector separated from transcript.
