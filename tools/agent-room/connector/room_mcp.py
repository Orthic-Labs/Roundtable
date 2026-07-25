#!/usr/bin/env python3
"""
Agent Room connector (MCP) — lets a Claude Code / Codex session JOIN a room
from a link and get @-woken, using only the tools it already has.

You add this once as an MCP server in your agent (Claude Code / Codex). Then,
in any session, you paste a room link and say "join and stay in this room."
The session:

    room_join(link)          -> connect this session to the room
    loop:
        msg = room_wait()    -> BLOCKS until someone @-mentions me, then
                                 returns their message   (this is the "probe")
        ...answer, or do the task with normal tools...
        room_say(reply, to=[msg.from])
    room_leave()             -> when you're done / closing the session

No terminal, no background daemon, no inbound webhook. The connector holds one
outbound WebSocket to the room; @-you is what makes room_wait() return.

Add to Claude Code (~/.claude.json or project .mcp.json):
    "agent-room": {
      "command": "python3",
      "args": ["/ABS/PATH/tools/agent-room/connector/room_mcp.py"],
      "env": {"AGENT_ROOM_DEFAULT_KIND": "exec"}
    }

Link format (what a room tab hands you):
    wss://your.box/agentroom/ws?room=memright&token=XYZ
    (kind defaults to 'exec'; agent name defaults to this machine's hostname)

    pip install mcp websockets
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import urllib.parse
from typing import Any

import websockets
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("agent-room")

# ------------------------------------------------------------ connection state
class Conn:
    def __init__(self) -> None:
        self.ws: Any = None
        self.reader: asyncio.Task | None = None
        self.inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.roster: list[dict[str, Any]] = []
        self.room: str = ""
        self.agent: str = ""

    @property
    def joined(self) -> bool:
        return self.ws is not None


C = Conn()


def _build_ws_url(link: str, agent: str, kind: str) -> tuple[str, str]:
    """Accept a room link and return (ws_url, room). Handles both the pretty
    '.../agentroom/ws?room=..&token=..' form and a bare '.../agentroom/<room>'."""
    u = urllib.parse.urlsplit(link)
    q = dict(urllib.parse.parse_qsl(u.query))
    room = q.get("room")
    path = u.path
    if not room:
        # bare form: last path segment is the room; endpoint is <base>/ws
        segs = [s for s in u.path.split("/") if s]
        room = segs[-1] if segs else "default"
        path = "/".join(u.path.split("/")[:-1]) + "/ws"
    elif not path.endswith("/ws"):
        path = path.rstrip("/") + "/ws"
    q.update({"room": room, "agent": agent, "kind": kind})
    if "token" not in q and os.environ.get("AGENT_ROOM_TOKEN"):
        q["token"] = os.environ["AGENT_ROOM_TOKEN"]
    return urllib.parse.urlunsplit(
        (u.scheme, u.netloc, path, urllib.parse.urlencode(q), "")), room


async def _read_loop() -> None:
    try:
        async for raw in C.ws:
            frame = json.loads(raw)
            t = frame.get("type")
            if t == "roster":
                C.roster = frame.get("agents", [])
            elif t == "msg" and frame.get("for_you"):
                await C.inbox.put(frame)
            # history/held/paused frames are ignored by an agent connector
    except Exception:
        pass


@mcp.tool()
async def room_join(link: str, agent: str = "", kind: str = "") -> str:
    """Join an Agent Room from its link. Call once, then use room_wait/room_say.
    `agent` defaults to this machine's hostname; `kind` defaults to 'exec'."""
    if C.joined:
        await room_leave()
    agent = agent or os.environ.get("AGENT_ROOM_AGENT") or socket.gethostname().split(".")[0]
    kind = kind or os.environ.get("AGENT_ROOM_DEFAULT_KIND", "exec")
    ws_url, room = _build_ws_url(link, agent, kind)
    C.ws = await websockets.connect(ws_url, max_size=2**22)
    C.room, C.agent = room, agent
    C.reader = asyncio.create_task(_read_loop())
    return (f"Joined room '{room}' as '{agent}'. You are present and listening. "
            f"Call room_wait() to receive the next message addressed to you "
            f"(it blocks until someone @{agent}s you), then room_say() to reply.")


@mcp.tool()
async def room_wait(timeout_seconds: int = 300) -> str:
    """Block until someone @-mentions this agent (or @all), then return their
    message as JSON {id, from, body, thread}. This IS the probe: an @ to you is
    what makes this return. Returns '(timeout)' if nobody addressed you in time —
    just call room_wait() again to keep listening."""
    if not C.joined:
        return "(not in a room — call room_join first)"
    try:
        msg = await asyncio.wait_for(C.inbox.get(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        return "(timeout — call room_wait() again to keep listening)"
    return json.dumps({"id": msg["id"], "from": msg["frm"],
                       "to": msg.get("to", []), "body": msg["body"],
                       "thread": msg.get("thread")})


@mcp.tool()
async def room_say(body: str, to: str = "@all", thread: int | None = None) -> str:
    """Post a message to the room. `to` is a space-separated list of @names or
    @all (e.g. '@adrian' to reply to the person who asked). Keep `thread` = the
    id of the message you're answering to stay in that thread."""
    if not C.joined:
        return "(not in a room — call room_join first)"
    targets = to.split() if to else ["@all"]
    await C.ws.send(json.dumps({"type": "say", "to": targets,
                                "body": body, "thread": thread}))
    return "sent"


@mcp.tool()
async def room_roster() -> str:
    """List who is currently in the room (name, kind, online)."""
    return json.dumps(C.roster)


@mcp.tool()
async def room_history(limit: int = 30) -> str:
    """Fetch recent room history (what was said before you joined / caught up)."""
    if not C.joined:
        return "(not in a room — call room_join first)"
    await C.ws.send(json.dumps({"type": "history", "since": None}))
    # the next history frame is handled by the read loop; give a short window
    for _ in range(20):
        await asyncio.sleep(0.1)
    return "(history delivered to the room; use room_wait to receive live messages)"


@mcp.tool()
async def room_leave() -> str:
    """Leave the room and close the connection (call when done / closing out)."""
    if C.reader:
        C.reader.cancel()
        C.reader = None
    if C.ws:
        try:
            await C.ws.close()
        except Exception:
            pass
    room = C.room
    C.ws = None
    C.room = C.agent = ""
    return f"Left room '{room}'." if room else "(was not in a room)"


if __name__ == "__main__":
    mcp.run()
