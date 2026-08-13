# Phase 1 / Plan 05 — Patient Master & Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the patient master (spec §6) and the registration desk — the first domain module (`src/modules/patients/`, spec §4) and the first UI (`apps/web`, spec §15). Backend: the `patients` table owned by registration with UHID generation (owner-set prefix + Verhoeff check digit), the D-30 ABHA field set, §14 confidential/VIP flag with alias, D-43 legacy-UHID cross-reference; phone-first search with the <300 ms budget CI-enforced (§15 + roadmap standing rule); photo capture storage (C-18's photo-prompt source); allergies with the E-8 entered-in-error correction grammar; the D-31 guardianship model (authority scope, validity, sensitive-context override, read-time majority enforcement + the fourth unscheduled sweep); approval-gated merge with snapshot-based unmerge (§11.5, wired through Plan 04's shipped engine); HMAC-signed QR cards with verify/reissue and `qr.signature_failed` on bad scans (D-23, consuming Plan 02's `kernel/crypto.ts`). Frontend: the `apps/web` React+Vite scaffold every later UI reuses (Tailwind 4, shadcn/ui, TanStack Router+Query, react-hook-form+zod, i18next Hindi/English, keyboard-first form kit, Vitest), with the registration desk (search-first, C-18 attach confirmation, photo capture, printed QR card), patient detail, merge review side-by-side, and a minimal approvals inbox (§8: approvers act in-app; Plan 04 shipped only the API).

**Architecture:** The patient master is a **module, not kernel** — `apps/core/src/modules/patients/` is the first real subject of the module-isolation lint rule shipped in Plan 01. Cross-module access is `index.ts` or events, nothing else (spec §4); later plans call `getPatient`/`searchPatients` from the module's `index.ts` and reference `patient_id` — **never copying demographics** (§6, roadmap trap). Tables live in `kernel/db/schema/patients.ts` following the shipped one-migration-dir convention; ownership is code discipline (only this module touches them), not file location. Merge is **check-on-execute**: `createMergeRequest` files a Plan 04 approval atomically on its own transaction (`requestApproval` is `Tx`-first for exactly this), and `executeMerge` verifies the approval row is `granted` before a single-winner conditional UPDATE — **not** an event consumer, because `runDispatchCycle` is unscheduled until Plan 11 and nothing would tick a subscription in production. Unmerge is its own approval type with `actFirstAllowed: true` — §11.5 calls a wrong merge a patient-safety emergency, and E-15 act-first-review-after is the shipped mechanism for that. Guardian majority is **read-time enforced** (the Plan 02 temp-roles pattern: a guardian of an 18-year-old is powerless the instant the birthday passes even if no sweep ever runs); `sweepGuardianMajority(db)` — the **fourth unscheduled sweep**, by owner decision 2026-08-13 Q4 — exists only to flip row status and emit `guardian.authority_changed`, and Plan 11 registers all four crons together. QR payloads are HMAC-signed under the existing `SECRET_KEY` with a per-patient `qr_version` so reissue revokes old cards (D-23); **this plan creates no crypto** (roadmap: Plan 02 shipped `hmacSign`/`hmacVerify`). `apps/web` is a static SPA (spec §5) talking to `/patients/*`, `/auth/*`, `/approvals/*`; it **rides the existing monorepo CI job with zero `.github` edits** (owner decision Q2): its typecheck runs under root `pnpm -r exec tsc --noEmit`, its Vitest suite under root `pnpm -r test`, its lint under the root `eslint .` pass.

**Tech Stack:** Backend adds **zero dependencies and zero env vars** (Verhoeff is ~30 lines hand-implemented; QR signing reuses `cfg.secretKey`). Frontend is the first dependency wave since Plan 01 (owner decision Q1): React ^19 · Vite ^7 · @vitejs/plugin-react ^5 · Tailwind ^4 (+ @tailwindcss/vite) · shadcn/ui (CLI-generated components + Radix deps) · @tanstack/react-router ^1 (**code-based routes** — no codegen plugin, no generated file) · @tanstack/react-query ^5 · react-hook-form ^7 + @hookform/resolvers ^5 + zod ^4 (deduped with the workspace) · i18next ^25 + react-i18next ^15 · qrcode.react ^4 · Vitest ^3 + Testing Library + jsdom ^26 — **confined to `apps/web`**; Jest and every shipped config stay untouched. `pnpm-lock.yaml` is committed with every dependency change (tripwire 12).

## Global Constraints (from spec v4.5 + roadmap standing rules + owner decisions 2026-08-13)

- TypeScript strict; no `any` anywhere (kernel rule extended to the module and the web app).
- **Catalog discipline: exactly NINE event names minted, all already in §10.6's reconciled catalog** — `patient.registered`, `patient.updated`, `patient.merged`, `patient.unmerged`, `guardian.linked`, `guardian.authority_changed`, `allergy.recorded`, `correction.entered_in_error` (E-8 grammar, pass-8 catalog), `qr.signature_failed` (pass-7 catalog) — `module: "patients"`, full §10.5 envelope via `defineEvent(...).make(...)` + `appendEvent`, `patientId` set on every patient-scoped emission. `patient.merged`/`patient.unmerged` carry `correlationId` = the backing approval's workflow instance id (§10.5: correlation = instance). ABHA field edits ride `patient.updated`; `abha.linked` is minted by the real ABDM linking flow in a later plan, not here.
- **Module isolation (spec §4):** all backend domain code under `src/modules/patients/`; the lint rule now has a real subject. The module imports kernel freely; nothing outside imports its internals — `AppModule` and tests import only from `modules/patients/index`. Later modules get `getPatient`/`searchPatients`/`resolvePatientId` from `index.ts` or consume events.
- **Additive-only over shipped code:** no file under `src/kernel/workflow/`, `src/kernel/auth/`, `src/kernel/events/`, `src/kernel/modules/`, or `src/kernel/approvals/` is modified. Shipped files modified, exhaustively: `src/kernel/db/schema/index.ts` (one re-export, T1) · `test/helpers/db.ts` (one new truncate statement, T1) · `src/app.module.ts` (T9) · `apps/core/package.json` (one script line, T2) · root `eslint.config.mjs` + root `package.json` + `pnpm-lock.yaml` (T11) · `apps/web/package.json` + `pnpm-lock.yaml` (T13, shadcn CLI adds Radix deps) · `README.md` (T10, T16). **`.github/workflows/*` is not touched by anyone** (owner decision Q2; tripwire 10 — an agent believing a workflow edit is needed must halt and report).
- **No new env vars.** QR signing uses the existing `SECRET_KEY` via `cfg.secretKey`. The UHID prefix is **data** (a `registration_config` row), not config: seeded by script argument (`UHID_PREFIX=... pnpm --filter @hmis/core seed:registration`, the `agent:create` precedent), owner-gated Class A at go-live, dev placeholder `HMS`. A missing config row **hard-fails** `allocateUhid` (`registration_not_configured`) — the no-fallbacks rule.
- **Migration `0006_*` is generated exactly once, in T1, via `db:generate`** — never hand-written, never regenerated by a later task. No Postgres extensions: search indexes are btree `text_pattern_ops` prefix indexes, a deliberate Phase-1 scope decision (pg_trgm/FTS arrive with MRD).
- **The `events` table schema is not touched** (partitioning is Plan 11).
- **Perf budgets are CI-enforced from this plan on** (roadmap global rule; owner decision Q7): T4's perf suite seeds 200k patients via one `generate_series` INSERT, asserts **median-of-5 phone search < 300 ms**, **median-of-5 `getPatient` < 100 ms** (the §15 interactive budget applied to the hot API), and — because a fast runner can sneak a seq scan under the budget — asserts via `EXPLAIN (FORMAT JSON)` that **no Seq Scan node touches `patients`** on the search query. The execution session additionally records one 1M-row server run in the gate report.
- **D-37 (roadmap trap):** the confidential/VIP flag affects privacy surfaces only — it must not appear in any ORDER BY, any queue logic, or any prioritization anywhere in this plan or its consumers. Search and `getPatient` hide confidential patients (404-semantics, existence-hiding) from callers lacking `patients.confidential.read`; the alias is for **public** surfaces (Plan 07 displays announce tokens only anyway) and is stored now, enforced there.
- **§6 (roadmap trap):** every later module references `patient_id` and never copies demographics. Merge therefore never rewrites other modules' rows: a merged patient's row is frozen (`status = 'merged'`, `merged_into_patient_id` set) and `getPatient`/`resolvePatientId` resolve through the chain (depth-capped); patient-master-owned child rows (allergies, guardians) move to the winner with their ids recorded in the request's snapshot so unmerge can restore them exactly.
- **Merge is approval-gated (§11.5) through Plan 04's shipped engine — no engine work.** Types `patient_merge` (routine) and `patient_unmerge` (urgent, `actFirstAllowed: true`) are registered as **data**: `approvalFlowDefinition` → Plan 03 `createDraft` → `activateDefinition` (Class C, drafter≠activator SoD applies) → `registerApprovalType`. Tests do this inline; production registration is a go-live runbook step (documented in T10) — **no seed script for types, no boot-time DB call** (EXECUTION-LESSONS §3.6: nothing new runs at boot).
- **Act-first semantics (E-15, shipped in Plan 04):** `executeUnmerge` proceeds when the unmerge approval is `granted` OR when the request was filed with `actedFirst = true` and is still `pending` — that is what act-first-review-after means. An after-the-fact rejection is a review outcome for humans, not a rollback path.
- **Single-winner concurrency (house pattern):** every state move is a conditional UPDATE discriminated on current state — merge execute (`requested` → `executed`), unmerge (`executed` → `unmerged`), loser-row freeze (`active` → `merged`), allergy correction (`active` → `entered_in_error`), QR reissue (version increment), guardian majority (`active` → `majority_ended`). The plan's race tests enumerate **every** loser code its own arbiter can produce (EXECUTION-LESSONS §3.13) — these are this plan's own error codes, fully controlled.
- **`sweepGuardianMajority(db, now?)` is the FOURTH unscheduled sweep** (owner decision Q4): idempotent, concurrency-safe via the status-discriminated UPDATE, DB-row-driven, **no scheduler of any kind** — Plan 11 registers it as a pg-boss cron alongside `runDispatchCycle`, `sweepExpiredTempRoles`, and `runDueTimers`. Correctness never depends on it: `effectiveGuardianAuthority` computes from DOB at read time.
- **Photos are bytea** (owner decision Q5): one current photo per patient in `patient_photos`, server-enforced cap 512,000 bytes, client downscales at capture. pgBackRest/replication/LUKS (Plan 11) cover them with the database.
- **Append-only discipline:** no delete path exists anywhere in this plan's code. Allergies correct via `entered_in_error` status + `correction.entered_in_error` event, never edit or delete. `patients` rows update only through `updatePatient`'s audited diff (`patient.updated` carries `changedFields`) and the defined status moves.
- No config fallbacks (Plan 02 rule). Multi-process-safe: no in-memory state anywhere.
- **Fail-first discipline (EXECUTION-LESSONS §3.5):** every backend task's failing-test step comes first. T9's e2e is written before the controller exists (fails at import/404 — that IS the evidence). T10 adds lifecycle tests over shipped code + docs and **explicitly owes no red run** (stated in-task with what replaces it). Web tasks: each screen's component test precedes the screen; T11's smoke test precedes `App.tsx` (red at unresolved import); T11's toolchain config files owe no red run — their evidence is the verify-by-execution flags. Fail-first evidence is owed by the **original** attempt; a retry inherits it.
- **Static imports in tests** (TS2835 under nodenext — §3.7); **no assertion on `JSON.stringify` of a response body** (§3.11); every derived fixture is hand-checked against this plan's own validators (§3.10).
- **apps/web must carry a `test` script from its first commit** — root `test` is `pnpm -r test` with **no `--if-present`**, so a scriptless workspace breaks `pnpm verify` repo-wide. Vitest lives only in `apps/web`; `jest.config.cjs` and every core test are untouched.
- **pnpm 10 `ignoredBuilds` blocks esbuild's postinstall** (the argon2 precedent — `pnpm.onlyBuiltDependencies` is deliberately NOT added). esbuild ships platform binaries as optionalDependencies, so Vite/Vitest work regardless — **verify-by-execution in T11**; if they do not, halt and report (never silently add build approvals).
- **i18n:** every user-facing string in `apps/web` goes through i18next `t()` with `en` + `hi` namespaces and a visible switcher (§15). The per-patient `language` field (`hi`/`en`, §6) is captured at registration for Plan 10's outbound messages — a data field, independent of the UI language.
- **Print is a first-class surface (§15):** the QR card is a printable component under an `@media print` stylesheet; every printed document carries its signed QR.
- Build/test on the server per the roadmap's standing execution rules; briefs carry EXECUTION-LESSONS §1 verbatim at top.

## File Structure (locked by this plan)

```
apps/core/
  src/modules/patients/index.ts               # THE cross-module interface: getPatient, searchPatients,
                                              #   resolvePatientId, patientsManifest, PatientsModule re-exports
  src/modules/patients/events.ts              # the nine catalog event definitions (defineEvent + zod)
  src/modules/patients/types.ts               # PatientError + code union
  src/modules/patients/uhid.ts                # Verhoeff tables + checkDigit/validate + formatUhid + allocateUhid(tx)
  src/modules/patients/registration.ts        # registerPatient / updatePatient / getPatient / resolvePatientId
  src/modules/patients/search.ts              # searchPatients (shape-dispatch: phone / UHID / name prefix)
  src/modules/patients/photos.ts              # storePatientPhoto / getPatientPhoto (bytea, 512k cap)
  src/modules/patients/allergies.ts           # addAllergy / markAllergyEnteredInError / listAllergies
  src/modules/patients/guardians.ts           # linkGuardian / updateGuardianAuthority / endGuardian /
                                              #   effectiveGuardianAuthority / sweepGuardianMajority
  src/modules/patients/qr.ts                  # buildQrPayload / verifyQrScan / reissueQrCard
  src/modules/patients/merge.ts               # createMergeRequest / executeMerge / requestUnmerge / executeUnmerge
  src/modules/patients/manifest.ts            # patientsManifest (permissions, menu, no subscriptions)
  src/modules/patients/patients.module.ts     # Nest module: controller only
  src/modules/patients/patients.controller.ts # /patients/* endpoints + toHttp
  src/kernel/db/schema/patients.ts            # patients, patient_photos, patient_allergies, patient_guardians,
                                              #   patient_merge_requests, registration_config + uhid_seq sequence
  scripts/seed-registration.ts                # seeds registration_config (UHID_PREFIX)

apps/web/
  package.json · vite.config.ts · tsconfig.json · index.html · components.json
  src/main.tsx · src/App.tsx · src/styles.css
  src/lib/api.ts                              # fetch wrapper: base URL, bearer token, error envelope
  src/lib/auth.tsx                            # token store + login/logout + useActor
  src/lib/i18n.ts · src/locales/en.json · src/locales/hi.json
  src/lib/keyboard.tsx                        # shortcut provider + focus-order helpers + legend
  src/router.tsx                              # code-based route tree
  src/components/ui/*                         # shadcn CLI output (T13)
  src/components/form-kit.tsx                 # RHF+zod field primitives, keyboard-first defaults
  src/components/photo-capture.tsx            # getUserMedia + file fallback + canvas downscale
  src/components/qr-card.tsx                  # printable card (@media print) + qrcode.react
  src/screens/login.tsx · src/screens/registration-desk.tsx · src/screens/patient-detail.tsx
  src/screens/merge-review.tsx · src/screens/approvals-inbox.tsx
  src/**/*.test.tsx                           # Vitest + Testing Library
```

Modified (exact contents shown in tasks): `apps/core/src/kernel/db/schema/index.ts` (T1) · `apps/core/test/helpers/db.ts` (truncate list only — `setupTestDb` frozen; T1) · `apps/core/package.json` (`seed:registration` script; T2) · `apps/core/src/app.module.ts` (T9) · root `eslint.config.mjs` + root `package.json` (T11) · `pnpm-lock.yaml` (T11, T13) · `README.md` (T10, T16). Generated: one drizzle migration `0006_*` (via `db:generate`; T1).

**Not touched, deliberately:** every file under `src/kernel/workflow/`, `src/kernel/auth/`, `src/kernel/events/`, `src/kernel/modules/`, `src/kernel/approvals/` (all byte-frozen for this plan) · `jest.config.cjs` · `.env.example` · `.github/workflows/*` · `tsconfig.base.json` (apps/web brings its own tsconfig; the base stays Node-only).

**Sequencing:** three pipelines, strictly sequential within each (≤6 tasks per Workflow): **A = T1–T6** (schema → UHID → registration service → search+perf → photos+allergies → guardians), **B = T7–T10** (QR → merge/unmerge → module+routes+e2e → lifecycle e2e+docs), **C = T11–T16** (scaffold → shell → shadcn+form kit → registration desk → patient detail → merge UI+inbox+docs). B consumes A's services; C consumes B's HTTP surface, so pipelines run A → B → C. Within C, every task touches `apps/web` — no parallel waves.

---

### Task 1: Schema — six tables, one sequence, migration 0006

**Files:**
- Create: `apps/core/src/kernel/db/schema/patients.ts`
- Create: `apps/core/src/kernel/db/schema/patients.test.ts`
- Modify: `apps/core/src/kernel/db/schema/index.ts` (one added line)
- Modify: `apps/core/test/helpers/db.ts` (one added truncate statement — `setupTestDb` and every existing statement byte-frozen)
- Generate: `apps/core/drizzle/0006_*.sql` (via `db:generate` — auto-named, never hand-written; **the only task that runs it**)

**Interfaces:**
- Consumes: drizzle-orm `pg-core` builders (shipped ^0.40 — `pgTable`, `pgSequence`, `customType`, `date`, `index().using()`, partial `uniqueIndex().where()` all present); `setupTestDb`/`truncateAll` (frozen signatures).
- Produces (exact — every later task imports from `../db/schema` via the index re-export):
  - Tables `patients`, `patientPhotos`, `patientAllergies`, `patientGuardians`, `patientMergeRequests`, `registrationConfig`; sequence `uhidSeq`; `bytea` custom type.
  - **`patient_merge_requests.approval_id` is plain text with NO FK into `approvals`, deliberately** — the shipped `truncateAll` truncates `approvals` in two separate statements (its own and the workflow FK group), so an FK here would force this table's name into BOTH under the §3.12 same-command rule; the plain-text convention already exists for actor ids, and `getApproval` is the read path.
  - No FK into `patients` exists anywhere outside this file, so the new truncate group is self-contained — the workflow and approvals statements are NOT modified.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/db/schema/patients.test.ts`:
```ts
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  patients, patientPhotos, patientAllergies, patientGuardians,
  patientMergeRequests, registrationConfig,
} from "./index";
import type { Db } from "../client";

describe("patients schema", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => truncateAll(db));

  const basePatient = {
    id: "01PATIENT0000000000000001",
    uhid: "HMS-00000001-5",
    name: "Asha Devi",
    sex: "female",
    createdBy: "u1",
    updatedBy: "u1",
  };

  it("round-trips a patient with defaults applied", async () => {
    await db.insert(patients).values(basePatient);
    const rows = await db.select().from(patients);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.language).toBe("hi");
    expect(row.status).toBe("active");
    expect(row.qrVersion).toBe(1);
    expect(typeof row.qrVersion).toBe("number"); // integer column — the string/number trap class
    expect(row.isConfidential).toBe(false);
    expect(row.sensitiveContext).toBe(false);
    expect(row.dobEstimated).toBe(false);
    expect(row.abhaVerificationStatus).toBe("none");
    expect(row.phone).toBeNull();
    expect(row.dob).toBeNull();
    expect(row.mergedIntoPatientId).toBeNull();
  });

  it("round-trips a DATE dob as a Date at day precision", async () => {
    await db.insert(patients).values({ ...basePatient, dob: new Date(Date.UTC(2010, 3, 15)) });
    const rows = await db.select().from(patients);
    const dob = rows[0]!.dob!;
    expect(dob).toBeInstanceOf(Date);
    expect(dob.getUTCFullYear()).toBe(2010);
    expect(dob.getUTCMonth()).toBe(3);
    expect(dob.getUTCDate()).toBe(15);
  });

  it("rejects a duplicate uhid", async () => {
    await db.insert(patients).values(basePatient);
    await expect(
      db.insert(patients).values({ ...basePatient, id: "01PATIENT0000000000000002" }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("round-trips photo bytes as a Buffer", async () => {
    await db.insert(patients).values(basePatient);
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await db.insert(patientPhotos).values({
      patientId: basePatient.id, mimeType: "image/jpeg", bytes, updatedBy: "u1",
    });
    const rows = await db.select().from(patientPhotos);
    expect(Buffer.isBuffer(rows[0]!.bytes)).toBe(true);
    expect(Buffer.compare(rows[0]!.bytes, bytes)).toBe(0);
  });

  it("enforces one photo per patient (PK) and the patient FK", async () => {
    await expect(
      db.insert(patientPhotos).values({
        patientId: "01NOSUCHPATIENT0000000000", mimeType: "image/jpeg",
        bytes: Buffer.from([1]), updatedBy: "u1",
      }),
    ).rejects.toThrow(/foreign key/i);
    await db.insert(patients).values(basePatient);
    const photo = { patientId: basePatient.id, mimeType: "image/jpeg", bytes: Buffer.from([1]), updatedBy: "u1" };
    await db.insert(patientPhotos).values(photo);
    await expect(db.insert(patientPhotos).values(photo)).rejects.toThrow(/duplicate key|unique/i);
  });

  it("allows only ONE pending merge request per loser (partial unique index)", async () => {
    await db.insert(patients).values(basePatient);
    await db.insert(patients).values({ ...basePatient, id: "01PATIENT0000000000000002", uhid: "HMS-00000002-3" });
    const req = {
      id: "01MERGEREQ0000000000000001",
      winnerId: basePatient.id,
      loserId: "01PATIENT0000000000000002",
      approvalId: "01APPROVAL000000000000001",
      requestNote: "duplicate registration",
      snapshot: { winnerBefore: {}, loserBefore: {} },
      requestedBy: "u1",
    };
    await db.insert(patientMergeRequests).values(req);
    await expect(
      db.insert(patientMergeRequests).values({ ...req, id: "01MERGEREQ0000000000000002", approvalId: "01APPROVAL000000000000002" }),
    ).rejects.toThrow(/duplicate key|unique/i);
    // a non-'requested' status frees the slot
    await db.execute(sql`update patient_merge_requests set status = 'executed' where id = ${req.id}`);
    await db.insert(patientMergeRequests).values({ ...req, id: "01MERGEREQ0000000000000003", approvalId: "01APPROVAL000000000000003" });
  });

  it("uhid_seq allocates increasing values and survives concurrent nextval", async () => {
    const first = await db.execute(sql`select nextval('uhid_seq') as n`);
    const second = await db.execute(sql`select nextval('uhid_seq') as n`);
    // nextval returns bigint → pg hands it back as TEXT; every consumer must force Number (T2 does)
    expect(Number(second.rows[0]!.n)).toBe(Number(first.rows[0]!.n) + 1);
    const batch = await Promise.all(
      Array.from({ length: 20 }, () => db.execute(sql`select nextval('uhid_seq') as n`)),
    );
    const values = batch.map((r) => Number(r.rows[0]!.n));
    expect(new Set(values).size).toBe(20);
  });

  it("registration_config and guardians round-trip with defaults", async () => {
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "u1" });
    const cfg = await db.select().from(registrationConfig);
    expect(cfg[0]!.uhidPrefix).toBe("HMS");

    await db.insert(patients).values(basePatient);
    await db.insert(patientGuardians).values({
      id: "01GUARDIAN000000000000001", patientId: basePatient.id,
      name: "Ram Prasad", relationship: "father", createdBy: "u1",
    });
    const g = (await db.select().from(patientGuardians))[0]!;
    expect(g.status).toBe("active");
    expect(g.authorityMessages).toBe(true);
    expect(g.authorityConsents).toBe(true);
    expect(g.authorityDsr).toBe(false);
    expect(g.authorityBills).toBe(true);
    expect(g.idVerified).toBe(false);

    await db.insert(patientAllergies).values({
      id: "01ALLERGY0000000000000001", patientId: basePatient.id,
      substance: "penicillin", source: "registration", recordedBy: "u1",
    });
    const a = (await db.select().from(patientAllergies))[0]!;
    expect(a.status).toBe("active");
    expect(a.severity).toBeNull();
  });
});
```

Run: `pnpm --filter @hmis/core test -- patients` — expect FAIL at import (`./patients` does not exist). That is the fail-first evidence.

- [ ] **Step 2: Write the schema**

`apps/core/src/kernel/db/schema/patients.ts`:
```ts
import { sql } from "drizzle-orm";
import {
  boolean, customType, date, index, integer, jsonb, pgSequence, pgTable,
  text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

/** drizzle has no built-in bytea — the standard customType pattern. Round-trip pinned by test. */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/** UHID allocation counter. Gaplessness is NOT required (a rolled-back registration may skip a number). */
export const uhidSeq = pgSequence("uhid_seq", { startWith: 1, increment: 1 });

/**
 * Registration configuration — a single audited row (id = 'main'). The UHID prefix is
 * hospital identity: owner-gated (Class A) at go-live, seeded via scripts/seed-registration.ts.
 * Deliberately data, not an env var: no loadConfig change, no .env.example change.
 */
export const registrationConfig = pgTable("registration_config", {
  id: text("id").primaryKey(),
  uhidPrefix: text("uhid_prefix").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The patient master (spec §6): ONE patients table owned by the registration module; every
 * later module references patient_id and never copies demographics. ABHA is the D-30 field
 * set (address + verification status + link token), nullable from day one — linkable at any
 * visit, never blocking one. Confidential/VIP (§14) affects privacy surfaces only, never
 * priority (D-37). sensitive_context is the D-31 override: it seals the guardian message
 * channel (POCSO/abuse/adolescent-confidentiality — IPD-phase flows depend on it existing NOW).
 */
export const patients = pgTable(
  "patients",
  {
    id: text("id").primaryKey(), // ULID via newId() — entity ids share the event-id grammar
    uhid: text("uhid").notNull(), // <PREFIX>-<8 digits>-<Verhoeff check digit>
    name: text("name").notNull(),
    phone: text("phone"), // normalized 10-digit Indian mobile; NULLABLE — phoneless patients are a designed path (D-34)
    altPhone: text("alt_phone"),
    dob: date("dob", { mode: "date" }), // nullable: unknown DOB; estimated flag below
    dobEstimated: boolean("dob_estimated").notNull().default(false), // true when derived from an entered age
    sex: text("sex").notNull(), // 'male' | 'female' | 'other' | 'unknown'
    addressLine: text("address_line"),
    district: text("district"),
    stateName: text("state_name"),
    pincode: text("pincode"),
    language: text("language").notNull().default("hi"), // 'hi' | 'en' — outbound-message language (§6), NOT the UI language
    bloodGroup: text("blood_group"), // 'A+'|'A-'|'B+'|'B-'|'AB+'|'AB-'|'O+'|'O-'
    isConfidential: boolean("is_confidential").notNull().default(false), // §14 staff-as-patient / VIP
    alias: text("alias"), // required when confidential; the name public surfaces use
    sensitiveContext: boolean("sensitive_context").notNull().default(false), // D-31 sealed-channel override
    abhaAddress: text("abha_address"), // D-30: the ABHA *address*, not just a number
    abhaNumber: text("abha_number"),
    abhaVerificationStatus: text("abha_verification_status").notNull().default("none"), // 'none'|'self_declared'|'verified'
    abhaLinkToken: text("abha_link_token"), // D-30 reserved M1/M2 field — populated by the real ABDM flow, later plan
    legacyUhid: text("legacy_uhid"), // D-43 old-UHID cross-reference (paper-era continuity)
    qrVersion: integer("qr_version").notNull().default(1), // D-23: reissue increments; old cards fail the scan
    status: text("status").notNull().default("active"), // 'active' | 'merged'
    mergedIntoPatientId: text("merged_into_patient_id"), // set when status='merged'; resolution follows the chain
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("patients_uhid_ux").on(t.uhid),
    // Phone-first search (<300 ms budget): prefix LIKE needs text_pattern_ops under the
    // cluster's en_US.utf8 collation — a plain btree would be ignored by LIKE 'x%'.
    index("patients_phone_idx").using("btree", t.phone.op("text_pattern_ops")),
    index("patients_alt_phone_idx").using("btree", t.altPhone.op("text_pattern_ops")),
    // Name prefix search on lower(name) — expression index, same opclass reasoning.
    index("patients_name_idx").using("btree", sql`lower(${t.name}) text_pattern_ops`),
  ],
);

/** One CURRENT photo per patient (PK = patient_id) — C-18's photo-prompt source. Cap enforced in code (512,000 bytes). */
export const patientPhotos = pgTable("patient_photos", {
  patientId: text("patient_id").primaryKey().references(() => patients.id),
  mimeType: text("mime_type").notNull(), // image/jpeg only in v1
  bytes: bytea("bytes").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Allergy list on the patient master (§6): captured at registration (vitals/consult sources
 * arrive Plan 07). Append-only with the E-8 entered-in-error grammar — never edited, never
 * deleted; corrections flip status and mint correction.entered_in_error.
 */
export const patientAllergies = pgTable(
  "patient_allergies",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    substance: text("substance").notNull(),
    reaction: text("reaction"),
    severity: text("severity"), // 'mild' | 'moderate' | 'severe' | null
    source: text("source").notNull(), // 'registration' | 'vitals' | 'consult'
    status: text("status").notNull().default("active"), // 'active' | 'entered_in_error'
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    correctedBy: text("corrected_by"),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
    correctionReason: text("correction_reason"),
  },
  (t) => [index("patient_allergies_patient_idx").on(t.patientId)],
);

/**
 * D-31 guardianship: relationship, verified identity, authority SCOPE (messages/consents/
 * DSR/bills), validity dates, DOB-driven majority transition. Enforcement is read-time
 * (guardians.ts effectiveGuardianAuthority); the sweep only flips status and events.
 */
export const patientGuardians = pgTable(
  "patient_guardians",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    name: text("name").notNull(),
    phone: text("phone"),
    relationship: text("relationship").notNull(), // 'father'|'mother'|'spouse'|'sibling'|'legal_guardian'|'other'
    idType: text("id_type"), // 'aadhaar'|'pan'|'voter_id'|'other'
    idNumberMasked: text("id_number_masked"), // last-4 only — never the full document number
    idVerified: boolean("id_verified").notNull().default(false),
    authorityMessages: boolean("authority_messages").notNull().default(true),
    authorityConsents: boolean("authority_consents").notNull().default(true),
    authorityDsr: boolean("authority_dsr").notNull().default(false),
    authorityBills: boolean("authority_bills").notNull().default(true),
    consentNote: text("consent_note"), // DPDP §9 guardian-consent record at minor registration
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }), // explicit validity end (court orders etc.)
    status: text("status").notNull().default("active"), // 'active' | 'ended' | 'majority_ended'
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedBy: text("ended_by"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("patient_guardians_patient_idx").on(t.patientId)],
);

/**
 * Merge requests (§11.5): approval-gated via Plan 04 (approval_id is PLAIN TEXT, no FK —
 * see the task's Interfaces note), snapshot carries both rows at request time so unmerge
 * can restore exactly. Status is the single-winner discriminator for execute/unmerge.
 */
export const patientMergeRequests = pgTable(
  "patient_merge_requests",
  {
    id: text("id").primaryKey(),
    winnerId: text("winner_id").notNull().references(() => patients.id),
    loserId: text("loser_id").notNull().references(() => patients.id),
    approvalId: text("approval_id").notNull(), // Plan 04 approvals.id — plain text, deliberately no FK
    unmergeApprovalId: text("unmerge_approval_id"), // set when an unmerge is requested (one per merge in v1)
    requestNote: text("request_note").notNull(),
    snapshot: jsonb("snapshot").notNull(), // { winnerBefore, loserBefore } — full rows at request time
    movedRows: jsonb("moved_rows"), // set at execute: { allergyIds: string[], guardianIds: string[], photoMoved: boolean }
    status: text("status").notNull().default("requested"), // 'requested' | 'executed' | 'unmerged'
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    executedBy: text("executed_by"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    unmergedBy: text("unmerged_by"),
    unmergedAt: timestamp("unmerged_at", { withTimezone: true }),
  },
  (t) => [
    // One live request per loser — the Plan 03 partial-unique precedent (one-active-per-key).
    uniqueIndex("patient_merge_requests_pending_loser_ux")
      .on(t.loserId)
      .where(sql`${t.status} = 'requested'`),
    index("patient_merge_requests_winner_idx").on(t.winnerId),
    index("patient_merge_requests_loser_idx").on(t.loserId),
  ],
);
```

`apps/core/src/kernel/db/schema/index.ts` — the complete new contents (one line added at the end):
```ts
export * from "./events";
export * from "./eventCursors";
export * from "./eventIdempotency";
export * from "./auth";
export * from "./workflow";
export * from "./approvals";
export * from "./patients";
```

- [ ] **Step 3: Extend `truncateAll` — one added statement, nothing else touched**

In `apps/core/test/helpers/db.ts`, add exactly this statement at the END of `truncateAll` (after the auth-group statement). All five FK-linked tables plus the config row live in ONE command (§3.12: every table with an incoming FK to a target must be named in the same statement — photos/allergies/guardians/merge-requests all FK into `patients`). No existing statement changes: nothing FKs into any existing group from here.

```ts
  await db.execute(
    sql`truncate table patient_merge_requests, patient_guardians, patient_allergies,
        patient_photos, patients, registration_config`,
  );
```

- [ ] **Step 4: Generate migration 0006**

```bash
cd /opt/hmis/apps/core && pnpm db:generate
```

Open the generated `drizzle/0006_*.sql` and confirm ALL of: `CREATE SEQUENCE "public"."uhid_seq"` · all six `CREATE TABLE`s with `bytea` on `patient_photos.bytes` and `date` on `patients.dob` · FKs from photos/allergies/guardians/merge-requests into `patients` · **NO FK on `patient_merge_requests.approval_id`** · `patients_uhid_ux` · the three `text_pattern_ops` indexes (the opclass must appear in the SQL — if drizzle-kit drops it, that is a plan defect: STOP and report, do not hand-edit the migration) · the partial unique `patient_merge_requests_pending_loser_ux` with its `WHERE` clause. Then `pnpm db:migrate` against dev.

- [ ] **Step 5: Run the tests, then full verify + commit**

Run: `pnpm --filter @hmis/core test -- patients` → PASS (8 tests). Then `pnpm verify` (unpiped, tripwire 16) → exit 0.

```bash
git add apps/core
git commit -m "feat(patients): schema — patient master, photos, allergies, guardians, merge requests; migration 0006"
```

---

### Task 2: Verhoeff check digit + UHID allocator + prefix seed script

**Files:**
- Create: `apps/core/src/modules/patients/uhid.ts`
- Create: `apps/core/src/modules/patients/uhid.test.ts`
- Create: `apps/core/scripts/seed-registration.ts`
- Modify: `apps/core/package.json` (ONE added script line: `"seed:registration": "tsx scripts/seed-registration.ts"` — no dependency changes, so `pnpm-lock.yaml` does not change)

**Interfaces:**
- Consumes: `registrationConfig`, `uhidSeq` (T1), `Tx`/`Db` (`kernel/db/client`), `createDb`, `requireEnv` (`kernel/config`).
- Produces (exact — T3 calls `allocateUhid`; T7/T9 call `isValidUhid`):
  - `verhoeffCheckDigit(digits: string): number` — Verhoeff over a digit string (Aadhaar's algorithm; owner decision Q6).
  - `isValidUhid(uhid: string): boolean` — format `/^[A-Z]{2,5}-\d{8}-\d$/` + check-digit validation over the 8 digits.
  - `formatUhid(prefix: string, n: number): string`
  - `allocateUhid(tx: Tx): Promise<string>` — `nextval('uhid_seq')` + prefix from `registration_config`; **throws `PatientError("registration_not_configured")` when the config row is missing** (the no-fallbacks rule — a dev placeholder is seeded by the script, never by code).
  - `class PatientError extends Error { constructor(readonly code: PatientErrorCode, message?: string) }` — **defined here in T2's file? NO.** `PatientError` lives in `types.ts` (T3) per the one-error-class convention; to keep this task self-contained and strictly ordered, `uhid.ts` defines and exports it and T3's `types.ts` **re-exports it from `./uhid`** — one class, one definition site, the Plan 03/04 convention preserved. (`types.ts` owns the full `PatientErrorCode` union; `uhid.ts` declares the union type with every code T3–T8 use, listed below, so no later task edits this file.)

- [ ] **Step 1: Write the failing tests**

`apps/core/src/modules/patients/uhid.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import {
  PatientError, allocateUhid, formatUhid, isValidUhid, verhoeffCheckDigit,
} from "./uhid";
import type { Db } from "../../kernel/db/client";

describe("verhoeffCheckDigit (pure)", () => {
  it("matches the canonical worked example: check digit of 236 is 3", () => {
    expect(verhoeffCheckDigit("236")).toBe(3);
  });

  it("property: appending the check digit always validates", () => {
    for (let i = 0; i < 500; i++) {
      const digits = String(1_000_000 + i * 7919).slice(0, 8).padStart(8, "0");
      const check = verhoeffCheckDigit(digits);
      expect(isValidUhid(`AB-${digits}-${check}`)).toBe(true);
    }
  });

  it("property: EVERY single-digit substitution is detected", () => {
    const digits = "00123456";
    const check = verhoeffCheckDigit(digits);
    for (let pos = 0; pos < digits.length; pos++) {
      for (let d = 0; d <= 9; d++) {
        if (String(d) === digits[pos]) continue;
        const mutated = digits.slice(0, pos) + String(d) + digits.slice(pos + 1);
        expect(isValidUhid(`AB-${mutated}-${check}`)).toBe(false);
      }
    }
  });

  it("property: EVERY adjacent transposition is detected (the Luhn 09↔90 gap, closed)", () => {
    const digits = "90817263";
    const check = verhoeffCheckDigit(digits);
    for (let pos = 0; pos < digits.length - 1; pos++) {
      if (digits[pos] === digits[pos + 1]) continue;
      const swapped =
        digits.slice(0, pos) + digits[pos + 1]! + digits[pos]! + digits.slice(pos + 2);
      expect(isValidUhid(`AB-${swapped}-${check}`)).toBe(false);
    }
  });

  it("formatUhid pads to 8 and appends the check digit", () => {
    const u = formatUhid("HMS", 123);
    expect(u).toMatch(/^HMS-00000123-\d$/);
    expect(isValidUhid(u)).toBe(true);
  });

  it("isValidUhid rejects malformed shapes and a wrong check digit", () => {
    expect(isValidUhid("HMS-00000123")).toBe(false);
    expect(isValidUhid("hms-00000123-4")).toBe(false);
    expect(isValidUhid("TOOLONGX-00000123-4")).toBe(false);
    const good = formatUhid("HMS", 123);
    const badCheck = good.slice(0, -1) + String((Number(good.slice(-1)) + 1) % 10);
    expect(isValidUhid(badCheck)).toBe(false);
  });
});

describe("allocateUhid (db)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => truncateAll(db));

  it("hard-fails when registration_config is missing (no fallbacks)", async () => {
    await expect(withTx(db, (tx) => allocateUhid(tx))).rejects.toMatchObject({
      code: "registration_not_configured",
    });
  });

  it("allocates valid, unique, increasing UHIDs — including 20 concurrent allocations", async () => {
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    const one = await withTx(db, (tx) => allocateUhid(tx));
    expect(one.startsWith("HMS-")).toBe(true);
    expect(isValidUhid(one)).toBe(true);

    const batch = await Promise.all(
      Array.from({ length: 20 }, () => withTx(db, (tx) => allocateUhid(tx))),
    );
    expect(new Set(batch).size).toBe(20);
    for (const u of batch) expect(isValidUhid(u)).toBe(true);
  });

  it("PatientError carries its code", () => {
    const e = new PatientError("registration_not_configured");
    expect(e.code).toBe("registration_not_configured");
    expect(e.name).toBe("PatientError");
  });
});
```

Run: `pnpm --filter @hmis/core test -- uhid` — expect FAIL at import. Fail-first evidence.

- [ ] **Step 2: Implement**

`apps/core/src/modules/patients/uhid.ts`:
```ts
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { registrationConfig } from "../../kernel/db/schema";
import type { Tx } from "../../kernel/db/client";

/**
 * One error class for the whole patients module (the Plan 03/04 one-class convention).
 * Defined here — the module's lowest layer — and re-exported by types.ts; the union carries
 * every code T3–T8 throw so no later task edits this file.
 */
export type PatientErrorCode =
  | "user_actor_required"
  | "registration_not_configured"
  | "patient_not_found"
  | "patient_not_active"
  | "reason_required"
  | "alias_required"
  | "dob_or_age"
  | "minor_needs_guardian"
  | "photo_too_large"
  | "unsupported_photo_type"
  | "allergy_not_found"
  | "allergy_not_active"
  | "guardian_not_found"
  | "guardian_not_active"
  | "merge_same_patient"
  | "merge_already_requested"
  | "unknown_merge_request"
  | "merge_not_requested"
  | "merge_not_executed"
  | "approval_not_granted"
  | "unmerge_not_requested"
  | "unmerge_already_requested";

export class PatientError extends Error {
  constructor(
    readonly code: PatientErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PatientError";
  }
}

// Verhoeff (owner decision Q6 — Aadhaar's algorithm): detects all single-digit errors and
// all adjacent transpositions. Tables are the published dihedral-group D5 tables; the
// property tests (every substitution, every transposition) would fail on ANY transcription
// error, so correctness is proven by execution, not by trusting these literals.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;

const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9] as const;

/** Check digit for a digit string (throws on non-digits — internal misuse, not user input). */
export function verhoeffCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new Error(`verhoeffCheckDigit: non-digit input "${digits}"`);
  let c = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D[c]![P[(i + 1) % 8]![Number(reversed[i])]!]!;
  }
  return INV[c]!;
}

function verhoeffValidates(digitsWithCheck: string): boolean {
  let c = 0;
  const reversed = digitsWithCheck.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D[c]![P[i % 8]![Number(reversed[i])]!]!;
  }
  return c === 0;
}

const UHID_RE = /^([A-Z]{2,5})-(\d{8})-(\d)$/;

export function isValidUhid(uhid: string): boolean {
  const m = UHID_RE.exec(uhid);
  if (!m) return false;
  return verhoeffValidates(m[2]! + m[3]!);
}

export function formatUhid(prefix: string, n: number): string {
  const body = String(n).padStart(8, "0");
  return `${prefix}-${body}-${verhoeffCheckDigit(body)}`;
}

/** Allocates the next UHID on the caller's transaction. Sequence = concurrency-safe by construction. */
export async function allocateUhid(tx: Tx): Promise<string> {
  const cfg = await tx
    .select({ uhidPrefix: registrationConfig.uhidPrefix })
    .from(registrationConfig)
    .where(eq(registrationConfig.id, "main"));
  if (cfg.length === 0) {
    throw new PatientError(
      "registration_not_configured",
      "registration_config row 'main' is missing — run: UHID_PREFIX=<PREFIX> pnpm --filter @hmis/core seed:registration",
    );
  }
  const res = await tx.execute(sql`select nextval('uhid_seq') as n`);
  const n = Number(res.rows[0]!.n); // nextval returns bigint → TEXT through pg; force a real number
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`uhid_seq returned unusable value: ${String(res.rows[0]!.n)}`);
  return formatUhid(cfg[0]!.uhidPrefix, n);
}
```

`apps/core/scripts/seed-registration.ts`:
```ts
import { createDb } from "../src/kernel/db/client";
import { registrationConfig } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";

/**
 * Seeds/updates the registration config (idempotent — the seed:admin convention).
 * Usage: UHID_PREFIX=HMS pnpm --filter @hmis/core seed:registration
 * The production prefix is an owner-gated go-live decision (Class A); dev uses a placeholder.
 */
async function main(): Promise<void> {
  const prefix = requireEnv("UHID_PREFIX");
  if (!/^[A-Z]{2,5}$/.test(prefix)) {
    throw new Error(`UHID_PREFIX must be 2–5 uppercase letters, got "${prefix}"`);
  }
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    await db
      .insert(registrationConfig)
      .values({ id: "main", uhidPrefix: prefix, updatedBy: "seed" })
      .onConflictDoUpdate({ target: registrationConfig.id, set: { uhidPrefix: prefix, updatedBy: "seed", updatedAt: new Date() } });
    console.log(`registration_config seeded: uhid_prefix=${prefix}`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
}); // the shipped seed-admin.ts convention: a failed seed exits non-zero, loudly
```

In `apps/core/package.json`, add to `"scripts"` (after `"agent:create"`):
```json
"seed:registration": "tsx scripts/seed-registration.ts"
```

- [ ] **Step 3: Seed dev + run the tests, then full verify + commit**

```bash
cd /opt/hmis/apps/core && UHID_PREFIX=HMS pnpm seed:registration
```
Expected output: `registration_config seeded: uhid_prefix=HMS`

Run: `pnpm --filter @hmis/core test -- uhid` → PASS (9 tests). Then `pnpm verify` (unpiped) → exit 0.

```bash
git add apps/core
git commit -m "feat(patients): Verhoeff check digit, UHID allocator, registration config seed"
```

---

### Task 3: Events, module types, manifest + the registration service

**Files:**
- Create: `apps/core/src/modules/patients/events.ts`
- Create: `apps/core/src/modules/patients/types.ts`
- Create: `apps/core/src/modules/patients/manifest.ts` (created here so this task's tests can grant `patients.confidential.read` through the registry; T9 wires it into `AppModule`)
- Create: `apps/core/src/modules/patients/registration.ts`
- Create: `apps/core/src/modules/patients/registration.test.ts`

**Interfaces:**
- Consumes: `defineEvent`, `newId`, `Actor` (`@hmis/contracts`); `appendEvent` (`kernel/events/append`); `hasPermission`, `createUser`, `createRole`, `grantPermissionToRole`, `syncPermissions`, `assignRole` (`kernel/auth/permissions` + `identity`, tests only); `allocateUhid`, `PatientError` (T2); tables (T1); `ModuleManifest` (`kernel/modules/manifest`).
- Produces (exact — T4–T10 and the web app consume these):
  - `events.ts`: the **nine** event defs — `patientRegistered`, `patientUpdated`, `patientMerged`, `patientUnmerged`, `guardianLinked`, `guardianAuthorityChanged`, `allergyRecorded`, `correctionEnteredInError`, `qrSignatureFailed` — all `module: "patients"`, zod payloads as written below. **No other task defines an event.**
  - `types.ts`: re-exports `PatientError`/`PatientErrorCode` from `./uhid` (one class, one definition site); shared unions `Sex`, `PatientLanguage`, `BloodGroup`, `GuardianRelationship`; `yearsBetween(dob: Date, now: Date): number` (UTC, anniversary-aware — used by the minor rule here, read-time authority in T6, and the sweep).
  - `manifest.ts`: `patientsManifest: ModuleManifest` — key `"patients"`, title `"Patient Master & Registration"`, menu `[{ label: "Registration", path: "/registration", permission: "patients.register" }]`, permissions `["patients.register", "patients.read", "patients.update", "patients.merge", "patients.confidential.read"]`, subscriptions `[]`.
  - `registration.ts`:
    - `type GuardianInput` / `type RegisterPatientInput` (as written below)
    - `registerPatient(tx: Tx, actor: Actor, input: RegisterPatientInput): Promise<{ patient: PatientRow; guardianId: string | null }>` — user-actor-only; semantic rules in order: `dob_or_age` (both given) → age→estimated dob conversion → `alias_required` (confidential without alias) → **`minor_needs_guardian`** (known DOB < 18 years requires the guardian block — DPDP §9 guardian consent at minor registration, D-31) → `allocateUhid` → insert patient (+ guardian if given) → `patient.registered` (+ `guardian.linked`).
    - `updatePatient(tx: Tx, actor: Actor, patientId: string, patch: PatientPatch): Promise<{ patient: PatientRow; changed: string[] }>` — diffs against the current row, updates via a **conditional UPDATE `where status = 'active'`** (a merged loser refuses with `patient_not_active` — this also arbitrates a race against a concurrent merge freeze), emits `patient.updated` with `changes: [{field, from, to}]` **only when the diff is non-empty**. `uhid`, `qrVersion`, `status`, `mergedIntoPatientId` are not patchable (not in the type).
    - `getPatient(db: Db, actor: Actor, patientId: string): Promise<{ patient: PatientRow; resolvedFrom: string | null } | null>` — follows the `merged_into` chain (≤ 5 hops), then the **confidential gate**: a flagged patient is `null` (existence-hiding) for user actors lacking `patients.confidential.read` and for agent actors (Plan 12 seam); `system` actors pass (internal machinery).
    - `resolvePatientId(db: Db, patientId: string): Promise<string | null>` — chain resolution only, no demographics, no gate (the §6 id-mapping surface for later modules).
    - `type PatientRow = typeof patients.$inferSelect`

- [ ] **Step 1: Write the failing tests**

`apps/core/src/modules/patients/registration.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, patientGuardians, patients, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patientsManifest } from "./manifest";
import { getPatient, registerPatient, resolvePatientId, updatePatient } from "./registration";
import { isValidUhid } from "./uhid";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };

describe("registration service", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
  });

  const baseInput = { name: "Asha Devi", sex: "female" as const, phone: "9876543210" };

  it("registers a patient: UHID allocated, row inserted, patient.registered with full envelope", async () => {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, baseInput));
    expect(isValidUhid(patient.uhid)).toBe(true);
    expect(patient.uhid.startsWith("HMS-")).toBe(true);
    expect(patient.language).toBe("hi");
    expect(patient.status).toBe("active");
    expect(patient.createdBy).toBe("clerk-1");

    const evs = await db.select().from(events).where(eq(events.name, "patient.registered"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.module).toBe("patients");
    expect(evs[0]!.patientId).toBe(patient.id);
    expect(evs[0]!.actorId).toBe("clerk-1");
    const payload = evs[0]!.payload as { uhid: string; name: string; phone: string | null; language: string };
    expect(payload.uhid).toBe(patient.uhid);
    expect(payload.name).toBe("Asha Devi");
    expect(payload.phone).toBe("9876543210");
  });

  it("refuses non-user actors", async () => {
    await expect(
      withTx(db, (tx) => registerPatient(tx, { type: "system", id: "sys" }, baseInput)),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("refuses dob AND ageYears together; converts a lone ageYears to an estimated dob", async () => {
    await expect(
      withTx(db, (tx) =>
        registerPatient(tx, clerk, { ...baseInput, dob: new Date(Date.UTC(1990, 0, 1)), ageYears: 30 }),
      ),
    ).rejects.toMatchObject({ code: "dob_or_age" });

    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { ...baseInput, ageYears: 30 }),
    );
    expect(patient.dobEstimated).toBe(true);
    expect(patient.dob).not.toBeNull();
    const yearNow = new Date().getUTCFullYear();
    expect(patient.dob!.getUTCFullYear()).toBe(yearNow - 30);
  });

  it("requires an alias for confidential patients (§14)", async () => {
    await expect(
      withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, isConfidential: true })),
    ).rejects.toMatchObject({ code: "alias_required" });
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { ...baseInput, isConfidential: true, alias: "Patient A" }),
    );
    expect(patient.alias).toBe("Patient A");
  });

  it("requires a guardian for a known minor (D-31 + DPDP §9) and links it atomically", async () => {
    const minorDob = new Date(Date.UTC(new Date().getUTCFullYear() - 10, 5, 1));
    await expect(
      withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, dob: minorDob })),
    ).rejects.toMatchObject({ code: "minor_needs_guardian" });

    const { patient, guardianId } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, {
        ...baseInput,
        dob: minorDob,
        guardian: { name: "Ram Prasad", relationship: "father", phone: "9812345678", consentNote: "DPDP consent at desk" },
      }),
    );
    expect(guardianId).not.toBeNull();
    const g = await db.select().from(patientGuardians).where(eq(patientGuardians.patientId, patient.id));
    expect(g).toHaveLength(1);
    expect(g[0]!.authorityMessages).toBe(true);

    const evs = await db.select().from(events).where(eq(events.name, "guardian.linked"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.patientId).toBe(patient.id);
    const payload = evs[0]!.payload as { authority: { messages: boolean; dsr: boolean } };
    expect(payload.authority.messages).toBe(true);
    expect(payload.authority.dsr).toBe(false);
  });

  it("updatePatient diffs, updates, and events — and a no-op patch emits nothing", async () => {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, baseInput));
    const { changed } = await withTx(db, (tx) =>
      updatePatient(tx, clerk, patient.id, { phone: "9000000001", language: "en" }),
    );
    expect(changed.sort()).toEqual(["language", "phone"]);
    const evs = await db.select().from(events).where(eq(events.name, "patient.updated"));
    expect(evs).toHaveLength(1);
    const payload = evs[0]!.payload as { changes: { field: string; from: string | null; to: string | null }[] };
    const phoneChange = payload.changes.find((c) => c.field === "phone")!;
    expect(phoneChange.from).toBe("9876543210");
    expect(phoneChange.to).toBe("9000000001");

    const second = await withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { phone: "9000000001" }));
    expect(second.changed).toEqual([]);
    expect(await db.select().from(events).where(eq(events.name, "patient.updated"))).toHaveLength(1);
  });

  it("updatePatient refuses a merged (frozen) row with patient_not_active", async () => {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, baseInput));
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: "01WINNER00000000000000001" }).where(eq(patients.id, patient.id));
    await expect(
      withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { name: "New Name" })),
    ).rejects.toMatchObject({ code: "patient_not_active" });
  });

  it("getPatient resolves the merged_into chain and reports resolvedFrom", async () => {
    const a = (await withTx(db, (tx) => registerPatient(tx, clerk, baseInput))).patient;
    const b = (await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, name: "Asha D" }))).patient;
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: b.id }).where(eq(patients.id, a.id));

    const viaLoser = await getPatient(db, clerk, a.id);
    expect(viaLoser!.patient.id).toBe(b.id);
    expect(viaLoser!.resolvedFrom).toBe(a.id);
    const direct = await getPatient(db, clerk, b.id);
    expect(direct!.resolvedFrom).toBeNull();
    expect(await resolvePatientId(db, a.id)).toBe(b.id);
    expect(await resolvePatientId(db, "01NOSUCH00000000000000000")).toBeNull();
  });

  it("hides confidential patients from users without the permission, shows them with it, passes system actors, blocks agents", async () => {
    const registry = new ModuleRegistry();
    registry.install(patientsManifest);
    await syncPermissions(db, registry);
    await createRole(db, "vip_desk", "VIP Desk");
    await grantPermissionToRole(db, registry, "vip_desk", "patients.confidential.read");
    const holder = await createUser(db, { username: "holder", fullName: "Holder", password: "p1234567" });
    const plain = await createUser(db, { username: "plain", fullName: "Plain", password: "p1234567" });
    await assignRole(db, { userId: holder.id, roleKey: "vip_desk", scopeType: "hospital" });

    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { ...baseInput, isConfidential: true, alias: "Patient A" }),
    );
    expect(await getPatient(db, { type: "user", id: plain.id }, patient.id)).toBeNull();
    expect((await getPatient(db, { type: "user", id: holder.id }, patient.id))!.patient.id).toBe(patient.id);
    expect((await getPatient(db, { type: "system", id: "sys" }, patient.id))!.patient.id).toBe(patient.id);
    expect(await getPatient(db, { type: "agent", id: "agent-1" }, patient.id)).toBeNull();
  });
});
```

Run: `pnpm --filter @hmis/core test -- registration` — expect FAIL at import. Fail-first evidence.

- [ ] **Step 2: Write `events.ts`, `types.ts`, `manifest.ts`**

`apps/core/src/modules/patients/events.ts`:
```ts
import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * The NINE catalog names this plan mints (§10.6 — P1 + pass-7 + pass-8 entries), module
 * "patients". No other event name may be emitted by this module in this plan; abha.linked
 * belongs to the real ABDM linking flow (later plan) — ABHA field edits ride patient.updated.
 */
const MODULE = "patients";

const authoritySchema = z.object({
  messages: z.boolean(),
  consents: z.boolean(),
  dsr: z.boolean(),
  bills: z.boolean(),
});

export const patientRegistered = defineEvent(
  "patient.registered",
  MODULE,
  z.object({
    patientId: z.string().min(1),
    uhid: z.string().min(1),
    name: z.string().min(1),
    phone: z.string().nullable(),
    language: z.enum(["hi", "en"]),
  }),
);

export const patientUpdated = defineEvent(
  "patient.updated",
  MODULE,
  z.object({
    patientId: z.string().min(1),
    // Field-level diff with stringified values — the audit trail §6 promises, and the raw
    // material for C-18's demographic-mismatch sampling (the report itself is Plan 12 scope).
    // Photo changes carry field "photo" with null values (bytes never enter an event).
    changes: z
      .array(z.object({ field: z.string().min(1), from: z.string().nullable(), to: z.string().nullable() }))
      .min(1),
  }),
);

export const patientMerged = defineEvent(
  "patient.merged",
  MODULE,
  z.object({
    winnerPatientId: z.string().min(1),
    loserPatientId: z.string().min(1),
    winnerUhid: z.string().min(1),
    loserUhid: z.string().min(1),
    mergeRequestId: z.string().min(1),
  }),
);

export const patientUnmerged = defineEvent(
  "patient.unmerged",
  MODULE,
  z.object({
    winnerPatientId: z.string().min(1),
    loserPatientId: z.string().min(1),
    mergeRequestId: z.string().min(1),
  }),
);

export const guardianLinked = defineEvent(
  "guardian.linked",
  MODULE,
  z.object({
    patientId: z.string().min(1),
    guardianId: z.string().min(1),
    relationship: z.string().min(1),
    authority: authoritySchema,
  }),
);

export const guardianAuthorityChanged = defineEvent(
  "guardian.authority_changed",
  MODULE,
  z.object({
    patientId: z.string().min(1),
    guardianId: z.string().min(1),
    reason: z.enum(["update", "ended", "majority"]),
    authority: authoritySchema, // the EFFECTIVE authority after the change (all-false for ended/majority)
  }),
);

export const allergyRecorded = defineEvent(
  "allergy.recorded",
  MODULE,
  z.object({
    patientId: z.string().min(1),
    allergyId: z.string().min(1),
    substance: z.string().min(1),
    severity: z.enum(["mild", "moderate", "severe"]).nullable(),
    source: z.enum(["registration", "vitals", "consult"]),
  }),
);

export const correctionEnteredInError = defineEvent(
  "correction.entered_in_error",
  MODULE,
  z.object({
    entity: z.literal("allergy"), // widens per-plan as the grammar reaches other records (E-8: universal)
    entityId: z.string().min(1),
    patientId: z.string().min(1),
    reason: z.string().min(1),
  }),
);

export const qrSignatureFailed = defineEvent(
  "qr.signature_failed",
  MODULE,
  z.object({
    reason: z.enum(["malformed", "invalid_signature", "stale_version", "unknown_patient"]),
    payloadPrefix: z.string(), // first 32 chars of the scanned payload — enough to investigate, never a full forgeable token
    patientId: z.string().optional(), // only when the signature verified (stale_version / unknown_patient) — a forged id is never evented as a patientId
  }),
);
```

`apps/core/src/modules/patients/types.ts`:
```ts
export { PatientError } from "./uhid";
export type { PatientErrorCode } from "./uhid";

export type Sex = "male" | "female" | "other" | "unknown";
export type PatientLanguage = "hi" | "en";
export type BloodGroup = "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-";
export type GuardianRelationship = "father" | "mother" | "spouse" | "sibling" | "legal_guardian" | "other";
export type AbhaVerificationStatus = "none" | "self_declared" | "verified";

export const MAJORITY_AGE_YEARS = 18;

/** Whole years between dob and now, UTC, anniversary-aware (Feb-29 birthdays normalize to Mar 1). */
export function yearsBetween(dob: Date, now: Date): number {
  const years = now.getUTCFullYear() - dob.getUTCFullYear();
  const anniversaryNotReached =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  return anniversaryNotReached ? years - 1 : years;
}
```

`apps/core/src/modules/patients/manifest.ts`:
```ts
import type { ModuleManifest } from "../../kernel/modules/manifest";

export const patientsManifest: ModuleManifest = {
  key: "patients",
  title: "Patient Master & Registration",
  menu: [{ label: "Registration", path: "/registration", permission: "patients.register" }],
  permissions: [
    "patients.register",
    "patients.read",
    "patients.update",
    "patients.merge",
    "patients.confidential.read", // §14: confidential/VIP visibility beyond normal RBAC
  ],
  subscriptions: [],
};
```

- [ ] **Step 3: Write `registration.ts`**

`apps/core/src/modules/patients/registration.ts`:
```ts
import { eq, and } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { patientGuardians, patients } from "../../kernel/db/schema";
import { allocateUhid, PatientError } from "./uhid";
import { guardianLinked, patientRegistered, patientUpdated } from "./events";
import { MAJORITY_AGE_YEARS, yearsBetween } from "./types";
import type {
  AbhaVerificationStatus, BloodGroup, GuardianRelationship, PatientLanguage, Sex,
} from "./types";
import type { Db, Tx } from "../../kernel/db/client";

export type PatientRow = typeof patients.$inferSelect;

export type GuardianInput = {
  name: string;
  phone?: string;
  relationship: GuardianRelationship;
  idType?: "aadhaar" | "pan" | "voter_id" | "other";
  idNumberMasked?: string; // last-4 only — the schema never holds a full document number
  idVerified?: boolean;
  authorityMessages?: boolean;
  authorityConsents?: boolean;
  authorityDsr?: boolean;
  authorityBills?: boolean;
  consentNote?: string;
};

export type RegisterPatientInput = {
  name: string;
  phone?: string;
  altPhone?: string;
  dob?: Date;
  ageYears?: number;
  sex: Sex;
  addressLine?: string;
  district?: string;
  stateName?: string;
  pincode?: string;
  language?: PatientLanguage;
  bloodGroup?: BloodGroup;
  isConfidential?: boolean;
  alias?: string;
  sensitiveContext?: boolean;
  abhaAddress?: string;
  abhaNumber?: string;
  abhaVerificationStatus?: AbhaVerificationStatus;
  legacyUhid?: string;
  guardian?: GuardianInput;
};

/** Registers a patient on the caller's transaction. Rules in order, each separately tested. */
export async function registerPatient(
  tx: Tx,
  actor: Actor,
  input: RegisterPatientInput,
): Promise<{ patient: PatientRow; guardianId: string | null }> {
  if (actor.type !== "user") {
    throw new PatientError("user_actor_required", "only user actors register patients");
  }
  if (input.dob !== undefined && input.ageYears !== undefined) {
    throw new PatientError("dob_or_age", "provide dob OR ageYears, not both");
  }
  let dob = input.dob ?? null;
  let dobEstimated = false;
  if (input.ageYears !== undefined) {
    const now = new Date();
    dob = new Date(Date.UTC(now.getUTCFullYear() - input.ageYears, now.getUTCMonth(), now.getUTCDate()));
    dobEstimated = true;
  }
  const isConfidential = input.isConfidential ?? false;
  if (isConfidential && (input.alias ?? "").trim() === "") {
    throw new PatientError("alias_required", "a confidential patient needs an alias for public surfaces (§14)");
  }
  // D-31 + DPDP §9: a KNOWN minor must have a guardian at registration. Unknown DOB cannot
  // be enforced against — the desk flow prompts, the rule binds only on data it has.
  const minor = dob !== null && yearsBetween(dob, new Date()) < MAJORITY_AGE_YEARS;
  if (minor && input.guardian === undefined) {
    throw new PatientError("minor_needs_guardian", "a minor's registration must include a guardian (D-31, DPDP §9)");
  }

  const patientId = newId();
  const uhid = await allocateUhid(tx);
  const inserted = await tx
    .insert(patients)
    .values({
      id: patientId,
      uhid,
      name: input.name,
      phone: input.phone ?? null,
      altPhone: input.altPhone ?? null,
      dob,
      dobEstimated,
      sex: input.sex,
      addressLine: input.addressLine ?? null,
      district: input.district ?? null,
      stateName: input.stateName ?? null,
      pincode: input.pincode ?? null,
      language: input.language ?? "hi",
      bloodGroup: input.bloodGroup ?? null,
      isConfidential,
      alias: input.alias ?? null,
      sensitiveContext: input.sensitiveContext ?? false,
      abhaAddress: input.abhaAddress ?? null,
      abhaNumber: input.abhaNumber ?? null,
      abhaVerificationStatus: input.abhaVerificationStatus ?? "none",
      legacyUhid: input.legacyUhid ?? null,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    .returning();
  const patient = inserted[0]!;

  let guardianId: string | null = null;
  if (input.guardian !== undefined) {
    const g = input.guardian;
    guardianId = newId();
    await tx.insert(patientGuardians).values({
      id: guardianId,
      patientId,
      name: g.name,
      phone: g.phone ?? null,
      relationship: g.relationship,
      idType: g.idType ?? null,
      idNumberMasked: g.idNumberMasked ?? null,
      idVerified: g.idVerified ?? false,
      authorityMessages: g.authorityMessages ?? true,
      authorityConsents: g.authorityConsents ?? true,
      authorityDsr: g.authorityDsr ?? false,
      authorityBills: g.authorityBills ?? true,
      consentNote: g.consentNote ?? null,
      createdBy: actor.id,
    });
  }

  await appendEvent(
    tx,
    patientRegistered.make({
      actor,
      patientId,
      payload: { patientId, uhid, name: patient.name, phone: patient.phone, language: patient.language },
    }),
  );
  if (guardianId !== null) {
    const g = input.guardian!;
    await appendEvent(
      tx,
      guardianLinked.make({
        actor,
        patientId,
        payload: {
          patientId,
          guardianId,
          relationship: g.relationship,
          authority: {
            messages: g.authorityMessages ?? true,
            consents: g.authorityConsents ?? true,
            dsr: g.authorityDsr ?? false,
            bills: g.authorityBills ?? true,
          },
        },
      }),
    );
  }
  return { patient, guardianId };
}

/** The patchable surface. uhid / qrVersion / status / mergedIntoPatientId are structurally absent. */
export type PatientPatch = Partial<{
  name: string;
  phone: string | null;
  altPhone: string | null;
  dob: Date | null;
  dobEstimated: boolean;
  sex: Sex;
  addressLine: string | null;
  district: string | null;
  stateName: string | null;
  pincode: string | null;
  language: PatientLanguage;
  bloodGroup: BloodGroup | null;
  isConfidential: boolean;
  alias: string | null;
  sensitiveContext: boolean;
  abhaAddress: string | null;
  abhaNumber: string | null;
  abhaVerificationStatus: AbhaVerificationStatus;
  abhaLinkToken: string | null;
  legacyUhid: string | null;
}>;

const PATCHABLE = [
  "name", "phone", "altPhone", "dob", "dobEstimated", "sex", "addressLine", "district",
  "stateName", "pincode", "language", "bloodGroup", "isConfidential", "alias",
  "sensitiveContext", "abhaAddress", "abhaNumber", "abhaVerificationStatus",
  "abhaLinkToken", "legacyUhid",
] as const;

function asAuditString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export async function updatePatient(
  tx: Tx,
  actor: Actor,
  patientId: string,
  patch: PatientPatch,
): Promise<{ patient: PatientRow; changed: string[] }> {
  if (actor.type !== "user") {
    throw new PatientError("user_actor_required", "only user actors update patients");
  }
  const rows = await tx.select().from(patients).where(eq(patients.id, patientId));
  const current = rows[0];
  if (!current) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  if (current.status !== "active") {
    throw new PatientError("patient_not_active", "a merged record is frozen — edit the canonical patient");
  }

  const changes: { field: string; from: string | null; to: string | null }[] = [];
  const set: Record<string, unknown> = {};
  for (const field of PATCHABLE) {
    if (!(field in patch)) continue;
    const next = (patch as Record<string, unknown>)[field];
    const prev = (current as Record<string, unknown>)[field];
    const prevS = asAuditString(prev);
    const nextS = asAuditString(next);
    if (prevS === nextS) continue;
    changes.push({ field, from: prevS, to: nextS });
    set[field] = next ?? null;
  }
  if (changes.length === 0) return { patient: current, changed: [] };

  const resultingConfidential = (set.isConfidential as boolean | undefined) ?? current.isConfidential;
  const resultingAlias = "alias" in set ? (set.alias as string | null) : current.alias;
  if (resultingConfidential && (resultingAlias ?? "").trim() === "") {
    throw new PatientError("alias_required", "a confidential patient needs an alias (§14)");
  }

  const updated = await tx
    .update(patients)
    .set({ ...set, updatedBy: actor.id, updatedAt: new Date() })
    .where(and(eq(patients.id, patientId), eq(patients.status, "active")))
    .returning();
  if (updated.length === 0) {
    // Lost a race against a merge freeze between the read and the write.
    throw new PatientError("patient_not_active", "patient was frozen concurrently");
  }
  await appendEvent(
    tx,
    patientUpdated.make({ actor, patientId, payload: { patientId, changes } }),
  );
  return { patient: updated[0]!, changed: changes.map((c) => c.field) };
}

const MERGE_CHAIN_MAX_HOPS = 5;

async function followMergeChain(
  db: Db,
  patientId: string,
): Promise<{ row: PatientRow; resolvedFrom: string | null } | null> {
  let currentId = patientId;
  for (let hop = 0; hop <= MERGE_CHAIN_MAX_HOPS; hop++) {
    const rows = await db.select().from(patients).where(eq(patients.id, currentId));
    const row = rows[0];
    if (!row) return null;
    if (row.status !== "merged" || row.mergedIntoPatientId === null) {
      return { row, resolvedFrom: currentId === patientId ? null : patientId };
    }
    currentId = row.mergedIntoPatientId;
  }
  throw new Error(`merge chain deeper than ${MERGE_CHAIN_MAX_HOPS} hops from ${patientId} — data corruption, investigate`);
}

/**
 * Chain-resolving read with the §14 confidential gate: flagged patients are existence-hidden
 * (null, indistinguishable from not-found) from user actors without patients.confidential.read
 * and from agent actors (Plan 12 seam). system actors pass — internal machinery must resolve.
 * D-37: the flag gates VISIBILITY only; nothing anywhere orders or prioritizes on it.
 */
export async function getPatient(
  db: Db,
  actor: Actor,
  patientId: string,
): Promise<{ patient: PatientRow; resolvedFrom: string | null } | null> {
  const resolved = await followMergeChain(db, patientId);
  if (!resolved) return null;
  if (resolved.row.isConfidential && actor.type !== "system") {
    if (actor.type === "agent") return null;
    const allowed = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
    if (!allowed) return null;
  }
  return { patient: resolved.row, resolvedFrom: resolved.resolvedFrom };
}

/** Id mapping only — no demographics, no gate (§6: later modules resolve ids, they never copy data). */
export async function resolvePatientId(db: Db, patientId: string): Promise<string | null> {
  const resolved = await followMergeChain(db, patientId);
  return resolved ? resolved.row.id : null;
}
```

- [ ] **Step 4: Run the tests, then full verify + commit**

Run: `pnpm --filter @hmis/core test -- registration` → PASS (9 tests). Then `pnpm verify` (unpiped) → exit 0.

```bash
git add apps/core
git commit -m "feat(patients): events, manifest, registration service — UHID at register, minor guardian rule, confidential gate, merge-chain reads"
```

---

### Task 4: Phone-first search + the CI-gated performance budget

**Files:**
- Create: `apps/core/src/modules/patients/search.ts`
- Create: `apps/core/src/modules/patients/search.test.ts`
- Create: `apps/core/test/perf-patient-search.test.ts`

**Interfaces:**
- Consumes: tables (T1), `hasPermission` (kernel auth), `isValidUhid`-adjacent shape regex (its own — a typo'd check digit must still be *searchable*, so search matches the UHID *shape*, not validity), `PatientError` (T2), `Actor`.
- Produces (exact — T9's controller and the web app consume):
  - `type PatientSearchResult = { id: string; uhid: string; name: string; phone: string | null; sex: string; dob: Date | null; isConfidential: boolean; hasPhoto: boolean }`
  - `searchPatients(db: Db, actor: Actor, q: string, limit?: number): Promise<PatientSearchResult[]>` — user-actor-only; trims; `< 2` chars → `[]`; shape dispatch: `/^\d{3,14}$/` → phone OR alt-phone prefix; `/^[A-Za-z]{2,5}-\d{8}-\d$/` → exact UHID (uppercased); else name prefix on `lower(name)` with LIKE metacharacters escaped. Always `status = 'active'`; confidential rows excluded unless the caller holds `patients.confidential.read` (resolved ONCE per call). `hasPhoto` via a LEFT JOIN selecting **only** `patient_photos.patient_id` — bytes never load on the search path. Ordered by `name` asc (D-37: nothing orders on the confidential flag), `limit` capped at 50, default 20.

- [ ] **Step 1: Write the failing functional tests**

`apps/core/src/modules/patients/search.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { patientPhotos, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patientsManifest } from "./manifest";
import { registerPatient } from "./registration";
import { searchPatients } from "./search";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };

describe("searchPatients", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
  });

  async function seedThree(): Promise<{ ashaUhid: string }> {
    const asha = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Asha Devi", sex: "female", phone: "9876543210" }),
    );
    await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Ashok Kumar", sex: "male", phone: "9876500000", altPhone: "8000000001" }),
    );
    await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Binod Singh", sex: "male", phone: "7012345678" }),
    );
    return { ashaUhid: asha.patient.uhid };
  }

  it("digit queries search phone AND alt-phone by prefix", async () => {
    await seedThree();
    const both = await searchPatients(db, clerk, "98765");
    expect(both.map((r) => r.name).sort()).toEqual(["Asha Devi", "Ashok Kumar"]);
    const viaAlt = await searchPatients(db, clerk, "80000");
    expect(viaAlt.map((r) => r.name)).toEqual(["Ashok Kumar"]);
  });

  it("UHID-shaped queries match exactly, case-insensitively on the prefix", async () => {
    const { ashaUhid } = await seedThree();
    const hits = await searchPatients(db, clerk, ashaUhid.toLowerCase());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.uhid).toBe(ashaUhid);
  });

  it("text queries search name by case-insensitive prefix, with LIKE metacharacters inert", async () => {
    await seedThree();
    const hits = await searchPatients(db, clerk, "ash");
    expect(hits.map((r) => r.name)).toEqual(["Asha Devi", "Ashok Kumar"]); // name asc
    expect(await searchPatients(db, clerk, "sha")).toEqual([]); // prefix, not substring — deliberate Phase-1 scope
    expect(await searchPatients(db, clerk, "a%")).toEqual([]); // % is a literal, matches nobody
  });

  it("returns hasPhoto without ever selecting bytes", async () => {
    await seedThree();
    const asha = (await searchPatients(db, clerk, "9876543210"))[0]!;
    expect(asha.hasPhoto).toBe(false);
    await db.insert(patientPhotos).values({
      patientId: asha.id, mimeType: "image/jpeg", bytes: Buffer.from([0xff]), updatedBy: "t",
    });
    expect((await searchPatients(db, clerk, "9876543210"))[0]!.hasPhoto).toBe(true);
  });

  it("excludes confidential patients unless the caller holds patients.confidential.read", async () => {
    const registry = new ModuleRegistry();
    registry.install(patientsManifest);
    await syncPermissions(db, registry);
    await createRole(db, "vip_desk", "VIP Desk");
    await grantPermissionToRole(db, registry, "vip_desk", "patients.confidential.read");
    const holder = await createUser(db, { username: "holder2", fullName: "H", password: "p1234567" });
    await assignRole(db, { userId: holder.id, roleKey: "vip_desk", scopeType: "hospital" });

    await withTx(db, (tx) =>
      registerPatient(tx, clerk, {
        name: "Vip Person", sex: "male", phone: "9111111111", isConfidential: true, alias: "Patient V",
      }),
    );
    expect(await searchPatients(db, clerk, "9111111111")).toEqual([]);
    const seen = await searchPatients(db, { type: "user", id: holder.id }, "9111111111");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.isConfidential).toBe(true);
  });

  it("short and non-user queries", async () => {
    await seedThree();
    expect(await searchPatients(db, clerk, " 9 ")).toEqual([]); // trimmed length < 2
    await expect(searchPatients(db, { type: "agent", id: "a1" }, "asha")).rejects.toMatchObject({
      code: "user_actor_required",
    });
  });
});
```

Run: `pnpm --filter @hmis/core test -- search` — expect FAIL at import. Fail-first evidence.

- [ ] **Step 2: Implement `search.ts`**

`apps/core/src/modules/patients/search.ts`:
```ts
import { and, asc, eq, like, or, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { patientPhotos, patients } from "../../kernel/db/schema";
import { PatientError } from "./uhid";
import type { Db } from "../../kernel/db/client";

export type PatientSearchResult = {
  id: string;
  uhid: string;
  name: string;
  phone: string | null;
  sex: string;
  dob: Date | null;
  isConfidential: boolean;
  hasPhoto: boolean;
};

const PHONE_RE = /^\d{3,14}$/;
const UHID_SHAPE_RE = /^[A-Za-z]{2,5}-\d{8}-\d$/; // shape, not validity: a typo'd check digit must still be searchable

/** Escape LIKE metacharacters so user text is always literal. Postgres default escape is backslash. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Phone-first patient search (§11.1 entry lanes; §15 <300 ms budget — CI-enforced by
 * test/perf-patient-search.test.ts). Prefix-only by design: every branch is served by a
 * text_pattern_ops btree index; substring/fuzzy search arrives with MRD (pg_trgm), not here.
 */
export async function searchPatients(
  db: Db,
  actor: Actor,
  q: string,
  limit = 20,
): Promise<PatientSearchResult[]> {
  if (actor.type !== "user") {
    throw new PatientError("user_actor_required", "search is a desk surface — user actors only");
  }
  const query = q.trim();
  if (query.length < 2) return [];
  const cap = Math.min(Math.max(limit, 1), 50);

  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");

  const conditions = [eq(patients.status, "active")];
  if (!canSeeConfidential) conditions.push(eq(patients.isConfidential, false));

  if (PHONE_RE.test(query)) {
    const prefix = `${query}%`;
    conditions.push(or(like(patients.phone, prefix), like(patients.altPhone, prefix))!);
  } else if (UHID_SHAPE_RE.test(query)) {
    conditions.push(eq(patients.uhid, query.toUpperCase()));
  } else {
    const prefix = `${escapeLike(query.toLowerCase())}%`;
    conditions.push(sql`lower(${patients.name}) like ${prefix}`);
  }

  const rows = await db
    .select({
      id: patients.id,
      uhid: patients.uhid,
      name: patients.name,
      phone: patients.phone,
      sex: patients.sex,
      dob: patients.dob,
      isConfidential: patients.isConfidential,
      photoPatientId: patientPhotos.patientId, // ONLY the id column — bytes never load here
    })
    .from(patients)
    .leftJoin(patientPhotos, eq(patientPhotos.patientId, patients.id))
    .where(and(...conditions))
    .orderBy(asc(patients.name)) // D-37: ordering never touches the confidential flag
    .limit(cap);

  return rows.map((r) => ({
    id: r.id,
    uhid: r.uhid,
    name: r.name,
    phone: r.phone,
    sex: r.sex,
    dob: r.dob,
    isConfidential: r.isConfidential,
    hasPhoto: r.photoPatientId !== null,
  }));
}
```

- [ ] **Step 3: Write the perf gate (this file is the roadmap's "test-enforced from Plan 05 on", made real)**

`apps/core/test/perf-patient-search.test.ts`:
```ts
import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { registrationConfig } from "../src/kernel/db/schema";
import { getPatient } from "../src/modules/patients/registration";
import { searchPatients } from "../src/modules/patients/search";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

const clerk: Actor = { type: "user", id: "perf-user" };
const SEED_ROWS = 200_000;
const SEARCH_BUDGET_MS = 300; // §15 patient search
const GET_BUDGET_MS = 100; // §15 interactive, applied to the hot read API

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Recursively collect every "Node Type" in an EXPLAIN (FORMAT JSON) plan tree. */
function nodeTypes(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) nodeTypes(n, out);
  } else if (node !== null && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (typeof rec["Node Type"] === "string") out.push(rec["Node Type"] as string);
    for (const v of Object.values(rec)) nodeTypes(v, out);
  }
  return out;
}

describe("patient search performance budget (CI-gated — owner decision Q7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let knownId: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "perf" });
    // One statement, ~2–5 s: synthetic but index-realistic. Check digits are dummies —
    // the perf suite never validates UHIDs, it measures the query paths.
    await db.execute(sql`
      insert into patients (id, uhid, name, phone, sex, language, status, created_by, updated_by)
      select
        'PERF' || lpad(gs::text, 22, '0'),
        'PRF-' || lpad(gs::text, 8, '0') || '-0',
        'Perf Patient ' || gs::text,
        '9' || lpad((100000000 + gs)::text, 9, '0'),
        'other', 'hi', 'active', 'perf-seed', 'perf-seed'
      from generate_series(1, ${sql.raw(String(SEED_ROWS))}) gs
    `);
    await db.execute(sql`analyze patients`);
    knownId = "PERF" + "100000".padStart(22, "0");
    await searchPatients(db, clerk, "9100050"); // warm the path once before timing
  }, 120_000);

  afterAll(async () => {
    await truncateAll(db); // do not leave 200k rows for the next suite's truncate to pay for
    await teardown();
  });

  it(`phone-prefix search median over 5 runs is under ${SEARCH_BUDGET_MS} ms at ${SEED_ROWS} rows`, async () => {
    const prefixes = ["9100050", "9100123", "9100199", "9100001", "9100175"]; // ~1,000 matches each
    const times: number[] = [];
    for (const p of prefixes) {
      const t0 = performance.now();
      const hits = await searchPatients(db, clerk, p);
      times.push(performance.now() - t0);
      expect(hits.length).toBeGreaterThan(0);
    }
    // eslint-disable-next-line no-console
    console.log(`search timings ms: ${times.map((t) => t.toFixed(1)).join(", ")} (median ${median(times).toFixed(1)})`);
    expect(median(times)).toBeLessThan(SEARCH_BUDGET_MS);
  });

  it(`getPatient median over 5 runs is under ${GET_BUDGET_MS} ms`, async () => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const hit = await getPatient(db, clerk, knownId);
      times.push(performance.now() - t0);
      expect(hit).not.toBeNull();
    }
    expect(median(times)).toBeLessThan(GET_BUDGET_MS);
  });

  it("the phone search predicate is served by an index — no Seq Scan on patients", async () => {
    const res = await db.execute(sql`
      explain (format json)
      select id from patients
      where status = 'active' and is_confidential = false
        and (phone like '9100050%' or alt_phone like '9100050%')
      order by name asc limit 20
    `);
    const raw = res.rows[0]!["QUERY PLAN"];
    const plan: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    const types = nodeTypes(plan);
    expect(types.length).toBeGreaterThan(0);
    expect(types).not.toContain("Seq Scan");
  });

  it("the name-prefix predicate is served by the lower(name) expression index — no Seq Scan", async () => {
    const res = await db.execute(sql`
      explain (format json)
      select id from patients
      where status = 'active' and is_confidential = false
        and lower(name) like 'perf patient 19999%'
      order by name asc limit 20
    `);
    const raw = res.rows[0]!["QUERY PLAN"];
    const plan: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    expect(nodeTypes(plan)).not.toContain("Seq Scan");
  });
});
```

- [ ] **Step 4: Run everything, then full verify + commit**

Run: `pnpm --filter @hmis/core test -- search` → PASS (6 functional). Run: `pnpm --filter @hmis/core test -- perf-patient-search` → PASS (4), and **quote the printed search timings in your report** — the execution session records a 1M-row variant on the server in the gate report. Then `pnpm verify` (unpiped) → exit 0.

```bash
git add apps/core
git commit -m "feat(patients): phone-first search + CI-gated perf budget — 200k rows, median<300ms, no-seq-scan plan assertions"
```

---

### Task 5: Photos (C-18's prompt source) + allergies with the entered-in-error grammar

**Files:**
- Create: `apps/core/src/modules/patients/photos.ts`
- Create: `apps/core/src/modules/patients/allergies.ts`
- Create: `apps/core/src/modules/patients/photos.test.ts`
- Create: `apps/core/src/modules/patients/allergies.test.ts`

**Interfaces:**
- Consumes: tables (T1), events (T3), `getPatient` (T3 — the photo read reuses its gate + chain resolution), `PatientError`, `appendEvent`, `newId`.
- Produces (exact):
  - `PHOTO_MAX_BYTES = 512_000` (const)
  - `storePatientPhoto(tx: Tx, actor: Actor, patientId: string, input: { mimeType: string; bytes: Buffer }): Promise<void>` — user-only; `image/jpeg` only (`unsupported_photo_type`); cap (`photo_too_large`); patient must exist and be `active`; **upsert** (one current photo — `onConflictDoUpdate` on the PK); emits `patient.updated` with `changes: [{ field: "photo", from: null, to: null }]` (bytes never enter an event).
  - `getPatientPhoto(db: Db, actor: Actor, patientId: string): Promise<{ mimeType: string; bytes: Buffer } | null>` — **implemented over `getPatient`**, so the merge chain resolves and the §14 confidential gate applies identically; a photo is exactly as visible as its patient.
  - `addAllergy(tx: Tx, actor: Actor, patientId: string, input: { substance: string; reaction?: string; severity?: "mild" | "moderate" | "severe"; source: "registration" | "vitals" | "consult" }): Promise<{ allergyId: string }>` — user-only; patient `active`; emits `allergy.recorded`.
  - `listAllergies(db: Db, patientId: string): Promise<AllergyRow[]>` — all statuses, newest first (the UI strikes through corrected entries; the trail stays visible — E-8).
  - `markAllergyEnteredInError(tx: Tx, actor: Actor, allergyId: string, reason: string): Promise<void>` — user-only; **reason mandatory at runtime** (`reason_required`, trimmed, before any DB read — the Plan 03 T8 lesson); single-winner conditional UPDATE `active → entered_in_error` (loser: `allergy_not_active`); emits `correction.entered_in_error`. **No delete path exists.**
  - `type AllergyRow = typeof patientAllergies.$inferSelect`

- [ ] **Step 1: Write the failing tests**

`apps/core/src/modules/patients/photos.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, registrationConfig } from "../../kernel/db/schema";
import { eq } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { registerPatient } from "./registration";
import { PHOTO_MAX_BYTES, getPatientPhoto, storePatientPhoto } from "./photos";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };

describe("patient photos", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" });
  });

  async function newPatient(): Promise<string> {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Asha Devi", sex: "female", phone: "9876543210" }),
    );
    return patient.id;
  }

  it("stores, replaces (upsert), and reads back a photo; each store events a photo change", async () => {
    const id = await newPatient();
    const v1 = Buffer.from([0xff, 0xd8, 1]);
    const v2 = Buffer.from([0xff, 0xd8, 2]);
    await withTx(db, (tx) => storePatientPhoto(tx, clerk, id, { mimeType: "image/jpeg", bytes: v1 }));
    await withTx(db, (tx) => storePatientPhoto(tx, clerk, id, { mimeType: "image/jpeg", bytes: v2 }));
    const read = await getPatientPhoto(db, clerk, id);
    expect(Buffer.compare(read!.bytes, v2)).toBe(0);

    const evs = await db.select().from(events).where(eq(events.name, "patient.updated"));
    expect(evs).toHaveLength(2);
    const payload = evs[0]!.payload as { changes: { field: string; from: null; to: null }[] };
    expect(payload.changes).toEqual([{ field: "photo", from: null, to: null }]);
  });

  it("enforces the byte cap and the jpeg-only rule", async () => {
    const id = await newPatient();
    await expect(
      withTx(db, (tx) =>
        storePatientPhoto(tx, clerk, id, { mimeType: "image/jpeg", bytes: Buffer.alloc(PHOTO_MAX_BYTES + 1) }),
      ),
    ).rejects.toMatchObject({ code: "photo_too_large" });
    await expect(
      withTx(db, (tx) =>
        storePatientPhoto(tx, clerk, id, { mimeType: "image/png", bytes: Buffer.from([1]) }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_photo_type" });
    expect(await getPatientPhoto(db, clerk, id)).toBeNull();
  });

  it("agent actors resolve non-confidential photos (the gate itself is getPatient's, tested in T3)", async () => {
    const id = await newPatient();
    await withTx(db, (tx) => storePatientPhoto(tx, clerk, id, { mimeType: "image/jpeg", bytes: Buffer.from([7]) }));
    // agent actors are gated exactly like getPatient (null, not bytes)
    expect(await getPatientPhoto(db, { type: "agent", id: "a1" }, id)).not.toBeNull(); // non-confidential: agents may resolve
  });

  it("refuses unknown and non-user callers", async () => {
    await expect(
      withTx(db, (tx) =>
        storePatientPhoto(tx, clerk, "01NOSUCH00000000000000000", { mimeType: "image/jpeg", bytes: Buffer.from([1]) }),
      ),
    ).rejects.toMatchObject({ code: "patient_not_found" });
    const id = await newPatient();
    await expect(
      withTx(db, (tx) =>
        storePatientPhoto(tx, { type: "system", id: "s" }, id, { mimeType: "image/jpeg", bytes: Buffer.from([1]) }),
      ),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });
});
```

`apps/core/src/modules/patients/allergies.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { registerPatient } from "./registration";
import { addAllergy, listAllergies, markAllergyEnteredInError } from "./allergies";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };

describe("allergies", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" });
  });

  async function newPatient(): Promise<string> {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Asha Devi", sex: "female" }),
    );
    return patient.id;
  }

  it("records an allergy with its event", async () => {
    const id = await newPatient();
    const { allergyId } = await withTx(db, (tx) =>
      addAllergy(tx, clerk, id, { substance: "penicillin", severity: "severe", source: "registration" }),
    );
    const list = await listAllergies(db, id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(allergyId);
    expect(list[0]!.status).toBe("active");

    const evs = await db.select().from(events).where(eq(events.name, "allergy.recorded"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.patientId).toBe(id);
    const payload = evs[0]!.payload as { substance: string; severity: string | null };
    expect(payload.substance).toBe("penicillin");
    expect(payload.severity).toBe("severe");
  });

  it("corrects via entered_in_error: mandatory reason, status flip, correction event, row retained", async () => {
    const id = await newPatient();
    const { allergyId } = await withTx(db, (tx) =>
      addAllergy(tx, clerk, id, { substance: "sulfa", source: "registration" }),
    );
    await expect(
      withTx(db, (tx) => markAllergyEnteredInError(tx, clerk, allergyId, "   ")),
    ).rejects.toMatchObject({ code: "reason_required" });

    await withTx(db, (tx) => markAllergyEnteredInError(tx, clerk, allergyId, "wrong patient selected"));
    const list = await listAllergies(db, id);
    expect(list).toHaveLength(1); // never deleted — the trail stays (E-8)
    expect(list[0]!.status).toBe("entered_in_error");
    expect(list[0]!.correctionReason).toBe("wrong patient selected");

    const evs = await db.select().from(events).where(eq(events.name, "correction.entered_in_error"));
    expect(evs).toHaveLength(1);
    const payload = evs[0]!.payload as { entity: string; entityId: string; reason: string };
    expect(payload.entity).toBe("allergy");
    expect(payload.entityId).toBe(allergyId);

    // double-correction loses the conditional UPDATE
    await expect(
      withTx(db, (tx) => markAllergyEnteredInError(tx, clerk, allergyId, "again")),
    ).rejects.toMatchObject({ code: "allergy_not_active" });
  });

  it("unknown ids and non-user actors are refused", async () => {
    const id = await newPatient();
    await expect(
      withTx(db, (tx) => addAllergy(tx, { type: "agent", id: "a" }, id, { substance: "x", source: "registration" })),
    ).rejects.toMatchObject({ code: "user_actor_required" });
    await expect(
      withTx(db, (tx) => markAllergyEnteredInError(tx, clerk, "01NOSUCH00000000000000000", "r")),
    ).rejects.toMatchObject({ code: "allergy_not_found" });
  });
});
```

Run: `pnpm --filter @hmis/core test -- "photos|allergies"` — expect FAIL at import. Fail-first evidence.

- [ ] **Step 2: Implement**

`apps/core/src/modules/patients/photos.ts`:
```ts
import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { patientPhotos, patients } from "../../kernel/db/schema";
import { patientUpdated } from "./events";
import { getPatient } from "./registration";
import { PatientError } from "./uhid";
import type { Db, Tx } from "../../kernel/db/client";

/** Server-side cap; the web client downscales to ~640px JPEG (~50–200 KB) before upload. */
export const PHOTO_MAX_BYTES = 512_000;

export async function storePatientPhoto(
  tx: Tx,
  actor: Actor,
  patientId: string,
  input: { mimeType: string; bytes: Buffer },
): Promise<void> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  if (input.mimeType !== "image/jpeg") {
    throw new PatientError("unsupported_photo_type", "photos are image/jpeg only in v1");
  }
  if (input.bytes.length > PHOTO_MAX_BYTES) {
    throw new PatientError("photo_too_large", `photo exceeds ${PHOTO_MAX_BYTES} bytes — the client must downscale`);
  }
  const rows = await tx.select({ id: patients.id, status: patients.status }).from(patients).where(eq(patients.id, patientId));
  if (rows.length === 0) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  if (rows[0]!.status !== "active") throw new PatientError("patient_not_active", "store the photo on the canonical patient");

  await tx
    .insert(patientPhotos)
    .values({ patientId, mimeType: input.mimeType, bytes: input.bytes, updatedBy: actor.id })
    .onConflictDoUpdate({
      target: patientPhotos.patientId,
      set: { mimeType: input.mimeType, bytes: input.bytes, updatedBy: actor.id, updatedAt: new Date() },
    });
  await appendEvent(
    tx,
    patientUpdated.make({
      actor,
      patientId,
      payload: { patientId, changes: [{ field: "photo", from: null, to: null }] },
    }),
  );
}

/**
 * Reads THROUGH getPatient: merge chain resolved, §14 confidential gate identical — a photo
 * is exactly as visible as its patient. C-18's attach prompt calls this.
 */
export async function getPatientPhoto(
  db: Db,
  actor: Actor,
  patientId: string,
): Promise<{ mimeType: string; bytes: Buffer } | null> {
  const resolved = await getPatient(db, actor, patientId);
  if (!resolved) return null;
  const rows = await db
    .select({ mimeType: patientPhotos.mimeType, bytes: patientPhotos.bytes })
    .from(patientPhotos)
    .where(eq(patientPhotos.patientId, resolved.patient.id));
  return rows[0] ?? null;
}
```

`apps/core/src/modules/patients/allergies.ts`:
```ts
import { and, desc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { patientAllergies, patients } from "../../kernel/db/schema";
import { allergyRecorded, correctionEnteredInError } from "./events";
import { PatientError } from "./uhid";
import type { Db, Tx } from "../../kernel/db/client";

export type AllergyRow = typeof patientAllergies.$inferSelect;

export async function addAllergy(
  tx: Tx,
  actor: Actor,
  patientId: string,
  input: {
    substance: string;
    reaction?: string;
    severity?: "mild" | "moderate" | "severe";
    source: "registration" | "vitals" | "consult";
  },
): Promise<{ allergyId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const rows = await tx.select({ status: patients.status }).from(patients).where(eq(patients.id, patientId));
  if (rows.length === 0) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  if (rows[0]!.status !== "active") throw new PatientError("patient_not_active", "record allergies on the canonical patient");

  const allergyId = newId();
  await tx.insert(patientAllergies).values({
    id: allergyId,
    patientId,
    substance: input.substance,
    reaction: input.reaction ?? null,
    severity: input.severity ?? null,
    source: input.source,
    recordedBy: actor.id,
  });
  await appendEvent(
    tx,
    allergyRecorded.make({
      actor,
      patientId,
      payload: {
        patientId,
        allergyId,
        substance: input.substance,
        severity: input.severity ?? null,
        source: input.source,
      },
    }),
  );
  return { allergyId };
}

/** All statuses, newest first — corrected entries render struck-through, never vanish (E-8). */
export async function listAllergies(db: Db, patientId: string): Promise<AllergyRow[]> {
  return db
    .select()
    .from(patientAllergies)
    .where(eq(patientAllergies.patientId, patientId))
    .orderBy(desc(patientAllergies.recordedAt));
}

export async function markAllergyEnteredInError(
  tx: Tx,
  actor: Actor,
  allergyId: string,
  reason: string,
): Promise<void> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed === "") throw new PatientError("reason_required", "a correction needs a reason (E-8)");

  const rows = await tx.select().from(patientAllergies).where(eq(patientAllergies.id, allergyId));
  const row = rows[0];
  if (!row) throw new PatientError("allergy_not_found", `unknown allergy ${allergyId}`);

  const updated = await tx
    .update(patientAllergies)
    .set({ status: "entered_in_error", correctedBy: actor.id, correctedAt: new Date(), correctionReason: trimmed })
    .where(and(eq(patientAllergies.id, allergyId), eq(patientAllergies.status, "active")))
    .returning({ id: patientAllergies.id });
  if (updated.length === 0) {
    throw new PatientError("allergy_not_active", "already corrected");
  }
  await appendEvent(
    tx,
    correctionEnteredInError.make({
      actor,
      patientId: row.patientId,
      payload: { entity: "allergy", entityId: allergyId, patientId: row.patientId, reason: trimmed },
    }),
  );
}
```

- [ ] **Step 3: Run the tests, then full verify + commit**

Run: `pnpm --filter @hmis/core test -- "photos|allergies"` → PASS (7 tests). Then `pnpm verify` (unpiped) → exit 0.

```bash
git add apps/core
git commit -m "feat(patients): photo storage with cap + allergies with entered-in-error correction grammar"
```

---

### Task 6: Guardians — authority scope, read-time majority, the fourth unscheduled sweep

**Files:**
- Create: `apps/core/src/modules/patients/guardians.ts`
- Create: `apps/core/src/modules/patients/guardians.test.ts`

**Interfaces:**
- Consumes: tables (T1), events (T3), `GuardianInput`/`PatientRow` (T3), `yearsBetween`/`MAJORITY_AGE_YEARS` (T3), `PatientError`, `appendEvent`, `newId`.
- Produces (exact — T9's controller, T10's e2e, and Plan 10's message routing consume):
  - `type GuardianRow = typeof patientGuardians.$inferSelect`
  - `type GuardianAuthority = { messages: boolean; consents: boolean; dsr: boolean; bills: boolean }` · `NO_AUTHORITY` (all false)
  - `linkGuardian(tx, actor, patientId, input: GuardianInput): Promise<{ guardianId: string }>` — user-only, patient `active`; emits `guardian.linked`.
  - `updateGuardianAuthority(tx, actor, guardianId, patch: Partial<GuardianAuthority> & { phone?: string | null; idVerified?: boolean; validTo?: Date | null; consentNote?: string | null }): Promise<void>` — guardian must be `active`; emits `guardian.authority_changed` (`reason: "update"`) whose payload carries the **effective** authority after the change (computed, not stored — an already-major patient's guardian events all-false, honestly).
  - `endGuardian(tx, actor, guardianId): Promise<void>` — single-winner `active → ended`; emits `reason: "ended"`, authority all-false.
  - `effectiveGuardianAuthority(patient: PatientRow, guardian: GuardianRow, now?: Date): GuardianAuthority` — **pure; THE enforcement point** (owner decision Q4). All-false when: guardian not `active` · `validTo` passed · patient's known DOB ≥ 18 years. Then the D-31 sensitive-context override: `patient.sensitiveContext` forces `messages: false` regardless of the stored flag (POCSO/abuse/adolescent-confidentiality seal the guardian message channel; consent/bills authority is a separate legal question and stays per-flags).
  - `sweepGuardianMajority(db: Db, now?: Date): Promise<number>` — **the fourth unscheduled sweep** (owner decision Q4): one transaction, one status-discriminated `UPDATE … FROM patients … RETURNING` claiming every `active` guardian whose patient's DOB is ≥ 18 years old, then one `guardian.authority_changed` (`reason: "majority"`, all-false) per claimed row, same transaction. Idempotent (second run: 0); concurrency-safe (the `status = 'active'` predicate re-evaluates under READ COMMITTED — two racing sweeps split the rows, never double-fire). **No scheduler anywhere; Plan 11 registers the pg-boss cron.**

- [ ] **Step 1: Write the failing tests**

`apps/core/src/modules/patients/guardians.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, patientGuardians, patients, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { registerPatient } from "./registration";
import {
  NO_AUTHORITY, effectiveGuardianAuthority, endGuardian, linkGuardian,
  sweepGuardianMajority, updateGuardianAuthority,
} from "./guardians";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };
const NOW = new Date(Date.UTC(2026, 7, 13)); // fixed clock for age arithmetic

function dobAged(years: number, extraDays = 0): Date {
  const d = new Date(Date.UTC(2026 - years, 7, 13));
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d;
}

describe("guardians", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" });
  });

  async function minorWithGuardian(dob: Date, sensitive = false): Promise<{ patientId: string; guardianId: string }> {
    const { patient, guardianId } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, {
        name: "Minor P", sex: "other", dob, sensitiveContext: sensitive,
        guardian: { name: "G", relationship: "father", phone: "9800000000" },
      }),
    );
    return { patientId: patient.id, guardianId: guardianId! };
  }

  it("effectiveGuardianAuthority: full for an active minor's guardian; messages sealed under sensitive context", async () => {
    const { patientId, guardianId } = await minorWithGuardian(dobAged(10));
    const patient = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!;
    const guardian = (await db.select().from(patientGuardians).where(eq(patientGuardians.id, guardianId)))[0]!;
    expect(effectiveGuardianAuthority(patient, guardian, NOW)).toEqual({
      messages: true, consents: true, dsr: false, bills: true,
    });

    const sealed = await minorWithGuardian(dobAged(12), true);
    const p2 = (await db.select().from(patients).where(eq(patients.id, sealed.patientId)))[0]!;
    const g2 = (await db.select().from(patientGuardians).where(eq(patientGuardians.id, sealed.guardianId)))[0]!;
    expect(effectiveGuardianAuthority(p2, g2, NOW)).toEqual({
      messages: false, consents: true, dsr: false, bills: true, // ONLY the message channel seals (D-31)
    });
  });

  it("read-time enforcement: authority is all-false the moment the patient is 18 — row still 'active'", async () => {
    const { patientId, guardianId } = await minorWithGuardian(dobAged(17, -1)); // 18 in ~a day... registered as minor
    const patient = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!;
    const guardian = (await db.select().from(patientGuardians).where(eq(patientGuardians.id, guardianId)))[0]!;
    expect(guardian.status).toBe("active");
    const at18 = new Date(Date.UTC(2027, 7, 14));
    expect(effectiveGuardianAuthority(patient, guardian, at18)).toEqual(NO_AUTHORITY);
    // and an explicit validTo in the past does the same
    await withTx(db, (tx) => updateGuardianAuthority(tx, clerk, guardianId, { validTo: new Date(Date.UTC(2020, 0, 1)) }));
    const g2 = (await db.select().from(patientGuardians).where(eq(patientGuardians.id, guardianId)))[0]!;
    expect(effectiveGuardianAuthority(patient, g2, NOW)).toEqual(NO_AUTHORITY);
  });

  it("updateGuardianAuthority events the EFFECTIVE authority; endGuardian is single-winner", async () => {
    const { guardianId } = await minorWithGuardian(dobAged(10));
    await withTx(db, (tx) => updateGuardianAuthority(tx, clerk, guardianId, { dsr: true, messages: false }));
    let evs = await db.select().from(events).where(eq(events.name, "guardian.authority_changed"));
    expect(evs).toHaveLength(1);
    let payload = evs[0]!.payload as { reason: string; authority: { dsr: boolean; messages: boolean } };
    expect(payload.reason).toBe("update");
    expect(payload.authority.dsr).toBe(true);
    expect(payload.authority.messages).toBe(false);

    await withTx(db, (tx) => endGuardian(tx, clerk, guardianId));
    await expect(withTx(db, (tx) => endGuardian(tx, clerk, guardianId))).rejects.toMatchObject({
      code: "guardian_not_active",
    });
    evs = await db.select().from(events).where(eq(events.name, "guardian.authority_changed"));
    expect(evs).toHaveLength(2);
    payload = evs[1]!.payload as { reason: string; authority: { consents: boolean } };
    expect(payload.reason).toBe("ended");
    expect(payload.authority).toEqual(NO_AUTHORITY);
  });

  it("sweepGuardianMajority flips exactly the majored guardians, events each, and is idempotent", async () => {
    await minorWithGuardian(dobAged(10)); // stays
    const turned18 = await minorWithGuardian(dobAged(18)); // flips (birthday today)
    const adult20 = await minorWithGuardian(dobAged(20)); // flips (registered via test backdate)
    const ended = await minorWithGuardian(dobAged(19));
    await withTx(db, (tx) => endGuardian(tx, clerk, ended.guardianId)); // 'ended' — sweep must not touch

    const flipped = await sweepGuardianMajority(db, NOW);
    expect(flipped).toBe(2);
    for (const g of [turned18.guardianId, adult20.guardianId]) {
      const row = (await db.select().from(patientGuardians).where(eq(patientGuardians.id, g)))[0]!;
      expect(row.status).toBe("majority_ended");
    }
    const majorityEvents = (await db.select().from(events).where(eq(events.name, "guardian.authority_changed")))
      .filter((e) => (e.payload as { reason: string }).reason === "majority");
    expect(majorityEvents).toHaveLength(2);

    expect(await sweepGuardianMajority(db, NOW)).toBe(0); // idempotent
  });

  it("two concurrent sweeps split the rows and never double-fire", async () => {
    await minorWithGuardian(dobAged(19));
    await minorWithGuardian(dobAged(21));
    await minorWithGuardian(dobAged(25));
    const [a, b] = await Promise.all([sweepGuardianMajority(db, NOW), sweepGuardianMajority(db, NOW)]);
    expect(a + b).toBe(3);
    const majorityEvents = (await db.select().from(events).where(eq(events.name, "guardian.authority_changed")))
      .filter((e) => (e.payload as { reason: string }).reason === "majority");
    expect(majorityEvents).toHaveLength(3);
  });
});
```

Note on fixtures: `minorWithGuardian(dobAged(20))` registers an ADULT with a guardian block — `registerPatient` only *requires* a guardian for minors, it does not forbid one for adults (guardianship of incapacitated adults is a real case D-31 leaves to explicit `validTo`). The fixture is therefore valid against T3's own rules (§3.10 hand-check, recorded here).

Run: `pnpm --filter @hmis/core test -- guardians` — expect FAIL at import. Fail-first evidence.

- [ ] **Step 2: Implement `guardians.ts`**

```ts
import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { patientGuardians, patients } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { guardianAuthorityChanged, guardianLinked } from "./events";
import { MAJORITY_AGE_YEARS, yearsBetween } from "./types";
import { PatientError } from "./uhid";
import type { GuardianInput, PatientRow } from "./registration";
import type { Db, Tx } from "../../kernel/db/client";

export type GuardianRow = typeof patientGuardians.$inferSelect;
export type GuardianAuthority = { messages: boolean; consents: boolean; dsr: boolean; bills: boolean };
export const NO_AUTHORITY: GuardianAuthority = { messages: false, consents: false, dsr: false, bills: false };

/**
 * THE enforcement point (owner decision Q4 — the Plan 02 temp-roles pattern): every consumer
 * computes authority from this pure function at read time. A guardian of an 18-year-old is
 * powerless the instant the birthday passes, whether or not the sweep has run. The D-31
 * sensitive-context override seals ONLY the message channel: POCSO/abuse/adolescent-
 * confidentiality flags must route messages away from the default guardian number, while
 * consent/bill authority is a distinct legal question left to the stored flags.
 */
export function effectiveGuardianAuthority(
  patient: PatientRow,
  guardian: GuardianRow,
  now: Date = new Date(),
): GuardianAuthority {
  if (guardian.status !== "active") return NO_AUTHORITY;
  if (guardian.validTo !== null && guardian.validTo.getTime() <= now.getTime()) return NO_AUTHORITY;
  if (patient.dob !== null && yearsBetween(patient.dob, now) >= MAJORITY_AGE_YEARS) return NO_AUTHORITY;
  return {
    messages: patient.sensitiveContext ? false : guardian.authorityMessages,
    consents: guardian.authorityConsents,
    dsr: guardian.authorityDsr,
    bills: guardian.authorityBills,
  };
}

export async function linkGuardian(
  tx: Tx,
  actor: Actor,
  patientId: string,
  input: GuardianInput,
): Promise<{ guardianId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const rows = await tx.select({ status: patients.status }).from(patients).where(eq(patients.id, patientId));
  if (rows.length === 0) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  if (rows[0]!.status !== "active") throw new PatientError("patient_not_active", "link guardians on the canonical patient");

  const guardianId = newId();
  await tx.insert(patientGuardians).values({
    id: guardianId,
    patientId,
    name: input.name,
    phone: input.phone ?? null,
    relationship: input.relationship,
    idType: input.idType ?? null,
    idNumberMasked: input.idNumberMasked ?? null,
    idVerified: input.idVerified ?? false,
    authorityMessages: input.authorityMessages ?? true,
    authorityConsents: input.authorityConsents ?? true,
    authorityDsr: input.authorityDsr ?? false,
    authorityBills: input.authorityBills ?? true,
    consentNote: input.consentNote ?? null,
    createdBy: actor.id,
  });
  await appendEvent(
    tx,
    guardianLinked.make({
      actor,
      patientId,
      payload: {
        patientId,
        guardianId,
        relationship: input.relationship,
        authority: {
          messages: input.authorityMessages ?? true,
          consents: input.authorityConsents ?? true,
          dsr: input.authorityDsr ?? false,
          bills: input.authorityBills ?? true,
        },
      },
    }),
  );
  return { guardianId };
}

export async function updateGuardianAuthority(
  tx: Tx,
  actor: Actor,
  guardianId: string,
  patch: Partial<GuardianAuthority> & {
    phone?: string | null;
    idVerified?: boolean;
    validTo?: Date | null;
    consentNote?: string | null;
  },
): Promise<void> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const rows = await tx.select().from(patientGuardians).where(eq(patientGuardians.id, guardianId));
  const guardian = rows[0];
  if (!guardian) throw new PatientError("guardian_not_found", `unknown guardian ${guardianId}`);
  if (guardian.status !== "active") throw new PatientError("guardian_not_active");

  const set: Record<string, unknown> = {};
  if (patch.messages !== undefined) set.authorityMessages = patch.messages;
  if (patch.consents !== undefined) set.authorityConsents = patch.consents;
  if (patch.dsr !== undefined) set.authorityDsr = patch.dsr;
  if (patch.bills !== undefined) set.authorityBills = patch.bills;
  if (patch.phone !== undefined) set.phone = patch.phone;
  if (patch.idVerified !== undefined) set.idVerified = patch.idVerified;
  if (patch.validTo !== undefined) set.validTo = patch.validTo;
  if (patch.consentNote !== undefined) set.consentNote = patch.consentNote;
  if (Object.keys(set).length === 0) return;

  const updated = await tx
    .update(patientGuardians)
    .set(set)
    .where(and(eq(patientGuardians.id, guardianId), eq(patientGuardians.status, "active")))
    .returning();
  if (updated.length === 0) throw new PatientError("guardian_not_active", "guardian changed concurrently");

  const patientRows = await tx.select().from(patients).where(eq(patients.id, guardian.patientId));
  await appendEvent(
    tx,
    guardianAuthorityChanged.make({
      actor,
      patientId: guardian.patientId,
      payload: {
        patientId: guardian.patientId,
        guardianId,
        reason: "update",
        authority: effectiveGuardianAuthority(patientRows[0]!, updated[0]!),
      },
    }),
  );
}

export async function endGuardian(tx: Tx, actor: Actor, guardianId: string): Promise<void> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const rows = await tx.select({ patientId: patientGuardians.patientId }).from(patientGuardians).where(eq(patientGuardians.id, guardianId));
  if (rows.length === 0) throw new PatientError("guardian_not_found", `unknown guardian ${guardianId}`);

  const updated = await tx
    .update(patientGuardians)
    .set({ status: "ended", endedBy: actor.id, endedAt: new Date() })
    .where(and(eq(patientGuardians.id, guardianId), eq(patientGuardians.status, "active")))
    .returning({ id: patientGuardians.id });
  if (updated.length === 0) throw new PatientError("guardian_not_active", "already ended");

  await appendEvent(
    tx,
    guardianAuthorityChanged.make({
      actor,
      patientId: rows[0]!.patientId,
      payload: { patientId: rows[0]!.patientId, guardianId, reason: "ended", authority: NO_AUTHORITY },
    }),
  );
}

/**
 * The FOURTH unscheduled sweep (owner decision 2026-08-13 Q4), alongside runDispatchCycle,
 * sweepExpiredTempRoles, and runDueTimers — Plan 11 registers all four as pg-boss crons.
 * Correctness never depends on it (effectiveGuardianAuthority above); this flips row status
 * and emits guardian.authority_changed for downstream consumers (Plan 10 routing, reports).
 * Concurrency: the status='active' predicate re-evaluates under READ COMMITTED, so two
 * racing sweeps split the claimed rows — proven by the parallel test.
 */
export async function sweepGuardianMajority(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - MAJORITY_AGE_YEARS, now.getUTCMonth(), now.getUTCDate()));
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  return withTx(db, async (tx) => {
    const claimed = await tx.execute(sql`
      update patient_guardians pg
      set status = 'majority_ended', ended_at = now()
      from patients p
      where pg.patient_id = p.id
        and pg.status = 'active'
        and p.dob is not null
        and p.dob <= ${cutoffIso}::date
      returning pg.id as guardian_id, pg.patient_id as patient_id
    `);
    for (const row of claimed.rows) {
      const guardianId = String(row.guardian_id);
      const patientId = String(row.patient_id);
      await appendEvent(
        tx,
        guardianAuthorityChanged.make({
          actor: { type: "system", id: "guardian-majority-sweep" },
          patientId,
          payload: { patientId, guardianId, reason: "majority", authority: NO_AUTHORITY },
        }),
      );
    }
    return claimed.rows.length;
  });
}
```

- [ ] **Step 3: Run the tests, then full verify + commit**

Run: `pnpm --filter @hmis/core test -- guardians` → PASS (5 tests). Then `pnpm verify` (unpiped) → exit 0.

```bash
git add apps/core
git commit -m "feat(patients): guardians — authority scope, sensitive-context seal, read-time majority + fourth unscheduled sweep"
```

---

### Task 7: Signed QR — build, verify, reissue (D-23, consuming Plan 02's crypto)

**Files:**
- Create: `apps/core/src/modules/patients/qr.ts`
- Create: `apps/core/src/modules/patients/qr.test.ts`
- Modify: `apps/core/test/perf-patient-search.test.ts` (**exactly ONE line deleted** — carried-forward cleanup, rationale below)

**Carried-forward cleanup** (EXECUTION-LESSONS §3.2's mechanism — named explicitly here so the gate reads it as in-scope rather than scope creep): pipeline A's T4 typed this plan's `// eslint-disable-next-line no-console` verbatim above the search-timings log. The root `eslint.config.mjs` never enables `no-console` (confirmed against shipped source — only `no-restricted-imports` and a test-file `no-unused-vars` relaxation are configured beyond `tseslint.configs.recommended`), so ESLint 9 reports it as an **unused disable directive**: `pnpm lint` emits `✖ 1 problem (0 errors, 1 warning)`. Verify still exits 0, which is precisely why it will rot there and mask the next real warning. Delete that one comment line — nothing else in that file, and do not touch the `console.log` it sat above. Recorded as EXECUTION-LESSONS §3.15.

**Interfaces:**
- Consumes: `hmacSign`, `hmacVerify` (`kernel/crypto` — **this plan creates no crypto**, roadmap-stated), `AppConfig` (`cfg.secretKey` — **no new env var**), `hasPermission`, tables, events (T3), `PatientError`, `appendEvent`, `withTx`.
- Produces (exact — T9's controller and the web card consume):
  - `QR_PREFIX = "q1"` — payload format `q1.<patientId>.<uhid>.<qrVersion>.<sig>`; the ULID id, the hyphenated UHID, and the integer version contain no `.`, so `split(".")` is unambiguous; `sig = hmacSign(secretKey, body)` over the first four segments.
  - `buildQrPayload(cfg: AppConfig, p: { id: string; uhid: string; qrVersion: number }): string`
  - `type QrVerifyResult = { ok: true; patient: { id: string; uhid: string; name: string; sex: string; dob: Date | null } } | { ok: false; reason: "malformed" | "invalid_signature" | "stale_version" | "unknown_patient" }`
  - `verifyQrScan(db: Db, cfg: AppConfig, actor: Actor, payload: string): Promise<QrVerifyResult>` — user-only. Order: parse (`malformed`) → `hmacVerify` (`invalid_signature`) → load row (`unknown_patient`) → version check (`stale_version` — a reissued card's predecessors die, D-23) → resolve the merge chain (an old card of a merged loser resolves to the WINNER — §6 in physical form) → confidential handling: the card was physically presented, so the scan resolves, but the returned `name` is the **alias** when the patient is confidential and the caller lacks `patients.confidential.read` (§14: alias on surfaces). **Every failure appends `qr.signature_failed` in its own transaction** (the scan is a read; the failure event must survive) — `patientId` only on `stale_version`/`unknown_patient`, where the signature proved the id is ours; a forged payload's id is never evented as a patientId.
  - `reissueQrCard(db: Db, cfg: AppConfig, actor: Actor, patientId: string): Promise<{ qrVersion: number; payload: string }>` — single-winner `qr_version` increment (conditional on `status = 'active'`), `patient.updated` with the version change, returns the fresh payload for immediate printing.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/modules/patients/qr.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { loadConfig } from "../../kernel/config";
import { events, patients, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { registerPatient } from "./registration";
import type { RegisterPatientInput } from "./registration";
import { QR_PREFIX, buildQrPayload, reissueQrCard, verifyQrScan } from "./qr";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };
const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

describe("signed QR (D-23)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" });
  });

  // Partial<RegisterPatientInput>, NOT Record<string, unknown>: an unknown-valued index
  // signature is not assignable to the typed optional fields (TS2322 — the §5.2 class).
  async function newPatient(extra: Partial<RegisterPatientInput> = {}): Promise<{ id: string; uhid: string; qrVersion: number }> {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Asha Devi", sex: "female", phone: "9876543210", ...extra }),
    );
    return { id: patient.id, uhid: patient.uhid, qrVersion: patient.qrVersion };
  }

  async function failureEvents(): Promise<{ reason: string; patientId?: string }[]> {
    const evs = await db.select().from(events).where(eq(events.name, "qr.signature_failed"));
    return evs.map((e) => e.payload as { reason: string; patientId?: string });
  }

  it("a built payload verifies and returns the patient summary", async () => {
    const p = await newPatient();
    const payload = buildQrPayload(cfg, p);
    expect(payload.startsWith(`${QR_PREFIX}.${p.id}.${p.uhid}.1.`)).toBe(true);
    const res = await verifyQrScan(db, cfg, clerk, payload);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.patient.id).toBe(p.id);
      expect(res.patient.uhid).toBe(p.uhid);
      expect(res.patient.name).toBe("Asha Devi");
    }
    expect(await failureEvents()).toEqual([]);
  });

  it("malformed and tampered payloads fail loudly with qr.signature_failed", async () => {
    const p = await newPatient();
    const good = buildQrPayload(cfg, p);

    const malformed = await verifyQrScan(db, cfg, clerk, "not-a-qr-payload");
    expect(malformed).toEqual({ ok: false, reason: "malformed" });

    const tampered = good.replace(p.uhid, p.uhid.replace(/\d/, "9")); // photographed-and-edited card
    const bad = await verifyQrScan(db, cfg, clerk, tampered);
    expect(bad).toEqual({ ok: false, reason: "invalid_signature" });

    const evs = await failureEvents();
    expect(evs.map((e) => e.reason).sort()).toEqual(["invalid_signature", "malformed"]);
    for (const e of evs) expect(e.patientId).toBeUndefined(); // a forged id is never evented as a patientId
  });

  it("a validly-signed payload for a missing patient fails as unknown_patient (with the id, which we signed)", async () => {
    const ghost = buildQrPayload(cfg, { id: "01GHOST000000000000000000", uhid: "HMS-99999999-0", qrVersion: 1 });
    const res = await verifyQrScan(db, cfg, clerk, ghost);
    expect(res).toEqual({ ok: false, reason: "unknown_patient" });
    expect((await failureEvents())[0]!.patientId).toBe("01GHOST000000000000000000");
  });

  it("reissue revokes prior cards: old payload → stale_version; new payload verifies; version change evented", async () => {
    const p = await newPatient();
    const oldPayload = buildQrPayload(cfg, p);
    const { qrVersion, payload } = await reissueQrCard(db, cfg, clerk, p.id);
    expect(qrVersion).toBe(2);

    const stale = await verifyQrScan(db, cfg, clerk, oldPayload);
    expect(stale).toEqual({ ok: false, reason: "stale_version" });
    expect((await failureEvents())[0]!.patientId).toBe(p.id);

    const fresh = await verifyQrScan(db, cfg, clerk, payload);
    expect(fresh.ok).toBe(true);

    const updated = await db.select().from(events).where(eq(events.name, "patient.updated"));
    expect(updated).toHaveLength(1);
    const changes = (updated[0]!.payload as { changes: { field: string; from: string; to: string }[] }).changes;
    expect(changes).toEqual([{ field: "qrVersion", from: "1", to: "2" }]);
  });

  it("an old card of a merged loser resolves to the winner", async () => {
    const loser = await newPatient();
    const winner = await newPatient();
    const loserCard = buildQrPayload(cfg, loser);
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: winner.id }).where(eq(patients.id, loser.id));
    const res = await verifyQrScan(db, cfg, clerk, loserCard);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.patient.id).toBe(winner.id);
  });

  it("a confidential patient's card resolves but shows the alias to callers without the permission", async () => {
    const p = await newPatient({ isConfidential: true, alias: "Patient A" });
    const res = await verifyQrScan(db, cfg, clerk, buildQrPayload(cfg, p));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.patient.name).toBe("Patient A");
  });

  it("reissue refuses unknown/frozen patients and non-user actors", async () => {
    await expect(reissueQrCard(db, cfg, clerk, "01NOSUCH00000000000000000")).rejects.toMatchObject({
      code: "patient_not_found",
    });
    // A merged (frozen) row must answer patient_not_active, NOT patient_not_found. Without
    // this case an implementation that collapses both branches into one code passes the test
    // while being wrong — EXECUTION-LESSONS §3.14: pick the fixture that separates them.
    const frozen = await newPatient();
    await db.update(patients).set({ status: "merged" }).where(eq(patients.id, frozen.id));
    await expect(reissueQrCard(db, cfg, clerk, frozen.id)).rejects.toMatchObject({
      code: "patient_not_active",
    });
    const p = await newPatient();
    await expect(reissueQrCard(db, cfg, { type: "agent", id: "a" }, p.id)).rejects.toMatchObject({
      code: "user_actor_required",
    });
  });
});
```

Run: `pnpm --filter @hmis/core test -- qr` — expect FAIL at import. Fail-first evidence.

- [ ] **Step 2: Implement `qr.ts`**

```ts
import { and, eq, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { hmacSign, hmacVerify } from "../../kernel/crypto";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import { patients } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { patientUpdated, qrSignatureFailed } from "./events";
import { PatientError } from "./uhid";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

export const QR_PREFIX = "q1";

/** Card payload: q1.<patientId>.<uhid>.<qrVersion>.<sig> — HMAC under the existing SECRET_KEY (no new env var). */
export function buildQrPayload(cfg: AppConfig, p: { id: string; uhid: string; qrVersion: number }): string {
  const body = `${QR_PREFIX}.${p.id}.${p.uhid}.${p.qrVersion}`;
  return `${body}.${hmacSign(cfg.secretKey, body)}`;
}

export type QrVerifyResult =
  | { ok: true; patient: { id: string; uhid: string; name: string; sex: string; dob: Date | null } }
  | { ok: false; reason: "malformed" | "invalid_signature" | "stale_version" | "unknown_patient" };

/**
 * Scanner-side verification (D-23: a photographed or edited static code fails; a reissued
 * card's predecessors fail). Every failure appends qr.signature_failed in its OWN
 * transaction — the scan itself is a read, but the failure is an auditable fact.
 */
export async function verifyQrScan(
  db: Db,
  cfg: AppConfig,
  actor: Actor,
  payload: string,
): Promise<QrVerifyResult> {
  if (actor.type !== "user") throw new PatientError("user_actor_required", "scanners are desk surfaces — user actors only");

  const fail = async (
    reason: "malformed" | "invalid_signature" | "stale_version" | "unknown_patient",
    patientId?: string,
  ): Promise<QrVerifyResult> => {
    await withTx(db, (tx) =>
      appendEvent(
        tx,
        qrSignatureFailed.make({
          actor,
          patientId,
          payload: { reason, payloadPrefix: payload.slice(0, 32), ...(patientId !== undefined ? { patientId } : {}) },
        }),
      ),
    );
    return { ok: false, reason };
  };

  const parts = payload.split(".");
  if (parts.length !== 5 || parts[0] !== QR_PREFIX || !/^\d+$/.test(parts[3]!)) {
    return fail("malformed");
  }
  const [prefix, id, uhid, versionPart, sig] = parts as [string, string, string, string, string];
  const body = `${prefix}.${id}.${uhid}.${versionPart}`;
  if (!hmacVerify(cfg.secretKey, body, sig)) {
    return fail("invalid_signature"); // forged/edited — the embedded id is NOT trusted, no patientId on the event
  }

  const rows = await db.select().from(patients).where(eq(patients.id, id));
  const row = rows[0];
  if (!row) return fail("unknown_patient", id); // signature is ours, so the id is ours to event
  if (row.qrVersion !== Number(versionPart) || row.uhid !== uhid) {
    return fail("stale_version", id); // reissue rotated the card (or the uhid predates a correction)
  }

  // Follow the merge chain — an old card of a merged loser must land on the canonical record (§6).
  let resolved = row;
  for (let hop = 0; resolved.status === "merged" && resolved.mergedIntoPatientId !== null && hop < 5; hop++) {
    const next = await db.select().from(patients).where(eq(patients.id, resolved.mergedIntoPatientId));
    if (!next[0]) return fail("unknown_patient", resolved.mergedIntoPatientId);
    resolved = next[0];
  }

  // §14: the card was physically presented, so the scan resolves — but the display name is
  // the alias for callers without the permission. D-37: nothing here affects any priority.
  let name = resolved.name;
  if (resolved.isConfidential) {
    const canSee = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
    if (!canSee) name = resolved.alias ?? "—";
  }
  return {
    ok: true,
    patient: { id: resolved.id, uhid: resolved.uhid, name, sex: resolved.sex, dob: resolved.dob },
  };
}

/** Single-winner version bump; prior cards fail with stale_version from this commit on. */
export async function reissueQrCard(
  db: Db,
  cfg: AppConfig,
  actor: Actor,
  patientId: string,
): Promise<{ qrVersion: number; payload: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  return withTx(db, async (tx) => {
    const updated = await tx
      .update(patients)
      // Atomic in-place increment — never read-then-write (house rule).
      .set({ qrVersion: sql`${patients.qrVersion} + 1`, updatedBy: actor.id, updatedAt: new Date() })
      .where(and(eq(patients.id, patientId), eq(patients.status, "active")))
      .returning();
    if (updated.length === 0) {
      const exists = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId));
      throw new PatientError(exists.length === 0 ? "patient_not_found" : "patient_not_active");
    }
    const row = updated[0]!;
    await appendEvent(
      tx,
      patientUpdated.make({
        actor,
        patientId,
        payload: {
          patientId,
          changes: [{ field: "qrVersion", from: String(row.qrVersion - 1), to: String(row.qrVersion) }],
        },
      }),
    );
    return { qrVersion: row.qrVersion, payload: buildQrPayload(cfg, row) };
  });
}
```

- [ ] **Step 3: Run the tests, then full verify + commit**

Run: `pnpm --filter @hmis/core test -- qr` → PASS (7 tests). Then `pnpm verify` (unpiped) → exit 0.

```bash
git add apps/core
git commit -m "feat(patients): signed QR build/verify/reissue — qr.signature_failed audit, merge-chain resolution, alias masking"
```

---

### Task 8: Merge & unmerge — approval-gated through Plan 04, single-winner, snapshot-restored

**Files:**
- Create: `apps/core/src/modules/patients/merge.ts`
- Create: `apps/core/src/modules/patients/merge.test.ts`

**Interfaces:**
- Consumes (verified against gate reports 03/04 + shipped source): `requestApproval(tx, requester, input)` (`kernel/approvals/requests` — `Tx`-first, exactly why `createMergeRequest` can file atomically), `getApproval(db, id)` (`kernel/approvals/worklist`), `approvalFlowDefinition` + `registerApprovalType` + Plan 03 `createDraft`/`activateDefinition` (tests register the types), `approveRequest` (tests decide), `seedSodPairs` (SoD pair for decisions), `inArray` (drizzle — the §5.2-safe array predicate), tables, events (T3), `PatientError`, `appendEvent`, `newId`.
- Produces (exact — T9's controller, T10's e2e, the merge UI):
  - `MERGE_APPROVAL_TYPE = "patient_merge"` (routine) · `UNMERGE_APPROVAL_TYPE = "patient_unmerge"` (**urgent, `actFirstAllowed: true`** — §11.5: a wrong merge is a patient-safety emergency; E-15 act-first is the shipped mechanism)
  - `type MergeRequestRow = typeof patientMergeRequests.$inferSelect`
  - `createMergeRequest(tx, actor, input: { winnerId: string; loserId: string; note: string }): Promise<{ mergeRequestId: string; approvalId: string; instanceId: string }>` — user-only; note mandatory (`reason_required`); `merge_same_patient`; both rows exist and `active`; **files the Plan 04 approval on the SAME transaction** (`subject: { type: "patient_merge_request", id }`, `patientId: loserId`); the T1 partial-unique index arbitrates duplicates race-safely (`merge_already_requested`); snapshot stores both full rows for the side-by-side review and the audit trail.
  - `getMergeRequest(db, id): Promise<{ request: MergeRequestRow; approvalStatus: string | null; unmergeApprovalStatus: string | null } | null>` — embeds approval statuses server-side so the UI needs no `approvals.requests.read` permission.
  - `executeMerge(db, actor, mergeRequestId): Promise<{ winnerId: string; loserId: string }>` — **check-on-execute** (owner decision Q3): the approval row must be `granted` (`approval_not_granted`); then ONE transaction: single-winner claim `requested → executed` (loser: `merge_not_requested`) → move allergies + guardians to the winner (`RETURNING` ids recorded in `movedRows`) → **photos never move** (the winner's photo—or absence—stands; the loser's stays on the frozen row, hidden behind chain resolution, intact for unmerge) → freeze the loser (`active → merged`, `merged_into` set) → `patient.merged` with `correlationId` = the approval's workflow instance id.
  - `requestUnmerge(tx, actor, input: { mergeRequestId: string; note: string; actFirst?: boolean }): Promise<{ approvalId: string; instanceId: string }>` — request must be `executed`; files the `patient_unmerge` approval, then claims the one unmerge slot via conditional UPDATE `where unmerge_approval_id is null` (`unmerge_already_requested`; a rejected unmerge needs a human path — v1 limitation, stated in T10's docs).
  - `executeUnmerge(db, actor, mergeRequestId): Promise<void>` — allowed when the unmerge approval is `granted` **OR** was filed `actedFirst` and is still `pending` (E-15 act-first-review-after; an after-the-fact rejection is a review outcome, not a rollback); ONE transaction: claim `executed → unmerged` (loser: `merge_not_executed`) → move back **exactly** the ids in `movedRows` (drizzle `inArray` — never a raw `= any(...)`, §5.2) → unfreeze the loser (`merged → active`, `merged_into` cleared) → `patient.unmerged` with `correlationId` = the unmerge approval's instance id.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/modules/patients/merge.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, patientAllergies, patientGuardians, patients, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { registerApprovalType } from "../../kernel/approvals/types";
import { approveRequest } from "../../kernel/approvals/decisions";
import { getApproval } from "../../kernel/approvals/worklist";
import { createDraft, activateDefinition } from "../../kernel/workflow/definitions";
import { registerPatient } from "./registration";
import { addAllergy } from "./allergies";
import {
  MERGE_APPROVAL_TYPE, UNMERGE_APPROVAL_TYPE, createMergeRequest, executeMerge,
  executeUnmerge, getMergeRequest, requestUnmerge,
} from "./merge";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

describe("merge & unmerge (§11.5 — approval-gated, splittable)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Actor;
  let mrdHead: Actor;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" });
    await seedSodPairs(db);

    // Two-step type registration — EXACTLY the go-live runbook flow (Plan 04 gate report §8):
    // builder → Plan 03 draft → activate (Class C; drafter≠activator SoD) → registerApprovalType.
    const drafterUser = await createUser(db, { username: "drafter", fullName: "D", password: "p1234567" });
    const activatorUser = await createUser(db, { username: "activator", fullName: "A", password: "p1234567" });
    const clerkUser = await createUser(db, { username: "clerk", fullName: "C", password: "p1234567" });
    const mrdUser = await createUser(db, { username: "mrd", fullName: "M", password: "p1234567" });
    const drafter: Actor = { type: "user", id: drafterUser.id };
    const activator: Actor = { type: "user", id: activatorUser.id };
    clerk = { type: "user", id: clerkUser.id };
    mrdHead = { type: "user", id: mrdUser.id };
    await createRole(db, "mrd_head", "MRD Head");
    await assignRole(db, { userId: mrdUser.id, roleKey: "mrd_head", scopeType: "hospital" });

    for (const spec of [
      { typeKey: MERGE_APPROVAL_TYPE, title: "Patient Merge", urgencyClass: "routine" as const, actFirstAllowed: false, sla: 240 },
      { typeKey: UNMERGE_APPROVAL_TYPE, title: "Patient Unmerge", urgencyClass: "urgent" as const, actFirstAllowed: true, sla: 60 },
    ]) {
      const def = approvalFlowDefinition({
        typeKey: spec.typeKey, title: spec.title, approverRole: "mrd_head", closureSlaMinutes: spec.sla,
      });
      const draft = await createDraft(db, drafter, def);
      await activateDefinition(db, activator, draft.definitionId);
      await registerApprovalType(db, activator, {
        typeKey: spec.typeKey, title: spec.title, approverRole: "mrd_head",
        urgencyClass: spec.urgencyClass, actFirstAllowed: spec.actFirstAllowed,
      });
    }
  });

  async function twoPatients(): Promise<{ winnerId: string; loserId: string; loserUhid: string }> {
    const w = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Asha Devi", sex: "female", phone: "9876543210" }));
    const l = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Asha Debi", sex: "female", phone: "9876543210" }));
    return { winnerId: w.patient.id, loserId: l.patient.id, loserUhid: l.patient.uhid };
  }

  async function requestedMerge(): Promise<{ winnerId: string; loserId: string; mergeRequestId: string; approvalId: string }> {
    const { winnerId, loserId } = await twoPatients();
    const req = await withTx(db, (tx) =>
      createMergeRequest(tx, clerk, { winnerId, loserId, note: "same person, double registration" }),
    );
    return { winnerId, loserId, mergeRequestId: req.mergeRequestId, approvalId: req.approvalId };
  }

  it("createMergeRequest files the approval atomically and snapshots both rows", async () => {
    const { loserId, mergeRequestId, approvalId } = await requestedMerge();
    const view = await getMergeRequest(db, mergeRequestId);
    expect(view!.request.status).toBe("requested");
    expect(view!.approvalStatus).toBe("pending");
    expect(view!.unmergeApprovalStatus).toBeNull();
    const snapshot = view!.request.snapshot as { winnerBefore: { name: string }; loserBefore: { id: string } };
    expect(snapshot.winnerBefore.name).toBe("Asha Devi");
    expect(snapshot.loserBefore.id).toBe(loserId);

    const approval = await getApproval(db, approvalId);
    expect(approval!.typeKey).toBe(MERGE_APPROVAL_TYPE);
    expect(approval!.patientId).toBe(loserId);
    expect(approval!.urgencyClass).toBe("routine");
  });

  it("guards: same patient, unknown patients, missing note, duplicate pending request", async () => {
    const { winnerId, loserId } = await twoPatients();
    await expect(
      withTx(db, (tx) => createMergeRequest(tx, clerk, { winnerId, loserId: winnerId, note: "x" })),
    ).rejects.toMatchObject({ code: "merge_same_patient" });
    // The unknown-patient branch this test's NAME promises (§3.14: a name that promises what
    // no assertion proves is the same defect class as a fixture that separates nothing).
    await expect(
      withTx(db, (tx) =>
        createMergeRequest(tx, clerk, { winnerId, loserId: "01NOSUCH00000000000000000", note: "x" }),
      ),
    ).rejects.toMatchObject({ code: "patient_not_found" });
    await expect(
      withTx(db, (tx) => createMergeRequest(tx, clerk, { winnerId, loserId, note: "  " })),
    ).rejects.toMatchObject({ code: "reason_required" });
    await withTx(db, (tx) => createMergeRequest(tx, clerk, { winnerId, loserId, note: "dup reg" }));
    await expect(
      withTx(db, (tx) => createMergeRequest(tx, clerk, { winnerId, loserId, note: "again" })),
    ).rejects.toMatchObject({ code: "merge_already_requested" });
  });

  it("executeMerge refuses while pending, then moves children, freezes the loser, events with the instance correlation", async () => {
    const { winnerId, loserId, mergeRequestId, approvalId } = await requestedMerge();
    await withTx(db, (tx) => addAllergy(tx, clerk, loserId, { substance: "penicillin", source: "registration" }));

    await expect(executeMerge(db, clerk, mergeRequestId)).rejects.toMatchObject({ code: "approval_not_granted" });

    await approveRequest(db, mrdHead, { approvalId, note: "verified same person at desk" });
    const { winnerId: w } = await executeMerge(db, clerk, mergeRequestId);
    expect(w).toBe(winnerId);

    const loser = (await db.select().from(patients).where(eq(patients.id, loserId)))[0]!;
    expect(loser.status).toBe("merged");
    expect(loser.mergedIntoPatientId).toBe(winnerId);

    const movedAllergies = await db.select().from(patientAllergies).where(eq(patientAllergies.patientId, winnerId));
    expect(movedAllergies).toHaveLength(1);

    const evs = await db.select().from(events).where(eq(events.name, "patient.merged"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.patientId).toBe(winnerId);
    const approval = await getApproval(db, approvalId);
    expect(evs[0]!.correlationId).toBe(approval!.instanceId); // §10.5: correlation = the backing instance

    const view = await getMergeRequest(db, mergeRequestId);
    const moved = view!.request.movedRows as { allergyIds: string[]; guardianIds: string[] };
    expect(moved.allergyIds).toHaveLength(1);
    expect(moved.guardianIds).toHaveLength(0);
  });

  it("concurrent executeMerge: exactly one winner; the loser's code is merge_not_requested; exactly one event", async () => {
    const { mergeRequestId, approvalId } = await requestedMerge();
    await approveRequest(db, mrdHead, { approvalId, note: "ok" });
    const results = await Promise.allSettled([
      executeMerge(db, clerk, mergeRequestId),
      executeMerge(db, clerk, mergeRequestId),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The claim is the transaction's FIRST write and both pre-reads see 'requested', so the
    // shipped arbiter produces exactly ONE loser code (§3.13: enumerate them all — here, one).
    expect((rejected[0]!.reason as { code: string }).code).toBe("merge_not_requested");
    expect(await db.select().from(events).where(eq(events.name, "patient.merged"))).toHaveLength(1);
  });

  it("unmerge: act-first executes while pending, restores exactly the moved rows, events, and is single-winner", async () => {
    const { winnerId, loserId, mergeRequestId, approvalId } = await requestedMerge();
    await withTx(db, (tx) => addAllergy(tx, clerk, loserId, { substance: "sulfa", source: "registration" }));
    await approveRequest(db, mrdHead, { approvalId, note: "ok" });
    await executeMerge(db, clerk, mergeRequestId);

    // wrong merge discovered — act first (E-15), review after
    const un = await withTx(db, (tx) =>
      requestUnmerge(tx, clerk, { mergeRequestId, note: "different persons — DOB mismatch found", actFirst: true }),
    );
    await expect(
      withTx(db, (tx) => requestUnmerge(tx, clerk, { mergeRequestId, note: "again", actFirst: true })),
    ).rejects.toMatchObject({ code: "unmerge_already_requested" });

    await executeUnmerge(db, clerk, mergeRequestId); // approval still pending + actedFirst → allowed

    const loser = (await db.select().from(patients).where(eq(patients.id, loserId)))[0]!;
    expect(loser.status).toBe("active");
    expect(loser.mergedIntoPatientId).toBeNull();
    const restored = await db.select().from(patientAllergies).where(eq(patientAllergies.patientId, loserId));
    expect(restored).toHaveLength(1); // the moved allergy came home
    expect(await db.select().from(patientAllergies).where(eq(patientAllergies.patientId, winnerId))).toHaveLength(0);

    const evs = await db.select().from(events).where(eq(events.name, "patient.unmerged"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.patientId).toBe(loserId);
    const unApproval = await getApproval(db, un.approvalId);
    expect(evs[0]!.correlationId).toBe(unApproval!.instanceId);

    await expect(executeUnmerge(db, clerk, mergeRequestId)).rejects.toMatchObject({ code: "merge_not_executed" });
  });

  it("unmerge without act-first waits for the grant", async () => {
    const { mergeRequestId, approvalId } = await requestedMerge();
    await approveRequest(db, mrdHead, { approvalId, note: "ok" });
    await executeMerge(db, clerk, mergeRequestId);
    const un = await withTx(db, (tx) =>
      requestUnmerge(tx, clerk, { mergeRequestId, note: "wrong merge" }),
    );
    await expect(executeUnmerge(db, clerk, mergeRequestId)).rejects.toMatchObject({ code: "approval_not_granted" });
    await approveRequest(db, mrdHead, { approvalId: un.approvalId, note: "confirmed distinct" });
    await executeUnmerge(db, clerk, mergeRequestId);
  });
});
```

Run: `pnpm --filter @hmis/core test -- merge` — expect FAIL at import. Fail-first evidence.

- [ ] **Step 2: Implement `merge.ts`**

```ts
import { and, eq, inArray, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { patientAllergies, patientGuardians, patientMergeRequests, patients } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { patientMerged, patientUnmerged } from "./events";
import { PatientError } from "./uhid";
import type { Db, Tx } from "../../kernel/db/client";

/** Registered as DATA at go-live (runbook, T10 docs); tests register them inline. No engine work — Plan 04 gate report §8. */
export const MERGE_APPROVAL_TYPE = "patient_merge";
export const UNMERGE_APPROVAL_TYPE = "patient_unmerge";

export type MergeRequestRow = typeof patientMergeRequests.$inferSelect;
type MovedRows = { allergyIds: string[]; guardianIds: string[] };

export async function createMergeRequest(
  tx: Tx,
  actor: Actor,
  input: { winnerId: string; loserId: string; note: string },
): Promise<{ mergeRequestId: string; approvalId: string; instanceId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "") throw new PatientError("reason_required", "a merge request needs a reason (§11.5 review)");
  if (input.winnerId === input.loserId) throw new PatientError("merge_same_patient");

  const rows = await tx.select().from(patients).where(inArray(patients.id, [input.winnerId, input.loserId]));
  const winner = rows.find((r) => r.id === input.winnerId);
  const loser = rows.find((r) => r.id === input.loserId);
  if (!winner || !loser) throw new PatientError("patient_not_found");
  if (winner.status !== "active" || loser.status !== "active") {
    throw new PatientError("patient_not_active", "both records must be active to merge");
  }

  const mergeRequestId = newId();
  // Tx-first requestApproval (Plan 04): the approval, its workflow instance, and this row
  // commit together or not at all. A duplicate-pending conflict below rolls ALL of it back.
  const { approvalId, instanceId } = await requestApproval(tx, actor, {
    typeKey: MERGE_APPROVAL_TYPE,
    subject: { type: "patient_merge_request", id: mergeRequestId },
    patientId: input.loserId,
    requestNote: note,
  });

  const inserted = await tx
    .insert(patientMergeRequests)
    .values({
      id: mergeRequestId,
      winnerId: input.winnerId,
      loserId: input.loserId,
      approvalId,
      requestNote: note,
      snapshot: { winnerBefore: winner, loserBefore: loser },
      requestedBy: actor.id,
    })
    .onConflictDoNothing()
    .returning({ id: patientMergeRequests.id });
  if (inserted.length === 0) {
    // Lost the partial-unique race (one pending request per loser) — unwind everything.
    throw new PatientError("merge_already_requested", "a pending merge request already exists for this record");
  }
  return { mergeRequestId, approvalId, instanceId };
}

/** Embeds approval statuses so the review UI needs no approvals-engine read permission. */
export async function getMergeRequest(
  db: Db,
  mergeRequestId: string,
): Promise<{ request: MergeRequestRow; approvalStatus: string | null; unmergeApprovalStatus: string | null } | null> {
  const rows = await db.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, mergeRequestId));
  const request = rows[0];
  if (!request) return null;
  const approval = await getApproval(db, request.approvalId);
  const unmergeApproval = request.unmergeApprovalId !== null ? await getApproval(db, request.unmergeApprovalId) : null;
  return {
    request,
    approvalStatus: approval?.status ?? null,
    unmergeApprovalStatus: unmergeApproval?.status ?? null,
  };
}

/**
 * Check-on-execute (owner decision Q3): the gate is verified against the approvals row at
 * execution time — NOT an event consumer, because runDispatchCycle is unscheduled until
 * Plan 11 and a subscription would never tick in production.
 */
export async function executeMerge(
  db: Db,
  actor: Actor,
  mergeRequestId: string,
): Promise<{ winnerId: string; loserId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const reqRows = await db.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, mergeRequestId));
  const req = reqRows[0];
  if (!req) throw new PatientError("unknown_merge_request");
  const approval = await getApproval(db, req.approvalId);
  if (!approval || approval.status !== "granted") {
    throw new PatientError("approval_not_granted", "the merge approval must be granted first (§11.5)");
  }

  return withTx(db, async (tx) => {
    // Single-winner claim FIRST — everything after runs at most once per request.
    const claimed = await tx
      .update(patientMergeRequests)
      .set({ status: "executed", executedBy: actor.id, executedAt: new Date() })
      .where(and(eq(patientMergeRequests.id, mergeRequestId), eq(patientMergeRequests.status, "requested")))
      .returning({ id: patientMergeRequests.id });
    if (claimed.length === 0) throw new PatientError("merge_not_requested", "already executed or unmade");

    const movedAllergies = await tx
      .update(patientAllergies)
      .set({ patientId: req.winnerId })
      .where(eq(patientAllergies.patientId, req.loserId))
      .returning({ id: patientAllergies.id });
    const movedGuardians = await tx
      .update(patientGuardians)
      .set({ patientId: req.winnerId })
      .where(eq(patientGuardians.patientId, req.loserId))
      .returning({ id: patientGuardians.id });
    // Photos deliberately NEVER move: the loser's photo stays on the frozen row (intact for
    // unmerge, hidden behind chain resolution); the winner's own photo — or absence — stands.

    const frozen = await tx
      .update(patients)
      .set({ status: "merged", mergedIntoPatientId: req.winnerId, updatedBy: actor.id, updatedAt: new Date() })
      .where(and(eq(patients.id, req.loserId), eq(patients.status, "active")))
      .returning({ uhid: patients.uhid });
    if (frozen.length === 0) throw new PatientError("patient_not_active", "loser record changed concurrently");

    const moved: MovedRows = {
      allergyIds: movedAllergies.map((r) => r.id),
      guardianIds: movedGuardians.map((r) => r.id),
    };
    await tx.update(patientMergeRequests).set({ movedRows: moved }).where(eq(patientMergeRequests.id, mergeRequestId));

    const winnerRows = await tx.select({ uhid: patients.uhid }).from(patients).where(eq(patients.id, req.winnerId));
    await appendEvent(
      tx,
      patientMerged.make({
        actor,
        patientId: req.winnerId,
        correlationId: approval.instanceId, // §10.5: correlation = the backing workflow instance
        payload: {
          winnerPatientId: req.winnerId,
          loserPatientId: req.loserId,
          winnerUhid: winnerRows[0]!.uhid,
          loserUhid: frozen[0]!.uhid,
          mergeRequestId,
        },
      }),
    );
    return { winnerId: req.winnerId, loserId: req.loserId };
  });
}

export async function requestUnmerge(
  tx: Tx,
  actor: Actor,
  input: { mergeRequestId: string; note: string; actFirst?: boolean },
): Promise<{ approvalId: string; instanceId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "") throw new PatientError("reason_required", "an unmerge request needs a reason");
  const rows = await tx.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, input.mergeRequestId));
  const req = rows[0];
  if (!req) throw new PatientError("unknown_merge_request");
  if (req.status !== "executed") throw new PatientError("merge_not_executed", "only an executed merge can be unmade");

  const { approvalId, instanceId } = await requestApproval(tx, actor, {
    typeKey: UNMERGE_APPROVAL_TYPE,
    subject: { type: "patient_merge_request", id: input.mergeRequestId },
    patientId: req.loserId,
    requestNote: note,
    ...(input.actFirst === true ? { actFirst: true } : {}),
  });
  // Claim the ONE unmerge slot (conditional on null) — a lost race unwinds the approval too.
  const claimed = await tx
    .update(patientMergeRequests)
    .set({ unmergeApprovalId: approvalId })
    .where(and(eq(patientMergeRequests.id, input.mergeRequestId), isNull(patientMergeRequests.unmergeApprovalId)))
    .returning({ id: patientMergeRequests.id });
  if (claimed.length === 0) {
    throw new PatientError("unmerge_already_requested", "an unmerge request already exists (a rejected one needs the manual path — v1)");
  }
  return { approvalId, instanceId };
}

export async function executeUnmerge(db: Db, actor: Actor, mergeRequestId: string): Promise<void> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const rows = await db.select().from(patientMergeRequests).where(eq(patientMergeRequests.id, mergeRequestId));
  const req = rows[0];
  if (!req) throw new PatientError("unknown_merge_request");
  if (req.status !== "executed") throw new PatientError("merge_not_executed");
  if (req.unmergeApprovalId === null) throw new PatientError("unmerge_not_requested");

  const approval = await getApproval(db, req.unmergeApprovalId);
  // E-15 act-first-review-after: an acted-first request executes while its review is pending.
  // Direct null-check (not a boolean variable) so TS narrows `approval` for the closure below.
  if (approval === null || !(approval.status === "granted" || (approval.actedFirst && approval.status === "pending"))) {
    throw new PatientError("approval_not_granted", "unmerge needs a grant, or an act-first request");
  }

  await withTx(db, async (tx) => {
    const claimed = await tx
      .update(patientMergeRequests)
      .set({ status: "unmerged", unmergedBy: actor.id, unmergedAt: new Date() })
      .where(and(eq(patientMergeRequests.id, mergeRequestId), eq(patientMergeRequests.status, "executed")))
      .returning({ id: patientMergeRequests.id });
    if (claimed.length === 0) throw new PatientError("merge_not_executed", "already unmade");

    const moved = (req.movedRows ?? { allergyIds: [], guardianIds: [] }) as MovedRows;
    if (moved.allergyIds.length > 0) {
      await tx.update(patientAllergies).set({ patientId: req.loserId }).where(inArray(patientAllergies.id, moved.allergyIds));
    }
    if (moved.guardianIds.length > 0) {
      await tx.update(patientGuardians).set({ patientId: req.loserId }).where(inArray(patientGuardians.id, moved.guardianIds));
    }
    const unfrozen = await tx
      .update(patients)
      .set({ status: "active", mergedIntoPatientId: null, updatedBy: actor.id, updatedAt: new Date() })
      .where(and(eq(patients.id, req.loserId), eq(patients.status, "merged")))
      .returning({ id: patients.id });
    if (unfrozen.length === 0) throw new PatientError("patient_not_active", "loser record changed concurrently");

    await appendEvent(
      tx,
      patientUnmerged.make({
        actor,
        patientId: req.loserId,
        correlationId: approval.instanceId,
        payload: { winnerPatientId: req.winnerId, loserPatientId: req.loserId, mergeRequestId },
      }),
    );
  });
}
```

- [ ] **Step 3: Run the tests, then full verify + commit**

Run: `pnpm --filter @hmis/core test -- merge` → PASS (**6 tests** — the suite has six `it` blocks; an earlier draft of this line said 7, which no correct implementation could satisfy). Then `pnpm verify` (unpiped) → exit 0.

```bash
git add apps/core
git commit -m "feat(patients): merge/unmerge — Plan 04 approval-gated, single-winner execute, snapshot-recorded moves, act-first unmerge"
```

---

### Task 9: Module surface — controller, Nest wiring, `index.ts`, body-parser bump + first e2e

**Files:**
- Create: `apps/core/src/modules/patients/patients.controller.ts`
- Create: `apps/core/src/modules/patients/patients.module.ts`
- Create: `apps/core/src/modules/patients/index.ts`
- Create: `apps/core/src/app.bootstrap.ts`
- Modify: `apps/core/src/main.ts` (bodyParser off at create + `configureApp` — photos ride base64 JSON past the 100 kb Express default)
- Modify: `apps/core/src/app.module.ts` (imports `PatientsModule`, installs `patientsManifest` — exact new contents below)
- Create: `apps/core/test/patients.e2e.test.ts`

**Interfaces:**
- Consumes: every T2–T8 export; `DB`/`CONFIG` tokens; `CurrentActor`, `RequirePermission` (kernel auth); `SodViolationError`; `ApprovalError` (kernel approvals); `WorkflowError` (kernel workflow); `NestExpressApplication` (`@nestjs/platform-express` — already a dependency).
- Produces:
  - `configureApp(app: NestExpressApplication): void` — registers json (`limit: "1mb"` — the 512 kB photo cap is ~683 kB in base64) and urlencoded parsers; **callers must create the app with `{ bodyParser: false }`**. Used by `main.ts` and by the two new e2e suites; **existing e2e suites stay untouched** (their default parser is fine — no §3.6-style audit is triggered because no boot-time behavior changed for them).
  - **Photo transport is base64-in-JSON both directions** (`PUT` up: `{ imageBase64 }`; `GET` down: `{ mimeType, imageBase64 }`) — deliberate: `<img>` tags cannot send bearer tokens, so the web client fetches JSON and renders a data URL; no multipart, no new dependency.
  - 21 routes on one controller, `@RequirePermission(…, "hospital")` each, **literal segments declared before `:id` routes** (Nest matches in declaration order): `POST /patients` (.register) · `GET /patients/search` (.read) · `POST /patients/qr/verify` (.read — returns `QrVerifyResult` with **HTTP 200 even on `ok: false`**: a failed scan is a domain answer, not a transport error) · `POST /patients/merge-requests` (.merge) · `GET /patients/merge-requests/:id` (.read) · `POST /patients/merge-requests/:id/execute` (.merge) · `POST /patients/merge-requests/:id/unmerge-request` (.merge) · `POST /patients/merge-requests/:id/unmerge` (.merge) · `GET /patients/:id` (.read) · `PATCH /patients/:id` (.update) · `PUT /patients/:id/photo` (.update) · `GET /patients/:id/photo` (.read) · `GET /patients/:id/qr` (.read) · `POST /patients/:id/qr/reissue` (.update) · `POST /patients/:id/allergies` (.update) · `GET /patients/:id/allergies` (.read) · `POST /patients/:id/allergies/:allergyId/entered-in-error` (.update) · `POST /patients/:id/guardians` (.update) · `GET /patients/:id/guardians` (.read — each row paired with its **computed effective authority**) · `PATCH /patients/:id/guardians/:guardianId` (.update) · `POST /patients/:id/guardians/:guardianId/end` (.update).
  - One `toHttp`, defined once (house convention): `SodViolationError → 403` · `PatientError`: `*_not_found`/`unknown_merge_request → 404`, `photo_too_large → 413`, state-conflicts (`patient_not_active`, `merge_*`, `unmerge_*`, `approval_not_granted`, `allergy_not_active`, `guardian_not_active`) `→ 409`, rest `→ 400` · `ApprovalError → 409` (e.g. `unknown_type` when the merge types aren't registered yet — the runbook step) · `WorkflowError → 409` · anything else rethrows (a 500 is a genuine bug, loudly).
  - `index.ts` — **the module's declared cross-module interface (spec §4)**: re-exports `patientsManifest`, `PatientsModule`, `getPatient`, `resolvePatientId`, `registerPatient`, `updatePatient`, `searchPatients`, `effectiveGuardianAuthority`, `NO_AUTHORITY`, `sweepGuardianMajority` (Plan 11 registers it as a pg-boss cron from HERE, never from the module's internals), `isValidUhid`, `PatientError`, all event defs, and the public types. Later modules import **only** from here or consume events; the lint rule enforces it.

- [ ] **Step 1: Write the failing e2e (before the controller exists — its first honest run fails at import; that IS the evidence)**

`apps/core/test/patients.e2e.test.ts` — bootstrap copied from the shipped `approvals.e2e.test.ts` pattern (per-worker `DATABASE_URL` derivation verbatim), plus the body-parser configuration:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { patientsManifest } from "../src/modules/patients";
import { registrationConfig } from "../src/kernel/db/schema";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

describe("patients e2e", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  registry.install(patientsManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let clerkToken: string;
  let randoToken: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>(undefined, { bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    await syncPermissions(db, registry);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "e2e" });
    await createRole(db, "reg_desk", "Registration Desk");
    for (const p of patientsManifest.permissions) {
      await grantPermissionToRole(db, registry, "reg_desk", p);
    }
    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const clerk = await mk("clerk");
    const rando = await mk("rando");
    clerkToken = clerk.token;
    randoToken = rando.token;
    await assignRole(db, { userId: clerk.id, roleKey: "reg_desk", scopeType: "hospital" });
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];

  it("401 without a token; 403 without the permission", async () => {
    await request(app.getHttpServer()).get("/patients/search").query({ q: "98765" }).expect(401);
    await request(app.getHttpServer()).get("/patients/search").query({ q: "98765" }).set(...auth(randoToken)).expect(403);
  });

  it("register → search → read → patch, with a valid UHID and events behind it", async () => {
    const reg = await request(app.getHttpServer())
      .post("/patients")
      .set(...auth(clerkToken))
      .send({ name: "Asha Devi", sex: "female", phone: "9876543210", language: "hi" })
      .expect(201);
    const patientId = reg.body.patient.id as string;
    expect(reg.body.patient.uhid).toMatch(/^HMS-\d{8}-\d$/);

    const found = await request(app.getHttpServer())
      .get("/patients/search").query({ q: "98765" }).set(...auth(clerkToken)).expect(200);
    expect(found.body.items).toHaveLength(1);
    expect(found.body.items[0].id).toBe(patientId);
    expect(found.body.items[0].hasPhoto).toBe(false);

    await request(app.getHttpServer()).get(`/patients/${patientId}`).set(...auth(clerkToken)).expect(200);
    const patched = await request(app.getHttpServer())
      .patch(`/patients/${patientId}`).set(...auth(clerkToken))
      .send({ language: "en" }).expect(200);
    expect(patched.body.changed).toEqual(["language"]);
    await request(app.getHttpServer()).get("/patients/01NOSUCH00000000000000000").set(...auth(clerkToken)).expect(404);
  });

  it("photo round-trips as base64 JSON — a ~300 kB body proves the parser bump", async () => {
    const reg = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Photo P", sex: "other" }).expect(201);
    const id = reg.body.patient.id as string;
    const bytes = Buffer.alloc(300_000, 7);
    await request(app.getHttpServer())
      .put(`/patients/${id}/photo`).set(...auth(clerkToken))
      .send({ imageBase64: bytes.toString("base64") }).expect(200);
    const got = await request(app.getHttpServer())
      .get(`/patients/${id}/photo`).set(...auth(clerkToken)).expect(200);
    expect(got.body.mimeType).toBe("image/jpeg");
    expect(Buffer.compare(Buffer.from(got.body.imageBase64, "base64"), bytes)).toBe(0);
    expect((await request(app.getHttpServer())
      .get("/patients/search").query({ q: "photo" }).set(...auth(clerkToken))).body.items[0].hasPhoto).toBe(true);
  });

  it("allergies and guardians ride their routes; guardians return computed effective authority", async () => {
    const reg = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Minor M", sex: "other", ageYears: 10, guardian: { name: "G", relationship: "mother" } })
      .expect(201);
    const id = reg.body.patient.id as string;

    const allergy = await request(app.getHttpServer())
      .post(`/patients/${id}/allergies`).set(...auth(clerkToken))
      .send({ substance: "penicillin", severity: "severe", source: "registration" }).expect(201);
    await request(app.getHttpServer())
      .post(`/patients/${id}/allergies/${allergy.body.allergyId}/entered-in-error`)
      .set(...auth(clerkToken)).send({ reason: "wrong record" }).expect(201);
    const list = await request(app.getHttpServer())
      .get(`/patients/${id}/allergies`).set(...auth(clerkToken)).expect(200);
    expect(list.body.items[0].status).toBe("entered_in_error");

    const guardians = await request(app.getHttpServer())
      .get(`/patients/${id}/guardians`).set(...auth(clerkToken)).expect(200);
    expect(guardians.body.items).toHaveLength(1);
    expect(guardians.body.items[0].effectiveAuthority).toEqual({
      messages: true, consents: true, dsr: false, bills: true,
    });
    await request(app.getHttpServer())
      .post(`/patients/${id}/guardians/${guardians.body.items[0].guardian.id}/end`)
      .set(...auth(clerkToken)).expect(201);
  });

  it("QR: card payload prints, verify resolves, tampering answers ok:false over HTTP 200 (route order proven)", async () => {
    const reg = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Card C", sex: "male", phone: "9000000001" }).expect(201);
    const id = reg.body.patient.id as string;

    const card = await request(app.getHttpServer())
      .get(`/patients/${id}/qr`).set(...auth(clerkToken)).expect(200);
    expect(card.body.payload.startsWith("q1.")).toBe(true);

    const ok = await request(app.getHttpServer())
      .post("/patients/qr/verify").set(...auth(clerkToken))
      .send({ payload: card.body.payload }).expect(201);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.patient.id).toBe(id);

    const bad = await request(app.getHttpServer())
      .post("/patients/qr/verify").set(...auth(clerkToken))
      .send({ payload: card.body.payload.slice(0, -2) + "xx" }).expect(201);
    expect(bad.body).toEqual({ ok: false, reason: "invalid_signature" });

    const re = await request(app.getHttpServer())
      .post(`/patients/${id}/qr/reissue`).set(...auth(clerkToken)).expect(201);
    expect(re.body.qrVersion).toBe(2);
    const stale = await request(app.getHttpServer())
      .post("/patients/qr/verify").set(...auth(clerkToken))
      .send({ payload: card.body.payload }).expect(201);
    expect(stale.body).toEqual({ ok: false, reason: "stale_version" });
  });

  it("merge routes 409 with a clear ApprovalError until the types are registered (the runbook step)", async () => {
    const a = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken)).send({ name: "A", sex: "male" }).expect(201);
    const b = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken)).send({ name: "B", sex: "male" }).expect(201);
    await request(app.getHttpServer())
      .post("/patients/merge-requests").set(...auth(clerkToken))
      .send({ winnerId: a.body.patient.id, loserId: b.body.patient.id, note: "dup" })
      .expect(409); // unknown approval type patient_merge — registration is go-live data, T10 exercises the full path
  });
});
```

Run: `pnpm --filter @hmis/core test -- patients.e2e` — expect FAIL at import (`../src/app.bootstrap` / controller do not exist). Fail-first evidence.

- [ ] **Step 2: `app.bootstrap.ts`, `main.ts`, module, `index.ts`**

`apps/core/src/app.bootstrap.ts`:
```ts
import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * Shared HTTP configuration for main.ts AND e2e apps. Express's default json limit is 100 kb;
 * patient photos ride base64 JSON (512 kB cap ≈ 683 kB encoded), so the app registers its own
 * parsers. Callers MUST create the Nest app with { bodyParser: false } or two parsers stack.
 */
export function configureApp(app: NestExpressApplication): void {
  app.useBodyParser("json", { limit: "1mb" });
  app.useBodyParser("urlencoded", { extended: true });
}
```

`apps/core/src/main.ts` — complete new contents (two changed lines vs shipped: the create options + `configureApp`):
```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app.bootstrap";
import { loadConfig } from "./kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(cfg.port);
}
void bootstrap();
```

`apps/core/src/modules/patients/patients.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { PatientsController } from "./patients.controller";

// Controller only — AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02).
@Module({ controllers: [PatientsController] })
export class PatientsModule {}
```

`apps/core/src/modules/patients/index.ts`:
```ts
/**
 * THE cross-module interface of the patients module (spec §4). Later modules import from
 * here or consume events — never internals; the module-isolation lint rule enforces it.
 * Everything else in this folder is private.
 */
export { patientsManifest } from "./manifest";
export { PatientsModule } from "./patients.module";
export { getPatient, registerPatient, resolvePatientId, updatePatient } from "./registration";
export type { GuardianInput, PatientPatch, PatientRow, RegisterPatientInput } from "./registration";
export { searchPatients } from "./search";
export type { PatientSearchResult } from "./search";
export { NO_AUTHORITY, effectiveGuardianAuthority, sweepGuardianMajority } from "./guardians";
export type { GuardianAuthority, GuardianRow } from "./guardians";
export { isValidUhid, PatientError } from "./uhid";
export type { PatientErrorCode } from "./uhid";
export * from "./events";
```

`apps/core/src/app.module.ts` — complete new contents (three added lines vs shipped, marked):
```ts
import { Module, Global, Inject, OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import { createDb, Db } from "./kernel/db/client";
import { loadConfig, AppConfig } from "./kernel/config";
import { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "./kernel/tokens";
import { ModuleRegistry } from "./kernel/modules/loader";
import { authManifest } from "./kernel/auth/manifest";
import { workflowManifest } from "./kernel/workflow/manifest";
import { approvalsManifest } from "./kernel/approvals/manifest";
import { patientsManifest, PatientsModule } from "./modules/patients"; // ← added (imports the module's index — spec §4)
import { HealthController } from "./health/health.controller";
import { AuthModule } from "./kernel/auth/auth.module";
import { WorkflowModule } from "./kernel/workflow/workflow.module";
import { ApprovalsModule } from "./kernel/approvals/approvals.module";

export { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "./kernel/tokens";

type DbBundle = { db: Db; pool: Pool };
const DB_BUNDLE = Symbol("DB_BUNDLE");

@Global()
@Module({
  imports: [AuthModule, WorkflowModule, ApprovalsModule, PatientsModule], // ← PatientsModule added
  controllers: [HealthController],
  providers: [
    { provide: CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: DB_BUNDLE,
      useFactory: (cfg: AppConfig): DbBundle => createDb(cfg.databaseUrl),
      inject: [CONFIG],
    },
    { provide: DB, useFactory: (b: DbBundle): Db => b.db, inject: [DB_BUNDLE] },
    { provide: DB_POOL, useFactory: (b: DbBundle): Pool => b.pool, inject: [DB_BUNDLE] },
    {
      provide: MODULE_REGISTRY,
      useFactory: (): ModuleRegistry => {
        const registry = new ModuleRegistry();
        registry.install(authManifest);
        registry.install(workflowManifest);
        registry.install(approvalsManifest);
        registry.install(patientsManifest); // ← added; syncPermissions mirrors it at boot — no new boot-time DB call
        // Later plans install their module manifests here.
        return registry;
      },
    },
  ],
  exports: [DB, DB_POOL, CONFIG, MODULE_REGISTRY],
})
export class AppModule implements OnModuleDestroy {
  private poolClosed = false;

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    // Own flag, not pg's pool.ended: that runtime property is missing from @types/pg
    // (typecheck failure), and a double app.close() must stay safe.
    if (this.poolClosed) return;
    this.poolClosed = true;
    await this.pool.end();
  }
}
```

- [ ] **Step 3: Write the controller**

`apps/core/src/modules/patients/patients.controller.ts`:
```ts
import {
  BadRequestException, Body, Controller, ConflictException, ForbiddenException, Get, Inject,
  NotFoundException, Param, Patch, PayloadTooLargeException, Post, Put, Query,
} from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { SodViolationError } from "../../kernel/auth/sod";
import { ApprovalError } from "../../kernel/approvals/types";
import { WorkflowError } from "../../kernel/workflow/instances";
import { withTx } from "../../kernel/db/client";
import { PatientError } from "./uhid";
import { getPatient, registerPatient, updatePatient } from "./registration";
import { searchPatients } from "./search";
import { getPatientPhoto, storePatientPhoto } from "./photos";
import { addAllergy, listAllergies, markAllergyEnteredInError } from "./allergies";
import { effectiveGuardianAuthority, endGuardian, linkGuardian, updateGuardianAuthority } from "./guardians";
import { patientGuardians } from "../../kernel/db/schema";
import { eq } from "drizzle-orm";
import { buildQrPayload, reissueQrCard, verifyQrScan } from "./qr";
import { createMergeRequest, executeMerge, executeUnmerge, getMergeRequest, requestUnmerge } from "./merge";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

const NOT_FOUND_CODES = new Set(["patient_not_found", "unknown_merge_request", "allergy_not_found", "guardian_not_found"]);
const CONFLICT_CODES = new Set([
  "patient_not_active", "merge_same_patient", "merge_already_requested", "merge_not_requested",
  "merge_not_executed", "approval_not_granted", "unmerge_already_requested", "unmerge_not_requested",
  "allergy_not_active", "guardian_not_active",
]);

/** Patients errors → HTTP, defined once. Unrecognized errors rethrow — a 500 is a genuine bug, loudly. */
function toHttp(e: unknown): never {
  if (e instanceof SodViolationError) throw new ForbiddenException(e.message);
  if (e instanceof PatientError) {
    if (NOT_FOUND_CODES.has(e.code)) throw new NotFoundException(e.message);
    if (e.code === "photo_too_large") throw new PayloadTooLargeException(e.message);
    if (CONFLICT_CODES.has(e.code)) throw new ConflictException(e.message);
    throw new BadRequestException(e.message);
  }
  // Merge-request paths surface these when the approval types are not yet registered (runbook)
  // or the backing definition moved — state conflicts, not client mistakes.
  if (e instanceof ApprovalError) throw new ConflictException(e.message);
  if (e instanceof WorkflowError) throw new ConflictException(e.message);
  throw e;
}

const sexEnum = z.enum(["male", "female", "other", "unknown"]);
const languageEnum = z.enum(["hi", "en"]);
const bloodGroupEnum = z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]);
const severityEnum = z.enum(["mild", "moderate", "severe"]);
const relationshipEnum = z.enum(["father", "mother", "spouse", "sibling", "legal_guardian", "other"]);
const phoneField = z.string().regex(/^[6-9]\d{9}$/, "10-digit Indian mobile");

const guardianBody = z.object({
  name: z.string().min(1),
  phone: phoneField.optional(),
  relationship: relationshipEnum,
  idType: z.enum(["aadhaar", "pan", "voter_id", "other"]).optional(),
  idNumberMasked: z.string().max(4).optional(),
  idVerified: z.boolean().optional(),
  authorityMessages: z.boolean().optional(),
  authorityConsents: z.boolean().optional(),
  authorityDsr: z.boolean().optional(),
  authorityBills: z.boolean().optional(),
  consentNote: z.string().optional(),
});

const registerBody = z.object({
  name: z.string().min(1).max(200),
  phone: phoneField.optional(),
  altPhone: phoneField.optional(),
  dob: z.coerce.date().optional(),
  ageYears: z.number().int().min(0).max(130).optional(),
  sex: sexEnum,
  addressLine: z.string().max(500).optional(),
  district: z.string().max(100).optional(),
  stateName: z.string().max(100).optional(),
  pincode: z.string().regex(/^\d{6}$/).optional(),
  language: languageEnum.optional(),
  bloodGroup: bloodGroupEnum.optional(),
  isConfidential: z.boolean().optional(),
  alias: z.string().max(200).optional(),
  sensitiveContext: z.boolean().optional(),
  abhaAddress: z.string().max(200).optional(),
  abhaNumber: z.string().max(20).optional(),
  abhaVerificationStatus: z.enum(["none", "self_declared", "verified"]).optional(),
  legacyUhid: z.string().max(50).optional(),
  guardian: guardianBody.optional(),
});

const patchBody = registerBody
  .omit({ ageYears: true, guardian: true })
  .partial()
  .extend({
    phone: phoneField.nullable().optional(),
    altPhone: phoneField.nullable().optional(),
    dob: z.coerce.date().nullable().optional(),
    dobEstimated: z.boolean().optional(),
    alias: z.string().max(200).nullable().optional(),
    bloodGroup: bloodGroupEnum.nullable().optional(),
    abhaAddress: z.string().max(200).nullable().optional(),
    abhaNumber: z.string().max(20).nullable().optional(),
    abhaLinkToken: z.string().max(500).nullable().optional(),
    legacyUhid: z.string().max(50).nullable().optional(),
    addressLine: z.string().max(500).nullable().optional(),
    district: z.string().max(100).nullable().optional(),
    stateName: z.string().max(100).nullable().optional(),
    pincode: z.string().regex(/^\d{6}$/).nullable().optional(),
  });

const searchQuery = z.object({ q: z.string(), limit: z.coerce.number().int().positive().max(50).optional() });
const photoBody = z.object({ imageBase64: z.string().min(1) });
const allergyBody = z.object({
  substance: z.string().min(1).max(200),
  reaction: z.string().max(500).optional(),
  severity: severityEnum.optional(),
  source: z.enum(["registration", "vitals", "consult"]),
});
const reasonBody = z.object({ reason: z.string().min(1) });
const guardianPatchBody = z.object({
  messages: z.boolean().optional(),
  consents: z.boolean().optional(),
  dsr: z.boolean().optional(),
  bills: z.boolean().optional(),
  phone: phoneField.nullable().optional(),
  idVerified: z.boolean().optional(),
  validTo: z.coerce.date().nullable().optional(),
  consentNote: z.string().nullable().optional(),
});
const qrVerifyBody = z.object({ payload: z.string().min(1).max(500) });
const mergeBody = z.object({ winnerId: z.string().min(1), loserId: z.string().min(1), note: z.string().min(1) });
const unmergeBody = z.object({ note: z.string().min(1), actFirst: z.boolean().optional() });

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

@Controller("patients")
export class PatientsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ——— literal-segment routes FIRST (Nest matches in declaration order) ———

  @RequirePermission("patients.read", "hospital")
  @Get("search")
  async search(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ items: unknown[] }> {
    const q = parsed(searchQuery, query);
    try {
      return { items: await searchPatients(this.db, actor, q.q, q.limit) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.read", "hospital")
  @Post("qr/verify")
  async qrVerify(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(qrVerifyBody, body);
    try {
      return await verifyQrScan(this.db, this.cfg, actor, b.payload); // 200-class even on ok:false — a scan answer, not a transport error
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.merge", "hospital")
  @Post("merge-requests")
  async mergeRequest(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(mergeBody, body);
    try {
      return await withTx(this.db, (tx) => createMergeRequest(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.read", "hospital")
  @Get("merge-requests/:id")
  async mergeDetail(@Param("id") id: string): Promise<unknown> {
    const view = await getMergeRequest(this.db, id);
    if (!view) throw new NotFoundException(`unknown merge request ${id}`);
    return view;
  }

  @RequirePermission("patients.merge", "hospital")
  @Post("merge-requests/:id/execute")
  async mergeExecute(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try {
      return await executeMerge(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.merge", "hospital")
  @Post("merge-requests/:id/unmerge-request")
  async unmergeRequest(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(unmergeBody, body);
    try {
      return await withTx(this.db, (tx) => requestUnmerge(tx, actor, { mergeRequestId: id, ...b }));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.merge", "hospital")
  @Post("merge-requests/:id/unmerge")
  async unmergeExecute(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ ok: true }> {
    try {
      await executeUnmerge(this.db, actor, id);
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.register", "hospital")
  @Post()
  async register(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(registerBody, body);
    try {
      return await withTx(this.db, (tx) => registerPatient(tx, actor, b));
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— :id routes ———

  @RequirePermission("patients.read", "hospital")
  @Get(":id")
  async detail(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    const found = await getPatient(this.db, actor, id);
    if (!found) throw new NotFoundException(`unknown patient ${id}`);
    return found;
  }

  @RequirePermission("patients.update", "hospital")
  @Patch(":id")
  async patch(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(patchBody, body);
    try {
      return await withTx(this.db, (tx) => updatePatient(tx, actor, id, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.update", "hospital")
  @Put(":id/photo")
  async putPhoto(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const b = parsed(photoBody, body);
    try {
      const bytes = Buffer.from(b.imageBase64, "base64");
      await withTx(this.db, (tx) => storePatientPhoto(tx, actor, id, { mimeType: "image/jpeg", bytes }));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.read", "hospital")
  @Get(":id/photo")
  async getPhoto(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ mimeType: string; imageBase64: string }> {
    const photo = await getPatientPhoto(this.db, actor, id);
    if (!photo) throw new NotFoundException("no photo");
    return { mimeType: photo.mimeType, imageBase64: photo.bytes.toString("base64") };
  }

  @RequirePermission("patients.read", "hospital")
  @Get(":id/qr")
  async qrCard(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    const found = await getPatient(this.db, actor, id);
    if (!found) throw new NotFoundException(`unknown patient ${id}`);
    const p = found.patient;
    return { payload: buildQrPayload(this.cfg, p), uhid: p.uhid, name: p.name, sex: p.sex, dob: p.dob };
  }

  @RequirePermission("patients.update", "hospital")
  @Post(":id/qr/reissue")
  async qrReissue(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try {
      return await reissueQrCard(this.db, this.cfg, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.update", "hospital")
  @Post(":id/allergies")
  async postAllergy(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(allergyBody, body);
    try {
      return await withTx(this.db, (tx) => addAllergy(tx, actor, id, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.read", "hospital")
  @Get(":id/allergies")
  async getAllergies(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    const found = await getPatient(this.db, actor, id);
    if (!found) throw new NotFoundException(`unknown patient ${id}`);
    return { items: await listAllergies(this.db, found.patient.id) };
  }

  @RequirePermission("patients.update", "hospital")
  @Post(":id/allergies/:allergyId/entered-in-error")
  async allergyError(
    @CurrentActor() actor: Actor,
    @Param("allergyId") allergyId: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(reasonBody, body);
    try {
      await withTx(this.db, (tx) => markAllergyEnteredInError(tx, actor, allergyId, b.reason));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.update", "hospital")
  @Post(":id/guardians")
  async postGuardian(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(guardianBody, body);
    try {
      return await withTx(this.db, (tx) => linkGuardian(tx, actor, id, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.read", "hospital")
  @Get(":id/guardians")
  async getGuardians(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    const found = await getPatient(this.db, actor, id);
    if (!found) throw new NotFoundException(`unknown patient ${id}`);
    const rows = await this.db
      .select()
      .from(patientGuardians)
      .where(eq(patientGuardians.patientId, found.patient.id));
    return {
      items: rows.map((g) => ({ guardian: g, effectiveAuthority: effectiveGuardianAuthority(found.patient, g) })),
    };
  }

  @RequirePermission("patients.update", "hospital")
  @Patch(":id/guardians/:guardianId")
  async patchGuardian(
    @CurrentActor() actor: Actor,
    @Param("guardianId") guardianId: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(guardianPatchBody, body);
    try {
      await withTx(this.db, (tx) => updateGuardianAuthority(tx, actor, guardianId, b));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("patients.update", "hospital")
  @Post(":id/guardians/:guardianId/end")
  async endGuardianRoute(@CurrentActor() actor: Actor, @Param("guardianId") guardianId: string): Promise<{ ok: true }> {
    try {
      await withTx(this.db, (tx) => endGuardian(tx, actor, guardianId));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }
}
```

- [ ] **Step 4: Run the e2e, then full verify + commit**

Run: `pnpm --filter @hmis/core test -- patients.e2e` → PASS (6 tests). Then `pnpm verify` (unpiped) → exit 0 — this also re-proves every existing e2e still passes with its default body parser.

```bash
git add apps/core
git commit -m "feat(patients): module surface — 21 routes, index interface, AppModule wiring, base64 photo transport, first e2e"
```

---

### Task 10: Full-lifecycle e2e over HTTP + docs (registration → merge → unmerge → sweep)

**Files:**
- Create: `apps/core/test/patients-lifecycle.e2e.test.ts`
- Modify: `README.md` (patients module section + go-live runbook block — exact text below)

**This task owes NO red run** (EXECUTION-LESSONS §3.5, stated explicitly): it adds an e2e over code shipped and gated in T1–T9, plus documentation. The evidence replacing fail-first: the new suite passing on its first honest run, `pnpm verify` green, and the CI run observed green on the pushed commit.

**Interfaces:** consumes only shipped surfaces (T9 routes, `/approvals/*` routes from Plan 04, `sweepGuardianMajority` called directly — sweeps are cron surfaces with no HTTP route, exactly like `runDueTimers` in Plan 04's T8).

- [ ] **Step 1: Write the lifecycle e2e**

`apps/core/test/patients-lifecycle.e2e.test.ts` — same bootstrap as `patients.e2e.test.ts` (per-worker DATABASE_URL, `{ bodyParser: false }` + `configureApp`), with FOUR users: `clerk` (role `reg_desk`: all five `patients.*` permissions — NO approvals permission is needed: `createMergeRequest` calls the `requestApproval` SERVICE on its own transaction, and service calls carry no route guard), `mrd` (role `mrd_head` + a role holding `approvals.requests.read` + `approvals.requests.decide`), `drafter`/`activator` (role `wf_admin` with `workflow.definitions.*`; activator also `approvals.types.manage`). `beforeEach` seeds SoD pairs, syncs permissions, seeds `registration_config`, and registers both approval types over HTTP: draft each `approvalFlowDefinition(...)` via `POST /workflow/definitions` (drafter), activate via `POST /workflow/definitions/:id/activate` (activator — Class C needs no approvals; drafter≠activator satisfies the SoD pair), then `POST /approvals/types` (activator). One `it` block, sequential legs:

1. **Register the duplicate pair:** clerk registers "Asha Devi" (phone `9876543210`, `language: "hi"`) and "Asha Debi" (same phone) → both UHIDs match `/^HMS-\d{8}-\d$/`; search `98765` returns both — the C-18 desk moment.
2. **Photo lands on the loser** (300 kB base64), search shows `hasPhoto: true` — the attach prompt's raw material.
3. **Merge request over HTTP:** `POST /patients/merge-requests` (winner Asha Devi, loser Asha Debi, note) → 201; `GET /patients/merge-requests/:id` shows `approvalStatus: "pending"`; **execute before grant → 409**.
4. **Approver's worklist:** `GET /approvals?status=pending` as mrd shows exactly the merge approval (`typeKey: "patient_merge"`, `urgencyClass: "routine"`); **clerk self-approval → 403** (`requester_approver` SoD via Plan 02, proven over HTTP); mrd approves with a note → 201.
5. **Execute:** `POST .../execute` → 201 `{ winnerId, loserId }` (Nest POST default); `GET /patients/<loserId>` returns the WINNER with `resolvedFrom: <loserId>`; loser's old QR payload (captured in leg 2 via `GET /patients/:id/qr` before merge) now verifies to the winner's id.
6. **Act-first unmerge:** `POST .../unmerge-request` with `actFirst: true` + note → 201; `POST .../unmerge` **while the approval is still pending** → 201 (E-15 act-first-review-after, end to end); loser is `active` again, `resolvedFrom: null`; mrd later rejects the unmerge approval with a note → 201 (the review closes; nothing rolls back — assert loser still active).
7. **Guardian majority:** clerk registers a minor with `dob` set 18 years minus 10 days ago and a guardian; `sweepGuardianMajority(db, new Date())` returns 0 (not yet 18); `sweepGuardianMajority(db, tenDaysAhead)` returns 1 and the guardian row is `majority_ended`; a second run at the same instant returns 0.
8. **Event-trail audit:** the `events` table now contains ≥ 1 each of `patient.registered` (×3), `patient.updated`, `patient.merged`, `patient.unmerged`, `guardian.linked`, `guardian.authority_changed`, and `approval.requested/.granted` — every name in this plan's catalog slice that the journey exercises, asserted by name with exact counts.

Assertions use parsed structures only (no `JSON.stringify` — §3.11); the loser-code and status assertions match T8's enumerated codes exactly.

- [ ] **Step 2: README — append this section verbatim**

```markdown
## Patients module (Plan 05)

The first domain module: `apps/core/src/modules/patients/` owns the patient master (spec §6).
Other modules reference `patient_id` and import ONLY from `modules/patients/index` (or consume
events) — the module-isolation lint rule enforces it. UHID = `<PREFIX>-<8 digits>-<Verhoeff>`;
phone-first search carries a CI-enforced <300 ms budget (`test/perf-patient-search.test.ts`).
Merge/unmerge are approval-gated through the approvals engine (types `patient_merge`,
`patient_unmerge` — act-first enabled). Guardian majority is read-time-enforced;
`sweepGuardianMajority` is the FOURTH unscheduled sweep (pg-boss cron in Plan 11, with
`runDispatchCycle`, `sweepExpiredTempRoles`, `runDueTimers`).

### Go-live runbook (owner steps, once per environment)
1. Choose the UHID prefix (Class A decision — printed on every card):
   `UHID_PREFIX=<PREFIX> pnpm --filter @hmis/core seed:registration`
2. Register the merge approval types as data (no code): build each definition with
   `approvalFlowDefinition({ typeKey: "patient_merge" | "patient_unmerge", approverRole: <role>, ... })`,
   draft + activate through `/workflow/definitions` (drafter ≠ activator), then `POST /approvals/types`
   (`patient_unmerge` with `urgencyClass: "urgent", actFirstAllowed: true`).
3. Grant `patients.*` permissions to the registration-desk role; `patients.confidential.read`
   and `patients.merge` only to the roles the owner designates.
```

- [ ] **Step 3: Full verify + commit**

Run: `pnpm --filter @hmis/core test -- patients-lifecycle` → PASS. Then `pnpm verify` (unpiped) → exit 0.

```bash
git add apps/core README.md
git commit -m "feat(patients): full-lifecycle e2e — register to merge/unmerge via approvals, act-first, majority sweep; docs"
```

---

### Task 11: `apps/web` scaffold — Vite + React + Tailwind 4 + Vitest, riding root verify

**Files:**
- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles.css`, `apps/web/src/test-setup.ts`, `apps/web/src/App.test.tsx`
- Modify: root `eslint.config.mjs` (complete new contents below), root `package.json` (ONE devDependency line), `pnpm-lock.yaml` (committed — tripwire 12; **the first dependency change since Plan 01**)

**This is the toolchain task.** It must end with `pnpm verify` green **repo-wide** — that single command now typechecks, lints, and tests three workspaces. Two structural facts make this task load-bearing: root `test` is `pnpm -r test` with **no `--if-present`**, so `apps/web` must carry a working `test` script from this very commit; and root `typecheck` is `pnpm -r exec tsc --noEmit`, so `apps/web/tsconfig.json` must be a single self-contained config (**no project references** — `tsc --noEmit` against a references-only config checks nothing and silently passes).

**Interfaces / decisions:**
- All non-shadcn dependencies land HERE, including ones first used in T12–T16 (`qrcode.react`, RHF, i18next) — later web tasks never touch `package.json` except T13's shadcn CLI (§3.1: files named where touched). Version ranges are known-published floors; pnpm resolves and the lockfile pins. **If any range fails to resolve at install, that is a plan defect — report it, don't guess versions.**
- `tsconfig.json` deliberately does **not** extend `tsconfig.base.json`: the base is NodeNext/Node-only; the web app needs `moduleResolution: "bundler"`, `jsx: "react-jsx"`, DOM libs. Strictness flags are replicated instead.
- TanStack Router is **code-based** (no `@tanstack/router-plugin`, no generated `routeTree.gen.ts`) — no codegen file to commit, lint, or ignore.
- pnpm 10 `ignoredBuilds` will block esbuild's postinstall (the argon2 precedent — do NOT add `onlyBuiltDependencies`); esbuild ships platform binaries as optionalDependencies, so Vite/Vitest run regardless — proven below by executing them.

- [ ] **Step 1: Write the failing smoke test first**

`apps/web/src/App.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("renders the app shell placeholder", () => {
  render(<App />);
  expect(screen.getByText("HMIS")).toBeInTheDocument();
});
```
This file exists before `App.tsx` — after Step 2's install, `pnpm --filter @hmis/web test` fails at the unresolved import. That is the fail-first evidence for the scaffold (config files themselves owe none; their evidence is the verify-by-execution flags below).

- [ ] **Step 2: The workspace files** — write everything below EXCEPT `src/App.tsx` and `src/main.tsx` (those come in Step 4, after the red run)

`apps/web/package.json`:
```json
{
  "name": "@hmis/web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "@hookform/resolvers": "^5.0.0",
    "@tanstack/react-query": "^5.60.0",
    "@tanstack/react-router": "^1.90.0",
    "i18next": "^25.0.0",
    "qrcode.react": "^4.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-hook-form": "^7.54.0",
    "react-i18next": "^15.4.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "jsdom": "^26.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.0",
    "vite": "^7.0.0",
    "vitest": "^3.0.0"
  }
}
```

`apps/web/vite.config.ts`:
```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // Dev-only convenience; production serving is Caddy (Plan 11). Same-origin '/…' paths in code.
    proxy: {
      "/auth": "http://localhost:3000",
      "/patients": "http://localhost:3000",
      "/approvals": "http://localhost:3000",
      "/workflow": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
```

`apps/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vite.config.ts"]
}
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HMIS</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/styles.css`:
```css
@import "tailwindcss";

/* Print is a first-class surface (§15): screen chrome vanishes, print-only blocks appear. */
@media print {
  .no-print { display: none !important; }
}
@media screen {
  .print-only { display: none !important; }
}
```

`apps/web/src/App.tsx`:
```tsx
export function App(): React.ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-semibold">HMIS</h1>
    </main>
  );
}
```

`apps/web/src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

`apps/web/src/test-setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 3: Root config — complete new `eslint.config.mjs`**

The existing file plus one import and two appended blocks; every existing block byte-identical:
```js
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/drizzle/**", "**/node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["apps/core/src/modules/**/*.ts"],
    rules: {
      // NOTE: the plan's literal patterns (["../*/!(index)", ...]) use bash-style
      // extglob syntax. ESLint 9's no-restricted-imports "patterns.group" matches via
      // the `ignore` npm package (gitignore semantics), which does not support
      // extglob — verified empirically that none of the four extglob patterns ever
      // match any import specifier, so the rule as literally written never fires.
      // Rewritten below to the same intent using gitignore-compatible syntax: a
      // module-name segment restricted to identifier characters (so it can never
      // match the literal ".." of a deeper kernel import) instead of "!(index)",
      // plus a same-shape negation to exempt the module's own index. Verified against
      // sibling-module internals (blocked), sibling-module index (allowed), kernel
      // imports at any depth (allowed), and bare package specifiers (allowed).
      "no-restricted-imports": ["error", {
        patterns: [{
          group: [
            "../[a-zA-Z0-9_-]*/**",
            "!../[a-zA-Z0-9_-]*/index",
            "**/modules/[a-zA-Z0-9_-]*/**",
            "!**/modules/[a-zA-Z0-9_-]*/index",
          ],
          message: "Modules may only import another module's index.ts (its declared interface). Cross-module internals are forbidden (spec §4).",
        }],
      }],
    },
  },
  {
    // Accommodation for pre-existing committed code (Task 4 test helper destructuring):
    // typescript-eslint's recommended no-unused-vars flags `pool` in
    // apps/core/src/kernel/db/schema/events.test.ts, captured from setupTestDb() per the
    // plan's exact Step 3 text but not read directly in the test body. Do not rewrite
    // committed test files to satisfy the linter; relax this one rule for test files
    // instead. Does not touch the module-isolation rule above.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // apps/web (Plan 05): the hooks rules catch the one class of silent UI bug lint can
    // catch. Plugin registered manually — no preset dependency on the plugin's config names.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // shadcn CLI output (Plan 05 T13) uses `interface X extends Y {}` idioms; generated
    // code is registry-owned — relax, don't rewrite (the deviations-not-to-fix principle).
    files: ["apps/web/src/components/ui/**"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
);
```

Root `package.json`: add ONE line to the `"devDependencies"` object (keep every existing entry byte-identical): `"eslint-plugin-react-hooks": "^5.2.0"`.

- [ ] **Step 4: Install, red run, then make it green and prove the toolchain**

```bash
cd /opt/hmis && git pull --rebase origin main && pnpm install
pnpm --filter @hmis/web test        # RED: App.test.tsx cannot resolve ./App — the fail-first evidence
```
Now write `src/App.tsx` and `src/main.tsx` exactly as shown in Step 2's blocks, then:
```bash
pnpm --filter @hmis/web test        # GREEN: 1 test
pnpm --filter @hmis/web build       # proves vite + esbuild work under ignoredBuilds (VERIFY-BY-EXECUTION)
pnpm --filter @hmis/web exec tsc --noEmit --listFiles | grep -c "src/App.tsx"   # ≥1: tsc REALLY checks src (no silent no-op config)
pnpm verify                         # repo-wide: three workspaces typecheck, lint, test — unpiped, real exit code
```
Expected: build emits `dist/` (git-ignored already via `**/dist/**`), listFiles counts ≥ 1, verify exit 0.

```bash
git add apps/web eslint.config.mjs package.json pnpm-lock.yaml
git commit -m "feat(web): apps/web scaffold — Vite+React+Tailwind4+Vitest riding root verify; react-hooks lint"
```

---

### Task 12: App shell — API client, auth, i18n (hi/en), router, keyboard kit

**Files:**
- Create: `apps/web/src/lib/api.ts`, `apps/web/src/lib/auth.tsx`, `apps/web/src/lib/i18n.ts`, `apps/web/src/locales/en.json`, `apps/web/src/locales/hi.json`, `apps/web/src/lib/keyboard.tsx`, `apps/web/src/router.tsx`, `apps/web/src/screens/login.tsx`, `apps/web/src/test-utils.tsx`
- Create (tests): `apps/web/src/lib/api.test.ts`, `apps/web/src/lib/i18n.test.ts`, `apps/web/src/screens/login.test.tsx`
- Modify: `apps/web/src/main.tsx`, `apps/web/src/App.tsx` (shell replaces placeholder — complete new contents below), `apps/web/src/App.test.tsx` (smoke assertion follows the shell — new contents below)

**Interfaces (consumed by every screen task):**
- `api<T>(method, path, body?): Promise<T>` — same-origin fetch, bearer header from the token store, JSON both ways, throws `ApiError { status, body }`; **401 clears the token** so the router guard bounces to `/login`.
- `setToken/getToken` — localStorage (`hmis.token`) + module state. LAN SPA; XSS-hardening beyond React's defaults is accepted Phase-1 posture, noted for the security review.
- `AuthProvider` / `useAuth()` → `{ actor, ready, login(username, password), logout() }` — `login` posts `/auth/login`, stores the token, loads `/auth/me`.
- `i18n` — i18next with `en` + `hi` JSON namespaces, default `en`, persisted (`hmis.lang`); **every user-facing string in every screen goes through `t()`** (§15) — the locale files below carry the full key set for T12–T16, so later tasks add keys, never restructure.
- `KeyboardProvider` + `<ShortcutLegend/>` — global shortcuts: `/` focuses `[data-search-input]`, `F2` → registration, `Alt+M` → merge, `Alt+A` → approvals inbox, visible legend in the shell footer.
- `router` — code-based routes: `/login` (public) · layout route with auth guard (`beforeLoad` → no token ⇒ redirect `/login`) wrapping `/` (redirect → `/registration`), `/registration`, `/patients/$patientId`, `/merge`, `/approvals`. Screens for T14–T16 mount as placeholders here (`<ComingSoon/>` stubs) and are replaced file-by-file later — the router file is **final in this task** (later tasks only swap imported components, §3.1-clean).
- `renderWithProviders(ui)` (test-utils) — QueryClient + i18n + AuthProvider wrapper; screen tests stub `fetch` via `vi.stubGlobal`.

- [ ] **Step 1: Failing tests first** — `api.test.ts` (bearer header attached; 401 clears token; ApiError carries status+body) and `login.test.tsx` (validation errors from zod resolver; successful login stores token and calls `/auth/me`) — both fail at unresolved imports. Then implement.

- [ ] **Step 2: Implementation** (complete files)

`apps/web/src/lib/api.ts`:
```ts
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API ${status}`);
    this.name = "ApiError";
  }
}

const TOKEN_KEY = "hmis.token";
let token: string | null = localStorage.getItem(TOKEN_KEY);

export function getToken(): string | null {
  return token;
}
export function setToken(next: string | null): void {
  token = next;
  if (next === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, next);
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) setToken(null); // guard bounces to /login on next navigation
  const text = await res.text();
  const parsed: unknown = text === "" ? null : JSON.parse(text);
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}
```

`apps/web/src/lib/auth.tsx`:
```tsx
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api";

export type Actor = { type: "user" | "agent" | "system"; id: string };

type AuthState = {
  actor: Actor | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [actor, setActor] = useState<Actor | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (getToken() !== null) {
        try {
          const me = await api<{ actor: Actor }>("GET", "/auth/me");
          if (!cancelled) setActor(me.actor);
        } catch {
          setToken(null); // stale token — start signed out
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api<{ token: string }>("POST", "/auth/login", { username, password });
    setToken(res.token);
    const me = await api<{ actor: Actor }>("GET", "/auth/me");
    setActor(me.actor);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("POST", "/auth/logout");
    } finally {
      setToken(null);
      setActor(null);
    }
  }, []);

  return <AuthContext.Provider value={{ actor, ready, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
```

`apps/web/src/lib/i18n.ts`:
```ts
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";
import hi from "../locales/hi.json";

const LANG_KEY = "hmis.lang";

void i18next.use(initReactI18next).init({
  resources: { en: { translation: en }, hi: { translation: hi } },
  lng: localStorage.getItem(LANG_KEY) ?? "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false }, // React escapes
});

export function switchLanguage(lng: "en" | "hi"): void {
  localStorage.setItem(LANG_KEY, lng);
  void i18next.changeLanguage(lng);
}

export default i18next;
```

`apps/web/src/locales/en.json` — the full key set for T12–T16 (T13–T16 may ADD keys; never rename):
```json
{
  "hospital": { "name": "Hospital (name pending — roadmap item #5)" },
  "app": { "title": "HMIS", "logout": "Log out", "language": "हिन्दी", "loading": "Loading…" },
  "nav": { "registration": "Registration", "merge": "Merge review", "approvals": "Approvals" },
  "shortcuts": { "title": "Shortcuts", "search": "/ Search", "new": "F2 New patient", "merge": "Alt+M Merge", "approvals": "Alt+A Approvals" },
  "login": { "title": "Sign in", "username": "Username", "password": "Password", "submit": "Sign in", "failed": "Sign-in failed — check the username and password" },
  "search": { "placeholder": "Phone number, UHID, or name…", "hint": "Phone-first: type digits", "none": "No matching patients", "newPatient": "New patient (F2)" },
  "register": { "title": "New patient", "name": "Full name", "phone": "Mobile number", "altPhone": "Alternate number", "dob": "Date of birth", "age": "Age (years)", "sex": "Sex", "male": "Male", "female": "Female", "other": "Other", "unknown": "Unknown", "address": "Address", "district": "District", "state": "State", "pincode": "PIN code", "language": "Message language", "hindi": "Hindi", "english": "English", "bloodGroup": "Blood group", "confidential": "Confidential record (VIP/staff)", "alias": "Public alias", "sensitive": "Sensitive context (seals guardian messages)", "abha": "ABHA (optional)", "abhaAddress": "ABHA address", "abhaNumber": "ABHA number", "legacyUhid": "Old UHID (paper era)", "guardian": "Guardian", "guardianRequired": "A guardian is required for minors", "guardianName": "Guardian name", "guardianPhone": "Guardian phone", "relationship": "Relationship", "consentNote": "Consent note (DPDP)", "submit": "Register (Alt+S)", "registered": "Registered" },
  "photo": { "title": "Photo", "start": "Start camera", "capture": "Capture", "retake": "Retake", "fallback": "Upload photo", "unavailable": "Camera unavailable — use upload" },
  "attach": { "title": "Is this the same person?", "confirm": "Yes — open this record", "reject": "No — register new", "noPhoto": "No photo on file — verify identity by questions" },
  "card": { "print": "Print card", "uhid": "UHID", "dob": "DOB", "sex": "Sex", "reissue": "Reissue card", "reissueWarning": "Reissuing invalidates every previously printed card for this patient." },
  "patient": { "title": "Patient", "demographics": "Demographics", "save": "Save changes", "saved": "Saved", "allergies": "Allergies", "addAllergy": "Add allergy", "substance": "Substance", "reaction": "Reaction", "severity": "Severity", "mild": "Mild", "moderate": "Moderate", "severe": "Severe", "markError": "Entered in error", "reason": "Reason", "guardians": "Guardians", "addGuardian": "Add guardian", "endGuardian": "End", "authority": "Authority", "authMessages": "Messages", "authConsents": "Consents", "authDsr": "Data requests", "authBills": "Bills", "sealedBanner": "Sensitive context: guardian messages are sealed (D-31)", "majorityEnded": "Ended at majority", "confidentialBadge": "CONFIDENTIAL", "merged": "This record was merged", "abha": "ABHA" },
  "merge": { "title": "Merge review", "left": "Record A", "right": "Record B", "pickTwo": "Search and pick two records", "winner": "Keep as canonical", "note": "Why is this the same person?", "submit": "Request merge", "status": "Approval status", "execute": "Execute merge", "executed": "Merged", "unmerge": "Request unmerge", "unmergeNote": "Why must this be split?", "actFirst": "Act first (patient-safety) — review after", "unmergeExecute": "Execute unmerge", "differs": "differs" },
  "inbox": { "title": "Approvals", "empty": "Nothing pending for your roles", "approve": "Approve", "reject": "Reject", "note": "Decision note (mandatory)", "requested": "requested", "urgency": { "routine": "Routine", "urgent": "Urgent", "emergency": "Emergency" } }
}
```

`apps/web/src/locales/hi.json` — the SAME key tree with Hindi values, complete. **The key-parity test below enforces completeness mechanically** — a missing key fails the suite, so nothing silently falls back. The first namespaces are shown; write every remaining key mirroring `en.json` exactly:
```json
{
  "hospital": { "name": "अस्पताल (नाम शेष — roadmap #5)" },
  "app": { "title": "HMIS", "logout": "लॉग आउट", "language": "English", "loading": "लोड हो रहा है…" },
  "nav": { "registration": "पंजीकरण", "merge": "मर्ज समीक्षा", "approvals": "अनुमोदन" },
  "login": { "title": "साइन इन", "username": "उपयोगकर्ता नाम", "password": "पासवर्ड", "submit": "साइन इन", "failed": "साइन-इन विफल — नाम व पासवर्ड जाँचें" },
  "search": { "placeholder": "फ़ोन नंबर, UHID या नाम…", "hint": "पहले फ़ोन: अंक लिखें", "none": "कोई मिलान नहीं", "newPatient": "नया मरीज़ (F2)" }
}
```

`apps/web/src/lib/i18n.test.ts` — the parity gate:
```ts
import en from "../locales/en.json";
import hi from "../locales/hi.json";

function keyPaths(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix === "" ? k : `${prefix}.${k}`),
  );
}

it("hi.json mirrors en.json key-for-key — a missing key would silently fall back to English", () => {
  expect(keyPaths(hi).sort()).toEqual(keyPaths(en).sort());
});
```

`apps/web/src/lib/keyboard.tsx`:
```tsx
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";

function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** Global desk shortcuts (§15 keyboard-first). Mounted once in the authed layout. */
export function KeyboardProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "/" && !isTypingTarget(e.target)) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("[data-search-input]")?.focus();
      } else if (e.key === "F2") {
        e.preventDefault();
        void navigate({ to: "/registration" });
      } else if (e.altKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        void navigate({ to: "/merge" });
      } else if (e.altKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        void navigate({ to: "/approvals" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
  return <>{children}</>;
}

export function ShortcutLegend(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <footer className="no-print flex gap-4 border-t px-4 py-1 text-xs text-neutral-500">
      <span>{t("shortcuts.search")}</span>
      <span>{t("shortcuts.new")}</span>
      <span>{t("shortcuts.merge")}</span>
      <span>{t("shortcuts.approvals")}</span>
    </footer>
  );
}
```

`apps/web/src/router.tsx` — **final in this task**; T14–T16 replace only the three `ComingSoon` imports with real screens:
```tsx
import {
  Outlet, createRootRoute, createRoute, createRouter, redirect, useNavigate,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { getToken } from "./lib/api";
import { useAuth } from "./lib/auth";
import { KeyboardProvider, ShortcutLegend } from "./lib/keyboard";
import { switchLanguage } from "./lib/i18n";
import i18next from "./lib/i18n";
import { LoginScreen } from "./screens/login";

function ComingSoon({ name }: { name: string }): React.ReactElement {
  return <div className="p-8 text-neutral-500">{name} — T14–T16</div>;
}

function Shell(): React.ReactElement {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <KeyboardProvider>
      <div className="flex min-h-screen flex-col">
        <header className="no-print flex items-center gap-6 border-b px-4 py-2">
          <span className="font-semibold">{t("app.title")}</span>
          <nav className="flex gap-4 text-sm">
            <a href="/registration" className="hover:underline">{t("nav.registration")}</a>
            <a href="/merge" className="hover:underline">{t("nav.merge")}</a>
            <a href="/approvals" className="hover:underline">{t("nav.approvals")}</a>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <button type="button" onClick={() => switchLanguage(i18next.language === "hi" ? "en" : "hi")}>
              {t("app.language")}
            </button>
            <button
              type="button"
              onClick={() => {
                void logout().then(() => navigate({ to: "/login" }));
              }}
            >
              {t("app.logout")}
            </button>
          </div>
        </header>
        <div className="flex-1">
          <Outlet />
        </div>
        <ShortcutLegend />
      </div>
    </KeyboardProvider>
  );
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginScreen });

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: () => {
    if (getToken() === null) throw redirect({ to: "/login" });
  },
  component: Shell,
});

const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/registration" });
  },
});

const registrationRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/registration",
  component: () => <ComingSoon name="Registration" />, // T14 replaces
});

const patientRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/patients/$patientId",
  component: () => <ComingSoon name="Patient" />, // T15 replaces
});

const mergeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/merge",
  component: () => <ComingSoon name="Merge" />, // T16 replaces
});

const approvalsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/approvals",
  component: () => <ComingSoon name="Approvals" />, // T16 replaces
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    authedRoute.addChildren([indexRoute, registrationRoute, patientRoute, mergeRoute, approvalsRoute]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

`apps/web/src/screens/login.tsx`:
```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(8),
});
type LoginInput = z.infer<typeof loginSchema>;

export function LoginScreen(): React.ReactElement {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const { register, handleSubmit, formState } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  const onSubmit = handleSubmit(async (data) => {
    setFailed(false);
    try {
      await login(data.username, data.password);
      await navigate({ to: "/registration" });
    } catch {
      setFailed(true);
    }
  });

  return (
    <main className="flex min-h-screen items-center justify-center">
      <form onSubmit={(e) => void onSubmit(e)} className="w-80 space-y-4 rounded-lg border p-6">
        <h1 className="text-xl font-semibold">{t("login.title")}</h1>
        <div>
          <label className="block text-sm" htmlFor="username">{t("login.username")}</label>
          <input id="username" autoFocus className="w-full rounded border px-2 py-1" {...register("username")} />
          {formState.errors.username && <p role="alert" className="text-sm text-red-600">{formState.errors.username.message}</p>}
        </div>
        <div>
          <label className="block text-sm" htmlFor="password">{t("login.password")}</label>
          <input id="password" type="password" className="w-full rounded border px-2 py-1" {...register("password")} />
          {formState.errors.password && <p role="alert" className="text-sm text-red-600">{formState.errors.password.message}</p>}
        </div>
        {failed && <p role="alert" className="text-sm text-red-600">{t("login.failed")}</p>}
        <button type="submit" className="w-full rounded bg-neutral-900 py-1.5 text-white" disabled={formState.isSubmitting}>
          {t("login.submit")}
        </button>
      </form>
    </main>
  );
}
```

`apps/web/src/App.tsx` (complete new contents) and `apps/web/src/main.tsx` (unchanged except App now renders providers):
```tsx
// App.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { AuthProvider } from "./lib/auth";
import { router } from "./router";
import "./lib/i18n";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
});

export function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
```

`apps/web/src/test-utils.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { AuthProvider } from "./lib/auth";
import "./lib/i18n";

export function renderWithProviders(ui: React.ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
}

/** Minimal fetch stub: route key "METHOD path" → response body (or a function of the request). */
export function stubFetch(routes: Record<string, unknown | ((init?: RequestInit) => unknown)>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
      if (!(key in routes)) return new Response("{}", { status: 404 });
      const value = routes[key];
      const body = typeof value === "function" ? (value as (i?: RequestInit) => unknown)(init) : value;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}
```

**App.test.tsx must be updated in this task** (its Files list note): the placeholder assertion (`getByText("HMIS")`) still holds — the unauthenticated router renders `/login` → update the smoke test to assert the login heading instead:
```tsx
import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("boots to the sign-in screen when no token is stored", async () => {
  render(<App />);
  expect(await screen.findByText("Sign in")).toBeInTheDocument();
});
```
(Files list addendum: `apps/web/src/App.test.tsx` is modified here — declared, §3.1.)

- [ ] **Step 3: Tests green + verify + commit**

`api.test.ts` and `login.test.tsx` use `stubFetch`; login test asserts: invalid submit shows two `role="alert"`s; valid submit posts `/auth/login`, then `/auth/me`, and the token lands in localStorage.

Run: `pnpm --filter @hmis/web test` → PASS (api, i18n parity, login, App smoke — 4 files). Then `pnpm verify` (unpiped) → exit 0.

```bash
git add apps/web
git commit -m "feat(web): app shell — api client, auth, hi/en i18n, code-based router, keyboard kit, login"
```

---

### Task 13: shadcn/ui components + the keyboard-first form kit

**Files:**
- Create: `apps/web/components.json`
- Create (via CLI): `apps/web/src/components/ui/*` (button, card, input, label, select, dialog, badge, table, tabs, textarea, checkbox, alert), `apps/web/src/lib/utils.ts`
- Create: `apps/web/src/components/form-kit.tsx`, `apps/web/src/components/form-kit.test.tsx`
- Modify: `apps/web/package.json` + `pnpm-lock.yaml` (**the shadcn CLI adds Radix/cva/clsx/tailwind-merge/lucide-react dependencies and runs the install itself** — declared here so the diff surprises nobody, §3.1)

**shadcn is CLI-generated, not hand-transcribed** (spec §5 pins it; the registry owns the component bytes). Acceptance is therefore **behavioral, not byte-wise**: the named files exist, `pnpm verify` is green repo-wide, and the form-kit tests pass against the generated `cn()` util. Generated component bytes are registry-determined — record the CLI's output in the report; do NOT edit generated files except where lint genuinely fails (T11 already relaxed `no-empty-object-type` for `components/ui/**`; any further lint conflict is a plan defect to report, not to hand-patch).

- [ ] **Step 1: `components.json`, then the CLI**

`apps/web/components.json`:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

```bash
cd /opt/hmis/apps/web
pnpm dlx shadcn@3 add --yes button card input label select dialog badge table tabs textarea checkbox alert
```
(`--yes` skips confirmation prompts — agents cannot answer an interactive CLI.)
Expected: files under `src/components/ui/`, `src/lib/utils.ts` created; `package.json` gains the Radix + utility deps; the CLI runs `pnpm install` (lockfile updates). If the CLI errors (registry offline, version drift), STOP and report — do not hand-write substitutes.

- [ ] **Step 2: Failing form-kit test, then the kit**

`apps/web/src/components/form-kit.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { FormKit, TextField } from "./form-kit";

const schema = z.object({ a: z.string().min(1, "A is required"), b: z.string().min(1) });

function Harness({ onSubmit }: { onSubmit: (v: unknown) => void }): React.ReactElement {
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { a: "", b: "" } });
  return (
    <FormProvider {...form}>
      <FormKit onSubmit={form.handleSubmit(onSubmit)}>
        <TextField name="a" label="Field A" autoFocus />
        <TextField name="b" label="Field B" />
        <button type="submit">Go</button>
      </FormKit>
    </FormProvider>
  );
}

it("Enter advances focus to the next field instead of submitting (keyboard-first, §15)", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<Harness onSubmit={onSubmit} />);
  await user.keyboard("hello{Enter}");
  expect(screen.getByLabelText("Field B")).toHaveFocus();
  expect(onSubmit).not.toHaveBeenCalled();
});

it("shows zod errors inline with role=alert", async () => {
  const user = userEvent.setup();
  render(<Harness onSubmit={vi.fn()} />);
  await user.click(screen.getByText("Go"));
  expect(await screen.findByText("A is required")).toHaveAttribute("role", "alert");
});

it("Alt+S submits from anywhere in the form", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<Harness onSubmit={onSubmit} />);
  await user.type(screen.getByLabelText("Field A"), "x");
  await user.type(screen.getByLabelText("Field B"), "y");
  await user.keyboard("{Alt>}s{/Alt}");
  expect(onSubmit).toHaveBeenCalled();
});
```

`apps/web/src/components/form-kit.tsx`:
```tsx
import { useFormContext } from "react-hook-form";
import { cn } from "@/lib/utils";

/**
 * Keyboard-first form primitives (§15): Enter advances to the next [data-field] control
 * (desks tab through with one hand on the keyboard), Alt+S submits, errors are inline
 * role=alert. Built on react-hook-form context; screens wrap with FormProvider.
 */
export function FormKit({
  onSubmit,
  children,
  className,
}: {
  onSubmit: (e?: React.BaseSyntheticEvent) => Promise<void> | void;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLFormElement>): void => {
    if (e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      void onSubmit();
      return;
    }
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      const fields = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-field]"));
      const idx = fields.indexOf(e.target);
      const next = fields[idx + 1];
      if (next) next.focus();
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(e);
      }}
      onKeyDown={handleKeyDown}
      className={cn("space-y-3", className)}
      noValidate
    >
      {children}
    </form>
  );
}

function fieldError(errors: Record<string, unknown>, name: string): string | undefined {
  const parts = name.split(".");
  let cur: unknown = errors;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  const msg = (cur as { message?: unknown } | undefined)?.message;
  return typeof msg === "string" ? msg : undefined;
}

export function TextField({
  name,
  label,
  type = "text",
  autoFocus,
  placeholder,
  className,
}: {
  name: string;
  label: string;
  type?: string;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
}): React.ReactElement {
  const { register, formState } = useFormContext();
  const error = fieldError(formState.errors as Record<string, unknown>, name);
  return (
    <div className={className}>
      <label className="block text-sm font-medium" htmlFor={`f-${name}`}>{label}</label>
      <input
        id={`f-${name}`}
        data-field
        type={type}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className="w-full rounded border px-2 py-1"
        {...register(name)}
      />
      {error !== undefined && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

export function SelectField({
  name,
  label,
  options,
  className,
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  className?: string;
}): React.ReactElement {
  const { register, formState } = useFormContext();
  const error = fieldError(formState.errors as Record<string, unknown>, name);
  return (
    <div className={className}>
      <label className="block text-sm font-medium" htmlFor={`f-${name}`}>{label}</label>
      <select id={`f-${name}`} data-field className="w-full rounded border px-2 py-1" {...register(name)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {error !== undefined && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

export function CheckboxField({
  name,
  label,
  className,
}: {
  name: string;
  label: string;
  className?: string;
}): React.ReactElement {
  const { register } = useFormContext();
  return (
    <label className={cn("flex items-center gap-2 text-sm", className)}>
      <input type="checkbox" data-field {...register(name)} />
      {label}
    </label>
  );
}
```

- [ ] **Step 3: Tests green + verify + commit**

Run: `pnpm --filter @hmis/web test` → PASS (7 tests). Then `pnpm verify` (unpiped) → exit 0.

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): shadcn/ui components via CLI + keyboard-first form kit (Enter-advance, Alt+S, inline errors)"
```

---

### Task 14: Registration desk — search-first, C-18 attach confirmation, photo capture, printed QR card

**Files:**
- Create: `apps/web/src/screens/registration-desk.tsx`, `apps/web/src/components/photo-capture.tsx`, `apps/web/src/components/qr-card.tsx`
- Create (tests): `apps/web/src/screens/registration-desk.test.tsx`, `apps/web/src/components/qr-card.test.tsx`, `apps/web/src/components/photo-capture.test.tsx`
- Modify: `apps/web/src/router.tsx` (ONE import swap: `registrationRoute`'s component becomes `RegistrationDesk`), `apps/web/src/styles.css` (append the print-isolation block below)

**Interfaces / flow (the §11.1 UHID desk, SLA < 3 min by design):**
- **Search-first**: the desk NEVER opens a blank form. The search input (`data-search-input`, autofocused) drives `GET /patients/search?q=` (debounced 250 ms, ≥2 chars); digit input hints phone-first (§11.1). Each result row shows the stored photo thumbnail (fetched as base64 JSON → data URL — `<img>` cannot carry a bearer token).
- **C-18 attach confirmation**: choosing a result opens a dialog with the photo LARGE plus demographics side-by-side and two buttons — *"Yes — open this record"* (navigate to the patient) and *"No — register new"* (prefills the form with the searched phone). A missing photo shows the verify-by-questions hint instead. This dialog IS C-18's photo-prompt; the demographic-mismatch **sampling report** is Plan 12 Fraud Sentinel scope, and its raw material (`patient.updated` diffs) ships in T3.
- **New-patient form**: form-kit fields mirroring T9's `registerBody` (client zod schema below — same rules, so server 400s are rare, not load-bearing); watched `dob`/`ageYears` compute minority and reveal a REQUIRED guardian section (D-31/DPDP §9, mirrored client-side); photo capture inline; submit → `POST /patients` → optional `PUT photo` → card view.
- **Card view**: `GET /patients/:id/qr` → printable card (`QrCard`) + print button → back to search. Every printed doc carries its signed QR (§15).
- `PhotoCapture` — `getUserMedia` path (portrait 480×640 canvas downscale → JPEG, quality-stepped 0.8/0.6/0.4 until ≤ 500 kB) **plus a file-input fallback** (`accept="image/*" capture="user"`) shown whenever the camera is unavailable or denied — jsdom tests exercise the fallback (no camera in jsdom, which is exactly the point).
- `QrCard` — credit-card layout (85.6×54 mm print CSS), `qrcode.react` SVG of the signed payload, hospital name via `t("hospital.name")` (name pending — roadmap item #5), UHID large, name/sex/DOB line.

- [ ] **Step 1: Failing tests first** (three files; all fail at unresolved imports):
  - `registration-desk.test.tsx`: (a) typing `98765` fires the search call and renders the stubbed result row; (b) clicking the row opens the attach dialog showing the photo img (stubbed base64) and both buttons; (c) "No — register new" switches to the form with phone prefilled; (d) in the form, `ageYears: 10` reveals the guardian section and blocks submit without it (zod error `register.guardianRequired`); (e) a valid submit posts `/patients` and shows the card view (stubbed `/qr` response rendered).
  - `qr-card.test.tsx`: renders the UHID text and an `svg` element; the print button calls a `window.print` spy.
  - `photo-capture.test.tsx`: with `navigator.mediaDevices` undefined (jsdom), the fallback file input renders; selecting a file (stubbed `createImageBitmap` + canvas `toBlob`) calls `onCapture` with a Blob.

- [ ] **Step 2: Implementation** — complete files.

`apps/web/src/components/photo-capture.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

const TARGET_W = 480;
const TARGET_H = 640;
const MAX_BYTES = 500_000;

async function canvasToCappedJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  for (const quality of [0.8, 0.6, 0.4]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob !== null && blob.size <= MAX_BYTES) return blob;
  }
  return null;
}

async function fileToCappedJpeg(file: File): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, TARGET_H / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvasToCappedJpeg(canvas);
}

export function PhotoCapture({ onCapture }: { onCapture: (blob: Blob | null) => void }): React.ReactElement {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [mode, setMode] = useState<"idle" | "streaming" | "captured" | "unavailable">("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const cameraPossible = typeof navigator !== "undefined" && navigator.mediaDevices !== undefined;

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (previewUrl !== null) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const start = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: TARGET_W, height: TARGET_H },
      });
      streamRef.current = stream;
      videoRef.current!.srcObject = stream;
      await videoRef.current!.play();
      setMode("streaming");
    } catch {
      setMode("unavailable"); // permission denied / no camera — the fallback input below stays usable
    }
  };

  const capture = async (): Promise<void> => {
    const video = videoRef.current!;
    const canvas = document.createElement("canvas");
    canvas.width = TARGET_W;
    canvas.height = TARGET_H;
    canvas.getContext("2d")!.drawImage(video, 0, 0, TARGET_W, TARGET_H);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    const blob = await canvasToCappedJpeg(canvas);
    finish(blob);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    finish(await fileToCappedJpeg(file));
  };

  const finish = (blob: Blob | null): void => {
    if (blob === null) return;
    setPreviewUrl(URL.createObjectURL(blob));
    setMode("captured");
    onCapture(blob);
  };

  const retake = (): void => {
    setPreviewUrl(null);
    setMode("idle");
    onCapture(null);
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t("photo.title")}</p>
      {mode === "streaming" && (
        <video ref={videoRef} className="h-48 w-36 rounded border object-cover" muted playsInline />
      )}
      {mode === "captured" && previewUrl !== null && (
        <img src={previewUrl} alt="" className="h-48 w-36 rounded border object-cover" />
      )}
      {mode === "unavailable" && <p className="text-sm text-amber-700">{t("photo.unavailable")}</p>}
      <div className="flex gap-2">
        {cameraPossible && mode === "idle" && (
          <Button type="button" variant="outline" onClick={() => void start()}>{t("photo.start")}</Button>
        )}
        {mode === "streaming" && (
          <Button type="button" onClick={() => void capture()}>{t("photo.capture")}</Button>
        )}
        {mode === "captured" && (
          <Button type="button" variant="outline" onClick={retake}>{t("photo.retake")}</Button>
        )}
        {mode !== "streaming" && mode !== "captured" && (
          <label className="cursor-pointer rounded border px-3 py-1.5 text-sm">
            {t("photo.fallback")}
            <input type="file" accept="image/*" capture="user" className="hidden" onChange={(e) => void onFile(e)} />
          </label>
        )}
      </div>
    </div>
  );
}
```

`apps/web/src/components/qr-card.tsx`:
```tsx
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export type QrCardData = { payload: string; uhid: string; name: string; sex: string; dob: string | null };

/** The printed patient card (§15: print is a first-class surface; every printed doc carries its signed QR). */
export function QrCard({ data }: { data: QrCardData }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="qr-card w-[340px] rounded-lg border p-4">
        <p className="text-xs text-neutral-500">{t("hospital.name")}</p>
        <div className="flex items-center gap-4 pt-2">
          <QRCodeSVG value={data.payload} size={112} />
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold">{data.name}</p>
            <p className="font-mono text-base">{data.uhid}</p>
            <p className="text-sm text-neutral-600">
              {t("card.sex")}: {data.sex}
              {data.dob !== null ? ` · ${t("card.dob")}: ${data.dob.slice(0, 10)}` : ""}
            </p>
          </div>
        </div>
      </div>
      <Button type="button" className="no-print" onClick={() => window.print()}>
        {t("card.print")}
      </Button>
    </div>
  );
}
```

Append to `apps/web/src/styles.css` (print isolation — only the card prints):
```css
@media print {
  body * { visibility: hidden; }
  .qr-card, .qr-card * { visibility: visible; }
  .qr-card { position: fixed; left: 0; top: 0; width: 85.6mm; border: none; }
}
```

`apps/web/src/screens/registration-desk.tsx`:
```tsx
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useForm, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { FormKit, TextField, SelectField, CheckboxField } from "../components/form-kit";
import { PhotoCapture } from "../components/photo-capture";
import { QrCard, type QrCardData } from "../components/qr-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type SearchHit = {
  id: string; uhid: string; name: string; phone: string | null; sex: string;
  dob: string | null; isConfidential: boolean; hasPhoto: boolean;
};

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function PatientPhoto({ patientId, className }: { patientId: string; className: string }): React.ReactElement {
  const photo = useQuery({
    queryKey: ["patient-photo", patientId],
    queryFn: () => api<{ mimeType: string; imageBase64: string }>("GET", `/patients/${patientId}/photo`),
    retry: false,
  });
  if (!photo.data) return <div className={`${className} bg-neutral-100`} />;
  return <img alt="" className={`${className} object-cover`} src={`data:${photo.data.mimeType};base64,${photo.data.imageBase64}`} />;
}

// ——— C-18: the attach confirmation — photo LARGE, demographics beside, explicit yes/no ———
function AttachDialog({
  hit, onClose, onReject,
}: { hit: SearchHit; onClose: () => void; onReject: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("attach.title")}</DialogTitle></DialogHeader>
        <div className="flex gap-4">
          {hit.hasPhoto ? (
            <PatientPhoto patientId={hit.id} className="h-56 w-44 rounded border" />
          ) : (
            <p className="w-44 self-center text-sm text-amber-700">{t("attach.noPhoto")}</p>
          )}
          <dl className="space-y-1 text-sm">
            <div><dt className="inline font-medium">{t("card.uhid")}: </dt><dd className="inline font-mono">{hit.uhid}</dd></div>
            <div><dt className="inline font-medium">{t("register.name")}: </dt><dd className="inline">{hit.name}</dd></div>
            <div><dt className="inline font-medium">{t("register.phone")}: </dt><dd className="inline">{hit.phone ?? "—"}</dd></div>
            <div><dt className="inline font-medium">{t("card.sex")}: </dt><dd className="inline">{hit.sex}</dd></div>
            <div><dt className="inline font-medium">{t("card.dob")}: </dt><dd className="inline">{hit.dob?.slice(0, 10) ?? "—"}</dd></div>
          </dl>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onReject}>{t("attach.reject")}</Button>
          <Button onClick={() => void navigate({ to: "/patients/$patientId", params: { patientId: hit.id } })}>
            {t("attach.confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Client mirror of T9's registerBody semantics (server stays authoritative).
const phonePattern = /^[6-9]\d{9}$/;
const registerSchema = z
  .object({
    name: z.string().min(1),
    phone: z.string().regex(phonePattern).optional().or(z.literal("")),
    dob: z.string().optional().or(z.literal("")),
    // NOT z.coerce: coerce("") === 0, which would make every blank form a zero-year-old minor.
    ageYears: z.preprocess(
      (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
      z.number().int().min(0).max(130).optional(),
    ),
    sex: z.enum(["male", "female", "other", "unknown"]),
    addressLine: z.string().optional(),
    district: z.string().optional(),
    pincode: z.string().regex(/^\d{6}$/).optional().or(z.literal("")),
    language: z.enum(["hi", "en"]),
    isConfidential: z.boolean(),
    alias: z.string().optional(),
    sensitiveContext: z.boolean(),
    abhaAddress: z.string().optional(),
    abhaNumber: z.string().optional(),
    legacyUhid: z.string().optional(),
    guardianName: z.string().optional(),
    guardianPhone: z.string().regex(phonePattern).optional().or(z.literal("")),
    guardianRelationship: z.enum(["father", "mother", "spouse", "sibling", "legal_guardian", "other"]),
    guardianConsentNote: z.string().optional(),
  })
  .refine((v) => !(v.dob !== undefined && v.dob !== "" && v.ageYears !== undefined), {
    message: "dob or age, not both", path: ["ageYears"],
  })
  .refine((v) => !v.isConfidential || (v.alias ?? "").trim() !== "", {
    message: "alias required", path: ["alias"],
  });
type RegisterFormValues = z.infer<typeof registerSchema>;

function isMinorInput(v: { dob?: string; ageYears?: number }): boolean {
  if (typeof v.ageYears === "number") return v.ageYears < 18;
  if (v.dob !== undefined && v.dob !== "") {
    const dob = new Date(v.dob);
    return Date.now() - dob.getTime() < 18 * 365.25 * 24 * 3600 * 1000; // UI hint only; the server rule is authoritative
  }
  return false;
}

function NewPatientForm({
  prefillPhone, onRegistered,
}: { prefillPhone: string; onRegistered: (patientId: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      name: "", phone: prefillPhone, sex: "unknown", language: "hi",
      isConfidential: false, sensitiveContext: false, guardianRelationship: "father",
    },
  });
  const watched = form.watch(["dob", "ageYears"]);
  const minor = isMinorInput({ dob: watched[0], ageYears: watched[1] });

  const submit = form.handleSubmit(async (v) => {
    setServerError(null);
    if (minor && (v.guardianName ?? "").trim() === "") {
      form.setError("guardianName", { message: t("register.guardianRequired") });
      return;
    }
    const body: Record<string, unknown> = {
      name: v.name,
      sex: v.sex,
      language: v.language,
      ...(v.phone !== undefined && v.phone !== "" ? { phone: v.phone } : {}),
      ...(v.dob !== undefined && v.dob !== "" ? { dob: v.dob } : {}),
      ...(typeof v.ageYears === "number" ? { ageYears: v.ageYears } : {}),
      ...(v.addressLine !== undefined && v.addressLine !== "" ? { addressLine: v.addressLine } : {}),
      ...(v.district !== undefined && v.district !== "" ? { district: v.district } : {}),
      ...(v.pincode !== undefined && v.pincode !== "" ? { pincode: v.pincode } : {}),
      ...(v.isConfidential ? { isConfidential: true, alias: v.alias } : {}),
      ...(v.sensitiveContext ? { sensitiveContext: true } : {}),
      ...(v.abhaAddress !== undefined && v.abhaAddress !== "" ? { abhaAddress: v.abhaAddress } : {}),
      ...(v.abhaNumber !== undefined && v.abhaNumber !== "" ? { abhaNumber: v.abhaNumber } : {}),
      ...(v.legacyUhid !== undefined && v.legacyUhid !== "" ? { legacyUhid: v.legacyUhid } : {}),
      ...((v.guardianName ?? "").trim() !== ""
        ? {
            guardian: {
              name: v.guardianName,
              relationship: v.guardianRelationship,
              ...(v.guardianPhone !== undefined && v.guardianPhone !== "" ? { phone: v.guardianPhone } : {}),
              ...(v.guardianConsentNote !== undefined && v.guardianConsentNote !== "" ? { consentNote: v.guardianConsentNote } : {}),
            },
          }
        : {}),
    };
    try {
      const res = await api<{ patient: { id: string } }>("POST", "/patients", body);
      if (photoBlob !== null) {
        const buf = new Uint8Array(await photoBlob.arrayBuffer());
        let binary = "";
        for (const b of buf) binary += String.fromCharCode(b);
        await api("PUT", `/patients/${res.patient.id}/photo`, { imageBase64: btoa(binary) });
      }
      onRegistered(res.patient.id);
    } catch (e) {
      setServerError(String(e));
    }
  });

  return (
    <FormProvider {...form}>
      <FormKit onSubmit={submit} className="max-w-2xl">
        <h2 className="text-lg font-semibold">{t("register.title")}</h2>
        <div className="grid grid-cols-2 gap-3">
          <TextField name="name" label={t("register.name")} autoFocus />
          <TextField name="phone" label={t("register.phone")} />
          <TextField name="dob" label={t("register.dob")} type="date" />
          <TextField name="ageYears" label={t("register.age")} type="number" />
          <SelectField
            name="sex"
            label={t("register.sex")}
            options={[
              { value: "unknown", label: t("register.unknown") },
              { value: "female", label: t("register.female") },
              { value: "male", label: t("register.male") },
              { value: "other", label: t("register.other") },
            ]}
          />
          <SelectField
            name="language"
            label={t("register.language")}
            options={[
              { value: "hi", label: t("register.hindi") },
              { value: "en", label: t("register.english") },
            ]}
          />
          <TextField name="addressLine" label={t("register.address")} className="col-span-2" />
          <TextField name="district" label={t("register.district")} />
          <TextField name="pincode" label={t("register.pincode")} />
          <TextField name="abhaAddress" label={t("register.abhaAddress")} />
          <TextField name="abhaNumber" label={t("register.abhaNumber")} />
          <TextField name="legacyUhid" label={t("register.legacyUhid")} />
        </div>
        <div className="flex gap-6">
          <CheckboxField name="isConfidential" label={t("register.confidential")} />
          <CheckboxField name="sensitiveContext" label={t("register.sensitive")} />
        </div>
        {form.watch("isConfidential") && <TextField name="alias" label={t("register.alias")} />}
        {minor && (
          <fieldset className="space-y-3 rounded border p-3">
            <legend className="px-1 text-sm font-medium">
              {t("register.guardian")} — {t("register.guardianRequired")}
            </legend>
            <div className="grid grid-cols-2 gap-3">
              <TextField name="guardianName" label={t("register.guardianName")} />
              <TextField name="guardianPhone" label={t("register.guardianPhone")} />
              <SelectField
                name="guardianRelationship"
                label={t("register.relationship")}
                options={[
                  { value: "father", label: "father" }, { value: "mother", label: "mother" },
                  { value: "legal_guardian", label: "legal_guardian" }, { value: "other", label: "other" },
                ]}
              />
              <TextField name="guardianConsentNote" label={t("register.consentNote")} />
            </div>
          </fieldset>
        )}
        <PhotoCapture onCapture={setPhotoBlob} />
        {serverError !== null && <p role="alert" className="text-sm text-red-600">{serverError}</p>}
        <Button type="submit" disabled={form.formState.isSubmitting}>{t("register.submit")}</Button>
      </FormKit>
    </FormProvider>
  );
}

export function RegistrationDesk(): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 250);
  const [attach, setAttach] = useState<SearchHit | null>(null);
  const [view, setView] = useState<{ kind: "search" } | { kind: "new"; prefillPhone: string } | { kind: "card"; patientId: string }>({ kind: "search" });

  const search = useQuery({
    queryKey: ["patient-search", debounced],
    queryFn: () => api<{ items: SearchHit[] }>("GET", `/patients/search?q=${encodeURIComponent(debounced)}`),
    enabled: view.kind === "search" && debounced.trim().length >= 2,
  });

  const card = useQuery({
    queryKey: ["qr-card", view.kind === "card" ? view.patientId : ""],
    queryFn: () => api<QrCardData>("GET", `/patients/${view.kind === "card" ? view.patientId : ""}/qr`),
    enabled: view.kind === "card",
  });

  if (view.kind === "card") {
    return (
      <div className="p-6">
        {card.data ? <QrCard data={card.data} /> : <p>{t("app.loading")}</p>}
        <Button variant="outline" className="no-print mt-4" onClick={() => { setView({ kind: "search" }); setQ(""); }}>
          {t("register.registered")} ✓
        </Button>
      </div>
    );
  }

  if (view.kind === "new") {
    return (
      <div className="p-6">
        <NewPatientForm prefillPhone={view.prefillPhone} onRegistered={(patientId) => setView({ kind: "card", patientId })} />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div className="max-w-xl">
        <input
          data-search-input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("search.placeholder")}
          className="w-full rounded border px-3 py-2 text-lg"
        />
        <p className="pt-1 text-xs text-neutral-500">{t("search.hint")}</p>
      </div>
      <div className="max-w-xl space-y-2">
        {search.data?.items.map((hit) => (
          <button
            key={hit.id}
            type="button"
            onClick={() => setAttach(hit)}
            className="flex w-full items-center gap-3 rounded border p-2 text-left hover:bg-neutral-50"
          >
            {hit.hasPhoto ? <PatientPhoto patientId={hit.id} className="h-12 w-10 rounded" /> : <div className="h-12 w-10 rounded bg-neutral-100" />}
            <span className="min-w-0">
              <span className="block truncate font-medium">{hit.name}</span>
              <span className="block font-mono text-xs text-neutral-600">{hit.uhid} · {hit.phone ?? "—"}</span>
            </span>
          </button>
        ))}
        {search.data !== undefined && search.data.items.length === 0 && (
          <p className="text-sm text-neutral-500">{t("search.none")}</p>
        )}
      </div>
      <Button onClick={() => setView({ kind: "new", prefillPhone: /^\d+$/.test(q.trim()) ? q.trim() : "" })}>
        {t("search.newPatient")}
      </Button>
      {attach !== null && (
        <AttachDialog
          hit={attach}
          onClose={() => setAttach(null)}
          onReject={() => {
            setView({ kind: "new", prefillPhone: attach.phone ?? (/^\d+$/.test(q.trim()) ? q.trim() : "") });
            setAttach(null);
          }}
        />
      )}
    </div>
  );
}
```

Router swap in `apps/web/src/router.tsx`: import `RegistrationDesk` from `./screens/registration-desk`, and change `registrationRoute`'s `component` to `RegistrationDesk`. Nothing else in the file changes.

- [ ] **Step 3: Tests green + verify + commit**

Run: `pnpm --filter @hmis/web test` → PASS. Then `pnpm verify` (unpiped) → exit 0.

```bash
git add apps/web
git commit -m "feat(web): registration desk — search-first flow, C-18 attach confirmation, photo capture, printed QR card"
```

---

### Task 15: Patient detail — demographics, allergies, guardians, ABHA, reissue

**Files:**
- Create: `apps/web/src/screens/patient-detail.tsx`, `apps/web/src/screens/patient-detail.test.tsx`
- Modify: `apps/web/src/router.tsx` (ONE import swap: `patientRoute`'s component becomes `PatientDetail`)

**Interfaces / behavior:**
- Loads `GET /patients/:id` (`{ patient, resolvedFrom }`), `GET /patients/:id/allergies`, `GET /patients/:id/guardians` (rows paired with server-computed `effectiveAuthority`).
- Header: name (+ `CONFIDENTIAL` badge and alias when flagged), UHID monospace, photo, a *merged-record* banner when `resolvedFrom` is set (the URL id redirected — show the canonical).
- **Demographics form sends ONLY dirty fields** (react-hook-form `formState.dirtyFields` → `PATCH /patients/:id`) — the server diffs again and refuses no-ops, so the audit trail stays clean.
- Allergies: list newest-first, `entered_in_error` rows struck through with the reason (E-8 — never hidden); add dialog (substance/reaction/severity, `source: "consult"` is Plan 07's — the desk uses `"registration"`); *entered-in-error* action prompts for the mandatory reason.
- Guardians: rows show status + the four effective-authority badges (from the server); a red `sealedBanner` when `patient.sensitiveContext` (D-31: messages sealed); add-guardian dialog (T13 form kit, same fields as registration's block); authority editor (four checkboxes + `validTo` date) → `PATCH .../guardians/:guardianId`; end button; `majority_ended` rows labeled.
- ABHA panel: `abhaAddress` / `abhaNumber` / `abhaVerificationStatus` select — plain `patient.updated`-audited fields (D-30); the link token is read-only display (real ABDM flow is a later plan).
- Card actions: reprint (`GET /patients/:id/qr` → `QrCard`), reissue behind a confirm dialog carrying `card.reissueWarning` (D-23: every previously printed card dies).
- Confidential toggle renders for everyone but the server enforces (`403` → inline error) — the UI holds no permission model in v1, deliberate and noted.

- [ ] **Step 1: failing tests first** (`patient-detail.test.tsx`, stubbed fetch): (a) renders name, UHID, allergy list with a struck-through corrected row, guardian badges from `effectiveAuthority`; (b) sealed banner appears when `sensitiveContext: true`; (c) editing ONE field and saving PATCHes exactly that field (assert the stubbed call body has one key); (d) entered-in-error posts the typed reason; (e) merged banner shown when `resolvedFrom` set. Fails at unresolved import.

- [ ] **Step 2: implement `patient-detail.tsx`** — one screen file, sections as inner components (`DemographicsSection`, `AllergiesSection`, `GuardiansSection`, `CardSection`), using T12's `api`/i18n, T13's form kit + `Dialog`/`Button`/`Badge`/`Table`, T14's `PatientPhoto` + `QrCard`. The dirty-fields PATCH:

```tsx
const onSave = form.handleSubmit(async (values) => {
  const dirty = form.formState.dirtyFields as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(dirty)) {
    const v = (values as Record<string, unknown>)[key];
    patch[key] = v === "" ? null : v; // cleared inputs null the column (server treats null as a clear)
  }
  if (Object.keys(patch).length === 0) return;
  await api("PATCH", `/patients/${patientId}`, patch);
  await queryClient.invalidateQueries({ queryKey: ["patient", patientId] });
  form.reset(values);
});
```
The rest of the file follows T14's established idioms exactly (queries with `["patient", id]`-style keys, dialogs with mandatory-note inputs, `role="alert"` errors). Every label through `t()` — the keys already exist in T12's locale files.

- [ ] **Step 3: router swap + tests green + verify + commit**

Run: `pnpm --filter @hmis/web test` → PASS. Then `pnpm verify` (unpiped) → exit 0.

```bash
git add apps/web
git commit -m "feat(web): patient detail — dirty-field edits, allergies with correction trail, guardian authority, ABHA, card reissue"
```

---

### Task 16: Merge review + approvals inbox + web docs (pipeline C capstone)

**Files:**
- Create: `apps/web/src/screens/merge-review.tsx`, `apps/web/src/screens/approvals-inbox.tsx`
- Create (tests): `apps/web/src/screens/merge-review.test.tsx`, `apps/web/src/screens/approvals-inbox.test.tsx`
- Modify: `apps/web/src/router.tsx` (TWO import swaps: `mergeRoute` → `MergeReview`, `approvalsRoute` → `ApprovalsInbox`), `README.md` (web section below)

**Merge review (§11.5 side-by-side):**
- Two patient pickers (search inputs reusing the T14 search query shape, one result selectable each side).
- Comparison table: one row per field (name, phone, dob, sex, address, ABHA, allergy count), values side by side, differing rows highlighted amber with `t("merge.differs")` — the reviewer sees exactly what disagrees before requesting.
- Winner radio (which record survives), mandatory note, submit → `POST /patients/merge-requests` → the screen becomes the request tracker: `GET /patients/merge-requests/:id` polled (`refetchInterval: 5000`) showing `approvalStatus`; **Execute** enabled only when `granted` (a click while pending renders the 409 message inline — the server is the gate, the button is convenience).
- After execution: unmerge block — note + `actFirst` checkbox (labeled `t("merge.actFirst")`), *request unmerge* → *execute unmerge* (enabled when `unmergeApprovalStatus` is `granted` OR the request was act-first — mirroring T8's rule; the server remains authoritative).

**Approvals inbox (§8: approvers act in-app — Plan 04 shipped the API, this is its first surface, serving ALL current and future types, not just merges):**
- `GET /approvals` (default pending, the caller's roles scope it server-side) → table: urgency badge (emergency red / urgent amber / routine neutral), `typeKey`, subject, requester note, age in minutes.
- Row actions approve/reject → dialog with the MANDATORY note (`t("inbox.note")`; empty blocked client-side, enforced server-side); a 403 (SoD requester≠approver) renders its message inline — the clerk who requested cannot decide, and sees why.
- Empty state `t("inbox.empty")`.

- [ ] **Step 1: failing tests first**: merge-review — (a) picking two hits renders the comparison with the differing phone row highlighted; (b) submit posts winner/loser/note; (c) tracker shows `approvalStatus` from the stub and disables Execute while `pending`; approvals-inbox — (d) renders stubbed pending rows with urgency badges; (e) approve dialog blocks empty note, posts note on confirm; (f) stubbed 403 body renders inline. Both fail at unresolved imports.

- [ ] **Step 2: implement both screens** following T14/T15 idioms verbatim (`useQuery` + `api`, form kit, shadcn `Table`/`Dialog`/`Badge`/`Button`, all strings through `t()` — keys exist since T12). Poll query:

```tsx
const tracker = useQuery({
  queryKey: ["merge-request", requestId],
  queryFn: () => api<{ request: MergeRequestView; approvalStatus: string | null; unmergeApprovalStatus: string | null }>(
    "GET", `/patients/merge-requests/${requestId}`),
  enabled: requestId !== null,
  refetchInterval: 5_000,
});
```

- [ ] **Step 3: README — append this section**

```markdown
## Web app (Plan 05)

`apps/web` — React 19 + Vite 7 SPA (Tailwind 4, shadcn/ui, TanStack Router/Query, RHF+zod,
i18next hi/en, Vitest). Rides root `pnpm verify` (typecheck via `pnpm -r exec tsc --noEmit`,
tests via `pnpm -r test`, lint via root `eslint .`) — CI needed NO change. Dev:
`pnpm --filter @hmis/web dev` (proxies /auth,/patients,/approvals,/workflow to :3000).
Build: `pnpm --filter @hmis/web build` → `apps/web/dist` (served by Caddy in Plan 11).
Screens: registration desk (search-first, C-18 photo confirm, printed QR card), patient
detail, merge review (approval-gated), approvals inbox (generic — serves every engine type).
Keyboard: `/` search · F2 new patient · Alt+M merge · Alt+A approvals · Enter advances ·
Alt+S submits. UI language ≠ patient message language (the latter is a patient field).
```

- [ ] **Step 4: Full verify + commit**

Run: `pnpm --filter @hmis/web test` → PASS (all web suites). Then `pnpm verify` (unpiped) → exit 0 — the plan-complete state: **three workspaces, one green command**.

```bash
git add apps/web README.md
git commit -m "feat(web): merge review side-by-side + approvals inbox; web docs — pipeline C complete"
```

---

## Self-Review Notes

- **Spec coverage (this plan's slice):** §6 patient master ✓ (one `patients` table owned by the registration module; every consumer gets `patient_id` via `getPatient`/`resolvePatientId` — merge freezes the loser and resolution follows the chain, so demographics are never copied; allergy list on the master with prescribing-warning data ready for Plan 07; per-patient `language` for Plan 10) · §6 ABHA nullable from day one ✓ (D-30 field set: address + number + verification status + link token; edits ride `patient.updated`; `abha.linked` deliberately NOT minted — it belongs to the real ABDM flow) · §11.1 entry lanes ✓ (search-first desk, phone-first dispatch, photo, printed QR card; the <3 min SLA is a design target the flow serves, not a testable claim) · §11.5 merge/unmerge ✓ (side-by-side comparison T16, approval gate through Plan 04 T8, splittable via snapshot-recorded moves; wrong-merge-as-emergency honored by the act-first unmerge type) · §14 confidential/VIP ✓ (flag + alias required, existence-hiding behind `patients.confidential.read`, alias on scan responses) · **D-37 ✓ — the flag appears in no ORDER BY, no queue, no prioritization anywhere in this plan** (roadmap trap; search orders by name only) · D-31 guardianship ✓ (relationship, masked verified identity, four-scope authority, validity dates, DOB-driven majority — read-time enforced + fourth sweep by owner decision Q4; sensitive-context override seals exactly the message channel; DPDP §9 consent note at minor registration, minor-needs-guardian enforced) · C-18/S10-18 ✓ (photo-prompt = T14's attach dialog with the stored photo large; demographic-mismatch sampling's RAW MATERIAL ships as `patient.updated` field diffs — the sampling report itself is Plan 12 Fraud Sentinel scope, stated) · D-23 signed QR ✓ (HMAC under existing `SECRET_KEY`, per-patient version, reissue rotates, photographed/edited cards fail, `qr.signature_failed` on every failure; merged-loser cards resolve to the winner) · §15 ✓ (search <300 ms and interactive <100 ms CI-enforced by T4 per owner decision Q7; keyboard-first kit + global shortcuts; hi/en i18n with switcher; print as a first-class surface with print-isolation CSS) · D-43 ✓ (`legacy_uhid` cross-reference field) · E-8 ✓ (allergies correct via `entered_in_error` + `correction.entered_in_error`; no delete path in the module) · E-15 ✓ (unmerge type urgent + `actFirstAllowed`, exercised end-to-end in T10 leg 6). **Deliberately out of scope, stated:** encounters (Plan 07) · ABDM linking flows (later plan) · **per-access break-glass eventing** (Plan 02 gate report open item 7 pointed at "record surfaces in Plan 05" — no catalog name exists for record access and the sealed clinical surfaces arrive with Plan 07+; the standing grant's `break_glass.used` remains the audit record; carried forward explicitly for the EMR plan) · guardian-aware message routing (Plan 10 consumes `effectiveGuardianAuthority` + events) · public-display alias enforcement (Plan 07 — displays announce tokens only anyway) · fuzzy/pg_trgm name search (MRD phase; prefix-only is a stated Phase-1 scope decision).
- **Catalog discipline:** exactly NINE names minted — `patient.registered`, `patient.updated`, `patient.merged`, `patient.unmerged`, `guardian.linked`, `guardian.authority_changed`, `allergy.recorded`, `correction.entered_in_error`, `qr.signature_failed` — all present in §10.6's reconciled catalog (P1 + pass-7 + pass-8 lists), `module: "patients"`, envelope via `defineEvent(...).make(...)` + `appendEvent`, `patientId` on every patient-scoped emission. Photo and QR-version changes reuse `patient.updated`'s `changes` grammar (no new names). `patient.merged`/`.unmerged` carry `correlationId` = the backing approval's workflow instance id. The sweep events as `actor: { type: "system", id: "guardian-majority-sweep" }`. Nothing else emits.
- **Type consistency:** `PatientError` defined ONCE (`uhid.ts`, T2 — the module's lowest layer), re-exported by `types.ts`, mapped once in T9's `toHttp`; its code union in T2 carries every code T3–T8 throw (audited: all 22 codes appear in exactly the tasks named) · event payload schemas (T3) are the single source for payload shape — tests assert against them via the parsed `payload` · `PatientRow`/`GuardianRow`/`AllergyRow`/`MergeRequestRow` are `$inferSelect` types · T9's zod bodies mirror T3/T6/T8 service types field-for-field; T14's client schema mirrors T9's `registerBody` (server authoritative) · consumed kernel signatures transcribed from SHIPPED source scouted this session, not from memory: `appendEvent(tx, def.make({ actor, payload, patientId?, correlationId? }))` · `newId()` · `hasPermission(db, userId, permission, "hospital")` · `assertNotSodPair` untouched (SoD lives inside Plan 04's decide path) · `requestApproval(tx, requester, { typeKey, subject, patientId?, requestNote?, actFirst? })` · `getApproval(db, id)` → row with `instanceId`/`status`/`actedFirst` · `approvalFlowDefinition(spec)` · `registerApprovalType(db, actor, spec)` · `createDraft(db, actor, defJson)` / `activateDefinition(db, actor, definitionId)` · `hmacSign/hmacVerify(key: Buffer, …)` · `loadConfig().secretKey: Buffer` · `setupTestDb`/`truncateAll` frozen, ONE appended statement.
- **Placeholders:** none — every step carries runnable code, exact commands with expected output, or (T15 Step 2, T16 Step 2) a complete specification plus the exact load-bearing code block, with every idiom pinned by an earlier task's full file. The one coder-authored content block — `hi.json`'s complete Hindi tree — is **mechanically enforced by T12's key-parity test**, so an incomplete translation fails the suite rather than silently falling back.
- **VERIFY-BY-EXECUTION FLAGS (prove by running — each names its owning task and discharging assertion):**
  ① **drizzle-kit emits `text_pattern_ops` + the `lower(name)` expression index** — T1 Step 4 inspects the generated SQL (STOP and report if the opclass is dropped — never hand-edit); T4's two EXPLAIN tests prove the indexes are actually USED (`nodeTypes(plan)` contains no `"Seq Scan"`, and `.length > 0` guards against a silently-empty walk).
  ② **bytea `customType` round-trips a Buffer** — T1 "round-trips photo bytes" (`Buffer.isBuffer` + `Buffer.compare === 0`).
  ③ **`pgSequence` emission + `nextval` arrives as TEXT** — T1 sequence test (`Number(second) === Number(first) + 1`, 20 concurrent uniques); T2's `allocateUhid` pins `Number.isSafeInteger`.
  ④ **Verhoeff table transcription** — T2's property tests: 500 append-validate rounds, EVERY single-digit substitution rejected, EVERY adjacent transposition rejected, canonical `236 → 3`. Any wrong table cell fails these; no hand-computed vector is trusted.
  ⑤ **`date` column (`mode: "date"`) round-trip** — T1 dob test (UTC day precision).
  ⑥ **raw `UPDATE … FROM` with a bound `::date` parameter** — T6's sweep tests (flips exactly 2 of 4 candidates; idempotent second run 0; the §5.2 array-binding trap is avoided everywhere else by drizzle `inArray`).
  ⑦ **EXPLAIN (FORMAT JSON) shape through node-postgres** — T4 handles both string and pre-parsed forms; discharging assertion is the non-empty node walk (①).
  ⑧ **the 200k perf seed is CI-viable** — T4's `beforeAll` (120 s timeout, single `generate_series` INSERT + ANALYZE, teardown truncates); CI observed green on the pushed commit is part of the task's done-ness.
  ⑨ **partial-unique conflict behavior via `onConflictDoNothing().returning()`** — T1's pending-loser test + T8's duplicate-request test (`merge_already_requested`, whole-tx rollback proven by the approval not existing after).
  ⑩ **Nest `{ bodyParser: false }` at `createNestApplication` + `useBodyParser("json", { limit: "1mb" })`** (third-party API surface) — T9's 300 kB base64 photo round-trip over HTTP.
  ⑪ **route declaration order** (literal `search`/`qr/verify`/`merge-requests` before `:id`) — T9's e2e hits all three literals successfully.
  ⑫ **Vite/Vitest run with esbuild's postinstall blocked by pnpm 10 `ignoredBuilds`** — T11 executes `pnpm --filter @hmis/web build` and the test run; if either fails, HALT and report (never silently add `onlyBuiltDependencies`).
  ⑬ **`pnpm -r exec tsc --noEmit` genuinely checks apps/web** — T11's `tsc --noEmit --listFiles | grep -c "src/App.tsx"` ≥ 1 (a references-style config would silently check nothing).
  ⑭ **the dependency ranges resolve** (first dep wave since Plan 01) — T11/T13 `pnpm install` success + committed lockfile; an unresolvable range is a PLAN DEFECT to report with the exact pnpm error.
  ⑮ **shadcn CLI runs non-interactively against `components.json`** — T13 executes it; acceptance is behavioral (files exist, verify green), bytes are registry-owned.
  ⑯ **`@hookform/resolvers` zod-4 interop** — T12's login test renders zod messages through the resolver.
  ⑰ **react-i18next ^15 under React 19** — T12's boot smoke test (`findByText("Sign in")` resolves through i18n).
  ⑱ **READ-COMMITTED claim-splitting of the sweep** — T6's parallel test (`a + b === 3`, exactly 3 events).
  ⑲ **race-loser codes fully enumerated (§3.13)** — T8's two races each produce exactly ONE possible loser code (`merge_not_requested` / `merge_not_executed`), argued from the claim being the transaction's first statement with all validation reads outside the tx — and asserted with the invariant (one fulfilled, one event) alongside the code.
  ⑳ **jsonb `movedRows` ids restore exactly** — T8's unmerge test (moved allergy returns to the loser; the winner holds zero).
  **Derived-fixture check (§3.10):** every approval-flow fixture funnels through `approvalFlowDefinition` → `defineWorkflow` (valid by construction); `dobAged(20)`-style fixtures were hand-checked against T3's own rules (an adult MAY carry a guardian — the minor rule requires, never forbids; recorded inline in T6); no fixture is built by spreading another.
- **Standing-rules audit (EXECUTION-LESSONS §3):** §3.1 every Files list names every file its steps touch — including `schema/index.ts` + `test/helpers/db.ts` (T1), `apps/core/package.json` (T2), `main.ts` + `app.module.ts` (T9), root `eslint.config.mjs` + root `package.json` + lockfile (T11), `apps/web/package.json` + lockfile (T13, CLI-driven), `App.test.tsx` modification (T12), `router.tsx` swaps (T14/T15/T16), `styles.css` append (T14), `README.md` (T10/T16) · §3.3 no conditional instructions — the only "if" branches are explicit HALT-AND-REPORT protocols (CLI failure, unresolvable range, dropped opclass), which stall nothing · §3.5 fail-first ordering holds T1–T9 and T12–T16 (tests precede implementation; T9's e2e precedes the controller); **T10 explicitly owes no red run** (evidence named in-task); T11's config files owe none (evidence = flags ⑫⑬⑭) with the smoke test red→green sequence spelled out · §3.6 **no new boot-time DB call** — the registry grows and the existing `syncPermissions` mirrors it; the `main.ts` change is transport-layer only and existing e2es keep their default parser (audited: no existing suite touches a >100 kb body) · §3.7 all test imports static · §3.9 every flag above names its owning task and assertion · §3.11 no `JSON.stringify` assertion anywhere (the EXPLAIN walk operates on parsed objects) · §3.12 the new truncate statement names ALL five FK-linked tables + config in ONE command; **no new table FKs into any existing truncate group** (the `approval_id` no-FK decision, recorded in T1) so no existing statement changes · §2.3 no criterion demands reproducing a red run on retry — fail-first evidence is owed by the original attempt and inherited.

## Pipeline notes (compile from these — execution session)

- Paste EXECUTION-LESSONS **§1 Tripwires verbatim at the TOP of every task brief**, above the goal.
- **Three pipelines: A = T1–T6, B = T7–T10, C = T11–T16 — strictly sequential within each, A → B → C between them** (B consumes A's services; C consumes B's HTTP surface; within C every task touches `apps/web`). ≤6 tasks per Workflow per the standing rule. Land any template/ledger fix between pipelines, then compile the next.
- **Migration `0006_*` is generated once, in T1** — no later task runs `db:generate`; an empty or duplicate migration appearing anywhere is a defect: delete it and report.
- **Frozen for this plan** — a coder needing to "improve" any of these must HALT and report: everything under `src/kernel/workflow/`, `src/kernel/auth/`, `src/kernel/events/`, `src/kernel/modules/`, `src/kernel/approvals/` · `jest.config.cjs` · `.env.example` · `tsconfig.base.json` · **`.github/workflows/*` (tripwire 10 — owner decision Q2: CI needs NO change; if an agent concludes otherwise, that conclusion is a report, never an edit).**
- **Network note for pipeline C:** T11/T13 run `pnpm install` and the shadcn registry fetch on the server — both need outbound network (present); a registry failure is an infra event, not a code defect (do not consume a defect retry on it — §2.1's classifier applies).
- Existing deviations not to "fix": everything in gate reports 01/02/03/04 §4 (MODULE_REGISTRY in `tokens.ts`, static e2e imports, `@Public` at method level, duplicate import lines, argon2 under `ignoredBuilds`, `decide<V>` generic, three-code race set). **New in this plan:** shadcn `components/ui/**` bytes are registry-owned (behavioral acceptance only; lint already relaxed for that path) · the web UI deliberately holds NO client-side permission model (server enforces; 403s render inline) · `hi.json` completeness is a translation pass the owner reviews at UAT — missing keys fall back to English visibly, which is the intended failure mode.
- **Recommended tier map (OWNER-ADJUSTABLE):** T1 sonnet · T2 sonnet (the property tests make the Verhoeff transcription self-verifying) · **T3 opus** (identity semantics: minor rule, confidential existence-hiding, merge-chain resolution, audited diff — silently-wrong territory) · **T4 opus** (the perf gate: hand-written SQL, EXPLAIN plan parsing, budget calibration — the flag-densest task) · T5 sonnet · **T6 opus** (authority semantics + the fourth sweep's concurrency + raw `UPDATE…FROM` binding) · T7 sonnet (well-specified crypto consumption) · **T8 opus** (the riskiest task in the plan: multi-table moves, approval coupling, two races, snapshot restore) · **T9 opus** (first domain-module wiring, 21 routes, bootstrap change — Plan 03 T9 / Plan 04 T7 shape, both correctly opus) · T10 sonnet · **T11 opus** (toolchain bring-up: first web workspace, the dependency wave, root lint edit — integration surfaces unverifiable by reading) · T12 sonnet · T13 sonnet · **T14 opus** (the flagship screen: capture pipeline, C-18 flow, print isolation) · T15 sonnet · T16 sonnet. **Opus gate on every task regardless of coder tier — never trade the gate away.** Running everything on sonnet is a supported cost/risk trade the owner may make at compile time without editing tasks.
- **Cost calibration:** Plan 04 actuals were ~160k subagent tokens per task including its gate (1,278,905 across 8 tasks, within 2% of estimate). Sixteen tasks ⇒ **expect ~2.5–2.8M subagent tokens across three pipelines, ~55–80 min wall clock each**. The web tasks (no DB, no e2e apps) may run cooler; T11 (install churn, many small files) and T14 (largest single screen) hotter. Only genuine code defects should consume retries.
- The execution session additionally records **one 1M-row perf run on the server** (same query set as T4, seeded via the same generate_series shape at 1,000,000) in the gate report — evidence at scale, not CI-gated.
- **Go-live items this plan creates (for the gate report's carried-forward list):** production UHID prefix (Class A, owner) · `patient_merge`/`patient_unmerge` type registration (runbook, T10 docs) · role grants for `patients.*` · the fourth sweep joins Plan 11's pg-boss registration list · per-access break-glass eventing carried to the EMR plan.

<!-- PLAN COMPLETE -->
