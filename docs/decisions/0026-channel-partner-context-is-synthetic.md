# 0026 — Channel-partner planning uses a synthetic book; real terms arrive as configuration

- **Date:** 2026-08-25   **Status:** Ruled
- **Area:** partners (Plan 09), commissioning

## Decision

- The owner will NOT supply real channel-partner cases or terms for planning.
- A fully synthetic partner book stands in: the same shapes (partners, agreements in both directions, product
  catalogue, holder-book CSV, CA/counsel register) with invented content.
- Real terms arrive as configuration or import files at commissioning.

## Why

Partner terms are commercial data the owner keeps out of the build; the build needs only their shape.

## Consequences / how to apply

- Any value from the synthetic book that appears hard-coded under `apps/` is a defect.
- The synthetic files live outside git under `/opt/hmis-context/` (`plan-09-channel-partners-2026-08-23.md`,
  `plan-09-brainstorm-2026-08-25.md`); never commit them.
- Only the substitution itself is a ruling. The brainstorm's strategies and its rulings O-1..O-9 are PROPOSED, not
  ruled.
