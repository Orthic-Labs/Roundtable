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
URL    https://roundtable.spoares.com  (PWA + API + wss node endpoint)
Hub    Hetzner, pm2 `roundtable-hub`, 0.0.0.0:8460, pm2 save'd
DB     ~/.local/share/roundtable/roundtable.sqlite3 (WAL)
Backup ~/backups/roundtable, cron 04:15, node:sqlite backup() + integrity_check
Node   this Mac, launchd com.orthiclabs.roundtable-node, starts at login
Codex  /opt/homebrew/bin/codex app-server — real, answering
```

Proven on 2026-07-26: posted "Say exactly: THIRD" into the room, read `THIRD` back out of the
production database as an agent chat message. Real binary, real hub, real Codex, no fixtures.

```
cargo test --workspace              → 73 passed, 0 failed
node --test src/*.test.mjs          → 100 passed, 0 failed  (retry if it wedges; see below)
```

## Deployment gotchas — all four cost real time, none are obvious

Everything below is DONE. Recorded because each was invisible until the thing was actually deployed.

1. **`http2 on;` took the whole box down.** `listen 443 ssl;` + `http2 on;` needs nginx >= 1.25.1;
   this box's `macbre/nginx-brotli` is older, so the directive fails `nginx -t`, the container exits
   at startup, and EVERY site 521s — not just yours. Use `listen 443 ssl http2;`, as every other
   conf here does. Verifying the conf was COPY'd into the image proves it shipped, NOT that it
   parses; run `nginx -t` against the built image before `up -d`.
2. **ufw silently blocks new upstream ports.** Existing rules allow 3301 and 4211:4215 from
   `172.16.0.0/12`; 8460 was not there, so nginx accepted TLS and then hung until timeout (`499` in
   the access log). Host-to-hub worked the whole time, which makes this look like an nginx bug when
   it is a firewall one. Any NEW upstream port needs:
   `sudo ufw allow from 172.16.0.0/12 to any port <port> proto tcp`
3. **Bind upstreams to `0.0.0.0`.** Binding only to the docker gateway `172.22.0.1` looked tighter
   but the containerised nginx could not reach it. Every other service here binds all interfaces;
   the host firewall is what keeps the port private (8460 is confirmed unreachable from the public
   internet).
4. **rustls has no default crypto provider.** The node ran over `ws://` for all of development and
   panicked on its first `wss://` dial. Worse, it exited 0, so launchd's
   `KeepAlive(SuccessfulExit=false)` did not restart it — a silent self-disable. Fixed by
   installing `ring` explicitly in `main()`.

`pm2 restart` does NOT reload env from `ecosystem.config.cjs`. Use `pm2 delete` + `pm2 start
ops/ecosystem.config.cjs`, then `pm2 save`.

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

- **Claude seats work, partially.** A delivery reaches a connected channel over the node's 0600
  unix socket and its reply posts back to the room — verified live with Codex and Claude seats
  answering in the same room. Still unimplemented over IPC: handoff.create, approval.verdict,
  session.join/leave, transcript.read/search (each returns an explicit error, not a fake success).
- **Windows** — never built or run. `roundtable-node` does not even COMPILE there: `ipc.rs`
  imports `UnixListener`/`UnixStream` unconditionally. Full brief: [`WINDOWS-HANDOFF.md`](./WINDOWS-HANDOFF.md).
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

## The test-runner hang — mostly fixed, not fully

The old advice ("run dispatch.test.mjs first, it's environmental") was wrong and is retired. Four
real leaks have been found and fixed, one of them a production defect: the hub could not shut down
(`server.close()` waits on WebSockets that never close, so SIGTERM stalled too), `WsConnection` had
no `destroy()`, `close()` only knew about handshaken connections, and `dispatch.test.mjs` had a
frame race that lost same-tick frames.

Still open: `replay.test.mjs` wedges at process exit roughly 1 run in 4, alone. Every assertion
passes first — the hang is purely the process not exiting, so it costs time, not correctness.
Measured from inside a hanging run, the child holds a `TCPServerWrap` and two `TCPSocketWrap`s: a
hub server that never finished closing. Retry the run, or run per-file.

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
2. **Finish the IPC surface** — transcript.read/search and handoff.create need the node to reach
   the hub for data it does not hold (a room roster, a transcript). Everything else is done.
3. Windows node installer (Adrian is handling the timing on this one).
