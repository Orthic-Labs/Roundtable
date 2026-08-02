import { OPERATOR_TARGET } from './dto.mjs';

/**
 * Append one operator-visible event and fan it out to every live browser socket.
 * Domain mutations call this after commit so the PWA does not need a full reload.
 */
export function publishOperatorEvent(store, browserConnections, { type, payload }) {
  const evt = store.appendOperatorEvent({ type, payload });
  const frame = JSON.stringify({ type, payload, cursor: evt.cursor });
  for (const conn of browserConnections) {
    try {
      conn.send(frame);
      conn.meta.cursor = evt.cursor;
    } catch { /* socket gone; close handler will clean up */ }
  }
  return evt;
}

export { OPERATOR_TARGET };
