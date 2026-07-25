// Run with: node --test 'tools/roundtable/packages/hub/src/*.test.mjs'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, StoreError } from './store.mjs';

const sha = (s) => s; // dedupe treats the hash as opaque; real hashing is the caller's job.

test('applies the Rust migration verbatim — same tables, no JS-specific schema', () => {
  const store = Store.open(':memory:');
  // Exactly the tables crates/roundtable-store/migrations/0001_initial.sql declares.
  assert.deepEqual(store.tables(), [
    'approvals', 'browser_sessions', 'deliveries', 'events', 'handoffs',
    'message_mentions', 'messages', 'nodes', 'request_dedupe', 'rooms', 'seats',
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
