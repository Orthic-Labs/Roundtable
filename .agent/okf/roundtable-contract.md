---
type: contract
title: roundtable — contract
tags: [blueprint, roundtable]
---

## invariants
- **** — rule: Strict client mutations reject unknown fields; evidence: tools/roundtable/crates/roundtable-protocol/src/lib.rs:131 #[serde(deny_unknown_fields)]
- **** — rule: Message body <= 64 KiB UTF-8 bytes (not chars); evidence: tools/roundtable/crates/roundtable-protocol/src/lib.rs:7 + 151
- **** — rule: Request dedupe keyed by (actor_id, request_id, payload_sha256); evidence: tools/roundtable/crates/roundtable-store/src/lib.rs:100
- **** — rule: Cookie attributes exact: __Host- prefix, HttpOnly, SameSite=Strict, Max-Age=2592000, Secure; evidence: tools/roundtable/crates/roundtable-hub/src/auth.rs
- **** — rule: SQLite WAL + foreign_keys=ON + busy_timeout=5000 + synchronous=NORMAL; evidence: tools/roundtable/crates/roundtable-store/migrations/0001_initial.sql
- **** — rule: Atomic message+delivery+event+dedupe transaction; evidence: tools/roundtable/crates/roundtable-store/src/lib.rs:108

## constraints
- **** — constraint: Single binary per app (no Electron); evidence: 2026-07-22-roundtable-cross-device-architecture.md section 1
- **** — constraint: Outbound-only node connections (no inbound firewall openings); evidence: 2026-07-22-roundtable-cross-device-architecture.md section 3
- **** — constraint: Windows GUI subsystem, no console window; evidence: 2026-07-22-roundtable-cross-device-architecture.md section 11

## assumptions
- **** — assumption: Single admin token for bootstrap (until admin API exists); evidence: ROUND_TABLE_ADMIN_TOKEN env; confidence: high
- **** — assumption: Single-user PWA (no multi-tenant in V1); evidence: absent in code - no user table exists; confidence: med
- **** — assumption: Always-online for hub; offline is PWA-only; evidence: PWA offline.ts exists in worktree; confidence: high

## decisions
- **** — decision: Roundtable dispatches via WebSocket envelope with version=1; evidence: 2026-07-22-roundtable-cross-device-architecture.md section 3 + protocol PROTOCOL_VERSION const; validity: current
- **** — decision: Lease-based delivery with attempt<2 requeue + attempt>=3 dead-letter; evidence: tools/roundtable/crates/roundtable-store/src/lib.rs:212-221; validity: current
- **** — decision: Coffee #211D1A + ember #FF5630 visual identity for PWA; evidence: tools/roundtable/packages/web/src/styles.css (in PWA branch); validity: current
