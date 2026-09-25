# ABDM connector — plan (2026-09-25)

**Owner instruction, 2026-09-25:** "build the whole ABDM thing without the credentials."
The connector is built to ABDM's current (V3) APIs, tested against an in-process fake gateway, and
**off** until the credentials exist. Until then the counter behaves exactly as today: it can
*record* an ABHA the patient reads out (`self_declared`) and cannot create or verify one.

Spec research, with every source and every UNVERIFIED item: `/opt/hmis-context/reference/abdm/abdm-spec-summary.md`
(outside the repo — it holds third-party material we do not redistribute).

## 1. What is trusted, and what is not

| Source | Use |
|---|---|
| NHA's official wrapper, `github.com/NHA-ABDM/ABDM-wrapper` (V3 profile) | **Authoritative** for paths, headers, flows |
| NRCeS FHIR IG v6.5.0 (`nrces.in/ndhm/fhir/r4`) | **Authoritative** for the FHIR bundles |
| `github.com/nha-in/docs` — the most detailed V3 OpenAPI set | **Untrusted.** Org created 2026-08-25; homepage field `docs.abdm.gov.om` (Oman TLD). Its paths match the official wrapper, so it is used as a *cross-check only*; nothing from it is executed, and a detail found only there is marked UNVERIFIED in code and confirmed on the sandbox portal before go-live |
| Open-source Care connector (`10bedicu/care_abdm`), fidelius-cli | Third-party working code; used to cross-check behaviour and the crypto test vector |

## 2. Two go-live blockers found now, not later

1. **`*.abdm.gov.in` answers HTTP 403 (CloudFront) from this server** — sandbox, portal and gateway
   alike; it looks like geo-blocking. If the production box is blocked too, the connector cannot
   reach the gateway even with credentials. The first sandbox login proves it either way; the
   remedy, if needed, is network-side (an Indian egress address), not code.
2. **Callbacks must reach us over public HTTPS.** They arrive at `https://hmis.crkmch.com/api/abdm/…`
   (the existing `/api/*` path space) and are authenticated by ABDM's RS256 JWT, not by our login.

## 3. Slices — one PR each, in order

**S0 — foundation (no patient data moves).**
- Config: gateway + ABHA base URLs, client id/secret (env only, never logged), `X-CM-ID`
  (`sbx` | `abdm`), the HFR facility id (HIP id), the callback base URL. `configured` only when
  every required value is present; otherwise every ABDM route answers 503 "ABDM not configured".
- Gateway client: `POST /gateway/v3/sessions` token cache (read `expiresIn`, refresh 30 s early,
  drop on 401); headers on every call (`REQUEST-ID` UUID, `TIMESTAMP` ISO-ms-Z, `X-CM-ID`,
  `Authorization`, and `X-HIP-ID`/`X-HIU-ID` per call); fetch injectable for tests.
- Callback authentication: RS256 JWT in `Authorization`, verified against the gateway's
  `/gateway/v3/certs` JWKS with `node:crypto` (no new dependency); keys cached 24 h, refetched once
  on a failed check; audience configurable (`account` per the Care connector — UNVERIFIED).
- The message log: every outbound request and inbound callback, keyed by `REQUEST-ID`
  (de-duplicates ABDM's retries), correlated by `response.requestId`, PHI-restricted.
- Callback routes: accept, verify, log, 202, and dispatch to a handler registry the later slices fill.
- Operator CLI: register the bridge (callback) URL (`PATCH /gateway/v3/bridge/url`) once credentials exist.
- **Fix found in research:** today a counter request can set `abhaVerificationStatus: "verified"`
  (`registerPatient` stores what the client sends). Only ABDM answering may set `verified`; the
  counter routes refuse it.

**S1 — M1 (ABHA at the counter).** Verify an existing ABHA number/address by OTP; create an ABHA by
Aadhaar OTP (Aadhaar and OTP RSA-encrypted with ABDM's public key; the Aadhaar number is never
stored); fetch the profile and card; set `verified` from ABDM's answer only. Scan-and-share: the
facility QR, the share-profile callback → a pre-filled registration and the token reply.
**Owner rulings pending** (built, switched by config, default OFF until ruled): Aadhaar-based
creation at the counter.

S1 as built (primary M1 reference: the Care connector; `nha-in` a cross-check only; every endpoint
is listed UNVERIFIED in `modules/abdm/abha-client.ts`):
- **DECIDED — no new permission.** The steps ride `patients.register` (the counter's own ABHA
  capability route); the two links ride `patients.update` (the permission `PATCH /patients/:id`
  needs for the same columns).
- **DECIDED — ABDM's tokens stay in memory.** The browser holds an opaque handle; ABDM's txnId and
  the patient's X-token live in the api process for 15 minutes, never in a table (one api process).
- **DECIDED — ABDM-verified name, birth and gender are authoritative** (NHA's M1 FT workbook: "set as
  non-editable"). The link shows the differences first and needs the clerk's acceptance, then takes
  ABDM's values through the amendment path (`acceptAbdmDemographics`: a Class I version, the audit,
  evidence `abdm_verified`), then `recordAbhaVerifiedByAbdm` stamps the ABHA. While `verified`,
  name/DOB/gender refuse an amendment (`abha_demographics_locked`, 409) — re-verify, or take the
  verification down first in its own amendment. Mobile and address stay editable. Identity
  assurance is neither raised nor dropped by it.
- **DECIDED — one ABHA, one patient** (FT TAGGING_UNIQUEPATIENTID_UNIQUEABHANUMBER): partial unique
  indexes on the ABHA number's digits and the lower-cased address over ACTIVE patients; registration,
  amendment, verification, share-link and unmerge all refuse a duplicate (`abha_already_linked`,
  409), naming the holder's UHID only to a user with `patients.read` who may see that record.
- **DECIDED — re-send** 60 s after the last OTP, at most twice (FT CRT_ABHA_106); an Aadhaar OTP is
  re-sent with the number typed again — it is kept nowhere. Find-by-Aadhaar rides the create switch.
- **DECIDED — scan-and-share tokens** are per facility per IST day from 1, 1800 s (Care's default);
  a re-scan by the same ABHA address keeps its token. A share with no ABHA number links the share
  and stamps nothing.
- `ABDM_ABHA_CREATE_AADHAAR` (default `false`) is the create switch; while off, create answers
  403 `abha_create_disabled` and the counter does not draw the button.

**S2 — M2 (the hospital shares its records).** Care-context linking (HIP-initiated with a link
token; patient-initiated discovery/link callbacks); context notify after each visit; consent
notification; the health-information request → FHIR bundles per NRCeS IG v6.5.0
(OPConsultRecord, PrescriptionRecord, DiagnosticReportRecord first) → Fidelius encryption →
push → transfer notify. **Crypto decision owed in S2:** the Fidelius curve is Curve25519 in
Weierstrass form; the research proved the published test vector with `node:crypto` + BigInt, which
is not constant-time — S2 chooses a vetted constant-time implementation before any real data moves.
**Owner rulings pending:** which records are shared; the consent-release policy.

**S3 — M3 (the hospital fetches records, with consent).** Consent request create/status/artefact;
health-information request; receive the push, decrypt, and show the records in the consult's history.

**S4 — Functional Testing (FT) readiness** (owner, 2026-09-25: "Functional Testing … take care of
these"). ABDM's FT / sandbox exit is *run by NHA or an NHA-empanelled tester* on the sandbox with our
credentials — we cannot pass it for ourselves. What we own: an FT test-case matrix (every M1/M2/M3
case → the feature that satisfies it → the automated test that proves it → the evidence the tester
needs), a sandbox run-book, and evidence capture from `abdm_messages`. Draft matrix and run-book:
`/opt/hmis-context/reference/abdm/ft/`.

**S5 — WASA readiness** (owner, 2026-09-25: "WASA certification"). The Web Application Security
Assessment certificate is issued only by a **CERT-In-empanelled auditor**; engaging one is
procurement, so the owner's. What we own: an OWASP Top 10 / ASVS L2 self-assessment of the whole
HMIS, fixes for its findings (each its own PR), and the evidence pack an auditor asks for (scope
URLs, role matrix and test users, architecture and data-flow, security-event logging). Draft
assessment: `/opt/hmis-context/reference/wasa/`.

## 4. Owner rulings still open (law / money)

1. Scope and order — this plan assumes M1 → M2 → M3.
2. ABHA creation by Aadhaar OTP at the counter — built, OFF by config until ruled.
3. Which records are shared under M2 — assumed: OPD prescription, lab reports, radiology reports.
4. Consent release — assumed: automatic release exactly matching the patient's ABDM consent, every release logged.
5. DHIS (the incentive scheme) — money; not built.

## 5. Owner actions owed (nobody else can do them)

HFR facility id; HPR ids for doctors; sandbox client id + secret (sent privately, placed only in the
production environment file); a named ABDM nodal officer; confirming the callback URL; booking the
sandbox functional test with NHA; **engaging a CERT-In-empanelled auditor for WASA** (procurement);
signing the undertakings the exit process asks for.
