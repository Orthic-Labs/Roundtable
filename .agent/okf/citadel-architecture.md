---
type: architecture
title: roundtable — architecture
description: Roundtable is a cross-device agent orchestration hub (Task 0-13 spec at 2026-07-22-citadel-cross-device-architecture.md) backed by a Rust workspace with three crates (protocol, store, hub) plus an in-progress node + PWA. Local implementa
tags: [blueprint, roundtable]
---

Roundtable is a cross-device agent orchestration hub (Task 0-13 spec at 2026-07-22-citadel-cross-device-architecture.md) backed by a Rust workspace with three crates (protocol, store, hub) plus an in-progress node + PWA. Local implementation at commit 6d37f5c2 has the protocol enums, the 11-table SQLite schema, the actor-based store with WAL/foreign-keys/busy_timeout/synchronous=NORMAL, atomic message+delivery commits, request-id+payload-sha256 dedupe, lease requeue, and dead-letter at attempt 3, plus a hub slice with /healthz, /readyz, /api/auth/login (sets __Host-citadel cookie with HttpOnly + SameSite=Strict + Max-Age=2592000 + Secure), and an origin-locked gate. /node/connect returns 501 and locked room/node/seat/message HTTP routes, the WebSocket fan-out, the node-side Claude/Codex adapters, the PWA workflows, and the ops/E2E/installers remain unimplemented.

## stack
- **Rust 2021** — evidence: tools/citadel/Cargo.toml:1
- **Tokio 1 async runtime** — evidence: tools/citadel/crates/citadel-hub/Cargo.toml
- **Axum 0.8 HTTP** — evidence: tools/citadel/crates/citadel-hub/Cargo.toml
- **rusqlite 0.40 bundled** — evidence: tools/citadel/crates/citadel-store/Cargo.toml
- **serde / serde_json** — evidence: tools/citadel/crates/citadel-protocol/Cargo.toml
- **uuid v7** — evidence: tools/citadel/crates/citadel-protocol/src/lib.rs:5
- **sha2 SHA-256** — evidence: tools/citadel/crates/citadel-protocol/src/lib.rs:2
- **thiserror** — evidence: tools/citadel/crates/citadel-store/Cargo.toml
- **React 19 + Vite + Vitest (PWA)** — evidence: tools/citadel/packages/web/package.json (planned; feat/roundtable-pwa-task6 branch)

## components
- **citadel-protocol** — evidence: tools/citadel/crates/citadel-protocol/src/lib.rs; role: Shared typed protocol - ActorKind/MessageKind/DeliveryReason/DeliveryState/SeatProvider/SeatState enums, Room/Message/Seat/Delivery records, Envelope<T>, MessageMutation with deny_unknown_fields, validate_message_body, canonical_sha256, 5 unit tests
- **citadel-store** — evidence: tools/citadel/crates/citadel-store/src/lib.rs; role: SQLite actor - dedicated thread owns one Connection with WAL+FK+busy_timeout=5000+synchronous=NORMAL, atomic append_message (message+mentions+deliveries+events+request_dedupe in one transaction), requeue_expired leases, record_failure with dead-letter at attempt 3, 8 unit tests
- **citadel-hub (slice)** — evidence: tools/citadel/crates/citadel-hub/src/{lib,auth,http,router,state,ws,main}.rs; role: Axum HTTP server - health endpoints, /api/auth/login (sets __Host-citadel cookie with exact attribute string), origin-locked mutation gate via AppConfig.allowed_origins, hash_secret; /node/connect returns 501; locked room/node/seat/message HTTP routes NOT YET IMPLEMENTED
- **citadel-node (planned)** — evidence: tools/citadel/crates/citadel-node/Cargo.toml; role: Outbound-authenticated WebSocket client on Mac/Windows - Cargo.toml has full async/runtime deps but src/main.rs is empty placeholder; no Claude or Codex adapter code
- **roundtable-web (PWA branch)** — evidence: feat/roundtable-pwa-task6 - tools/citadel/packages/web/src/{App,api,offline,types,styles,test-setup}.tsx + components/{Login,RoomList,RoomView,SeatPanel,MessageList,Composer}.tsx; role: React 19 PWA - login + room creation/archive, session discovery/attach, structured mention metadata, optimistic message state with server seq replacement, WebSocket seat/delivery/approval updates, approval + handoff evidence rendering, IndexedDB offline queue with request-id dedupe, scroll-anchor pagination, manifest + service worker, 10 vitest tests passing, vite build passing (24 modules / 205KB JS). NOT YET MERGED into main.

## dataFlow
- Browser POST /api/auth/login -> citadel-hub auth.rs -> set __Host-citadel cookie + httpOnly cookie session -> Browser
- Browser POST /api/rooms -> citadel-hub http.rs (NOT IMPLEMENTED) -> citadel-store create_room -> Browser
- Browser WS /browser/socket -> citadel-hub ws.rs (STUB) -> fan-out from events table
- Node WS /node/connect?node_id=...&resume_cursor=N -> citadel-hub ws.rs (returns 501) -> replay events WHERE target_node_id AND seq > N
- Node delivers delivery.assign -> adapter invokes provider (Claude Channel MCP or Codex App Server) -> emits delivery.ack/state/complete -> citadel-hub -> store.record_failure / mark completed

## entryPoints
- **hub** — command: citadel-hub; evidence: tools/citadel/crates/citadel-hub/src/main.rs:9
- **node** — command: citadel-node; evidence: tools/citadel/crates/citadel-node/src/main.rs (placeholder only)
- **web** — command: pnpm --dir tools/citadel/packages/web dev; evidence: tools/citadel/packages/web/package.json

## stateStores
- **SQLite (WAL)** — evidence: tools/citadel/crates/citadel-store/migrations/0001_initial.sql; tables: ['rooms', 'nodes', 'seats', 'messages', 'message_mentions', 'deliveries', 'handoffs', 'approvals', 'request_dedupe', 'browser_sessions', 'events']

## externalDeps
- **tokio 1** — evidence: tools/citadel/crates/citadel-hub/Cargo.toml
- **axum 0.8** — evidence: tools/citadel/crates/citadel-hub/Cargo.toml
- **rusqlite 0.40** — evidence: tools/citadel/crates/citadel-store/Cargo.toml
- **serde / serde_json** — evidence: tools/citadel/crates/citadel-protocol/Cargo.toml
- **uuid v7** — evidence: tools/citadel/crates/citadel-protocol/Cargo.toml:21
- **sha2** — evidence: tools/citadel/crates/citadel-protocol/Cargo.toml:23

## deployableUnits
- **citadel-hub** — entryPoint: tools/citadel/crates/citadel-hub/src/main.rs; type: api; components: ['citadel-hub', 'citadel-store', 'citadel-protocol']
- **citadel-node** — entryPoint: tools/citadel/crates/citadel-node/src/main.rs; type: worker; components: ['citadel-node', 'citadel-protocol']
- **roundtable-web** — entryPoint: tools/citadel/packages/web/src/main.tsx; type: web; components: ['roundtable-web']

## infrastructure
- **** — target: Linux server (Hetzner, planned); evidence: 2026-07-22-citadel-cross-device-architecture.md - systemd + nginx config described but ops/systemd/, ops/nginx.conf, ops/install-macos.sh, ops/install-windows.ps1 NOT YET WRITTEN

## crossCutting
- **Strict protocol types** — evidence: tools/citadel/crates/citadel-protocol/src/lib.rs:131 - #[serde(deny_unknown_fields)] on MessageMutation
- **UUID v7 monotonic IDs** — evidence: tools/citadel/crates/citadel-protocol/src/lib.rs:6
- **64 KiB message cap** — evidence: tools/citadel/crates/citadel-protocol/src/lib.rs:7
- **Dedupe by (actor_id, request_id, payload_sha256)** — evidence: tools/citadel/crates/citadel-store/src/lib.rs:102 - request_dedupe table
- **Cookie attributes exact** — evidence: tools/citadel/crates/citadel-hub/src/auth.rs - __Host-citadel=...; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure
- **Origin allowlist gate** — evidence: tools/citadel/crates/citadel-hub/src/http.rs

## capabilityCoverage
- **** — capability: document/ADR/plan claims and precedence; status: covered; evidence: 2026-07-22-citadel-cross-device-architecture.md, .agent/claims.json (7554 claims); provider: blueprint
- **** — capability: code symbols (files, modules, types, functions, methods, routes, schemas); status: covered; evidence: tools/citadel/crates/roundtable-{protocol,store,hub}/src/**/*.rs - 421/511/260 LOC of typed Rust, 7 source files in hub; provider: blueprint lexical (rust)
- **** — capability: code relationships (defines, contains, imports, calls, implements, reads/writes, tests); status: partial; evidence: Cargo.toml workspace wiring visible; no call-graph extraction beyond lexical imports; provider: blueprint lexical
- **** — capability: task retrieval across both code and documents; status: covered; evidence: graph candidates + queue.json (4.2 MB); provider: blueprint
- **** — capability: contradiction/staleness arbitration; status: covered; evidence: verdicts.json (this run): 21 verified, 5 stale (CODE-FELL-SHORT findings); provider: blueprint

## flows
- **** — flow: Browser login + cookie session; status: covered; evidence: tools/citadel/crates/citadel-hub/src/auth.rs + http.rs; tests/auth.rs verified 4/4
- **** — flow: Origin gate blocks wrong-origin mutations; status: covered; evidence: tools/citadel/crates/citadel-hub/src/http.rs; tests/auth.rs verified wrong_origin_returns_403_on_mutations
- **** — flow: Revoked node token cannot upgrade; status: covered; evidence: tools/citadel/crates/citadel-hub/src/http.rs authenticate_node_headers; tests/auth.rs verified revoked_node_token_cannot_upgrade
- **** — flow: Atomic message+delivery+event+dedupe commit; status: covered; evidence: tools/citadel/crates/citadel-store/src/lib.rs:108 - message_and_deliveries_commit_atomically passing
- **** — flow: Dedupe replay vs RequestIdReused; status: covered; evidence: tools/citadel/crates/citadel-store/src/lib.rs - same_request_same_payload_replays_response + same_request_different_payload_conflicts passing
- **** — flow: Lease expiry requeue; status: covered; evidence: tools/citadel/crates/citadel-store/src/lib.rs:212 - lease_expiry_requeues_once passing
- **** — flow: Third failure dead-letters; status: covered; evidence: tools/citadel/crates/citadel-store/src/lib.rs:215 - third_failure_dead_letters passing
- **** — flow: Gap-free room seq under concurrency; status: covered; evidence: tools/citadel/crates/citadel-store/src/lib.rs:188 - room_sequence_is_gap_free_under_concurrency passing (30 tasks)
- **** — flow: Browser connects WebSocket and receives seat/delivery updates; status: missing; evidence: tools/citadel/crates/citadel-hub/src/ws.rs is 8-line stub; no fan-out implementation
- **** — flow: Node WebSocket connect with resume_cursor replays events; status: missing; evidence: /node/connect returns 501; locked replay path not implemented
- **** — flow: Human mention wakes selected seats, prose alias does not; status: covered; evidence: tests/delivery.rs - human_mention_wakes_only_selected_seats + agent_text_containing_every_alias_wakes_nobody verified in worktree but not yet merged into main
- **** — flow: Structured handoff wakes target + marks evidence; status: covered; evidence: tests/delivery.rs structured_handoff_wakes_exactly_target_and_marks_evidence verified in worktree, not yet merged
- **** — flow: Two seats cannot claim same exclusive task key; status: covered; evidence: tests/delivery.rs two_seats_cannot_claim_same_exclusive_task_key - verified in worktree, not yet merged
- **** — flow: Circular handoffs stop after depth 8; status: covered; evidence: tests/delivery.rs circular_handoffs_stop_after_depth_eight - verified in worktree, not yet merged
- **** — flow: Room + message CRUD via HTTP; status: missing; evidence: Hub route handlers for /api/rooms not implemented; room_and_message_crud_validate_limits failing in worktree
- **** — flow: Duplicate mutation returns first response; status: missing; evidence: tests/http.rs duplicate_mutation_returns_first_response - currently returns 409 instead of 201 on replay (worktree failure)
- **** — flow: Cancel while running preserves no destructive rollback; status: missing; evidence: claim.2026-07-22-roundtable-cross-device-architecture-md.ed52.408 STALE - no seat.interrupt message type in protocol
- **** — flow: Cancel while waiting_approval ends deterministically; status: missing; evidence: claim.2026-07-22-roundtable-cross-device-architecture-md.ed52.410 STALE - no approval_resolved_after_cancel variant
- **** — flow: Claude Channel MCP route invocation; status: missing; evidence: tools/citadel/crates/citadel-node/ - no Claude adapter code
- **** — flow: Codex App Server JSONL route invocation; status: missing; evidence: tools/citadel/crates/citadel-node/ - no Codex adapter code
- **** — flow: PWA login + room list + compose + WebSocket state; status: partial; evidence: feat/roundtable-pwa-task6 - vitest 10 passed, vite build passed (24 modules); NOT YET MERGED into main
- **** — flow: PWA offline IndexedDB queue replay; status: partial; evidence: feat/roundtable-pwa-task6 - offline.ts implemented and tested, but unmerged
- **** — flow: macOS node installer (LaunchAgent plist, token from stdin); status: missing; evidence: ops/install-macos.sh NOT WRITTEN
- **** — flow: Windows node installer (Per-user Scheduled Task, no console window, no token in args); status: missing; evidence: ops/install-windows.ps1 NOT WRITTEN
- **** — flow: nginx + systemd hub deployment; status: missing; evidence: ops/nginx.conf, ops/systemd/roundtable.service NOT WRITTEN
- **** — flow: Backup script; status: missing; evidence: ops/backup.sh NOT WRITTEN
- **** — flow: Observability guide; status: missing; evidence: ops/observability.md NOT WRITTEN (verdict stale: claim.ed52.710)
- **** — flow: rightkit-logs wiring; status: missing; evidence: Hub Cargo.toml lacks rightkit-logs dep; hub emits no structured tracing (verdict stale: claim.ed52.155)
- **** — flow: Local fake-node E2E roundtrip; status: missing; evidence: tests/e2e/roundtrip.mjs NOT WRITTEN - expected output 'ROUNDTRIP PASS deliveries=2 duplicates=0' never run

## coverageGaps
- **** — flow: Browser + node WebSocket fan-out; status: missing; impact: PWA and node cannot connect - entire transport layer blocked; existingPrimitives: ['store.events table']; handoff: architect; evidence: tools/citadel/crates/citadel-hub/src/ws.rs:1-8
- **** — flow: Locked HTTP CRUD for rooms/nodes/seats/messages; status: missing; impact: Browser cannot create rooms or post messages through the hub; existingPrimitives: ['store.create_room', 'store.append_message']; handoff: architect
- **** — flow: Node-side Claude + Codex provider adapters; status: missing; impact: No real agent can be invoked; round-trip is impossible; existingPrimitives: ['citadel-node Cargo.toml dependencies']; handoff: architect
- **** — flow: Cancellation contract (seat.interrupt + approval_resolved_after_cancel); status: missing; impact: Cancel is not deterministic; partial outputs policy cannot be enforced; handoff: architect
- **** — flow: macOS LaunchAgent + Windows Per-user Scheduled Task installers; status: missing; impact: Node cannot ship to production machines; handoff: architect
- **** — flow: ops/observability.md + rightkit-logs wiring; status: missing; impact: Hub has no structured logs; ops playbook cannot direct on-call; handoff: architect
- **** — flow: Fake-node E2E; status: missing; impact: No acceptance proof - code is unverified end-to-end; existingPrimitives: ['tests/delivery.rs,tests/auth.rs,tests/http.rs (in worktree)']; handoff: architect
