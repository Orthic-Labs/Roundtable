// Node read path: `node.query` -> exactly one `query.result`.
//
// The node holds neither a transcript nor a room roster, so `transcript.read`, `transcript.search`
// and alias resolution for `handoff.create` all have to ask the hub. Every other node->hub command
// is fire-and-forget; this is the only request/response pair, so correlation by `request_id` and
// the "always reply, even on failure" rule are what these tests pin down.
//
// Own file, like replay.test.mjs, because it opens real WebSocket servers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from './store.mjs';
import { createHub } from './server.mjs';
import { PROTOCOL_VERSION, NodeFrame } from './wire.mjs';

const envelope = (type, payload) => JSON.stringify({
  version: PROTOCOL_VERSION, event_id: crypto.randomUUID(), sent_at_ms: Date.now(), type, payload,
});

const hello = (nodeId, token) => envelope(NodeFrame.HELLO, {
  hello: {
    node_id: nodeId, token, hostname: 'm', os: 'macos', version: '0.1.0', resume_cursor: 0,
  },
});

function fixture() {
  const store = Store.open(':memory:');
  const hub = createHub({ store, adminToken: 'tok', secure: false, allowedOrigins: [] });
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const token = 'query-token';
  const node = store.registerNode({ name: 'mac', tokenHash: Store.hashNodeToken(token) });
  const seat = store.createSeat({
    roomId: room.id, nodeId: node.id, alias: 'reviewer', provider: 'codex', sessionRef: 's',
  });
  return { store, hub, room, token, node, seat };
}

/** Connect, handshake, and return a socket plus a `query()` that resolves the matching result. */
async function connectNode(port, nodeId, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/node/connect`);
  await once(ws, 'open');
  const frames = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const f = JSON.parse(e.data.toString());
    frames.push(f);
    // Resolve from a buffer rather than a fresh once(): hello.accepted and a result can land in
    // the same tick, and a late listener would miss the one already delivered.
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].match(f)) waiters.splice(i, 1)[0].resolve(f);
    }
  });
  const waitFor = (match) => new Promise((resolve, reject) => {
    const hit = frames.find(match);
    if (hit) { resolve(hit); return; }
    const t = setTimeout(() => reject(new Error('timed out waiting for frame')), 2000);
    waiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
  });
  ws.send(hello(nodeId, token));
  await waitFor((f) => f.type === 'hello.accepted');
  const query = async (queryBody) => {
    const requestId = crypto.randomUUID();
    ws.send(envelope(NodeFrame.QUERY, { query_request: { request_id: requestId, query: queryBody } }));
    const f = await waitFor(
      (x) => x.type === 'query.result' && x.payload?.query_result?.request_id === requestId,
    );
    return f.payload.query_result;
  };
  return { ws, query };
}

async function closeClient(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, 'close');
  ws.close();
  await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
}

test('transcript.read returns the room transcript to a seated node', async (t) => {
  const { store, hub, room, token, node } = fixture();
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  store.postMessage({ roomId: room.id, actorId: crypto.randomUUID(), body: 'first' });
  store.postMessage({ roomId: room.id, actorId: crypto.randomUUID(), body: 'second' });

  const { ws, query } = await connectNode(addr.port, node.id, token);
  t.after(() => closeClient(ws));

  const res = await query({ transcript_read: { room_id: room.id, after_seq: 0, limit: 50 } });
  assert.equal(res.ok, true, res.error ?? '');
  assert.deepEqual(res.result.messages.map((m) => m.body), ['first', 'second']);
});

test('transcript.search finds a message by substring', async (t) => {
  const { store, hub, room, token, node } = fixture();
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  store.postMessage({ roomId: room.id, actorId: crypto.randomUUID(), body: 'we chose sqlite' });
  store.postMessage({ roomId: room.id, actorId: crypto.randomUUID(), body: 'unrelated chatter' });

  const { ws, query } = await connectNode(addr.port, node.id, token);
  t.after(() => closeClient(ws));

  const res = await query({ transcript_search: { room_id: room.id, query: 'sqlite', limit: 10 } });
  assert.equal(res.ok, true, res.error ?? '');
  assert.deepEqual(res.result.messages.map((m) => m.body), ['we chose sqlite']);
});

test('transcript.search treats LIKE wildcards as literal text', async (t) => {
  // An agent searching for "100%" or a snake_case symbol must not get wildcard behaviour.
  const { store, hub, room, token, node } = fixture();
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  store.postMessage({ roomId: room.id, actorId: crypto.randomUUID(), body: 'coverage is 100% now' });
  store.postMessage({ roomId: room.id, actorId: crypto.randomUUID(), body: 'nothing to see' });

  const { ws, query } = await connectNode(addr.port, node.id, token);
  t.after(() => closeClient(ws));

  const res = await query({ transcript_search: { room_id: room.id, query: '100%', limit: 10 } });
  assert.equal(res.ok, true, res.error ?? '');
  assert.deepEqual(res.result.messages.map((m) => m.body), ['coverage is 100% now']);
});

test('roster.read returns seats so a node can resolve an alias to a seat_id', async (t) => {
  const { store, hub, room, token, node, seat } = fixture();
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  const { ws, query } = await connectNode(addr.port, node.id, token);
  t.after(() => closeClient(ws));

  const res = await query({ roster_read: { room_id: room.id } });
  assert.equal(res.ok, true, res.error ?? '');
  const found = res.result.seats.find((s) => s.alias === 'reviewer');
  assert.equal(found.id, seat.id, 'alias must resolve to the seat that owns it');
});

test('a node cannot read a room it holds no seat in', async (t) => {
  // The authorisation boundary: a node authenticates as itself, not as an operator.
  const { store, hub, token, node } = fixture();
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  const other = store.createRoom({ slug: 'private', title: 'Private' });
  store.postMessage({ roomId: other.id, actorId: crypto.randomUUID(), body: 'secret' });

  const { ws, query } = await connectNode(addr.port, node.id, token);
  t.after(() => closeClient(ws));

  const res = await query({ transcript_read: { room_id: other.id, limit: 50 } });
  assert.equal(res.ok, false, 'reading a room this node has no seat in must be refused');
  assert.equal(res.error, 'room_not_accessible');
  assert.equal(res.result, null, 'a refusal must not leak the transcript');
});

test('an unknown room is refused with the same error as an unauthorised one', async (t) => {
  // Distinguishing them would let a node probe which rooms exist on the hub.
  const { store, hub, token, node } = fixture();
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  const { ws, query } = await connectNode(addr.port, node.id, token);
  t.after(() => closeClient(ws));

  const res = await query({ transcript_read: { room_id: crypto.randomUUID(), limit: 50 } });
  assert.equal(res.error, 'room_not_accessible');
});

test('node.handoff.create actually writes a handoff', async (t) => {
  // Regression: this frame was in the wire vocabulary and the node sent it, but the hub consumed
  // it nowhere — it decoded, matched no branch, and was dropped. Because the node resolves its
  // caller as soon as the frame is written, the agent was told the handoff succeeded while no row
  // was ever written. Caught by reading the production database after a live handoff said "ok".
  const { store, hub, room, token, node, seat } = fixture();
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  const target = store.createSeat({
    roomId: room.id, nodeId: node.id, alias: 'builder', provider: 'codex', sessionRef: 's2',
  });
  const { ws } = await connectNode(addr.port, node.id, token);
  t.after(() => closeClient(ws));

  ws.send(envelope(NodeFrame.HANDOFF_CREATE, {
    handoff_create: {
      request_id: crypto.randomUUID(),
      from_seat_id: seat.id,
      to_seat_id: target.id,
      body: 'over to you',
      evidence_refs: ['ref-1'],
      request_payload_sha256: '',
    },
  }));

  // Fire-and-forget: no ack frame to await, so poll the store briefly.
  let handoffs = [];
  for (let i = 0; i < 40 && handoffs.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
    handoffs = store.listHandoffs(room.id);
  }
  assert.equal(handoffs.length, 1, 'the handoff must be persisted, not silently dropped');
  assert.equal(handoffs[0].from_seat_id, seat.id);
  assert.equal(handoffs[0].to_seat_id, target.id);
});

test('a node cannot hand off from a seat it does not own', async (t) => {
  const { store, hub, room, token, node, seat } = fixture();
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  const otherNode = store.registerNode({ name: 'other', tokenHash: Store.hashNodeToken('t2') });
  const foreign = store.createSeat({
    roomId: room.id, nodeId: otherNode.id, alias: 'foreign', provider: 'codex', sessionRef: 's3',
  });
  const { ws } = await connectNode(addr.port, node.id, token);
  t.after(() => closeClient(ws));

  ws.send(envelope(NodeFrame.HANDOFF_CREATE, {
    handoff_create: {
      request_id: crypto.randomUUID(),
      from_seat_id: foreign.id, // not this node's seat
      to_seat_id: seat.id,
      body: 'should be refused',
      evidence_refs: [],
      request_payload_sha256: '',
    },
  }));

  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(store.listHandoffs(room.id), [], 'a node may only act as its own seats');
});

test('an unknown query kind still gets a reply', async (t) => {
  // A node that never hears back leaves an MCP tool call hanging inside a live Claude session.
  const { store, hub, room, token, node } = fixture();
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  const { ws, query } = await connectNode(addr.port, node.id, token);
  t.after(() => closeClient(ws));

  const res = await query({ nonsense_read: { room_id: room.id } });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown query/);
});
