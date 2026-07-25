# Roundtable — Observability

Closes the architecture spec's `ops/observability.md` debt: log field schema, sampling, and the
on-call runbook.

The pipeline is deliberately small: the hub writes **one JSON object per line to stdout**, pm2
captures stdout to a file, and `jq` is the query tool. There is no log shipper, no agent, and no
hosted collector — adding one would violate the workspace's "minimum mechanism" rule for a service
with one operator. Revisit only when a second operator or a second box exists.

## Implementation

`packages/hub/src/log.mjs`. Zero dependencies, by force: `@rightkit/logs` is the workspace
standard, but pnpm is a broken release on this Mac and npm fails on certificate trust, so nothing
is installable here. **The field schema below matches what a rightkit-logs sink expects**, so
adopting the real package later is a change to `log.mjs` alone, not to every call site. That is the
honest state of the "hub adopts rightkit-logs" spec item: schema-compatible, package not installed,
blocked on tooling rather than on design.

## Field schema

Every line carries these three:

| Field | Type | Notes |
|---|---|---|
| `ts` | ISO-8601 string | UTC, millisecond precision |
| `level` | `debug` \| `info` \| `warn` \| `error` | |
| `event` | dotted string | The event name — the primary thing you filter on |

Then per-event fields:

| Event | Level | Fields |
|---|---|---|
| `http.request` | info / warn (4xx) / error (5xx) | `method`, `path`, `status`, `duration_ms` |
| `node.connected` | info | `node_id`, `resume_cursor` |
| `node.disconnected` | info | `node_id` |
| `node.message.post.malformed` | warn | `reason` |
| `node.message.post.unknown_seat` | warn | `seat_id`, `room_id` |
| `node.message.post.failed` | error | `seat_id`, `room_id`, `err.{name,message}` |

`path` is the pathname only — the query string is stripped before logging.

## What is never logged

`log.mjs` hard-redacts these keys at any level, replacing the value with `[redacted]`:

`token`, `admin_token`, `cookie`, `authorization`, `token_hash`, `body`, `password`

`body` is in that list for a reason that is not security theater: a room transcript is the user's
private content and has no business in an ops log. If you need to see what an agent said, read the
room — that is what the transcript is for.

## Sampling

**None, and that is a decision, not an omission.** Roundtable is a single-operator system with a
handful of seats; total volume is a few hundred lines a day. Sampling would cost the one property
that matters here — being able to reconstruct exactly what happened for a specific delivery —
in exchange for disk space that is not scarce. Introduce sampling only if `http.request` volume
becomes the dominant cost, and sample **only** that event; never sample `warn`/`error`, and never
sample node lifecycle events.

Volume control is `ROUNDTABLE_LOG_LEVEL` (default `info`). Set it to `warn` to silence the access
log while keeping every failure.

## On-call runbook

Logs: `~/.pm2/logs/roundtable-hub-out.log` (and `-error.log` for anything that escaped the logger).

**Is it up?**

```bash
curl -fsS https://roundtable.spoares.com/healthz && pm2 describe roundtable-hub | head -20
```

**What is failing right now?**

```bash
tail -n 2000 ~/.pm2/logs/roundtable-hub-out.log | jq -c 'select(.level == "error" or .level == "warn")'
```

**Is a node actually connected?** (the single most common "it's broken" cause — the hub is fine and
the Mac's node is not running)

```bash
curl -fsS -b "$COOKIE" https://roundtable.spoares.com/api/nodes | jq '.nodes[] | {id, name, online}'
tail -n 5000 ~/.pm2/logs/roundtable-hub-out.log | jq -c 'select(.event | startswith("node."))' | tail -20
```

**Slow requests:**

```bash
tail -n 5000 ~/.pm2/logs/roundtable-hub-out.log | jq -c 'select(.duration_ms > 1000)'
```

**Trace one delivery end to end** — the hub log tells you what the hub did; the delivery row tells
you where it stopped:

```bash
sqlite3 ~/.local/share/roundtable/roundtable.sqlite3 \
  "SELECT id, seat_id, state, attempt, error_code, datetime(updated_at_ms/1000,'unixepoch')
   FROM deliveries WHERE id = '<delivery_id>';"
```

**Recent cancels** (per the architecture's Cancellation contract §7 audit trail):

```bash
sqlite3 ~/.local/share/roundtable/roundtable.sqlite3 \
  "SELECT id, room_id, seat_id, error_code, datetime(created_at_ms/1000,'unixepoch')
   FROM deliveries WHERE error_code LIKE 'canceled_%' ORDER BY created_at_ms DESC LIMIT 100;"
```

**Stuck deliveries** (queued with no connected node, or a lease that expired):

```bash
sqlite3 ~/.local/share/roundtable/roundtable.sqlite3 \
  "SELECT id, seat_id, state, attempt, lease_until_ms FROM deliveries
   WHERE state IN ('queued','sent','acked','running') ORDER BY created_at_ms DESC LIMIT 50;"
```

**Restart the hub** (safe — SQLite is WAL, nodes reconnect and replay from their cursor):

```bash
pm2 restart roundtable-hub && sleep 2 && curl -fsS https://roundtable.spoares.com/healthz
```

## Known gaps

- The **node** (`roundtable-node`) logs via `tracing` to stderr in its own format, not this schema.
  Its logs live wherever launchd/Task Scheduler put them, per machine. Unifying the two is not
  done.
- There are no metrics, only logs. No counters, no histograms, no dashboard. `duration_ms` on
  `http.request` is the only latency signal, and you read it with `jq`.
