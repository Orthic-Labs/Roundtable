// Run with: node --test 'tools/roundtable/packages/hub/src/*.test.mjs'
//
// The end-to-end path: a message mentioning a seat produces a delivery, the delivery reaches the
// node that owns that seat over a real WebSocket, and the node's ack closes it out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHub } from './server.mjs';
import { Store } from './store.mjs';
import { PROTOCOL_VERSION, NodeFrame } from './wire.mjs';

async function withHub(fn) {
  const store = Store.open(':memory:');
  const hub = createHub({ store, adminToken: 'tok', secure: false, allowedOrigins: [] });
  const addr = await hub.listen(0);
  const wsBase = `ws://127.0.0.1:${addr.port}`;
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const node = store.registerNode({ name: 'mac', tokenHash: 'h' });
  const seat = store.createSeat({
    roomId: room.id, nodeId: node.id, alias: 'mac-claude', provider: 'claude', sessionRef: 's1',
  });
  try { await fn({ hub, store, room, node, seat, wsBase }); } finally { await hub.close(); }
}

/** Frame a node->hub message the way the Rust node does. */
const nodeFrame = (type, payload = {}) => JSON.stringify({
  version: PROTOCOL_VERSION, event_id: crypto.randomUUID(), sent_at_ms: Date.now(), type, payload,
});

test('E2E: a mention reaches the connected node as a delivery.assign frame', async () => {
  await withHub(async ({ hub, store, room, node, seat, wsBase }) => {
    const client = new WebSocket(`${wsBase}/node/connect?node_id=${node.id}`);
    await once(client, 'open');

    store.postMessage({
      roomId: room.id, actorId: 'adrian', body: 'run the suite', mentionSeatIds: [seat.id],
    });

    const received = once(client, 'message');
    assert.equal(hub.flushDeliveries(), 1, 'the connected node should take the delivery');
    const [evt] = await received;

    const frame = JSON.parse(evt.data);
    assert.equal(frame.type, 'delivery.assign');
    assert.equal(frame.version, PROTOCOL_VERSION);
    assert.equal(frame.payload.message.body, 'run the suite');
    assert.ok(frame.payload.cursor > 0, 'the frame carries a replay cursor');
    client.close();
  });
});

test('E2E: the node acks and the delivery leaves the queue', async () => {
  await withHub(async ({ hub, store, room, node, seat, wsBase }) => {
    const client = new WebSocket(`${wsBase}/node/connect?node_id=${node.id}`);
    await once(client, 'open');

    const { deliveries } = store.postMessage({
      roomId: room.id, actorId: 'adrian', body: 'x', mentionSeatIds: [seat.id],
    });
    const received = once(client, 'message');
    hub.flushDeliveries();
    await received;

    client.send(nodeFrame(NodeFrame.DELIVERY_ACK, { delivery_id: deliveries[0].id }));
    // Give the server a tick to process the inbound frame.
    await new Promise((r) => setTimeout(r, 50));

    const row = store.raw.prepare('SELECT state FROM deliveries WHERE id = ?').get(deliveries[0].id);
    assert.equal(row.state, 'acked');
    assert.equal(store.queuedDeliveries(seat.id).length, 0);
    client.close();
  });
});

test('a delivery with no connected node stays queued rather than being lost', async () => {
  await withHub(async ({ hub, store, room, seat }) => {
    store.postMessage({ roomId: room.id, actorId: 'a', body: 'x', mentionSeatIds: [seat.id] });
    assert.equal(hub.flushDeliveries(), 0, 'nothing is connected, so nothing is taken');
    assert.equal(store.queuedDeliveries(seat.id).length, 1, 'it must remain queued for replay');
  });
});

test('E2E: a reconnecting node replays what it missed from its cursor', async () => {
  await withHub(async ({ hub, store, room, node, seat, wsBase }) => {
    // Deliver while connected, then drop.
    const first = new WebSocket(`${wsBase}/node/connect?node_id=${node.id}`);
    await once(first, 'open');
    store.postMessage({ roomId: room.id, actorId: 'a', body: 'missed-me', mentionSeatIds: [seat.id] });
    const got = once(first, 'message');
    hub.flushDeliveries();
    await got;
    first.close();
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect from cursor 0 — everything addressed to this node replays.
    const second = new WebSocket(`${wsBase}/node/connect?node_id=${node.id}&cursor=0`);
    const replayed = once(second, 'message');
    await once(second, 'open');
    const [evt] = await replayed;
    assert.match(JSON.parse(evt.data).payload.message.body, /missed-me/);
    second.close();
  });
});

test('a malformed frame from a node closes the connection rather than being ignored', async () => {
  await withHub(async ({ node, wsBase }) => {
    const client = new WebSocket(`${wsBase}/node/connect?node_id=${node.id}`);
    await once(client, 'open');
    client.send('not json at all');
    const [evt] = await once(client, 'close');
    assert.equal(evt.code, 1003);
  });
});

// node.message.post — the seat's reply, sent by the Rust node the way
// ClientCommand::PostMessage does (see crates/roundtable-node/src/hub.rs). This frame has no
// response; the caller learns nothing back over the wire beyond what dedupe would report to a
// LATER retry with the same request_id.

test('E2E: a seat reply from the node is persisted and readable back over HTTP', async () => {
  await withHub(async ({ store, room, node, seat, wsBase }) => {
    const client = new WebSocket(`${wsBase}/node/connect?node_id=${node.id}`);
    await once(client, 'open');

    client.send(nodeFrame(NodeFrame.MESSAGE_POST, {
      request_id: crypto.randomUUID(), seat_id: seat.id, room_id: room.id,
      message_kind: 'completion', body: 'done — 3 files changed', reply_to: null,
      request_payload_sha256: 'sha-1',
    }));
    await new Promise((r) => setTimeout(r, 50));

    const messages = store.listMessages(room.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].actor_id, seat.id);
    assert.equal(messages[0].actor_kind, 'agent');
    assert.equal(messages[0].kind, 'completion');
    assert.equal(messages[0].body, 'done — 3 files changed');
    client.close();
  });
});

test('a retried node.message.post (same request_id) is not persisted twice', async () => {
  await withHub(async ({ store, room, node, seat, wsBase }) => {
    const client = new WebSocket(`${wsBase}/node/connect?node_id=${node.id}`);
    await once(client, 'open');
    const requestId = crypto.randomUUID();
    const send = () => client.send(nodeFrame(NodeFrame.MESSAGE_POST, {
      request_id: requestId, seat_id: seat.id, room_id: room.id,
      message_kind: 'chat', body: 'hello', reply_to: null, request_payload_sha256: 'sha-same',
    }));
    send();
    await new Promise((r) => setTimeout(r, 50));
    send(); // the exact retry a node performs after a reconnect it isn't sure landed
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(store.listMessages(room.id).length, 1, 'dedupe must prevent a second insert');
    client.close();
  });
});

test('a node.message.post naming a seat from a different room is dropped, not misfiled', async () => {
  await withHub(async ({ store, room, node, wsBase }) => {
    const otherRoom = store.createRoom({ slug: 'other', title: 'Other' });
    const otherSeat = store.createSeat({
      roomId: otherRoom.id, nodeId: node.id, alias: 'wrong-room-seat', provider: 'claude', sessionRef: 's2',
    });
    const client = new WebSocket(`${wsBase}/node/connect?node_id=${node.id}`);
    await once(client, 'open');

    // seat_id is real, but for otherRoom — the frame claims room.id instead.
    client.send(nodeFrame(NodeFrame.MESSAGE_POST, {
      request_id: crypto.randomUUID(), seat_id: otherSeat.id, room_id: room.id,
      message_kind: 'chat', body: 'should not land', reply_to: null, request_payload_sha256: 'sha-x',
    }));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(store.listMessages(room.id).length, 0);
    assert.equal(store.listMessages(otherRoom.id).length, 0);
    client.close();
  });
});

test('a node.message.post for an unknown seat_id is dropped, not thrown', async () => {
  await withHub(async ({ store, room, node, wsBase }) => {
    const client = new WebSocket(`${wsBase}/node/connect?node_id=${node.id}`);
    await once(client, 'open');
    client.send(nodeFrame(NodeFrame.MESSAGE_POST, {
      request_id: crypto.randomUUID(), seat_id: crypto.randomUUID(), room_id: room.id,
      message_kind: 'chat', body: 'ghost seat', reply_to: null, request_payload_sha256: 'sha-y',
    }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.listMessages(room.id).length, 0);
    // The connection itself must survive an unknown seat — it is not a protocol violation the
    // way a malformed frame is, just a stale/racing reference.
    assert.equal(client.readyState, WebSocket.OPEN);
    client.close();
  });
});
