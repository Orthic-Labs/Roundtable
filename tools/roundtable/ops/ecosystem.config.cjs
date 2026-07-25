// pm2 config for the Node hub.
//
// The box runs 15 other Node services under pm2; this matches them deliberately. Because the hub
// is dependency-free (node:sqlite, node:http, hand-rolled WS), deployment is:
//
//   cd ~/sites/roundtable && git pull --ff-only origin main && pm2 restart roundtable-hub
//
// There is nothing to compile and nothing to install. Do NOT add a build step here.
//
// Secrets are NOT in this file. pm2 has NO native env-file support, so the token is not inlined
// here and not loaded from a shell wrapper — main.mjs reads it from the path below at startup
// (ROUND_TABLE_ADMIN_TOKEN_FILE). Create it out-of-band, 0600, owned by the user pm2 runs as:
//
//   install -m 700 -d ~/.config/roundtable
//   openssl rand -hex 32 > ~/.config/roundtable/admin-token
//   chmod 600 ~/.config/roundtable/admin-token
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
      // 0.0.0.0, matching every other service on this box (rightapps-api :3301, the brand
      // sites :4211-4215). Binding ONLY to the docker gateway 172.22.0.1 looked tighter but the
      // containerised nginx could not reach it — TLS connected and the proxy then hung until
      // timeout, while the same container reached :4211 fine. Not publicly exposed: the host
      // firewall does not open 8460 and Cloudflare fronts the only route in (verified after
      // changing this — 8460 is refused from the public internet).
      ROUND_TABLE_BIND: '0.0.0.0:8460',
      // Under ~, not /var/lib: the vendure user owns this and needs no sudo to back it up or
      // move it. Nothing on this box requires the database to live outside the home directory.
      ROUND_TABLE_DATABASE: '/home/vendure/.local/share/roundtable/roundtable.sqlite3',
      ROUND_TABLE_ADMIN_TOKEN_FILE: '/home/vendure/.config/roundtable/admin-token',
      ROUND_TABLE_ORIGINS: 'https://roundtable.spoares.com',
    },
    out_file: '/home/vendure/.pm2/logs/roundtable-hub-out.log',
    error_file: '/home/vendure/.pm2/logs/roundtable-hub-error.log',
    merge_logs: true,
    time: true,
  }],
};
