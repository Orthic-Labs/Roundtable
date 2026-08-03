# Citadel Rules

## Purpose
Citadel is a private control room for live local Codex and Claude sessions.
Keep provider execution, credentials, and hidden session state on the enrolled machine.

## Canonical sources
- Read `README.md` for product and operator behavior.
- Read `docs/architecture.md` for components, flows, and security boundaries.
- Read `HANDOVER.md` before continuing active implementation work.
- Treat `STATUS.md` as current state, not a permanent rule source.

## Commands
- Run `cargo test --workspace` for Rust protocol, store, and node coverage.
- Run `cd packages/hub && node --test src/*.test.mjs` for hub coverage.
- Run `git diff --check` before handoff.

## Locked invariants
- Keep provider keys off the hub and load node tokens from environment or owner-only files.
- Keep enrollment on the SSH-operated CLI instead of exposing a public HTTP route.
- Persist deliveries before dispatch and prevent terminal replay after reconnect.
- Let nodes read only rooms where they hold a seat.
- Keep approval verdicts with the operator rather than the local Claude IPC channel.
- Preserve the outbound node connection and owner-only local socket model.

## Verification
- Run focused protocol or store tests before the full Rust and hub suites.
- Verify real session adapters against actual Codex app-server or Claude MCP behavior when changed.
- Require live deployment evidence before claiming persistence or remote-control acceptance.
