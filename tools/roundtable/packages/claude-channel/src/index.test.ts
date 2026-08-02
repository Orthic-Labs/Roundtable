import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IpcClient } from "./ipc.js";
import { createChannel } from "./index.js";

test("ipc client serializes snake_case methods", () => {
  // Just ensures import + construction does not throw.
  const client = new IpcClient({ socketPath: "/tmp/no-such-socket" });
  assert.equal(typeof client.request, "function");
  assert.equal(typeof client.close, "function");
});

test("ipc client surfaces timeout when no peer", async () => {
  const client = new IpcClient({ socketPath: "/tmp/no-such-socket-" + Date.now(), timeoutMs: 100 });
  await assert.rejects(() => client.request("ping", {}), /timeout|ENOENT|ECONNREFUSED/);
});

test("citadel_join calls IPC redeem_invite with code, alias, session_ref, provider", async () => {
  const { server, client } = createChannel({ socketPath: "/tmp/no-such-socket-" + Date.now() });
  let seenMethod: string | undefined;
  let seenParams: Record<string, unknown> | undefined;
  // Stub the IPC transport so this test never touches a real socket — it only asserts on what
  // citadel_join hands to IpcClient.request, mirroring how the other tools call client.request.
  client.request = async (method: string, params: Record<string, unknown> = {}) => {
    seenMethod = method;
    seenParams = params;
    return { request_id: "00000000-0000-0000-0000-000000000000", ok: true, payload: { alias: "reviewer-2" } };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

  const result = await mcpClient.callTool({ name: "citadel_join", arguments: { code: "abc123", alias: "reviewer" } });

  assert.equal(seenMethod, "redeem_invite");
  assert.equal(seenParams?.code, "abc123");
  assert.equal(seenParams?.alias, "reviewer");
  assert.equal(seenParams?.provider, "claude");
  assert.equal(typeof seenParams?.session_ref, "string");
  assert.ok((seenParams?.session_ref as string).length > 0);

  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  assert.match(text, /reviewer-2/);

  await mcpClient.close();
  await server.close();
});

test("citadel_join surfaces the node/hub error when the node is unreachable", async () => {
  const { server, client } = createChannel({ socketPath: "/tmp/no-such-socket-" + Date.now(), });
  client.request = async () => {
    throw new Error("ipc request timeout: redeem_invite");
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

  const result = await mcpClient.callTool({ name: "citadel_join", arguments: { code: "abc123" } });
  assert.equal(result.isError, true);
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  assert.match(text, /timeout|redeem_invite/);

  await mcpClient.close();
  await server.close();
});

// Every test above stubs IpcClient.request, so none of them ever encoded a byte for the node.
// That gap hid three wire breaks at once: params nested instead of flat, replies correlated by an
// id the node never echoes, and a null payload on error replies failing schema parse. These tests
// speak to a fake node over a real socket, asserting the bytes the Rust parser actually accepts.
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeNode(handler: (req: Record<string, unknown>) => unknown): Promise<{ server: Server; path: string }> {
  const path = process.platform === "win32"
    ? String.raw`\\.\pipe\citadel-test-` + `${process.pid}-${Math.random().toString(36).slice(2)}`
    : join(tmpdir(), `citadel-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
  const server = createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        sock.write(JSON.stringify(handler(JSON.parse(line))) + "\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve({ server, path })));
}

test("wire: request fields are flat beside method, as the node's tagged enum requires", async () => {
  let seen: Record<string, unknown> | undefined;
  const { server, path } = await fakeNode((req) => {
    seen = req;
    // Mirrors the node: its own response id, never the caller's.
    return { request_id: "00000000-0000-0000-0000-000000000001", ok: true, payload: { seat: { alias: "zephyr" } } };
  });
  const client = new IpcClient({ socketPath: path, timeoutMs: 2000 });
  const resp = await client.request("redeem_invite", { code: "cit_x", alias: "a", session_ref: "s", provider: "claude" });

  assert.equal(seen?.method, "redeem_invite");
  assert.equal(seen?.code, "cit_x", "code must sit beside method, not under params");
  assert.equal(seen?.params, undefined, "no params envelope reaches the node");
  assert.equal(resp.ok, true);

  client.close();
  server.close();
});

test("wire: an error reply with a null payload and nil id still resolves the caller", async () => {
  const { server, path } = await fakeNode(() => ({
    request_id: "00000000-0000-0000-0000-000000000000",
    ok: false,
    payload: null,
    error: "invite_expired",
  }));
  const client = new IpcClient({ socketPath: path, timeoutMs: 2000 });
  const resp = await client.request("redeem_invite", { code: "cit_x", session_ref: "s", provider: "claude" });

  assert.equal(resp.ok, false);
  assert.equal(resp.error, "invite_expired");

  client.close();
  server.close();
});

test("wire: concurrent requests get their own replies, in order", async () => {
  const { server, path } = await fakeNode((req) => ({
    request_id: "00000000-0000-0000-0000-000000000002",
    ok: true,
    payload: { echo: req.nonce },
  }));
  const client = new IpcClient({ socketPath: path, timeoutMs: 2000 });
  await client.connect();
  const [a, b, c] = await Promise.all([
    client.request("ping", { nonce: "a" }),
    client.request("ping", { nonce: "b" }),
    client.request("ping", { nonce: "c" }),
  ]);

  assert.equal((a.payload as Record<string, unknown>).echo, "a");
  assert.equal((b.payload as Record<string, unknown>).echo, "b");
  assert.equal((c.payload as Record<string, unknown>).echo, "c");

  client.close();
  server.close();
});
