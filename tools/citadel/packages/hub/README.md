# Citadel Hub (canonical)

**This is the production hub.** The Rust `crates/citadel-hub` crate is [deprecated/frozen](../../crates/citadel-hub/DEPRECATED.md).

Dependency-free Node.js service: rooms, auth, HTTP API, node WebSocket (`/node/connect`), operator event stream (`/api/events`), SQLite store, and delivery dispatch.

```bash
# from tools/citadel/packages/hub
ROUND_TABLE_ADMIN_TOKEN='<secret>' node main.mjs
```

Production uses pm2 — see `ops/ecosystem.config.cjs`.

## Contract surfaces

| Surface | Path |
|---|---|
| Operator HTTP API | `src/server.mjs` route table |
| PWA DTO mapping | `src/dto.mjs` |
| Browser live events | `src/operator-events.mjs` → `events` table (`target_node_id = __operator__`) |
| Node replay | `store.eventsAfter(..., { audience: 'node' })` |
| Delivery transitions | `src/transitions.mjs` |
| Browser mutation idempotency | `request_dedupe` via `src/payload.mjs` (`actor_id = operator`) |

## Tests

```bash
node --test 'src/*.test.mjs'
```
