// Accept Cloudflare Access as proof of identity, so the operator is not asked to log in twice.
//
// Access authenticates at Cloudflare's edge and forwards a signed assertion in the
// `Cf-Access-Jwt-Assertion` header. Cloudflare's own guidance is to VERIFY that token rather than
// trust the header's presence — "to ensure that the request came from Access and not a malicious
// third party" — because a header is trivially forged by anything that can reach the origin.
//
// Two independent things must both hold before this grants access, and neither is sufficient alone:
//   1. nginx only accepts connections from Cloudflare (cf-enforce.inc), so nothing else can even
//      present a header here.
//   2. the assertion is signed by THIS team's Access keys and names THIS application.
//
// RS256 verification uses node:crypto only — no dependency added for one signature check.

import { createPublicKey, createVerify } from 'node:crypto';

const b64urlToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Fetch and cache the team's signing keys.
 *
 * Cached because this runs on every request, and re-fetched on an unknown `kid` because Cloudflare
 * rotates keys — pinning them would fail closed at the worst moment, on a rotation, with no
 * warning. `ttlMs` bounds how long a revoked key stays usable.
 */
export function createAccessVerifier({ teamDomain, audience, ttlMs = 15 * 60 * 1000, fetchImpl = fetch }) {
  if (!teamDomain || !audience) return null; // not configured -> feature off, caller falls back
  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  let keys = new Map();
  let fetchedAt = 0;

  async function refresh() {
    const res = await fetchImpl(certsUrl);
    if (!res.ok) throw new Error(`access certs ${res.status}`);
    const body = await res.json();
    const next = new Map();
    for (const jwk of body.keys || []) {
      next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    }
    keys = next;
    fetchedAt = Date.now();
  }

  async function keyFor(kid) {
    if (!keys.has(kid) || Date.now() - fetchedAt > ttlMs) await refresh();
    return keys.get(kid);
  }

  /** @returns {Promise<{email: string} | null>} the verified identity, or null if not valid. */
  return async function verify(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [rawHeader, rawPayload, rawSig] = parts;

    let header, payload;
    try {
      header = JSON.parse(b64urlToBuf(rawHeader).toString('utf8'));
      payload = JSON.parse(b64urlToBuf(rawPayload).toString('utf8'));
    } catch { return null; }

    // Reject `alg: none` and anything we did not agree to, rather than dispatching on attacker input.
    if (header.alg !== 'RS256') return null;

    const key = await keyFor(header.kid).catch(() => null);
    if (!key) return null;

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${rawHeader}.${rawPayload}`);
    verifier.end();
    if (!verifier.verify(key, b64urlToBuf(rawSig))) return null;

    // A signature from the right team is not enough: without the audience check, a token minted for
    // ANY other application in this Cloudflare account would be accepted here.
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(audience)) return null;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
    if (payload.iss && payload.iss !== `https://${teamDomain}`) return null;

    return { email: payload.email || null };
  };
}
