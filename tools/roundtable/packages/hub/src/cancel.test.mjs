// Run with: node --test 'tools/roundtable/packages/hub/src/cancel.test.mjs'
//
// The Cancellation contract from 2026-07-22-roundtable-cross-device-architecture.md, clause by
// clause. Each test names the clause it holds. These are store-level tests: they prove the state
// machine and the audit trail, not the WebSocket plumbing (dispatch of `seat.interrupt` is
// covered by the route test at the bottom).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  store.forceDeliveryState(delivery.id, 'sent');
  store.forceDeliveryState(delivery.id, 'acked');
  store.forceDeliveryState(delivery.id, 'running');
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
  store.forceDeliveryState(delivery.id, 'sent');
  store.forceDeliveryState(delivery.id, 'acked');
  store.forceDeliveryState(delivery.id, 'running');
  store.forceDeliveryState(delivery.id, 'waiting_approval');

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
  store.forceDeliveryState(delivery.id, 'sent');
  store.forceDeliveryState(delivery.id, 'acked');
  store.forceDeliveryState(delivery.id, 'running');
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

// ---- restart safety --------------------------------------------------------

test('a store can be reopened — the migration is not re-applied on restart', () => {
  // Every other test opens ':memory:', which is always fresh, so none of them could catch this:
  // the hub started fine on a new database and then died with "table rooms already exists" on its
  // FIRST restart, because Store.open re-ran the migration unconditionally. Guarded by
  // user_version now, matching roundtable-store's open_connection.
  const dir = mkdtempSync(join(tmpdir(), 'rt-store-'));
  const path = join(dir, 'reopen.sqlite3');

  const first = Store.open(path);
  const room = first.createRoom({ slug: 'persist', title: 'Persist' });
  first.close();

  const second = Store.open(path); // must not throw
  assert.equal(second.getRoom(room.id).slug, 'persist', 'data must survive the reopen');
  second.close();

  const third = Store.open(path); // and again
  assert.ok(third.tables().includes('rooms'));
  third.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a pre-guard database (migrated, user_version 0) is adopted, not re-migrated', () => {
  // Exactly the box's situation: the file was created before the user_version guard existed, so
  // it has every table AND reports version 0. Re-running the migration on it throws; stamping it
  // is correct because the schema it already has IS version 2.
  const dir = mkdtempSync(join(tmpdir(), 'rt-legacy-'));
  const path = join(dir, 'legacy.sqlite3');

  const first = Store.open(path);
  const room = first.createRoom({ slug: 'legacy', title: 'Legacy' });
  first.raw.exec('PRAGMA user_version = 0'); // simulate the pre-guard file
  first.close();

  const reopened = Store.open(path); // must not throw
  assert.equal(reopened.getRoom(room.id).slug, 'legacy');
  assert.equal(Number(Object.values(reopened.raw.prepare('PRAGMA user_version').get())[0]), 2,
    'the adopted database must be stamped so the next open takes the fast path');
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});
