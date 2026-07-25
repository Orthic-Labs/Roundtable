// Run with: node --test 'tools/roundtable/packages/hub/src/*.test.mjs'
// End-to-end against a real listening server over real HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHub } from './server.mjs';
import { Store } from './store.mjs';
import {
  SESSION_COOKIE, hashSecret, hashSecretBytes, tokenMatches,
  randomToken, sessionCookie, sessionFromHeaders, originAllowed,
} from './auth.mjs';

const ADMIN = 'test-admin-token';

async function withHub(fn) {
  const hub = createHub({
    store: Store.open(':memory:'),
    adminToken: ADMIN,
    secure: false, // plain HTTP in tests
    allowedOrigins: ['https://roundtable.spoares.com'],
  });
  const addr = await hub.listen(0);
  const base = `http://127.0.0.1:${addr.port}`;
  try { await fn(base, hub); } finally { await hub.close(); }
}

/** Extract the session cookie from a Set-Cookie header for reuse. */
const cookieFrom = (res) => {
  const sc = res.headers.get('set-cookie');
  return sc ? sc.split(';')[0] : null;
};

test('auth: hash and constant-time compare match the Rust contract', () => {
  // sha256("abc") — pinned so a hash change is caught rather than silently accepted.
  assert.equal(hashSecret('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(tokenMatches(hashSecretBytes('s3cret'), 's3cret'), true);
  assert.equal(tokenMatches(hashSecretBytes('s3cret'), 'wrong'), false);
  assert.equal(tokenMatches(hashSecretBytes('s3cret'), ''), false);
});

test('auth: cookie is __Host- compliant and attribute order matches', () => {
  assert.equal(
    sessionCookie('abc', true, 100),
    '__Host-roundtable=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=100; Secure',
  );
  assert.ok(!sessionCookie('abc', false, 100).includes('Secure'));
  assert.equal(randomToken().length, 43); // 32 bytes base64url, unpadded
});

test('auth: session parsed from a crowded Cookie header', () => {
  assert.equal(sessionFromHeaders({ cookie: `other=1; ${SESSION_COOKIE}=tok; x=2` }), 'tok');
  assert.equal(sessionFromHeaders({ cookie: 'other=1' }), null);
  assert.equal(sessionFromHeaders({}), null);
});

test('auth: origin guard allows absent Origin but rejects a foreign one', () => {
  const allowed = ['https://roundtable.spoares.com'];
  assert.equal(originAllowed(undefined, allowed), true, 'the node connects without an Origin');
  assert.equal(originAllowed('https://roundtable.spoares.com', allowed), true);
  assert.equal(originAllowed('https://evil.example', allowed), false);
});

test('health endpoints answer without auth', async () => {
  await withHub(async (base) => {
    for (const p of ['/healthz', '/readyz']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });
    }
  });
});

test('security headers are present on every response', async () => {
  await withHub(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });
});

test('login rejects a wrong token and accepts the right one', async () => {
  await withHub(async (base, hub) => {
    const bad = await fetch(`${base}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ token: 'nope' }),
    });
    assert.equal(bad.status, 401);
    assert.equal(hub.sessionCount, 0, 'a failed login must not create a session');

    const good = await fetch(`${base}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ token: ADMIN }),
    });
    assert.equal(good.status, 200);
    assert.equal(hub.sessionCount, 1);
    assert.match(good.headers.get('set-cookie'), /^__Host-roundtable=/);
  });
});

test('protected routes require a session, and the cookie unlocks them', async () => {
  await withHub(async (base) => {
    assert.equal((await fetch(`${base}/api/me`)).status, 401);

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ token: ADMIN }),
    });
    const cookie = cookieFrom(login);
    const me = await fetch(`${base}/api/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { authenticated: true });
  });
});

test('logout invalidates the session', async () => {
  await withHub(async (base, hub) => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ token: ADMIN }),
    });
    const cookie = cookieFrom(login);
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(hub.sessionCount, 0);
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 401);
  });
});

test('a foreign Origin cannot drive a mutation even with a valid cookie', async () => {
  await withHub(async (base) => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ token: ADMIN }),
    });
    const cookie = cookieFrom(login);
    const res = await fetch(`${base}/api/rooms`, {
      method: 'POST', headers: { cookie, Origin: 'https://evil.example' }, body: '{}',
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'origin_not_allowed');
  });
});

test('declared-but-unported routes return 501, unknown routes 404', async () => {
  await withHub(async (base) => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ token: ADMIN }),
    });
    const cookie = cookieFrom(login);
    // /api/nodes is declared in the route table but its handler is not ported yet.
    const known = await fetch(`${base}/api/nodes`, { headers: { cookie } });
    assert.equal(known.status, 501, 'a declared route must not look like a typo');
    assert.equal((await known.json()).route, '/api/nodes');
    assert.equal((await fetch(`${base}/api/nope`, { headers: { cookie } })).status, 404);
  });
});

test('path params are captured', async () => {
  await withHub(async (base) => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ token: ADMIN }),
    });
    const cookie = cookieFrom(login);
    const res = await fetch(`${base}/api/nodes/node-123`, { headers: { cookie } });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).route, '/api/nodes/:node_id');
  });
});

test('oversized bodies are rejected rather than buffered', async () => {
  await withHub(async (base) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST', body: 'x'.repeat(1024 * 1024 + 10),
    });
    assert.equal(res.status, 413);
  });
});

test('E2E: a node connects over WebSocket and the hub tracks it', async () => {
  await withHub(async (base, hub) => {
    const client = new WebSocket(`${base.replace('http', 'ws')}/node/connect`);
    await once(client, 'open');
    assert.equal(hub.connectionCount, 1);
    client.close();
  });
});

test('E2E: an unknown websocket path is refused', async () => {
  await withHub(async (base) => {
    const client = new WebSocket(`${base.replace('http', 'ws')}/nope`);
    const [evt] = await once(client, 'close');
    assert.equal(evt.code, 1008);
  });
});
