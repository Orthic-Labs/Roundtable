# Citadel hub spine decision

**Decision:** `tools/roundtable/packages/hub` is Citadel's single maintained hub spine.

The deployed Node hub owns HTTP, browser WebSocket, SQLite DTO mapping, operator events, & node delivery. `crates/roundtable-hub` remains buildable as a frozen recovery/reference implementation, marked by `CITADEL_RUST_HUB_FROZEN`; it receives no routes, features, or contract repairs.

This decision follows verified Node-path contract, auth, idempotency, transition, outbox, inspector, & delegation gates. Revisit Rust-hub retirement only after bounded parity/recovery review. P1-12 agent-room retirement remains deferred until link invite, budgets, runtime profiles, & execution bridges reach documented parity plus Adrian approves a follow-up dispatch.
