# 0038 — Build the whole ABDM connector now, without credentials, and prepare for FT and WASA

- **Date:** 2026-09-25   **Status:** Partly open
- **Area:** abdm, security, procurement

## Decision

- Owner: build the whole ABDM connector without the credentials.
- Owner, same day: *"ABDM M1, M2 & M3 API integration, Functional Testing (FT), WASA certification … take care of
  these while working on ABDM."*
- Scope therefore: M1 (ABHA), M2 (HMIS as HIP: FHIR records, encrypted release within a consent), M3 (HMIS as HIU),
  plus FT readiness (test-case matrix, run-book, evidence capture) and WASA readiness (OWASP Top 10 / ASVS L2
  self-assessment, a fix PR per finding, evidence pack).

## Why

The credentials and the sandbox come later; the code, the test evidence and the security fixes do not need to wait
for them.

## Consequences / how to apply

- The connector stays off, answering 503, until configured.
- FT itself is run by NHA or an empanelled tester, and a WASA certificate comes only from a CERT-In-empanelled
  auditor (engaging one is procurement, so the owner's). Never claim FT has been passed or that a WASA certificate
  exists.
- Only an ABDM answer may set a patient's ABHA as verified; a client-sent "verified" is never stored.
- Spec research and the FT matrix live outside git under `/opt/hmis-context/reference/abdm/`; WASA drafts under
  `/opt/hmis-context/reference/wasa/`. Plan: `docs/superpowers/plans/2026-09-25-abdm-connector.md`.
- Aadhaar-OTP ABHA creation, MSG91 as the SMS sender, hosting and the synthetic WASA auditor were ruled the next day
  (0011).

## Open

- Owner rulings still owed: the order of scope, which record types are shared, the consent-release policy, and DHIS
  (money).
- Go-live needs an SMS sender with DLT registration (procurement) and ABDM's acceptance of the callback hosting.
