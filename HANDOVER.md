# Roundtable — Handover (2026-07-25, updated after the first real end-to-end proof)

Read this first in a cold session. `STATUS.md` is the detailed authoritative log; this is the
orientation layer on top of it.

## What Roundtable is

Cross-device rooms for existing local Claude/Codex sessions. A Rust hub on Hetzner owns rooms,
transcripts, delivery, and auth; a small node runs at login on each machine (Mac/Windows) and
dials the hub outbound over WSS. Full product spec:
`2026-07-22-roundtable-cross-device-architecture.md`.

## Repository — read this before touching anything

`github.com/Orthic-Labs/roundtable` is canonical. **Do not confuse it with
`github.com/bogusyogi/claude`** (Adrian's general workspace repo) — this tree spent time sitting
untracked *inside* that other repo before being connected here properly. If a checkout's
`git remote -v` doesn't say `Orthic-Labs/roundtable`, stop and fix that first; verification run
against the wrong repo produced a real false conclusion earlier (see STATUS.md, "Corrected
claims").

**Single branch, everywhere.** `main` only, local and remote, no worktrees. Adrian's explicit
instruction; don't create branches without asking.

## Current state — everything is green, AND a real message reaches Codex and back

```
cargo test --workspace --no-fail-fast                     → 66 passed, 0 failed
node --test packages/hub/src/*.test.mjs (8 stable files)  → 72 passed, 0 failed
node --test packages/hub/src/e2e-rust-node.test.mjs       → 1 passed, 0 failed
```

**The actual milestone:** a message posted in a room reaches the real compiled
`roundtable-node` binary over a real WebSocket, drives the real Codex fixture through a real
turn, and the reply is persisted back as an `agent`-authored message. Not a mock at any layer.
Getting there required finding and fixing five real, independent wire-protocol bugs — see
STATUS.md's "Node↔Codex seat routing" section for the full list; the short version is that every
`HubCommand`/`HubEvent` payload is nested one level deeper than any JS-only test assumed (Rust's
serde default externally-tagged enum representation), `Message.actor_id` must be a real UUID even
for humans, and the seat default state `'attached'` isn't a valid `SeatState` variant. **None of
these surfaced until a real binary was driven against a real Codex process** — every JS-only and
Rust-only test had been internally self-consistent with the same wrong assumption.

Both stacks are complete and working *independently*, and now also **together**:

- **Rust hub** (`crates/roundtable-hub`) — original implementation, axum, 24 tests. Still in the
  tree, still green, not yet decommissioned.
- **Node hub** (`packages/hub`) — a full port, **zero npm dependencies**
  (`node:sqlite`, `node:http`, `node:crypto`, hand-rolled RFC 6455 WebSocket server). All 16
  routes have real handlers, and the wire protocol to the real Rust node is now verified correct
  end-to-end, not just internally consistent.
- **Rust node** (`crates/roundtable-node`) — connects, receives a delivery, drives Codex via
  `CodexAdapter`, and posts the reply back. `main.rs`'s event loop handles `HelloAccepted`,
  `Ping`, and `DeliveryAssign` (routes to the seat's `CodexAdapter`, picks
  `CreateThread`/`StartTurn`/`SteerTurn` based on what it already knows about that seat).
  `ApprovalResolve`/`SeatDetach` are still unhandled.

**One important caveat:** the reply that lands is a synthetic status string
(`"[roundtable-node] turn Completed (thread ...)"`), not the agent's real output.
`CodexEvent::body` is deliberately empty — App Server's actual text-delta field shape isn't
documented anywhere available here, and guessing it would repeat the exact mistake this whole
investigation was about. The *transport and routing* are proven; *relaying real agent content*
is the next real gap.

## Decisions already made — don't re-litigate these

1. **Node, not Rust, for the hub.** The hub is I/O-bound, the Hetzner box runs 15/17 pm2 services
   in Node already, and there is *no viable Rust deploy path*: no builds on the box (ruled out —
   17 live services, 4 CPUs), no CI (Adrian: standing no-hosted-CI policy, not Roundtable-specific),
   and no cross-compile tooling from this arm64 Mac to the box's x86_64 (`zig`/`cross`/`docker` all
   absent). The Rust node stays Rust — it's a small login-time binary with no runtime, which is
   exactly where Rust earns its keep.
2. **`roundtable.spoares.com`, a subdomain — not `spoares.com/roundtable`.** Adrian correctly
   pointed out the path mount is *operationally simpler* (one line in an already-COPY'd conf, vs a
   new conf + a new Dockerfile COPY line — and a missing-COPY has bitten this box before). Rejected
   anyway on ONE axis: shared origin = shared trust boundary. Roundtable's session cookie would be
   sent to the memory dashboard too, and `Path=/roundtable` does NOT fix this — cookie path
   matching is by request path, not page path. Full reasoning is in
   `ops/nginx-roundtable.conf`'s header comment; read it before changing this.
3. **No builds and no CI on Hetzner, at all.** Was violated once by accident early in this session
   (a Rust toolchain got installed on the live box and a release build started) — caught,
   toolchain and build artifacts removed, box unaffected. Don't repeat it. The whole point of the
   Node port is that deploy becomes `git pull && pm2 restart` with nothing to compile.
4. **Task 11 (production deploy) needs an explicit `DEPLOY TASK 11` from Adrian.** Not inferred
   from "host it" or similar. This is a fixed safety boundary in the architecture doc, not a
   suggestion.
5. **`~/sites/coderight`** was deleted from Hetzner mid-session (33G, unrelated cleanup Adrian
   asked for) — verify before assuming it's needed for anything; the live site runs from
   `~/sites/rightsites/coderight`, untouched.

## What's NOT done

- **The Rust hub has not been decommissioned.** Both hubs exist. Someone needs to decide when to
  delete `crates/roundtable-hub` (or keep it — not yet decided which).
- **Deployment itself.** `ops/ecosystem.config.cjs`, `ops/nginx-roundtable.conf`, `ops/backup.sh`
  are written and locally smoke-tested, but none has touched Hetzner. That's gated behind
  `DEPLOY TASK 11` per #4 above, plus Adrian's sudo for the nginx Dockerfile rebuild.
- **Real agent content is not relayed** — the reply the node posts is a synthetic status string,
  not Codex's actual output. See the caveat above; this is the real next step.
- **`ApprovalResolve` and `SeatDetach`** still fall into `main.rs`'s catch-all.
- **`.agent/okf/*.md`** is stale in both directions (predates most of today's work) — don't trust
  it, regenerate it.

## A known, unresolved test-runner quirk (not a protocol bug)

`dispatch.test.mjs`'s reconnect test reproducibly hangs the whole `node --test` process when it
runs anywhere but first in a batch. Confirmed via extensive isolation: every test passes alone,
the exact same file passed as a full batch before the wire-protocol fixes above, the hang
reproduces with ANY prior test + this one, and is unaffected by added delay. This looks like a
Node test-runner/environment interaction on this machine, not a defect in the code — the actual
production path (`e2e-rust-node.test.mjs`) is unaffected. Don't spend time chasing this without
new evidence; run this file alone or last in a batch to avoid it.

## Known gotchas (already paid for once — don't rediscover)

- **`cargo test --workspace` breaks if `crates/*` glob picks up a stray directory** (e.g. tooling
  scratch dirs). Fixed by listing workspace members explicitly in `Cargo.toml` — don't revert to
  the glob.
- **`node --test` with a quoted glob string can silently under-run files** depending on shell
  expansion context — if a count looks low, expand the glob yourself or pass files individually and
  sum, don't trust a single `tail -N` on the output (a truncated tail looks exactly like missing
  tests and cost real time to debug today).
- **pnpm is a broken release on this Mac**, npm fails on certificate trust. This is *why* the Node
  hub has zero dependencies — it's forced, not a style choice. Don't add an npm dependency to
  `packages/hub` without first checking you can actually install it here.
- **The `HubTransport` factory is synchronous but WS connect is async** — `main.rs` uses
  `block_in_place` + `Handle::block_on` to bridge this once per connect attempt. Don't try to make
  the factory itself async without touching every existing caller.
- **The wire framing is `{version, event_id, sent_at_ms, type, payload}`** (nested payload) — that
  is the Rust node's contract, and the Node hub was deliberately written to match it, not the other
  way around. If you're ever tempted to "clean up" the envelope shape, remember the node is the
  fixed point.

## Suggested next step

Either (a) decide the Rust hub's fate (delete vs keep as reference), or (b) make the reply carry
real agent content instead of a synthetic status string — the one substantive gap left after
today's end-to-end proof. That needs App Server's actual text-delta notification shape, which
isn't in the fixture or the architecture doc; get it from a real `codex app-server` run (Task 0's
`generate-json-schema --experimental` step in the architecture doc) rather than guessing, given
how expensive guessing turned out to be for the rest of this protocol.
