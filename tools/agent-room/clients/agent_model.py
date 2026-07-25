#!/usr/bin/env python3
"""
agent_model — a hosted-model participant in an Agent Room.

Connects as an agent, and whenever it is @-mentioned it calls the model's
HTTP API with the recent room transcript and posts the reply back. Keys
live only on the machine running this client (never sent to the room).

Adapters below use the CORRECT current request/response shapes:
  * Anthropic Messages: x-api-key + anthropic-version; reply at
    content[0].text  (NOT choices[].message — that is OpenAI's shape).
  * OpenAI / MiniMax / Groq / NVIDIA NIM: OpenAI chat-completions shape;
    reply at choices[0].message.content.

    pip install websockets
    ANTHROPIC_API_KEY=... python agent_model.py \
        --url wss://box/agentroom --room memright --agent claude \
        --provider anthropic --model claude-opus-4-8 \
        --system "You are the architecture partner in this room." \
        --token "$AGENT_ROOM_TOKEN"
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import urllib.request
from typing import Any

from roomclient import RoomClient

# provider -> (endpoint, default_model, auth_style)
PROVIDERS = {
    "anthropic": ("https://api.anthropic.com/v1/messages", "claude-opus-4-8", "anthropic"),
    "openai":    ("https://api.openai.com/v1/chat/completions", "gpt-5.6", "bearer"),
    "minimax":   ("https://api.minimax.io/v1/text/chatcompletion_v2", "MiniMax-M3", "bearer"),
    "groq":      ("https://api.groq.com/openai/v1/chat/completions", "llama-3.3-70b-versatile", "bearer"),
    "nvidia":    ("https://integrate.api.nvidia.com/v1/chat/completions", "openai/gpt-oss-120b", "bearer"),
}
KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY",
    "minimax": "MINIMAX_API_KEY", "groq": "GROQ_API_KEY", "nvidia": "NVIDIA_API_KEY",
}


def _post(url: str, headers: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


def call_model(provider: str, model: str, key: str, system: str,
               transcript: str, prompt: str, max_tokens: int = 1024) -> str:
    endpoint, _, auth = PROVIDERS[provider]
    user = (f"Recent room conversation:\n{transcript}\n\n"
            f"You were addressed with:\n{prompt}\n\n"
            f"Reply as a participant in the room.")

    if auth == "anthropic":
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01",
                   "content-type": "application/json"}
        payload = {"model": model, "max_tokens": max_tokens, "system": system,
                   "messages": [{"role": "user", "content": user}]}
        data = _post(endpoint, headers, payload)
        # Anthropic: {"content":[{"type":"text","text":"..."}], "role":"assistant"}
        parts = [b.get("text", "") for b in data.get("content", [])
                 if b.get("type") == "text"]
        return "".join(parts).strip() or "(empty reply)"

    # OpenAI-compatible (openai / minimax / groq / nvidia)
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    payload = {"model": model, "max_tokens": max_tokens,
               "messages": [{"role": "system", "content": system},
                            {"role": "user", "content": user}]}
    data = _post(endpoint, headers, payload)
    return data["choices"][0]["message"]["content"].strip()


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="wss://host/path (no /ws)")
    ap.add_argument("--room", required=True)
    ap.add_argument("--agent", required=True)
    ap.add_argument("--provider", required=True, choices=list(PROVIDERS))
    ap.add_argument("--model", default=None)
    ap.add_argument("--system", default="You are a helpful agent in a shared room.")
    ap.add_argument("--token", default=os.environ.get("AGENT_ROOM_TOKEN", ""))
    ap.add_argument("--max-tokens", type=int, default=1024)
    args = ap.parse_args()

    model = args.model or PROVIDERS[args.provider][1]
    key = os.environ.get(KEY_ENV[args.provider], "")
    if not key:
        raise SystemExit(f"missing {KEY_ENV[args.provider]} in env")

    client = RoomClient(args.url, args.room, args.agent, args.token, kind="model")
    busy = asyncio.Lock()

    async def on_message(msg: dict[str, Any]) -> None:
        if not msg.get("for_you"):
            return
        async with busy:  # one turn at a time; avoids talking over itself
            try:
                reply = await asyncio.to_thread(
                    call_model, args.provider, model, key, args.system,
                    client.context_text(), msg["body"], args.max_tokens)
            except Exception as e:  # noqa: BLE001
                reply = f"(model error: {e})"
            # reply to whoever addressed us; keep the thread
            await client.say(reply, to=[f'@{msg["frm"]}'], thread=msg.get("thread") or msg["id"])

    await client.run(on_message)


if __name__ == "__main__":
    asyncio.run(main())
