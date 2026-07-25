#!/usr/bin/env node
// Node hub entrypoint.
//
// Env matches the Rust hub so a swap needs no config change:
//   ROUND_TABLE_DATABASE      default ./roundtable.sqlite3
//   ROUND_TABLE_ADMIN_TOKEN   required — no default, ever
//   ROUND_TABLE_BIND          default 127.0.0.1:8460
//   ROUND_TABLE_ORIGINS       comma-separated allowed origins for mutations
//   ROUND_TABLE_INSECURE_COOKIE=1  drop the Secure attribute (local HTTP only)

import { readFileSync } from 'node:fs';
import { Store } from './src/store.mjs';
import { createHub } from './src/server.mjs';
import { log } from './src/log.mjs';

const database = process.env.ROUND_TABLE_DATABASE ?? 'roundtable.sqlite3';
const bind = process.env.ROUND_TABLE_BIND ?? '127.0.0.1:8460';
const allowedOrigins = (process.env.ROUND_TABLE_ORIGINS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The admin token, from the environment or a 0600 file.
 *
 * The file form exists because **pm2 has no native env-file support** — `ecosystem.config.cjs`
 * can only carry literals, and putting the production admin token in a committed config file is
 * not an option. `ROUND_TABLE_ADMIN_TOKEN_FILE` lets the secret live in a root-owned 0600 file
 * that pm2 merely points at. Same pattern as the node's `BearerToken::load`.
 */
function loadAdminToken() {
  const file = process.env.ROUND_TABLE_ADMIN_TOKEN_FILE;
  if (file) {
    try {
      const token = readFileSync(file, 'utf8').trim();
      if (token) return token;
      log.error('startup.admin_token_file_empty', { path: file });
    } catch (err) {
      log.error('startup.admin_token_file_unreadable', { path: file, err });
    }
    process.exit(1);
  }
  return process.env.ROUND_TABLE_ADMIN_TOKEN;
}

const adminToken = loadAdminToken();
if (!adminToken) {
  // Matches the Rust hub's .expect() — refuse to start rather than run unauthenticated.
  log.error('startup.no_admin_token', {
    hint: 'set ROUND_TABLE_ADMIN_TOKEN or ROUND_TABLE_ADMIN_TOKEN_FILE',
  });
  process.exit(1);
}

const lastColon = bind.lastIndexOf(':');
const host = bind.slice(0, lastColon) || '127.0.0.1';
const port = Number(bind.slice(lastColon + 1));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  log.error('startup.invalid_bind', { bind });
  process.exit(1);
}

const hub = createHub({
  store: Store.open(database),
  adminToken,
  secure: process.env.ROUND_TABLE_INSECURE_COOKIE !== '1',
  allowedOrigins,
});

await hub.listen(port, host);
// Without this the hub queues deliveries and never sends them to any node.
hub.startDispatchLoop();
log.info('startup.listening', { host, port, database, origins: allowedOrigins.length });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log.info('shutdown', { signal: sig });
    await hub.close();
    process.exit(0);
  });
}
