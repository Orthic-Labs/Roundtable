#!/usr/bin/env node
// Put roundtable.spoares.com and api.spoares.com behind Cloudflare Access, WITHOUT cutting off
// the nodes.
//
//   node ops/gate-with-access.mjs            # plan only, changes nothing
//   node ops/gate-with-access.mjs --apply    # make it so
//
// Needs CLOUDFLARE_API_TOKEN with Account -> "Access: Apps and Policies" -> Edit. On this Mac the
// token lives in ~/.zshrc, which a non-interactive shell does NOT read, so run it as:
//   zsh -ic 'node ops/gate-with-access.mjs --apply'
//
// WHY A SCRIPT RATHER THAN FOUR CURLS: the order below is load-bearing, and getting it wrong takes
// every Roundtable node offline until someone notices.
//
// Both nodes dial wss://roundtable.spoares.com/node/connect. Access intercepts the WebSocket
// handshake, and a node has no browser identity to satisfy it — so an Access app on the bare
// hostname kills every node the instant it is created. Cloudflare resolves overlapping apps by
// longest path match, so a SEPARATE app on the /node/connect path with a Bypass policy wins over
// the host-wide app. This script therefore creates the bypass FIRST and verifies it answers before
// it creates the app that would otherwise lock the nodes out.
//
// The allow policy is CLONED from whatever currently guards spoares.com rather than invented here,
// so Roundtable inherits the identity rules you already trust instead of a second, drifting copy.

const ACCOUNT = '03ae77ccd7a07bcbb2dcfde47fa7ba3a';
const API = 'https://api.cloudflare.com/client/v4';
const SOURCE_APP_DOMAIN = 'spoares.com'; // the app whose policy we clone
const BYPASS_PATH = 'roundtable.spoares.com/node/connect';
const TARGETS = ['roundtable.spoares.com', 'api.spoares.com'];

const APPLY = process.argv.includes('--apply');
const token = process.env.CLOUDFLARE_API_TOKEN;

if (!token) {
  console.error('CLOUDFLARE_API_TOKEN is not set in this shell.');
  console.error("On the Mac it is in ~/.zshrc — run: zsh -ic 'node ops/gate-with-access.mjs --apply'");
  process.exit(2);
}

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!body.success) {
    const e = (body.errors || [])[0] || {};
    // 10000 is the one you will actually hit: the token is valid, it just lacks the Access scope.
    if (e.code === 10000) {
      throw new Error(
        'Cloudflare returned 10000 (valid token, missing permission).\n' +
        '  Add: dash -> My Profile -> API Tokens -> edit ->\n' +
        '       Account -> "Access: Apps and Policies" -> Edit\n' +
        '       Account -> "Access: Organizations, Identity Providers, and Groups" -> Read\n' +
        '  Editing permissions keeps the token VALUE, so no session restart is needed.',
      );
    }
    throw new Error(`${path} -> ${e.code}: ${e.message || 'unknown error'}`);
  }
  return body.result;
}

const listApps = () => cf(`/accounts/${ACCOUNT}/access/apps`);
const listPolicies = (appId) => cf(`/accounts/${ACCOUNT}/access/apps/${appId}/policies`);

async function main() {
  const apps = await listApps();
  const byDomain = new Map(apps.map((a) => [a.domain, a]));
  console.log(`Access applications today: ${apps.length}`);
  for (const a of apps) console.log(`  ${a.domain}`);

  const source = byDomain.get(SOURCE_APP_DOMAIN);
  if (!source) throw new Error(`no Access app on ${SOURCE_APP_DOMAIN} to clone a policy from`);
  const sourcePolicies = await listPolicies(source.id);
  const allow = sourcePolicies.find((p) => p.decision === 'allow');
  if (!allow) throw new Error(`the ${SOURCE_APP_DOMAIN} app has no allow policy to clone`);
  console.log(`\nCloning allow policy ${allow.name!== undefined ? `"${allow.name}"` : ''} from ${SOURCE_APP_DOMAIN}`);
  console.log(`  include rules: ${JSON.stringify(allow.include)}`);

  // ---- step 1: the bypass, BEFORE anything that could lock the nodes out --------------------
  const plan = [];
  if (byDomain.has(BYPASS_PATH)) {
    console.log(`\n[skip] bypass app already exists for ${BYPASS_PATH}`);
  } else {
    plan.push({
      step: 'bypass',
      domain: BYPASS_PATH,
      app: { name: 'Roundtable node WebSocket (bypass)', domain: BYPASS_PATH, type: 'self_hosted', session_duration: '24h' },
      policy: {
        name: 'Bypass — nodes have no browser identity',
        decision: 'bypass',
        include: [{ everyone: {} }],
      },
    });
  }

  // ---- step 2: the host-wide gates -----------------------------------------------------------
  for (const domain of TARGETS) {
    if (byDomain.has(domain)) {
      console.log(`[skip] ${domain} already has an Access app`);
      continue;
    }
    plan.push({
      step: 'gate',
      domain,
      app: { name: `${domain} (Access)`, domain, type: 'self_hosted', session_duration: '24h' },
      policy: { name: allow.name || 'Allow', decision: 'allow', include: allow.include },
    });
  }

  if (plan.length === 0) {
    console.log('\nNothing to do — everything is already gated.');
    return;
  }

  console.log('\nPLAN (bypass first, on purpose):');
  for (const p of plan) console.log(`  ${p.step.padEnd(7)} ${p.domain}  policy=${p.policy.decision}`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to make these changes.');
    return;
  }

  for (const p of plan) {
    const app = await cf(`/accounts/${ACCOUNT}/access/apps`, {
      method: 'POST',
      body: JSON.stringify(p.app),
    });
    await cf(`/accounts/${ACCOUNT}/access/apps/${app.id}/policies`, {
      method: 'POST',
      body: JSON.stringify(p.policy),
    });
    console.log(`  created ${p.domain} (${p.policy.decision})`);

    // Prove the bypass actually bypasses before creating the app that depends on it.
    if (p.step === 'bypass') {
      const probe = await fetch(`https://${BYPASS_PATH}`, { redirect: 'manual' });
      const loc = probe.headers.get('location') || '';
      if (loc.includes('cloudflareaccess')) {
        throw new Error(
          `STOPPING: ${BYPASS_PATH} still redirects to Access after the bypass was created.\n` +
          '  Creating the host-wide app now would take every node offline. Investigate first.',
        );
      }
      console.log(`  verified ${BYPASS_PATH} is NOT redirected to Access`);
    }
  }

  console.log('\nDone. Now confirm the nodes survived:');
  console.log("  ssh vendure 'grep node.connected ~/.pm2/logs/roundtable-hub-out.log | tail -2'");
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
