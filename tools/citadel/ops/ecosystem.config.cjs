// pm2 config for the Node hub.
//
// The box runs 15 other Node services under pm2; this matches them deliberately. Because the hub
// is dependency-free (node:sqlite, node:http, hand-rolled WS), deployment is:
//
//   cd ~/sites/citadel && git pull --ff-only origin main && pm2 restart citadel-hub
//
// There is nothing to compile and nothing to install. Do NOT add a build step here.
//
// Secrets are NOT in this file. pm2 has NO native env-file support, so the token is not inlined
// here and not loaded from a shell wrapper — main.mjs reads it from the path below at startup
// (ROUND_TABLE_ADMIN_TOKEN_FILE). Create it out-of-band, 0600, owned by the user pm2 runs as:
//
//   install -m 700 -d ~/.config/citadel
//   openssl rand -hex 32 > ~/.config/citadel/admin-token
//   chmod 600 ~/.config/citadel/admin-token
//
// Start once with:
//   pm2 start ops/ecosystem.config.cjs && pm2 save

module.exports = {
  apps: [{
    name: 'citadel-hub',
    script: 'packages/hub/main.mjs',
    cwd: '/home/vendure/sites/citadel/tools/citadel',
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
      CITADEL_BIND: '0.0.0.0:8460',
      // Under ~, not /var/lib: the vendure user owns this and needs no sudo to back it up or
      // move it. Nothing on this box requires the database to live outside the home directory.
      CITADEL_DATABASE: '/home/vendure/.local/share/citadel/roundtable.sqlite3',
      CITADEL_ADMIN_TOKEN_FILE: '/home/vendure/.config/citadel/admin-token',
      CITADEL_ORIGINS: 'https://citadel.spoares.com',
      // Cloudflare Access fronts this host, so a verified Access assertion authenticates the
      // operator and the admin-token login is not asked for a second time. Neither value is a
      // secret: both appear in the public Access login redirect
      // (/cdn-cgi/access/login/<host>?kid=<aud>). The SECRET half is Cloudflare's signing key,
      // which is never here — the hub fetches the team's PUBLIC keys and verifies against those.
      // Unset these and the feature switches off, leaving the admin token as the only way in.
      CITADEL_ACCESS_TEAM_DOMAIN: 'adrdsouza.cloudflareaccess.com',
      CITADEL_ACCESS_AUD: 'd5ede6f630edb801c03529809fec76203320b781c9f5eb2d7bca892ab1dadc40',
    },
    out_file: '/home/vendure/.pm2/logs/citadel-hub-out.log',
    error_file: '/home/vendure/.pm2/logs/citadel-hub-error.log',
    merge_logs: true,
    time: true,
  }],
};
