// Delivery and run state transition graph — mirrors the architecture contract.
// Invalid transitions are refused so a late or duplicated frame cannot rewind lifecycle.

export const DELIVERY_TRANSITIONS = Object.freeze({
  queued: ['sent', 'failed', 'dead_letter'],
  sent: ['acked', 'failed', 'dead_letter'],
  acked: ['running', 'failed', 'dead_letter'],
  running: ['waiting_approval', 'completed', 'failed', 'dead_letter'],
  waiting_approval: ['running', 'completed', 'failed', 'dead_letter'],
  completed: [],
  failed: [],
  dead_letter: [],
});

export function canTransitionDelivery(from, to) {
  if (from === to) return true;
  return DELIVERY_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertDeliveryTransition(from, to) {
  if (!canTransitionDelivery(from, to)) {
    const err = new Error('invalid_delivery_transition');
    err.from = from;
    err.to = to;
    throw err;
  }
}
