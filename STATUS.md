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

One integration gap is real and documented rather than papered over: **the node client and the
hub speak different wire framings** (see below). Both compile and both pass their own tests; they
have never been tested against each other.

## Measured test counts on `main`

| Component | Tests | State |
|---|---|---|
| `roundtable-protocol` | 5 | real — locked v1 types, canonical JSON |
| `roundtable-store` | 9 | real — 66KB implementation over the 11-table schema |
| `roundtable-hub` | 24 | real — axum: auth, http, router, state, ws + 4 integration suites |
| `roundtable-node` | 24 | real — Codex JSONL adapter, WS client w/ reconnect, IPC, keyring |
| **cargo total** | **62** | **0 failures** |
| `packages/web` | 2 test files | **unrun** — see build environment, below |
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

## Known gap: node and hub speak different wire framings

This is the one place the two eras did not reconcile, and it is deliberately **not** hidden
behind a compiling build:

- `roundtable_protocol::WsEnvelope` (hub side) is `{version, event_id, sent_at_ms, ...flattened
  event}` — the event fields sit at the top level, discriminated by a `type` tag.
- `roundtable-node`'s client expects `{version, event_id, sent_at_ms, type, payload: {...}}` —
  a *nested* payload.

Node therefore keeps a private `Envelope<T>` in `crates/roundtable-node/src/hub.rs`, documented
in place, rather than importing `WsEnvelope`. This keeps node's 24 tests and its
`fixtures/hub/fake-hub.mjs` honest: they exercise the framing node actually speaks.

**Do not "fix" this by swapping in `WsEnvelope`** without also porting the fixtures and adding a
real node↔hub integration test. Substituting the type alone would produce a green build that
fails on the wire, which is worse than the current explicit gap.

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
| `ops/nginx-roundtable.conf` | missing |
| `ops/roundtable.service` | missing |
| `ops/backup.sh` | missing |
| `ops/install-macos.sh`, `ops/install-windows.ps1` | missing |
| "web assets: embedded in binary" | **not implemented** — the hub has no `rust-embed`/`include_dir`/`ServeDir`; it serves no PWA |
| Build location | **not Hetzner, and not CI** (Adrian, 2026-07-25). See "Hub language" below — there is currently no deployment path for a Rust hub. |

On 2026-07-25 a deploy was attempted before checking any of this: a Rust toolchain was installed on
the production box and a release build started, against a box running 17 live pm2 services. Both
were removed (~0.6G). Nothing was served and no live service was affected, but the check should
have come first.

## Hub language — Rust is probably the wrong choice (open, 2026-07-25)

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

**Recommended sequencing:** do not rewrite against an unsettled protocol. The wire framing is
unresolved, so a port now would be rewritten twice. Settle the framing first, prove the thing runs
end to end, then port the hub to Node/TypeScript and keep the node in Rust — a clean split along
the line where each language actually pays.

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
- **No local package manager currently works for the web package.** `pnpm@11.12.0` (the version
  pinned in the workspace CLAUDE.md) is blocked locally as a broken release; `npm install` fails
  with "failed to copy trust settings of system certificate". The PWA's two test files
  (`App.test.tsx`, `offline.test.ts`) are therefore **present but unrun**. This is a pre-existing
  environment fault, not a Roundtable defect, and it is the reason the web row above reports test
  *files* rather than a test count.

## Next action

Stage 0 of [`2026-07-25-roundtable-synthesis-three-rings.md`](./2026-07-25-roundtable-synthesis-three-rings.md)
is complete: the repository is reconciled, single-branch, and every implementation is on `main`.
The next engineering step is the node↔hub wire alignment above, which is also the natural first
slice of Phase 1 (instrumenting one orchestrator→executor edge).
