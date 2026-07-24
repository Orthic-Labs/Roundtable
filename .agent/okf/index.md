---
type: index
title: Index
---

# Index

## architecture
- [roundtable — architecture](roundtable-architecture.md) — Roundtable is a cross-device agent orchestration hub (Task 0-13 spec at 2026-07-22-roundtable-cross-device-architecture.md) backed by a Rust workspace with three crates (protocol, store, hub) plus an in-progress node + PWA. Local implementa

## contract
- [roundtable — contract](roundtable-contract.md)

## health
- [roundtable — health](roundtable-health.md)

## interfaces
- [roundtable — interfaces](roundtable-interfaces.md)

## risk
- [roundtable — uncovered flow: Browser + node WebSocket fan-out](roundtable-risk-0.md) — missing: PWA and node cannot connect - entire transport layer blocked
- [roundtable — uncovered flow: Locked HTTP CRUD for rooms/nodes/seats/messages](roundtable-risk-1.md) — missing: Browser cannot create rooms or post messages through the hub
- [roundtable — uncovered flow: Node-side Claude + Codex provider adapters](roundtable-risk-2.md) — missing: No real agent can be invoked; round-trip is impossible
- [roundtable — uncovered flow: Cancellation contract (seat.interrupt + approval_resolved_after_cancel)](roundtable-risk-3.md) — missing: Cancel is not deterministic; partial outputs policy cannot be enforced
- [roundtable — uncovered flow: macOS LaunchAgent + Windows Per-user Scheduled Task installers](roundtable-risk-4.md) — missing: Node cannot ship to production machines
- [roundtable — uncovered flow: ops/observability.md + rightkit-logs wiring](roundtable-risk-5.md) — missing: Hub has no structured logs; ops playbook cannot direct on-call
- [roundtable — uncovered flow: Fake-node E2E](roundtable-risk-6.md) — missing: No acceptance proof - code is unverified end-to-end

## security
- [roundtable — security](roundtable-security.md)

## solid
- [roundtable — solid](roundtable-solid.md)
