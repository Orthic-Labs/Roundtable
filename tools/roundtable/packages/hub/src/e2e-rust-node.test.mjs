// Run with: node --test 'tools/roundtable/packages/hub/src/e2e-rust-node.test.mjs'
//
// The definitive test for the whole gap this session closed: a REAL compiled roundtable-node
// binary, dialling a REAL Node hub over a REAL WebSocket, driving a REAL Codex App Server fixture
// process — not mocks at any layer. A message mentioning a Codex seat should produce a reply
// message in the room, posted by the node on the seat's behalf.
//
// Slower than the rest of the suite (spawns a subprocess, `cargo build` on first run) and
// deliberately isolated in its own file so it can be skipped in a hurry with
// `node --test --test-name-pattern='^(?!.*rust node)' 'src/*.test.mjs'` without editing this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from './server.mjs';
import { Store } from './store.mjs';

// packages/hub/src/ -> packages/hub -> packages -> tools/roundtable (the Cargo workspace root)
const RUST_WORKSPACE = fileURLToPath(new URL('../../..', import.meta.url));
const NODE_BINARY = join(RUST_WORKSPACE, 'target', 'debug', 'roundtable-node');
const FIXTURE_CODEX = join(RUST_WORKSPACE, 'fixtures', 'app-server', 'fake-codex.mjs');

test('E2E: the real compiled roundtable-node binary delivers a message to Codex and posts a reply', async (t) => {
  // Deliberately does NOT shell out to `cargo build` from here: spawning cargo as a child of the
  // test runner with inherited stdio hung indefinitely in this sandboxed environment even though
  // `cargo build -p roundtable-node` run directly took 0.24s. Requiring a pre-built binary is a
  // normal, cheap precondition for an E2E test (the workspace's own `cargo test` already builds
  // it) rather than something worth debugging a subprocess-spawning quirk for.
  if (!existsSync(NODE_BINARY)) {
    t.skip(`roundtable-node binary not built at ${NODE_BINARY} — run: cargo build -p roundtable-node`);
    return;
  }

  const store = Store.open(':memory:');
  const hub = createHub({ store, adminToken: 'e2e-token', secure: false, allowedOrigins: [] });
  const addr = await hub.listen(0);

  const room = store.createRoom({ slug: 'e2e-rust', title: 'E2E Rust Node' });
  const dbNode = store.registerNode({ name: 'mac', tokenHash: 'unused-by-this-hub' });
  const seat = store.createSeat({
    roomId: room.id, nodeId: dbNode.id, alias: 'mac-codex', provider: 'codex', sessionRef: 'thread-none-yet',
  });

  const workDir = await mkdtemp(join(tmpdir(), 'rt-e2e-'));
  const config = {
    hub_url: `ws://127.0.0.1:${addr.port}/node/connect`,
    node_id: dbNode.id,
    hostname: 'mac', os: 'macos', version: '0.1.0',
    ipc_socket_path: join(workDir, 'ipc.sock'),
    state_path: join(workDir, 'state.json'),
    codex_command: ['node', FIXTURE_CODEX],
    codex_cwd: null,
    reconnect_base_ms: 500, heartbeat_ms: 15000, heartbeat_offline_after_ms: 45000,
  };
  await writeFile(join(workDir, 'config.json'), JSON.stringify(config));

  const nodeProc = spawn(NODE_BINARY, [], {
    cwd: workDir,
    env: {
      ...process.env,
      ROUNDTABLE_NODE_CONFIG: join(workDir, 'config.json'),
      ROUNDTABLE_NODE_TOKEN: 'node-secret',
      RUST_LOG: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let nodeOutput = '';
  nodeProc.stdout.on('data', (c) => { nodeOutput += c; });
  nodeProc.stderr.on('data', (c) => { nodeOutput += c; });
  // t.after, not a bare await at the end of the test body: an assertion failure anywhere above
  // would otherwise skip cleanup entirely, leaving the hub's server listening and the process
  // never draining — which is exactly what happened once (a failed assertion produced one line
  // of output and then the whole `node --test` invocation hung indefinitely).
  t.after(async () => {
    nodeProc.kill();
    await hub.close();
  });

  // Give the real binary time to dial the hub over WS and complete the codex handshake.
  const connected = await waitFor(() => hub.connectionCount > 0, 5000);
  assert.ok(connected, `node never connected to the hub. Output:\n${nodeOutput}`);

  // actorId must be a real UUID: Message.actor_id is typed Uuid in the Rust protocol, and a
  // human-readable placeholder like 'adrian' fails roundtable-node's deserialization with
  // "UUID parsing failed" — silently, until the warning added to hub.rs made it visible. Every
  // actor, human included, needs a genuine UUID identity on the real wire, not just seats/nodes.
  const { deliveries } = store.postMessage({
    roomId: room.id, actorId: crypto.randomUUID(), body: 'say hello', mentionSeatIds: [seat.id],
  });
  assert.equal(deliveries.length, 1);
  assert.equal(hub.flushDeliveries(), 1, 'the connected node should take the delivery');

  // The real node: receives delivery.assign -> registers the seat -> calls execute() against the
  // real fixture process -> receives a CodexEvent -> posts node.message.post back to this hub.
  const replyLanded = await waitFor(
    () => store.listMessages(room.id).some((m) => m.actor_id === seat.id),
    5000,
  );
  assert.ok(replyLanded, `no reply from the node within 5s. Node output:\n${nodeOutput}`);

  const messages = store.listMessages(room.id);
  const reply = messages.find((m) => m.actor_id === seat.id);
  assert.equal(reply.actor_kind, 'agent');
  assert.match(reply.body, /turn (Running|Completed|Failed|WaitingApproval|Cancelled)/,
    'the reply is the synthetic status body documented in main.rs::handle_codex_event');
});

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}
