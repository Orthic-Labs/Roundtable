---
type: security
title: roundtable — security
tags: [blueprint, roundtable]
---

## trustBoundaries
- **** — from: Browser; to: Hub; control: __Host-citadel cookie + Origin allowlist + CSRF via SameSite=Strict; evidence: tools/citadel/crates/citadel-hub/src/{auth,http}.rs
- **** — from: Node; to: Hub; control: Bearer node token + node_id query param + ?resume_cursor for replay; evidence: 2026-07-22-citadel-cross-device-architecture.md section 4 + tests/auth.rs revoked_node_token_cannot_upgrade

## secrets
- **** — path: ROUND_TABLE_ADMIN_TOKEN (env); present: True; evidence: 2026-07-22-citadel-cross-device-architecture.md (`ROUND_TABLE_ADMIN_TOKEN (env)`)
- **** — path: ROUND_TABLE_NODE_TOKEN_<NAME> (env); present: True; evidence: 2026-07-22-citadel-cross-device-architecture.md (`ROUND_TABLE_NODE_TOKEN_<NAME> (env)`)

## injectionSurface
- **** — surface: Node WebSocket message bodies parsed as JSON envelopes; evidence: citadel_protocol::Envelope - schema-validated per envelope

## authz
- **** — rule: Mutations require exact-origin match against allowlist; evidence: tools/citadel/crates/citadel-hub/src/http.rs
- **** — rule: Revoked node tokens cannot upgrade to WebSocket; evidence: tests/auth.rs revoked_node_token_cannot_upgrade

## dataProtection
- **** — control: Cookies are HttpOnly + Secure + SameSite=Strict; evidence: tools/citadel/crates/citadel-hub/src/auth.rs
