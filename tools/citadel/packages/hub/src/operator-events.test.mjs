// Run with: node --test 'tools/citadel/packages/hub/src/*.test.mjs'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHub } from './server.mjs';
import { Store } from './store.mjs';
import { OPERATOR_TARGET } from './dto.mjs';

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
  try { await fn(api, store, base, cookie); } finally { await hub.close(); }
}

test('operator events: committed message posts publish message.posted to authed browser socket', async () => {
  await withApi(async (api, store, base, cookie) => {
    const { room } = await (await api('/api/rooms', {
      method: 'POST', body: JSON.stringify({ slug: 'live', title: 'Live', request_id: crypto.randomUUID() }),
    })).json();
    const node = store.registerNode({ name: 'mac', tokenHash: 'hash' });
    const seat = store.createSeat({
      roomId: room.id, nodeId: node.id, alias: 'mac-codex', provider: 'codex', sessionRef: 's1',
    });

    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/events`, {
      headers: { cookie },
    });
    await once(socket, 'open');

    const seen = [];
    socket.addEventListener('message', (evt) => seen.push(JSON.parse(evt.data)));
    await api(`/api/rooms/${room.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        request_id: crypto.randomUUID(), body: 'ping', mentioned_seat_ids: [seat.id],
      }),
    });
    await new Promise((r) => setTimeout(r, 50));
    const posted = seen.find((f) => f.type === 'message.posted');
    assert.ok(posted, `expected message.posted, got ${seen.map((f) => f.type).join(',')}`);
    assert.equal(posted.payload.body, 'ping');
  });
});

test('browser websocket rejects unauthenticated upgrade', async () => {
  await withApi(async (_api, _store, base) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/events`);
    const [evt] = await once(socket, 'close');
    assert.equal(evt.code, 1008);
  });
});

test('browser websocket rejects a foreign Origin before attaching operator state', async () => {
  const store = Store.open(':memory:');
  const hub = createHub({ store, adminToken: ADMIN, secure: false, allowedOrigins: ['https://citadel.spoares.com'] });
  const addr = await hub.listen(0);
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${addr.port}/api/events`, {
      headers: { Origin: 'https://evil.example' },
    });
    const [evt] = await once(socket, 'close');
    assert.equal(evt.code, 1008);
    assert.equal(hub.browserConnectionCount, 0);
  } finally { await hub.close(); }
});

test('operator events are not replayed to nodes', () => {
  const store = Store.open(':memory:');
  store.appendOperatorEvent({ type: 'message.posted', payload: { id: 'm1' } });
  store.appendEvent({ type: 'delivery.assign', payload: { n: 1 }, targetNodeId: 'node-a' });
  assert.equal(store.eventsAfter(0, { audience: 'operator' }).length, 1);
  assert.equal(store.eventsAfter(0, { nodeId: 'node-a', audience: 'node' }).length, 1);
  assert.equal(store.eventsAfter(0, { nodeId: 'node-a', audience: 'node' })[0].type, 'delivery.assign');
  store.close();
});

test('browser mutation idempotency: same request_id replays without double post', async () => {
  await withApi(async (api, store) => {
    const { room } = await (await api('/api/rooms', {
      method: 'POST', body: JSON.stringify({ slug: 'dedupe', title: 'D', request_id: crypto.randomUUID() }),
    })).json();
    const node = store.registerNode({ name: 'mac', tokenHash: 'h' });
    const { seat } = await (await api(`/api/rooms/${room.id}/seats`, {
      method: 'POST',
      body: JSON.stringify({
        request_id: crypto.randomUUID(), node_id: node.id, alias: 'a', provider: 'claude', session_ref: 's',
      }),
    })).json();
    const requestId = crypto.randomUUID();
    const body = { request_id: requestId, body: 'once', mentioned_seat_ids: [seat.id] };
    const first = await api(`/api/rooms/${room.id}/messages`, { method: 'POST', body: JSON.stringify(body) });
    const second = await api(`/api/rooms/${room.id}/messages`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(store.listMessages(room.id).length, 1);
  });
});
