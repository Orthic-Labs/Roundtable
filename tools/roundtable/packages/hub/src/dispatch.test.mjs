// Run with: node --test 'tools/roundtable/packages/hub/src/*.test.mjs'
//
// The end-to-end path: a message mentioning a seat produces a delivery, the delivery reaches the
// node that owns that seat over a real WebSocket, and the node's ack closes it out.
//
// Frame shapes here match roundtable-node's REAL serialization, not a hand-guessed one. Every
// HubCommand variant (Hello, DeliveryAck, MessagePost, ...) is a Rust enum with
// `#[serde(rename_all = "snake_case")]` and no explicit tag/content attribute, so serde's default
// externally-tagged representation wraps each variant's fields one level deeper under its own
// snake_case name — e.g. `{"hello": {node_id, token, ...}}`, not `{node_id, token, ...}` flat.
// This was discovered by e2e-rust-node.test.mjs spawning the real compiled binary: every test
// here previously used a flat, self-consistent-but-wrong shape that no test caught because both
// the fake sender and the (also wrong) hub-side reader agreed with each other, never with Rust.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHub } from './server.mjs';
import { Store } from './store.mjs';
import { PROTOCOL_VERSION, NodeFrame } from './wire.mjs';

/** The hub verifies this against the node's stored token_hash — it is not decorative. */
const NODE_TOKEN = 'test-node-token';

async function withHub(fn) {
  const store = Store.open(':memory:');
  const hub = createHub({ store, adminToken: 'tok', secure: false, allowedOrigins: [] });
  const addr = await hub.listen(0);
  const wsBase = `ws://127.0.0.1:${addr.port}`;
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const node = store.registerNode({ name: 'mac', tokenHash: Store.hashNodeToken(NODE_TOKEN) });
  const seat = store.createSeat({
    roomId: room.id, nodeId: node.id, alias: 'mac-claude', provider: 'claude', sessionRef: 's1',
  });
  try { await fn({ hub, store, room, node, seat, wsBase }); } finally { await hub.close(); }
}

/** Frame a node->hub message the way the Rust node does. */
const nodeFrame = (type, payload = {}) => JSON.stringify({
  version: PROTOCOL_VERSION, event_id: crypto.randomUUID(), sent_at_ms: Date.now(), type, payload,
});

/**
 * Connects a fake node the way the REAL roundtable-node binary does
 * (crates/roundtable-node/src/hub.rs::connect_and_drive): open the socket, send node.hello
 * FIRST — there is no `?node_id=` query string on the real client's URL — then read exactly one
 * frame back and require it to be hello.accepted.
 */
async function connectAsNode(wsBase, nodeId, { resumeCursor = 0 } = {}) {
  const client = new WebSocket(`${wsBase}/node/connect`);
  await once(client, 'open');

  // Collect EVERY frame from the moment the socket opens, before the handshake is sent.
  //
  // This is not belt-and-braces: on reconnect the hub sends hello.accepted and the replayed
  // delivery.assign frames back to back in the same tick. Awaiting them one at a time with
  // `once()` loses any frame that arrived before the next listener attached, and the test then
  // waits forever for a message already delivered. That race — not batch position, and not the
  // environment — is what hung `node --test` in this file for weeks.
  client.frames = [];
  client.addEventListener('message', (e) => client.frames.push(JSON.parse(e.data)));
  /** Resolve once a frame of `type` has arrived, whether it landed before or after this call. */
  client.waitFor = async (type, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = client.frames.find((f) => f.type === type);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}; got ${client.frames.map((f) => f.type).join(',') || 'nothing'}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  client.send(nodeFrame(NodeFrame.HELLO, {
    hello: {
      node_id: nodeId, token: NODE_TOKEN, hostname: 'mac', os: 'macos',
      version: '0.1.0', resume_cursor: resumeCursor,
    },
  }));
  await client.waitFor('hello.accepted');
  return client;
}

test('E2E: a mention reaches the connected node as a delivery.assign frame', async () => {
  await withHub(async ({ hub, store, room, node, seat, wsBase }) => {
    const client = await connectAsNode(wsBase, node.id);

    store.postMessage({
      roomId: room.id, actorId: 'adrian', body: 'run the suite', mentionSeatIds: [seat.id],
    });

    const received = once(client, 'message');
    assert.equal(hub.flushDeliveries(), 1, 'the connected node should take the delivery');
    const [evt] = await received;

    const frame = JSON.parse(evt.data);
    assert.equal(frame.type, 'delivery.assign');
    assert.equal(frame.version, PROTOCOL_VERSION);
    // Wrapped under delivery_assign: matches roundtable-node's HubEvent::DeliveryAssign, an
    // externally-tagged struct variant.
    const inner = frame.payload.delivery_assign;
    assert.equal(inner.message.body, 'run the suite');
    assert.equal(inner.room_slug, 'r');
    assert.equal(inner.room_title, 'R');
    assert.deepEqual(inner.context_messages, [], 'first message in the room has no prior context');
    assert.equal(inner.parent, null, 'not a reply');
    assert.equal(inner.seats.length, 1);
    assert.deepEqual(inner.message.mentioned_seat_ids, [seat.id]);
    client.close();
  });
});

test('E2E: the node acks and the delivery leaves the queue', async () => {
  await withHub(async ({ hub, store, room, node, seat, wsBase }) => {
    const client = await connectAsNode(wsBase, node.id);

    const { deliveries } = store.postMessage({
      roomId: room.id, actorId: 'adrian', body: 'x', mentionSeatIds: [seat.id],
    });
    const received = once(client, 'message');
    hub.flushDeliveries();
    await received;

    // HubCommand::DeliveryAck { delivery_id } is a struct variant -> wrapped under delivery_ack.
    client.send(nodeFrame(NodeFrame.DELIVERY_ACK, { delivery_ack: { delivery_id: deliveries[0].id } }));
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
    const first = await connectAsNode(wsBase, node.id);
    store.postMessage({ roomId: room.id, actorId: 'a', body: 'missed-me', mentionSeatIds: [seat.id] });
    const got = once(first, 'message');
    hub.flushDeliveries();
    await got;
    first.close();
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect from cursor 0 — everything addressed to this node replays, after its own
    // hello.accepted (which every connection gets, replayed or not).
    const second = await connectAsNode(wsBase, node.id, { resumeCursor: 0 });
    const replayed = await second.waitFor('delivery.assign');
    assert.match(replayed.payload.delivery_assign.message.body, /missed-me/);
    second.close();
  });
});

test('a node.hello with an unregistered node_id is refused, not silently accepted', async () => {
  await withHub(async ({ wsBase }) => {
    const client = new WebSocket(`${wsBase}/node/connect`);
    await once(client, 'open');
    client.send(nodeFrame(NodeFrame.HELLO, {
      hello: {
        node_id: crypto.randomUUID(), token: 'x', hostname: 'mac', os: 'macos',
        version: '0.1.0', resume_cursor: 0,
      },
    }));
    const [evt] = await once(client, 'close');
    assert.equal(evt.code, 1008);
  });
});

test('any frame before node.hello is refused, not treated as the handshake', async () => {
  await withHub(async ({ wsBase }) => {
    const client = new WebSocket(`${wsBase}/node/connect`);
    await once(client, 'open');
    client.send(nodeFrame(NodeFrame.PONG, {}));
    const [evt] = await once(client, 'close');
    assert.equal(evt.code, 1003);
  });
});

test('a malformed frame from a node closes the connection rather than being ignored', async () => {
  await withHub(async ({ wsBase }) => {
    const client = new WebSocket(`${wsBase}/node/connect`);
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
    const client = await connectAsNode(wsBase, node.id);

    client.send(nodeFrame(NodeFrame.MESSAGE_POST, {
      message_post: {
        request_id: crypto.randomUUID(), seat_id: seat.id, room_id: room.id,
        message_kind: 'completion', body: 'done — 3 files changed', reply_to: null,
        request_payload_sha256: 'sha-1',
      },
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
    const client = await connectAsNode(wsBase, node.id);
    const requestId = crypto.randomUUID();
    const send = () => client.send(nodeFrame(NodeFrame.MESSAGE_POST, {
      message_post: {
        request_id: requestId, seat_id: seat.id, room_id: room.id,
        message_kind: 'chat', body: 'hello', reply_to: null, request_payload_sha256: 'sha-same',
      },
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
    const client = await connectAsNode(wsBase, node.id);

    // seat_id is real, but for otherRoom — the frame claims room.id instead.
    client.send(nodeFrame(NodeFrame.MESSAGE_POST, {
      message_post: {
        request_id: crypto.randomUUID(), seat_id: otherSeat.id, room_id: room.id,
        message_kind: 'chat', body: 'should not land', reply_to: null, request_payload_sha256: 'sha-x',
      },
    }));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(store.listMessages(room.id).length, 0);
    assert.equal(store.listMessages(otherRoom.id).length, 0);
    client.close();
  });
});

test('a node.message.post for an unknown seat_id is dropped, not thrown', async () => {
  await withHub(async ({ store, room, node, wsBase }) => {
    const client = await connectAsNode(wsBase, node.id);
    client.send(nodeFrame(NodeFrame.MESSAGE_POST, {
      message_post: {
        request_id: crypto.randomUUID(), seat_id: crypto.randomUUID(), room_id: room.id,
        message_kind: 'chat', body: 'ghost seat', reply_to: null, request_payload_sha256: 'sha-y',
      },
    }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.listMessages(room.id).length, 0);
    // The connection itself must survive an unknown seat — it is not a protocol violation the
    // way a malformed frame is, just a stale/racing reference.
    assert.equal(client.readyState, WebSocket.OPEN);
    client.close();
  });
});

test('a connected node cannot post as a seat owned by another node', async () => {
  await withHub(async ({ store, room, seat, wsBase }) => {
    const foreign = store.registerNode({ name: 'foreign', tokenHash: Store.hashNodeToken(NODE_TOKEN) });
    const client = await connectAsNode(wsBase, foreign.id);
    client.send(nodeFrame(NodeFrame.MESSAGE_POST, {
      message_post: {
        request_id: crypto.randomUUID(), seat_id: seat.id, room_id: room.id,
        message_kind: 'chat', body: 'forged', reply_to: null, request_payload_sha256: 'forged',
      },
    }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.listMessages(room.id).length, 0);
    client.close();
  });
});

test('a node can report its own delivery state, approval, and presence', async () => {
  await withHub(async ({ hub, store, room, node, seat, wsBase }) => {
    const client = await connectAsNode(wsBase, node.id);
    const { run, delivery } = store.createTask({
      roomId: room.id, executorSeatId: seat.id, title: 'x', instructions: 'x',
    });
    hub.flushDeliveries();
    client.send(nodeFrame(NodeFrame.DELIVERY_ACK, { delivery_ack: { delivery_id: delivery.id } }));
    client.send(nodeFrame(NodeFrame.DELIVERY_STATE, {
      delivery_state: { delivery_id: delivery.id, state: 'running', error_code: null },
    }));
    client.send(nodeFrame(NodeFrame.APPROVAL_REQUEST, {
      approval_request: {
        request_id: crypto.randomUUID(), seat_id: seat.id, delivery_id: delivery.id,
        provider_request_id: 'guardian-1', description: 'patch', input_preview: 'x', decisions: ['approve', 'deny'],
      },
    }));
    client.send(nodeFrame(NodeFrame.SEAT_PRESENCE, {
      seat_presence: { seat_id: seat.id, state: 'running', last_ack_seq: 9 },
    }));
    client.send(nodeFrame(NodeFrame.RUN_EVENT, {
      run_event: { delivery_id: delivery.id, event_key: 'provider-1', event_type: 'command.completed', payload: { exit_code: 0 } },
    }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.getDelivery(delivery.id).state, 'running');
    assert.equal(store.pendingApprovals(room.id).length, 1);
    assert.equal(store.getSeat(seat.id).state, 'running');
    assert.equal(store.getSeat(seat.id).last_ack_seq, 9);
    assert.deepEqual(store.listRunEvents(run.id).map((event) => event.type), ['command.completed']);
    client.close();
  });
});
