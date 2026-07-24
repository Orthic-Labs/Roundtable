---
type: risk
title: roundtable — uncovered flow: Browser + node WebSocket fan-out
description: missing: PWA and node cannot connect - entire transport layer blocked
tags: [blueprint, roundtable, risk, coverage-gap]
---

flow: Browser + node WebSocket fan-out; status: missing; impact: PWA and node cannot connect - entire transport layer blocked; existingPrimitives: ['store.events table']; handoff: architect; evidence: tools/roundtable/crates/roundtable-hub/src/ws.rs:1-8

## Related
- [roundtable-architecture](roundtable-architecture.md)
