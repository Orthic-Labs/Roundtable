// Wire contract for the Node hub.
//
// This is transcribed from the Rust `roundtable-node` client, which is staying in Rust and is
// already written and tested. Node's framing is therefore authoritative: the hub is written to
// speak it, not the other way round. Source of truth:
//   crates/roundtable-node/src/hub.rs  (Envelope<T>, HubEvent, encode_frame)
//
// Envelope shape — note `payload` is NESTED and the discriminator field is `type`:
//   { version, event_id, sent_at_ms, type, payload: { ... } }
//
// This deliberately does NOT match `roundtable_protocol::WsEnvelope`, which flattens its event.
// That divergence is the known node<->hub gap recorded in STATUS.md; porting the hub to this
// framing is what closes it.

export const PROTOCOL_VERSION = 1;

/** Frames the hub sends to a node. */
export const HubFrame = Object.freeze({
  HELLO_ACCEPTED: 'hello.accepted',
  DELIVERY_ASSIGN: 'delivery.assign',
  APPROVAL_RESOLVE: 'approval.resolve',
  SEAT_DETACH: 'seat.detach',
  SEAT_INTERRUPT: 'seat.interrupt',
  PING: 'ping',
});

/** Frames a node sends to the hub. */
export const NodeFrame = Object.freeze({
  HELLO: 'node.hello',
  PONG: 'node.pong',
  DELIVERY_ACK: 'node.delivery.ack',
  MESSAGE_POST: 'node.message.post',
  HANDOFF_CREATE: 'node.handoff.create',
  APPROVAL_REQUEST: 'node.approval.request',
  SEAT_PRESENCE: 'node.seat.presence',
});

const HUB_FRAMES = new Set(Object.values(HubFrame));
const NODE_FRAMES = new Set(Object.values(NodeFrame));

export class WireError extends Error {}

/**
 * Build an envelope for a hub->node frame.
 * `event_id` and `sent_at_ms` are injectable so tests are deterministic.
 */
export function encodeFrame(type, payload, { eventId, sentAtMs } = {}) {
  if (!HUB_FRAMES.has(type)) throw new WireError(`unknown hub frame: ${type}`);
  if (payload === undefined || payload === null || typeof payload !== 'object') {
    throw new WireError(`payload must be an object for ${type}`);
  }
  return {
    version: PROTOCOL_VERSION,
    event_id: eventId ?? crypto.randomUUID(),
    sent_at_ms: sentAtMs ?? Date.now(),
    type,
    payload,
  };
}

/** Serialize a frame to the bytes put on the wire. */
export function serialize(envelope) {
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

/**
 * Parse an inbound node->hub frame.
 *
 * Mirrors the node client's own tolerance: a version mismatch is fatal on the handshake, and
 * unknown frame types are rejected rather than silently dropped, so a protocol change surfaces
 * instead of manifesting as a stuck seat.
 */
export function decodeFrame(raw) {
  let env;
  try {
    env = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch (e) {
    throw new WireError(`invalid frame JSON: ${e.message}`);
  }
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new WireError('frame must be a JSON object');
  }
  if (env.version !== PROTOCOL_VERSION) {
    throw new WireError(`protocol version mismatch: node=${env.version} hub=${PROTOCOL_VERSION}`);
  }
  if (typeof env.type !== 'string' || !NODE_FRAMES.has(env.type)) {
    throw new WireError(`unknown node frame: ${env.type}`);
  }
  if (env.payload === undefined || env.payload === null || typeof env.payload !== 'object') {
    throw new WireError(`missing payload for ${env.type}`);
  }
  if (typeof env.event_id !== 'string') throw new WireError('missing event_id');
  if (!Number.isInteger(env.sent_at_ms)) throw new WireError('missing sent_at_ms');
  return env;
}
