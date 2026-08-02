---
type: health
title: roundtable — health
tags: [blueprint, roundtable]
---

## hotspots
- **** — file: tools/citadel/crates/citadel-store/src/lib.rs; loc: 511; note: Large actor + many DB ops in one file - natural extraction point once more tables land (`tools/citadel/crates/citadel-store/src/lib.rs`)

## coupling
- **** — from: citadel-hub; to: citadel-store; evidence: tools/citadel/crates/citadel-hub/src/state.rs - direct Store ownership

## untested
- **** — file: tools/citadel/crates/citadel-hub/src/router.rs; evidence: hub has 0 tests at HEAD; delivery tests live in worktree, not yet merged (`tools/citadel/crates/citadel-hub/src/router.rs`)
- **** — file: tools/citadel/crates/citadel-hub/src/ws.rs; evidence: stub only (`tools/citadel/crates/citadel-hub/src/ws.rs`)
- **** — file: tools/citadel/crates/citadel-node/src/main.rs; evidence: placeholder; no real code (`tools/citadel/crates/citadel-node/src/main.rs`)

## top10
- **** — rank: 1; finding: Hub is a health/auth slice; locked HTTP+WS surface unimplemented; evidence: tools/citadel/crates/citadel-hub/src/{main,lib,auth,http,router,state,ws}.rs
- **** — rank: 2; finding: Node crate has full Cargo.toml but empty src; evidence: tools/citadel/crates/citadel-node/Cargo.toml + src/main.rs
- **** — rank: 3; finding: PWA work on feat/roundtable-pwa-task6 not merged into main; evidence: git -C /Volumes/D/claude branch -a
- **** — rank: 4; finding: rightkit-logs not wired to hub (claim.ed52.155 STALE); evidence: tools/citadel/crates/citadel-hub/Cargo.toml
- **** — rank: 5; finding: Cancellation contract missing from protocol types; evidence: claim.ed52.408 + ed52.410 STALE
- **** — rank: 6; finding: Ops dir (install-macos.sh, install-windows.ps1, nginx.conf, systemd unit, backup, observability.md) not written; evidence: tools/citadel/ops/ does not exist
- **** — rank: 7; finding: Fake-node E2E acceptance harness not written; evidence: tests/e2e/roundtrip.mjs does not exist
- **** — rank: 8; finding: Hub tests = 0 at HEAD; only worktree; evidence: git -C /Volumes/D/claude show --stat 6d37f5c2
- **** — rank: 9; finding: Store has 8 unit tests passing - solid foundation; evidence: tools/citadel/crates/citadel-store/src/lib.rs tests
- **** — rank: 10; finding: Protocol has 5 tests passing - well-typed boundary; evidence: tools/citadel/crates/citadel-protocol/src/lib.rs:172-215
