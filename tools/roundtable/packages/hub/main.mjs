#!/usr/bin/env node
// Node hub entrypoint.
//
// Env matches the Rust hub so a swap needs no config change:
//   ROUND_TABLE_DATABASE      default ./roundtable.sqlite3
//   ROUND_TABLE_ADMIN_TOKEN   required — no default, ever
//   ROUND_TABLE_BIND          default 127.0.0.1:8460
//   ROUND_TABLE_ORIGINS       comma-separated allowed origins for mutations
//   ROUND_TABLE_INSECURE_COOKIE=1  drop the Secure attribute (local HTTP only)

import { Store } from './src/store.mjs';
import { createHub } from './src/server.mjs';

const database = process.env.ROUND_TABLE_DATABASE ?? 'roundtable.sqlite3';
const adminToken = process.env.ROUND_TABLE_ADMIN_TOKEN;
const bind = process.env.ROUND_TABLE_BIND ?? '127.0.0.1:8460';
const allowedOrigins = (process.env.ROUND_TABLE_ORIGINS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!adminToken) {
  // Matches the Rust hub's .expect() — refuse to start rather than run unauthenticated.
  console.error('ROUND_TABLE_ADMIN_TOKEN is required');
  process.exit(1);
}

const lastColon = bind.lastIndexOf(':');
const host = bind.slice(0, lastColon) || '127.0.0.1';
const port = Number(bind.slice(lastColon + 1));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid ROUND_TABLE_BIND: ${bind}`);
  process.exit(1);
}

const hub = createHub({
  store: Store.open(database),
  adminToken,
  secure: process.env.ROUND_TABLE_INSECURE_COOKIE !== '1',
  allowedOrigins,
});

await hub.listen(port, host);
console.log(`roundtable-hub listening on ${host}:${port} (db ${database})`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`${sig} received, shutting down`);
    await hub.close();
    process.exit(0);
  });
}
