#!/usr/bin/env python3
"""
agent_exec — a coding-session participant in an Agent Room.

This is the piece that makes "@mac-claude pull and run the daily-sync smoke"
a live action instead of a message you relay by hand. When this client is
@-mentioned, it runs the instruction as a HEADLESS coding-agent invocation
IN A REPO on this machine, streams the agent's output back into the room,
and posts a final done line. The agent can edit, run, and commit for real.

Two backends out of the box (swap via --cmd for anything else):
  * claude-code : claude -p "<instruction>" --output-format stream-json --verbose
  * codex       : codex exec "<instruction>"

The instruction is passed on stdin (safe for arbitrary text). Room context
is prepended so the coding agent sees what was being discussed.

    pip install websockets
    python agent_exec.py --url wss://box/agentroom --room memright \
        --agent mac-claude --backend claude-code \
        --cwd ~/claude/... --token "$AGENT_ROOM_TOKEN"

SECURITY: this executes a coding agent with tool access on this machine.
Run it only for rooms and repos you control. --permission-mode defaults to
the safe interactive default of the backend; pass --yolo to opt into
bypass mode explicitly (audited in the room).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
from pathlib import Path
from typing import Any

from roomclient import RoomClient

BACKENDS = {
    # {instr} is replaced with a placeholder; the real text goes on stdin
    "claude-code": ["claude", "-p", "--output-format", "stream-json", "--verbose"],
    "codex":       ["codex", "exec", "-"],
}


def build_cmd(backend: str, extra: list[str], yolo: bool) -> list[str]:
    cmd = list(BACKENDS[backend])
    if backend == "claude-code":
        cmd += ["--permission-mode", "bypassPermissions" if yolo else "default"]
    cmd += extra
    return cmd


def parse_line(backend: str, line: str) -> str | None:
    """Turn one stdout line from the backend into room-postable text, or None."""
    line = line.rstrip("\n")
    if not line:
        return None
    if backend == "claude-code":
        # stream-json: one JSON object per line
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            return line
        if evt.get("type") == "assistant":
            blocks = evt.get("message", {}).get("content", [])
            txt = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
            return txt.strip() or None
        if evt.get("type") == "result":
            return None  # final handled by caller
        return None
    return line  # codex / generic: stream raw


async def run_instruction(client: RoomClient, backend: str, cmd: list[str],
                          cwd: str, instruction: str, context: str,
                          reply_to: str, thread: int) -> None:
    stdin_text = (f"[Agent Room — repo work requested by @{reply_to}]\n"
                  f"Recent discussion:\n{context}\n\n"
                  f"Instruction:\n{instruction}\n")
    await client.say(f"▶ running in `{cwd}` ({backend})…",
                     to=[f"@{reply_to}"], thread=thread)
    proc = await asyncio.create_subprocess_exec(
        *cmd, cwd=cwd, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    assert proc.stdin and proc.stdout
    proc.stdin.write(stdin_text.encode())
    await proc.stdin.drain()
    proc.stdin.close()

    async for raw in proc.stdout:
        text = parse_line(backend, raw.decode(errors="replace"))
        if text:
            await client.say(text, to=[f"@{reply_to}"], thread=thread)
    rc = await proc.wait()
    await client.say(f"✔ done (exit {rc})" if rc == 0 else f"✖ failed (exit {rc})",
                     to=[f"@{reply_to}"], thread=thread)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--room", required=True)
    ap.add_argument("--agent", required=True)
    ap.add_argument("--backend", choices=list(BACKENDS), default="claude-code")
    ap.add_argument("--cwd", required=True, help="repo checkout to run in")
    ap.add_argument("--cmd", default="", help="override: full shell command template")
    ap.add_argument("--yolo", action="store_true", help="bypass permission prompts")
    ap.add_argument("--token", default=os.environ.get("AGENT_ROOM_TOKEN", ""))
    args = ap.parse_args()

    cwd = str(Path(args.cwd).expanduser())
    cmd = shlex.split(args.cmd) if args.cmd else build_cmd(args.backend, [], args.yolo)

    client = RoomClient(args.url, args.room, args.agent, args.token, kind="exec")
    busy = asyncio.Lock()

    async def on_message(msg: dict[str, Any]) -> None:
        if not msg.get("for_you"):
            return
        if busy.locked():
            await client.say("(busy on a task — queued after current run)",
                             to=[f'@{msg["frm"]}'])
        async with busy:
            await run_instruction(
                client, args.backend, cmd, cwd, msg["body"],
                client.context_text(), msg["frm"], msg.get("thread") or msg["id"])

    print(f"[exec] {args.agent} bridging {args.backend} in {cwd}")
    await client.run(on_message)


if __name__ == "__main__":
    asyncio.run(main())
