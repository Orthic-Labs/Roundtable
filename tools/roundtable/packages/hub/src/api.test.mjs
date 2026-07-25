// Run with: node --test 'tools/roundtable/packages/hub/src/*.test.mjs'
// Full HTTP round-trips against a real listening hub — create a room, attach a seat, post a
// mention, read it back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from './server.mjs';
import { Store } from './store.mjs';

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
  try { await fn(api, store); } finally { await hub.close(); }
}

test('API: create a room, then read it back in the list', async () => {
  await withApi(async (api) => {
    const created = await api('/api/rooms', {
      method: 'POST', body: JSON.stringify({ slug: 'memright', title: 'MemRight', objective: 'ship' }),
    });
    assert.equal(created.status, 201);
    const { room } = await created.json();
    assert.equal(room.slug, 'memright');
    assert.equal(room.next_seq, 1);

    const list = await api('/api/rooms');
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).rooms.map((r) => r.slug), ['memright']);
  });
});

test('API: duplicate slug is a 409, not a 500', async () => {
  await withApi(async (api) => {
    await api('/api/rooms', { method: 'POST', body: JSON.stringify({ slug: 'dup', title: 'a' }) });
    const again = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ slug: 'dup', title: 'b' }) });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, 'slug_taken');
  });
});

test('API: unknown room is a 404', async () => {
  await withApi(async (api) => {
    assert.equal((await api('/api/rooms/no-such-room')).status, 404);
  });
});

test('API: attach a seat and see it on the room', async () => {
  await withApi(async (api, store) => {
    const { room } = await (await api('/api/rooms', {
      method: 'POST', body: JSON.stringify({ slug: 'r', title: 'R' }),
    })).json();
    const node = store.registerNode({ name: 'mac', tokenHash: 'hash' });

    const created = await api(`/api/rooms/${room.id}/seats`, {
      method: 'POST',
      body: JSON.stringify({ nodeId: node.id, alias: 'mac-claude', provider: 'claude', sessionRef: 's1' }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).seat.alias, 'mac-claude');

    const detail = await (await api(`/api/rooms/${room.id}`)).json();
    assert.deepEqual(detail.seats.map((s) => s.alias), ['mac-claude']);
  });
});

test('API: post a message with a mention, and page the transcript', async () => {
  await withApi(async (api, store) => {
    const { room } = await (await api('/api/rooms', {
      method: 'POST', body: JSON.stringify({ slug: 'r', title: 'R' }),
    })).json();
    const node = store.registerNode({ name: 'mac', tokenHash: 'h' });
    const { seat } = await (await api(`/api/rooms/${room.id}/seats`, {
      method: 'POST', body: JSON.stringify({ nodeId: node.id, alias: 'win-codex', provider: 'codex', sessionRef: 's' }),
    })).json();

    const posted = await api(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ actorId: 'adrian', body: 'run the tests', mentionSeatIds: [seat.id] }),
    });
    assert.equal(posted.status, 201);
    const result = await posted.json();
    assert.equal(result.message.seq, 1);
    assert.equal(result.deliveries.length, 1, 'the mentioned seat gets exactly one delivery');

    const page = await (await api(`/api/rooms/${room.id}/messages?limit=10`)).json();
    assert.deepEqual(page.messages.map((m) => m.body), ['run the tests']);

    const after = await (await api(`/api/rooms/${room.id}/messages?after_seq=1`)).json();
    assert.equal(after.messages.length, 0, 'after_seq is exclusive');
  });
});

test('API: an empty message body is a 400', async () => {
  await withApi(async (api) => {
    const { room } = await (await api('/api/rooms', {
      method: 'POST', body: JSON.stringify({ slug: 'r', title: 'R' }),
    })).json();
    const res = await api(`/api/rooms/${room.id}/messages`, {
      method: 'POST', body: JSON.stringify({ actorId: 'a', body: '' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'body_required');
  });
});

test('API: detaching a seat works once, then 404s', async () => {
  await withApi(async (api, store) => {
    const { room } = await (await api('/api/rooms', {
      method: 'POST', body: JSON.stringify({ slug: 'r', title: 'R' }),
    })).json();
    const node = store.registerNode({ name: 'mac', tokenHash: 'h' });
    const { seat } = await (await api(`/api/rooms/${room.id}/seats`, {
      method: 'POST', body: JSON.stringify({ nodeId: node.id, alias: 'a', provider: 'claude', sessionRef: 's' }),
    })).json();

    assert.equal((await api(`/api/rooms/${room.id}/seats/${seat.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await api(`/api/rooms/${room.id}/seats/${seat.id}`, { method: 'DELETE' })).status, 404,
      'detaching an already-detached seat must not report success');
  });
});
