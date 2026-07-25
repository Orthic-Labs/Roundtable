// Run with: node --test 'tools/roundtable/packages/hub/src/*.test.mjs'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, StoreError } from './store.mjs';

/** A store with one room, one node, and two seats. */
function seeded() {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'memright', title: 'MemRight', objective: 'ship it' });
  const node = store.registerNode({ name: 'mac', tokenHash: 'deadbeef' });
  const mac = store.createSeat({ roomId: room.id, nodeId: node.id, alias: 'mac-claude', provider: 'claude', sessionRef: 's1' });
  const win = store.createSeat({ roomId: room.id, nodeId: node.id, alias: 'win-codex', provider: 'codex', sessionRef: 's2' });
  return { store, room, node, mac, win };
}

test('rooms: created, listed newest-first, and archived rooms drop out', () => {
  const store = Store.open(':memory:');
  const a = store.createRoom({ slug: 'a', title: 'A' });
  const b = store.createRoom({ slug: 'b', title: 'B' });
  assert.equal(store.listRooms().length, 2);
  assert.equal(store.getRoomBySlug('a').id, a.id);

  assert.equal(store.archiveRoom(b.id), true);
  assert.deepEqual(store.listRooms().map((r) => r.slug), ['a']);
  assert.equal(store.listRooms({ includeArchived: true }).length, 2);
  assert.equal(store.archiveRoom(b.id), false, 'archiving twice is a no-op');
  store.close();
});

test('rooms: duplicate slug is rejected with a typed error', () => {
  const store = Store.open(':memory:');
  store.createRoom({ slug: 'dup', title: 'one' });
  assert.throws(() => store.createRoom({ slug: 'dup', title: 'two' }),
    (e) => e instanceof StoreError && e.message === 'slug_taken');
  store.close();
});

test('seats: alias is unique per room, and a bad room is a typed error', () => {
  const { store, room, node } = seeded();
  assert.throws(() => store.createSeat({ roomId: room.id, nodeId: node.id, alias: 'mac-claude', provider: 'claude', sessionRef: 'other' }),
    (e) => e instanceof StoreError && e.message === 'alias_taken');
  assert.throws(() => store.createSeat({ roomId: 'no-such-room', nodeId: node.id, alias: 'x', provider: 'claude', sessionRef: 'z' }),
    (e) => e instanceof StoreError && e.message === 'unknown_room_or_node');
  assert.deepEqual(store.listSeats(room.id).map((s) => s.alias), ['mac-claude', 'win-codex']);
  assert.equal(store.seatByAlias(room.id, 'win-codex').provider, 'codex');
  store.close();
});

test('messages: sequence is allocated per room and never reused', () => {
  const { store, room } = seeded();
  const seqs = [];
  for (let i = 0; i < 5; i += 1) {
    seqs.push(store.postMessage({ roomId: room.id, actorId: 'adrian', body: `m${i}` }).message.seq);
  }
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  assert.equal(store.getRoom(room.id).next_seq, 6);
  store.close();
});

test('messages: sequences are independent across rooms', () => {
  const { store, room } = seeded();
  const other = store.createRoom({ slug: 'other', title: 'Other' });
  store.postMessage({ roomId: room.id, actorId: 'a', body: 'x' });
  const first = store.postMessage({ roomId: other.id, actorId: 'a', body: 'y' });
  assert.equal(first.message.seq, 1, 'a new room starts at 1 regardless of other rooms');
  store.close();
});

test('messages: a mention creates exactly one delivery, for that seat only', () => {
  const { store, room, mac, win } = seeded();
  const { message, deliveries } = store.postMessage({
    roomId: room.id, actorId: 'adrian', body: '@win-codex please run the tests',
    mentionSeatIds: [win.id],
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].seat_id, win.id);
  assert.deepEqual(store.mentionsFor(message.id), [win.id]);
  assert.equal(store.queuedDeliveries(win.id).length, 1);
  assert.equal(store.queuedDeliveries(mac.id).length, 0, 'an unmentioned seat must NOT wake');
  store.close();
});

test('messages: prose containing an @alias does NOT wake a seat on its own', () => {
  const { store, room, win } = seeded();
  // The body mentions the alias but no seat id is passed — the wake rule is explicit-only.
  store.postMessage({ roomId: room.id, actorId: 'agent-1', actorKind: 'agent', body: 'ask @win-codex about it' });
  assert.equal(store.queuedDeliveries(win.id).length, 0);
  store.close();
});

test('messages: the whole post is atomic — a bad seat id rolls back the message too', () => {
  const { store, room } = seeded();
  const before = store.getRoom(room.id).next_seq;
  assert.throws(() => store.postMessage({
    roomId: room.id, actorId: 'adrian', body: 'boom', mentionSeatIds: ['not-a-seat'],
  }));
  assert.equal(store.getRoom(room.id).next_seq, before, 'next_seq must not advance on a failed post');
  assert.equal(store.listMessages(room.id).length, 0, 'no orphan message may survive');
  store.close();
});

test('messages: posting to an archived or unknown room is refused', () => {
  const { store, room } = seeded();
  store.archiveRoom(room.id);
  assert.throws(() => store.postMessage({ roomId: room.id, actorId: 'a', body: 'x' }),
    (e) => e instanceof StoreError && e.message === 'unknown_or_archived_room');
  assert.throws(() => store.postMessage({ roomId: 'nope', actorId: 'a', body: 'x' }),
    (e) => e instanceof StoreError && e.message === 'unknown_or_archived_room');
  store.close();
});

test('messages: empty body is refused', () => {
  const { store, room } = seeded();
  assert.throws(() => store.postMessage({ roomId: room.id, actorId: 'a', body: '' }),
    (e) => e instanceof StoreError && e.message === 'body_required');
  store.close();
});

test('messages: paging is exclusive on afterSeq, ascending, and capped', () => {
  const { store, room } = seeded();
  for (let i = 0; i < 10; i += 1) store.postMessage({ roomId: room.id, actorId: 'a', body: `m${i}` });

  const firstPage = store.listMessages(room.id, { limit: 4 });
  assert.deepEqual(firstPage.map((m) => m.seq), [1, 2, 3, 4]);

  const nextPage = store.listMessages(room.id, { afterSeq: 4, limit: 4 });
  assert.deepEqual(nextPage.map((m) => m.seq), [5, 6, 7, 8]);

  assert.equal(store.listMessages(room.id, { limit: 9999 }).length, 10, 'limit is capped, not unbounded');
  store.close();
});
