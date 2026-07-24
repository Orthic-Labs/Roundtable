---
type: interfaces
title: roundtable — interfaces
tags: [blueprint, roundtable]
---

## publicApi
- **POST /api/auth/login** — evidence: tools/roundtable/crates/roundtable-hub/src/http.rs
- **GET /healthz** — evidence: tools/roundtable/crates/roundtable-hub/src/main.rs:10
- **GET /readyz** — evidence: tools/roundtable/crates/roundtable-hub/src/main.rs:11
- **GET/POST /node/connect (planned)** — evidence: 2026-07-22-roundtable-cross-device-architecture.md section 4

## moduleInterfaces
- **roundtable_protocol::Envelope<T>** — evidence: tools/roundtable/crates/roundtable-protocol/src/lib.rs:121
- **roundtable_protocol::MessageMutation (deny_unknown_fields)** — evidence: tools/roundtable/crates/roundtable-protocol/src/lib.rs:131
- **roundtable_store::Store::open / open_in_memory / append_message** — evidence: tools/roundtable/crates/roundtable-store/src/lib.rs:50

## dataContracts
- **WebSocket envelope** — shape: {version:u8, event_id:Uuid, sent_at_ms:i64, type:String, payload:Value}; evidence: tools/roundtable/crates/roundtable-protocol/src/lib.rs:121
- **Cookie session** — shape: __Host-roundtable=<session>; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure; evidence: tools/roundtable/crates/roundtable-hub/src/auth.rs

## configKeys
- **ROUND_TABLE_ADMIN_TOKEN** — evidence: 2026-07-22-roundtable-cross-device-architecture.md
- **ROUND_TABLE_NODE_TOKEN_<NAME>** — evidence: 2026-07-22-roundtable-cross-device-architecture.md
- **ALLOWED_ORIGINS** — evidence: tools/roundtable/crates/roundtable-hub/src/http.rs (AppConfig.allowed_origins)

## extensionPoints
- **SeatProvider enum** — evidence: tools/roundtable/crates/roundtable-protocol/src/lib.rs:53 - extensible for future VoiceRight etc.
- **DeliveryReason enum** — evidence: tools/roundtable/crates/roundtable-protocol/src/lib.rs:30 - extensible

## fragileContracts
- **Lock-step Cookie attribute string** — evidence: tools/roundtable/crates/roundtable-hub/src/auth.rs - tests assert exact substring; any reorder breaks
