# Plan 13 — Resource Registry (kernel), and the OPD rooms move

**Written 2026-08-26 on the build host; amended the same evening after a second brainstorm (the amendments are marked *AMENDED* in place — DD4, DD12, T1, T6, T7, § 4A). NOT APPROVED FOR EXECUTION — this document is the whole of what that session produced; execution is a separate session with its own approval.**

**Roadmap:** [`2026-08-11-phase1-plan-series.md`](2026-08-11-phase1-plan-series.md) § *Plan 13* (sequencing RULED 2026-08-25: immediately after 09, hard gate before the IPD cluster) and § *Stage-2 acceleration*. **Spec:** [`../specs/2026-08-10-hmis-architecture-design.md`](../specs/2026-08-10-hmis-architecture-design.md) §11.18 (the ward-room model and its v4.6 sentence naming this registry), §11.2 (bed board, class-drives-tariff), §11.19-A (service-line floors), §11.16-A (the mini-OT's registry contributions), §4 (module framework). **This plan argues from those and does not restate them.**

**Slot:** Plan 16a closed 2026-08-26; Plan 09 and Plan 09a are both closed on clean reviews. Nothing in the partner lane blocks this phase. Two owner rulings still gate `RECEIVABLE_COMMISSION_ENABLED` and `COMMISSION_ACCRUAL_ENABLED` (09a open items 1 and 3) — **neither is Plan 13's to answer and neither blocks it.**

**Executor seed (v3 §1):** read this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 — then execute, on the build host, task by task. **Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: it is 354,071 bytes ≈ 88k tokens and it is re-billed on every tool call (v3 §9.1).** The entries that bear on this phase are cited by number where they bite: §2.54, §2.93, §2.101, §2.102, §3.12/§3.35.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Seven tasks. The ruling sentence, honestly: this is a two-table kernel subsystem plus pure functions plus three read routes — no money arithmetic, no new locking, no workflow definitions, no screen — and it is smaller than 16a (nine tasks, LIGHT) and than 11h (nine tasks, LIGHT). **What makes it not a pure kernel-table phase is the second half: a destructive data migration against a LIVE production database** (owner ruling Q2, 2026-08-26 — the OPD rooms move NOW). That does not change the lane, because **v3 §2 is explicit that the lane sets who codes and how work is dispatched and does NOT set verification depth.** It changes the tiering: four of the seven tasks are CRITICAL and carry executed mutants, and the migration is split across three commits so the irreversible step lands alone (DD12).

**The main session codes task by task** under AGENT-RULES in full, builds every mutant the inline Assertion Books name, watches CI with [`../pipelines/ci-watch-host.sh`](../pipelines/ci-watch-host.sh) by full SHA, and closes with one independent reviewer.

### Stop-loss (v3 §6): **660,000 tokens**, and the arithmetic is shown because §2.95 exists

`stop-loss = 1.5 × (per-task rate × task count) + one full reviewer pass per remediation cycle`

- **Per-task rate — 20,178**, from Plan 16a: LIGHT, 9 tasks, **181,605** subagent tokens ([`../pipelines/token-baselines.json`](../pipelines/token-baselines.json)). It is the most recent LIGHT phase and the closest in shape (a new table family, its consumers, and its tests).
- **Task term:** `1.5 × (20,178 × 7) = 211,869`.
- **Review term — TWO passes, not the default one: `181,605 + 268,625 = 450,230`.** One fresh pass at 16a's measured rate, plus one **resumed** pass at 09a's measured pass-2 rate, because **v3 §9.5 is explicit that a resumed agent starts full** — 09a's second pass cost 8,950 tokens per call against pass 1's 2,480, on a smaller diff.
- **Total: 662,099 → 660,000.**

**Why two passes are budgeted rather than one.** §6's amendment says budget one cycle by default. This phase overrides that default deliberately: **its central act is dropping a table on a live hospital's database.** A remediation on that path is unreviewed code on the same path, which is exactly the case the second pass exists for — and 09a, whose shape this phase shares, set one pass, breached its stop-loss by 40%, and the second pass is the reason that phase is correct.

**The distortion in the first term, named rather than hidden.** For a LIGHT phase `subagentTokens` is essentially the reviewer, so deriving a "per-task rate" from 16a's number uses a REVIEW cost as an EXECUTION cost, and the two terms overlap. The alternative — 09a's rate, 118,693/task — gives 1.25M, which multiplies review cost by task count and is precisely the error §6's amendment forbids in the other direction. **The number above is therefore a tripwire with a known bias, not a measurement.** The honest input is the one that does not exist: main-session cost, unmeasurable from inside a session (runbook **O3**, open since Plan 11e).

### Context budget (v3 §9.2), measured before compiling

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | **64,116** after the amendments; re-measure at kickoff (`wc -c`) | **16,029** |
| `AGENT-RULES.md` | 24,550 | 6,138 |
| ledger §5 only (lines 1039–1053) | 3,455 | 864 |
| **NOT pointed at:** the ledger in full | 354,071 | **88,518 — the number §9.1's cite-by-number rule exists to avoid** |

**Per-agent context budget: ≈ 22,000 tokens carried.** For comparison, Plan 09's briefs carried **374,461 into every one of 2,327 tool calls** (ledger §2.97) — the difference is entirely §9.1's three rules, and it is the whole reason this document cites the ledger by number.

**Parallel-work fence.** `git status` was CLEAN at write time (`main`, `0055c06`) and no jest/vitest process was running. If one appears during execution it is a second lane: read [`reports/2026-08-26-parallel-session-protocol.md`](reports/2026-08-26-parallel-session-protocol.md) before trusting any test evidence (AGENT-RULES rule 20, and **read the matched command lines, never the count**).

---

## 1. Why this phase

**Resource state has no home, and OPD has already privatised the part of it that exists.** Journey state has a uniform transactionally-consistent home in `workflow_instances`; the roadmap added this phase in place of the audit's "hospital state projection" for exactly that asymmetry. Today `opd_rooms` is a private OPD table, and the mini-OT's theatre, its two recovery bays, pharmacy stores, lab benches and analyzers, housekeeping rooms and BMW collection points all need the same shape. Built per-module, that is seven copies of one concept — §2.54's mechanism applied to a table instead of a fact.

**It is a hard gate before the IPD cluster and it was pulled forward for the mini-OT.** §11.16-A's own resource line reads: *theatre ×1 · recovery-bay beds ×2 (day-care class) · autoclave (device, cycle logs) · instrument sets · consignment store location.* Plan 15 cannot be authored against a registry that does not exist.

**And the OPD rooms move now, by owner ruling (2026-08-26), for a reason the plan inherits verbatim:** Plan 13 exists BECAUSE OPD privatised room state; at 2 rows and 2 referrers this migration is as cheap as it will ever be; and if OPD rooms have not moved by Plan 15, the mini-OT's rooms live in the registry while the OPD floor's rooms do not — which is the two-homes-for-one-concept trap the phase is meant to close. **Only ROOMS move.** OPD doctor availability (`opd_doctors`, `opd_doctor_schedules`, `opd_doctor_leaves` as availability) STAYS in OPD until the roster module; `opd_doctor_schedules` is touched solely to repoint its `room_id` foreign key. The seam is named, not moved.

---

## 2. Ground truth — measured on this host, 2026-08-26, and **re-measure it at kickoff** (AGENT-RULES §6)

Every line below was run in this checkout at write time. **Three of them had already drifted from the launch prompt that commissioned this document, which is why the rule is re-measure rather than re-read.**

- **Migration head `0030_charming_the_hood.sql`.** Journal idx 30. `git status` clean, branch `main`, HEAD `0055c06`. **This phase generates THREE: `0031`, `0032`, `0033` — see DD12.** Read the head yourself (`ls apps/core/drizzle/*.sql | tail -1` **and** `git status`) before writing a number into a commit.
- **There is NO `resources` table and no `resource_status_history` anywhere** — `pgTable("resources"` and `resource_status_history` are zero hits across `apps` and `packages`.
- **`opdRooms` is touched by NINE source files, not six.** The launch prompt named six. Measured (`grep -rln 'opdRooms\|opd_rooms' --include=*.ts apps packages`, excluding `drizzle/`):
  `kernel/db/schema/opd.ts` · `kernel/db/schema/opd.test.ts` · `modules/opd/masters.ts` · `modules/opd/masters.test.ts` · `modules/opd/queue.ts` · `modules/opd/schedules.ts` · **`test/helpers/db.ts`** · **`test/helpers/opd.ts`** · **`test/perf-opd-queue.test.ts`**. The last three are the ones the prompt's list omitted, and **a Files list that omits them makes the task unbuildable** — 16a hit that shape four times.
- **The two foreign keys, and they are NOT alike.** `opd_doctor_schedules.room_id` is **`notNull().references(() => opdRooms.id)`** (`opd.ts:93`); `opd_queue_sessions.room_id` is **nullable** (`opd.ts:169`). The NOT NULL one is what makes the backfill's precondition guard load-bearing (**A11**).
- **`ALL_MANIFESTS` holds TWELVE**, pinned by key and in order at `manifests.test.ts:108`, cross-pinned to `app.module.ts` (leg V4) and to the worker (leg 3). **Leg 3 asserts the worker differs from `ALL_MANIFESTS` in `["ops", "membership", "formulary"]` — exactly three. A thirteenth manifest with no subscriptions makes it FOUR, and the test's own title says "exactly three".** That is a three-file change plus a test title.
- **Permission census: 77 declared = 63 held + 14 not-yet-modelled**, pinned twice in `test/seed-roles.test.ts` (lines 425 and 496) and compared **cell for cell, both directions** against a table in `README.md`.
- **SPA route census 25** (`test/caddyfile-parity.test.ts:304`). **Deploy seed census: seven scripts, in order** (`test/deploy-parity.test.ts:345-353`). **API prefix census: ONE — `/api`** (`caddyfile-parity.test.ts:236`), since Plan 11g / DD1. **A new API route family therefore needs NO Caddyfile edit and no vite edit**, and this phase adds no screen, so it moves **neither** the SPA route census nor the deploy seed census. Verified rather than assumed; see DD11.
- **`truncateAll` (`test/helpers/db.ts:156-167`) is one hand-maintained statement and `opd_rooms` is in it.** A table absent from it is never emptied at all (16a F2); a table dropped while still named in it makes every suite throw.
- **`ENTITY_ORDER` in `kernel/search/registry.ts:23` already contains `"room"`, and `SearchEntity` in `packages/contracts/src/search.ts:22` already declares it — and NO provider registers it.** This phase does not add one (**DD15**).
- **Class-B/C machinery exists and governs WORKFLOW DEFINITIONS only** — `kernel/workflow/definitions.ts` (`changeClass: "A"|"B"|"C"`, draft → approve → activate, SoD-paired, `governance.test.ts`). **No master-data table in this system is governed by it today**: `createRoom`, `createDepartment`, `createDoctor` and every `formulary` master are direct audited writes. See DD10 and § 4A.
- **Hand-authored migrations are house practice with two precedents to copy.** `0030_charming_the_hood.sql` reorders drizzle's generated statements with a header saying why and stating `_journal.json` is untouched. `0025_episode_numbers.sql` is a full backfill: a `DO $$ … RAISE EXCEPTION` precondition guard, deterministic SQL backfill, then the constraints. **`0032` and `0033` follow `0025`'s shape exactly.**

### Production, measured read-only against `hmis-prod-db-1` (user `hmis`, db `hmis`), 2026-08-26

| | |
|---|---|
| `opd_rooms` | **2 rows — `SYN-R1` / "SYN Consult Room 1", `SYN-R2` / "SYN Consult Room 2"; `floor` NULL on both; `active` true on both** |
| `opd_doctor_schedules` | 14 rows, **all 14 carry a `room_id`** (the NOT NULL FK) |
| `opd_queue_sessions` | 2 rows, 1 carries a `room_id` |
| FKs referencing `opd_rooms` | **exactly two**: `opd_doctor_schedules.room_id`, `opd_queue_sessions.room_id` |
| `events.site_id` | `text("site_id").notNull().default("main")` (`schema/events.ts:38`); one distinct value in production; **no `sites`/`facilities`/`branch` table exists** |

> **THE LAUNCH PROMPT SAID "The 2 OPD rooms are real rooms in a real hospital." THEY ARE NOT.** Both carry the `SYN-` prefix, which 16a's own spike established as the commissioning smoke-test marker (`SYN-Dust`, `SYN-Penicillin`). **The migration as it stands today moves two synthetic rows.** That lowers the risk of this phase materially and it is recorded here so nobody re-derives it — **and it changes nothing about how the migration must be written**, because the owner may enter real rooms between this document and its execution. The backfill is data-driven, guarded, and never hardcodes a row. **Spike Q1 re-asks this at kickoff for exactly that reason.**

---

## 3. Spike — questions written now, answered at kickoff by read-only SQL against production

Write the measured answers **in place here** before T1 starts (v3 §1.2; the 11d Question B precedent — a read-only production query from the main session is the cheapest honest way, and no agent is needed for any of these).

**Q1 — Has the room book changed?** `select id, code, name, floor, active from opd_rooms order by code;`
Answers three things at once: whether the two `SYN-` rows are still the whole book (write-time measurement), whether **any room now carries a non-null `floor`**, and whether **any room is inactive**. *Consequence:* both of those fields are mapped by the backfill and production currently exercises NEITHER — so if the answer is still "two SYN rooms, floor NULL, active true", **T6's fixtures must deliberately differ from production** (**A8** and **A9**, and §2.102: a fixture whose fields coincide has not exercised the code that distinguishes them). If real rooms HAVE been entered, say so and re-read the risk of T7's drop.

**Q2 — Does every referrer resolve?** `select count(*) from opd_doctor_schedules s left join opd_rooms r on r.id = s.room_id where r.id is null;` and the same for `opd_queue_sessions`.
Answers whether the backfill's row-count guard can pass. *Consequence:* a non-zero count means an orphan exists behind a NOT NULL FK, and **T6 halts and reports rather than migrating** — the guard in `0032` must RAISE, not skip.

**Q3 — Where is production?** `select max(id) from drizzle.__drizzle_migrations;` (or the deploy's own report) and `select to_regclass('resources');`
Answers that production is at `0030` and that nothing has claimed the table name. *Consequence:* a head other than `0030` re-bases every migration number in § 5 before T1 generates anything.

**Q4 — Is `site_id` still one value with nothing behind it?** `select site_id, count(*) from events group by 1;` and `select to_regclass('sites'), to_regclass('facilities');`
Confirms the owner's Q3 ruling still describes the system at kickoff. *Consequence:* more than one distinct value, or a sites table appearing, re-opens DD3 with the owner before T1.

**Q5 — WHAT IS THE HOSPITAL DOING RIGHT NOW?** `select to_mode, at from operating_mode_changes order by seq desc limit 1;` — **the columns are `from_mode`/`to_mode`/`at`, ordered by `seq`** (`schema/ops.ts:54-66`), not `mode`/`changed_at`
**This is the gate on the destructive half of the phase and it is asked for that reason.** Production has never left `commissioning` (11f's CLOSE; `operating_mode_changes` was still empty at 11f close). *Consequence:* if the answer is still `commissioning` or an empty table, T6/T7 proceed as planned. **If production has entered `live`, T7's drop stops being a migration and becomes an owner-authorised operational act** — record the answer, do not proceed on the strength of this document, and route it.

---

## 4. Design decisions — what this plan rules beyond the spec

**DD1 — The registry is a KERNEL SUBSYSTEM, not a module: `apps/core/src/kernel/resources/`.**
The house has both shapes. `patients`, `tariff`, `opd`, `billing`, `membership`, `partners`, `formulary` are modules with journeys and screens; `auth`, `workflow`, `approvals`, `alerts`, `ops` are kernel subsystems that everything consumes, **and they carry §4 manifests too** — `kernel/ops/manifest.ts` says why in as many words (the §4 seam is where permissions are DECLARED, and a route guarding a permission no manifest declares is unreachable by every role forever). The registry owns no journey and is consumed by OPD, the mini-OT, pharmacy, lab, housekeeping and IPD alike. It takes the `kernel/ops` shape: `manifest.ts`, `events.ts`, `errors.ts`, `resources.controller.ts`, `resources.module.ts`, plus its own logic files. **Its tables live in `kernel/db/schema/resources.ts` like every other table** — the one-migration-dir convention means table location says nothing about ownership; ownership is code discipline (spec §4, and `opd.ts`'s own header).

**DD2 — ONE state column: `status`. There is no `active` boolean.**
Every other master in this repo carries `active` (`opd_rooms`, `opd_departments`, `opd_doctors`, `formulary_medicines`), and the registry deliberately does not. A resource that is `active: false` and `status: 'available'` is a row that disagrees with itself, and it is the bed board — the one surface §11.2 builds on this table — that would read it wrong. **One column cannot drift against itself.** Each kind declares a `retired` status (DD4); `opd_rooms.active` maps onto it at migration time (`true → available`, `false → retired`, **A9**). The cost, stated: every board and picker query must exclude the retired status rather than filter `active`, and `listRooms({ activeOnly })` becomes `status !== retired` — **one predicate in one mapper (DD9), not a rule every caller must remember.**

**DD3 — `site_id text NOT NULL DEFAULT 'main'` — RULED BY THE OWNER 2026-08-26, mirroring the shipped kernel precedent.**
Exactly as `events.site_id` is already declared (`schema/events.ts:38`). **No `sites` table, no facilities table, no multi-site machinery in this phase.** Owner's reasoning, recorded so the executor inherits it: retrofitting a NOT NULL scope column onto a populated live kernel table later is the expensive path; matching the existing column costs nothing today. **Do not re-litigate this.**

**DD4 — Kinds and their status vocabularies are DECLARED on the §4 manifest seam, and the kernel declares the structural ones.**
`ModuleManifest` gains one optional field — the `search?: SearchProvider[]` precedent from 11h T1, which is the same seam solving the same problem:

```ts
export type ResourceKindDecl = {
  kind: ResourceKind;              // a member of the closed union in kinds.ts
  statuses: readonly string[];     // the kind's whole vocabulary
  initial: string;                 // the status a newly created resource takes
  occupied: string | null;         // the status an assignment sets; null ⇒ this kind is not assignable
  onRelease: string;               // the status a release sets — a bed goes to CLEANING, not available (§11.2's discharge cascade)
  retired: string;                 // the status that means "no longer part of the hospital" (DD2)
};
```

Collected at boot from `registry.all()` exactly as `collectProviders` does, with the same refusals: **a kind declared by two manifests is a boot error** (the `duplicate_provider` precedent), and **a kind no installed manifest declares cannot be created**. `resourcesManifest` declares the five structural kinds — `floor`, `ward`, `hall`, `room`, `bed` — because no module owns a floor. **Plan 15 adds `theatre` and `device` on its own manifest, Plan 16 adds `store`, Plan 17 adds `bench` and `analyzer`; none of them edits kernel code to do it.** That is the roadmap's "manifest registration of resource kinds per module", built as the thing it is: a seam.
*AMENDED — the seam's exact width, so Plan 15 does not misread it:* the seam is open for **status vocabularies** and for **claiming** a kind, and it is **closed for the set of kinds**. The ten names live in `kinds.ts` and in T1's CHECK (DD5); an **eleventh kind is a kernel edit plus a migration plus the parity test**, by design. The five later modules edit no kernel code only because their kinds are already among the ten. § 4A item 2 (instrument sets) is the first pressure on that boundary and is routed for exactly this reason.
`initial`/`occupied`/`onRelease`/`retired` must each be a member of `statuses`; a declaration that violates it is a boot error, asserted in `kinds.test.ts`.

**DD5 — `kind` carries a CHECK constraint AND a declaration check, and a test pins the two lists equal.**
16a's F3 ruled that closed sets ship as CHECK constraints, because an out-of-set value reads to every downstream reader in the safe-LOOKING direction. That reasoning holds here and it holds *harder*, because **this phase writes rows through raw SQL** (the backfill), which the application's own validation cannot see. So: a CHECK listing the ten roadmap kinds defends every write path, **and** the write path additionally refuses a kind no installed manifest declares — which is strictly stronger, because it rejects a legal-but-unowned kind. That is two copies of ten strings, which is §2.54's mechanism, **so it ships with the §2.54-approved remedy: a test that compares them** (the `caddyfile-parity` shape). `status` gets no CHECK — its vocabulary is per-kind and lives only in the declarations.

**DD6 — The occupancy triad is `occupant_ref` + `occupant_type` + `since`, plain text, no foreign key, and the three move together or not at all.**
A bed's occupant is an admission, a recovery bay's is a day-care encounter, a store's is nothing, an analyzer's is a run. **A column that must point at two different parents can carry a foreign key to neither** — the shipped precedent is `patient_merge_requests.approval_id` and `import_quarantine.batch_id` (see `schema/membership.ts`). `occupant_type` is what makes the ref readable; without it the column is an id nobody can resolve. **The invariant: `occupant_ref` non-null ⟺ `occupant_type` non-null ⟺ `since` non-null ⟺ `status` is the kind's `occupied`.** Enforced at the write path in one place, and it is an Assertion Book row (A2).

**DD7 — The tree is CYCLE-BOUNDED and DEPTH-BOUNDED, and there is no legal-parent-kind matrix.**
`parent_id` is a nullable self-reference. Postgres cannot express "not my own ancestor", so the write path walks ancestors to the root before every move, capped at `MAX_RESOURCE_DEPTH = 6` — one constant in one file, read by both the write guard and the tree reader (16a DD5's "one constant, one owner", applied to a number). Six gives headroom over §11.18's four-level floor → ward/hall → room → bed without inviting a hierarchy nobody can render.
**What this plan deliberately does NOT enforce is which kinds may contain which.** A bed under a theatre is legal here, because §11.16-A's two recovery bays may well hang exactly there, and a containment matrix written now would block Plan 15 from a shape the owner has already described. **Containment rules are the owning module's, not the registry's — that is the roadmap's own trap ("IPD owns admissions, assignment rules, gender segregation, isolation, quota — rules OVER the registry") applied to structure instead of to occupancy.** Named as a seam, not built.

**DD8 — FIVE events, and two of them are wider than the roadmap's list. The widening is argued, not slipped in.**
The roadmap names `resource.status_changed`, `resource.assigned`, `resource.released`. This plan also ships **`resource.registered`** and **`resource.updated`**. Reason: spec §6 says audit is structural — *"event log + append-only financials + row-level `updated_by`/`updated_at`"* — and §11.18 sweep #3 puts master changes under change control. `createRoom` emits nothing today, which is an audit hole in OPD; carrying that hole into a kernel table that IPD, the mini-OT, pharmacy and lab will all build on makes it a hole in the foundation instead of in one module. The cost is two `defineEvent` entries and two `appendEvent` calls inside transactions that already exist. **`masterdata.changed` (§11.18 sweep #3's own name) is NOT this phase's event** — it is cross-cutting, it belongs with the governance machinery, and § 4A routes it.

**DD9 — OPD's room helpers keep their EXTERNAL SHAPE, so the move stops at the module boundary.**
`RoomRow` is `typeof opdRooms.$inferSelect` today and is consumed by `opd-masters.controller.ts` and, through it, by `apps/web/src/screens/opd-admin.tsx`. After the move it becomes an **explicit type with the same field names** — `{ id, code, name, floor: string | null, active: boolean, createdBy, createdAt, updatedBy, updatedAt }` — produced by a mapper over the registry row: `floor` reads `attributes->>'floor'`, `active` reads `status !== retired`. **The controller, the HTTP contract, the SPA and its tests are therefore untouched, and `apps/web` is not in this phase at all.** The blast radius is `modules/opd/masters.ts`. *This is a decision the reviewer should attack:* a mapper that preserves a legacy shape is a facade, and a facade is a place where two vocabularies can drift. It is chosen because the alternative — changing the response shape — pulls a screen, its tests and a contract into a phase whose subject is a table, and buys nothing this phase can use.

**DD10 — Registry masters are NOT Class-B/C governed in this phase, and the reason is consistency, not convenience.**
The machinery exists (`kernel/workflow/definitions.ts`) and governs workflow definitions. **No master-data table in this system is governed by it today** — not OPD's departments, rooms or doctors, not any formulary master. Governing the registry alone would make it the single governed master in the hospital, which is a worse state than either end: the change-control story would be true of rooms and false of doctors, drugs and services, and nobody reading either would know which. It also cannot be operated today: governance needs a second approving actor and **production still has ONE full administrator** (11e's CLOSE, runbook O1). So the registry writes through the same audited, evented, `updated_by`-stamped path every other master uses (DD8 makes it *better* audited than what it replaces), and **the governance question is routed whole — see § 4A item 3.**

**DD11 — This phase moves NO census except two, and both are named in the task that moves them.**
Measured, not assumed (§ 2): manifest census **12 → 13** (T2, three files plus a test title) and permission census **77 → 78 declared, 63 → 64 held** (T2, three files). **Unmoved and verified:** the SPA route census stays 25 (no screen), the deploy seed census stays seven (no seed script), the API prefix census stays one (Plan 11g / DD1 — there is no Caddyfile edit left to make), `packages/contracts` stays 4 suites / 21 tests. **For every task, § 5 names the number it moves and the file that pins it.** 16a hit that shape four times; it is the cheapest lesson in this document to obey.

**DD12 — THREE migrations, because the irreversible step lands alone.**
`0031` creates the two tables and nothing else — additive, independently deployable, harmless if the phase halts after it. `0032` backfills `resources` from `opd_rooms` **preserving every id**, then drops both old foreign keys and adds them again against `resources(id)`. **`opd_rooms` still exists after `0032`, holding the source data, orphaned.** `0033` drops it.
**Preserving the ids is what makes this cheap**: they are ULIDs, globally unique, so `opd_doctor_schedules.room_id` and `opd_queue_sessions.room_id` need no value rewrite — only their FK target changes. **And splitting the drop out of the repoint is what makes it recoverable**: for the length of one commit the truth exists in two places, and a wrong backfill is a fix rather than a restore. On a live hospital database that is worth one extra migration file.
*AMENDED — the file split alone buys NOTHING in production; the deploy gate is what buys it.* `db:migrate:prod` applies every pending file in one run. If T6 and T7 are both merged before the next deploy, `0032` and `0033` execute back to back and the recovery window on the live database is zero — the "length of one commit" is a fact about git, not about the hospital. **Therefore this phase deploys TWICE, and `0033` may not be committed until the first deploy has landed and been verified:** deploy after T6 (owner-authorised, §3.6), then run the T7 precondition (below) read-only against production, and only then author `0033`. If production has left `commissioning` by then, that same gate is where the owner signs the drop (§ 4A item 4). Both hand-authored files follow `0025_episode_numbers.sql`'s shape — a `DO $$ … RAISE EXCEPTION` precondition guard first, deterministic SQL second — and carry `0030_charming_the_hood.sql`'s header convention: say what was hand-edited and state that `_journal.json` is untouched (AGENT-RULES §6, and **never** hand-edit the journal).

**DD13 — Uniqueness is `(site_id, kind, lower(code))`, and tightening it over live data comes with a guard.**
`opd_rooms_code_ux` is unique on raw `code`, globally. The registry scopes it, because a bed "12" and a room "12" are different things and a global code space would make the first bed collide with an existing room. `lower()` because a room code is read off a door and case is not identity (the formulary's `unique on lower` precedent). **Tightening a constraint over data that already exists can fail at `CREATE UNIQUE INDEX` with an error naming an index instead of a room, so `0032`'s guard raises first and names the colliding rows.** Production's two codes (`SYN-R1`, `SYN-R2`) do not collide; the guard is for the book that exists at execution time, which Q1 measures.

**DD14 — The registry's HTTP surface is READ-ONLY, and it declares exactly ONE permission.**
Three read routes (`tree`, `board`, `history`) guarded by **`resources.read`**, granted to `opd_admin` — the role that reads rooms today, so **no new authority is created** (16a DD10's minimum-authority posture). There is **no `resources.manage`**: master writes for rooms continue through OPD's existing `opd.masters.manage`-guarded routes, now delegating into the registry (DD9), and the first module that needs a registry write route declares and mounts its own permission with it. Likewise **`assignResource`/`releaseResource` ship as module-facing functions with tests and NO route**, because nothing assigns anything until Plan 15. This is deliberate: `seed-roles.test.ts:160` records the trap of a permission *"declared, guarding a LIVE route, and held by nobody"*, and a `manage` permission guarding no route is the same defect seen from the other side.
**The honest half, stated so CLOSE cannot be written as if it were otherwise:** the three read routes have no caller in this phase — no screen renders them and `resource.status_changed`, `resource.assigned` and `resource.released` will not fire in production. Their first consumer is Plan 15. The registry's value this phase is that **the OPD floor's rooms stop being private**, and everything else is forward-looking (16a's precedent for saying so).

**DD15 — The registry declares NO search provider, and the half-built seam it inherits is named rather than finished.**
`SearchEntity` in `packages/contracts/src/search.ts:22` already declares `"room"` and `kernel/search/registry.ts:23` already ranks it in `ENTITY_ORDER` — **and no provider anywhere registers it**, so `@room` has been a typeable chip resolving to nothing since Plan 11h shipped. Finishing it here would be right in kind and wrong in scope: the roadmap's traps say *no dashboard*, this phase adds no screen, and a palette entry for a registry nobody can yet see is apparatus ahead of need. **What this plan does instead is record that the seam is half-built**, so the next reader finds a named gap rather than an apparent oversight: the module that first gives the registry a screen adds one `search:` array entry to `resourcesManifest` — Plan 11h's DD1 made that a one-line change and it stays one.

---

## 4A. ROUTED TO THE OWNER — open, named, and not blocking (v3, prompt Q4)

> **Items 1–3 RULED 2026-08-26 evening — the owner adopted the recommendations recorded under each. Item 4 is decided by DD12's deploy gate. Nothing in this section is open; the rulings are recorded here so Plans 15 and the IPD cluster inherit them.**

The owner ruled Q2 (migrate now) and Q3 (`site_id`) on 2026-08-26. Q4 asked what §11.18 leaves genuinely open that Plan 15's mini-OT needs first. **Four items, each with what this plan does in the meantime so nothing blocks.**

1. **What is `class`, and when does it acquire its tariff link?** §11.18 says bed classes *carry* tariff, attendant policy, pass counts, nursing-ratio indicator and AC/non-AC attributes; §11.2 says *"class drives every tariff for the stay."* That describes a governed table with a link into the tariff engine, not a scalar. But the roadmap's column list has `class` as a column on `resources` and its trap line says **one table family**. §11.16-A needs a **day-care class** for the two recovery bays, and day-care tariff entries are already on the owner's stage-2 action list. **RULED BY THE OWNER 2026-08-26 (adopting the planner's recommendation):** `class` is a closed code on `bed`/`room`, and the tariff link is a **tariff-module table keyed by class code** (§11.2, "class drives tariff") landing with the IPD cluster — **not** a foreign key on `resources`. Plan 13 therefore ships neither the column nor the answer; adding a nullable column later is the cheap case, unlike `site_id` (DD3).
   **This plan rules, provisionally: `class` is a nullable text column on `resources` and there is no `resource_classes` table and no tariff link in Plan 13.** The question routed is the TIMING: does the class→tariff table land in **Plan 15** (when the first classed resource is billed) or with the **IPD cluster** (when class drives a whole stay)? Plan 15 inherits whichever answer arrives, and if it is Plan 15, that phase should know now.
2. **Are instrument sets registry resources?** §11.16-A lists *"instrument sets"* under **"Resources (Plan 13 registry contributions)"** — but `set` is **not** one of the ten kinds the roadmap names, and a CSSD set is a tracked, sterilized, recalled-by-load asset with a lifecycle the registry's `status` does not describe. **This plan does not add a `set` kind.** The routed question: do instrument sets become registry resources (a new kind on the mini-OT's manifest, DD4 makes that a one-line addition), or a CSSD table that *references* the autoclave device the way module tables reference `patients`? **Plan 15 needs the answer before it is authored; Plan 13 does not.** **RULED BY THE OWNER 2026-08-26 (adopting the planner's recommendation):** **not a registry kind.** The registry is a tree of places and stations; a set is a movable asset with a sterility lifecycle (packed → sterilised → issued → used → returned → reprocessed, recalled by autoclave load) — a CSSD table with an FK to the autoclave `device` resource, the way module tables reference `patients`. It would be the first kind whose `status` is not about occupancy, and DD6's triad would mean nothing for it.
3. **Master-data change control — the whole question, not the registry's share of it.** §11.18 sweep #3 puts item/service/doctor/payer masters under workflow-definition governance. **Nothing in the system has it** (DD10). The routed question is whether master-data governance is its own phase across all masters, or arrives per-module. **It cannot be answered by Plan 13 without making the registry the only governed master in the hospital**, which is worse than either answer. Also note the operational precondition: governance needs a second approving actor and production has one full administrator (runbook O1). **RULED BY THE OWNER 2026-08-26 (adopting the planner's recommendation):** **a dedicated master-data change-control phase after the IPD cluster**, covering rooms, doctors, departments, formulary and tariff in one shape — and it **cannot be scheduled before runbook O1 closes**; a Class-B/C flow with one approver is theatre.
4. **The destructive step's authorisation, if production has moved.** Spike Q5 measures the operating mode at kickoff. Production has never left `commissioning`. **If it has by then, T7's `DROP TABLE opd_rooms` against a live hospital is an owner-authorised operational act and not a migration this document approves.** Recorded here rather than left to the executor's judgment. *AMENDED:* DD12's deploy gate is now where this is decided — T7's precondition reads the operating mode after T6's deploy, and a `live` answer halts before `0033` exists.

---

## 5. Tasks

Tiers per AGENT-RULES §3. **CRITICAL tasks carry their Assertion Book rows inline** — assertion · mutant · discriminating input. Every task ends with the finish block (AGENT-RULES §5); commit messages are exact. **Migration numbers are re-based at kickoff against the measured head (Spike Q3).**

> **A standing note on every Assertion Book row below, and it is 16a's F10 written into this plan's own bones: a "discriminating input" is a PREDICTION until somebody runs it.** 16a's plan named an input that did not discriminate, and only building the mutant showed it. Where a row's input is arguable it is argued; where an obvious-looking input would NOT discriminate, that is said too. **The executor is expected to correct these rows and to record the correction as a finding — a corrected row is the instrument working, not the plan failing.**

---

### T1 — The two tables, and migration `0031` — **ROUTINE**

**Files:** Create `apps/core/src/kernel/db/schema/resources.ts`, `apps/core/src/kernel/db/schema/resources.test.ts`; Modify `apps/core/src/kernel/db/schema/index.ts` (export, in dependency order); Modify **`apps/core/test/helpers/db.ts`** (the truncate statement — see below, this is not optional); Generate `apps/core/drizzle/0031_*.sql` + `drizzle/meta/` via `pnpm db:generate`.

**Produces (exact — every later task depends on these names):**
- **`resources`**: `id` text PK (ULID via `newId()`) · `kind` text NOT NULL **with a CHECK over the ten roadmap kinds** (DD5) · `parentId` text nullable, self-references `resources.id` · `code` text NOT NULL · `name` text NOT NULL · *(no `class` column — AMENDED, see § 4A item 1: a nullable column is the cheap case to add later, and a free-text column with no write path is the drift DD5 exists to prevent)* · `attributes` jsonb NOT NULL default `{}` · `status` text NOT NULL · `occupantType` text nullable · `occupantRef` text nullable · `since` timestamptz nullable · `siteId` text NOT NULL **default `'main'`** (DD3) · `createdBy`/`createdAt`/`updatedBy`/`updatedAt` (the `opd_departments` audit shape). Unique index on **`(site_id, kind, lower(code))`** (DD13). Index on `(parent_id)` and on `(kind, status)` — the board's two access paths.
- **`resource_status_history`**: `seq` bigserial (**the ordering key — ids are ULIDs and are NEVER an ordering key**, `opd.ts` header / ledger §3.26) · `id` text PK · `resourceId` text NOT NULL references `resources.id` · `fromStatus` text **nullable** (null on the creation row — "no previous status" is a fact, not a missing value) · `toStatus` text NOT NULL · `occupantType`/`occupantRef` text nullable (the occupancy *after* this transition) · `reason` text nullable · `at` timestamptz NOT NULL defaultNow() · `actorId` text NOT NULL. **No update and no delete path anywhere in the codebase** (A3).

**`truncateAll` — and why the two tables join the `patients`/`opd` statement NOW rather than in T6.** §3.35/§3.12 govern which group a new table joins, and 16a's F2 adds the island case: a table absent from the statement is never emptied at all. At T1 `resources` points nowhere and nothing points in — an island, which by F2 would take its own statement. **But at T6 it becomes the PARENT of `opd_queue_sessions.room_id` and `opd_doctor_schedules.room_id`, and a parent must be truncated in the same statement as its children.** Joining the existing statement now is correct at both moments and costs one edit instead of two. Put both new names in the existing `patients`/`opd` statement, adjacent to `opd_rooms`, with that reason in the comment.

**Acceptance:** `resources.test.ts` pins the two tables' columns by name (the `opd.test.ts` / `formulary.test.ts` pattern) and pins **the CHECK constraint's kind list equal to the `ResourceKind` union** (DD5 — the union lands in T2; if T1 runs first, this leg lands in T2 and T1 says so rather than leaving it unpinned). Migration generated **only when ready to carry it to the same commit** (AGENT-RULES §6). Full-suite migration applies clean. `pnpm verify` exit 0 before push, detached, exit value read from a file.
**Commit:** `feat(core): resource registry schema — resources + resource_status_history (13 T1)`

---

### T2 — Kinds, the manifest seam, and one permission — **ROUTINE**

**Files:** Create `apps/core/src/kernel/resources/{kinds.ts, kinds.test.ts, manifest.ts, events.ts, errors.ts, index.ts, resources.module.ts}`; Modify `apps/core/src/kernel/modules/manifest.ts` (add `resourceKinds?`), `apps/core/src/kernel/modules/manifests.ts` (**twelve → THIRTEEN**), **`apps/core/src/kernel/modules/manifests.test.ts`** (the census leg AND leg 3 — see below), `apps/core/src/app.module.ts` (install order); Modify **`apps/core/scripts/seed-roles.ts`** (the grant), **`apps/core/test/seed-roles.test.ts`** (both census pins, lines 425 and 496, and the per-role counts), **`README.md`** (the permission×role table `seed-roles.test.ts` compares cell for cell, both directions).

**THE THREE NUMBERS THIS TASK MOVES, and the files that pin them** (DD11; 16a's F1 is this task's shape exactly — a task that declares a permission must be allowed to grant it):
1. **Manifest census 12 → 13** — `manifests.ts`, `manifests.test.ts:108` (by key, IN ORDER — append, do not reorder), `app.module.ts`.
2. **`manifests.test.ts` leg 3 — "exactly three" becomes "exactly FOUR".** `resourcesManifest` ships `subscriptions: []` and the worker serves no resources route, so `expect(allKeys.filter(k => !workerKeys.includes(k))).toEqual(["ops", "membership", "formulary"])` becomes `[…, "resources"]` **and the test's own title changes.** Add the `(1d)` comment block in the shape (1a)/(1c) already use, with the same reason: installing it in the worker would catalog nothing new and subscribe to nothing.
3. **Permission census 77 → 78 declared, 63 → 64 held, 14 not-yet-modelled unchanged** — `seed-roles.ts`, `seed-roles.test.ts` (both pins), `README.md`. **MEASURE it and report the difference rather than assuming this line** (AGENT-RULES §4).

**Produces:**
- `kinds.ts`: the closed `ResourceKind` union — `"floor" | "ward" | "hall" | "room" | "bed" | "theatre" | "store" | "bench" | "analyzer" | "device"` — the `ResourceKindDecl` type (DD4 verbatim), `MAX_RESOURCE_DEPTH = 6` (DD7 — **one constant, one owner**), `KERNEL_RESOURCE_KINDS` (the five structural kinds with their vocabularies), and `collectResourceKinds(registry)` in the shape of `collectProviders`: **duplicate kind ⇒ throw; a declaration naming an `initial`/`occupied`/`onRelease`/`retired` outside its own `statuses` ⇒ throw.**
- `manifest.ts`: `resourcesManifest` — key `"resources"`, title, `menu: []` (no screen, DD14), `permissions: ["resources.read"]`, `subscriptions: []`, `resourceKinds: KERNEL_RESOURCE_KINDS`.
- `events.ts`: five `defineEvent` names under module `resources` — `resource.registered`, `resource.updated`, `resource.status_changed`, `resource.assigned`, `resource.released` (DD8). No per-run noise: each name is appended only when the fact it records happened (`kernel/ops/events.ts`'s stated rule).
- `errors.ts`: `ResourceError` with codes `"unknown_kind" | "unknown_status" | "unknown_resource" | "duplicate_code" | "cycle" | "too_deep" | "not_assignable" | "already_occupied" | "not_occupied"`.
- The kernel's five structural declarations, and they are the vocabulary IPD and the mini-OT inherit — get them right here:
  `room`: statuses `["available","occupied","cleaning","blocked","retired"]`, initial `available`, occupied `occupied`, onRelease **`cleaning`**, retired `retired`.
  `bed`: the same five, and **`onRelease: "cleaning"` is §11.2's discharge cascade in one field** — *bed released → housekeeping task → cleaned → verified → available*. A bed that returned straight to `available` would put the next patient in an uncleaned bed, and it is a one-word defect.
  `floor`, `ward`, `hall`: `["available","blocked","retired"]`, initial `available`, **`occupied: null`** — a floor is not assignable.

**Acceptance:** `kinds.test.ts` covers a duplicate-kind boot error, a declaration whose `occupied` is outside its `statuses`, and the ten-kind union pinned against T1's CHECK list. Manifest census green at thirteen; leg 3 green at four with its comment. Reachability census closes at the number MEASURED. `pnpm verify` exit 0 before push.
**Commit:** `feat(core): the resource kind seam — manifest, declarations, events, one permission (13 T2)`

---

### T3 — The write surface — **CRITICAL**

**Files:** Create `apps/core/src/kernel/resources/{registry.ts, registry.test.ts}`; Modify `apps/core/src/kernel/resources/index.ts` (exports).

**Produces** (all `(tx, actor, …)`, the `opd/masters.ts` and `formulary/masters.ts` shape): `createResource`, `updateResource`, `moveResource`, `changeResourceStatus`, `assignResource`, `releaseResource`, `retireResource`. Each writes its event inside the caller's transaction; each status change appends exactly one `resource_status_history` row; **creation appends the row with `fromStatus: null`.**

#### Assertion Book — T3

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A1** | A move that would make a resource its own ancestor is refused with `cycle`, at ANY depth. | `registry.mutant.ts` whose ancestor check tests only `newParentId === id` — the one-hop case. | **A three-level chain `floor → room → bed`, then `moveResource(floor, under: bed)`.** The one-hop mutant sees `floor.parentId` becoming `bed.id ≠ floor.id` and ALLOWS it; the shipped walk reaches `floor` from `bed` and refuses. **The obvious input — `moveResource(x, under: x)` — does NOT discriminate: both implementations refuse it.** Say so in the test's own comment, because the next reader will reach for it. |
| **A2** | The occupancy triad moves together: `assignResource` sets `occupantType`, `occupantRef`, `since` and the kind's `occupied` status in one write; `releaseResource` nulls the first three and sets `onRelease`; assigning an occupied resource throws `already_occupied`; releasing a free one throws `not_occupied`. | A `releaseResource` that clears `occupantRef` and `occupantType` but leaves `since` standing. | **Assign → release → RE-assign, asserting `since` equals the SECOND assignment's instant.** A single assign-then-release leg asserting `since === null` would kill this mutant too, but it would NOT kill the sneakier sibling — an `assignResource` that sets `since` only when it is currently null — and the re-assign leg kills both. §2.102: a fixture that never re-uses a resource cannot tell a stale timestamp from a fresh one. |
| **A3** | `resource_status_history` is append-only and each row's `fromStatus` is the value that was there BEFORE. | A `changeResourceStatus` that reads `fromStatus` from the row AFTER updating it, so every row records `from === to`. | **Two consecutive DIFFERENT transitions on one resource — `available → blocked → available` — asserted as an ordered triple with the creation row: `[(null→available), (available→blocked), (blocked→available)]` by `seq`.** A fixture that transitions `available → available` hides it completely, and a single transition proves only half (it catches the value but not the ordering). §2.102, and §2.93's shape one layer out: a formula verified where its operands coincide has not been verified. |
| **A4** | A kind or a status that no INSTALLED manifest declares is refused — `unknown_kind` / `unknown_status`. | A validator that checks `kind` against the `ResourceKind` union (the TYPE) instead of the boot-collected declarations. | **`kind: "theatre"`.** It is a member of the union — so a type-only check passes it — and NO manifest declares it in this phase (Plan 15 will). **A nonsense kind like `"banana"` does NOT discriminate: it fails both checks.** This input is the whole distinction between "a legal string" and "a kind this hospital has", and it is the row most likely to be got wrong by an executor reaching for the easy fixture. |
| **A5** | `MAX_RESOURCE_DEPTH` is enforced on the write path, and it is read from `kinds.ts` rather than restated. | A `createResource`/`moveResource` with the depth counter removed. | **A seven-deep chain built one `createResource` at a time.** The seventh call throws `too_deep` against the shipped code and succeeds against the mutant. Six or fewer does not discriminate — the cap is six. |

**Acceptance:** every row above built as a **separate scratch file beside the source** (never by editing the shipped file), run ISOLATED with the isolation line quoted, DIED or SURVIVED recorded with counts and expected-vs-received (AGENT-RULES rule 21). Fail-first is owed and its failing output quoted. All scratch deleted before final counts.
**Commit:** `feat(core): the resource registry write surface — create, move, status, assign, release (13 T3)`

---

### T4 — The read surface: tree, board, history — **CRITICAL**

**Files:** Create `apps/core/src/kernel/resources/{read.ts, read.test.ts}`; Modify `apps/core/src/kernel/resources/index.ts`.

**Produces:** `resourceTree(db, { rootId?, kind?, siteId?, depth? })` → a nested tree, depth-capped by `MAX_RESOURCE_DEPTH`; `resourceBoard(db, { kind, parentId?, siteId? })` → a flat snapshot of DIRECT children carrying status and the occupancy triad; `resourceHistory(db, resourceId, { limit? })` → history rows in `seq` order. **There is no recursive-CTE precedent in this repository** (`grep -rn "WITH RECURSIVE"` over `apps/core/src` returns nothing), so whichever shape is chosen — iterative level-by-level fetch or a recursive CTE — is new ground and both A6's cap and its termination are load-bearing rather than decorative.

#### Assertion Book — T4

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A6** | `resourceTree` terminates and returns at most `MAX_RESOURCE_DEPTH` levels **even against a database that contains a cycle**. | A tree builder with no depth counter and no visited set. | **A cycle inserted by RAW SQL — `A.parent = B; B.parent = A` — bypassing T3's guard entirely.** This is the row that matters most in this task and it is the one an executor will be tempted to skip: **a tree test built only through the guarded write path can never construct the input that discriminates**, because T3 refuses to create it. The guard and the reader must be proved independently, or the reader's termination is an inference from someone else's correctness. §2.102 applied to a read. |
| **A7** | `resourceBoard({ kind, parentId })` returns exactly the DIRECT children of that parent of that kind — never a grandchild, never a sibling parent's child. | A board query that filters on `kind` and drops the `parentId` predicate. | **TWO wards, each holding beds, plus one bed nested a level deeper.** A fixture with ONE parent cannot discriminate: the unfiltered query returns the identical set. §2.102 — name the field that coincides (there is only one parent, so `parentId` is constant across the fixture) and build the leg where it differs. |

**Acceptance:** as T3 — mutants built beside the source, run isolated, quoted. Read functions take `Db`, never `Tx`, and hold no lock.
**Commit:** `feat(core): the resource registry read surface — tree, board, history (13 T4)`

---

### T5 — Three read routes — **ROUTINE**

**Files:** Create `apps/core/src/kernel/resources/resources.controller.ts`, `apps/core/test/resources.e2e.test.ts`; Modify `apps/core/src/kernel/resources/resources.module.ts` (controller only — **AuthGuard and PermissionGuard are global `APP_GUARD`s registered ONCE by `AuthModule` and their order is load-bearing**; registering either here runs a second permission check against a request whose actor the first guard has not attached. `ops.module.ts` says so in as many words and is the shape to copy).

**Produces:** `GET /resources/tree`, `GET /resources/board`, `GET /resources/:id/history` — all three `@RequirePermission("resources.read")`, all three zod-parsed query bodies, `ResourceError` mapped to 400/404/409 the way `OpdError` and `FormularyError` already are.

**What this task does NOT touch, verified rather than assumed (DD11):** no `Caddyfile`, no `vite.config.ts` — the API prefix census is **one** (`/api`) since Plan 11g / DD1 and there is no edge edit left to make; no `router.tsx` and no SPA route census change — this phase adds no screen; no `deploy.sh` — no seed script. **If any of those three turns out to be wrong at execution time, that is a plan defect: report it and add the file, do not work around it** (AGENT-RULES, disclose-don't-work-around).

**Acceptance:** e2e asserts 401 unauthenticated, **403 for an authenticated actor without `resources.read`**, and 200 with the expected shape for `opd_admin`. Quote the runner's own summary line.
**Commit:** `feat(core): resource registry read routes — tree, board, history (13 T5)`

---

### T6 — The move: backfill, repoint both foreign keys, OPD reads the registry — **CRITICAL**

**Files:** Modify `apps/core/src/kernel/db/schema/opd.ts` (**both `roomId` columns repoint to `resources.id`; `opdRooms` STAYS, now orphaned** — DD12), `apps/core/src/kernel/db/schema/opd.test.ts`, `apps/core/src/modules/opd/masters.ts` (`createRoom`/`updateRoom`/`listRooms` write and read the registry through the DD9 mapper; `RoomRow` becomes an explicit type), `apps/core/src/modules/opd/masters.test.ts`, `apps/core/src/modules/opd/queue.ts` (`boardSnapshot`'s `leftJoin` and the `roomCode` lookup), `apps/core/src/modules/opd/schedules.ts` (the room-exists-and-is-active check becomes status-based), `apps/core/test/helpers/opd.ts` (**`seedOpdMasters`** — measured name — seeds rooms into the registry), **`apps/core/test/perf-opd-queue.test.ts`** (*AMENDED — it was listed under T7 and that was the 16a shape one task early:* line 104 raw-inserts into `opd_rooms` and line 120 inserts `opd_queue_sessions` rows pointing at those ids; after `0032` that FK targets `resources`, so the suite goes red at THIS task, not the next — move the room insert to the registry here; its `analyze` list at line 182 can wait for T7); Generate + **hand-author** `apps/core/drizzle/0032_*.sql`.

**NOT in this task's Files list, and the reason is DD9:** `opd-masters.controller.ts`, `packages/contracts`, and all of `apps/web`. `RoomRow` keeps its field names, so the controller's return type compiles unchanged and `opd-admin.tsx` renders the same JSON. **`opd-admin.test.tsx` and `masters.test.ts` are the two suites that would go red if that is wrong; both must stay green with no edit to the former.**

**`0032`, in order — the `0025_episode_numbers.sql` shape:**
1. **Guard, `DO $$ … RAISE EXCEPTION`, three preconditions, before any write:** (a) every `opd_doctor_schedules.room_id` and every non-null `opd_queue_sessions.room_id` resolves to an existing `opd_rooms` row — an orphan behind the NOT NULL FK halts the migration (Spike Q2); (b) no two rooms collide under `lower(code)` (DD13), naming the colliding rows; (c) no `opd_rooms.id` already exists in `resources`.
2. `INSERT INTO resources` … `SELECT` from `opd_rooms` — **ids preserved**, `kind='room'`, `parent_id` NULL, `code`/`name` copied, `attributes` = `jsonb_build_object('floor', floor)` **when `floor IS NOT NULL`, else `'{}'`** (a null floor must not become `{"floor": null}` — that is a field that exists and says nothing), `status` = `case when active then 'available' else 'retired' end`, `site_id='main'`, audit columns copied.
3. One `resource_status_history` row per migrated room: `from_status` NULL, `to_status` the status just assigned, `actor_id` a named migration actor constant, `reason` naming this migration.
4. Row-count assertion in a second `DO $$`: `count(resources where kind='room') = count(opd_rooms)`. **RAISE on mismatch.**
5. Drop `opd_doctor_schedules_room_id_fkey` and `opd_queue_sessions_room_id_fkey`; add both again against `resources(id)`.
Header comment states what was hand-authored and why, that `_journal.json` is untouched (`0030`'s convention), **and that migrated rows get a history row but NO `resource.registered` event** — migrations do not append events, and the audit trail for the oldest rooms starts at their history row, said in the file so the gap reads as chosen rather than missed (*AMENDED*).

#### Assertion Book — T6

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A8** | Every `opd_rooms` row lands in `resources` with its **id preserved** and every field mapped: `floor` → `attributes->>'floor'`, `active` → status. | A backfill that copies `code` and `name` and drops `floor` on the floor. | **A fixture with one room carrying `floor = '2'` and one with `floor = NULL`.** **Production holds two rooms, both `floor NULL` (§2, Spike Q1) — so a fixture shaped like production cannot discriminate this mutant at all.** This is the clearest §2.102 row in the phase: name the field whose value coincides across every production row, and build the leg where it differs. |
| **A9** | `active` maps to status, not to a constant. | A backfill that writes `'available'` for every row. | **One INACTIVE room in the fixture.** Production has **zero** inactive rooms, so again the production-shaped fixture is blind. Assert `status = 'retired'` for it AND assert `listRooms({ activeOnly: true })` excludes it — the mapper (DD9) and the migration must agree, and this is the one leg that proves they do. |
| **A10** | Both foreign keys point at `resources` and both still hold. | A `0032` that repoints only `opd_queue_sessions` (the nullable one) and leaves `opd_doctor_schedules` on `opd_rooms`. | **Create a room through the NEW path — so it exists in `resources` and NOT in `opd_rooms` — then create a doctor schedule in it.** Against the mutant the insert violates the stale FK; against the shipped code it succeeds. A fixture that seeds rooms into both tables would pass either way. This is also the leg that proves the NOT NULL FK survived the swap on all 14 production rows' shape. |
| **A11** | The precondition guard REFUSES rather than proceeding. | A `0032` whose guard `RAISE NOTICE`s instead of `RAISE EXCEPTION`s. | **A database seeded with an `opd_doctor_schedules` row whose `room_id` names no room** (constructible only by dropping the FK first in the test's own fixture, which is what makes this leg worth writing). The mutant migrates a broken book silently and fails later at the FK add with an error naming a constraint; the shipped guard fails first with an error naming the row. **The difference is which one an operator can act on at 2 a.m.** |

**Acceptance:** mutants per AGENT-RULES rule 21 — separate scratch files, isolated runs, quoted. `masters.test.ts` proves the DD9 mapper round-trips `floor` and `active`. `opd-admin.test.tsx` green **unedited**. Full-suite migration applies clean from an empty database AND against a database already at `0031`.
**Commit:** `feat(core): OPD rooms move onto the registry — backfill, both FKs repointed (13 T6)`

---

### T7 — The drop: `opd_rooms` is gone — **CRITICAL**

**Files:** Modify `apps/core/src/kernel/db/schema/opd.ts` (delete `opdRooms`), `apps/core/src/kernel/db/schema/opd.test.ts`, **`apps/core/test/helpers/db.ts`** (remove `opd_rooms` from the truncate statement), `apps/core/test/perf-opd-queue.test.ts` (only its `analyze` list now — the insert moved to T6); Generate + hand-author `apps/core/drizzle/0033_*.sql`.

**PRECONDITION (*AMENDED*, DD12): T6 has been deployed to production and verified before this task begins — `select count(*), count(*) filter (where kind='room') from resources;` equals the `opd_rooms` count, every `opd_rooms.id` exists in `resources`, and both `room_id` foreign keys name `resources` in `pg_constraint`. Quote the answers in CLOSE. If `operating_mode_changes` shows `live`, stop here and route (§ 4A item 4). Do not author `0033` on the strength of a green suite alone.**

**`0033` is one statement and it is deliberately naked:** `DROP TABLE "opd_rooms";` — **never `CASCADE`** (A12). Header comment states why, and that this file is the phase's only irreversible step.

#### Assertion Book — T7

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A12** | `0033` uses a bare `DROP TABLE`, so applying it to a database where `0032`'s repoint did NOT happen **fails loudly** instead of silently deleting two foreign keys. | `DROP TABLE "opd_rooms" CASCADE;` | **A database at `0031` — tables created, repoint NOT applied — with `0033` applied by hand via `psql`** (the drizzle migrator never skips a file; the scenario this row guards is a hand-applied hotfix, which is exactly how a mis-ordered application happens on a live box — *AMENDED* to say so). Under `CASCADE` the drop succeeds and **both foreign keys vanish without a word**, leaving `opd_doctor_schedules.room_id` unconstrained on a live hospital's schedule book. Under the bare drop Postgres refuses and names the dependent constraint. **This is the row that justifies T7 being its own task at all**, and the mutant is one word long. |
| **A13** | Nothing reads `opd_rooms` after this commit. | Leaving `opd_rooms` in `truncateAll`'s statement. | **Any suite that calls `truncateAll` after `0033`** — it throws `relation "opd_rooms" does not exist`. Recorded honestly: **this mutant's kill is guaranteed by the suite and it is a WEAK row**, kept because the file it names (`test/helpers/db.ts`) is the one a Files list forgets. The real instrument for A13 is mechanical, not a mutant: `grep -rn 'opdRooms\|opd_rooms' apps packages --include=*.ts --include=*.tsx` returns **zero hits outside `apps/core/drizzle/`** at close. |

**Acceptance:** `to_regclass('opd_rooms') IS NULL` after migration; the grep above returns zero non-`drizzle` hits; **full workspace suite run ONCE, at the end** (AGENT-RULES §2.8), workspace total not decreased and no test deleted (§4). CI green by full SHA before close.
**Commit:** `feat(core): drop opd_rooms — the registry is the only home for a room (13 T7)`

---

## 6. CLOSE — appended as the phase runs

*(Findings as they arrive · the independent reviewer's report · mechanical verification: detached `pnpm verify` with the exit value read from a file, per-commit `git show --stat` against Files lists, frozen-path audit, clean tree · CI green by full SHA · the actuals row: tokens / agents / wall clock / catches · the ledger's ARCHIVE pass (v3 §5) · the token audit (v3 §9.2) · lessons bound for the ledger · the one-line roadmap amendment, which lands at close and not before — the 11h and 16a precedent.)*

**Nothing below this line is written yet. Per v3 §9.4, this phase may not record an actuals row and no session may report it as cheap before the independent review has returned** — 16a passed eleven green `pnpm verify` runs and eight green CI runs and then one reviewer found three patient-safety CRITICALs in it.
