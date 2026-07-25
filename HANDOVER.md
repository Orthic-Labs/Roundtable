# Roundtable — Handover (2026-07-26, deployed and answering)

Read this first in a cold session. `STATUS.md` is the detailed authoritative log; this is the
orientation layer on top of it.

## What Roundtable is

Cross-device rooms for existing local Claude/Codex sessions. A hub on Hetzner owns rooms,
transcripts, delivery, and auth; a small node runs at login on each machine (Mac/Windows) and
dials the hub outbound over WSS. Full product spec:
`2026-07-22-roundtable-cross-device-architecture.md`.

## Repository — read this before touching anything

`github.com/Orthic-Labs/roundtable` is canonical. **Do not confuse it with
`github.com/bogusyogi/claude`** (Adrian's general workspace repo). If a checkout's `git remote -v`
doesn't say `Orthic-Labs/roundtable`, stop and fix that first.

**Single branch, everywhere.** `main` only, local and remote, no worktrees.

## It is live

```
Hub    Hetzner, pm2 `roundtable-hub`, 172.22.0.1:8460, pm2 save'd
DB     ~/.local/share/roundtable/roundtable.sqlite3 (WAL)
Backup ~/backups/roundtable, cron 04:15, node:sqlite backup() + integrity_check
Node   this Mac, launchd com.orthiclabs.roundtable-node, starts at login
Codex  /opt/homebrew/bin/codex app-server — real, answering
```

Proven on 2026-07-26: posted "Say exactly: THIRD" into the room, read `THIRD` back out of the
production database as an agent chat message. Real binary, real hub, real Codex, no fixtures.

```
cargo test --workspace              → 71 passed, 0 failed
node --test (per file / small batch) → 100 passed, 0 failed
```

## THE ONE THING LEFT — needs Adrian's sudo

`roundtable.spoares.com` still falls through to the default server. The vhost is staged at
`~/sites/nginx/roundtable.conf` on the box; the Dockerfile needs its `COPY` line and a rebuild, and
`vendure` is not in the `docker` group. Run this on the box:

```bash
cd ~/sites/nginx && cp Dockerfile Dockerfile.bak-$(date +%s) && \
  echo 'COPY roundtable.conf /etc/nginx/conf.d/roundtable.conf' >> Dockerfile && \
  for f in *.conf; do grep -q "COPY $f " Dockerfile && echo "IN $f" || echo "MISSING $f"; done && \
  sudo docker compose build && sudo docker compose up -d && \
  curl -sI https://roundtable.spoares.com/healthz | head -1
```

Every line of that loop must read `IN`. A `MISSING` is a hard stop — the image bakes confs in
rather than mounting them, so a conf on disk but absent from the Dockerfile is silently dropped and
its domain falls through to damneddesigns (this happened to spoares.com on 2026-06-15).

Afterwards, point the node at the real URL instead of the SSH tunnel:

```bash
ROUNDTABLE_HUB_URL=wss://roundtable.spoares.com/node/connect \
  ROUNDTABLE_NODE_ID=4d1cb397-b1cb-4134-b1ed-4f991c632c98 \
  /Volumes/D/claude/roundtable/tools/roundtable/ops/install-macos.sh
```

## Operating it

```bash
# enrol things (box-side CLI — deliberately NOT an HTTP route, it mints credentials)
ssh vendure 'node ~/sites/roundtable/tools/roundtable/ops/enrol-node.mjs list'
ssh vendure 'node ~/sites/roundtable/tools/roundtable/ops/enrol-node.mjs node <name>'
ssh vendure 'node ~/sites/roundtable/tools/roundtable/ops/enrol-node.mjs seat <room> <node> <alias> codex'

# deploy the hub
ssh vendure 'cd ~/sites/roundtable && git pull --ff-only origin main && pm2 restart roundtable-hub'

# the Mac node
launchctl print gui/$(id -u)/com.orthiclabs.roundtable-node | grep state
tail -f ~/Library/Logs/roundtable/node.out.log
```

On-call runbook and the log field schema: `tools/roundtable/ops/observability.md`.

## What is NOT done

- **Claude seats do not work.** `packages/claude-channel` builds and its IPC tests pass, but
  `main.rs` logs a Claude-provider delivery as explicitly unhandled. Codex only, for now. This is
  the biggest remaining gap — the product is "multi-party rooms" and today it is single-provider.
- **Windows** — no installer, never built or run there.
- The node never advances its own replay cursor (always reconnects at 0). Harmless now that the hub
  refuses to replay terminal deliveries, but it is not doing its job.
- Streaming deltas and most `ThreadItem` variants are not surfaced.

## Hard-won lessons — do not relearn these

- **The fixture agreeing with the code proves nothing.** Both were wrong together for weeks. Every
  wire shape is now grounded in `fixtures/app-server/schema/`, generated from a real `codex`
  binary. Regenerate and diff rather than assuming.
- **Never pipe a child's stderr without draining it.** A full 64KB pipe buffer blocks the child
  forever. This presented as "Codex answers the handshake then hangs", with no error anywhere.
- **`server.close()` does not close anything.** It stops accepting and waits. WebSockets hold their
  sockets open, so you need `closeAllConnections()`. This masqueraded as a test-runner quirk for
  weeks.
- **A test that awaits frames one `once()` at a time will lose frames** sent in the same tick.
  Collect from socket open.
- **Deploy, then believe.** Six defects were invisible to a green test suite and appeared within
  minutes of a real deployment: no dispatch loop at all, a migration that broke every restart,
  unverified node tokens, a stale connection eating deliveries, a stderr deadlock, and a handshake
  real Codex rejects.

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
4. **RETIRED — there is no magic approval phrase.** This file used to say Task 11 required a
   literal `DEPLOY TASK 11`. Adrian struck that down on 2026-07-26: his stated intent IS the
   approval, and a phrase gate in a doc never outranks what he actually says. Deployed the same
   day on his instruction. Real stops remain: unrequested spend, destructive or irreversible
   actions he did not ask for, and anything needing his sudo.
5. **`~/sites/coderight`** was deleted from Hetzner mid-session (33G, unrelated cleanup Adrian
   asked for) — verify before assuming it's needed for anything; the live site runs from
   `~/sites/rightsites/coderight`, untouched.

## The test-runner hang — root-caused, largely fixed, not fully

The old advice ("run dispatch.test.mjs first, it's environmental") was wrong and is retired. It was
two real bugs: a hub that could not shut down (`server.close()` waits for WebSockets that never
close — SIGTERM hung the same way in production) and a frame race in the test helper.

Honest status: `dispatch.test.mjs` now passes 11/11 and exits cleanly, where only 3 tests ever ran
before. Small batches pass. **The full 12-file run is still flaky** — it completed 100/100 once,
then hung at ~42 on later runs, always AFTER the tests report, so it is a lingering handle rather
than a stuck test. Not root-caused. Run files individually or in small batches.

## Known gotchas (already paid for once — don't rediscover)

- **`cargo test --workspace` breaks if `crates/*` glob picks up a stray directory** (e.g. tooling
  scratch dirs). Fixed by listing workspace members explicitly in `Cargo.toml` — don't revert to
  the glob.
- **`node --test` with a quoted glob string can silently under-run files** depending on shell
  expansion context — if a count looks low, expand the glob yourself or pass files individually and
  sum, don't trust a single `tail -N` on the output (a truncated tail looks exactly like missing
  tests and cost real time to debug today).
- **pnpm is a broken release on this Mac; npm works.** The "npm fails on certificate trust" claim
  was wrong — those `failed to copy trust settings` lines are shell-init noise printed by unrelated
  commands (a plain `node -e` prints them too). `npm install` succeeds; `packages/claude-channel`
  installed 99 packages cleanly on 2026-07-26. The Node hub still has zero dependencies, but that
  is now a deliberate property worth keeping, not a workaround — it is what makes deploy a
  `git pull` with nothing to install.
- **The `HubTransport` factory is synchronous but WS connect is async** — `main.rs` uses
  `block_in_place` + `Handle::block_on` to bridge this once per connect attempt. Don't try to make
  the factory itself async without touching every existing caller.
- **The wire framing is `{version, event_id, sent_at_ms, type, payload}`** (nested payload) — that
  is the Rust node's contract, and the Node hub was deliberately written to match it, not the other
  way around. If you're ever tempted to "clean up" the envelope shape, remember the node is the
  fixed point.

## Real protocol schema is now in the repo — use it, don't guess

`fixtures/app-server/schema/` holds a real Codex App Server v2 protocol schema, generated via
`codex app-server generate-json-schema --experimental --out <dir>` against a real, locally-
installed `codex` CLI (Task 0 in the architecture doc, done for real). Read its README before
touching `codex.rs` or `fake-codex.mjs` again — it documents exactly what was wrong before
(flat `turnId`/`status`, bare-string `input`) and what the real shapes are. Regenerate it if
`codex` is upgraded and you suspect drift; diff, don't assume.

## Suggested next step

1. **nginx** — the one command above, Adrian's sudo.
2. **Route Claude seats.** `main.rs` drops Claude deliveries into a catch-all; wire them through
   `packages/claude-channel`'s IPC. Until then "multi-party rooms" is one party.
3. Windows node installer.
