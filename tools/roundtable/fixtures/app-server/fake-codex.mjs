#!/usr/bin/env node
// Fixture Codex App Server, driven by citadel-node's tests over stdio JSON-RPC.
//
// Every shape here is grounded in fixtures/app-server/schema/ (a real schema generated via
// `codex app-server generate-json-schema --experimental` against a real, locally-installed
// `codex` CLI) — not invented. The load-bearing facts:
// - `thread/start` takes CONFIGURATION ONLY (cwd, model, sandbox, approvalPolicy, …). It has no
//   `input` field and it starts NO turn. It returns {thread: Thread} — the id is `thread.id`.
// - `turn/start` requires {threadId, input} and returns {turn: Turn} — id at `turn.id`.
// - `input` is an array of UserInput (tagged union); this fixture understands the `text` variant,
//   which is all citadel-node sends.
// - `turn/started` / `turn/completed` carry {threadId, turn: {id, status}}, never a flat
//   turnId/status. Status is one of inProgress | completed | interrupted | failed.
// - The real agent reply is an `item/completed` notification with item.type === "agentMessage"
//   and a flat item.text — not accumulated from `item/agentMessage/delta` chunks.
// - Approvals are Guardian auto-reviews (`item/autoApprovalReview/started|completed`), NOT a
//   server->client approval request. `tool/requestUserInput` does not exist in this protocol.
//
// Test hooks (not part of the real protocol, and namespaced so they can't be mistaken for it):
// send input text containing "@@deny@@" to make this fixture emit a DENIED Guardian review
// before completing the turn, exercising the approval path.
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

// Emits a DENIED Guardian review — the one state that actually blocks pending a human override.
function sendDeniedReview(threadId, turnId) {
  send({
    jsonrpc: "2.0",
    method: "item/autoApprovalReview/completed",
    params: {
      threadId,
      turnId,
      reviewId: randomUUID(),
      startedAtMs: Date.now() - 5,
      completedAtMs: Date.now(),
      decisionSource: "guardian",
      action: { type: "command", command: "rm -rf /tmp/x", cwd: "/tmp", source: "shell" },
      review: { status: "denied", riskLevel: "high", rationale: "destructive command" },
    },
  });
}

// Emits the notification sequence after a turn is under way. Callers send turn/started and their
// own JSON-RPC result themselves, so the notification-vs-result ordering stays visible per method.
function emitCompletion(threadId, turnId, input) {
  const text = extractText(input);
  setTimeout(() => {
    if (text.includes("@@deny@@")) sendDeniedReview(threadId, turnId);
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: randomUUID(), type: "agentMessage", text: `echo: ${text}` },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    });
  }, 10);
}

function threadObject(threadId, cwd) {
  const now = new Date().toISOString();
  return {
    id: threadId,
    cliVersion: "0.0.1",
    createdAt: now,
    updatedAt: now,
    cwd: cwd || "/tmp",
    ephemeral: false,
    modelProvider: "fake",
    preview: "",
    sessionId: randomUUID(),
    source: "app",
    status: "idle",
    turns: [],
  };
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
      // ClientInfo requires BOTH name and version. Real codex app-server rejects a missing
      // `version` with "Invalid request: missing field `version`"; this fixture used to accept
      // it, which is why the node shipped a handshake that only failed against real Codex.
      const info = params && params.clientInfo;
      if (!info || typeof info.name !== "string" || typeof info.version !== "string") {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid request: missing field `version`" } });
        continue;
      }
      send({ jsonrpc: "2.0", id, result: { serverInfo: { name: "fake-codex", version: "0.0.1" }, capabilities: {} } });
      continue;
    }
    if (method === "thread/start") {
      // Config only, and NO turn is started — matching the real params/response.
      const threadId = randomUUID();
      send({
        jsonrpc: "2.0",
        id,
        result: {
          thread: threadObject(threadId, params && params.cwd),
          cwd: (params && params.cwd) || "/tmp",
          model: "fake-model",
          modelProvider: "fake",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: "none",
        },
      });
      continue;
    }
    if (method === "thread/resume") {
      const threadId = (params && params.threadId) || randomUUID();
      send({ jsonrpc: "2.0", id, result: { thread: threadObject(threadId, params && params.cwd) } });
      continue;
    }
    if (method === "turn/start") {
      const threadId = params && params.threadId;
      const turnId = randomUUID();
      send({
        jsonrpc: "2.0",
        id,
        result: { turn: { id: turnId, status: "inProgress", items: [] } },
      });
      sendTurnStarted(threadId, turnId);
      emitCompletion(threadId, turnId, params && params.input);
      continue;
    }
    if (method === "turn/interrupt") {
      const threadId = params && params.threadId;
      send({ jsonrpc: "2.0", id, result: {} });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId, turn: { id: randomUUID(), status: "interrupted" } },
      });
      continue;
    }
    if (method === "thread/approveGuardianDeniedAction") {
      send({ jsonrpc: "2.0", id, result: {} });
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
