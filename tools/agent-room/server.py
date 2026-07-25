#!/usr/bin/env python3
"""
Agent Room — live multi-party chat server for LLM agents + human.

A durable, remotely-accessible room where hosted-model agents, local
coding-session bridges, and the human all connect over WebSocket and talk
in real time. Routing is @-mention driven (not round-robin). History is
persisted to SQLite so participants can leave and rejoin. A loop-guard
holds runaway agent<->agent chatter until the human acks.

Single process. Run behind your existing nginx (wss upgrade) with a bearer
token. No external deps beyond FastAPI + uvicorn.

    pip install fastapi 'uvicorn[standard]'
    AGENT_ROOM_TOKEN=... uvicorn server:app --host 127.0.0.1 --port 8790

Protocol (JSON frames):

  client -> server:
    {"type":"say","to":["@codex"]|["@all"],"body":"...","thread":<id|null>}
    {"type":"ack","ref":<msg id>}            # release a held message
    {"type":"pause","on":true|false}         # human pause of all agents
    {"type":"history","since":<id|null>}     # request backlog

  server -> client:
    {"type":"msg", id, room, frm, to, body, ts, thread, for_you, held}
    {"type":"history","messages":[...]}
    {"type":"roster","agents":[{name,kind,online}]}
    {"type":"held","id",...}                 # awaiting human ack
    {"type":"paused","on":bool}
    {"type":"error","reason":"..."}
"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query

TOKEN = os.environ.get("AGENT_ROOM_TOKEN", "")
DB_PATH = Path(os.environ.get("AGENT_ROOM_DB", str(Path(__file__).parent / "rooms.db")))
# consecutive agent->agent messages (no human turn) before the loop-guard holds
AGENT_TURN_LIMIT = int(os.environ.get("AGENT_ROOM_TURN_LIMIT", "6"))
HISTORY_ON_JOIN = int(os.environ.get("AGENT_ROOM_HISTORY", "50"))

app = FastAPI(title="Agent Room")


# --------------------------------------------------------------------------- db
def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _init_db() -> None:
    with closing(_db()) as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS messages(
                 id      INTEGER PRIMARY KEY AUTOINCREMENT,
                 room    TEXT NOT NULL,
                 frm     TEXT NOT NULL,
                 to_json TEXT NOT NULL,
                 body    TEXT NOT NULL,
                 ts      REAL NOT NULL,
                 thread  INTEGER,
                 held    INTEGER NOT NULL DEFAULT 0,
                 acked   INTEGER NOT NULL DEFAULT 0
               )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_room ON messages(room, id)")
        conn.commit()


def _persist(room: str, frm: str, to: list[str], body: str,
             thread: int | None, held: bool) -> dict[str, Any]:
    with closing(_db()) as conn:
        cur = conn.execute(
            "INSERT INTO messages(room,frm,to_json,body,ts,thread,held,acked) "
            "VALUES(?,?,?,?,?,?,?,0)",
            (room, frm, json.dumps(to), body, time.time(), thread, int(held)),
        )
        conn.commit()
        mid = cur.lastrowid
    return {"id": mid, "room": room, "frm": frm, "to": to, "body": body,
            "ts": time.time(), "thread": thread, "held": held}


def _history(room: str, since: int | None, limit: int) -> list[dict[str, Any]]:
    with closing(_db()) as conn:
        if since:
            rows = conn.execute(
                "SELECT * FROM messages WHERE room=? AND id>? ORDER BY id",
                (room, since)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM messages WHERE room=? ORDER BY id DESC LIMIT ?",
                (room, limit)).fetchall()
            rows = list(reversed(rows))
    return [_row(r) for r in rows]


def _mark_acked(mid: int) -> dict[str, Any] | None:
    with closing(_db()) as conn:
        conn.execute("UPDATE messages SET held=0, acked=1 WHERE id=?", (mid,))
        conn.commit()
        r = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
    return _row(r) if r else None


def _row(r: sqlite3.Row) -> dict[str, Any]:
    return {"id": r["id"], "room": r["room"], "frm": r["frm"],
            "to": json.loads(r["to_json"]), "body": r["body"], "ts": r["ts"],
            "thread": r["thread"], "held": bool(r["held"])}


# ----------------------------------------------------------------------- rooms
class Client:
    def __init__(self, ws: WebSocket, name: str, kind: str):
        self.ws = ws
        self.name = name          # e.g. "mac-claude", "codex", "adrian"
        self.kind = kind          # "human" | "model" | "exec"


class Room:
    def __init__(self, name: str):
        self.name = name
        self.clients: dict[str, Client] = {}   # name -> Client (last writer wins)
        self.paused = False
        self.agent_streak = 0                  # consecutive agent->agent turns
        self.lock = asyncio.Lock()

    def roster(self) -> list[dict[str, Any]]:
        return [{"name": c.name, "kind": c.kind, "online": True}
                for c in self.clients.values()]


ROOMS: dict[str, Room] = {}


def _room(name: str) -> Room:
    r = ROOMS.get(name)
    if r is None:
        r = ROOMS[name] = Room(name)
    return r


def _addressed(to: list[str], client_name: str) -> bool:
    if any(t in ("@all", "@room", "@everyone") for t in to):
        return True
    return f"@{client_name}" in to or client_name in to


async def _send(client: Client, frame: dict[str, Any]) -> None:
    try:
        await client.ws.send_text(json.dumps(frame))
    except Exception:
        pass


async def _broadcast(room: Room, msg: dict[str, Any]) -> None:
    """Deliver a persisted msg to every connected client, flagging for_you."""
    frame_base = {"type": "msg", **msg}
    for c in list(room.clients.values()):
        frame = dict(frame_base)
        frame["for_you"] = (c.name != msg["frm"]) and _addressed(msg["to"], c.name)
        await _send(c, frame)


async def _push_roster(room: Room) -> None:
    frame = {"type": "roster", "agents": room.roster()}
    for c in list(room.clients.values()):
        await _send(c, frame)


# ------------------------------------------------------------------- endpoint
@app.on_event("startup")
def _startup() -> None:
    _init_db()


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {"ok": True, "rooms": {n: len(r.clients) for n, r in ROOMS.items()}}


@app.websocket("/ws")
async def ws(websocket: WebSocket,
             room: str = Query(...),
             agent: str = Query(...),
             kind: str = Query("model"),
             token: str = Query("")):
    # auth — bearer token via query (nginx may also enforce a header)
    hdr = websocket.headers.get("authorization", "")
    bearer = hdr[7:] if hdr.lower().startswith("bearer ") else ""
    if TOKEN and token != TOKEN and bearer != TOKEN:
        await websocket.close(code=4401)
        return
    if kind not in ("human", "model", "exec"):
        kind = "model"

    await websocket.accept()
    rm = _room(room)
    client = Client(websocket, agent, kind)
    rm.clients[agent] = client

    # backlog + roster on join
    await _send(client, {"type": "history",
                         "messages": _history(room, None, HISTORY_ON_JOIN)})
    await _send(client, {"type": "paused", "on": rm.paused})
    await _push_roster(rm)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await _send(client, {"type": "error", "reason": "bad json"})
                continue
            await _handle(rm, client, frame)
    except WebSocketDisconnect:
        pass
    finally:
        if rm.clients.get(agent) is client:
            del rm.clients[agent]
        await _push_roster(rm)


async def _handle(rm: Room, client: Client, frame: dict[str, Any]) -> None:
    ftype = frame.get("type")

    if ftype == "history":
        since = frame.get("since")
        await _send(client, {"type": "history",
                             "messages": _history(rm.name, since, HISTORY_ON_JOIN)})
        return

    if ftype == "pause":
        rm.paused = bool(frame.get("on", True))
        for c in list(rm.clients.values()):
            await _send(c, {"type": "paused", "on": rm.paused})
        return

    if ftype == "ack":
        ref = frame.get("ref")
        msg = _mark_acked(int(ref)) if ref is not None else None
        if msg:
            rm.agent_streak = 0        # human intervened -> reset guard
            await _broadcast(rm, msg)  # release the held message to its targets
        return

    if ftype == "say":
        body = (frame.get("body") or "").strip()
        if not body:
            return
        to = frame.get("to") or ["@all"]
        if isinstance(to, str):
            to = [to]
        thread = frame.get("thread")

        is_human = client.kind == "human"
        # loop-guard: count agent turns that target other agents
        held = False
        if is_human:
            rm.agent_streak = 0
        else:
            targets_agent = any(
                t not in ("@human", "@adrian") for t in to
            ) and not all(t in ("@human", "@adrian") for t in to)
            if targets_agent:
                rm.agent_streak += 1
            if rm.paused or rm.agent_streak > AGENT_TURN_LIMIT:
                held = True

        async with rm.lock:
            msg = _persist(rm.name, client.name, to, body, thread, held)

        if held:
            # notify humans that an agent message is waiting for release
            for c in list(rm.clients.values()):
                if c.kind == "human":
                    await _send(c, {"type": "held", **msg,
                                    "reason": "paused" if rm.paused
                                    else "loop-guard"})
            # echo back to sender so it knows it was held
            await _send(client, {"type": "held", **msg})
            return

        await _broadcast(rm, msg)
        return

    await _send(client, {"type": "error", "reason": f"unknown type {ftype!r}"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.environ.get("AGENT_ROOM_HOST", "127.0.0.1"),
                port=int(os.environ.get("AGENT_ROOM_PORT", "8790")))
