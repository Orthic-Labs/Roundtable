// Run with: node --test 'tools/roundtable/packages/hub/src/*.test.mjs'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, StoreError } from './store.mjs';

function seeded() {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const node = store.registerNode({ name: 'mac', tokenHash: 'h' });
  const mac = store.createSeat({ roomId: room.id, nodeId: node.id, alias: 'mac-claude', provider: 'claude', sessionRef: 's1' });
  const win = store.createSeat({ roomId: room.id, nodeId: node.id, alias: 'win-codex', provider: 'codex', sessionRef: 's2' });
  return { store, room, node, mac, win };
}

test('handoff: posts a message, records evidence, and wakes exactly the target', () => {
  const { store, room, mac, win } = seeded();
  const { handoff, message, deliveries } = store.createHandoff({
    roomId: room.id, fromSeatId: mac.id, toSeatId: win.id,
    summary: 'mirror fix done, please run the suite',
    evidence: { commit: 'abc123', tests: 'cargo test -p roundtable-node' },
  });

  assert.equal(message.kind, 'handoff');
  assert.equal(message.actor_kind, 'agent');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].seat_id, win.id, 'only the target seat wakes');
  assert.equal(store.queuedDeliveries(mac.id).length, 0, 'the sender must not wake itself');
  assert.deepEqual(JSON.parse(handoff.evidence_json).commit, 'abc123');
  assert.equal(store.listHandoffs(room.id).length, 1);
  store.close();
});

test('handoff: the delivery reason is structured_handoff, not human_mention', () => {
  const { store, room, mac, win } = seeded();
  store.createHandoff({ roomId: room.id, fromSeatId: mac.id, toSeatId: win.id, summary: 'over to you' });
  assert.equal(store.queuedDeliveries(win.id)[0].reason, 'structured_handoff');
  store.close();
});

test('handoff: self-handoff and cross-room handoff are refused', () => {
  const { store, room, mac, win, node } = seeded();
  assert.throws(() => store.createHandoff({ roomId: room.id, fromSeatId: mac.id, toSeatId: mac.id, summary: 'x' }),
    (e) => e instanceof StoreError && e.message === 'handoff_to_self');

  const other = store.createRoom({ slug: 'other', title: 'O' });
  const stranger = store.createSeat({ roomId: other.id, nodeId: node.id, alias: 'a', provider: 'claude', sessionRef: 's9' });
  assert.throws(() => store.createHandoff({ roomId: room.id, fromSeatId: mac.id, toSeatId: stranger.id, summary: 'x' }),
    (e) => e instanceof StoreError && e.message === 'seat_not_in_room');
  assert.equal(store.listHandoffs(room.id).length, 0, 'no partial handoff may survive a rejection');
  store.close();
});

test('handoff: an unknown seat rolls the whole thing back', () => {
  const { store, room, mac } = seeded();
  const before = store.getRoom(room.id).next_seq;
  assert.throws(() => store.createHandoff({ roomId: room.id, fromSeatId: mac.id, toSeatId: 'ghost', summary: 'x' }),
    (e) => e instanceof StoreError && e.message === 'unknown_seat');
  assert.equal(store.getRoom(room.id).next_seq, before, 'next_seq must not advance');
  assert.equal(store.listMessages(room.id).length, 0, 'no orphan handoff message');
  store.close();
});

test('approval: created pending, resolved once, second resolution refused', () => {
  const { store, room, win } = seeded();
  const { deliveries } = store.postMessage({
    roomId: room.id, actorId: 'adrian', body: 'go', mentionSeatIds: [win.id],
  });
  const approval = store.createApproval({
    roomId: room.id, seatId: win.id, deliveryId: deliveries[0].id,
    providerRequestId: 'req-1', description: 'run rm -rf build/',
  });
  assert.equal(approval.state, 'pending');
  assert.equal(store.pendingApprovals(room.id).length, 1);

  const resolved = store.resolveApproval(approval.id, 'allow');
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.resolution, 'allow');
  assert.equal(store.pendingApprovals(room.id).length, 0);

  assert.throws(() => store.resolveApproval(approval.id, 'deny'),
    (e) => e instanceof StoreError && e.message === 'already_resolved',
    'a late click must not overturn a decision');
  store.close();
});

test('approval: only a declared decision is accepted', () => {
  const { store, room, win } = seeded();
  const { deliveries } = store.postMessage({ roomId: room.id, actorId: 'a', body: 'x', mentionSeatIds: [win.id] });
  const approval = store.createApproval({
    roomId: room.id, seatId: win.id, deliveryId: deliveries[0].id,
    providerRequestId: 'req-2', description: 'd', decisions: ['allow', 'deny'],
  });
  assert.throws(() => store.resolveApproval(approval.id, 'maybe'),
    (e) => e instanceof StoreError && e.message === 'invalid_resolution');
  store.close();
});

test('approval: the same provider request twice is a retry, not a second approval', () => {
  const { store, room, win } = seeded();
  const { deliveries } = store.postMessage({ roomId: room.id, actorId: 'a', body: 'x', mentionSeatIds: [win.id] });
  const args = {
    roomId: room.id, seatId: win.id, deliveryId: deliveries[0].id,
    providerRequestId: 'same-req', description: 'd',
  };
  store.createApproval(args);
  assert.throws(() => store.createApproval(args),
    (e) => e instanceof StoreError && e.message === 'approval_exists');
  store.close();
});

test('events: cursor is monotonic and replay is exclusive', () => {
  const store = Store.open(':memory:');
  assert.equal(store.latestCursor(), 0);
  const a = store.appendEvent({ type: 'delivery.assign', payload: { n: 1 } });
  const b = store.appendEvent({ type: 'ping', payload: { n: 2 } });
  assert.ok(b.cursor > a.cursor, 'cursors must increase');

  assert.deepEqual(store.eventsAfter(0).map((e) => e.payload.n), [1, 2]);
  assert.deepEqual(store.eventsAfter(a.cursor).map((e) => e.payload.n), [2], 'afterCursor is exclusive');
  assert.equal(store.eventsAfter(b.cursor).length, 0);
  assert.equal(store.latestCursor(), b.cursor);
  store.close();
});

test('events: a targeted event reaches only its node; broadcasts reach everyone', () => {
  const store = Store.open(':memory:');
  store.appendEvent({ type: 'broadcast', payload: { k: 'all' } });
  store.appendEvent({ targetNodeId: 'node-mac', type: 'targeted', payload: { k: 'mac' } });
  store.appendEvent({ targetNodeId: 'node-win', type: 'targeted', payload: { k: 'win' } });

  assert.deepEqual(store.eventsAfter(0, { nodeId: 'node-mac' }).map((e) => e.payload.k), ['all', 'mac']);
  assert.deepEqual(store.eventsAfter(0, { nodeId: 'node-win' }).map((e) => e.payload.k), ['all', 'win']);
  store.close();
});
