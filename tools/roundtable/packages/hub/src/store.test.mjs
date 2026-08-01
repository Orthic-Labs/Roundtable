// Run with: node --test 'tools/roundtable/packages/hub/src/*.test.mjs'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, StoreError } from './store.mjs';

const sha = (s) => s; // dedupe treats the hash as opaque; real hashing is the caller's job.

test('applies the Rust migration verbatim — same tables, no JS-specific schema', () => {
  const store = Store.open(':memory:');
  // Exactly the tables declared by the shared v1 and v2 Rust migrations.
  assert.deepEqual(store.tables(), [
    'approvals', 'artifacts', 'browser_sessions', 'deliveries', 'events', 'handoffs', 'invites',
    'message_mentions', 'messages', 'nodes', 'request_dedupe', 'rooms', 'run_events',
    'runs', 'seats', 'tasks',
  ]);
  store.close();
});

test('foreign keys are enforced', () => {
  const store = Store.open(':memory:');
  assert.equal(store.raw.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  store.close();
});

test('dedupe: first call produces, second replays the original response', () => {
  const store = Store.open(':memory:');
  let calls = 0;
  const produce = () => { calls += 1; return { id: 'msg-1', seq: calls }; };

  const first = store.dedupe('actor-a', 'req-1', sha('p'), produce);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.response, { id: 'msg-1', seq: 1 });

  const second = store.dedupe('actor-a', 'req-1', sha('p'), produce);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.response, { id: 'msg-1', seq: 1 }, 'must return the ORIGINAL response');
  assert.equal(calls, 1, 'producer must not run twice — this is what makes node retries safe');
  store.close();
});

test('dedupe: same request_id with a different payload is rejected (HTTP 409)', () => {
  const store = Store.open(':memory:');
  store.dedupe('actor-a', 'req-1', sha('payload-one'), () => ({ ok: true }));
  assert.throws(
    () => store.dedupe('actor-a', 'req-1', sha('payload-two'), () => ({ ok: true })),
    (e) => e instanceof StoreError && e.message === 'request_id_reused',
  );
  store.close();
});

test('dedupe is scoped per actor — same request_id from a different node is independent', () => {
  const store = Store.open(':memory:');
  const a = store.dedupe('actor-a', 'req-1', sha('p'), () => ({ who: 'a' }));
  const b = store.dedupe('actor-b', 'req-1', sha('p'), () => ({ who: 'b' }));
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, false);
  assert.deepEqual(b.response, { who: 'b' });
  store.close();
});

test('a missing migration file fails loudly rather than opening an empty database', () => {
  assert.throws(
    () => Store.open(':memory:', { migrationPath: '/nonexistent/0001.sql' }),
    (e) => e instanceof StoreError && /cannot read migration/.test(e.message),
  );
});

test('a task creates one delivery-backed run with ordered idempotent events', () => {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'tasks', title: 'Tasks' });
  const node = store.registerNode({ name: 'node', tokenHash: 'h' });
  const seat = store.createSeat({ roomId: room.id, nodeId: node.id, alias: 'codex', provider: 'codex', sessionRef: 't' });
  const { task, run, delivery } = store.createTask({
    roomId: room.id, executorSeatId: seat.id, title: 'Inspect migration', instructions: 'Report schema',
    reasoningModel: 'gpt-5', executionRuntime: 'codex', toolExecutor: 'codex', observabilityGrade: 'standard',
  });
  assert.equal(task.state, 'queued');
  assert.equal(run.task_id, task.id);
  assert.equal(run.delivery_id, delivery.id);
  const first = store.appendRunEvent({ runId: run.id, eventKey: 'e1', type: 'command.completed', payload: { exit_code: 0 } });
  const retry = store.appendRunEvent({ runId: run.id, eventKey: 'e1', type: 'command.completed', payload: { exit_code: 0 } });
  const second = store.appendRunEvent({ runId: run.id, eventKey: 'e2', type: 'result', payload: { summary: 'ok' } });
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  assert.equal(retry.replayed, true);
  assert.equal(store.listRunEvents(run.id).length, 2);
  store.close();
});

test('an illegal delivery transition leaves its run and task queued', () => {
  const store = Store.open(':memory:');
  const room = store.createRoom({ slug: 'transitions', title: 'Transitions' });
  const node = store.registerNode({ name: 'node', tokenHash: 'h' });
  const seat = store.createSeat({ roomId: room.id, nodeId: node.id, alias: 'codex', provider: 'codex', sessionRef: 't' });
  const { task, run, delivery } = store.createTask({ roomId: room.id, executorSeatId: seat.id, title: 'No rewind', instructions: 'Use graph.' });
  assert.equal(store.setDeliveryStateForNode({ nodeId: node.id, deliveryId: delivery.id, state: 'running' }), null);
  assert.equal(store.getDelivery(delivery.id).state, 'queued');
  assert.equal(store.getRun(run.id).state, 'queued');
  assert.equal(store.getTask(task.id).state, 'queued');
  store.close();
});
