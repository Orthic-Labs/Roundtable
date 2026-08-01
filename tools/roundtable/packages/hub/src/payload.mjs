import { createHash } from 'node:crypto';

/** Stable actor id for browser-originated idempotent mutations. */
export const OPERATOR_ACTOR = 'operator';

export function payloadSha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
