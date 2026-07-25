#!/usr/bin/env node
// Fixture Codex App Server, driven by roundtable-node's tests over stdio JSON-RPC.
//
// Shapes below are grounded in fixtures/app-server/schema/ (a real schema generated via
// `codex app-server generate-json-schema --experimental` against a real, locally-installed
// `codex` CLI) — not invented. In particular:
// - `turn/started` / `turn/completed` carry `{threadId, turn: {id, status}}`, never a flat
//   `turnId`/`status`. `status` is one of `inProgress | completed | interrupted | failed`.
// - `thread/start` / `turn/start`'s `input` is an array of `UserInput` (tagged union); this
//   fixture only understands the `text` variant, which is all roundtable-node ever sends.
// - The real agent reply is an `item/completed` notification with `item.type === "agentMessage"`
//   and a flat `item.text`, sent once the turn's content is ready — not accumulated from
//   `item/agentMessage/delta` chunks (this fixture doesn't emit deltas at all).
import { randomUUID } from "node:crypto";

function send(o) {
  process.stdout.write(JSON.stringify(o) + "\n");
}

function extractText(input) {
  if (Array.isArray(input)) {
    const textPart = input.find((part) => part && part.type === "text");
    return textPart ? textPart.text : "";
  }
  return typeof input === "string" ? input : "";
}

function sendTurnStarted(threadId, turnId) {
  send({
    jsonrpc: "2.0",
    method: "turn/started",
    params: { threadId, turn: { id: turnId, status: "inProgress" } },
  });
}

// Emits item/completed then turn/completed ~10ms later. Callers send turn/started and their own
// JSON-RPC `result` for the request that triggered this themselves — thread/start deliberately
// sends turn/started BEFORE its id-response (see below; a real, documented race), so the
// notification-vs-result ordering can't be hidden inside one shared helper.
function emitCompletion(threadId, turnId, input) {
  setTimeout(() => {
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: randomUUID(), type: "agentMessage", text: `echo: ${extractText(input)}` },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    });
  }, 10);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let newlineIndex;
  while ((newlineIndex = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, newlineIndex);
    buf = buf.slice(newlineIndex + 1);
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = request;
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { serverInfo: { name: "fake-codex", version: "0.0.1" }, capabilities: {} } });
      continue;
    }
    if (method === "thread/start") {
      // Deliberately sends turn/started BEFORE the id-response `call()` is waiting on — a real
      // race roundtable-node's tests document and rely on (see codex.rs's
      // create_thread_round_trips_and_routes_events_to_the_seat).
      const threadId = (params && params.threadId) || randomUUID();
      const turnId = randomUUID();
      sendTurnStarted(threadId, turnId);
      send({ jsonrpc: "2.0", id, result: { threadId } });
      emitCompletion(threadId, turnId, params && params.input);
      continue;
    }
    if (method === "turn/start") {
      const threadId = params && params.threadId;
      const turnId = randomUUID();
      send({ jsonrpc: "2.0", id, result: { turnId, threadId } });
      sendTurnStarted(threadId, turnId);
      emitCompletion(threadId, turnId, params && params.input);
      continue;
    }
    if (method === "shutdown") {
      send({ jsonrpc: "2.0", id, result: { ok: true } });
      setTimeout(() => process.exit(0), 5);
      continue;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "not impl: " + method } });
  }
});
