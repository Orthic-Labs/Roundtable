# Roundtable — Authoritative Status

**This file is the single source of truth for what is implemented.** Where README.md,
SUMMARY.md, CHANGELOG.md, `docs/*.md`, or `.agent/okf/*.md` disagree with this file, this file
wins. Regenerate or correct them; do not resolve the conflict in their favour.

- **Repository:** `github.com/Orthic-Labs/roundtable` — the canonical home. This tree previously
  sat inside the `bogusyogi/claude` workspace with no `.git` of its own; it is now a proper
  checkout of this remote. Roundtable work happens here, not in the workspace repo.
- **Measured:** 2026-07-25, clean checkout of `main`.
- **Method:** `cargo test --workspace --no-fail-fast` from `main`. Static inspection for anything
  not covered by a test.
- **Branch policy:** `main` is the **only** branch, locally and on the remote. All prior branch
  work has been absorbed into it (below). Do not create branches or worktrees.

## Bottom line

**62 cargo tests, 0 failures.** Every crate now carries a real implementation. The hub, store,
protocol, and PWA work that previously lived only on unmerged branches has been absorbed into
`main`, and those branches are deleted.

**The Rust node now connects to the Node hub over WebSocket** — verified 2026-07-25 by running the
real `roundtable-node` binary against a live hub and reading `{"connected":1}` back from the hub's
own `/api/nodes`. The three gaps recorded below are closed.

## Measured test counts on `main`

| Component | Tests | State |
|---|---|---|
| `roundtable-protocol` | 5 | real — locked v1 types, canonical JSON |
| `roundtable-store` | 9 | real — 66KB implementation over the 11-table schema |
| `roundtable-hub` | 24 | real — axum: auth, http, router, state, ws + 4 integration suites |
| `roundtable-node` | 24 | real — Codex JSONL adapter, WS client w/ reconnect, IPC, keyring |
| **cargo total** | **62** | **0 failures** |
| `packages/web` | **10** | real PWA — builds (24 modules, 205KB) and serves from the hub |
| `packages/claude-channel` | — | real — 7 `roundtable_*` MCP tools, Zod schemas |

## Absorbed branch work (branches now deleted)

`main` previously tracked none of `tools/roundtable`, and the richest implementations sat on
branches. All are now in `main`:

| Former branch | Carried | Disposition |
|---|---|---|
| `worktree-agent-ad08f847547b7348f` @ `7879d1cf` | Full axum hub (`auth/http/router/state/ws` + 4 test suites), 66KB store, 15KB protocol | **absorbed** |
| `feat/roundtable-pwa-task6` @ `25107365` | Real PWA: `api.ts`, `offline.ts` IndexedDB queue, Composer/Login/MessageList/RoomList/RoomView/SeatPanel, test setup | **absorbed** |
| `claude/multi-agent-llm-broker-uf0hcw` @ `804a0b65` (remote) | `tools/agent-room/` — 1,110-line multi-party broker: server, MCP connector, clients, UI | **absorbed** |
| `worktree-agent-aa58c26c08f651899` @ `6d37f5c2` | A competing, strictly-inferior duplicate of the hub/store slice (511-line store vs 2,095; no integration tests) | **discarded** — superseded by `7879d1cf`; its only unique asset was a regenerable `Cargo.lock` |
| 14 further branches (`codex/rightkit-*`, `worktree-agent-*` at `e03add00`/`22ae1ff2`) | nothing unique | **deleted** — all were already merged into `main` |

A full `git bundle --all` backup was taken and verified before any deletion.

## Node↔hub connection — CLOSED 2026-07-25

Recorded earlier as "different wire framings". That understated it: there were three gaps, and the
framing was the smallest. All three are now fixed, and the fix is verified by running the real
binary rather than by a passing suite.

| Was broken | Fix |
|---|---|
| **The node binary never connected.** `main.rs` loaded config, logged `roundtable-node ready`, then ended with `let _ = (cfg, state, token); Ok(())`. `HubClient` was real and tested, but nothing constructed it — the binary reported success and did nothing. | `main.rs` now builds a transport factory and constructs `HubClient`, then drains `next_event()` for the life of the process. |
| **No WebSocket transport existed.** The only `HubTransport` was `TcpHubChannel` (raw TCP, NDJSON) with no tungstenite dependency, while the hub, the architecture, and nginx all assume outbound WSS. `hub_url` and the `ws://` fixture were aspirational. | `WsHubChannel` added (`tokio-tungstenite`, rustls). The factory picks WS for `ws://`/`wss://` and keeps raw TCP for a bare `host:port`, so the local fixture path still works. |
| **The framings differed.** | Moot: the Node hub was written to the Rust node's framing — `{version, event_id, sent_at_ms, type, payload}` with a nested payload — so both now speak it. |

**Verification (not a test — the actual binaries):** the real `roundtable-node` was run against a
live Node hub with `hub_url: ws://127.0.0.1:PORT/node/connect`; the node logged
`roundtable-node connecting` and stayed up, and the hub's own `/api/nodes` returned
`{"connected":1}`.

Two implementation notes worth keeping:

- The driver requests a transport **synchronously** (`(self.transport_factory)()`) while dialling a
  WebSocket is async, so `main.rs` uses `block_in_place` + `Handle::block_on`. That needs the
  multi-thread runtime (`#[tokio::main]` provides it) and runs once per connect attempt, not per
  frame. Changing the factory to return a future would be cleaner but breaks every existing
  `HubClient::new` caller.
- The node previously installed **no tracing subscriber**, so every `tracing::info!` was discarded
  and a connected node was indistinguishable from a wedged one. It now initialises `fmt` +
  `EnvFilter`, defaulting to `info`.

**Still not proven:** a delivery travelling all the way from a browser message to a Codex/Claude
session and back. The transport is up; seat routing on the node side is where that continues, and
the gap there is now measured, not guessed at.

## Node↔Codex seat routing — steps 1–2 done, verified against the real fixture (2026-07-25)

Was previously measured (below, kept for the record) as four undone steps. Steps 1 and 2 are now
implemented and tested against `fixtures/app-server/fake-codex.mjs` — a real child process, not a
mock — with 4 new tests (7 total in `codex.rs`, `roundtable-node` now 24→28,
workspace 62→66, all still 0 failures):

- **Response correlation.** `CodexAdapter` now spawns a reader-loop task on `connect()` that reads
  `stdout_rx` for the process lifetime, resolves pending requests by `id` via a
  `HashMap<i64, oneshot::Sender<...>>`, and routes turn-lifecycle notifications
  (`turn/started`/`turn/completed`/`turn/interrupted`/`turn/failed`) to a seat by reverse-looking-up
  `thread_id` in the `seats` map. `connect()`'s `initialize` call now genuinely awaits its response
  instead of firing and moving on regardless of what came back.
- **`execute(seat_id, CodexCommand) -> NodeResult<Value>`** exists and sends the real methods —
  `thread/list`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt` — plus a
  **new `CodexCommand::CreateThread` variant** for `thread/start`, which the enum had no way to
  reach before this: the old set could `StartTurn` on an existing `thread_id` or `ResumeThread`,
  but nothing could create a seat's first thread.
- **A real bug was found and fixed in `subscribe()`**, unrelated to routing but blocking every test
  above: the old mpsc-based version built a fresh `(tx, rx)` pair per call and returned `rx`, but
  `tx` was a local variable dropped when the function returned — every receiver handed to a caller
  was orphaned before its first event, and nothing had ever exercised this path against real events
  before today. Replaced with a `tokio::sync::broadcast` channel, where `subscribe()` can be called
  any number of times and each caller gets a genuinely live receiver.
- **A real ordering race was found and documented, not hidden:** for a brand-new thread, the
  fixture's `turn/started` notification arrives on the wire *before* the `thread/start` response
  that `execute()` is waiting on to learn the `thread_id` — so `notification_to_event` has no seat
  to route it to yet and correctly drops it. Only the later `turn/completed` (after the mapping
  exists) is deliverable. This is inherent to the protocol shape, not a test artifact; the test
  (`create_thread_round_trips_and_routes_events_to_the_seat`) asserts the real outcome rather than
  the hoped-for one, and the fix (a "pending creation" table keyed by request_id, to buffer an
  early notification until its create resolves) is not implemented.

**Still not done — step 3, the one that actually connects a hub delivery to a Codex turn:**

- `main.rs`'s event loop still handles only 2 of 5 `HubEvent` variants (`HelloAccepted`, `Ping`).
  `DeliveryAssign`, `ApprovalResolve`, and `SeatDetach` still fall into the catch-all and go
  nowhere. `main.rs` still never constructs a `CodexAdapter` — nothing wires the hub client to it.
- Agent text-delta notifications are not handled: `CodexEvent::body` is deliberately left empty,
  because App Server's real field shape for streamed message content is not in the fixture or the
  architecture doc, and guessing it would repeat the exact mistake this section exists to avoid.
- Approval requests and `tool/requestUserInput` are not handled at all.

Closing this needs a `DeliveryAssign` handler in `main.rs` that looks up or creates the seat's
`CodexAdapter`, calls `execute()` with `CreateThread` or `StartTurn`/`SteerTurn` as appropriate,
and forwards the resulting `CodexEvent`s back to the hub — plus the `ApprovalResolve`/`SeatDetach`
handlers. Do not report "the node talks to Codex" without re-checking this list; the previous
version of it undersold nothing, but re-verify after any further change rather than trusting a
memory of this paragraph.

`PROTOCOL_VERSION` widened `u8 → u16` in the absorbed protocol; `NodeError::ProtocolVersion` was
widened to match.

## Corrected claims

- **The push history is TRUE. An earlier revision of this file wrongly called it fabricated —
  that was my error, now corrected.** README, SUMMARY, and CHANGELOG assert a push to
  `github.com/Orthic-Labs/roundtable` at `3455587`, `2b3c0c2`, `2c3140f`, `6e5ac7a`, `210047f`.
  **All five commits exist in this repository and are ancestors of `main`.** The earlier check
  was run from a checkout that was not connected to this remote — the `roundtable/` directory sat
  inside the `bogusyogi/claude` workspace with no `.git` of its own, so `git cat-file` resolved
  against the wrong repository and reported the commits absent. The claim was always accurate;
  the verification was pointed at the wrong place. Lesson recorded here because "verified absent"
  is only as good as the repo you verified against.
- **`.agent/reconcile.json`**, cited by all three docs, does not exist. The real file is
  `.agent/stale.json`.
- **`.agent/okf/*.md` is stale in both directions** and predates this absorption: it cites hub
  source files that only now exist, and calls `roundtable-node` an "empty placeholder" when it is
  a 1,409-line crate. Regenerate it before trusting it.

## Deployment is NOT ready (Task 11)

Task 11 is gated by the architecture as production mutation requiring an explicit `DEPLOY TASK 11`
dispatch. Independently of that gate, there is nothing deployable yet:

| Required by spec | Reality |
|---|---|
| `ops/nginx-roundtable.conf` | **written** — includes the Dockerfile `COPY` check that must pass before any rebuild |
| `ops/ecosystem.config.cjs` | **written** — pm2, replacing the systemd unit; the box runs 15 other Node services this way |
| `ops/backup.sh` | **written and smoke-tested** — `.backup` + `integrity_check` + sha256, single self-contained artifact |
| `ops/install-macos.sh`, `ops/install-windows.ps1` | missing — these install the *node* agent, not the hub |
| Serving the PWA | **done** — hub serves the built PWA; index no-store, hashed assets immutable, SPA fallback |
| Build location | **moot for the Node hub** — nothing to compile. `git pull` + `pm2 restart`. |

On 2026-07-25 a deploy was attempted before checking any of this: a Rust toolchain was installed on
the production box and a release build started, against a box running 17 live pm2 services. Both
were removed (~0.6G). Nothing was served and no live service was affected, but the check should
have come first.

## Node hub — in progress (2026-07-25)

The port is underway at `tools/roundtable/packages/hub/`. **76 tests, 0 failures**, run with
`node --test 'tools/roundtable/packages/hub/src/*.test.mjs'`.

| Slice | State |
|---|---|
| `src/wire.mjs` | done — envelope matching the Rust node exactly; all 5 hub→node and 7 node→hub frames |
| `src/store.mjs` | done — applies `0001_initial.sql` verbatim; request-dedupe contract ported |
| `src/ws.mjs` | done — hand-rolled RFC 6455 server; text/ping/pong/close/continuation, all 3 length forms |
| `src/auth.mjs` | done — `__Host-roundtable`, sha256, constant-time compare, origin guard |
| `src/server.mjs` | **all 16 routes implemented** — rooms, seats, messages, handoffs, approvals, nodes |
| `main.mjs` | done — smoke-tested standalone: starts, creates the WAL database, serves `/healthz`, login 200 |
| handoff / approval / nodes handlers | done — handoff is one transaction; approvals resolve once |
| delivery dispatch + reconnect replay | done — verified e2e over a real WebSocket |
| durable event log | done — monotonic cursor, targeted vs broadcast |
| serving the PWA | **done** — verified against a live hub |

**Zero dependencies, and that is forced rather than stylistic.** `node:sqlite` (built in since Node
22.5; the box runs v26), `node:http`, `node:crypto`, and a hand-rolled WebSocket server because
`ws` cannot be installed — pnpm is blocked locally as a broken release and npm fails on certificate
trust. The upside is that deployment has no build step at all.

The Rust hub stays in the tree and green (62 tests) until the Node one replaces it. Nothing is
broken mid-port.

## Hub language — why the port (decided 2026-07-25)

The hub is Rust because the architecture put hub and node in one workspace so the protocol types
are defined once and compile-checked on both ends.

**That justification is not currently being delivered.** Node and hub speak different wire
framings (see the gap above): `WsEnvelope` flattens its event, node's client expects a nested
`payload` under a `type` tag. The shared-type benefit is fictional today, so the project is paying
Rust's deployment cost and collecting none of its upside.

Against Rust, for the hub specifically:

- **It is I/O-bound, not CPU-bound.** WebSocket fan-out, SQLite writes, HTTP — for one operator
  with 2–4 machines, Rust's performance advantage is irrelevant.
- **The box is a Node box.** 15 of 17 pm2 services run `node`, one `bash`, one binary. A Node hub
  is `git pull` + `pm2 restart`, identical to how `rightsites` already deploys.
- **There is no deployment path.** No building on the box, no CI, `arm64` Mac vs `x86_64` box, and
  no cross toolchain installed. Shipping a Rust binary requires adding tooling somewhere.

For Rust, and not to be dismissed:

- The hub is **written and tested** — 24 tests across auth/delivery/http/reconnect, plus a ~2,000
  line store with 9 tests. A rewrite discards that and reintroduces solved bugs.
- **`roundtable-node` should stay Rust regardless.** It runs invisibly at login on Mac and Windows,
  wants a single binary with no runtime, and touches the OS keychain. That is Rust earning its
  keep; the hub is not.

**Why this keeps surfacing:** a Rust hub means an `x86_64-unknown-linux-gnu` binary has to come
from somewhere. There are exactly three sources and all three are closed — build on the box (ruled
out), build in CI (ruled out), cross-compile from the Mac (`arm64`, no `zig`/`cross`/`docker`
installed). The language choice *is* the deployment problem.

**Measured weight of a Rust build** (2026-07-25): `target/` 1.6G debug+tests, `~/.cargo` 1.9G, 138
crates in the lockfile. The partial build on Hetzner had already written 276M of `target/` plus a
356M toolchain before it was killed. Hosting a Rust hub on that box means carrying ~1.5–2G of
toolchain, registry cache, and build artifacts permanently, and contending for 4 cores with 17 live
services on every deploy.

**Recommendation: port the hub to Node/TypeScript. Keep `roundtable-node` in Rust.**

An earlier revision of this file said "do not rewrite against an unsettled protocol; settle the
wire framing first." That was wrong and is withdrawn. The framing gap is not a blocker to the
port — it is *resolved by* the port. The Rust node is written, tested, and staying, so its framing
(`{version, event_id, sent_at_ms, type, payload}`) is the one that survives; the new hub is simply
written to speak it. Doing the port is what settles the protocol, so there is no double work to
avoid.

The port's real price is the ~2,000-line store and ~960-line hub with their 33 tests. That is
mitigated by the schema already existing (`migrations/0001_initial.sql` is the contract) and the
protocol already being specified — a Node hub over `better-sqlite3` re-expresses known SQL against
a known wire format rather than designing anything new.

What the port buys, permanently: no toolchain, registry cache, or build artifacts on the server; no
cross-compilation; and `git pull` + `pm2 restart` deployment, identical to the 15 Node services the
box already runs.

## Genuinely-absent spec items

Verified still absent:

- Hub adoption of `rightkit-logs`
- `MessageKind::SeatInterrupt` + interrupt handler
- `ApprovalResolution::AfterCancel` + cancel-while-waiting-approval flow
- `DeliveryRecord.no_rollback` enforcement
- `tools/roundtable/ops/observability.md` (`ops/` is an empty directory; Task 11 not started)
- End-to-end acceptance (Task 12)

## Build environment notes

- **The cargo workspace lists members explicitly** rather than globbing `crates/*`. The glob
  picked up tooling scratch directories (`.claude/.cc-writes`) and failed the entire workspace
  with "failed to load manifest for workspace member". Add new crates to the list.
- **npm works. An earlier revision of this file wrongly said it did not — corrected 2026-07-25.**
  `pnpm@11.12.0` is genuinely blocked locally as a broken release, but `npm install` succeeds (170
  packages), `vite build` succeeds (24 modules, 205KB), and `vitest` passes **10/10**. The earlier
  "npm fails on certificate trust" conclusion came from `ERROR: failed to copy trust settings of
  system certificate` lines, which are **shell-init noise printed by unrelated commands** — they
  appear on a plain `node -e` too — not an npm failure. Filter them (`| grep -v 'trust settings'`)
  rather than treating them as a fault.
- The hub itself remains dependency-free regardless; only the PWA build needs npm.

## Next action

Stage 0 of [`2026-07-25-roundtable-synthesis-three-rings.md`](./2026-07-25-roundtable-synthesis-three-rings.md)
is complete: the repository is reconciled, single-branch, and every implementation is on `main`.
The next engineering step is the node↔hub wire alignment above, which is also the natural first
slice of Phase 1 (instrumenting one orchestrator→executor edge).
