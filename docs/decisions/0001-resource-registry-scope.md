# 0001 — What the resource registry holds, and when master-data change control may start

- **Date:** 2026-08-26   **Status:** Ruled
- **Area:** kernel (resource registry), opd, ot, ipd

Recorded in §4A of the Plan 13 phase doc `docs/superpowers/plans/2026-08-26-phase1-13-resource-registry.md`
(phase closed 2026-08-27).

## Decision

- Instrument sets are NOT a registry kind. They live in a CSSD table with a foreign key to the autoclave device.
- `class` and its tariff link land with the IPD cluster, not as a column on the registry.
- Master-data change control is its own phase, scheduled after the IPD cluster, and it cannot be scheduled
  before runbook O1 closes.

## Why

Governance of master data with one administrator is theatre (runbook O1 is what ends that).

## Consequences / how to apply

- The registry (`resources` + `resource_status_history`, kernel tables) replaced `opd_rooms`, which was dropped.
- The kind seam is OPEN for status vocabularies and for claiming a kind, and CLOSED for the set of ten kinds.
  `theatre` and `device` need no kernel edit; an eleventh kind needs a kernel change, a migration and a parity test.
- The worker's `ModuleRegistry` does not call `collectResourceKinds` (the API does). A manifest that claims a kind
  and is installed in the worker boots without the duplicate-kind refusal; fix that in the phase that adds one.
- `updateRoom({active:true})` forces the kind's `initial` status; the `active` toggle has to go when the registry
  gains a second writer.
