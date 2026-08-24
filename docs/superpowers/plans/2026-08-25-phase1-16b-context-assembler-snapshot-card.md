# Plan 16b — Context Assembler & Snapshot Card (clinical copilot Phase A, part 2)

**Written 2026-08-25, ahead of 16a execution, by owner instruction. Status: PROVISIONAL — this document is re-based against Plan 16a's CLOSE before approval; §0 names every seam that may move. Not approved for execution; does not start before 16a closes.**
**Spec:** [`../specs/2026-08-25-clinical-copilot-design.md`](../specs/2026-08-25-clinical-copilot-design.md) — this plan implements its §2.1 (Context Assembler + snapshot card), §3.2's seam-12 enum preference surface, §4.1's Phase A acceptance invariants, and starts the L1 DPIA drafting §4.1 requires. The plan argues from the spec and does not restate it.
**Not in this phase, by design:** tokenizer, in-text scrubber, typed claims, any inference request, Honcho — the inference rim is Phase B (spec §2.2–§2.6), behind its own ordered gates.

**Executor seed (v3 §1):** read this document, 16a's CLOSE, [`AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 — then execute, on the build host, task by task.

---

## 0. Re-base seams — the alteration contract this document was written under

The owner ordered this plan written before 16a runs. Honest consequence: seven facts below are *assumptions about 16a's outcome*, each re-verified against 16a's CLOSE at kickoff. A drift rewrites the seam, not the phase.

1. **Manifest census: ten → eleven.** Assumes 16a T2 landed the formulary manifest as written. The number is re-read from `manifests.test.ts` at kickoff, not trusted from here.
2. **`rx-checks` exported shapes** (`RxCheckLine`, `InteractionHit`, `DuplicateHit`, `isCurrent`, and 16a T3's `ResolvedDrug`) — T3 here consumes them verbatim. If 16a's reviewer or execution changed a shape, T3's signatures follow it; the semantics (one engine, two call sites) do not move.
3. **Prior-rx loading:** 16a T5 lands its prior-prescription query inline in `prescriptions.ts`. T3 here **extracts** it as `loadCurrentPriorRx(db, patientId, now)` in `apps/core/src/modules/opd/` and repoints the issue path to it — unless 16a already extracted it, in which case T3 consumes it and the extraction step vanishes.
4. **Migration number 0012** assumes 16a generated 0011. Read the head at kickoff (AGENT-RULES §6).
5. **16a spike answers steer copy and fixtures:** Q2 (durationDays fill rate) sets how loud the `assumedCurrent` labeling will actually be in production — if most lines lack duration, the label is the common case and T5's copy review happens with that fact on the table; Q1's vocabulary makes T3's fixtures real drugs, not invented ones.
6. **16a's independent-reviewer findings on the check engine** fold into T3's acceptance before this plan is approved.
7. **The NKDA owner decision** (spec §2.1 flagged adjacent improvement) is asked at this phase's kickoff, not silently resolved: if accepted, a small task T8 is appended at re-base (patients module: an explicit "no known drug allergies — confirmed" record + `allergy.nkda_confirmed` event + the card's strongest line "allergies: confirmed none, asked ⟨date⟩"); if declined, the card ships "no allergies recorded" wording permanently and the flag closes.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Seven tasks, one small module (a read-composition surface — no money, no locking, no workflow), one screen component, one docs task. The main session codes task by task under AGENT-RULES, builds the mutants for the inline CRITICAL rows (T2/T3/T6 — permission filtering, the one-engine invariant, and the reorder-never-redact law are the seams that earn them), watches CI with [`pipelines/ci-watch-host.sh`](../pipelines/ci-watch-host.sh), and closes with one independent reviewer.

**Stop-loss (v3 §6):** 1.5× Plan 16a's actual, read from 16a's CLOSE at kickoff. If unwritten, **2.5M tokens** (the standing LIGHT fallback).

---

## 1. Why this phase

The spec's §2.1 insight: briefing is 90% assembly, 10% narration — and assembly is deterministic. This phase ships the 90%: a snapshot card in `opd-consult` that answers "brief me on this patient" from spine read models, instantly, with no inference request in existence. The owner's original ask — *the copilot reads past prescriptions, allergies, reports, and cross-verifies* — is served today by T3's move: the patient's **current medications are run through 16a's own check engine against each other**, so interactions and duplicates *among what the patient is already taking* surface on the card without one new line of check logic. One engine, two call sites, by construction.

The second reason is the one that cannot be retrofitted: **Phase A acceptance carries the assembler invariants** (spec §4.1 trap 3). If the card were built ad-hoc — a hand-rolled fetch per section, blanks where helpers fail — Phase B would inherit a permission bypass and a silent-omission habit in the exact component that later feeds an LLM payload. Building the allowlist, the four-state render, and the one-sheet-per-caller invariant NOW, while the consumer is a mere card, is what makes the Class-1 lane safe to open later. The enum preference surface (T6) is the same argument applied to §3: Honcho must plug into an existing, equality-tested socket, never bring its own machinery.

Third: the L1 DPIA draft starts here (T7) because the Lens is the platform's first-ever Class-1 activation and external DPDP review has lead time (spec §4.1 trap 4). The pack allowlist T1 defines **is** the payload basis the re-identification analysis needs — writing the two together keeps the fact in one place.

---

## 2. Ground truth (measured 2026-08-25, this repo)

- **Realtime:** a websocket gateway with permission-guarded topic spaces; OPD declares `queue`/`display`/`encounter` spaces (`modules/opd/realtime.ts:4`, `encounter:<encounterId>` under `opd.visits.read`); the web side is one socket per tab, reference-counted topics, `useRealtime(topics, handler)` (`apps/web/src/lib/realtime.ts`). `opd-consult.tsx:38` states the house pattern: *"Reads are BOTH polled (15 s) AND realtime-subscribed (D6): a push is a hint."* Allergy events (`allergy.recorded`, a patients-module event) are **not** on the OPD tail (`OPD_REALTIME_NAMES` lists ten OPD names only) — so a mid-consult allergy reaches the card via the 15 s poll, within the D6 contract.
- **Patients read helpers:** `getPatientSummaries(db, actor, ids)` (actor-aware; restricted/alias rules applied inside it) and `listAllergies(db, patientId)` — both exported from `modules/patients/index.ts`; the OPD module already consumes them across the boundary (the precedent this module copies).
- **Vitals:** `opd_vitals` ordered by `recordedAt`; the print path takes the LATEST row with the D4 note "a danger flag never auto-clears" — the card's vitals section carries the same rule.
- **From 16a (as planned; §0 re-bases):** `resolveDrugTexts`/`resolveMedicines`/`ResolvedDrug` (T3), `rx-checks.ts` pure functions (T4), prior-rx loading inline in `prescriptions.ts` (T5), manifest census ten.

## 3. Spike — answered at kickoff, on the host

Write the measured answers in place here before T1 starts.

- **Q1 — history section cost:** `EXPLAIN ANALYZE` the encounter-history read for the heaviest patient in production (most encounters). Decides the section's default window (plan default: last 10 encounters) and whether it needs an index this phase.
- **Q2 — assembly wall time:** time the full five-section read fan-out against production-size data. The card must render instantly (spec design law 9's spirit); the answer decides `Promise.all` fan-out vs sequential reads, and is recorded as the baseline the CLOSE compares against.
- **Q3 — the in-process permission helper:** name the exact exported function the PermissionGuard uses to evaluate a permission for an actor (read `kernel/auth`), so T2 calls the same evaluation in-process — never a parallel re-implementation. (A name lookup, minutes; recorded here so T2 cites it exactly.)
- **Q4 — seam verification:** diff-read 16a's CLOSE against §0's seven assumptions; record each as HOLDS or MOVED-with-consequence.
- **Q5 — the NKDA question to the owner** (§0 seam 7): accepted → T8 appended; declined → flag closed. An owner decision recorded in one line, not SQL.

## 4. Design decisions (what this plan rules beyond the spec)

- **DD1 — a `briefing` module, the eleventh manifest.** Not in OPD (the assembler is cross-setting by design — OT/ICU/IPD packs arrive with their modules) and not in the kernel (it *composes* modules' read helpers; the kernel owns generic seams, not composition). No menu entry (the card lives inside consult; no standalone screen), no permissions of its own on the manifest — access is governed by DD2's pack permissions.
- **DD2 — the pack is a versioned code artifact, and it carries both permission layers.** `OPD_CONSULT_PACK` (in `modules/briefing/pack.ts`): `{ key: "opd-consult", version: "opd-consult/1", routePermission: "opd.consult", sections: [{ key, permission, pinned }...], enumSlots: { verbosity: ["standard","compact"], format: ["narrative","bullets"] } }`. `routePermission` gates the endpoint; each section's `permission` drives the four-state filter; each section also declares `fields: string[]` — the source-record fields its builder may render (spec §2.1's allowlist is field-level, and T7's DPIA pointer needs it to be). No DB representation of packs — the contract is provisional until a second pack exists (spec §2.3), and code-with-a-version-string satisfies "versioned artifact" with the least machinery. Sections, in pinned-first order: `alerts` (pinned, `opd.consult`), `allergies` (pinned, `opd.consult`), `medications` (`opd.visits.read`), `vitals` (`opd.visits.read`), `demographics` (`opd.visits.read`; restricted rules apply inside the patients helper; **locality, occupation, and kin fields are absent from the declaration** — spec §2.2's quasi-identifier exclusion, enforced from Phase A), `encounters` (`opd.visits.read`).
- **DD3 — four-state totality is structural.** `FactSheet = { pack: { key; version }; asOf: Date; sections: Record<SectionKey, FactSection> }` where `FactSection = { state: "content" | "none" | "unavailable" | "forbidden"; lines: FactLine[] }` (`lines` non-empty only for `content`), `FactLine = { lineId: string; kind: string; text: string; detail: unknown; provenance: { recordId?: string; eventName?: string } }`. Every pack section key is present in `sections` — a missing key cannot typecheck, and T2's test asserts it at runtime anyway (design law 6: blank is not a state).
- **DD4 — medication review is the same engine on the current actives.** The patient's current prior lines (16a's currency semantics) are fed to `checkInteractions`/`checkDuplicateSalt` **as the `lines` argument with `priors: []`** — the in-rx pairwise path then yields interactions and duplicates *among current medications*, zero new check code. Active-allergy conflicts of current medications surface via `matchAllergiesSaltAware` the same way. One engine, two call sites, behaviorally tested (T3).
- **DD5 — freshness is the D6 pattern, no new topic space.** The card refetches on `encounter:<encounterId>` frames and rides the consult screen's existing 15 s poll; "as of HH:MM" is stamped from assembly time. An allergy recorded mid-consult reaches the card within ≤15 s — within the spec's intent (issue-time checks remain the hard guarantee, per §1.3). A `patient:<id>` topic space joins the tail when a second surface needs it, not before.
- **DD6 — preferences are spine config, enum-bounded, pinned-immune.** `briefing_preferences` (userId PK, `verbosity`, `format`, `sectionOrder` — an ordering of NON-pinned section keys). PUT validates every value against the pack's `enumSlots` (out-of-enum → 400; the enum-only law's write gate, spec §3.1). The card applies preferences to non-pinned sections only; a "view options" control with reset persists them. The impressions chip arrives with Honcho — this phase builds the socket it will feed (seam 12).
- **DD7 — the reorder-never-redact law becomes one CI test.** T6 renders the fact sheet through **every** enum combination × sectionOrder permutation of the fixture and asserts (a) the set of `lineId`s per section is identical across all combinations, (b) pinned sections render first in all of them. Spec §3.1's "finite and testable" promise, cashed.
- **DD8 — the DPIA draft cites the pack, never copies it.** T7 adds the L1 skeleton to the existing DPIA file, naming `OPD_CONSULT_PACK`'s section/field list *by pointer* as the payload basis (the fact rule — the allowlist lives in code, the DPIA references it), with [COUNSEL] markers for re-identification analysis, provider processing locations, and DPDP §16 — plus spec §4.5's items 4 (patient notice) and 5 (briefing retention) entering the counsel queue.

## 5. Tasks

Tiers per AGENT-RULES §3; CRITICAL rows inline (assertion · mutant · discriminating input); finish block per task; commit messages exact.

---

### T1 — Briefing module skeleton: pack contract + fact-sheet types — **ROUTINE**

**Files:** Create `apps/core/src/modules/briefing/{index.ts, manifest.ts, pack.ts, pack.test.ts, types.ts, errors.ts, briefing.module.ts}`; Modify `apps/core/src/kernel/modules/manifests.ts` (+ census test: **ten → eleven**, re-read per §0.1) and `apps/core/src/app.module.ts`.

**Produces:** DD2's `OPD_CONSULT_PACK` and `BriefingPack` type; DD3's `FactSheet`/`FactSection`/`FactLine`/`SectionKey` types; `BriefingError` codes `"unknown_pack" | "unknown_patient" | "invalid_preference"`; manifest `{ key: "briefing", title: "Briefing — fact sheets for the point of care", menu: [], permissions: [], search: [], subscriptions: [] }`.
**Acceptance:** pack test pins: pinned sections are exactly `alerts` + `allergies` and come first in declaration order; every section carries a permission; enum slots carry the two DD2 domains. Census test at eleven and green.
**Commit:** `feat(core): the briefing module — pack contract and fact-sheet types (16b T1)`

---

### T2 — The assembler: four states, per-section permissions, one path — **CRITICAL**

**Files:** Create `apps/core/src/modules/briefing/{assemble.ts, assemble.test.ts}`; Modify `apps/core/src/modules/briefing/index.ts` (export).

**Produces:** `assembleFactSheet(db: Db, actor: Actor, patientId: string, pack: BriefingPack): Promise<FactSheet>`. Per section: evaluate the section's permission for the actor via the guard's own helper (Q3's name — the same evaluation, in-process, never a re-implementation) → `forbidden`; else run the section builder in try/catch → thrown = `unavailable`, empty = `none`, rows = `content` with `FactLine`s carrying provenance. Builders: `alerts` (T3's `hits` rendered as `FactLine`s, severity in `kind`), `demographics` (via `getPatientSummaries` — restricted/alias rules stay inside the patients helper), `allergies` (`listAllergies`, active only; empty → `none` — the card's copy owns the "recorded" honesty), `medications` (T3's `lines`), `vitals` (latest row + all danger-flagged rows — D4: a danger flag never auto-clears), `encounters` (last 10 per Q1). Every builder renders only its section's declared `fields` (DD2). `asOf` stamped once per sheet. Unknown patient → `unknown_patient`.

**Assertion Book:**
- *Forbidden, not filtered-silent* · mutant: permission evaluation dropped (all sections build) · input: actor holding `opd.consult` but NOT `opd.visits.read` → expected `medications.state === "forbidden"` (and `alerts`/`allergies` content); mutant → content everywhere.
- *Unavailable ≠ none* · mutant: builder catch maps a throw to `none` · input: a builder forced to throw via a fixture patient whose encounter rows violate the builder's read (test injects a failing db wrapper for one section) → expected `"unavailable"`; mutant → `"none"`. This row is design law 6's sharpest edge — absence must never impersonate emptiness.
- *Totality* · mutant: forbidden sections omitted from the record instead of keyed · input: the same reduced-permission actor → expected every pack section key present in `sections`; mutant → key missing.
- *Restricted patient* · assertion (fixture, no new mutant): a restricted patient's demographics section carries the alias-rule output the patients helper returns — the test pins that `assembleFactSheet` adds no name field of its own anywhere in the sheet for that fixture.

**Acceptance:** mutants DIED with quoted expected-vs-received; fail-first quoted; every builder covered by at least one `content` and one `none`/`unavailable` case; plus the exclusion test — a fixture patient carrying locality/occupation/kin values renders a full sheet whose **serialized form contains none of those fixture values** (the DD2 exclusion made executable).
**Commit:** `feat(core): the fact-sheet assembler — four states, per-section permissions (16b T2)`

---

### T3 — Medication review: the one engine's second call site — **CRITICAL**

**Files:** Create `apps/core/src/modules/briefing/{medication-review.ts, medication-review.test.ts}`; Modify `apps/core/src/modules/opd/prescriptions.ts` (extract `loadCurrentPriorRx(db, patientId, now)` per §0.3 and repoint the issue path — or consume it if 16a already extracted) + its test imports.

**Produces:** `buildMedicationReview(db: Db, patientId: string, now: Date): Promise<{ lines: FactLine[]; hits: (InteractionHit | DuplicateHit | AllergyMatch)[] }>` — loads current actives via `loadCurrentPriorRx`, resolves them live (16a DD4), runs `checkInteractions(activeLines, [], pairs, now)` + `checkDuplicateSalt(activeLines, [], now)` + `matchAllergiesSaltAware` against active allergies (DD4 here). Every medication `FactLine` carries its prescription id + issue date in provenance and the `assumedCurrent` label where 16a's `isCurrent` said so.

**Assertion Book:**
- *Stale lines are out* · mutant: currency filter dropped from the actives load · input: a 5-day antibiotic issued 10 days ago beside current warfarin + aspirin fixture → expected hits exclude any pair involving the antibiotic; mutant → includes it.
- *Behavioral equivalence with the issue path (the one-engine law)* · assertion, no mutant — the law is equivalence itself: the same fixture lines submitted through 16a T5's `rx-precheck` (as draft lines, empty priors) and through `buildMedicationReview` yield the **identical hit set** (same pairs, same severities), asserted field-by-field. If this test ever needs a tolerance, that is a CHAIN-HALT finding, not a fixture fix.
- *Allergy facts carry provenance* · mutant: allergy conflict rows emitted without prescription provenance · input: active amoxicillin + active penicillin-class allergy → expected the hit's FactLine cites the prescription id; mutant → empty provenance.

**Acceptance:** mutants DIED with quotes; the repointed `prescriptions.test.ts` suite green with zero deleted tests; the extraction commit-diff touches only the named files.
**Commit:** `feat(core): medication review on the one check engine (16b T3)`

---

### T4 — The endpoint — **ROUTINE**

**Files:** Create `apps/core/src/modules/briefing/briefing.controller.ts`; Modify `briefing.module.ts`, `apps/core/test/` (new `briefing.e2e.test.ts`).

**Produces:** `GET /briefing/:packKey/:patientId` — resolves the pack by key (`unknown_pack` → 404), guarded by the pack's `routePermission` (DD2) via the standard PermissionGuard, returns the `FactSheet` json. No other routes this phase (preferences ride T6).
**Acceptance:** e2e: 403 without `opd.consult`; 404 for an unknown pack key; a full sheet for a seeded patient with the four states exercised (one section forbidden via a reduced-permission user fixture).
**Commit:** `feat(core): briefing endpoint under the pack's route permission (16b T4)`

---

### T5 — The snapshot card — **ROUTINE**

**Files:** Create `apps/web/src/components/patient-snapshot.tsx`, `patient-snapshot.test.tsx`, `apps/web/src/lib/briefing-api.ts`; Modify `apps/web/src/screens/opd-consult.tsx` (+ its test).

**Changes:** the card renders the sheet pinned-first, each of the four states visually distinct — `content` rows; `none` as quiet copy (allergies: **"no allergies recorded"** — never "no allergies"); `unavailable` as an unmissable "UNAVAILABLE — could not load" band; `forbidden` as "not visible to your role". Header carries "as of HH:MM" and the standing line **"in-system records only"** (design law 10). Medication rows show the `assumedCurrent` label ("prescribed N days ago — may no longer be current") and review hits render inside the pinned `alerts` section with the pair note + provenance date. Refresh per DD5: refetch on `encounter:<id>` frames (`useRealtime`) + the screen's existing 15 s poll. Mounted in `opd-consult` above the rx form.
**Acceptance:** component tests: all four states render distinctly (test-ids per the screen's convention); pinned sections first regardless of response order; the three honesty strings asserted verbatim; a frame triggers refetch (the existing realtime test pattern).
**Commit:** `feat(web): the patient snapshot card — four states, pinned-first, honest copy (16b T5)`

---

### T6 — The preference surface and the equality law — **CRITICAL**

**Files:** Create `apps/core/src/kernel/db/schema/briefing.ts` (+ `briefing.test.ts` census sibling; migration `0012` per §0.4), `apps/core/src/modules/briefing/{preferences.ts, preferences.test.ts}`; Modify `briefing.controller.ts` (GET/PUT `/briefing/preferences`), `patient-snapshot.tsx` (+ test), `briefing-api.ts`.

**Produces:** `briefingPreferences` table (`userId` PK · `verbosity` · `format` · `sectionOrder` jsonb `string[]` · audit columns); `getPreferences(db, userId)` (absent row → pack defaults); `putPreferences(tx, actor, input)` — validates each value against the pack's `enumSlots` and `sectionOrder` against the pack's **non-pinned** keys (unknown value or a pinned key in the order → `invalid_preference` → 400). The card applies: `sectionOrder` permutes non-pinned sections; `verbosity: "compact"` collapses each line to its primary text (never removes a line); `format` switches narrative/bullet presentation of the same lines. A "view options" control persists via PUT, with reset-to-defaults.

**Assertion Book:**
- *The equality law (DD7)* · mutant: `verbosity: "compact"` filters medication lines older than 90 days out of the render · input: the fixture sheet rendered through ALL enum combinations × all sectionOrder permutations of three non-pinned sections → expected: identical `lineId` set per section in every combination; mutant → one combination missing a line, the loop's set-equality assertion quotes which.
- *Pinned immunity* · mutant: `sectionOrder` applied to the full section list · input: an order listing `medications` first → expected `alerts`, `allergies` still render before it in every combination; mutant → medications first.
- *The write gate* · mutant: enum validation dropped in `putPreferences` · input: `verbosity: "minimal"` (not in the slot) → expected 400 `invalid_preference`; mutant → 200 and a stored out-of-enum value.

**Acceptance:** mutants DIED with quotes; migration `0012` carried in the same commit as its schema (AGENT-RULES §6); preferences absent → defaults (tested); the combination loop's combination count is asserted (so a future slot addition consciously grows the test, never silently shrinks it).
**Commit:** `feat(core+web): explicit briefing preferences — enums only, pinned immune, equality-tested (16b T6)`

---

### T7 — DPIA v0.3 draft: the L1 skeleton, grounded in the pack — **ROUTINE**

**Files:** Modify `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md`.

**Changes (DD8):** version line → `0.3 DRAFT`; §3's L1 bullet expands into a subsection: payload basis = the `OPD_CONSULT_PACK` section/field allowlist **by pointer** (module path + version string, never a copied field list); skeleton headings with [COUNSEL] markers — re-identification risk over tokenized clinical payloads, candidate provider processing locations, DPDP §16 transfer analysis, DPA no-training terms; a line recording that the router remains excluded (Class-0-only, §3's standing finding). §6/§7 counsel queue gains two items by pointer to spec §4.5: patient notice (item 4) and briefing-output retention (item 5). Nothing is marked resolved — this is a draft for the external DPDP specialist, and the sign-off table gains a `v0.3` row with the date.
**Acceptance:** the diff touches only this file; every new claim carries either a pointer or a [COUNSEL] marker (no silently-asserted legal positions); the fact rule holds — zero copied field lists, zero restated spec text.
**Commit:** `docs(compliance): DPIA v0.3 draft — L1 skeleton grounded in the briefing pack allowlist (16b T7)`

---

## 6. CLOSE — appended as the phase runs

*(§0 seam verdicts (Q4) recorded first · findings as they arrive · the independent reviewer's report · mechanical verification: detached `pnpm verify` exit value, per-commit `git show --stat` vs Files lists, frozen-path audit, clean tree · the actuals row: tokens / agents / wall clock / catches vs Q2's baseline · lessons bound for the ledger · this phase's one-line roadmap amendment · Phase A of the clinical copilot closes with this section — Phase B's gates (spec §2.6) open only from here.)*
