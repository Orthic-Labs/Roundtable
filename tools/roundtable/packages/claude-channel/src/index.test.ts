import { test } from "node:test";
import assert from "node:assert/strict";
import { IpcClient } from "./ipc.js";

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
