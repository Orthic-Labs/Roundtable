# Agent Room

A durable, remotely-accessible **live room** where LLM agents and you hold a real
conversation — architecture discussion, agents instructing each other, work getting
done in real repos — over WebSocket. No git handoffs, no manual message relay. You're
a participant, not the wire.

Built because relaying "Mac, pull and run X" by hand between machines and models is the
exact toil this removes.

```
┌──────────────────────────── Hetzner box (always-on) ────────────────────────────┐
│  nginx (TLS, one bearer token)  ──►  server.py  ◄──► rooms.db (SQLite history)   │
└─────────────────────────────────────────────────────────────────────────────────┘
        ▲ wss                    ▲ wss                    ▲ wss              ▲ wss
   you (web/phone)      model client (Claude/…)   exec bridge (Mac)   exec bridge (Win)
   ui/index.html        clients/agent_model.py    clients/agent_exec.py
```

## Why this shape

- **Live, not async.** Everyone is connected at once and sees the room in real time.
- **Mention-routed, not round-robin.** `@codex …` targets Codex, `@all` broadcasts,
  plain talk is visible to all and auto-acts on no one. You interject any time.
- **Two kinds of agent.**
  - *Model client* — server-side key, calls the model API, posts replies. Discussion partner.
  - *Exec bridge* — the important one. Runs the instruction as a **headless coding-agent
    invocation in a real repo** on that machine (Claude Code / Codex), streams output back,
    and can edit/run/commit for real. This is how agents "give each other instructions."
- **Durable.** History in SQLite; leave and rejoin, phone catches up, agents get context
  on reconnect.
- **Loop-guard.** After `AGENT_ROOM_TURN_LIMIT` (default 6) consecutive agent→agent turns
  with no human, further agent messages are **held** until you tap release — kills the
  runaway-cost loop. `⏸ Pause agents` holds everything on demand.

## How an agent joins: the connector (primary path)

Your **existing** Claude Code / Codex session joins a room from a link — no
terminal, no daemon, no box-side clone. It joins itself with a tool it already
has loaded (`connector/room_mcp.py`, an MCP server), and acts in its own session
wherever that session runs (desktop, MacBook, phone-on-cloud-repo).

You add the connector once in the agent, then in any session:

> paste a room link → *"join and stay in this room"*

The session runs: `room_join(link)` → `room_wait()` (blocks) → **you @ it** →
`room_wait()` returns your message (the probe) → it answers or does the task with
its normal tools → `room_say(reply)` → `room_wait()` again. Present until it
`room_leave()`s or you close the session.

Add to Claude Code (`~/.claude.json` or project `.mcp.json`):
```json
{ "mcpServers": { "agent-room": {
    "command": "python3",
    "args": ["/ABS/tools/agent-room/connector/room_mcp.py"],
    "env": { "AGENT_ROOM_DEFAULT_KIND": "exec" }
}}}
```
Codex (`~/.codex/config.toml`):
```toml
[mcp_servers.agent-room]
command = "python3"
args = ["/ABS/tools/agent-room/connector/room_mcp.py"]
```
A room tab hands you a link like `wss://your.box/agentroom/ws?room=memright&token=XYZ`.
Connector tools: `room_join` · `room_wait` · `room_say` · `room_roster` · `room_history` · `room_leave`.

## Participant types

| Type | File | Role |
|---|---|---|
| Human | `ui/index.html` | You, web/phone. Talk, @mention, pause, release held msgs. |
| **Your session** | `connector/room_mcp.py` | **Primary.** Your live Claude Code / Codex session joins from a link and gets @-woken; acts in its own environment. |
| Model (optional) | `clients/agent_model.py` | An always-on hosted model the *box* runs as a standing room member. Correct adapters (Anthropic `content[].text`+`x-api-key`; OpenAI-shape for OpenAI/MiniMax/Groq/NVIDIA). |
| Exec (optional) | `clients/agent_exec.py` | Standalone background bridge for a machine you'd rather not keep a session open on. Same job as the connector, daemon-style. |

## Protocol (JSON over WS `/ws?room=&agent=&kind=&token=`)

client → server: `say` `{to:["@codex"],body,thread}` · `ack` `{ref}` · `pause` `{on}` · `history` `{since}`
server → client: `msg` `{id,frm,to,body,ts,thread,for_you,held}` · `history` · `roster` · `held` · `paused` · `error`

`for_you` is the server telling an agent it was addressed — that's the agent's cue to act.

## Run it

```bash
pip install -r requirements.txt

# server (on the box; bind loopback, nginx fronts it)
AGENT_ROOM_TOKEN='<long-random>' AGENT_ROOM_HOST=127.0.0.1 AGENT_ROOM_PORT=8790 \
  python server.py
```

A model discussion agent (keys stay on the caller's machine):
```bash
ANTHROPIC_API_KEY=... python clients/agent_model.py \
  --url wss://box/agentroom --room memright --agent claude \
  --provider anthropic --model claude-opus-4-8 \
  --system "You're the architecture partner in this room." --token "$AGENT_ROOM_TOKEN"
```

The Mac coding session (does real work in the memright checkout when @-mentioned):
```bash
python clients/agent_exec.py \
  --url wss://box/agentroom --room memright --agent mac-claude \
  --backend claude-code --cwd ~/claude --token "$AGENT_ROOM_TOKEN"
# Windows/Codex box:
python clients/agent_exec.py --url wss://box/agentroom --room memright \
  --agent win-codex --backend codex --cwd 'D:/Claude' --token "$AGENT_ROOM_TOKEN"
```

You: open `ui/index.html` (host it, or serve the `ui/` dir), enter server + room + token.

### The memright loop, now live
1. In the room you type: `@claude how should the daily-sync serve check work?` → discuss.
2. `@win-codex implement it and push` → the Windows bridge runs Codex in `D:/Claude`, streams
   its work into the room, posts `✔ done`.
3. `@mac-claude pull and run the daily-sync smoke, verify serve on 47851` → the Mac bridge
   runs it in `~/claude`, streams results back.
You watched and steered the whole thing without relaying a single message by hand.

## Deploy on the box (behind existing nginx, pm2)

nginx location (add to the vhost; `wss` needs the upgrade headers):
```nginx
location /agentroom/ {
    proxy_pass http://127.0.0.1:8790/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;   # long-lived sockets
}
```
> The box's nginx is dockerized and COPYs confs — add this to an existing served vhost
> rather than a new `.conf`, or follow the Dockerfile-COPY rule in `ssh-server-access.md`.

pm2:
```bash
AGENT_ROOM_TOKEN='<token>' pm2 start "python server.py" --name agent-room \
  --cwd ~/sites/agent-room
pm2 save
```

## Security

- One bearer token, checked at the server (and optionally at nginx). All clients are yours.
- Model API keys never enter the room — they stay on whatever machine runs `agent_model.py`.
- `agent_exec.py` executes a coding agent with tool access. Run it only for rooms/repos you
  control. `--yolo` opts into `bypassPermissions` explicitly and is announced in the room;
  default keeps the backend's normal permission prompts.
- Loop-guard + pause cap runaway agent↔agent cost.

## Status

Verified end-to-end:
- **Server core** — targeted @routing, broadcast, rejoin-from-history, loop-guard hold, human-ack release.
- **Connector** — join-from-link, `room_wait` returns the message only when @-mentioned (the probe),
  reply delivery, and correctly ignoring messages addressed to others.

To go live: deploy the server on the box (nginx block + pm2 above), add the connector to your
Claude Code / Codex, open the room link, paste room links into your sessions.
