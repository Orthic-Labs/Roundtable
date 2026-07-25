// Run with: node --test 'tools/roundtable/packages/hub/src/*.test.mjs'
// Serves the real built PWA from packages/web/dist when present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHub, DEFAULT_WEB_ROOT } from './server.mjs';
import { Store } from './store.mjs';

const BUILT = existsSync(`${DEFAULT_WEB_ROOT}/index.html`);

async function withHub(fn, opts = {}) {
  const hub = createHub({
    store: Store.open(':memory:'), adminToken: 'tok', secure: false, allowedOrigins: [], ...opts,
  });
  const addr = await hub.listen(0);
  try { await fn(`http://127.0.0.1:${addr.port}`); } finally { await hub.close(); }
}

test('serves the built PWA at /', { skip: !BUILT && 'run `npx vite build` in packages/web first' }, async () => {
  await withHub(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<div id="root">|<script/);
  });
});

test('index.html is never cached, hashed assets are immutable', { skip: !BUILT && 'needs a build' }, async () => {
  await withHub(async (base) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.headers.get('cache-control'), 'no-store',
      'a cached index.html leaves clients on a stale asset manifest after deploy');

    // Find a real hashed asset from the built index.
    const html = await (await fetch(`${base}/`)).text();
    const asset = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0];
    assert.ok(asset, 'built index should reference a hashed asset');
    const res = await fetch(base + asset);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /immutable/);
  });
});

test('unknown client-side route falls back to index.html, not 404', { skip: !BUILT && 'needs a build' }, async () => {
  await withHub(async (base) => {
    const res = await fetch(`${base}/rooms/some-room-id`);
    assert.equal(res.status, 200, 'a refresh on a client route must not 404');
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});

test('API 404s stay JSON — the SPA fallback must not swallow them', async () => {
  await withHub(async (base) => {
    const res = await fetch(`${base}/api/definitely-not-a-route`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
  });
});

test('path traversal cannot escape the web root', async () => {
  await withHub(async (base) => {
    // Encoded so fetch does not normalize it away before it reaches the server.
    const res = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`);
    assert.ok(res.status === 403 || res.status === 404 || res.status === 200);
    if (res.status === 200) {
      assert.doesNotMatch(await res.text(), /root:x:/, 'must never serve /etc/passwd');
    }
  });
});

test('with no build present, / is a clean 404 rather than a crash', async () => {
  await withHub(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not_found');
  }, { webRoot: '/nonexistent/web/dist' });
});
