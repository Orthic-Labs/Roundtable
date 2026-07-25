# Roundtable — Authoritative Status

**This file is the single source of truth for what is implemented.** Where README.md,
SUMMARY.md, CHANGELOG.md, `docs/*.md`, or `.agent/okf/*.md` disagree with this file, this file
wins. Regenerate or correct them; do not resolve the conflict in their favour.

- **Repository:** `github.com/Orthic-Labs/roundtable` — the canonical home. This tree previously
  sat inside the `bogusyogi/claude` workspace with no `.git` of its own; it is now a proper
  checkout of this remote. Roundtable work happens here, not in the workspace repo.
- **Measured:** 2026-07-26, clean checkout of `main`.
- **Method:** `cargo test --workspace` and `node --test src/*.test.mjs` from `main`, plus a real
  deployment driving a real `codex app-server`. Static inspection for anything not covered.
- **Branch policy:** `main` is the **only** branch, locally and on the remote. All prior branch
  work has been absorbed into it (below). Do not create branches or worktrees.

## Bottom line

**DEPLOYED AND WORKING, BOTH PROVIDERS.** The hub runs on Hetzner under pm2, the Mac node runs
under launchd. A message to a Codex seat reaches a **real `codex app-server`** and comes back as
the agent's real reply; a message to a Claude seat reaches a connected channel over the node's
0600 unix socket and its reply posts back. Verified live on 2026-07-26 — `mac-codex` and
`mac-claude` answering in the same room, read back out of the production database.

**76 cargo tests, 0 failures. 107 Node hub tests, 0 failures** — and as of 2026-07-26 all 107 run
in ONE command again: `node --test src/*.test.mjs`. The "97 + 3" split is retired; the residual
wedge is fixed and its cause identified. See "The test-runner hang".

**`https://roundtable.spoares.com` is live** — nginx vhost built and serving, the PWA loads, and
the Mac node connects over `wss://` with no tunnel. Nothing is outstanding on deployment.

## Deployed state (2026-07-26)

| Piece | Where | State |
|---|---|---|
| Hub | Hetzner, pm2 `roundtable-hub`, `172.22.0.1:8460` | running, restart-safe, `pm2 save`d |
| Database | `~/.local/share/roundtable/roundtable.sqlite3` | WAL, migration guarded by `user_version` |
| Backups | `~/backups/roundtable`, cron 04:15 daily | verified: real backup taken, contents confirmed |
| PWA | built on the Mac, rsynced to the box | served by the hub at `/` |
| Node (Mac) | launchd `com.orthiclabs.roundtable-node` | running, auto-starts at login |
| Codex | `/opt/homebrew/bin/codex app-server` | real, answering |
| nginx vhost | built and serving `roundtable.spoares.com` | live (TLS via the spoares.com wildcard) |
| ufw | `allow 8460/tcp from 172.16.0.0/12` | required — the container could not reach the hub without it |

Enrolment is `ops/enrol-node.mjs` (node / room / seat / list) — deliberately a box-side CLI, not an
HTTP route, because it mints credentials.

## Measured test counts on `main`

| Component | Tests | State |
|---|---|---|
| `roundtable-protocol` | 5 | real — locked v1 types, canonical JSON |
| `roundtable-store` | 9 | real — 66KB implementation over the 11-table schema |
| `roundtable-hub` | 24 | real — axum: auth, http, router, state, ws + 4 integration suites |
| `roundtable-node` | 36 | real — Codex adapter against the REAL generated schema, WS client w/ reconnect, IPC, keyring |
| **cargo total** | **76** | **0 failures** |
| `packages/hub` | **107** | green — the full run is one command again since the wedge was fixed |
| `packages/web` | 10 | real PWA — builds (24 modules, 205KB) and serves from the hub |
| `packages/claude-channel` | 2 | builds; the node routes Claude deliveries to it and posts its replies |

## What real Codex found that the fixture never could

Pointing the node at a real `codex app-server` for the first time immediately found three bugs that
every green test had missed, because the fixture was internally consistent with the same wrong
assumptions:

1. **A stderr deadlock.** The child's stderr was piped and never read. A piped stream nobody drains
   fills its ~64KB kernel buffer and blocks the child forever on its next write. Real Codex starts
   several MCP servers and logs plenty: the handshake succeeded and then `thread/start` hung until
   it timed out, with no error anywhere. The fixture logs nothing, so no test could have caught it.
2. **`initialize` was missing `clientInfo.version`**, which `ClientInfo` requires. Real Codex
   rejects the handshake outright. The fixture accepted the short form.
3. **`active_turn_id` was never cleared on turn completion**, so the SECOND message to any seat took
   the steer path and real Codex rejected it with "no active turn to steer" — every follow-up
   message to a seat was silently lost.

And three more found by deploying rather than by testing:

4. **`flushDeliveries()` was only ever called by tests.** A deployed hub accepted messages and
   dispatched nothing, forever. There is now a real dispatch loop plus an immediate flush on node
   connect.
5. **The migration re-ran on every open**, so the hub started once on a fresh database and died on
   its first restart. Guarded by `user_version`, with an adoption path for databases written before
   the guard existed.
6. **Node tokens were never verified.** The hub checked only that the `node_id` existed, so anyone
   knowing a UUID could receive that node's deliveries — each carrying a room transcript — and post
   as its seats. Revoked nodes were admitted too. Found before the vhost went live, so it was never
   reachable from the internet.
7. **A stale connection swallowed deliveries.** Nothing enforced one connection per node, and
   `dispatch()` sends to the first match and reports success. After a dropped tunnel the hub held a
   dead socket alongside the live one and fed it every delivery. Two posted messages vanished —
   marked `sent`, never received, no error. A completing hello now supersedes any earlier
   connection for that node.

## The test-runner hang — SOLVED 2026-07-26 (five real defects, no environment quirk)

Long treated in this repo as a machine/environment quirk. It is not: every cause found so far has
been a real defect, and one of them was a production defect.

**Fixed:**

1. **The hub could not shut down.** `close()` sent WebSocket close frames and called
   `server.close()`, which waits for every existing connection to end — and a WebSocket holds its
   socket open by design. SIGTERM stalled identically in production. Now destroys sockets.
2. **`WsConnection` had no `destroy()`.** Only a polite `close()` that waits for the peer's
   closing handshake. An upgraded socket is detached from the HTTP server, so
   `closeAllConnections()` cannot reach it either — a peer that never answers pinned the process.
3. **`close()` only knew about handshaken nodes.** A connection that upgraded but never sent
   `node.hello`, or one that was superseded and removed from `nodeConnections`, was tracked
   nowhere. Now every upgraded connection is tracked in `allConnections` and destroyed on close.
   Supersede also destroys rather than politely closing — a superseded peer is by definition not
   answering.
4. **A frame race in `dispatch.test.mjs`.** It awaited `hello.accepted`, then awaited the next
   frame with a fresh `once()`. On reconnect the hub sends both in the same tick, so the second
   was lost and the test waited forever for a message already delivered. The helper now collects
   frames from socket open and exposes `waitFor(type)`. This file went from 3 passing tests to
   all 11.

5. **The residual wedge was a flaky ASSERTION in `replay.test.mjs`, not a leak.** This is the one
   this file called "not solved" for weeks, and the diagnosis was backwards: the unclosed server
   was the *symptom*, not the cause.

   `rule 8: a terminal delivery is never reinjected on reconnect replay` asserted
   `assert.equal(hub.flushDeliveries(), 1)`. But the hub **also** flushes on node connect, from a
   deferred `setTimeout(..., 0)` in `server.mjs` (deferred so `hello.accepted` reaches the wire
   first — the node drops the connection if any other frame precedes it). That auto-flush races
   the test's manual flush, and whichever arrives second finds nothing left to send and returns 0.
   So the assertion was really asserting *which of the two won*, which is not the rule under test.
   It lost about one run in three.

   When it lost, the test threw **before** its trailing `await hub.close()` — so the hub stayed
   listening with two live sockets, and `node --test` could not exit. That is the exact
   `TCPServerWrap: 1` + `TCPSocketWrap: 2` signature recorded below.

   Two changes, both in `replay.test.mjs`: the assertion now checks the precondition that actually
   matters (`store.getDelivery(...).state === 'sent'` after a synchronous flush — true regardless
   of which path dispatched it), and every test registers `t.after(() => hub.close(); store.close())`
   so cleanup runs on failure too. A failing test now *reports* instead of wedging the runner.

**Measured before the fix** (clean checkout, macOS, Node v26.4.0):

| Command | Result |
|---|---|
| `node --test src/*.test.mjs` | wedged 2 of 3 runs |
| same, excluding `replay.test.mjs` | 97/97 |
| `node --test src/replay.test.mjs` alone | wedged 1 of 1 with the probe attached |

**Measured after the fix, same machine:** `node --test src/replay.test.mjs` → **12 clean runs of
12**. `node --test src/*.test.mjs` → **8 clean runs of 8, 100 passed, 0 failed**.

**Practical guidance:** run the whole thing in one command — `node --test src/*.test.mjs`. The
"97 + 3" split is retired. Do not reinstate the old "run dispatch.test.mjs first" advice either;
that diagnosis was wrong too.

One attempted fix was reverted rather than kept, and should stay reverted: `server.unref()` plus a
bounded `setTimeout` resolve made it worse (3 hangs in 8) and resolved `close()` before the server
had actually closed, which is a semantics regression. It was treating the symptom.

## The node read path — `node.query` / `query.result` (added 2026-07-26)

`transcript.read`, `transcript.search` and `handoff.create` returned "not implemented" over IPC
because the node holds neither a transcript nor a room roster; it only ever sees the deliveries
addressed to it. They now work, over a read path added to the existing node socket.

**Why a new frame pair and not HTTP.** The hub's REST API authenticates by session cookie, minted
from the admin token. Letting a node use it would mean handing every node an operator credential —
the wrong trust boundary for a machine that is only supposed to run one agent. The node is already
authenticated on its WebSocket, so the read path goes there.

**Shape.** `NodeFrame.QUERY` (`node.query`) carries `{ request_id, query: { <kind>: {...} } }` and
is answered by exactly one `HubFrame.QUERY_RESULT` (`query.result`) carrying
`{ request_id, ok, result, error }`. Kinds: `transcript_read`, `transcript_search`, `roster_read`.
This is the **only** request/response pair in the protocol — every other node command is
fire-and-forget and resolves as soon as its bytes are written (see `handleNodeMessagePost`), which
is exactly why reads needed something new rather than reusing an existing frame.

**Authorisation.** The hub answers only for rooms the node holds a seat in
(`store.nodeHasSeatInRoom`). Without that, one node could read every transcript on the hub. An
unknown room and an unauthorised one both return `room_not_accessible`, so a node cannot use the
error to probe which rooms exist.

**Correlation and failure.** The node keeps `pending_queries: HashMap<Uuid, oneshot::Sender<...>>`,
registered *before* the frame is written (the answer can arrive the instant the bytes land). Every
path answers: an unknown query kind, a refusal, a write failure, and a dropped connection all
resolve the waiting caller with an error. That caller is a blocking MCP tool call inside a live
agent session, where silence is indistinguishable from a hang.

**`handoff.create`** reads the roster per handoff rather than caching it. A cached roster is stale
exactly when it matters — a seat added or detached mid-session — and a handoff to a stale `seat_id`
fails silently. It shares `message.reply`'s precondition: the node must be holding a delivery for
the originating seat, otherwise there is no room to resolve the alias against.

**`node.handoff.create` was decoded by nobody, exactly like `seat.interrupt`.** The frame was in the
wire vocabulary and the node had always sent it, but the hub's message handler had no branch for it:
it decoded, matched nothing, and fell on the floor. Because the node resolves its caller as soon as
the frame is written, an agent was told its handoff succeeded while no row was ever written. Found
by reading the production database after a live handoff returned `ok: true` — the node's answer was
truthful about what it did (wrote the frame) and useless as evidence the handoff happened. Fixed
with `handleNodeHandoffCreate`, which enforces the same boundary as every other node-authored
action: a node may only hand off FROM a seat it owns.

**Two node processes on one machine = an endless supersede loop.** Hit while debugging this: a
foreground `roundtable-node` run overlapping the launchd agent produced
`node.superseded` → `node.disconnected` → `node.connected` every ~2.3s forever, since each
connection evicts the other's. The node's IPC socket also ends up stale — the file exists and
`connect()` gets ECONNREFUSED, because the process that bound it is no longer the one that owns the
path. Symptom to recognise: a repeating supersede triple in the hub log for ONE `node_id`. Check
`ps aux | grep roundtable-node` before assuming a code defect; the fix is to leave exactly one
process running.

**Verified in production, 2026-07-26**, against the deployed hub over `wss://` — not in a fixture:

| Probe over the live IPC socket | Result |
|---|---|
| `transcript_read` on room `main` | `ok`, 3 real messages out of the production database |
| `transcript_search` for `"ROUNDTABLE"` | `ok`, 5 hits |
| `transcript_search` for text that is absent | `ok`, 0 hits |
| `transcript_read` on a room this node has no seat in | refused, `room_not_accessible` |
| `handoff_create` with no delivery in flight | correct precondition error, not "not implemented" |
| `handoff_create` WITH a delivery in flight | alias `mac-codex` resolved to its real seat_id, handoff row written to the production DB, wake message posted with `kind='handoff'`, and **the real Codex agent woke and replied into the room** |
| `ping` | `pong` |

Two seam defects were found and fixed while wiring this, both previously unreachable because the
methods were stubs: `packages/claude-channel` sent `since_seq` where the node reads `after_seq`
(an `Option`, so serde filled it with `None` and every read silently restarted at 0), and it sent
`to_seat_id` where the node expects `to_alias`. Agents know each other by alias, never by UUID.

## Also fixed 2026-07-26 — `seat.interrupt` was decoded by nobody

`HubEvent::SeatInterrupt` was fully handled in `main.rs`, and the hub sent the frame on every
operator cancel, but `hub.rs`'s reader match never listed `"seat.interrupt"` among the kinds it
decodes. Every cancellation fell through to the catch-all and was dropped with a single
"unrecognized hub frame kind" line. Cancellation looked implemented end to end and did nothing on
the node. One missing match arm; found while adding `query.result` to the same list.

## Decisions

- **The Rust hub (`crates/roundtable-hub`) stays, as reference only.** The Node hub is what is
  deployed. Deleting the Rust one now would be premature: `crates/roundtable-store`'s migration IS
  the schema contract the Node hub loads at runtime, so that crate cannot go, and the Rust hub's 24
  integration tests encode the protocol contract the Node port is checked against. The Node hub is
  days old and this week alone found seven defects in it. Revisit after ~30 days of stable
  operation; until then the cost is a compile, not a risk.
- **`tool/requestUserInput` does not exist** in this Codex protocol version — verified absent from
  the full generated schema. The architecture doc's reference to it predates this App Server.
  Approvals run through a Guardian auto-review instead (`item/autoApprovalReview/*` plus
  `thread/approveGuardianDeniedAction` as the human override), which is what is implemented.
- **npm works on this Mac after all** (`packages/claude-channel` installed 99 packages cleanly on
  2026-07-26). The "npm fails on certificate trust" note in older docs is stale for this path. The
  Node hub stays dependency-free regardless — that is now a deliberate property, not a workaround.

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

## Node↔Codex seat routing — CLOSED end-to-end, real content relaying (2026-07-25/26)

**Proven, not asserted:** a message posted to a room reaches the real compiled `roundtable-node`
binary over a real WebSocket, drives the real `fake-codex.mjs` App Server process through a real
turn, and the resulting reply — now the agent's real content, not a synthetic status ping — is
persisted back in the store as an `agent`-authored message. Verified two ways — a plain repro
script with full unbuffered logs, and the tracked `e2e-rust-node.test.mjs` (1/1 pass, ~950ms,
asserting the literal reply text `"echo: say hello"`). `cargo test --workspace`: 67/67. The other
9 hub test files together: 73/73.

This took five real, independent bugs to close, all found only because a REAL binary was driven
against a REAL Codex process — no amount of JS-only or Rust-only testing surfaced any of them,
because each side's tests were internally self-consistent with a wrong shared assumption:

1. **The hub never sent `hello.accepted` at all.** The real node's handshake requires it as the
   literal first frame or it fails the connection outright.
2. **The handshake direction was backwards once added.** The hub sent `hello.accepted`
   unprompted, keyed off a `?node_id=` query parameter the real client never sends. The real
   sequence is: node connects, sends `node.hello` first, hub replies.
3. **Every `HubCommand` payload is wrapped one level deeper than assumed.** `Hello`,
   `DeliveryAck`, `MessagePost` etc. are Rust enum variants with
   `#[serde(rename_all = "snake_case")]` and no explicit tag — serde's default externally-tagged
   representation nests each variant's fields under its own snake_case key, e.g.
   `{"hello": {node_id, ...}}`, not `{node_id, ...}` flat. The same is true in the hub→node
   direction: `HubEvent::DeliveryAssign` needed the full field set (`delivery`, `message`,
   `parent`, `context_messages`, `room_slug`, `room_title`, `room_objective`, `seats`), wrapped
   under `delivery_assign` — not the two-field flat shape every JS test had been asserting on.
4. **`Message.actor_id` is typed `Uuid`.** A human-readable placeholder like `'adrian'` (used
   throughout the JS test suite, including this file's own examples) fails deserialization with
   `UUID parsing failed`. Every actor, human included, needs a genuine UUID on the real wire.
5. **`store.mjs`'s seat default state, `'attached'`, isn't a valid `SeatState` variant.** The real
   enum is `detached/offline/idle/running/waiting_approval/error`; fixed to default `'idle'`.

None of these surfaced as a compile error or an assertion failure in isolation — each failed
**silently**, which is itself the sixth finding: `roundtable-node`'s event-reader loop dropped any
undeserializable `HubEvent` via bare `.ok()`, with zero logging. Every failure above was invisible
until a `warn!` was added at that exact point (now permanent, not diagnostic scaffolding) — this
is why the investigation took as long as it did, and is the single highest-leverage fix in this
list for anyone debugging this protocol in the future.

A seventh, unrelated but equally real bug was found along the way: an abrupt node disconnect
(`ECONNRESET` — a network blip, or a killed process) crashed the **entire Node hub process**, not
just that connection. `WsConnection` re-emits socket errors on itself, and Node's `EventEmitter`
throws if `'error'` has no listener. Fixed with a no-op `conn.on('error', () => {})` in
`attachWebSocket`.

**Two more real bugs, found 2026-07-26 by generating the actual protocol schema instead of
continuing to guess.** Ran `codex app-server generate-json-schema --experimental --out <dir>`
against a real, locally-installed `codex` CLI — the architecture doc's own Task 0 step, done for
real, persisted at `fixtures/app-server/schema/`. Comparing it against `codex.rs` and
`fake-codex.mjs` surfaced:

8. **`turn/started`/`turn/completed` carry a nested `{threadId, turn: {id, status}}`, not a flat
   `turnId`/`status`.** `notification_to_event` was reading fields that don't exist at that level;
   fixed to read `turn.id`/`turn.status`. Real `TurnStatus` values are
   `completed | interrupted | failed | inProgress`.
9. **`input` params (`thread/start`, `turn/start`, `turn/steer`) are an array of `UserInput`
   (tagged union), not a bare string.** `codex.rs` was sending `{"input": "hello"}`; a real App
   Server would reject or mishandle this. Fixed via a `text_input()` helper that wraps every
   outgoing input as `[{"type":"text","text": ...}]` at the wire boundary — `CodexCommand`'s own
   fields stay plain `String`, unaffected.

Neither of these had failed a test before, because `fake-codex.mjs` was internally consistent with
the same wrong assumptions `codex.rs` made — exactly the pattern behind bugs 1-7 above. Fixing them
also closed the real gap this file previously flagged as open: `item/completed` notifications
where `item.type == "agentMessage"` now route through with the real `item.text`, and
`main.rs::handle_codex_event` relays that text as the room reply instead of always synthesizing a
status line. `fake-codex.mjs` was rewritten to emit the real sequence
(`turn/started` -> `item/completed` -> `turn/completed`), and the corresponding unit tests
(`create_thread_round_trips_and_routes_events_to_the_seat`, plus two new direct-call tests for the
drop paths) were updated to assert against the real shapes rather than the old simplified ones.

**A known, separate, unresolved issue:** `dispatch.test.mjs`'s reconnect test reproducibly hangs
the whole `node --test` process when it runs anywhere but first in a batch — confirmed via
extensive isolation (every individual test passes; the exact same file passed as a full 9-test
batch before these changes; the hang is reproducible with ANY single prior test + this one, and
unaffected by delay length). This looks like a Node test-runner / environment interaction, not a
protocol defect — the actual production code path (the real e2e test above) is unaffected and
passes cleanly. Do not spend further time chasing it without new evidence; running this file
alone, or last in a batch, avoids it.

The four steps below (kept for the historical record) are now ALL implemented and tested against
`fixtures/app-server/fake-codex.mjs` — a real child process, not a mock:

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

**Step 3 is done too.** `main.rs`'s event loop now handles `DeliveryAssign` (routes to the seat's
`CodexAdapter`, choosing `CreateThread`/`StartTurn`/`SteerTurn` based on what's already known about
that seat) and forwards the resulting `CodexEvent`s back to the hub as a `PostMessage`. Verified by
the real round trip described above.

**Real agent content now relays (2026-07-26), grounded in the actual protocol, not guessed.**
Generated the real App Server v2 protocol schema from a locally-installed `codex` CLI
(`codex app-server generate-json-schema --experimental --out <dir>`, persisted at
`fixtures/app-server/schema/`) rather than continuing to guess wire shapes — the architecture
doc's own Task 0 step, run for real. This surfaced two concrete bugs in `codex.rs` and the fixture:

- `turn/started`/`turn/completed` carry `{threadId, turn: Turn}` — a full nested `Turn` object
  (`turn.id`, `turn.status`), not a flat `turnId`/`status`. `notification_to_event` now parses the
  nested shape; `TurnStatus`'s real values are `completed | interrupted | failed | inProgress`.
- `turn/start`'s (and `thread/start`'s) `input` is an array of `UserInput` (tagged union), not a
  bare string. `codex.rs` now wraps every outgoing `input` via a `text_input()` helper at the wire
  boundary (`[{"type":"text","text": ...}]`); `CodexCommand`'s own fields stay plain `String`.
- The real agent reply is `item/completed` with `item.type == "agentMessage"` and a flat
  `item.text` — now routed by `notification_to_event`, carried in `CodexEvent::body`, and relayed
  by `main.rs::handle_codex_event` as a `Chat`-kind message. `fake-codex.mjs` was rewritten to
  emit this real sequence (`turn/started` -> `item/completed` -> `turn/completed`) instead of its
  old simplified shapes, and the real e2e test now asserts the literal reply text
  (`"echo: say hello"`), not a synthetic status string.

**Still genuinely not done:**

- `ApprovalResolve` and `SeatDetach` still fall into `main.rs`'s catch-all and go nowhere.
- `item/agentMessage/delta` (live-streaming chunks) is intentionally not consumed — only the
  completed item's full text is relayed. Other real `ThreadItem` variants (tool calls, file
  changes, reasoning, command execution) are not surfaced as room content at all; they simply
  don't match `notification_to_event`'s `item.type == "agentMessage"` check and are dropped.
- Approval requests and `tool/requestUserInput` are not handled at all.
- The "pending creation" race noted above (an early `turn/started` for a brand-new thread can be
  dropped) is unfixed — now `item/completed` and `turn/completed` for that same first turn are
  also subject to it if they somehow arrived before the create resolves, though in practice they
  don't (they're scheduled ~10ms after `thread/start`'s notification, safely after the mapping
  exists).

Do not report "the node talks to Codex" as more than this without re-checking this list; the round
trip now carries real agent reply content for the common case (a plain-text `agentMessage`), but
several real event types still aren't surfaced.

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

## Deployment — DONE (Task 11), except nginx

Superseded the "Deployment is NOT ready" section this file carried until 2026-07-26. Everything
below is live and verified, not written-and-untested.

| Required by spec | Reality |
|---|---|
| `ops/nginx-roundtable.conf` | written and STAGED on the box as `~/sites/nginx/roundtable.conf`; the Dockerfile `COPY` line and rebuild need Adrian's sudo |
| `ops/ecosystem.config.cjs` | **live** — pm2 `roundtable-hub`, `pm2 save`d, survives restart |
| `ops/backup.sh` | **live** — cron 04:15; rewritten to use `node:sqlite`'s native `backup()` because the sqlite3 CLI is NOT installed on the box and installing it needs sudo. Verified: real backup taken, contents read back |
| `ops/install-macos.sh` | **written and used** — builds, writes 0600 config/token, registers a launchd agent. The Mac node is running under it |
| `ops/install-windows.ps1` | still missing — Windows not started |
| `ops/enrol-node.mjs` | new — node/room/seat enrolment, box-side CLI rather than an HTTP route because it mints credentials |
| Serving the PWA | **live** — built on the Mac, rsynced, served by the hub |
| Build location | **no builds on the box**, as required. Node hub compiles nothing; the PWA is built on the Mac and shipped |

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

Closed on 2026-07-26:

- ~~`MessageKind::SeatInterrupt` + interrupt handler~~ — `seat.interrupt` is wired end to end: the
  hub's cancel route posts it, the node translates it to Codex `turn/interrupt`.
- ~~`ApprovalResolution::AfterCancel` + cancel-while-waiting-approval~~ — implemented; a late
  answer records `approval_resolved_after_cancel` and posts a stale-approval system message.
- ~~`DeliveryRecord.no_rollback` enforcement~~ — enforced by never retracting recorded work, held
  by a test that asserts prior output survives a cancel.
- ~~`ops/observability.md`~~ — written, with a real structured logger behind it.
- ~~End-to-end acceptance (Task 12)~~ — done against real Codex through the deployed hub.

Still absent:

- **Hub adoption of `rightkit-logs`** — `packages/hub/src/log.mjs` is schema-compatible with it but
  is a local zero-dependency implementation. The hub deliberately has no npm dependencies.
- **Claude seat coverage.** Deliveries reach a connected channel and its replies post back —
  verified live, both providers answering in one room. `message.reply`, `transcript.read`,
  `transcript.search`, `handoff.create` and `ping` all do real work as of 2026-07-26. Still
  refused, explicitly: `approval.verdict`, and `session.join/leave` (seats are enrolled with
  `ops/enrol-node.mjs`; the node holds no admin credential to create one).
- **Windows node** — no installer, never built or run on Windows.
- **The node never advances its own replay cursor.** It echoes back whatever the handshake gave it,
  so it always reconnects at 0. Harmless now that the hub refuses to replay terminal deliveries,
  but the cursor is still not doing its job.
- **`item/agentMessage/delta` and most `ThreadItem` variants** are not surfaced (reasoning,
  streaming). Commands, file edits, tool calls, searches and plans are.

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

1. **nginx** — Adrian's sudo, one command (see HANDOVER.md). Until then the node reaches the hub
   over an SSH tunnel rather than `wss://roundtable.spoares.com`.
2. Windows node installer (Adrian is handling the timing).
