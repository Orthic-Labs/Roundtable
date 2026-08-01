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

test('API: PATCH /api/rooms/:id archives — the route the X button calls', async () => {
  // This route was never registered: `store.archiveRoom` existed and the PWA had always sent
  // PATCH here, so every archive attempt 404'd and rooms could be created but never removed.
  // Found from a stray blank-slug room stuck in the sidebar with three 404s behind it.
  await withApi(async (api, store) => {
    const room = store.createRoom({ slug: 'doomed', title: 'Doomed' });

    const res = await api(`/api/rooms/${room.id}`, {
      method: 'PATCH', body: JSON.stringify({ archived: true, request_id: crypto.randomUUID() }),
    });
    assert.equal(res.status, 200, 'archive must not 404');

    const body = await res.json();
    // archiveRoom() returns a boolean; the client types this as a Room, so the handler must
    // re-read the row rather than pass that through.
    assert.equal(typeof body.room, 'object');
    assert.ok(body.room.archived_at, 'PWA expects archived_at, not archived_at_ms');
    assert.equal(body.room.archived_at_ms, undefined);
    assert.equal(store.listRooms().find((r) => r.id === room.id), undefined, 'drops out of the listing');
  });
});

test('API: PATCH with anything other than archived:true is refused', async () => {
  await withApi(async (api, store) => {
    const room = store.createRoom({ slug: 'keep', title: 'Keep' });
    const res = await api(`/api/rooms/${room.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'renamed' }) });
    assert.equal(res.status, 400, 'an unsupported patch must not silently no-op as success');
    assert.ok(store.listRooms().find((r) => r.id === room.id), 'and must not archive it');
  });
});

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

test('API: task creates one delivery-backed run plus one compact system message', async () => {
  await withApi(async (api, store) => {
    const room = store.createRoom({ slug: 'tasks', title: 'Tasks' });
    const node = store.registerNode({ name: 'mac', tokenHash: 'hash' });
    const seat = store.createSeat({ roomId: room.id, nodeId: node.id, alias: 'mac-codex', provider: 'codex', sessionRef: 's1' });

    const created = await api(`/api/rooms/${room.id}/tasks`, {
      method: 'POST', body: JSON.stringify({
        executorSeatId: seat.id, title: 'Check cursor', instructions: 'Persist before ack.',
        request_id: crypto.randomUUID(),
      }),
    });
    assert.equal(created.status, 201);
    const { task, run } = await created.json();
    assert.equal(run.task_id, task.id);
    assert.ok(run.delivery_id);

    const listed = await (await api(`/api/rooms/${room.id}/tasks`)).json();
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.runs[0].id, run.id);
    const { messages } = await (await api(`/api/rooms/${room.id}/messages`)).json();
    assert.match(messages[0].body, /Persist before ack\./);
    assert.match(messages[0].body, /Task queued: Check cursor/);
    assert.equal(store.listRunEvents(run.id).length, 0);
  });
});

test('API: run inspector returns timeline, artifacts, and durable delegation lineage', async () => {
  await withApi(async (api, store) => {
    const room = store.createRoom({ slug: 'inspect', title: 'Inspect' });
    const node = store.registerNode({ name: 'inspector', tokenHash: 'hash' });
    const from = store.createSeat({ roomId: room.id, nodeId: node.id, alias: 'from', provider: 'claude', sessionRef: 's1' });
    const executor = store.createSeat({ roomId: room.id, nodeId: node.id, alias: 'to', provider: 'codex', sessionRef: 's2' });
    const { run } = store.createTask({ roomId: room.id, requestedBySeatId: from.id, executorSeatId: executor.id, title: 'Inspect', instructions: 'Report.' });
    store.appendRunEvent({ runId: run.id, eventKey: 'started', type: 'run.started' });
    store.raw.prepare('INSERT INTO artifacts (id, run_id, kind, locator, digest, metadata_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run('artifact-1', run.id, 'report', '/tmp/report.json', null, '{}', Date.now());
    const response = await api(`/api/runs/${run.id}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.events.map((event) => event.type), ['run.started']);
    assert.equal(body.artifacts[0].locator, '/tmp/report.json');
    assert.equal(body.lineage.delegated_from_seat_id, from.id);
    assert.equal(body.lineage.executor_seat_id, executor.id);
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
      body: JSON.stringify({
        request_id: crypto.randomUUID(), actorId: 'adrian', body: 'run the tests', mentioned_seat_ids: [seat.id],
      }),
    });
    assert.equal(posted.status, 201);
    const { message } = await posted.json();
    assert.equal(message.seq, 1);
    assert.deepEqual(message.mentioned_seat_ids, [seat.id]);

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
