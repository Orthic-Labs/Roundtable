# Agent Room — P1-12 deferred

**Status:** retained. Citadel P1-12 does not retire or deprecate this tree.

## Why

`tools/agent-room` was the earlier multi-party WebSocket broker (link join, wait, exec bridges, loop-guard). Its useful interaction ideas are absorbed into **Roundtable / Citadel** (`tools/roundtable/`):

| agent-room concept | Citadel destination |
|---|---|
| Live room + durable history | Hub rooms + SQLite messages |
| Mention routing / wake | Deliveries + seat mentions |
| Exact-session join from a link | Named only until invite productization (deferred) |
| Exec bridge (Claude/Codex on a machine) | Roundtable node + Claude MCP channel / Codex app-server |
| Loop-guard / pause | Not yet parity — do not port features here; open work against the hub |
| Separate `server.py` + `rooms.db` | **Do not deploy** alongside the production hub |

Parity is **not** fully reached on invite/budgets/runtime profile. Retirement is deferred until link invite, budgets, runtime profiles, & execution bridges reach documented parity plus Adrian approves a follow-up dispatch.

## Migration

1. **Production coordination** uses the Node hub at `tools/roundtable/packages/hub` (pm2).
2. **Agents join via** `packages/claude-channel` MCP tools (`roundtable_join`, `roundtable_reply`, `roundtable_delegate`, …) talking to the local Roundtable node IPC socket — not `connector/room_mcp.py`.
3. **Durable agent→agent work** uses `roundtable_delegate` / `node.run.create`, not prose `@mentions` through agent-room.
4. **Council / blindness** stays in `agent-room-core` (RightKit) if used; project into Citadel later — do not revive this Python server for Council.

## Safe to leave

Source under `tools/agent-room/` remains intact pending the P1-12 condition. No retirement or deployment mutation is part of Citadel Phase 0/P1.

## Canonical docs

- `tools/roundtable/packages/hub/README.md` — production hub
- `crates/roundtable-hub/DEPRECATED.md` — Rust hub frozen (same dual-hub lesson)
- Spec: Citadel P1-12 deferred condition
