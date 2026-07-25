// Run with: node --test 'tools/roundtable/packages/hub/src/cancel.test.mjs'
//
// The Cancellation contract from 2026-07-22-roundtable-cross-device-architecture.md, clause by
// clause. Each test names the clause it holds. These are store-level tests: they prove the state
// machine and the audit trail, not the WebSocket plumbing (dispatch of `seat.interrupt` is
// covered by the route test at the bottom).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.mjs';

function fixture() {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'r', title: 'R' });
  const node = store.registerNode({ name: 'mac', tokenHash: 'h' });
  const seat = store.createSeat({
    roomId: room.id, nodeId: node.id, alias: 'mac-codex', provider: 'codex', sessionRef: 's1',
  });
  const { deliveries } = store.postMessage({
    roomId: room.id, actorId: crypto.randomUUID(), body: 'do the thing', mentionSeatIds: [seat.id],
  });
  return { store, room, node, seat, delivery: deliveries[0] };
}

test('§1 cancel before the provider starts fails the delivery without any interrupt', () => {
  const { store, delivery } = fixture();
  // Still `queued` — no node has taken it.
  const result = store.cancelDelivery(delivery.id, { canceledBy: 'human', reason: 'wrong room' });
  assert.equal(result.delivery.state, 'failed');
  assert.equal(result.delivery.error_code, 'canceled_by_human');
  assert.equal(result.interrupt, false, 'a queued delivery has no provider to interrupt');
});

test('§2 cancel while running signals an interrupt', () => {
  const { store, delivery } = fixture();
  store.setDeliveryState(delivery.id, 'running');
  const result = store.cancelDelivery(delivery.id, { canceledBy: 'human' });
  assert.equal(result.interrupt, true, 'a running delivery must produce an interrupt');
  assert.equal(result.delivery.state, 'failed');
});

test('§3 cancel while waiting on approval kills the approval, and a later answer is recorded as stale', () => {
  const { store, room, seat, delivery } = fixture();
  const approval = store.createApproval({
    roomId: room.id, seatId: seat.id, deliveryId: delivery.id,
    providerRequestId: 'rev-1', description: 'run rm -rf', inputPreview: 'rm -rf /',
    decisions: ['approve', 'deny'],
  });
  store.setDeliveryState(delivery.id, 'waiting_approval');

  const result = store.cancelDelivery(delivery.id, { canceledBy: 'human' });
  assert.deepEqual(result.canceledApprovals, [approval.id]);

  // The human clicks Allow anyway, after the cancel.
  const resolved = store.resolveApproval(approval.id, 'approve');
  assert.equal(resolved.after_cancel, true);
  assert.equal(resolved.resolution, 'approval_resolved_after_cancel',
    'the recorded resolution must say it landed after a cancel, not "approve"');

  const stale = store.listMessages(room.id).find((m) => m.body.includes('after the delivery had already been canceled'));
  assert.ok(stale, 'a system message must mark the approval stale');
  assert.equal(stale.kind, 'system');
});

test('§5 cancel does not roll back work already recorded', () => {
  const { store, room, seat, delivery } = fixture();
  store.setDeliveryState(delivery.id, 'running');
  // The provider did real work and reported it before the cancel landed.
  store.postMessage({
    roomId: room.id, actorId: seat.id, actorKind: 'agent', kind: 'progress',
    body: '$ git push origin main (ok)',
  });
  const before = store.listMessages(room.id).length;

  store.cancelDelivery(delivery.id, { canceledBy: 'human' });

  const after = store.listMessages(room.id);
  assert.ok(after.length > before, 'cancel adds an audit message');
  assert.ok(
    after.some((m) => m.body === '$ git push origin main (ok)'),
    'work already recorded must survive the cancel — the protocol never retracts it',
  );
});

test('§7 cancel writes an audit trail naming who, what, and why', () => {
  const { store, room, delivery } = fixture();
  store.cancelDelivery(delivery.id, { canceledBy: 'handoff', reason: 'superseded by seat-2' });
  const audit = store.listMessages(room.id).find((m) => m.body.includes('was canceled by'));
  assert.ok(audit, 'a cancel must post a typed system message');
  assert.equal(audit.kind, 'system');
  assert.match(audit.body, /canceled_by_handoff/);
  assert.match(audit.body, /mac-codex/, 'the seat alias must be readable without a join');
  assert.match(audit.body, /superseded by seat-2/);
  assert.match(audit.body, /NOT rolled back/);
});

test('a terminal delivery cannot be canceled twice', () => {
  const { store, delivery } = fixture();
  store.cancelDelivery(delivery.id, { canceledBy: 'human' });
  assert.throws(() => store.cancelDelivery(delivery.id, { canceledBy: 'human' }), /delivery_not_cancelable/);
});

test('an approval resolved normally is not marked after_cancel', () => {
  const { store, room, seat, delivery } = fixture();
  const approval = store.createApproval({
    roomId: room.id, seatId: seat.id, deliveryId: delivery.id,
    providerRequestId: 'rev-2', description: 'd', inputPreview: 'p',
    decisions: ['approve', 'deny'],
  });
  const resolved = store.resolveApproval(approval.id, 'approve');
  assert.equal(resolved.after_cancel, false);
  assert.equal(resolved.resolution, 'approve');
  assert.throws(() => store.resolveApproval(approval.id, 'deny'), /already_resolved/);
});

test('getDelivery carries the node_id needed to route an interrupt to the right node', () => {
  const { store, node, delivery } = fixture();
  assert.equal(store.getDelivery(delivery.id).node_id, node.id);
});

// ---- node authentication ---------------------------------------------------
// The hub used to accept any connection quoting an existing node_id, without ever checking the
// token it sent. A delivery carries a room transcript, so that was enough to read private
// conversations knowing only a UUID.

test('a node token is actually verified, and a wrong one is refused', () => {
  const store = Store.open(':memory:');
  const node = store.registerNode({ name: 'mac', tokenHash: Store.hashNodeToken('right-token') });
  assert.ok(store.verifyNodeToken(node.id, 'right-token'), 'the correct token must be accepted');
  assert.equal(store.verifyNodeToken(node.id, 'wrong-token'), null);
  assert.equal(store.verifyNodeToken(node.id, ''), null);
  assert.equal(store.verifyNodeToken(node.id, undefined), null);
  assert.equal(store.verifyNodeToken(crypto.randomUUID(), 'right-token'), null, 'unknown node');
});

test('verifyNodeToken never leaks the stored hash', () => {
  const store = Store.open(':memory:');
  const node = store.registerNode({ name: 'mac', tokenHash: Store.hashNodeToken('t') });
  assert.equal(store.verifyNodeToken(node.id, 't').token_hash, undefined);
});

test('a revoked node is refused even with the right token', () => {
  const store = Store.open(':memory:');
  const node = store.registerNode({ name: 'mac', tokenHash: Store.hashNodeToken('t') });
  store.raw.prepare('UPDATE nodes SET revoked_at_ms = ? WHERE id = ?').run(Date.now(), node.id);
  assert.equal(store.verifyNodeToken(node.id, 't'), null);
});
