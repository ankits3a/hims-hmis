# Plan kernel-D — The `documents` kernel component: chrome, snapshot, number, code, verification

**Written 2026-08-28 on the build host. NOT APPROVED FOR EXECUTION.** Four rulings were taken at write time and are recorded where they bite: **the document is a row and the body is stored at issue** (DD1, RULED); **as-of-encounter beats as-of-issue where R-01 and K3 disagree** (DD2, RULED); **the patient-held original carries the real name of a confidential patient** (DD6, RULED — Schedule H and the referral case; the alias is a protection against staff surfaces); and **the QR never carries the access code** (DD4, RULED). Everything else is locked in [`../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md`](../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md) §5.

**Roadmap:** Track C · the kernel document component the series named `kernel-D` (`00-RECORD-AND-PLAN.md` §6, §7) · gates **M4** and, more importantly, **Plans 17 and 18** — the two modules that would otherwise each invent their own chrome. **Spec:** [`../specs/2026-08-10-hmis-architecture-design.md`](../specs/2026-08-10-hmis-architecture-design.md) §6 (the patient master, copied by nothing — this phase is the one deliberate, versioned exception, and says why), §14 (confidential/VIP), §11.14 (retention). **Brainstorm:** `00-RECORD-AND-PLAN.md` §5A.3 (the verification portal) and §6 (the chrome gap); `01-MEDANTA-TEARDOWN.md` §2.1 (the chrome to copy) and §J (twelve chrome cases); `10-REMAINING-SEGMENTS.md` S9. **Review:** [`reports/2026-08-28-patient-self-service-review.md`](reports/2026-08-28-patient-self-service-review.md) §6 (why this phase is gated on 22c-A and absorbs its T6 surface conversion), G8, G9, G15, G18. **This plan argues from those and does not restate them.**

**Slot: gated on 22c-A** — the renderer reads `resolveIdentityAt` and `patient_identity_versions`, which do not exist before it. 07-IMPLEMENTATION-PLAN drew K3 ‖ K4; that was wrong and the review says why. **Recommended position: immediately after 22c-A, before 22c-B.** Nothing in 22c-B/C depends on this phase; Plan 17 does.

**Executor seed (v3 §1):** this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), ledger §5 (lines 1132–1146). **Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: 377,112 bytes ≈ 94,278 tokens, re-billed per tool call (v3 §9.1).** Entries that bite: §2.101, §2.115, §2.120/§2.121.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Seven tasks, one migration, no workflow definition, no approval band. It is a kernel seam — a table, a renderer, one public route — of the shape v3 §2 names as LIGHT's home. **Four CRITICAL:** the snapshot (the phase's reason to exist), the public lookup (a shared secret on the internet), the amendment/revocation grammar (immutability), and the conversion of the shipped surfaces (where the Medanta failure would be reproduced). The lane does not set verification depth (v3 §2).

Main session codes task by task under AGENT-RULES; mutants per rule 21; CI watched by full SHA with [`../pipelines/ci-watch-host.sh`](../pipelines/ci-watch-host.sh); reviewers **FRESH, not resumed** (v3 §9.5, ledger §2.115).

### Stop-loss (v3 §6): **690,000 tokens**, arithmetic shown — and the derivation is stated the honest way

For a LIGHT phase the only measured term is the reviewer: Plan 16a's "per-task rate" *is* one review pass divided by nine, and the series' docs say so. Counting it again as a task term is the same cost twice. So:

`stop-loss = 1.5 × (passes budgeted × measured per-pass)` — **`1.5 × 2 × 229,246 = 687,738 → 690,000`**, where 229,246 is Plan 14's mean fresh pass (`(244,568 + 213,923) / 2`, [`../pipelines/token-baselines.json`](../pipelines/token-baselines.json)). Two passes because immutability and a public secret are seams where 09a, 13 and 14 all found their worst defect in the *remediation*. Main-session cost stays unmeasurable (runbook **O3**). This lands within 2% of every number the series carries under the older derivation, so nothing is renumbered.

### Context budget (v3 §9.2)

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | measure at kickoff (`wc -c`) | ≈ 8,000 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only | ≈ 3,500 | 875 |
| `01-MEDANTA-TEARDOWN.md` §2 + §J only | ≈ 5,000 | 1,250 |
| `06-RULINGS-LOCKED.md` §5 only | ≈ 1,500 | 375 |
| **NOT pointed at:** the ledger in full | 377,112 | **94,278** |

---

## 1. Why this phase

### 1.1 The gap, in one sentence

`opdConfig.letterhead` is `{ name, addressLines[] }` and it is consumed ad hoc by two files. There is no document number, no verification code, no shared header or footer, no authorship block, no amendment grammar, and — the one that matters — **no rule about which demographics a document renders.** Every printing module to come (lab, imaging, discharge, certificates, statutory registers) currently has to invent all of it, and the department series' lab document already sketches its own report face.

### 1.2 The failure this phase exists to make impossible

A competitor's own reports print **one patient's age three different ways across one episode** (`01-MEDANTA-TEARDOWN.md` P1): the OPD note computes age at print time, the lab and radiology reports at encounter time, and the handwritten sheet says a fourth thing. Every one of those subsystems believed it was correct. The defence is not a rule that callers are trusted to follow; it is **a renderer that cannot read the live patient row**. That is DD1.

### 1.3 What this phase does not do

No new print *content* — the e-Rx and the invoice keep their bodies; they gain the chrome, a number, a code and the snapshot. No server-side PDF unless S1 says the browser cannot count pages (DD8). No lab or imaging document types — they are M5's, on this component. No patient-facing screen — M4's. No statutory hash-footer prints — 28a's (index §4 theme 17), which will consume this component rather than replace it.

---

## 2. Ground truth — measured on this host, 2026-08-28, and **re-measure it at kickoff** (AGENT-RULES §6)

| fact | value | how / consequence |
|---|---|---|
| migrations on disk | **36** (`0000`–`0035`); the series has claimed `0036`–`0040` for 22c-A/B/C and 22a-1/2 **in that order** | `ls apps/core/drizzle/*.sql \| wc -l`. **The number this phase writes is whatever is free at kickoff** — if it executes right after 22c-A as recommended, it is `0037` and the series' later numbers shift by one; the numbers are labels, not facts |
| the letterhead | `letterheadSchema = { name, addressLines[] }` | `modules/opd/config.ts:29`; read by `prescriptions.ts:543` and `billing.controller.ts:427` — **the only two consumers** |
| print surfaces, server | `RxPrintData` (`opd/prescriptions.ts:509-526`, `getPrescriptionPrint` at :528, `user_actor_required` at :529) · `InvoicePrint` (`billing/billing.controller.ts:354-361`, route `GET invoices/:id/print` at :421) | **Two.** Nothing else prints. Both compute `patient` from `getPatientSummaries` at render time — the live read DD1 removes |
| print surfaces, web | `rx-print.tsx` 120 lines · `invoice-print.tsx` 113 · `token-slip.tsx` 62 · `qr-card.tsx` 31 | `apps/web/src/components/`; the `.print-doc` isolation rule at `styles.css:147-150`, **A5 portrait, 148 mm** |
| age helper | `ageYearsAt(dob, at)` | `opd/time.ts:48` — J2's "one helper" exists; the e-Rx already calls it with `issuedAt` |
| QR today | HMAC under `SECRET_KEY`: `bil1.invoice.<id>.<sig>` (`billing.controller.ts:429-436`), the e-Rx payload via `buildRxQrPayload`; `hmacSign`/`hmacVerify` at `kernel/crypto.ts:30-35` | The QR is **authentication of the paper**, not access to the original. This phase keeps that and adds the second thing |
| wrong-QR audit precedent | `qr.signature_failed` event, reasons `malformed \| invalid_signature \| stale_version \| unknown_prescription` | `opd/events.ts:142-146` — the shape T4's `document.lookup_failed` copies |
| revocation precedent | `patients.qr_version` — *"reissue increments; old cards fail the scan"* | `schema/patients.ts:76` ⇒ **DD5** |
| number series | `EPISODE_SERIES = V A L S R P GRN D`; `formatEpisodeNo` pads **4 digits**, cap **9,999/day**, one multi-letter exception (`GRN`) with its reason stated | `kernel/episodes/series.ts` ⇒ **DD3** |
| entered-in-error vocabulary | `entered_in_error_marks.doc_type ∈ invoice \| receipt \| credit_note` | `schema/billing.ts:264` — money documents void by mark; **clinical documents amend by reissue** (DD7) — two grammars, deliberately |
| confidential rendering today | `rx-print.tsx:47`: `name = restricted ? alias : name` | The shipped e-Rx prints the **alias** to any printer without `patients.confidential.read` ⇒ **DD6** |
| `@Public()` routes today | `auth.controller.ts:126,144,162` + `health.controller.ts:22` — each auth route throttled | T4's seam |
| throttle | `auth_throttle(kind, subject)`, kinds `login \| pin`, backoff not lockout, **keyed on the submitted string so the 429 cannot enumerate** | `kernel/auth/throttle.ts` header ⇒ T4 adds kind `doc_code` keyed on the submitted document number |
| server-side PDF | **none** — no `pdf`, `puppeteer`, `playwright` in either `package.json`; `qrcode.react ^4.1.0` on the web only | ⇒ S1, DD8 |
| test DB groups | tables with an FK into `patients` join the patients truncate statement in `test/helpers/db.ts` (ledger §3.12) | T1 registers `documents` there |
| blob precedent | `patient_photos` as `bytea`, cap 512,000 bytes in code | `schema/patients.ts:7-10, 102` — the body is jsonb, not bytes; nothing binary is stored here |

---

## 3. Spike — questions written now, answered at kickoff, recorded in §6.3

| # | Question | Why it changes the work |
|---|---|---|
| **S1** | **Does the deployed browser's print path render `Page x of y` with CSS paged media (`counter(page)` / `counter(pages)`) on a two-page `.print-doc`?** Test on the actual desk browser, not Chrome-latest | If no, DD8's fallback (no total on browser prints) ships and server-side Chromium becomes a named follow-up with an ops cost; if yes, J4 is free |
| **S2** | How many prescriptions and invoices exist in production, and how many were **reprinted**? (`opd_prescriptions` count; invoice print has no counter — say so) | Sizes DD9's no-backfill decision: pre-phase documents verify by the shipped HMAC QR only, and the answer says how many papers that covers |
| **S3** | Which roles hold `patients.confidential.read` in production? | DD6 changes who sees a real name on a staff reprint; the count is the blast radius |
| **S4** | What is `resolveIdentityAt`'s cost at issue time under the 22c-A version table — one indexed read? | The snapshot is taken on every issue; a slow resolver slows every print at the desk (I7: not one second slower) |
| **S5** | Does `retention/sweep.ts` (events partitions) ever drop anything a `documents` row references? | Expected no — documents reference module rows, not events; record it so M4's "the link dies with retention" (S9-20) is designed against fact |
| **S6** | Does the web's i18n (`react-i18next`) already carry a gender formatter, or do screens format `sex` ad hoc? | J3: one formatter. If several exist, T3 deletes them |

---

## 4. Design decisions

**DD1 — RULED: a document is a row, and its body is stored at issue.** `documents(id, doc_no, doc_type, version, supersedes_id, status, patient_id FK, encounter_ref text, issued_at, issued_by, identity_snapshot jsonb, body jsonb, authorship jsonb, accreditation text null, sealed boolean, code_hash, code_version, revoked_at)`. The renderer takes a `documents` row and **nothing else** — it has no database handle to `patients`. That is what makes R-01/K3 a property rather than a convention: a renderer that cannot read the live row cannot print today's name on last year's report. The body is the module's own render model (the e-Rx lines, the invoice lines), captured at issue, immutable after (the `receipts`/`allocations` trigger precedent). Spec §6 says nothing copies the patient master; this is the one deliberate exception, versioned, and the reason is §1.2.

**DD2 — RULED: as-of-encounter, not as-of-issue.** R-01 says as-of-issue; the documents section of the locked register and K3 say as-of-encounter. They differ when a name is amended between the encounter and the issue — a report authorised three days after collection. The document describes the person who was *seen*; `identity_snapshot = resolveIdentityAt(patientId, encounter.openedAt)` (22c-A T6), or `issued_at` when the document has no encounter (a receipt for an advance). A reprint after a later amendment adds the annotation *"current name: …"* from the live row, in the chrome, never in the body — the one live read, and it is labelled as such.

**DD3 — Document numbers are a series, `document: "DOC"`.** The document number is the chrome's number, distinct from the business number the body carries (invoice no, visit no). It is what an outside doctor types into the portal and what MRD files by. `EPISODE_SERIES` gains `document: "DOC"` — the second multi-letter prefix, on the `GRN` entry's own rule: every single letter names a clinical document *type*; this is the cross-cutting wrapper of all of them, and `D` is taken. `DOC2608280042` parses exactly as `V2608280042` does.

**DD4 — RULED: the QR never carries the access code.** The QR encodes the portal URL and the document number — and, for the two shipped types, keeps the existing HMAC payload beside it. The eight-digit code is printed *next to* the QR, as the competitor does, and typed. A photographed QR alone therefore grants nothing; the paper — QR *and* code — is the credential. Codes are CSPRNG, stored as `HMAC(secret, doc_no ‖ code_version ‖ code)`, never in clear, and the printed one is shown once at issue and on reissue.

**DD5 — Revocation is a version bump; a revoked code answers exactly as a wrong one.** `code_version` increments on reissue (the `qr_version` precedent); the old code fails. The portal's response for *wrong code*, *revoked code*, *unknown document* and *sealed document* is **one response** — the `auth_throttle` enumeration property applied to documents. The audit event distinguishes them; the caller cannot.

**DD6 — RULED: the patient-held original of a confidential patient carries the real name.** The alias exists to protect a staff-as-patient or a VIP from *colleagues and screens*. It is not a protection against the patient, and a prescription in the name `P-4821` cannot be filled at a chemist (Schedule H requires the patient's name) nor can a referral in an alias be acted on. So: the **patient-held copy** (issued to the patient, or retrieved by code) renders the real name; a **staff reprint** without `patients.confidential.read` renders the alias, as `rx-print.tsx:47` does today; a **sealed-class** document (`sensitiveContext`) never leaves the portal at all (DD5 shape). The row stores both name and alias in the snapshot; the chrome chooses by `audience ∈ patient | staff | verification`.

**DD7 — Clinical documents amend by reissue; money documents void by mark.** Two grammars already exist and this phase keeps both: `entered_in_error_marks` for invoice/receipt/credit note (Plan 08), and **reissue marked AMENDED** for everything clinical — a new row, `version + 1`, `supersedes_id`, a `reason_class` enum (series R-018), the old row `status = 'superseded'`. The old paper's code **still resolves** to v1 with a supersession banner naming v2's date (review G18) — the holder has the paper; hiding v1 protects nobody.

**DD8 — No server-side renderer in this phase.** The chrome is a server-produced **render model** (`{ chrome, zones, body, footer }` as JSON) and one web component, `DocumentFrame`, that prints it under the shipped `.print-doc` rule. Page x of y comes from CSS paged media if S1 says the desk browser can; otherwise the footer prints *"Page x"* without a total and server-side Chromium becomes a named follow-up with a cost. **Do not add a PDF dependency on the strength of a plan sentence.**

**DD9 — No backfill.** Documents printed before this phase have no row. They verify by the HMAC QR they already carry (the shipped `verifyQrScan` / `bil1` paths, unchanged). The portal says *"issued before document verification was available"* for a well-formed pre-phase HMAC and nothing at all for anything else.

**DD10 — Formatting is one module.** `formatGender`, `formatAge` (from `ageYearsAt` at the encounter date, never `now()`), `formatDate` (IST), and the null rule (em-dash, never the string `null` — J5). Three functions, one test file, deleted from every screen that had its own.

**DD11 — Zone C is typed, and the accreditation slot is data.** `doc_type` selects the third header zone: `encounter` (visit no, type, date, department, doctor) for clinical notes; `money` (invoice/receipt no, service day, payer) for billing; `specimen` and `study` are **declared here as types with no issuer** so Plan 17/18 fill a slot rather than add a zone. `accreditation` is a string the issuing module passes (`NABL MC-…`) or null; the chrome renders it only when present. Today nothing passes it.

**DD12 — The authorship block is three optional triples.** `performed / prepared / authorized`, each `{ at, userId, displayName }` captured at issue. The e-Rx fills `authorized` (the prescriber); the invoice fills `prepared` (the cashier). The competitor's radiology block is the model and it renders whatever is present, in that order, never a blank line.

---

## 4A. ROUTED TO THE OWNER — provisional, and named

**None blocks kickoff.** DD6 changes what a confidential patient's own copy prints — the owner should know, because it reverses a shipped behaviour that was itself deliberate (Plan 07's alias-on-print). The argument is Schedule H and the referral case; the default stands unless overruled. S1's answer may add *server-side Chromium* to a future phase as an ops cost — a rupee-adjacent note, not a decision here.

---

## 5. Tasks

Seven. Four CRITICAL.

### T1 — Migration: `documents`, `document_retrievals`, the series key, the throttle kind — **ROUTINE**

`documents` per DD1 with the immutability trigger set on `body`, `identity_snapshot`, `authorship`, `issued_*` (status, `code_hash`, `code_version`, `revoked_at` remain writable — they are the lifecycle). `document_retrievals(id, document_id, at, outcome, ip_hash, channel)` — append-only. `EPISODE_SERIES.document = "DOC"`. `auth_throttle` kind `doc_code` (data). Register `documents` and `document_retrievals` in the patients truncate group (§3.12).

**Files:** `kernel/db/schema/documents.ts` (new), `kernel/db/schema/index.ts`, `kernel/episodes/series.ts`, `apps/core/drizzle/<next>_*.sql`, `test/helpers/db.ts`.

### T2 — `issueDocument` and the snapshot — **CRITICAL**

`issueDocument(tx, actor, { docType, patientId, encounterRef, encounterAt, body, authorship, accreditation })` → allocates `doc_no`, takes `identity_snapshot = resolveIdentityAt(patientId, encounterAt ?? now)`, mints the code, stamps `sealed` from `patients.sensitive_context` **at issue**, writes the row in the caller's transaction, emits `document.issued`.

#### Assertion Book — T2

| # | Assertion | Mutant |
|---|---|---|
| A1 | The snapshot is taken from `resolveIdentityAt(patientId, encounterAt)`, never from `patients` | Read `patients.name` → **the Medanta failure**: a reprint after an amendment shows today's name |
| A2 | Age in the snapshot is computed at `encounterAt`, not at issue and not at print | Compute at `now()` → P1 exactly: 49 on the lab report, 51 on the note |
| A3 | The document row commits in the caller's transaction | Issue in a separate transaction → a rolled-back prescription leaves a numbered, coded document for a prescription that does not exist |
| A4 | `sealed` is stamped at issue from `sensitive_context` and never re-read | Read it at lookup → a later un-sealing exposes a document issued under seal, or vice versa |
| A5 | The code is CSPRNG, eight digits, stored only as a keyed hash | Store in clear → every code in the database is one `SELECT` from a leak |
| A6 | Two issues in one IST day take distinct, ascending `DOC` numbers under contention | Read-then-write the serial → two documents, one number |

### T3 — The chrome: render model, `DocumentFrame`, formatters — **ROUTINE**

The three-zone header (identity from the snapshot; Zone C by `doc_type`, DD11), the department band, the standard footer (facility, regd. office, emergency number, CIN, *printed by* + timestamp, page), the authorship block (DD12), the amendment annotation and the *current name* line (DD2), the AMENDED banner (DD7). DD10's formatters, and the deletion of every ad hoc one S6 finds. **The frame has no data access**: its input is a `documents` row plus `{ audience, printedBy, printedAt }`.

*Not CRITICAL, but pinned:* a test that renders a fixture whose snapshot name ≠ live name and asserts the body shows the snapshot and the chrome shows the annotation — the §9.4 fixture rule (name the field whose value equals another's, and write the leg where they differ).

### T4 — The public verification lookup — **CRITICAL**

`GET /verify/:docNo` (`@Public()`, renders the entry form and nothing about the document) · `POST /verify/:docNo` with the code (`@Public()`, throttled by `doc_code` on the submitted number). Success returns the render model with `audience = 'verification'`; every failure returns **one** response (DD5). Every attempt writes `document_retrievals`; failures also emit `document.lookup_failed { reason }` (the `qr.signature_failed` shape).

#### Assertion Book — T4

| # | Assertion | Mutant |
|---|---|---|
| A7 | Wrong code, revoked code, unknown number and sealed document return byte-identical responses and status codes | Branch the message → the portal confirms that a document exists, or that a patient is in a sealed class |
| A8 | The throttle is keyed on the submitted document number, existing or not | Key on real rows only → the 429 enumerates document numbers |
| A9 | A sealed document is never returned, even with the correct code | Check `sealed` only on the form step → the code that was printed before sealing opens it |
| A10 | Code comparison is constant-time over the hash | `===` on the raw string with an early return → a timing oracle on a 10⁸ space |
| A11 | A successful retrieval is logged with the outcome, and the log row commits even if rendering fails | Log after render → a crashed render is an unlogged disclosure |
| A12 | The response with `audience='verification'` carries the snapshot, never the live row | Join `patients` in the lookup → an amended name leaks through the portal |
| A13 | A pre-phase HMAC QR resolves to DD9's sentence and nothing else | Try to resolve it to a document → a forged pre-phase payload probes the table |

### T5 — Amendment, reissue, revocation — **CRITICAL**

`amendDocument(tx, actor, documentId, { reasonClass, body, authorship })` (DD7) · `reissueCode(tx, actor, documentId)` (DD5) · `revokeCode`.

#### Assertion Book — T5

| # | Assertion | Mutant |
|---|---|---|
| A14 | An amendment is a new row with `version+1` and `supersedes_id`; the original's body is untouched | Update the original's body → NABL's "original retained" is violated and the paper in the patient's hand no longer matches anything |
| A15 | The old code resolves to v1 with the supersession banner | Refuse v1 → the holder of a real paper is told it does not exist |
| A16 | Reissuing a code invalidates the previous code in the same statement | Two-step update → a window with two live codes |
| A17 | `reason_class` is an enum; free text is refused | Accept a string → the amendment register cannot be summarised (R-018) |
| A18 | The immutability trigger refuses an UPDATE to `body`, `identity_snapshot`, `issued_at` | Drop the trigger → an "as issued" document is editable |

### T6 — The two shipped surfaces issue through `documents` — **CRITICAL**

`getPrescriptionPrint` and `GET invoices/:id/print` become *readers of a document row*: the e-Rx issues at `prescription.issued` (in that transaction; a reprint reads the row), the invoice at `invoice.issued`. `RxPrintData`/`InvoicePrint` become `{ document, renderModel }`; `rx-print.tsx` and `invoice-print.tsx` render through `DocumentFrame` with their bodies inside it. **This is 22c-A T6's surface conversion, moved here** so each surface is converted once, to the chrome, not first to a resolver call and then again to the chrome; 22c-A T6 keeps the resolver and its as-of test (A19–A23) on a fixture.

#### Assertion Book — T6

| # | Assertion | Mutant |
|---|---|---|
| A19 | An e-Rx reprinted after a name amendment shows the name as issued plus the annotation | Read live → the phase's entire purpose is defeated and nothing fails loudly |
| A20 | The receipt/invoice for an **advance** (no encounter) snapshots at `issued_at` | Require an encounter → the first online prepayment (22a-1) cannot issue a receipt document |
| A21 | The patient-held e-Rx of a confidential patient carries the real name; the staff reprint without the permission carries the alias (DD6) | Alias everywhere → an unfillable prescription; real name everywhere → the alias is defeated on every desk printer |
| A22 | Issuing the document is inside `issuePrescription`'s / `issueInvoice`'s transaction | Issue after commit → a prescription with no document, or a document with no prescription, on a crash |
| A23 | The web print of either surface contains exactly one `.print-doc` | Two frames → both reach the paper (the TokenSlip precedent) |

### T7 — Routes, the reprint surface, and the e2e — **ROUTINE**

`GET /documents/:id/render?audience=` (staff, permissioned by the owning module's read permission) · a reprint action on the patient-detail and billing screens · the e2e: *issue → amend name → reprint → as-of-encounter asserted → verify by code on the public page → revoke → old code fails identically to a wrong one*.

---

## 6. CLOSE

*(Filled by the executing session.)*

### 6.1 The commits
### 6.2 Findings
### 6.3 Spike answers S1–S6 — especially S1 (page totals) and S3 (DD6's blast radius)
### 6.4 The Assertion Book, corrected by execution
### 6.5 Mechanical verification
### 6.6 The independent close review
