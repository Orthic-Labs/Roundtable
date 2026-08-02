# Real Codex App Server protocol schema

Generated 2026-07-25 from a real, locally-installed `codex` CLI (`/opt/homebrew/bin/codex`) via:

```bash
codex app-server generate-json-schema --experimental --out <dir>
```

This is the architecture doc's own Task 0 step ("Generate App Server schemas"), run for real.
`codex_app_server_protocol.v2.schemas.json` is the full bundled schema (all request/response/
notification types and their shared definitions); `ServerNotification.json` is the tagged union
of every server→client notification with its real wire `method` string.

## Why this exists

`fixtures/app-server/fake-codex.mjs` — the fixture `citadel-node`'s tests drive — predates
this and gets several real shapes wrong. Discovered by generating this schema and comparing:

- `turn/started` and `turn/completed` notifications carry `{threadId, turn: Turn}` — a full
  nested `Turn` object (`id`, `status`, `items`, `itemsView`, `startedAt`, `completedAt`,
  `durationMs`, `error`) — not a flat `turnId` string. `TurnStatus` is
  `completed | interrupted | failed | inProgress`, not the fixture's ad-hoc status strings.
- `turn/start`'s `input` field is an **array** of `UserInput` (tagged union: `text`, `image`,
  `localImage`, `audio`, `localAudio`, `skill`, `mention`), not a plain string.
- The real notification that carries an agent's actual reply text is `item/completed` with
  `item.type == "agentMessage"` and a flat `item.text: string` — not something synthesized from
  accumulating `item/agentMessage/delta` chunks (those exist too, for live streaming, but the
  completed item already has the full text).

`fake-codex.mjs` is not (yet) rewritten to emit these real shapes — check its date against this
README's before trusting it for anything beyond the specific fields it already covers correctly
(`initialize`, the basic JSON-RPC framing, and the wire method names `thread/start`/`turn/start`/
`turn/started`/`turn/completed`, which ARE correct — only the notification bodies are simplified).

## Regenerating

Re-run the command above whenever `codex` is upgraded and you suspect drift; diff against these
files rather than assuming the shape is unchanged. Do not hand-edit these two files.
