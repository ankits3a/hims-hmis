# 0041 — Two-site production: the hospital's own server is primary, with automatic failover to the cloud

- **Date:** 2026-10-03   **Status:** Partly open
- **Area:** hosting, production, billing (serial numbers)

## Decision

- The hospital's own server becomes the primary production site (an Ubuntu VM on the hospital's Windows server); the
  cloud server is the automatic failover standby. One writer at a time, asynchronous Postgres replication.
- **Standby: the current cloud host for now**; an Indian server in about a month.
- **No extra hardware:** one ISP line, no witness device, no 4G link.
- **Switching is automatic, both ways.**
- **A few seconds of data loss on failover is accepted.**
- **On an emergency failover, GST and every other serial skips 20** numbers, with an audit row.
- **Writes from outside the hospital during an internet cut are wanted** (queued as a later phase).

## Why

The owner fears hospital internet cuts and wants patient data inside the hospital.

## Consequences / how to apply

- Design: `docs/superpowers/plans/2026-10-03-phase1-11b-two-site-production.md`.
- Steps that restart production Postgres or change the firewall/VPN need the owner's go-ahead before they run.

## Open

- The Indian standby server is not yet chosen.
