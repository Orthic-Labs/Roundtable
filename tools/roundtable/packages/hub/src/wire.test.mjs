// Run with: node --test 'tools/roundtable/packages/hub/src/*.test.mjs'
// (Pass the glob, not the directory — the bare directory form also picks up wire.mjs and fails.)
// Zero dependencies on purpose — no package manager works on the dev Mac right now.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION, HubFrame, NodeFrame, WireError,
  encodeFrame, serialize, decodeFrame,
} from './wire.mjs';

const FIXED = { eventId: '01930000-0000-7000-8000-000000000000', sentAtMs: 1753440000000 };

test('hub frame matches the Rust node Envelope<T> shape exactly', () => {
  const env = encodeFrame(HubFrame.PING, { nonce: 'abc' }, FIXED);
  // Field-for-field against crates/roundtable-node/src/hub.rs::Envelope<T>.
  assert.deepEqual(Object.keys(env).sort(), ['event_id', 'payload', 'sent_at_ms', 'type', 'version']);
  assert.equal(env.version, PROTOCOL_VERSION);
  assert.equal(env.type, 'ping');
  // payload is NESTED, not flattened — this is the whole point of the divergence from WsEnvelope.
  assert.deepEqual(env.payload, { nonce: 'abc' });
});

test('serialized JSON carries `type` and a nested `payload`, not a flattened event', () => {
  const json = JSON.parse(serialize(encodeFrame(HubFrame.PING, { nonce: 'x' }, FIXED)).toString());
  assert.equal(json.type, 'ping');
  assert.equal(json.payload.nonce, 'x');
  assert.equal(json.nonce, undefined, 'event fields must NOT be flattened to the top level');
});

test('every hub->node frame the Rust node parses is encodable', () => {
  // crates/roundtable-node/src/hub.rs dispatches exactly these.
  for (const t of ['hello.accepted', 'delivery.assign', 'approval.resolve', 'seat.detach', 'ping', 'query.result', 'mutation.result']) {
    assert.equal(encodeFrame(t, {}, FIXED).type, t);
  }
});

test('every node->hub frame the Rust node emits is decodable', () => {
  // From encode_frame(...) call sites in hub.rs.
  for (const t of ['node.hello', 'node.pong', 'node.delivery.ack', 'node.delivery.state', 'node.run.event', 'node.message.post',
                   'node.handoff.create', 'node.approval.request', 'node.seat.presence', 'node.run.create', 'node.query']) {
    const raw = JSON.stringify({ version: PROTOCOL_VERSION, event_id: FIXED.eventId, sent_at_ms: FIXED.sentAtMs, type: t, payload: {} });
    assert.equal(decodeFrame(raw).type, t);
  }
});

test('round-trips through Buffer', () => {
  const env = encodeFrame(HubFrame.SEAT_DETACH, { seat_id: FIXED.eventId, reason: 'offline' }, FIXED);
  const back = JSON.parse(serialize(env).toString('utf8'));
  assert.deepEqual(back, env);
});

test('version mismatch is fatal rather than silently ignored', () => {
  const raw = JSON.stringify({ version: 99, event_id: FIXED.eventId, sent_at_ms: 1, type: NodeFrame.HELLO, payload: {} });
  assert.throws(() => decodeFrame(raw), WireError);
});

test('unknown frame types are rejected, not dropped', () => {
  const raw = JSON.stringify({ version: PROTOCOL_VERSION, event_id: FIXED.eventId, sent_at_ms: 1, type: 'node.not_a_frame', payload: {} });
  assert.throws(() => decodeFrame(raw), WireError);
  assert.throws(() => encodeFrame('not.a.hub.frame', {}), WireError);
});

test('malformed frames are rejected', () => {
  assert.throws(() => decodeFrame('{'), WireError);
  assert.throws(() => decodeFrame('[]'), WireError);
  const noPayload = JSON.stringify({ version: PROTOCOL_VERSION, event_id: FIXED.eventId, sent_at_ms: 1, type: NodeFrame.HELLO });
  assert.throws(() => decodeFrame(noPayload), WireError);
});
