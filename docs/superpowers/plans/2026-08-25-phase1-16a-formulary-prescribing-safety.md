# Plan 16a — Formulary & Prescribing Safety (clinical copilot Phase A, part 1)

**Written 2026-08-25 (owner brainstorm → stress-tested spec → this plan). APPROVED FOR EXECUTION 2026-08-26 (owner, in-conversation) and kicked off the same day.**
**Spec:** [`../specs/2026-08-25-clinical-copilot-design.md`](../specs/2026-08-25-clinical-copilot-design.md) — this plan implements its §1 (formulary module + deterministic safety layer) and inherits its ten design laws; the plan argues from the spec and does not restate it.
**Slot: RULED 2026-08-26 (owner, in-conversation) — PARALLEL TO PLAN 09.** 11h closed 2026-08-25 (twelve commits, fourteen mutants dead), so the fence below is discharged. Plan 09 is LIVE-BUT-NOT-CLOSED (its independent review waits on a model-limit reset, 2026-08-28 06:00 UTC) and Plan 09a — the four MAJORs that gate 09's flags — stays open at T2–T4 with T1 landed. **This phase touches none of it**: the owner's ruling is that the two lanes run independently, and the only contact point is the migration counter (see § 2's kickoff re-base). Original slot wording, kept as the record: *after Plan 11h closes; before or parallel to Plan 09 — owner rules at kickoff.* The roadmap file is **not amended by this document** (the 11h precedent); the one-line roadmap amendment lands at this phase's close. Numbering: 16a because the medicine master is Plan 16 (pharmacy)'s foundation and the DTC-formulary clock (running since 2026-08-23) lands its output here; 16a has **zero dependency on Plans 09/13/14** — it extends shipped OPD prescribing only.
**Plan 16b — Context Assembler & snapshot card** (spec §2.1), the second half of clinical-copilot Phase A, is **written PROVISIONAL** ([`2026-08-25-phase1-16b-context-assembler-snapshot-card.md`](2026-08-25-phase1-16b-context-assembler-snapshot-card.md), owner-instructed 2026-08-25, ahead of this phase's execution) — its §0 seam list re-bases against THIS phase's CLOSE before it is approved. Nothing in 16a depends on 16b; this phase's CLOSE is 16b's kickoff input.

**Executor seed (v3 §1):** read this document, [`AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 — then execute, on the build host, task by task.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Nine tasks. This is a new module, and v3 §2's guide says LIGHT presumes "no full-module build" — the ruling sentence, honestly: the formulary is masters + pure functions + one admin screen family, with no money arithmetic, no locking beyond what `issuePrescription` already holds, and no workflow definitions; it is smaller than 11e (user administration), which ran LIGHT as the v3 pilot. The main session codes task by task under AGENT-RULES, builds the mutants for the inline CRITICAL rows (T3/T4/T5 — the safety seams get executed mutants in either lane, v3 §2), watches CI with [`pipelines/ci-watch-host.sh`](../pipelines/ci-watch-host.sh), and closes with one independent reviewer.

**Stop-loss (v3 §6): 2.5M tokens — the fallback, and it applies for a reason worth naming.** 11h's actuals row IS written, and its token cell reads *"not readable by the session about itself — the 11e precedent; owner-held"*. A row that exists and carries no number is the same input as no row, so the fallback stands. (Plan 09's close shipped the `token-audit` skill; whether it can read THIS phase about itself is a question for CLOSE, not an assumption here.)

**Parallel-work fence:** Plan 11h was executing on this host the night this plan was written (T5 landed 2026-08-25 ~03:40). **16a does not start before 11h's CLOSE.** Shared files to rebase onto 11h's merged state, not around it: `apps/web/src/router.tsx` (11h mounts the palette; T6/T7 add routes), `apps/core/src/kernel/modules/manifests.ts` + `manifests.test.ts` (census 9 → 10 is THIS phase's change; 11h changed providers, not the census), `apps/core/src/modules/opd/manifest.ts` (11h T3 added `search:`; T5 here touches nothing in it — listed so nobody "cleans it up").

---

## 1. Why this phase

The owner proposed a clinical copilot (2026-08-25): role-bound per staff member, LLM at the doctor dashboard reading diagnostics/labs/prescriptions/allergies, context-aware across OPD/OT/ICU/IPD. The brainstorm split it (spec D1): the conversational copilot keeps its ops-roles-first rollout ruling and its post-12a gates; what ships **now** is the deterministic half — the checks that must fire 100% of the time and therefore must not be a model. This phase is that half's foundation and first consumer.

The gap is measured, not hypothesized (§2): today's allergy guard is a bidirectional substring match over free text — its own doc-comment says "free-text on both sides is the reality until a formulary lands (stage 2)". An allergy to "penicillin" catches "Penicillin G" and misses **Augmentin** (amoxicillin + clavulanate), because nothing in the system knows what any drug *is*. Drug–drug interaction and duplicate-therapy checks are not weak — they are impossible. The formulary module makes them possible, and the OPD prescription pipeline becomes their first consumer, behind the same hard-warning → override-with-reason → S10-KPI machinery already shipped.

The sequencing economics mirror 11h's: Plan 16 (pharmacy) is already gated on the DTC-formulary and interaction-dataset clocks, and every stage-2 clinical module (mini-OT implants, pharmacy dispense, lab-drug interference later) needs the medicine master. Building it now means Plan 16 builds stock/pricing/dispensing on a proven master instead of building the master under pressure; and OPD prescribing — live today — gets the Augmentin gap closed months before pharmacy exists. The owner's parallel mining track (platinumrx seed data, spec D2) needs the staging tables to land into; they are T1's cheapest rows.

---

## 2. Ground truth (measured 2026-08-25, this repo)

- `matchAllergies` (`apps/core/src/modules/opd/prescriptions.ts:38`) — pure, case-insensitive, bidirectional substring; no length guard. Hard-warning machinery around it: `allergy_conflict` carries `{ matches }`, override reason ≥ 3 chars (`MIN_OVERRIDE_REASON`), `allergyOverrideCount` on the `prescriptionIssued` event (S10 numerator).
- `RxLine` (`apps/core/src/modules/opd/fhir.ts:11`) = `{ drug, dose, route, frequency, durationDays: number | null, instructions, noSubstitution }` — **`durationDays` already exists**, so prior-rx currency is computable with no data-model change. No `medicineId` yet; stored `lines` jsonb rows will lack it forever, so it enters as `medicineId?: string | null` and every reader stays tolerant of its absence.
- `patient_allergies` (`kernel/db/schema/patients.ts:108`): `substance` free text, `severity`, `status: 'active'|'entered_in_error'`. Allergies reach OPD only via `listAllergies` (the read-helper boundary this module copies).
- **No medicine/drug/salt table exists anywhere** (grep over `apps/core/drizzle/*.sql` and `src`: zero hits for drug/medicine masters). Migration head: `0010_silent_victor_mancha.sql` → this phase generates `0011` (AGENT-RULES §6 discipline).
- Schema is per-domain files under `apps/core/src/kernel/db/schema/` (each with a census-pinning `.test.ts` sibling); `ALL_MANIFESTS` (`kernel/modules/manifests.ts`) is pinned by `manifests.test.ts` to **nine manifests, by key, in order** — registering the tenth is a deliberate two-file change plus `app.module.ts`.
- `issuePrescription` runs checks **before** `withTx` and serializes versions FOR-UPDATE on the encounter row; the check suite slots where `matchAllergies` runs today. Note for T5: allergy listing happens pre-transaction today; the spec's "checks evaluate at issue time" law is satisfied by keeping reads adjacent to the existing read — do not move them inside the version-serializer transaction and lengthen the lock window.

**RE-BASED AT KICKOFF, 2026-08-26 — three of the seven bullets above were measured on 2026-08-25 and TWO OF THEM HAVE MOVED.** Plans 09, 09a and 11h all landed between the writing and the kickoff, and the two facts that moved are both counters this phase increments:

- **Migration head is `0025_episode_numbers`, not `0010_silent_victor_mancha`** — 11h landed `0020`/`0021`, Plan 09 landed `0022`, and `0023`–`0025` came from the identifier-grammar lane. **T1 generates `0026`.** Plan 09a's T2 had also been written against `0026`; its row now reads *the next free number, read at kickoff* and names this phase as the one that takes it (AGENT-RULES §6 is the standing rule; this is the one time two open phases could have collided on it).
- **`ALL_MANIFESTS` holds ELEVEN manifests, not nine** — Plan 09 installed `membership` and `partners`. **T2's census change is eleven → twelve**, and `manifests.test.ts` pins it by key, in order, alongside `app.module.ts` and the worker's own set.
- Unchanged and re-confirmed: `matchAllergies` is still `prescriptions.ts:36`, still bidirectional substring, still carrying the doc-comment that names its own expiry (*"until a formulary lands (stage 2)"*); `RxLine` still carries `durationDays`; `patient_allergies` is untouched. **The three facts this phase's design rests on did not move.**

## 3. Spike — answered at kickoff, on the host, read-only SQL (11d Question B precedent)

Write the measured answers in place here before T1 starts; Q1's output is also T8's acceptance fixture.

**ANSWERED 2026-08-26, read-only `SELECT` against `hmis-prod-db-1` (the production database), before T1 started. The headline is one sentence and it governs how every answer below should be read: PRODUCTION HAS NEVER LEFT COMMISSIONING, so there is almost nothing to measure — 21 patients, 8 encounters, 1 prescription, 4 allergy rows, all of it smoke-test data.** That is not a spike that failed; it is a spike that returned a number, and the number changes what three tasks may claim. **What it does NOT change: the Augmentin gap is a property of the CODE, not of the traffic** — §2's re-confirmed bullets are the ground this phase actually stands on, and they were measured, not assumed.

- **Q1 — the real drug vocabulary:** distinct `lines[].drug` strings over all `opd_prescriptions`, with frequency (lateral `jsonb_array_elements`). Answers: how big the day-one curation worklist is, whether 0.8 is a sane coverage-notice threshold, and what T9's seed should actually contain.
  **MEASURED: one distinct string in the entire production book — `Paracetamol`, count 1.** Day-one curation worklist: one row. **Consequence, and it is a real narrowing:** 0.8 cannot be calibrated against live data — at n=1 the coverage ratio is 0 or 1 and `noticeEnabled` flips with a single prescription. DD5's threshold therefore stands AS RULED rather than as measured, T8's acceptance stays on seeded fixtures exactly as written, and the first honest calibration is a pilot-traffic measurement this phase does not have and must not pretend to. **T9's seed cannot be reviewed against the real vocabulary either** (see Q1's consequence in T9 below).
- **Q2 — durationDays fill rate:** % of stored lines with non-null `durationDays`. Answers how often the labeled 90-day fallback will fire (spec §1.3 check 2).
  **MEASURED: 1 of 1 stored lines carries a non-null `durationDays` — 100%, n=1, which is not an answer.** The labeled 90-day fallback's real frequency is unknown until pilot traffic. T4 implements `isCurrent` exactly as specified (the arithmetic is not in doubt — its Assertion Book row runs both branches in one test); what stays open is 16b §0.5's question of how LOUD the `assumedCurrent` label will be in practice, and it is re-asked at 16b's kickoff with real data or not at all.
- **Q3 — allergy substance reality:** distinct `patient_allergies.substance` values. Answers whether brand-name allergies (spec finding: "Augmentin" recorded as the substance) exist in production data today, i.e. whether T3's substance-resolution path has live specimens on day one.
  **MEASURED: four rows — `adrak`, `dust`, `SYN-Dust`, `SYN-Penicillin`.** Three things follow and each is worth its line. **(a) There are ZERO brand-name drug allergies in production**, so T3's substance-resolution path has no live specimen on day one and its evidence is fixtures only — stated here so no later reader mistakes a green suite for a field measurement. **(b) Two of the four are not drugs at all** (`dust`; `adrak` is ginger — a patient's own word for what they react to, recorded in the language they said it in). Neither will ever resolve, both must stay on the substring fallback, and **that is design law 1 arriving as live data rather than as a principle**: the check suite's most common real input may well be a substance the formulary does not contain. **(c) `SYN-` is the commissioning smoke prefix** — `SYN-Penicillin` normalizes to `synpenicillin`, resolves to nothing, and matches nothing by substring either. It is not a specimen of the class path; the Augmentin regression test remains the only thing that proves that path, which is why it is an Assertion Book row and not a fixture.
- **Q4 — coverage-query cost:** `EXPLAIN ANALYZE` of Q1's query at production size. If it is not obviously cheap, T8 caches it per-day rather than per-request; the answer decides, not a hunch.
  **MEASURED: 0.122 ms execution, 0.608 ms planning — and the shape matters more than the number.** The plan is `Seq Scan on opd_prescriptions` → `Function Scan on jsonb_array_elements` → `HashAggregate`, i.e. **cost linear in the whole prescription book, with no index available to it**. At one row that is free; the measurement forecasts nothing. **Ruling: T8 computes directly this phase (no day-cache — caching a query nobody has yet measured under load is a guess wearing a number's clothes), and CLOSE records that the cache decision is DEFERRED to the first real-volume measurement, not settled by this one.** The 30-day predicate is what will make or break it, and `opd_prescriptions.issued_at` carrying no index is the thing to look at first when that day comes.

## 4. Design decisions (what this plan rules beyond the spec)

- **DD1 — checks are pure functions in `modules/opd/rx-checks.ts`, fed formulary data as arguments.** OPD's purity pattern (queue-engine precedent, `purity.test.ts`) and the module boundary both hold: OPD imports read helpers from `../formulary` (the `listAllergies` shape), never formulary tables. `prescriptions.ts` stays focused; the new file owns the suite.
- **DD2 — fuzzy suggests, exact resolves.** The consult autocomplete may match generously (it is a picker; a human confirms). But `resolveDrugTexts` — the path that feeds SAFETY checks with no human in the loop (allergy substances, legacy free-text lines) — resolves only by exact brand name, salt/moiety name, or recorded alias after normalization (lowercase, trim, collapse whitespace, strip `.,()-/`). A typo resolves to `null` and falls to the legacy substring layer; it never fuzzy-resolves into the wrong drug's salts.
- **DD3 — the hard-warning grammar extends, not forks.** Severe interactions and in-rx duplicates join `allergy_conflict`'s exact shape: an `OpdError` carrying its matches in `detail`, an override array with `reason ≥ MIN_OVERRIDE_REASON`, a count on the issued event. New codes: `interaction_conflict`, `duplicate_salt_conflict`. Moderate interactions, vs-prior duplicates, and different-route duplicates are **soft notices returned in the issue response** (and shown pre-submit by T6) — data, never errors, never override-gated.
- **DD4 — prior-line resolution is live, not stored.** When checking against prior prescriptions, their free-text lines are resolved against the CURRENT formulary — a line unresolvable last month resolves today as coverage grows, and old prescriptions get today's protection. (Composition corrections reach future checks automatically for the same reason; the retro-scan of *active* prescriptions stays the spec's named deferral.)
- **DD5 — coverage threshold is one constant, one owner.** `COVERAGE_NOTICE_THRESHOLD = 0.8` lives in the formulary module; the coverage endpoint returns `{ coverage, noticeEnabled }` and T6 reads `noticeEnabled` — the client never re-derives it (the fact rule, applied to a number).
- **DD6 — seed pairs are data with provenance, and small.** T9 seeds ~25 classically severe pairs (warfarin×NSAIDs family, methotrexate×trimethoprim, MAOI×SSRI, macrolide×statin, etc.), each row `source: 'seed-2026-08'`. The DTC clock owns expansion; a licensed interaction dataset (the RFQ clock) lands through staging→admission like any mined data, never as a bulk table load.
- **DD7 — `routeClass` makes route-awareness cheap.** `formulary_medicines.route_class: 'systemic' | 'topical'` set at admission (from form), consumed by checks: same-moiety different-routeClass → soft; interaction pairs may carry `route_scope: 'systemic_only' | null`. No per-route ontology — two buckets, extendable when a specimen demands it.
- **DD8 — intra-FDC pairs are an admission concern.** `addMedicine` checks the new medicine's own salts against the pair table; a hit requires `acknowledgeIntraFdc: true` in the input (surfaced by T7's UI), else `intra_fdc_interaction`. Prescribing-time checks skip same-line pairs entirely.
- **DD9 — `medicineId` rides the FHIR document as an identifier, not a rewrite.** `toFhirBundle` keeps drug display text as-is; a resolved line adds the id into the medication entry. Old stored documents are untouched and never migrated.

- **DD10 — WHO HOLDS THE THREE NEW PERMISSIONS, and the plan defect that forced the question at kickoff (added 2026-08-26).** T2's Files list named the manifest and the manifest census and stopped there — but `scripts/seed-roles.ts` + `test/seed-roles.test.ts` hold a **reachability invariant** (every declared permission is granted to a role or listed in `NOT_YET_MODELLED` with a reason) and a hard census pin (*"74 declared = 60 held + 14 not yet modelled"*), and `README.md` carries a permission×role table that `seed-roles.test.ts` compares **cell for cell, both directions**. **A task that declares three permissions and may not edit those files cannot go green** — the same shape Plan 09's T1 relay warned about in as many words, arriving from the other side. The Files list is corrected in T2 below; the ruling the correction needs is here:
  - **`formulary.read` → `doctor` and `pharmacy`.** The spec says *read for any prescriber* (§1); T6's autocomplete is unusable without it, and a pharmacist who may not read the formulary cannot verify what they dispense.
  - **`formulary.manage` and `formulary.staging.review` → `pharmacy`.** The spec's word is *pharmacist-gated*, twice (§1.1). No new role is minted.
  - **This grants live authority to NOBODY today, and that is measured rather than hoped:** `pharmacy` is one of the three roles `seed:roles` creates with grants and no holders. The grant is a door that opens the day a pharmacist account exists — which is the DD18 posture (minimum authority, no new role model) reached from the opposite direction, because here the role already exists and the permission is new.
  - **Expected census after T2: 77 declared = 63 held + 14 not yet modelled.** T2 MEASURES it and reports the difference rather than assuming this line (AGENT-RULES §4).

---

## 5. Tasks

Tiers per AGENT-RULES §3. CRITICAL tasks carry their Assertion Book rows inline (assertion · mutant · discriminating input). Every task ends with the finish block (AGENT-RULES §5); commit messages are exact.

---

### T1 — Formulary schema: five tables, moiety-canonical salts — **ROUTINE**

**Files:** Create `apps/core/src/kernel/db/schema/formulary.ts`, `apps/core/src/kernel/db/schema/formulary.test.ts`; Modify `apps/core/src/kernel/db/schema/index.ts` (export); **AMENDED AT EXECUTION (F2):** Modify `apps/core/test/helpers/db.ts` (the formulary island's `truncateAll` statement — without it every other suite leaves formulary rows standing for the next one); Generate ~~`0011_*.sql`~~ **`apps/core/drizzle/0026_*.sql`** (+ meta) via `pnpm db:generate` — the head is `0025_episode_numbers`, re-measured at kickoff (§2).

**Produces (exact, later tasks depend on these names):**
- `formularySalts`: `id` PK · `name` (canonical **active moiety**, unique on lower) · `aliases` jsonb `string[]` default `[]` · `drugClass` text nullable · `atcCode` text nullable · `active` bool default true · `createdBy/createdAt/updatedBy/updatedAt` (the `opd_departments` audit shape).
- `formularyMedicines`: `id` PK · `brandName` (unique on lower) · `form` text · `routeClass` text notNull default `'systemic'` (`'systemic'|'topical'`) · `strengthLabel` text nullable · `scheduleFlag` text nullable (`'H'|'H1'|'X'|'OTC'`) · `stagingId` text nullable · `active` · audit columns.
- `formularyMedicineSalts`: `medicineId` ref · `saltId` ref · `strength` text nullable · PK `(medicineId, saltId)`.
- `formularyInteractions`: `id` PK · `saltAId`/`saltBId` refs with **CHECK `salt_a_id < salt_b_id`** and unique `(saltAId, saltBId)` (canonical ordering — no reversed duplicates) · `severity` (`'severe'|'moderate'`) · `note` text notNull · `source` text notNull · `routeScope` text nullable (`'systemic_only'`) · `active` · audit columns.
- `formularyStaging`: `id` PK · `kind` text notNull (`'medicine'`) · `name` text notNull · `payload` jsonb notNull · `sourceUrl` text notNull · `minedAt` timestamptz notNull · `status` text notNull default `'pending'` (`'pending'|'approved'|'rejected'`) · `reviewedBy`/`reviewedAt` nullable · `medicineId` text nullable (the admitted row it became).

**Acceptance:** `formulary.test.ts` pins the census (five tables, columns by name — the `opd.test.ts` pattern); migration `0011` generated only when ready to carry to the same commit (AGENT-RULES §6); full-suite migration applies clean.
**Commit:** `feat(core): formulary schema — five tables, moiety-canonical salts (16a T1)`

---

### T2 — The formulary module: manifest, masters, events, controller — **ROUTINE**

**Files:** Create `apps/core/src/modules/formulary/{index.ts, manifest.ts, events.ts, errors.ts, masters.ts, masters.test.ts, formulary.controller.ts, formulary.module.ts}`; Modify `apps/core/src/kernel/modules/manifests.ts` (+ its census test: ~~nine → ten~~ **ELEVEN → TWELVE**, re-based 2026-08-26 — Plan 09 installed `membership` and `partners`) and `apps/core/src/app.module.ts` (install order — the census test pins all three in sync); **AMENDED AT KICKOFF (DD10):** Modify `apps/core/scripts/seed-roles.ts` (the three grants), `apps/core/test/seed-roles.test.ts` (the reachability census and the per-role counts it pins) and `README.md` (the permission×role table `seed-roles.test.ts` compares cell for cell). **Those three were missing and the task could not have gone green without them.**

**Produces:** manifest key `"formulary"`, permissions `["formulary.read", "formulary.manage", "formulary.staging.review"]`, menu `[{ label: "Formulary", path: "/formulary/admin", permission: "formulary.manage" }]`, `search: []`, `subscriptions: []`. `FormularyError` codes: `"unknown_salt" | "unknown_medicine" | "duplicate_name" | "intra_fdc_interaction" | "staging_not_pending"`. Events (defineEvent grammar): `formulary.salt.added|updated`, `formulary.medicine.added|updated|corrected`, `formulary.interaction.added|updated`, `formulary.staging.approved|rejected` — `updateMedicine` emits `…updated` for attribute changes and `…corrected` when the salt composition changes (the spec's retro-scan hook, §1.1). Masters (all `(tx, actor, …)`, the `opd/masters.ts` shape): `addSalt`, `updateSalt`, `addMedicine(tx, actor, input: { brandName; form; routeClass; strengthLabel?; scheduleFlag?; salts: { saltId; strength? }[]; stagingId?; acknowledgeIntraFdc?: boolean })`, `updateMedicine`, `addInteraction` (normalizes pair ordering before insert), `updateInteraction`. **`addMedicine` implements DD8**: queries `formularyInteractions` among the new medicine's own saltIds; on a hit without `acknowledgeIntraFdc: true` → `intra_fdc_interaction` carrying the pairs.
**Acceptance:** masters tests cover: composition round-trip (Augmentin = amoxicillin + clavulanic acid); duplicate brand rejected; interaction pair stored canonically whichever order given; DD8 both branches (blocked without acknowledge, admitted with, event either way); each mutation lands its event (assert on `events` table by name, the `allergies.test.ts` shape). Manifest census test updated to **twelve** and green; **the reachability census closes at the number T2 MEASURES** (DD10 predicts 77 = 63 + 14 — report the difference and its cause if it is not, never pad to hit it).
**Commit:** `feat(core): the formulary module — manifest, masters, events (16a T2)`

---

### T3 — Resolution read surface: exact resolves, fuzzy never does — **CRITICAL**

**Files:** Create `apps/core/src/modules/formulary/{resolve.ts, resolve.test.ts}`; Modify `apps/core/src/modules/formulary/index.ts` (exports).

**Produces (the boundary OPD consumes — exact signatures):**
```ts
export type SaltRef = { saltId: string; moiety: string; drugClass: string | null };
export type ResolvedDrug = { medicineId: string | null; brandName: string | null; routeClass: "systemic" | "topical" | null; salts: SaltRef[] };
export function normalizeDrugName(raw: string): string; // lowercase, trim, collapse ws, strip .,()-/
export async function resolveMedicines(db: Db, medicineIds: string[]): Promise<Map<string, ResolvedDrug>>;   // active medicines only
export async function resolveDrugTexts(db: Db, texts: string[]): Promise<Map<string, ResolvedDrug | null>>;  // DD2 path
export async function listInteractionsAmong(db: Db, saltIds: string[]): Promise<InteractionPair[]>;
export type InteractionPair = { saltAId: string; saltBId: string; severity: "severe" | "moderate"; note: string; routeScope: "systemic_only" | null };
```
`resolveDrugTexts` resolution order per text: normalized brand name → salt moiety name → salt alias; **no substring, no trigram, no distance** (DD2). A text that is a salt (not a brand) resolves with `medicineId: null` and that one salt. Inactive rows never resolve.

**Assertion Book (assertion · mutant · discriminating input):**
- *Brand resolution carries composition* · mutant: `resolveDrugTexts` looks up salts only, never `formularyMedicines` · input: text `"Augmentin"` with T2's fixture → expected `salts = [amoxicillin, clavulanic acid]`; mutant → `null`.
- *Alias resolves* · mutant: alias lookup dropped · input: `"amoxycillin"` (alias of amoxicillin) → expected the salt; mutant → `null`.
- *Fuzzy never resolves* · mutant: matching by `includes()` after normalization · input: `"Augmentn"` (typo) → expected `null`; mutant → resolves. The assertion pins `null` — this row is the DD2 law made executable.
- *Inactive is invisible* · mutant: `active` filter dropped · input: deactivated medicine's brand → expected `null`; mutant → resolves.

**Acceptance:** all four mutants DIED (separate scratch files, isolation quoted, expected-vs-received quoted — AGENT-RULES rule 21); fail-first quoted for the first test.
**Commit:** `feat(core): formulary resolution read surface — exact resolves, fuzzy never does (16a T3)`

---

### T4 — The check suite: salt-aware allergies, interactions, duplicates — **CRITICAL**

**Files:** Create `apps/core/src/modules/opd/{rx-checks.ts, rx-checks.test.ts}`. (Pure functions only — no db import; the file is added to `purity.test.ts`'s covered set.) **AMENDED AT EXECUTION:** Modify `apps/core/src/modules/opd/purity.test.ts` (the parenthetical above authorises it; the Files list did not name it) and `apps/core/src/modules/formulary/{resolve.ts, index.ts}` (the normalizer is published through the module's interface — see F13).

**Produces (exact signatures; T5 consumes all of these):**
```ts
export type RxCheckLine = { lineIndex: number; drug: string; resolution: ResolvedDrug | null };
export type PriorRx = { prescriptionId: string; issuedAt: Date; lines: { line: RxLine; resolution: ResolvedDrug | null }[] };
export function isCurrent(durationDays: number | null, issuedAt: Date, now: Date): { current: boolean; assumedCurrent: boolean };
  // durationDays present: current ⇔ now ≤ issuedAt + durationDays; null: current within 90 days with assumedCurrent=true, else not current
export function matchAllergiesSaltAware(
  lines: RxCheckLine[],
  allergies: { substance: string; resolution: ResolvedDrug | null }[],
): AllergyMatch[]; // AllergyMatch unchanged from prescriptions.ts
export type InteractionHit = {
  severity: "severe" | "moderate"; lineIndex: number; saltPair: [string, string]; note: string;
  against: { scope: "in_rx"; lineIndex: number } | { scope: "prior"; prescriptionId: string; issuedAt: Date; assumedCurrent: boolean };
};
export function checkInteractions(lines: RxCheckLine[], priors: PriorRx[], pairs: InteractionPair[], now: Date): InteractionHit[];
export type DuplicateHit = {
  moiety: string; lineIndex: number; hard: boolean;
  against: { scope: "in_rx"; lineIndex: number } | { scope: "prior"; prescriptionId: string; issuedAt: Date; assumedCurrent: boolean };
};
export function checkDuplicateSalt(lines: RxCheckLine[], priors: PriorRx[], now: Date): DuplicateHit[];
```
Semantics (each a spec §1.3 line): allergy matching = substance's resolved moiety-set ∩ line's moiety-set, **plus** normalized substance vs each line-salt's `moiety`/`aliases`/`drugClass` (the class path: substance text `"penicillin"` hits a salt whose `drugClass` is `"penicillin"`), **plus** the legacy bidirectional substring on raw text as the fallback layer — now with the guard: a side shorter than 4 chars matches only exact-token. Interactions: pairwise across distinct lines' salt cross-product and against current prior lines; same-line pairs skipped (DD8); `routeScope: 'systemic_only'` pairs skipped when either side is `topical`. Duplicates: same moiety, in-rx same-routeClass → `hard: true`; vs-prior or different-routeClass → `hard: false`.

**Assertion Book:**
- *Class path fires (the Augmentin regression, by name)* · mutant: matcher compares moieties only, ignores `drugClass` · input: allergy `{ substance: "penicillin", resolution: null }` + line Augmentin (amoxicillin, `drugClass: "penicillin"`) → expected 1 match; mutant → 0.
- *Substance resolution fires* · mutant: `allergies[].resolution` ignored · input: allergy `{ substance: "Augmentin", resolution: {salts:[amoxicillin,…]} }` + line `"Amoxicillin 500"` resolved to amoxicillin → expected 1 match; mutant → 0 (no substring overlap between "augmentin" and "amoxicillin").
- *Short-string guard* · mutant: guard removed · input: allergy `"b"` + line `"Ibuprofen"` → expected 0 matches; mutant → 1.
- *Prior-scope interactions* · mutant: `priors` branch dropped · input: rx warfarin + prior current aspirin, severe pair fixture → expected 1 severe `scope:"prior"` hit; mutant → 0.
- *Currency arithmetic* · mutant: `isCurrent` returns `{current:true}` unconditionally · input A: prior amoxicillin `durationDays: 5`, issued 10 days ago → expected no duplicate hit; mutant → 1. Input B: prior thyroxine `durationDays: null`, issued 30 days ago → expected 1 soft hit with `assumedCurrent: true` (both inputs in one test so the mutant cannot pass by luck).
- *Hard/soft boundary* · mutant: vs-prior duplicates marked `hard: true` · input: same moiety in-rx twice AND vs prior → expected `[hard:true (in_rx), hard:false (prior)]`; mutant → both true.
- *Route scoping* · mutant: `routeScope` ignored · input: topical diclofenac line + prior systemic warfarin with pair `routeScope:'systemic_only'` → expected 0 interaction hits; mutant → 1.

**Acceptance:** all seven mutants DIED with quoted expected-vs-received; fail-first quoted; `purity.test.ts` covers the new file (no db import possible).
**Commit:** `feat(core): salt-aware rx checks — allergy class match, interactions, duplicates (16a T4)`

---

### T5 — The pipeline consumes the suite; overrides and KPI extend — **CRITICAL**

**Files:** Modify `apps/core/src/modules/opd/{prescriptions.ts, fhir.ts, errors.ts, events.ts, prescriptions.test.ts, opd-visits.controller.ts, opd-masters.controller.ts}` (the last for its error-code union comment only); Modify `apps/core/test/opd.e2e.test.ts`.

**Changes, exactly:** `RxLine` gains `medicineId?: string | null` (DD9; `toFhirBundle` adds it to the medication entry when present; all readers tolerate absence). `IssuePrescriptionInput` gains `interactionOverrides?: { lineIndex: number; reason: string }[]` and `duplicateOverrides?: { lineIndex: number; reason: string }[]`. `issuePrescription`, in the existing pre-transaction read block: resolve lines (`resolveMedicines` for id-carrying lines, `resolveDrugTexts` for the rest) and allergy substances; load prior prescriptions for the patient (`status='active'`, all encounters — one indexed query) and resolve their lines (DD4); run the three checks. Severe interaction hits and `hard:true` duplicates without a covering override → throw `interaction_conflict` / `duplicate_salt_conflict` with hits in `detail` (DD3); override reasons reuse `MIN_OVERRIDE_REASON` and `override_reason_required` verbatim. Soft hits (moderate, vs-prior, route-differing) return on `IssuedPrescription` as `notices: (InteractionHit | DuplicateHit)[]` — and a new controller route `POST …/rx-precheck` (permission `opd.consult`) runs resolution + checks WITHOUT issuing, so T6 shows warnings pre-submit; **the issue path re-runs the checks regardless** (design law 2: issue time, in the same read block as today's allergy read — not inside the version-serializer tx, per §2's note). `prescriptionIssued` payload gains `interactionOverrideCount` + `duplicateOverrideCount` (event schema extended, `allergyOverrideCount` untouched). `opd-masters.controller.ts`'s error-code union note gains the two codes.

**Assertion Book:**
- *Severe blocks without override* · mutant: wiring drops `checkInteractions` result · input (e2e): formulary-seeded warfarin + aspirin severe pair, two lines, no overrides → expected `interaction_conflict` with 1 hit in `detail`; mutant → issue succeeds.
- *Override reason gate* · mutant: reason-length check skipped for `interactionOverrides` · input: override reason `"ok"` (2 chars) → expected `override_reason_required`; mutant → succeeds.
- *KPI lands* · assertion (no mutant — event-payload shape): issued with 1 interaction override → `prescriptionIssued` payload has `interactionOverrideCount: 1` read back from the `events` table.
- *Unresolved degrades, never blocks* · mutant: unresolved lines routed through salt checks with empty salts treated as a conflict, or resolution failure thrown · input: free-text line `"Some Ayurvedic Tonic"` (resolves null) + no allergies → expected issue succeeds with zero hits and zero notices; mutant → throws. This row is design law 1 made executable.
- *Legacy layer survives* · assertion (regression, no new mutant): the existing substring case — allergy `"sulfa"`, line `"Sulfamethoxazole"` unresolved → still `allergy_conflict` (the shipped `matchAllergies` tests keep passing unmodified except imports).

**Acceptance:** mutants DIED with quotes; the full shipped `prescriptions.test.ts` suite green with zero deleted tests (AGENT-RULES §4); e2e covers the precheck route (soft notices returned) and the issue-with-override path end to end.
**Commit:** `feat(core): prescription pipeline consumes the check suite; interaction overrides join the KPI event (16a T5)`

---

### T6 — Consult UI: autocomplete, hard-warning, coverage-gated notice — **ROUTINE**

**Files:** Modify `apps/web/src/screens/opd-consult.tsx`, `opd-consult.test.tsx`, `apps/web/src/lib/opd-api.ts`.

**Consumes:** T5's `rx-precheck` route and `notices`; T8's coverage endpoint (`noticeEnabled` — DD5; until T8 lands in the same phase, the client treats a 404 from the coverage endpoint as `noticeEnabled: false`, which is also the correct long-term degrade).
**Changes:** rx-line drug input gains a formulary autocomplete (existing picker pattern from the OPD doctor/department pickers; free typing always allowed — design law 1; picking sets `medicineId`, shows brand + salts). On submit: call precheck; severe/hard hits render in the existing allergy-override modal pattern extended with per-kind reasons; soft notices render as a dismissible panel (soft = never gates submit). Per-line "not in formulary — advanced checks unavailable" hint renders **only when `noticeEnabled`** and the line is unresolved. Interaction alert text = the pair's `note` + which prior prescription (date) when `scope:"prior"`, with `assumedCurrent` rendering the "prescribed N days ago — may no longer be current" label (spec §1.3). Any panel showing prior-rx hits carries the line "checked against in-system prescriptions only" (design law 10).
**Acceptance:** screen tests cover: autocomplete sets `medicineId`; severe hit requires reason ≥ 3 chars before submit proceeds; soft notice never blocks; hint absent when `noticeEnabled: false` even for unresolved lines. Test-ids follow the screen's existing convention.
**Commit:** `feat(web): consult autocomplete, interaction hard-warning, coverage-gated notice (16a T6)`

---

### T7 — Staging admission: pull-based, pharmacist-gated, sanitized — **ROUTINE**

**Files:** Create `apps/core/src/modules/formulary/{staging.ts, staging.test.ts}`, `apps/web/src/screens/formulary-admin.tsx`, `formulary-admin.test.tsx`, `apps/web/src/lib/formulary-api.ts`; Modify `apps/web/src/router.tsx` (mount `/formulary/admin`), `apps/core/src/modules/formulary/{formulary.controller.ts, index.ts}`.

**Produces:** `searchStaging(db, q)` (pending rows by normalized name — this one MAY match generously; a human reviews what it returns), `getStagingRow`, `admitStaging(tx, actor, stagingId, input)` — wraps T2's `addMedicine` (DD8 acknowledge flows through), stamps `stagingId`/`medicineId` both ways, sets `status:'approved'`, emits `formulary.staging.approved`; `rejectStaging` mirrors. Both require `formulary.staging.review` (controller-guarded); a non-pending row → `staging_not_pending`. **The pull-based inversion (spec §1.1):** the admin screen's entry flow starts from a name search; a staging hit pre-fills the medicine form; there is no "review queue" view of all pending rows. Payloads render **text-only** (no `dangerouslySetInnerHTML`, values through the default React text path; the test asserts a payload containing `<script>` renders inert as text).
**Acceptance:** staging tests: pending rows unreachable through `resolveDrugTexts`/`resolveMedicines` (the isolation law, asserted by fixture); admit round-trip creates the medicine + composition and back-links; double-admit rejected. Screen tests: search→prefill→admit flow; XSS fixture renders as text; routes denied without the permission (the existing screen-permission test pattern).
**Commit:** `feat(core+web): staging admission — pull-based, pharmacist-gated, sanitized (16a T7)`

---

### T8 — Curation surfaces: coverage worklist + pair override rates — **ROUTINE**

**Files:** Create `apps/core/src/modules/formulary/{curation.ts, curation.test.ts}`; Modify `formulary.controller.ts`, `apps/web/src/screens/formulary-admin.tsx` (+ test), `apps/web/src/lib/formulary-api.ts`.

**Produces:** `getCoverage(db)` → `{ coverage: number; noticeEnabled: boolean; unresolvedTop: { drug: string; count: number }[] }` — resolvable share of the last 30 days' prescribed lines (Q1's query, shaped by Q4's answer: direct or day-cached), `noticeEnabled = coverage >= COVERAGE_NOTICE_THRESHOLD` (DD5 — the constant lives here and nowhere else); `getPairOverrideRates(db)` → per interaction pair over the last 90 days: times hit, times overridden, rate — from `opd_prescriptions.interactionOverrides` + hits recomputed from stored lines against the current pair table (one honest SQL; if recomputation is heavier than Q4 tolerates, the rollup runs day-cached exactly like coverage — decide from the measurement, record which in CLOSE). Formulary-admin gains two sections: the unresolved-drugs worklist (each row's name pre-fills T7's entry search — the curation loop closes on screen) and the pair table flagging rates above 0.9 for curator review (spec §1.4; display-only this phase — downgrades happen through T2's `updateInteraction` by a human).
**Acceptance:** curation tests with seeded fixtures: coverage math (2 resolvable of 3 lines → 0.667, `noticeEnabled: false`); worklist ranks by frequency; override-rate arithmetic (3 hits, 2 overridden → 0.667). Screen test: worklist row click lands in entry search.
**Commit:** `feat(core+web): curation surfaces — coverage worklist and pair override rates (16a T8)`

---

### T9 — Severe-pair starter seed, with provenance — **ROUTINE**

**Files:** Create `apps/core/scripts/seed-formulary-interactions.ts`, `apps/core/test/seed-formulary-interactions.test.ts` (the `seed-roles` script+test pattern).

**Content:** ~25 curated severe pairs as data in the script — the classically dangerous set: warfarin × {aspirin, ibuprofen, diclofenac, metronidazole, fluconazole}, methotrexate × {trimethoprim, ibuprofen}, sildenafil × nitrates (isosorbide, nitroglycerin), clarithromycin/erythromycin × {simvastatin, atorvastatin}, tramadol × {fluoxetine, sertraline}, MAOI (selegiline) × {fluoxetine, sertraline, tramadol}, potassium-sparing (spironolactone) × potassium chloride, ACE-inhibitor (enalapril, ramipril) × spironolactone, digoxin × {verapamil, amiodarone}, theophylline × ciprofloxacin, lithium × {ibuprofen, enalapril}. The script upserts the involved **salts** (moiety + class where load-bearing: NSAIDs, statins, SSRIs) and the pairs, each `source: 'seed-2026-08'`, `severity: 'severe'`, note text one clinical line each (written in the script; **the plan asked for a review against Q1's real vocabulary and Q1 returned ONE drug (`Paracetamol`), so there is nothing to review against** — the full curated set ships as written, and the deferral decision the sentence anticipated belongs to the DTC with pilot data, not to this session with n=1). Idempotent: re-run updates nothing that exists (match on canonical pair).
**Acceptance:** seed test runs the script twice against a scratch-scoped db (suite-managed), asserts count stability and one spot pair's canonical ordering + provenance.
**Commit:** `feat(core): severe-pair starter seed with provenance (16a T9)`

---

## 6. CLOSE — appended as the phase runs

*(Findings as they arrive · the independent reviewer's report · mechanical verification: detached `pnpm verify` exit value, per-commit `git show --stat` vs Files lists, frozen-path audit, clean tree · the actuals row: tokens / agents / wall clock / catches · lessons bound for the ledger · the one-line roadmap amendment · the 16b phase document is written after this section closes.)*

**Executed from 2026-08-26 on the build host, LIGHT lane, main session coding task by task.**

### Task ledger

| task | commit | verdict |
|---|---|---|
| kickoff — spike answered, §2 re-based, DD10 ruled | `be9134f` | four spike answers measured against production; two stale counters corrected; one plan defect caught before code |
| T1 — the five tables | `b1c9db8` **CI GREEN** (run 32949762683, 773s) | migration `0026_true_malcolm_colcord`; **12/12** in `formulary.test.ts`, isolated (`Test Suites: 1 passed, 1 total`); `pnpm verify` exit 0 before push (core 205/1758 → **206/1770**) |
| T2 — the module | _pending push_ | **12/12** in `masters.test.ts`, isolated; census **MEASURED 77 = 63 held + 14 not-yet-modelled**, exactly DD10's prediction; manifest census eleven → twelve; `pnpm verify` exit 0 (core **207/1782**, web 42, contracts 4/21) after two reds — F8 (real, fixed) and F9 (flake, measured) |
| T3 — resolution, exact | _pending push_ | **12/12** in `resolve.test.ts`, isolated; **fail-first quoted** (staged subset, semantic red); **four mutants built, four DIED** — M3 only on the shipped assertion, see F10 |
| T4 — the check suite | _pending push_ | **17/17** in `rx-checks.test.ts`, isolated, no database; **seven mutants built, SEVEN DIED**, all quoted |
| T5 — the pipeline | _pending push_ | **15/15** `prescriptions.test.ts` (7 shipped legs unmodified), **7/7** `opd.e2e.test.ts`; **three mutants built, THREE DIED** |
| T6 — the consult UI | _pending push_ | **12/12** `opd-consult.test.tsx` (10 shipped legs unmodified); picker, three-kind override dialog, soft-notice panel, coverage-gated hint |
| _appended as each lands_ | | |

### Findings

- **F1 — A TASK THAT DECLARES A PERMISSION MUST BE ALLOWED TO GRANT IT, AND T2 WAS NOT.** Recorded
  in full as DD10 above: the reachability invariant, the census pin (`74 declared = 60 held + 14 not
  yet modelled`) and the README's cell-for-cell parity all live in files T2's Files list did not
  name. **Found by reading `membership/manifest.ts`'s own header at kickoff**, which says the same
  thing about Plan 09 in as many words — the lesson was already written down, one phase earlier, by
  a session that had paid for it. What made it cheap this time is that it was read BEFORE the task
  ran rather than after a red suite; what makes it a finding anyway is that the plan-authoring pass
  had the same file available and did not check it. **The general form is §2.54's** (two copies of
  one fact drift by construction) **with a twist worth naming: here the second copy is a TEST, and
  a test that pins a census is a file every permission-declaring task must be allowed to edit.**
- **F2 — THE FORMULARY IS A CLOSED ISLAND IN THE FK GRAPH, AND THAT IS EXACTLY WHY IT NEEDED A
  `truncateAll` STATEMENT OF ITS OWN.** Ledger §3.35/§3.12 govern which truncate group a new table
  joins; both are about tables that point INTO an existing group. The formulary points nowhere
  outside itself and nothing points in, so it joins no group — and the tempting conclusion from
  that, that no change is needed, is wrong in the one direction that matters: `truncateAll` is a
  hand-maintained list, and a table absent from it is never emptied at all. A moiety left standing
  from one test is a moiety the next test's resolver finds. **The rule the ledger does not yet
  state: an island needs its own statement precisely BECAUSE no group's rule drags it in.**
- **F3 — the enum values the plan named in prose ship as CHECK constraints, and the reason is a
  failure direction rather than a house style.** `route_class`, `severity`, `route_scope`,
  `schedule_flag`, `status` and `kind` are closed sets in §5's own text. Stored unconstrained, a
  value outside the set is one every downstream reader — the check engine, the curation rollup,
  the admission screen — silently treats as *not systemic* / *not severe*: the safe-LOOKING
  direction, and the wrong one, because a severe pair that reads as not-severe raises no warning.
  The `counterparties_payee_class_ck` precedent (Plan 09) is the same decision made once already.
- **F5 — T2's OWN FUNCTION LIST NEEDED A SIXTH ERROR CODE, and the honest fix was to add it
  rather than to answer a misleading one.** §5 closes the union at five codes and, in the same
  paragraph, names `updateInteraction` among the six masters T2 ships. That function's "no such
  row" refusal has no code among the five. The two ways out were both worse than the third: answer
  `unknown_salt` when the salts are fine and the PAIR is missing (a curator would chase that for an
  hour), or leave the function out (it is named in the plan). `unknown_interaction` is added, in
  the file T2 owns, and the union's closure is otherwise untouched — **the closure rule binds LATER
  tasks, which is exactly why the task that owns the file has to get the list right.**
- **F6 — `requireUserActor` IS DELIBERATELY ABSENT, and the reason is that the alternative was to
  abuse an error code.** `opd/masters.ts` guards every writer with one and throws
  `user_actor_required`. Writing the same guard here meant either widening the union a second time
  or throwing something that does not mean it. It is left out because here it would be redundant
  rather than protective: every writer is reachable only through a route carrying
  `@RequirePermission("formulary.manage")`, **agents hold no permissions at all** until Plan 12a
  builds `agent_permissions`, and the module exports no other path. The commit that grants an agent
  `formulary.manage` is the commit where the guard belongs — and it is named in `masters.ts` so
  that reader finds it.
- **F7 — the census pins cost SIX edits in two files, and every one of them was load-bearing.**
  Adding three permissions moved: the per-module declaration map (`formulary: 3`), the catalog
  total (74 → 77), the role-model grant total (96 → 100) and distinct-permission count (54 → 57),
  two per-role counts (`doctor` 9 → 10, `pharmacy` 2 → 5), the reachability census (60 held → 63),
  the non-table pair set (50 → 54) with its README prose line, and **two separate execution legs
  in the V5 test that run `seed:roles` against a real database and pin the per-role granted counts
  twice — once for the first run and once for the idempotent second.** None of it is ceremony:
  that last pair is what proves the second run grants nothing, which is the property `seed:roles`
  exists to have. **DD10 predicted 77 = 63 + 14 and the measurement agreed exactly** — recorded
  because AGENT-RULES §4 says report the difference, and the honest report is that there was none.
- **F17 — THE COVERAGE HINT NEEDED THE SERVER TO SAY WHICH LINES ARE UNRESOLVED, or the browser
  would have grown a second normalizer.** T6's hint renders per line when the formulary does not
  know that line. The client could only decide that by normalizing drug names against a fetched
  medicine list — **a second `normalizeDrugName`, in a second language, drifting silently from the
  first** (§2.54, and F13's lesson one layer out). Instead `RxPrecheckResult` gains
  `unresolvedLineIndexes`, decided by the side that already knows. **Files-list amendment,
  disclosed:** T6 touches `modules/opd/prescriptions.ts` and its test, which its list does not name.
  It is also why the hint can be honest: a line the doctor typed exactly right resolves server-side
  and shows no hint, where a client-side guess would have flagged it.
- **F18 — `en.json` AND `hi.json` ARE NOT IN T6's FILES LIST, and every string this screen adds
  needs both.** Eleven new keys, in both locales, because the app ships Hindi as a first-class
  language rather than a fallback. A screen that added an English-only string would leave a Hindi
  user with a raw key on a SAFETY warning.
- **F19 — "AUTOCOMPLETE" SHIPPED AS A PICKER, and the difference is worth stating rather than
  glossing.** §5 T6 says *"a formulary autocomplete (existing picker pattern from the OPD
  doctor/department pickers)"* — the two halves of that sentence describe different controls. What
  ships is the picker half: a `<select>` beside the drug field listing active medicines, which
  fills the name and the id. Free typing in the drug field is untouched (design law 1). **The
  reason is the spec's own promise that the formulary stays "what-we-stock-sized"** — hundreds of
  rows, which a select renders fine. **The named upgrade, and its trigger:** when T8's coverage
  worklist shows the master outgrowing a selectable list, the control becomes a type-ahead over the
  same endpoint. Recorded so nobody reads the plan and assumes a type-ahead shipped.
- **F14 — A RE-ISSUE WOULD HAVE WARNED THE DOCTOR AGAINST THE PRESCRIPTION IT WAS REPLACING, and
  nothing in the plan mentions it.** T5 loads the patient's `active` prescriptions to check against.
  A re-issue supersedes its own previous version INSIDE the transaction — but that row is still
  `active` while the pre-transaction reads run. So correcting a typo on a two-line prescription
  would have told the doctor the patient is already taking both drugs, and a severe pair would have
  REFUSED the correction outright, against itself. `runRxChecks` takes `excludeEncounterId` and the
  issue path passes the encounter it is writing to. **It is a shipped test of its own** — *"a
  re-issue is not checked against the version it supersedes"* — because the failure would look
  exactly like the feature working.
- **F15 — THE PLAN'S T5 FILES LIST NAMES THE WRONG CONTROLLER, AND UNDERSTATES WHAT THE OTHER ONE
  NEEDED.** It says to modify `opd-visits.controller.ts`; the prescription routes have always lived
  in `opd-queue.controller.ts` (`POST visits/:id/prescriptions` is declared there), and there is no
  `opd-visits.controller.ts` in the tree at all. And it says `opd-masters.controller.ts` changes
  *"for its error-code union comment only"* — but that file owns `OPD_CONFLICT_CODES`, the set
  `opdStatus` reads, and without `interaction_conflict` in it a clinical refusal answers **400
  instead of 409**: a client that must render an override dialog receives something shaped like a
  malformed request. That is Plan 09's counter-side 500 one step milder, and the e2e now pins the
  status as well as the code. *(`duplicate_salt_conflict` would have reached 409 anyway through the
  `startsWith("duplicate_")` rule — which is worth knowing precisely because it means one of the
  two would have been right by accident and the other wrong.)*
- **F16 — `matchAllergies` IS NOW A FOUR-LINE WRAPPER, so the substring layer exists ONCE.** T4's
  engine had to re-implement the shipped bidirectional substring match to add the short-string
  guard, which would have left two copies of one rule — §2.54 in the safety path. The shipped
  export keeps its name and signature (its callers and its tests are untouched) and delegates to
  `matchAllergiesSaltAware` with null resolutions. **The three shipped assertions survive the new
  guard unchanged and were checked before the change, not after:** `"sulfa"` × `"Sulfamethoxazole"`
  and `"Penicillin G"` × `"penicillin"` are both ≥ 4 characters on both sides, and the negative
  case shares no substring in either direction. Had any of them used a short token, the guard would
  have been the wrong shape rather than the tests being wrong.
- **F13 — I INVENTED A FILE TO SOLVE A PROBLEM THE ARCHITECTURE ALREADY SOLVES, AND A LINT RULE
  SAID SO.** `rx-checks.ts` is a pure core and needs the formulary's normalizer for its class path.
  Reasoning from the purity test alone, I extracted `formulary/normalize.ts` — a file importing
  nothing — so the pure module could take the function without dragging `kernel/db` in
  transitively. `pnpm lint` refused it: **"Modules may only import another module's index.ts (its
  declared interface). Cross-module internals are forbidden (spec §4)"**, three errors, one of them
  on the file I had just created for the purpose.
  **The rule is right and my reasoning had a false premise.** The premise was that importing
  `../formulary` would pull a database connection into a pure module. It does not:
  `kernel/db/client.ts` reads no environment at module load and opens no pool until `createDb` is
  CALLED, so the index import loads drizzle table *definitions* and nothing else — the suite still
  needs no database and still runs in milliseconds, which was the property `purity.test.ts` exists
  to protect. So the normalizer goes back into `resolve.ts`, is published through `index.ts`, and
  `rx-checks.ts` consumes the module's declared interface exactly as DD1 says it should.
  **The lesson is not "obey the linter":** it is that a structural rule encodes a decision somebody
  already made, and an extraction invented to route around one deserves the question *what does
  this rule know that I don't* before the file is written. Cost: one file created and deleted, and
  a lint cycle. *(`purity.test.ts` would NOT have caught the mistake in either direction — it greps
  for `from "../../kernel` and neither import matches. The architectural lint did.)*
- **F12 — FAIL-FIRST WAS NOT CAPTURED FOR T4, AND THE RULES DO NOT LET ME RECONSTRUCT ONE.**
  T3's red was staged honestly (a signature-only subset, semantic failure, quoted). T4's
  implementation was written before its suite, and by the time that was noticed the shipped file
  existed. AGENT-RULES §2.4 forbids the obvious repair in as many words — *"never manufacture a red
  by mutating shipped state: no throwaway databases, no relocating or deleting source files"* — and
  the §2.4 fallback needs a prior attempt's commit SHA, which does not exist. **So it is disclosed
  rather than fabricated.** What DOES exist for every assertion that matters is stronger than a
  stub red and was obtained without touching the shipped file: seven mutants, seven separate scratch
  implementations, each run isolated, each producing a genuine red of the shipped assertion with
  expected-vs-received quoted. The gap is real and narrow: nothing proves the suite could fail
  *before the code existed*, and the mutants prove it fails against seven specific wrong
  implementations after.
- **F11 — THE PLAN'S T4 SEMANTICS NAME A FIELD ITS OWN T3 TYPE DOES NOT CARRY, and the right
  answer was to change neither.** §5's allergy semantics say matching runs against each line-salt's
  `moiety`/`aliases`/`drugClass`; the `SaltRef` type pinned three sections earlier is
  `{ saltId, moiety, drugClass }` — no aliases. Tracing the cases shows the alias path is
  REDUNDANT rather than missing: an allergy recorded under an alias (`"amoxycillin"`) already
  resolves to its moiety through `resolveDrugTexts`, so by the time the matcher runs, aliases have
  been discharged into moiety ids. And the case that actually bites — an UNRESOLVED line — carries
  no salts at all, so alias data on the line side could not help it either; that case is the legacy
  substring layer's, which is why the layer survives. **Widening a pinned type to add work the
  resolution layer already does would have looked like thoroughness and bought nothing.**
- **F10 — THE PLAN'S NAMED DISCRIMINATING INPUT FOR MUTANT A3 DOES NOT DISCRIMINATE, AND ONLY
  BUILDING IT SHOWED THAT.** §5's Assertion Book says: *mutant: matching by `includes()` after
  normalization · input: `"Augmentn"` (typo) → expected `null`; mutant → resolves.* Built and run:
  **the mutant PASSED that input.** `"Augmentn"` is a DELETION typo, and no substring relation holds
  in either direction between `augmentn` and `augmentin 625` — a fuzzy-by-`includes()`
  implementation is exactly as blind to it as the exact one. The hand-walk predicted a kill and was
  wrong in the dangerous direction: *the mutant appeared to survive a correct implementation*.
  **AGENT-RULES §3 branch (b): the shipped code is right and the PLAN'S row could not discriminate.**
  The fix was already in the shipped test, which asserts `null` over five texts rather than one —
  three of them (`"Augmentin"`, `"amox"`, `"625"`) ARE genuine substring relations, and the mutant
  dies on the first: `"text": "Augmentin"`, expected `drug: null`, received a fully resolved object.
  The scratch spec was left carrying BOTH legs so the record shows the non-discriminating input
  beside the discriminating one.
  **This is rule 21's entire thesis, met head-on:** *"a hand-walk of 'a wrong implementation would
  produce X' is a prediction, not evidence, and it has been wrong in BOTH directions in the same
  plan."* Here it was wrong at plan-authoring time, in a row whose whole job was to make DD2
  executable — and a phase that trusted the row instead of running it would have shipped the law
  with a test that proves it against one input a fuzzy matcher also passes.
- **F9 — `billing/series.test.ts`'s race leg FLAKED ONCE UNDER FULL-SUITE LOAD, and the honest
  report includes the hypothesis I could not fully exclude.** The leg runs **ten rounds of six
  concurrent `nextDocNo` transactions** against a 15-second per-test budget and threw
  `Exceeded timeout of 15000 ms`. Measured before concluding anything (rule 20: nothing else was
  running, command lines read rather than counted):
  · **isolated, three consecutive runs — 7/7 passing every time**, ~17 s per suite;
  · **the same tree had already passed the full suite twice** — T1's verify (core 206/1770) and
  T2's first verify, whose only failure was F8's;
  · **the third full run after F8's fix: 207/1782, exit 0, no failures at all.**
  So: three passes, one failure, identical machinery — load-dependent, not a regression.
  **The hypothesis kept on the record rather than argued away:** T1 added a statement to
  `truncateAll` (F2), and THIS test calls `truncateAll` INSIDE its loop, so the change costs ten
  extra round-trips in exactly the test that failed. The arithmetic is against it — five empty
  tables over a local socket is single-digit milliseconds against a 15 000 ms budget — but the cost
  is real and it landed on shared machinery, so it is written down where the next person to see
  this test flake will find it. **What is NOT claimed: that the flake is unrelated to this phase.**
  It is claimed to be load-dependent, on four measurements.
- **F8 — A COMMENT THAT QUOTES A DECORATOR IS A DECORATOR, AS FAR AS A SOURCE-SCANNING TEST CAN
  TELL — AND THE FIX FOR IT FAILED THE SAME WAY.** `test/roles-catalog.e2e.test.ts` walks every
  non-test `.ts` file under `src`, matches the permission decorator's opening token, and requires a
  scope literal in each match; its own docstring says *"the regex sees what a reviewer sees"*. A
  reviewer distinguishes code from prose and the regex does not. `masters.ts`'s F6 comment
  explained the absent actor-guard by quoting the decorator with a permission and no scope, and the
  full suite went red on a file with no route in it at all. **The second failure is the one worth
  recording:** the fix was a comment explaining the trap — which quoted the same token again, and
  failed identically. Only naming the decorator without its parentheses cleared it.
  **The general form: a test that greps source for a code pattern must expect that pattern in
  prose, and the cheapest place to absorb that is the test, not every future comment.** This phase
  paid twice rather than change a shipped test it does not own; the ledger entry is what should
  stop the third time. *(Cost: one full `pnpm verify` cycle. Caught by verify before the push,
  which is §2.87 doing exactly the job it was written for.)*
- **F4 — the ordered-pair CHECK is the constraint this schema exists for, and it is tested by the
  reversed insert rather than by reading the DDL.** A×B and B×A are one clinical fact; stored
  unordered, how many hits a prescription raises depends on which order a curator typed. The
  suite's leg inserts the reversed row and quotes the refusal (`formulary_interactions_ordered_ck`),
  which is what makes T2's `addInteraction` normalization CHECKABLE rather than trusted.
