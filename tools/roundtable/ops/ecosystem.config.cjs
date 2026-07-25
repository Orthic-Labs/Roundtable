// pm2 config for the Node hub.
//
// The box runs 15 other Node services under pm2; this matches them deliberately. Because the hub
// is dependency-free (node:sqlite, node:http, hand-rolled WS), deployment is:
//
//   cd ~/sites/roundtable && git pull --ff-only origin main && pm2 restart roundtable-hub
//
// There is nothing to compile and nothing to install. Do NOT add a build step here.
//
// Secrets are NOT in this file. ROUND_TABLE_ADMIN_TOKEN comes from the environment file below,
// which is created out-of-band with mode 0600 and never committed:
//
//   /etc/roundtable/roundtable.env      (root-owned, 0600)
//
// Start once with:
//   pm2 start ops/ecosystem.config.cjs && pm2 save

module.exports = {
  apps: [{
    name: 'roundtable-hub',
    script: 'packages/hub/main.mjs',
    cwd: '/home/vendure/sites/roundtable/tools/roundtable',
    interpreter: 'node',
    instances: 1,
    exec_mode: 'fork', // single instance: SQLite WAL has one writer and the WS state is in-process
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      // Bind to the Docker gateway so the containerised nginx can reach it; not 0.0.0.0.
      ROUND_TABLE_BIND: '172.22.0.1:8460',
      ROUND_TABLE_DATABASE: '/var/lib/roundtable/roundtable.sqlite3',
      ROUND_TABLE_ORIGINS: 'https://roundtable.spoares.com',
    },
    out_file: '/home/vendure/.pm2/logs/roundtable-hub-out.log',
    error_file: '/home/vendure/.pm2/logs/roundtable-hub-error.log',
    merge_logs: true,
    time: true,
  }],
};
