// The value of verifying the Access assertion is entirely in what it REJECTS. A check that only
// proves "a valid token is accepted" would pass just as well if the code trusted the header blindly,
// which is the bug Cloudflare's docs warn about. So most of these are negative cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { createAccessVerifier } from './access-jwt.mjs';

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'aud-tag-for-this-app';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mint({ key = privateKey, kid = 'kid-1', alg = 'RS256', ...claims } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg, kid }));
  const payload = b64url(JSON.stringify({
    aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, nbf: now - 10,
    email: 'adrian@example.com', ...claims,
  }));
  if (alg === 'none') return `${header}.${payload}.`;
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${b64url(signer.sign(key))}`;
}

// generateKeyPairSync already returns KeyObjects, and createPublicKey() rejects one that is
// already public ("expected private"), so export straight off it.
const jwk = (k) => ({ ...k.export({ format: 'jwk' }), kid: 'kid-1', alg: 'RS256' });

function verifier(overrides = {}) {
  return createAccessVerifier({
    teamDomain: TEAM,
    audience: AUD,
    fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [jwk(publicKey)] }) }),
    ...overrides,
  });
}

test('a genuine assertion from the team is accepted', async () => {
  const v = verifier();
  const id = await v(mint());
  assert.equal(id?.email, 'adrian@example.com');
});

test('a token signed by a DIFFERENT key is rejected', async () => {
  // The forgery that matters: anything able to reach the origin can set the header, so an
  // unverified implementation would accept this and hand over every transcript.
  const v = verifier();
  assert.equal(await v(mint({ key: other.privateKey })), null);
});

test('alg:none is rejected rather than dispatched on', async () => {
  const v = verifier();
  assert.equal(await v(mint({ alg: 'none' })), null);
});

test('a token for another application in the same account is rejected', async () => {
  // Same team, same signing keys, different app — valid signature, wrong audience.
  const v = verifier();
  assert.equal(await v(mint({ aud: ['some-other-app'] })), null);
});

test('an expired token is rejected', async () => {
  const v = verifier();
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await v(mint({ exp: now - 5 })), null);
});

test('a token from a different team is rejected', async () => {
  const v = verifier();
  assert.equal(await v(mint({ iss: 'https://attacker.cloudflareaccess.com' })), null);
});

test('garbage and empty input are rejected without throwing', async () => {
  const v = verifier();
  for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c', null, undefined, 42]) {
    assert.equal(await v(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('unconfigured verifier is null so the caller keeps the admin-token path', async () => {
  assert.equal(createAccessVerifier({ teamDomain: '', audience: '' }), null);
  assert.equal(createAccessVerifier({ teamDomain: TEAM, audience: '' }), null);
});

test('an unknown kid triggers a refetch rather than failing closed on rotation', async () => {
  let calls = 0;
  const v = createAccessVerifier({
    teamDomain: TEAM,
    audience: AUD,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ keys: [jwk(publicKey)] }) };
    },
  });
  assert.ok(await v(mint()));
  assert.equal(calls, 1, 'first verify fetches');
  assert.equal(await v(mint({ kid: 'rotated-kid' })), null);
  assert.ok(calls > 1, 'an unknown kid must refetch, or a key rotation locks everyone out');
});
