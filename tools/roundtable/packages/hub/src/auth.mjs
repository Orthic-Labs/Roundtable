// Session auth for the Node hub.
//
// Ported field-for-field from crates/roundtable-hub/src/auth.rs so a session issued by either
// implementation is interchangeable. Cookie name, attribute order, hash, and comparison semantics
// all match; changing any of them is a breaking change to the browser contract.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Matches auth.rs SESSION_COOKIE. The __Host- prefix forces Path=/, Secure, and no Domain. */
export const SESSION_COOKIE = '__Host-roundtable';

/** sha256 hex, matching hash_secret(). */
export function hashSecret(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Raw 32-byte digest, matching hash_secret_bytes(). */
export function hashSecretBytes(secret) {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Constant-time comparison, matching token_matches()'s use of subtle::ConstantTimeEq.
 * Comparing digests (not the secrets) keeps both sides fixed-length, so timingSafeEqual
 * cannot throw on a length mismatch and no length is leaked.
 */
export function tokenMatches(expectedDigest, supplied) {
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  return timingSafeEqual(expectedDigest, hashSecretBytes(supplied));
}

/** 32 random bytes, base64url, no padding — matches random_token(). */
export function randomToken() {
  return randomBytes(32).toString('base64url');
}

/** Matches session_cookie() attribute-for-attribute, including order. */
export function sessionCookie(token, secure, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`
    + (secure ? '; Secure' : '');
}

export function clearSessionCookie(secure) {
  return sessionCookie('', secure, 0);
}

/** Pull the session token out of a Cookie header. Returns null when absent. */
export function sessionFromHeaders(headers) {
  const raw = headers?.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * Exact-origin guard for mutating requests.
 *
 * The Rust hub rejects a mutation whose Origin is not explicitly allowed, which is what stops a
 * hostile page from driving the hub with the operator's cookie. A missing Origin is allowed only
 * for non-browser clients (the node connects without one).
 */
export function originAllowed(origin, allowedOrigins) {
  if (origin === undefined || origin === null || origin === '') return true;
  return allowedOrigins.includes(origin);
}
