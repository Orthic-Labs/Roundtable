/**
 * Structured JSON-lines logging for the hub.
 *
 * Zero dependencies, on purpose and under duress: `@rightkit/logs` is the workspace standard, but
 * pnpm is a broken release on this machine and npm fails on certificate trust, so nothing is
 * installable here (see HANDOVER.md "Known gotchas"). The field schema below deliberately matches
 * what a rightkit-logs sink expects, so swapping the implementation later is a change to this file
 * only, not to every call site.
 *
 * One JSON object per line on stdout. pm2 captures stdout to a file; `jq` is the query tool. That
 * is the whole pipeline — see ops/observability.md.
 */

import { resolveEnv } from './env-compat.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
// CITADEL_LOG_LEVEL is primary; ROUNDTABLE_LOG_LEVEL is honored unchanged for backward
// compatibility, with a one-time deprecation warning (see env-compat.mjs).
const threshold = LEVELS[resolveEnv('CITADEL_LOG_LEVEL', 'ROUNDTABLE_LOG_LEVEL')] ?? LEVELS.info;

/**
 * Fields that must never be logged, at any level. Tokens and cookies are the ones that would
 * actually leak an account; bodies are excluded because a room transcript is the user's private
 * content and has no place in an ops log.
 */
const REDACT = new Set(['token', 'admin_token', 'cookie', 'authorization', 'token_hash', 'body', 'password']);

function scrub(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACT.has(k)) { out[k] = '[redacted]'; continue; }
    // Errors do not JSON.stringify usefully — they serialize as {}.
    out[k] = v instanceof Error ? { message: v.message, name: v.name } : v;
  }
  return out;
}

function emit(level, event, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, event, ...scrub(fields) };
  // process.stdout.write, not console.log: no formatting, no interleaving surprises, one line.
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (event, fields = {}) => emit('debug', event, fields),
  info: (event, fields = {}) => emit('info', event, fields),
  warn: (event, fields = {}) => emit('warn', event, fields),
  error: (event, fields = {}) => emit('error', event, fields),
};
