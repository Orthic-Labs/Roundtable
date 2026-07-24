---
type: solid
title: roundtable — solid
tags: [blueprint, roundtable]
---

## dimensions
- **observability** — status: Missing; note: rightkit-logs not wired; hub has no structured tracing. Verdict ed52.155 stale.
- **resilience** — status: Partial; note: Store handles requeue + dead-letter; WebSocket reconnect/replay logic on the server side is unwritten
- **config/env** — status: Partial; note: Admin/node tokens read from env; allowed_origins via AppConfig
- **testing** — status: Partial; note: protocol 5/5, store 8/8, hub 0; PWA 10/10 in branch; integration E2E missing
- **CI/CD** — status: Missing; note: No GitHub Actions / pipeline definition
- **performance** — status: Undetermined; note: No benchmarks yet
- **scalability** — status: Undetermined; note: Single-instance hub; SQLite WAL works for one writer, fan-out model unproven
- **data lifecycle** — status: Partial; note: 11 tables created on open; no retention/archival policy
- **onboarding** — status: Partial; note: Architecture doc + protocol/store code is readable; missing ops runbook + installer docs
- **accessibility** — status: Partial; note: PWA branch ships reduced-motion + focus styles + accessible names per AC
- **licensing** — status: Undetermined; note: Repo LICENSE not declared in scout

## scorecard
- **** — dimension: observability; score: 1
- **** — dimension: resilience; score: 2
- **** — dimension: config/env; score: 3
- **** — dimension: testing; score: 3
- **** — dimension: CI/CD
- **** — dimension: performance; score: 1
- **** — dimension: scalability; score: 2
- **** — dimension: data lifecycle; score: 2
- **** — dimension: onboarding; score: 3
- **** — dimension: accessibility; score: 3
- **** — dimension: licensing; score: 1

## top5
- **** — rank: 1; issue: Implement hub HTTP+WS surface; evidence: tools/roundtable/crates/roundtable-hub/src/{router,ws}.rs
- **** — rank: 2; issue: Implement node-side Claude + Codex adapters + IPC; evidence: tools/roundtable/crates/roundtable-node/src/main.rs (empty)
- **** — rank: 3; issue: Merge PWA branch into main and re-run end-to-end smoke; evidence: feat/roundtable-pwa-task6
- **** — rank: 4; issue: Write ops/ (install-macos.sh, install-windows.ps1, nginx.conf, systemd unit, backup.sh, observability.md); evidence: tools/roundtable/ops/ does not exist
- **** — rank: 5; issue: Wire rightkit-logs into hub and add fake-node E2E; evidence: claim.ed52.155 + claim.ed52.710 stale
