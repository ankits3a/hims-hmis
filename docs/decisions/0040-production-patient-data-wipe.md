---
type: decision
id: "0040"
title: "Production patient data was test data: copy it to staging exactly, then wipe it from production"
description: "Production patient data was test data: it was copied exactly to staging and then every patient-linked row was deleted from production."
generated: { by: agent:claude, at: 2026-09-30 }
verified: []
status: stable
ruling: ruled
tags: [data, privacy, staging, production]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0040 — Production patient data was test data: copy it to staging exactly, then wipe it from production

- **Date:** 2026-09-30   **Status:** Ruled
- **Area:** data, privacy (DPDP), staging, production

## Decision

- Owner: every patient record in production up to 2026-09-30 was test or demo data.
- Copy production (users and data) to staging as an **EXACT copy**; the DPDP risk of real-looking data on staging is
  accepted.
- Then delete every patient-linked row from production, including bills, receipts and pharmacy sales. Users and
  their role assignments are kept.

## Why

Go live with a clean patient book while staging keeps realistic data to test against.

## Consequences / how to apply

- Done 2026-09-30 after a full backup and a dump kept under `/opt/hmis-prod/ops/`; the wipe script is
  `/opt/hmis-prod/ops/2026-09-30-prod-patient-wipe.sql`.
- Residue deliberately not cleaned: stock stays decremented by test sales; cashier sessions and daily closes keep test
  totals; patient photo and document files are orphaned on disk; bill number series continue.
- Staging data is a production copy: resetting the staging database (for example when staging returns from a lane
  carrying a migration) destroys it.
