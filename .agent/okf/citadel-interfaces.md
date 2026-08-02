---
type: interfaces
title: roundtable — interfaces
tags: [blueprint, roundtable]
---

## publicApi
- **POST /api/auth/login** — evidence: tools/citadel/crates/citadel-hub/src/http.rs
- **GET /healthz** — evidence: tools/citadel/crates/citadel-hub/src/main.rs:10
- **GET /readyz** — evidence: tools/citadel/crates/citadel-hub/src/main.rs:11
- **GET/POST /node/connect (planned)** — evidence: 2026-07-22-citadel-cross-device-architecture.md section 4

## moduleInterfaces
- **citadel_protocol::Envelope<T>** — evidence: tools/citadel/crates/citadel-protocol/src/lib.rs:121
- **citadel_protocol::MessageMutation (deny_unknown_fields)** — evidence: tools/citadel/crates/citadel-protocol/src/lib.rs:131
- **citadel_store::Store::open / open_in_memory / append_message** — evidence: tools/citadel/crates/citadel-store/src/lib.rs:50

## dataContracts
- **WebSocket envelope** — shape: {version:u8, event_id:Uuid, sent_at_ms:i64, type:String, payload:Value}; evidence: tools/citadel/crates/citadel-protocol/src/lib.rs:121
- **Cookie session** — shape: __Host-citadel=<session>; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure; evidence: tools/citadel/crates/citadel-hub/src/auth.rs

## configKeys
- **ROUND_TABLE_ADMIN_TOKEN** — evidence: 2026-07-22-citadel-cross-device-architecture.md
- **ROUND_TABLE_NODE_TOKEN_<NAME>** — evidence: 2026-07-22-citadel-cross-device-architecture.md
- **ALLOWED_ORIGINS** — evidence: tools/citadel/crates/citadel-hub/src/http.rs (AppConfig.allowed_origins)

## extensionPoints
- **SeatProvider enum** — evidence: tools/citadel/crates/citadel-protocol/src/lib.rs:53 - extensible for future VoiceRight etc.
- **DeliveryReason enum** — evidence: tools/citadel/crates/citadel-protocol/src/lib.rs:30 - extensible

## fragileContracts
- **Lock-step Cookie attribute string** — evidence: tools/citadel/crates/citadel-hub/src/auth.rs - tests assert exact substring; any reorder breaks
