# 0007 — Pharmacy desk: P-number at queue time; the doctor authorises dispensing against an allergy

- **Date:** 2026-09-19   **Status:** Ruled
- **Area:** pharmacy

## Decision

- **PD-2:** each pharmacy ticket gets its P-number when it is QUEUED, not at verify.
- **PD-9:** the DOCTOR (not a senior pharmacist) must authorise dispensing against a recorded allergy.
- **Standing instruction** for the phase's other open decisions (C7 money checks, PD-D19 old/new MRP, PD-D22 patient
  GSTIN on the bill, the counter redirect): *"claude, follow what is logical and always fallback to top hospital
  standards."* Decide, mark DECIDED in the phase doc, build. (The owner later ruled PD-D19 and PD-D22 directly — see
  0012.)
- No deploy without the owner's command: *"Once all the decision task is done, wait for my command to deploy as
  another session is also working on a module."* A deploy command covers one deploy; a further deploy needs a fresh
  command.

## Why

The owner rules on money, procurement and law; everything else defaults to the standard Indian corporate hospital
answer, and here the owner said so explicitly.
