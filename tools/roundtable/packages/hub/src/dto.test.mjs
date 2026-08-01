// Run with: node --test 'tools/roundtable/packages/hub/src/*.test.mjs'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toRoom, toMessage, toApproval, normalizePostMessage, normalizeCreateHandoff,
  normalizeResolveApproval,
} from './dto.mjs';
import { canTransitionDelivery, assertDeliveryTransition } from './transitions.mjs';

test('dto: room maps archived_at_ms to archived_at', () => {
  const room = toRoom({
    id: 'r1', slug: 'x', title: 'T', objective: '', next_seq: 1, archived_at_ms: 99,
  });
  assert.equal(room.archived_at, 99);
  assert.equal(room.archived_at_ms, undefined);
});

test('dto: approval parses decisions_json', () => {
  const approval = toApproval({
    id: 'a1', room_id: 'r1', seat_id: 's1', description: 'd', input_preview: 'p',
    decisions_json: '["approve","deny"]', state: 'pending',
  });
  assert.deepEqual(approval.decisions, ['approve', 'deny']);
});

test('dto: message includes mentions and handoff metadata', () => {
  const msg = toMessage(
    {
      id: 'm1', room_id: 'r1', seq: 2, actor_id: 's1', actor_kind: 'agent',
      kind: 'handoff', body: 'summary', created_at_ms: 1,
    },
    {
      seatById: new Map([['s1', { alias: 'mac-claude' }]]),
      mentionedSeatIds: ['s2'],
      handoffByMessageId: new Map([['m1', {
        from_alias: 'mac-claude', to_alias: 'win-codex', evidence_refs: [{ kind: 'commit', value: 'abc' }],
      }]]),
      deliveryStateByMessageId: new Map([['m1', 'queued']]),
    },
  );
  assert.deepEqual(msg.mentioned_seat_ids, ['s2']);
  assert.equal(msg.actor, 'mac-claude');
  assert.equal(msg.handoff.summary, 'summary');
  assert.equal(msg.delivery_state, 'queued');
});

test('dto: normalizes mixed camelCase and snake_case mutation bodies', () => {
  assert.deepEqual(
    normalizePostMessage({ mentioned_seat_ids: ['s1'], body: 'hi' }).mentionSeatIds,
    ['s1'],
  );
  assert.equal(normalizeCreateHandoff({ summary: 'go' }).summary, 'go');
  assert.equal(normalizeResolveApproval({ decision: 'allow' }), 'allow');
  assert.equal(normalizeResolveApproval({ resolution: 'deny' }), 'deny');
});

test('transitions: illegal delivery rewind is rejected', () => {
  assert.equal(canTransitionDelivery('completed', 'running'), false);
  assert.throws(() => assertDeliveryTransition('completed', 'running'), /invalid_delivery_transition/);
});

test('transitions: happy path acked to running is allowed', () => {
  assert.equal(canTransitionDelivery('acked', 'running'), true);
});
