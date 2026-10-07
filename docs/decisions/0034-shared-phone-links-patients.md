# 0034 — Patients who share a mobile number are shown as linked on each other's record

- **Date:** 2026-09-13   **Status:** Ruled
- **Area:** patients, privacy

## Decision

- Owner: when two patients list the same mobile number, each record must name the other as a linked family patient.

## Why

A family registers under one phone; the desk needs to see the household from either member.

## Consequences / how to apply

- Built as FD-34 (PR #185): the link is DERIVED at read time from `patients.phone` / `alt_phone`
  (`modules/patients/linked.ts`, `GET /patients/:id/linked`, shown under "Linked patients" on `/patients/:id`).
  No stored edge and no households table; a stored edge would go stale when a number is corrected on one side.
- The record says **"shares a contact number"**, never a relationship.
- Carried rules (DECIDED): the §14 seal filters both the list and its total; merge chains resolve on both sides; the
  list caps at 20 with the true total shown; staff actors only, never a patient actor; one `patient.linked` PHI
  access row per non-empty read.
- A real households table remains Plan 22c-B, gated on the patient app's consent classes.
