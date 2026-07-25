"""
roomclient — thin async WebSocket client for Agent Room.

Shared by the hosted-model client (agent_model.py) and the coding-session
bridge (agent_exec.py). Keeps a rolling transcript so an agent has room
context when it is @-mentioned, and reconnects with backoff.

    pip install websockets
"""
from __future__ import annotations

import asyncio
import json
import urllib.parse
from collections import deque
from typing import Any, Awaitable, Callable

import websockets


class RoomClient:
    def __init__(self, url: str, room: str, agent: str, token: str,
                 kind: str = "model", transcript_len: int = 40):
        self.base = url.rstrip("/")
        self.room = room
        self.agent = agent
        self.token = token
        self.kind = kind
        self.transcript: deque[dict[str, Any]] = deque(maxlen=transcript_len)
        self.roster: list[dict[str, Any]] = []
        self._ws: Any = None

    def _wss(self) -> str:
        q = urllib.parse.urlencode(
            {"room": self.room, "agent": self.agent,
             "kind": self.kind, "token": self.token})
        return f"{self.base}/ws?{q}"

    async def say(self, body: str, to: list[str] | str = "@all",
                  thread: int | None = None) -> None:
        if isinstance(to, str):
            to = [to]
        await self._ws.send(json.dumps(
            {"type": "say", "to": to, "body": body, "thread": thread}))

    async def run(self, on_message: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        """Connect and dispatch. on_message is called for each 'msg' frame.
        Reconnects forever with capped backoff."""
        backoff = 1
        while True:
            try:
                async with websockets.connect(self._wss(), max_size=2**22) as ws:
                    self._ws = ws
                    backoff = 1
                    print(f"[room] {self.agent} connected to {self.room}")
                    async for raw in ws:
                        frame = json.loads(raw)
                        await self._dispatch(frame, on_message)
            except Exception as e:  # noqa: BLE001
                print(f"[room] {self.agent} disconnected: {e}; retry in {backoff}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)

    async def _dispatch(self, frame: dict[str, Any],
                        on_message: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        ftype = frame.get("type")
        if ftype == "history":
            for m in frame.get("messages", []):
                self.transcript.append(m)
        elif ftype == "roster":
            self.roster = frame.get("agents", [])
        elif ftype == "msg":
            self.transcript.append(frame)
            await on_message(frame)
        # held / paused / error frames are informational for agents

    def context_text(self, limit: int = 20) -> str:
        """Recent transcript rendered as plain 'name: body' lines."""
        lines = [f'{m["frm"]}: {m["body"]}'
                 for m in list(self.transcript)[-limit:]]
        return "\n".join(lines)
