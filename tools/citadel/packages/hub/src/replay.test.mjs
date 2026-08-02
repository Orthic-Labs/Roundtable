// Run with: node --test 'tools/citadel/packages/hub/src/replay.test.mjs'
//
// Delivery-recovery rule 8 from the architecture spec: "A completed delivery is never reinjected."
//
// In its OWN file, like e2e-rust-node.test.mjs, because it opens real WebSocket servers, and
// keeping it separate keeps cancel.test.mjs pure store-level.
//
// This file used to wedge `node --test` at exit, which was long blamed on batch position and the
// environment. It was neither: the first test's assertion raced the hub's on-connect auto-flush and
// failed ~1 run in 3, and a failing test skipped its own `hub.close()`. Fixed 2026-07-26 — see
// STATUS.md, "The test-runner hang". Cleanup now lives in `t.after()` precisely so a future failure
// reports itself instead of hanging the runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from './store.mjs';
import { createHub } from './server.mjs';
import { PROTOCOL_VERSION, NodeFrame } from './wire.mjs';

const hello = (nodeId, token) => JSON.stringify({
  version: PROTOCOL_VERSION, event_id: crypto.randomUUID(), sent_at_ms: Date.now(),
  type: NodeFrame.HELLO,
  payload: {
    hello: {
      node_id: nodeId, token, hostname: 'm', os: 'macos', version: '0.1.0', resume_cursor: 0,
    },
  },
});

function fixture() {
  const store = Store.open(':memory:');
  const hub = createHub({ store, adminToken: 'tok', secure: false, allowedOrigins: [] });
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const token = 'replay-token';
  const node = store.registerNode({ name: 'mac', tokenHash: Store.hashNodeToken(token) });
  const seat = store.createSeat({
    roomId: room.id, nodeId: node.id, alias: 'a', provider: 'codex', sessionRef: 's',
  });
  return { store, hub, room, token, node, seat };
}

/**
 * Close a client socket and WAIT for it to actually close.
 *
 * `close()` only starts a closing handshake. Returning before it finishes races `hub.close()`,
 * and the half-closed client socket keeps the event loop alive after every test has passed —
 * which hangs `node --test` with nothing left to report. Confirmed with
 * process.getActiveResourcesInfo(): this file was the one leaving a TCPServerWrap and two
 * TCPSocketWraps behind.
 */
async function closeClient(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, 'close');
  ws.close();
  await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
}

/** Reconnect from cursor 0 and collect every frame the hub replays. */
async function replayedFrames(port, nodeId, token) {
  const conn = new WebSocket(`ws://127.0.0.1:${port}/node/connect`);
  await once(conn, 'open');
  const frames = [];
  // The global WebSocket is an EventTarget, not an EventEmitter — addEventListener, not .on().
  conn.addEventListener('message', (e) => frames.push(JSON.parse(e.data.toString())));
  conn.send(hello(nodeId, token));
  await new Promise((r) => setTimeout(r, 200));
  await closeClient(conn);
  return frames;
}

test('rule 8: a terminal delivery is never reinjected on reconnect replay', async (t) => {
  const { store, hub, room, token, node, seat } = fixture();
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  const { deliveries } = store.postMessage({
    roomId: room.id, actorId: crypto.randomUUID(), body: 'work', mentionSeatIds: [seat.id],
  });

  // Connect, take the delivery, then finish it the way a real node would.
  const first = new WebSocket(`ws://127.0.0.1:${addr.port}/node/connect`);
  await once(first, 'open');
  first.send(hello(node.id, token));
  await once(first, 'message'); // hello.accepted
  // The hub ALSO flushes on connect, from a deferred `setTimeout(..., 0)` that exists so
  // hello.accepted reaches the wire first. That auto-flush races this manual one, and whichever
  // gets there second finds nothing left to send. Asserting `flushDeliveries() === 1` therefore
  // asserted which of the two won — not the rule under test — and lost about one run in three.
  // When it lost, this test threw before reaching `hub.close()`, which left a listening server
  // and two live sockets behind and wedged `node --test` at exit: the "test-runner hang".
  // The precondition that actually matters is simply that the delivery went out before it is
  // marked completed, and after a synchronous flush that is true either way.
  hub.flushDeliveries();
  assert.equal(
    store.getDelivery(deliveries[0].id).state, 'sent',
    'the delivery must have been dispatched before it is marked completed',
  );
  store.forceDeliveryState(deliveries[0].id, 'acked');
  store.forceDeliveryState(deliveries[0].id, 'running');
  store.forceDeliveryState(deliveries[0].id, 'completed');
  await closeClient(first);
  await new Promise((r) => setTimeout(r, 50));

  // Reconnect from cursor 0 — the whole event history is eligible for replay. Before the fix the
  // hub re-sent every delivery.assign it had ever written, so a reconnect re-ran finished work:
  // observed live as a duplicate agent reply plus a run of "no active turn to steer" errors.
  const frames = await replayedFrames(addr.port, node.id, token);
  assert.equal(
    frames.filter((f) => f.type === 'delivery.assign').length, 0,
    'a completed delivery must never be replayed — that re-runs finished work on every reconnect',
  );
});

test('a still-outstanding delivery IS replayed on reconnect', async (t) => {
  // The other half of rule 8: skipping terminal deliveries must not skip outstanding ones, or a
  // node that drops mid-delivery silently loses the work.
  const { store, hub, room, token, node, seat } = fixture();
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  const first = new WebSocket(`ws://127.0.0.1:${addr.port}/node/connect`);
  await once(first, 'open');
  first.send(hello(node.id, token));
  await once(first, 'message');
  store.postMessage({
    roomId: room.id, actorId: crypto.randomUUID(), body: 'work', mentionSeatIds: [seat.id],
  });
  assert.equal(hub.flushDeliveries(), 1); // now 'sent', never acked — the node "crashed"
  await closeClient(first);
  await new Promise((r) => setTimeout(r, 50));

  const frames = await replayedFrames(addr.port, node.id, token);
  assert.equal(
    frames.filter((f) => f.type === 'delivery.assign').length, 1,
    'an unfinished delivery must survive a reconnect',
  );
});

test('a reconnecting node supersedes its previous connection', async (t) => {
  // A stale connection for the same node silently swallows deliveries: dispatch() picks the first
  // matching connection and reports success, so the delivery is marked `sent` while the live node
  // never sees it. Observed live after an SSH tunnel dropped — two node.connected for one node_id
  // with one disconnect between them, and two messages that simply vanished.
  const { store, hub, room, token, node, seat } = fixture();
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  const first = new WebSocket(`ws://127.0.0.1:${addr.port}/node/connect`);
  await once(first, 'open');
  first.send(hello(node.id, token));
  await once(first, 'message');
  assert.equal(hub.connectionCount, 1);

  // Second connection for the SAME node, without the first having closed.
  const second = new WebSocket(`ws://127.0.0.1:${addr.port}/node/connect`);
  await once(second, 'open');
  const frames = [];
  second.addEventListener('message', (e) => frames.push(JSON.parse(e.data.toString())));
  second.send(hello(node.id, token));
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(hub.connectionCount, 1, 'the stale connection must be evicted, not kept alongside');

  // The delivery must reach the LIVE connection.
  store.postMessage({
    roomId: room.id, actorId: crypto.randomUUID(), body: 'work', mentionSeatIds: [seat.id],
  });
  assert.equal(hub.flushDeliveries(), 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    frames.filter((f) => f.type === 'delivery.assign').length, 1,
    'the surviving connection must be the one that receives the delivery',
  );

  // Close BOTH client sockets. `first` was superseded by the hub, but that only closes the
  // SERVER side — the client-side handle stays open in this process and keeps the event loop
  // alive after every test has passed, which hangs `node --test`. Verified with
  // process.getActiveResourcesInfo(): this file was leaving a TCPServerWrap and two
  // TCPSocketWraps behind.
  await closeClient(first);
  await closeClient(second);
});
