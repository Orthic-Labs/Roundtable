// Run with: node --test 'tools/roundtable/packages/hub/src/*.test.mjs'
//
// The invite mechanism: an operator mints a room-scoped, single-use code over HTTP; a node
// redeems it over the WS `node.query` channel (kind `redeem_invite`) to bootstrap a brand-new
// seat without ever having held one in that room before. Covers the store contract (code format,
// sha256-at-rest, redeem/expire/reuse/revoke semantics) and the wire contract (HTTP issue/list/
// revoke, WS redeem, the seat-presence broadcast on redemption).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store, StoreError } from './store.mjs';
import { createHub } from './server.mjs';
import { hashSecret } from './auth.mjs';
import { PROTOCOL_VERSION, NodeFrame } from './wire.mjs';

const ADMIN = 'test-admin-token';

async function withApi(fn) {
  const store = Store.open(':memory:');
  const hub = createHub({ store, adminToken: ADMIN, secure: false, allowedOrigins: [] });
  const addr = await hub.listen(0);
  const base = `http://127.0.0.1:${addr.port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', body: JSON.stringify({ token: ADMIN }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (path, init = {}) => fetch(base + path, {
    ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  try { await fn(api, store, base, cookie); } finally { await hub.close(); store.close(); }
}

// ---- store-level -----------------------------------------------------------

test('store: createInvite returns a "cit_" + 26 [a-z2-7] code and persists only its sha256', () => {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const invite = store.createInvite({ roomId: room.id });

  assert.match(invite.code, /^cit_[a-z2-7]{26}$/);
  assert.equal(invite.room_id, room.id);
  assert.equal(invite.expires_at_ms - invite.created_at_ms, 3600000, 'default ttl is 1h');

  const row = store.raw.prepare('SELECT * FROM invites WHERE id = ?').get(invite.id);
  assert.equal(row.code_hash, hashSecret(invite.code), 'stored hash must match the returned code');
  assert.notEqual(row.code_hash, invite.code, 'the plaintext code itself must never be a column value');
  // Nothing in the row is the plaintext code under another name either.
  assert.ok(!Object.values(row).includes(invite.code));
  store.close();
});

test('store: listInvites never exposes code or code_hash, and reports derived state', () => {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'r', title: 'R' });
  store.createInvite({ roomId: room.id });
  const [row] = store.listInvites(room.id);

  assert.equal(row.state, 'active');
  assert.equal(row.code, undefined);
  assert.equal(row.code_hash, undefined);
  assert.deepEqual(Object.keys(row).sort(), ['created_at_ms', 'expires_at_ms', 'id', 'room_id', 'state']);
  store.close();
});

test('store: redeemInvite creates a seat and marks the invite redeemed, atomically', () => {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const node = store.registerNode({ name: 'mac', tokenHash: 'h' });
  const invite = store.createInvite({ roomId: room.id });

  const seat = store.redeemInvite({
    code: invite.code, nodeId: node.id, alias: 'zephyr', provider: 'claude', sessionRef: 's1',
  });
  assert.equal(seat.room_id, room.id);
  assert.equal(seat.node_id, node.id);
  assert.equal(seat.alias, 'zephyr');
  assert.equal(seat.state, 'idle');
  assert.deepEqual(store.listSeats(room.id).map((s) => s.id), [seat.id]);

  const row = store.raw.prepare('SELECT * FROM invites WHERE id = ?').get(invite.id);
  assert.ok(row.redeemed_at_ms, 'redeemed_at_ms must be set');
  assert.equal(row.redeemed_seat_id, seat.id);
  assert.equal(store.listInvites(room.id)[0].state, 'redeemed');
  store.close();
});

test('store: a second redemption of the same code is invite_used', () => {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const node = store.registerNode({ name: 'mac', tokenHash: 'h' });
  const invite = store.createInvite({ roomId: room.id });

  store.redeemInvite({ code: invite.code, nodeId: node.id, alias: 'a1', provider: 'claude', sessionRef: 's1' });
  assert.throws(
    () => store.redeemInvite({ code: invite.code, nodeId: node.id, alias: 'a2', provider: 'claude', sessionRef: 's2' }),
    (e) => e instanceof StoreError && e.message === 'invite_used',
  );
  assert.equal(store.listSeats(room.id).length, 1, 'the second attempt must not create a seat');
  store.close();
});

test('store: an expired invite is invite_expired and cannot be redeemed', () => {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const node = store.registerNode({ name: 'mac', tokenHash: 'h' });
  const invite = store.createInvite({ roomId: room.id, ttlMs: -1 }); // already expired

  assert.throws(
    () => store.redeemInvite({ code: invite.code, nodeId: node.id, alias: 'a1', provider: 'claude', sessionRef: 's1' }),
    (e) => e instanceof StoreError && e.message === 'invite_expired',
  );
  assert.equal(store.listInvites(room.id)[0].state, 'expired');
  store.close();
});

test('store: a revoked invite is invite_revoked and cannot be redeemed', () => {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const node = store.registerNode({ name: 'mac', tokenHash: 'h' });
  const invite = store.createInvite({ roomId: room.id });

  assert.equal(store.revokeInvite(room.id, invite.id), true);
  assert.equal(store.revokeInvite(room.id, invite.id), false, 'revoking twice is a no-op, not an error');
  assert.throws(
    () => store.redeemInvite({ code: invite.code, nodeId: node.id, alias: 'a1', provider: 'claude', sessionRef: 's1' }),
    (e) => e instanceof StoreError && e.message === 'invite_revoked',
  );
  store.close();
});

test('store: an unknown code is invalid_invite', () => {
  const store = Store.open(':memory:');
  const node = store.registerNode({ name: 'mac', tokenHash: 'h' });
  assert.throws(
    () => store.redeemInvite({ code: 'cit_doesnotexist00000000000', nodeId: node.id, alias: 'a1', provider: 'claude', sessionRef: 's1' }),
    (e) => e instanceof StoreError && e.message === 'invalid_invite',
  );
  store.close();
});

test('store: revokeInvite is scoped to its own room', () => {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const other = store.createRoom({ slug: 'other', title: 'Other' });
  const invite = store.createInvite({ roomId: room.id });
  assert.equal(store.revokeInvite(other.id, invite.id), false, 'must not revoke a different room\'s invite');
  assert.equal(store.listInvites(room.id)[0].state, 'active');
  store.close();
});

// ---- HTTP ---------------------------------------------------------------

test('API: issue an invite returns the code once, and it is never listed', async () => {
  await withApi(async (api, store) => {
    const room = store.createRoom({ slug: 'r', title: 'R' });
    const issued = await api(`/api/rooms/${room.id}/invites`, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(issued.status, 200);
    const { invite } = await issued.json();
    assert.match(invite.code, /^cit_[a-z2-7]{26}$/);
    assert.equal(invite.room_id, room.id);

    const listed = await api(`/api/rooms/${room.id}/invites`);
    assert.equal(listed.status, 200);
    const { invites } = await listed.json();
    assert.equal(invites.length, 1);
    assert.equal(invites[0].id, invite.id);
    assert.equal(invites[0].state, 'active');
    assert.equal(invites[0].code, undefined, 'the list must never leak the code');
    assert.equal(invites[0].code_hash, undefined);
  });
});

test('API: issuing an invite for an unknown room is a 404', async () => {
  await withApi(async (api) => {
    const res = await api('/api/rooms/no-such-room/invites', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'unknown_room');
  });
});

test('API: a custom ttl_ms is honored', async () => {
  await withApi(async (api, store) => {
    const room = store.createRoom({ slug: 'r', title: 'R' });
    const issued = await api(`/api/rooms/${room.id}/invites`, { method: 'POST', body: JSON.stringify({ ttl_ms: 60000 }) });
    const { invite } = await issued.json();
    assert.equal(invite.expires_at_ms - invite.created_at_ms, 60000);
  });
});

test('API: DELETE revokes; a second DELETE 404s', async () => {
  await withApi(async (api, store) => {
    const room = store.createRoom({ slug: 'r', title: 'R' });
    const invite = store.createInvite({ roomId: room.id });

    const first = await api(`/api/rooms/${room.id}/invites/${invite.id}`, { method: 'DELETE' });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true });

    const second = await api(`/api/rooms/${room.id}/invites/${invite.id}`, { method: 'DELETE' });
    assert.equal(second.status, 404);

    assert.equal(store.listInvites(room.id)[0].state, 'revoked');
  });
});

// ---- WS node.query: redeem_invite ----------------------------------------

const envelope = (type, payload) => JSON.stringify({
  version: PROTOCOL_VERSION, event_id: crypto.randomUUID(), sent_at_ms: Date.now(), type, payload,
});
const hello = (nodeId, token) => envelope(NodeFrame.HELLO, {
  hello: { node_id: nodeId, token, hostname: 'm', os: 'macos', version: '0.1.0', resume_cursor: 0 },
});

async function connectNode(port, nodeId, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/node/connect`);
  await once(ws, 'open');
  const frames = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const f = JSON.parse(e.data.toString());
    frames.push(f);
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
    const f = await waitFor((x) => x.type === 'query.result' && x.payload?.query_result?.request_id === requestId);
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

test('node.query redeem_invite creates a seat for a node with NO prior seat in the room', async (t) => {
  const store = Store.open(':memory:');
  const hub = createHub({ store, adminToken: 'tok', secure: false, allowedOrigins: [] });
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const token = 'redeem-token';
  const node = store.registerNode({ name: 'mac', tokenHash: Store.hashNodeToken(token) });
  const invite = store.createInvite({ roomId: room.id });
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  assert.equal(store.nodeHasSeatInRoom(node.id, room.id), false, 'precondition: node holds no seat yet');

  const { ws, query } = await connectNode(addr.port, node.id, token);
  t.after(() => closeClient(ws));

  const res = await query({
    redeem_invite: {
      code: invite.code, alias: 'zephyr', session_ref: 's1', provider: 'claude',
    },
  });
  assert.equal(res.ok, true, res.error ?? '');
  assert.equal(res.result.seat.room_id, room.id);
  assert.equal(res.result.seat.node_id, node.id);
  assert.equal(res.result.seat.alias, 'zephyr');
  assert.equal(store.nodeHasSeatInRoom(node.id, room.id), true, 'the node now holds a seat');
});

test('node.query redeem_invite: bad code is rejected with a typed error and no seat', async (t) => {
  const store = Store.open(':memory:');
  const hub = createHub({ store, adminToken: 'tok', secure: false, allowedOrigins: [] });
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const token = 'bad-code-token';
  const node = store.registerNode({ name: 'mac', tokenHash: Store.hashNodeToken(token) });
  const addr = await hub.listen(0);
  t.after(async () => { await hub.close(); store.close(); });

  const { ws, query } = await connectNode(addr.port, node.id, token);
  t.after(() => closeClient(ws));

  const res = await query({
    redeem_invite: { code: 'cit_totallybogus00000000000', alias: 'x', session_ref: 's', provider: 'claude' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_invite');
  assert.equal(res.result, null);
  assert.equal(store.listSeats(room.id).length, 0);
});

test('node.query redeem_invite broadcasts the same seat.presence event operators already see', async () => {
  await withApi(async (_api, store, base, cookie) => {
    const port = new URL(base).port;
    const room = store.createRoom({ slug: 'r', title: 'R' });
    const token = 'presence-token';
    const node = store.registerNode({ name: 'mac', tokenHash: Store.hashNodeToken(token) });
    const invite = store.createInvite({ roomId: room.id });

    const browserWs = new WebSocket(`${base.replace('http', 'ws')}/api/events`, { headers: { cookie } });
    await once(browserWs, 'open');
    try {
      const seenSeatPresence = new Promise((resolve) => {
        browserWs.addEventListener('message', (e) => {
          const f = JSON.parse(e.data.toString());
          if (f.type === 'seat.presence') resolve(f.payload);
        });
      });

      const { ws, query } = await connectNode(port, node.id, token);
      try {
        const res = await query({
          redeem_invite: { code: invite.code, alias: 'zephyr', session_ref: 's1', provider: 'claude' },
        });
        assert.equal(res.ok, true, res.error ?? '');

        const payload = await Promise.race([
          seenSeatPresence,
          new Promise((_, reject) => setTimeout(() => reject(new Error('no seat.presence broadcast')), 2000)),
        ]);
        assert.equal(payload.id, res.result.seat.id);
        assert.equal(payload.alias, 'zephyr');
      } finally {
        await closeClient(ws);
      }
    } finally {
      await closeClient(browserWs);
    }
  });
});

test('redeem_invite resumes a detached seat with the same alias on the same node', () => {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'resume', title: 'Resume' });
  const node = store.registerNode({ name: 'win', tokenHash: Store.hashNodeToken('t') });
  const first = store.createInvite({ roomId: room.id });
  const seat = store.redeemInvite({ code: first.code, nodeId: node.id, alias: 'claude', provider: 'claude', sessionRef: 's1' });
  store.detachSeat(seat.id);

  const second = store.createInvite({ roomId: room.id });
  const resumed = store.redeemInvite({ code: second.code, nodeId: node.id, alias: 'claude', provider: 'claude', sessionRef: 's2' });
  assert.equal(resumed.id, seat.id, 'same seat row is resumed, not duplicated');
  assert.equal(resumed.state, 'idle');
  assert.equal(resumed.session_ref, 's2');
  store.close();
});
