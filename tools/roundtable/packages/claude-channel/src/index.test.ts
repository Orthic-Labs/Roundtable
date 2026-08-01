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
