# Roundtable

> **TL;DR:** Roundtable lets you steer live local Codex & Claude coding sessions from another device without moving provider API keys or full hidden session state into a cloud agent service.

Roundtable turns agent sessions already running on your machines into authenticated rooms. Send a
message from phone, laptop or browser; the local node holding real session delivers it to Codex or
Claude, then posts reply back to shared room.

Hub coordinates messages. Your machine still runs agent.

## How it works

```text
phone / laptop / browser
          │ HTTPS + WebSocket
          ▼
   Roundtable hub + SQLite
          │ authenticated node delivery
          ▼
 local node on coding machine
          ├── Codex app-server
          └── Claude MCP channel
```

Core concepts:

- **Room:** shared transcript around one piece of work.
- **Seat:** named agent identity inside room, such as `mac-codex`.
- **Node:** local daemon attached to one machine.
- **Delivery:** durable message assignment from hub to node/seat.
- **Handoff:** transfer of work or attention between seats.
- **Approval:** typed request/decision record visible in room.

## Architecture

| Component | Technology | Responsibility |
|---|---|---|
| Hub | dependency-free Node.js service | rooms, auth, HTTP, WebSocket, dispatch, replay & API |
| Store | SQLite in WAL mode | messages, seats, nodes, deliveries, approvals, handoffs, leases & dedupe |
| Protocol | versioned Rust types + canonical JSON | stable wire vocabulary across node/hub |
| Node | Rust daemon | authenticated hub connection, reconnect, local IPC, secrets & agent adapters |
| Codex adapter | `codex app-server` JSON-RPC | start/resume/steer/interrupt real Codex threads |
| Claude channel | MCP shim over owner-only local socket | attach Claude session, receive work & post replies |
| Web app | installable PWA | room list, transcript, composer, approvals & remote control |

Hub persists event before delivery. Node reconnects, replays eligible work & deduplicates by stable
IDs. One active connection per node prevents stale sockets from swallowing messages. Terminal
deliveries are never re-injected.

## SQLite delivery model

Store uses 11-table schema with guarded migrations & WAL. SQLite actor serializes state changes,
while transactional operations keep multi-step actions—such as handoff + wake message—consistent.

Important protections:

- canonical event/message IDs make retries idempotent;
- delivery states prevent duplicate execution;
- node/seat leases prevent two workers owning same work;
- room membership bounds transcript access;
- approval resolution happens once;
- cancel never retracts output already recorded;
- daily verified backups protect deployed database;
- schema `user_version` prevents migrations rerunning on restart.

## Codex session bridge

Node talks to real `codex app-server`, not a fake shell wrapper. It supports thread list/start/resume,
turn start/steer/interrupt & relevant notifications. Adapter translates Codex items—messages,
commands, file edits, tool calls, searches & plans—into room events.

Each seat keeps vendor thread identity on machine. Hub receives room messages & surfaced agent
events, not provider credentials or complete hidden model context.

## Claude session bridge

Claude connects through seven-tool MCP channel over node’s mode-`0600` local Unix socket. Channel can
reply, read/search transcript, create handoff & ping. Node queries hub over already-authenticated
WebSocket; it never receives operator/admin credential merely to read room.

Query protocol uses correlated request IDs & guarantees response/error on unknown query, refusal,
write failure or dropped connection, so MCP call cannot hang silently.

## Authentication & trust boundaries

Roundtable separates browser, hub, node & provider trust:

- browser API uses server-side authenticated session;
- WebSocket upgrades enforce allowed origin;
- every node has unique token, verified before delivery;
- revoked nodes are refused;
- node may read only rooms where it holds seat;
- unknown & unauthorized rooms return same error to prevent enumeration;
- node may act only from seats it owns;
- enrollment/minting credentials remains box-side CLI, not public HTTP route;
- local secrets use OS keyring where available;
- local Claude socket is owner-only.

Provider API keys stay on coding machine. Hub is coordination plane, not hosted inference proxy.

## Reliability model

- outbound hub messages are durable before dispatch;
- reconnect replays eligible nonterminal deliveries;
- duplicate events/messages are harmless;
- superseding connection destroys earlier socket;
- dispatch loop runs continuously & flushes when node connects;
- pending node queries fail on disconnect instead of waiting forever;
- structured logs cover room, node, seat, event & delivery identities;
- launchd/pm2 restart processes automatically;
- SQLite backup is scheduled daily.

This was tested against real Codex & live Claude channel, not only fixtures.

## What makes it different

Roundtable’s advantage is control-plane design:

- **Continue existing sessions:** work stays attached to real local Codex/Claude thread.
- **No provider-key relay:** hub never needs OpenAI/Anthropic credentials.
- **Durable room history:** reconnects, handoffs & approvals survive client/device changes.
- **Typed multi-agent coordination:** seats, deliveries, interrupts, handoffs & approvals are protocol
  objects, not conventions hidden in chat prose.
- **Least-privilege nodes:** machine receives only work for seats/rooms it owns.
- **Local vendor adapters:** provider-specific session mechanics stay beside provider session.
- **Human remote surface:** same room works as PWA while local agents continue through native tools.
- **Operationally simple hub:** dependency-free Node service + SQLite + pm2/nginx.

It is closer to secure remote control for local agent sessions than another cloud chatbot.

## Current deployed state

Live system at `https://roundtable.spoares.com` includes:

- Hetzner hub under pm2;
- SQLite WAL store + daily backups;
- PWA served by hub;
- Mac node under launchd;
- real Codex app-server seat;
- real Claude MCP channel seat;
- TLS WebSocket connection without tunnel;
- working messages, transcript read/search, interrupt & cross-seat handoff.

Authoritative measured status:

- **76 Rust tests, 0 failures**
- **107 Node hub tests, 0 failures**
- **10 PWA tests**
- live two-provider message/reply & handoff acceptance

See [`STATUS.md`](STATUS.md) for dated evidence & exact deployment details.

## Current limits

- Windows node has not been built or run;
- node replay cursor still reconnects from zero, while hub prevents terminal replay;
- Codex streaming deltas, reasoning & some `ThreadItem` variants are not surfaced;
- Claude channel intentionally refuses `approval.verdict` & `session.join/leave`;
- hub uses schema-compatible local logger instead of `rightkit-logs`;
- browser PWA currently relies on hub’s own admin login; Cloudflare Access rollout is prepared but
  blocked on required token scope.

## Repository layout

```text
tools/roundtable/
├── crates/
│   ├── roundtable-protocol/
│   ├── roundtable-store/
│   ├── roundtable-hub/
│   └── roundtable-node/
├── packages/
│   ├── hub/
│   ├── web/
│   └── claude-channel/
├── fixtures/
└── ops/
```

Detailed architecture: [`2026-07-22-roundtable-cross-device-architecture.md`](2026-07-22-roundtable-cross-device-architecture.md).
Code-grounded overview: [`docs/product.md`](docs/product.md) & [`docs/architecture.md`](docs/architecture.md).
