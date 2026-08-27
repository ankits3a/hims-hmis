# Plan 13 — Resource Registry (kernel), and the OPD rooms move

**Written 2026-08-26 on the build host; amended the same evening after a second brainstorm (the amendments are marked *AMENDED* in place — DD4, DD12, T1, T6, T7, § 4A). ~~NOT APPROVED FOR EXECUTION — this document is the whole of what that session produced; execution is a separate session with its own approval.~~ APPROVED FOR EXECUTION by the owner 2026-08-26 evening, at `576a9b7`, and executed from this document in a separate session beginning ~22:40 UTC the same day (§ 3's spike answers and § 2's re-measure are that session's first writes; § 6's CLOSE is its last). The struck sentence stands as the record — it was true of the authoring session and its replacement is the approval it asked for. The two deploys inside this phase are separately authorised and the struck sentence does NOT cover them (DD12, T7's precondition).**

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

> **RE-MEASURED AT KICKOFF, 2026-08-26 ~22:40 UTC, before anything was generated (AGENT-RULES §6). NOT ONE NUMBER MOVED, and the re-measure is recorded rather than skipped because the rule's value is in the runs that come back identical too.**
> Migration head **`0030_charming_the_hood.sql`**, journal idx **30**, **31** `.sql` files · `git status` **clean**, branch `main`, HEAD **`8c64cad`** (the write-time `0055c06` plus the three Plan 13 docs commits `a7910e3` → `576a9b7` → `8c64cad`; no code moved) · `pgTable("resources"` and `resource_status_history` still **zero hits** · **NINE** `opdRooms` files, the same nine, byte for byte the list in the bullet below · `ALL_MANIFESTS` **twelve**, pinned at `manifests.test.ts:108`, leg 3 still reads *"exactly three enumerated, intentional ways"* at line 143 with `["ops","membership","formulary"]` at line 172 · permission census **77 = 63 + 14**, both pins present · SPA routes **25** · deploy seeds **SEVEN** · this document **64,449** bytes (was 64,116 before the § 4A rulings commit; the context-budget row below is re-derived: **≈16,112 tokens**, +83 against the estimate, which changes no decision).
> **Parallel-work fence: `ps -eo pid,cmd | grep -iE 'jest|vitest'` matched NOTHING — not even a self-match, because the probe ran as an argv-list without a shell wrapper carrying the literal string** (rule 20's own trap, avoided by construction rather than by reading past it). No second lane.


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

> **ANSWERED 2026-08-26 ~22:40 UTC, from the execution session, read-only against `hmis-prod-db-1` (user `hmis`, db `hmis`) via `docker exec … psql`. No agent. Every answer is inline under its question below. Headline: NOTHING MOVED — the write-time measurement still describes production exactly, and Q5 returns the answer that lets T6/T7 proceed as written.**

**Q1 — Has the room book changed?** `select id, code, name, floor, active from opd_rooms order by code;`
Answers three things at once: whether the two `SYN-` rows are still the whole book (write-time measurement), whether **any room now carries a non-null `floor`**, and whether **any room is inactive**. *Consequence:* both of those fields are mapped by the backfill and production currently exercises NEITHER — so if the answer is still "two SYN rooms, floor NULL, active true", **T6's fixtures must deliberately differ from production** (**A8** and **A9**, and §2.102: a fixture whose fields coincide has not exercised the code that distinguishes them). If real rooms HAVE been entered, say so and re-read the risk of T7's drop.

> **A1 — UNCHANGED. The book is still the two synthetic rows, and it still exercises NEITHER discriminating field.**
> ```
>              id             |  code  |        name        | floor | active
>  ----------------------------+--------+--------------------+-------+--------
>   01M0TEPMH5H83HWAYQ4AY5MS5C | SYN-R1 | SYN Consult Room 1 |       | t
>   01M0TEPMJ91B2CA5QR6N8CW46Q | SYN-R2 | SYN Consult Room 2 |       | t
>  (2 rows)
> ```
> Two rows, both `SYN-`-prefixed, **`floor` NULL on both, `active` true on both** — so production holds **zero** rooms with a floor and **zero** inactive rooms. **The consequence the question predicted is now binding: T6's fixtures MUST deliberately differ from production** (**A8** needs a room with a non-null `floor`, **A9** needs an inactive room), because a production-shaped fixture cannot discriminate either mutant. §2.102 exactly. No real rooms were entered between the write and the execution, so T7's drop carries the risk this document already priced.


**Q2 — Does every referrer resolve?** `select count(*) from opd_doctor_schedules s left join opd_rooms r on r.id = s.room_id where r.id is null;` and the same for `opd_queue_sessions`.
Answers whether the backfill's row-count guard can pass. *Consequence:* a non-zero count means an orphan exists behind a NOT NULL FK, and **T6 halts and reports rather than migrating** — the guard in `0032` must RAISE, not skip.

> **A2 — ZERO ORPHANS ON BOTH SIDES. The backfill's row-count guard can pass.**
> `opd_doctor_schedules` left-joined to `opd_rooms`: **0** unresolved. `opd_queue_sessions` (non-null `room_id` only): **0** unresolved.
> Row census re-measured in the same batch, and it matches § 2 line for line: `opd_rooms` **2** · `opd_doctor_schedules` **14**, all **14** carrying a `room_id` (the NOT NULL FK) · `opd_queue_sessions` **2**, **1** carrying a `room_id`.
> **This does not make `0032`'s guard optional.** It is a fact about production *today*, and the guard defends the book that exists *at apply time* — which, per DD12's deploy gate, is a later moment than this measurement.


**Q3 — Where is production?** `select max(id) from drizzle.__drizzle_migrations;` (or the deploy's own report) and `select to_regclass('resources');`
Answers that production is at `0030` and that nothing has claimed the table name. *Consequence:* a head other than `0030` re-bases every migration number in § 5 before T1 generates anything.

> **A3 — PRODUCTION IS AT `0030`, AND THE TABLE NAMES ARE UNCLAIMED. No re-basing: `0031`/`0032`/`0033` stand as written.**
> `select max(id), count(*) from drizzle.__drizzle_migrations` → **`max_id = 31`, `applied = 31`**. That serial counts *rows*, one per applied file, from 1 — so 31 applied rows are files `0000`…`0030`, and the local checkout holds exactly **31** `.sql` files (`ls apps/core/drizzle/*.sql | wc -l`). The two numbers agree; production and the build checkout are at the same head. **Read the row COUNT beside `max(id)` when checking this — `max(id)` alone is off by one against the file number and reads as `0031` already applied, which it is not.**
> `select to_regclass('resources'), to_regclass('resource_status_history')` → **both NULL.** Nothing has claimed either name.


**Q4 — Is `site_id` still one value with nothing behind it?** `select site_id, count(*) from events group by 1;` and `select to_regclass('sites'), to_regclass('facilities');`
Confirms the owner's Q3 ruling still describes the system at kickoff. *Consequence:* more than one distinct value, or a sites table appearing, re-opens DD3 with the owner before T1.

> **A4 — STILL ONE VALUE, STILL NOTHING BEHIND IT. DD3 stands and is not re-opened.**
> `select site_id, count(*) from events group by 1` → one row: **`main` — 349 events.** `to_regclass` on `sites`, `facilities` and `branches` → **all three NULL.** The owner's Q3 ruling still describes the system, so `site_id text NOT NULL DEFAULT 'main'` ships as DD3 declares it.


**Q5 — WHAT IS THE HOSPITAL DOING RIGHT NOW?** `select to_mode, at from operating_mode_changes order by seq desc limit 1;` — **the columns are `from_mode`/`to_mode`/`at`, ordered by `seq`** (`schema/ops.ts:54-66`), not `mode`/`changed_at`
**This is the gate on the destructive half of the phase and it is asked for that reason.** Production has never left `commissioning` (11f's CLOSE; `operating_mode_changes` was still empty at 11f close). *Consequence:* if the answer is still `commissioning` or an empty table, T6/T7 proceed as planned. **If production has entered `live`, T7's drop stops being a migration and becomes an owner-authorised operational act** — record the answer, do not proceed on the strength of this document, and route it.

> **A5 — THE TABLE IS EMPTY. PRODUCTION HAS NEVER LEFT `commissioning`. T6 AND T7 PROCEED AS PLANNED.**
> `select from_mode, to_mode, at, seq from operating_mode_changes order by seq desc limit 5` → **`(0 rows)`**; `select count(*)` → **0**.
> Zero rows is not an absence of information here: `schema/ops.ts:39` states it in as many words — *"`commissioning` is FIRST on purpose: it is what zero rows read as, and what a freshly-migrated deployment IS"* — and `getOperatingMode` is one `ORDER BY seq DESC LIMIT 1` over this ledger. **The gate on the destructive half of the phase is therefore OPEN, and § 4A item 4 does not fire.**
> **This answer has a shelf life and DD12 is why.** T7's precondition re-asks it *after* T6's deploy; the mode may change between now and then, and it is that later reading — not this one — that authorises `0033`.


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

~~**Nothing below this line is written yet. Per v3 §9.4, this phase may not record an actuals row and no session may report it as cheap before the independent review has returned**~~ — 16a passed eleven green `pnpm verify` runs and eight green CI runs and then one reviewer found three patient-safety CRITICALs in it. **The review has returned, twice. Written 2026-08-27.**

---

## 6.1 THE PHASE SHIPPED, AND BOTH DEPLOYS LANDED

**Ten commits, every one CI-green by full SHA.** Seven tasks as written, one docs commit for the spike, two remediation commits for the reviewer's findings.

| | commit | CI |
|---|---|---|
| spike answers + §2 re-measure | `710af65` | (docs) |
| **T1** schema + `0031` | `e913845` | GREEN 686s · run 33021449575 |
| **T2** the kind seam | `c8a34e6` | GREEN 831s · run 33022864624 |
| **T3** the write surface | `f4473ac` | GREEN 749s · run 33036418839 |
| **T4** the read surface | `a6add31` | GREEN 764s · run 33037179412 |
| **T5** the read routes | `e50e07b` | GREEN 833s · run 33037821225 |
| **T6** the move + `0032` | `37eb481` | GREEN 859s · run 33038946417 |
| **T7** the drop + `0033` | `a005775` | GREEN 782s · run 33042088721 |
| CLOSE remediation, pass 1 | `6bff729` | GREEN 767s · run 33043841354 |
| CLOSE remediation, pass 2 | `673a8ea` | GREEN 793s · run 33044826256 |

**DEPLOY 1 — `0031` + `0032`, owner-authorised 2026-08-27, `deploy.sh` exit 0**, 8/8 steps, 9/9 services, edge gate green. Production went **31 → 33** applied migration rows. Verified immediately after, read-only:

- both rooms in `resources`, **ids preserved byte for byte** (`01M0TEPMH5H83HWAYQ4AY5MS5C`, `01M0TEPMJ91B2CA5QR6N8CW46Q`), `attributes = {}` on both (floor was NULL — **not** `{"floor": null}`), `status = 'available'` on both, `site_id = 'main'`, `created_by`/`created_at`/`updated_by`/`updated_at` copied verbatim;
- two `resource_status_history` rows, `from_status` NULL, `actor_id = 'migration:0032'`, reason naming the migration, **and no `resource.registered` event** — exactly as `0032`'s header says it chose;
- **14 of 14** `opd_doctor_schedules` and **1 of 1** non-null `opd_queue_sessions` resolving through `resources`; both `room_id` foreign keys naming `resources` in `pg_constraint`.

**T7's PRECONDITION, run read-only against production after that deploy and before `0033` was authored** (DD12's gate, and the reason the file split buys anything at all): 33 applied rows · `resources` kind=`room` count **2** = `opd_rooms` count **2** · **0** rows unmigrated · both FKs on `resources` · **`operating_mode_changes` EMPTY.** Production has still never left `commissioning`, so **§ 4A item 4 did not fire** and the drop stayed a migration rather than becoming an owner-authorised operational act.

**DEPLOY 2 — `0033`, separately owner-authorised 2026-08-27, `deploy.sh` exit 0.** Production **33 → 34**. `to_regclass('opd_rooms')` is **NULL**; the two rooms, all 14 schedules and the one session are unchanged and resolving; both foreign keys name `resources`; `/api/health` through the edge answers `200 {"status":"ok","db":"ok","worker":"ok"}`. **`opd_rooms` no longer exists in this hospital.**

---

## 6.2 FINDINGS

### The Assertion Book's own rows — four corrections, which is the instrument working

The plan's standing note says a discriminating input is a PREDICTION until somebody runs it, and asks the executor to correct rows and record the correction. Four needed it.

**F1 — A2 claimed a kill it does not get. `registry.mutant-a2b.ts` SURVIVED, 17/17 passed.**
A2's row says the assign → release → re-assign leg *"kills both"* the named mutant and its sneakier sibling — an `assignResource` that sets `since` only when it is currently null (`since: existing.since ?? at`). **It does not.** After a CORRECT release, `since` is always null, so `existing.since ?? at` always evaluates to `at`: through the shipped write path the sibling is an EQUIVALENT mutant, reachable only from a state the shipped release cannot produce. **A fixture built entirely through the guarded path can never construct the input that discriminates it** — which is A6's lesson arriving four rows early. Corrected in-task (AGENT-RULES §3 branch (b)): one added leg builds the inconsistent row **by RAW SQL**, exactly as A6 builds its cycle, and the mutant then DIED (`Expected: 2026-08-26T12:00:00.000Z · Received: 2026-08-26T10:00:00.000Z`).

**F2 — A11's fixture cannot be built the obvious way, and the obvious way tests the wrong statement.**
A11 needs an `opd_doctor_schedules` row whose `room_id` names no room, which is constructible only by dropping the foreign key first. Do just that and leave it dropped, and the mutant fails at `0032`'s own `DROP CONSTRAINT` — a fixture artefact, not the failure A11 is about. The fixture must **re-add the constraint `NOT VALID`**, which leaves it PRESENT (so the migration's drop succeeds) while tolerating the pre-existing bad row — the state a live box reaches after an unguarded repair. With that correction the row measures what it claims: shipped raises `opd_doctor_schedules has 1 row(s) whose room_id names no opd_rooms row; refusing to migrate a broken room book` and writes **0 rooms**; the mutant emits a NOTICE, writes **2 rooms**, and fails later at the FK ADD naming a CONSTRAINT.

**F3 — A12's mutant is not a hypothetical. It is `drizzle-kit generate`'s DEFAULT OUTPUT.**
The plan calls the CASCADE mutant *"one word long"*, implying the bare drop is the natural thing and CASCADE the deviation. **It is the other way round.** `pnpm db:generate` emitted `DROP TABLE "opd_rooms" CASCADE;` and the hand-edit that ships is the REMOVAL of that word. That inverts which case takes effort and makes A12 the most valuable row in the phase rather than a formality. Measured, at `0031` with the repoint not applied: CASCADE succeeds, `NOTICE: drop cascades to 2 other objects`, and **both `room_id` foreign keys vanish — 0 surviving**, leaving a live hospital's schedule book unconstrained. The bare drop refuses, names both dependent constraints, and leaves table and keys untouched.

**F4 — A13's acceptance criterion is literally unmeetable and should be restated.**
A13 says the mechanical instrument is a grep returning *"zero hits outside `apps/core/drizzle/`"*. It returns **14**, every one a COMMENT — including the paragraphs in `schema/resources.ts` that carry this phase's whole reasoning about why the registry exists. Stripping them to satisfy a grep would delete the argument to save the assertion. **The criterion is restated as: zero NON-COMMENT references**, which is what the row actually means and which holds — verified, and independently guaranteed by typecheck (an `opdRooms` identifier would not resolve) and by the suite (an `opd_rooms` SQL string throws).

### The independent reviewer — two passes, no CRITICAL, seven MAJOR across both

**Pass 1** read all eight commits together plus the live database. **No CRITICAL.** It confirmed by execution — not by inference — that `0032`'s three guards RAISE rather than skip, that the whole migration runs in one transaction so a RAISE rolls the file back, that guard 2 asserts ids-preserved by left-join rather than trusting a count, that the production backfill was correct column by column, and that `0033` was safe to apply. It hunted specifically for a value where the DD9 facade and the migration disagree and **found none**.

| | finding | disposition |
|---|---|---|
| **M1** | **DD6's occupancy invariant was enforced on `assignResource`/`releaseResource` only.** `changeResourceStatus` validated the status against the kind's vocabulary and never looked at the triad, so three states were reachable: an occupied bed with nobody in it; an occupied bed reading `available` to **the exact index documented as "the board: every bed that is free"**; and a retirement that walked straight past `retireResource`'s own guard. | **FIXED** `6bff729`, four legs |
| **M2** | `kinds.ts` promises in capitals that a duplicate kind is a BOOT error. `collectResourceKinds` had **no caller outside its own test**, so a duplicate-`bed` deployment would have booted fine. The cited precedent, `collectProviders`, *is* called from a live path. | **FIXED** `6bff729` |
| **M3** | **A8, A9, A11 and A12 have no shipped regression.** They are mutants of SQL, and the shipped A8/A9 legs test the DD9 MAPPER, not the backfill. No test anywhere applies `0032` to a database with rows in `opd_rooms` — the per-worker databases are empty when it runs. **The `floor IS NOT NULL` and `active = false` branches have therefore never executed in any environment, and after T7 they never can.** | **RECORDED — not fixable, see 6.4** |
| **M4** | `errors.ts` exports `resourceHttpStatus` so no controller keeps a private copy of the mapping, citing the Plan 09 escape by name. The controller kept a private copy. | **FIXED** `6bff729` |
| **M5** | Three unindexed full-table reads: `subtreeHeight` scanned the whole table once per level **inside the caller's write transaction**; `resourceTree` and `resourceBoard` fetched every matching row to filter roots in JS — the board behind a live route. | **FIXED** `6bff729` |

**Pass 2 reviewed the remediation adversarially and found two MAJOR defects in it. Both were real and both were introduced by the fix.**

| | finding | disposition |
|---|---|---|
| **R1** | **THE FOURTH DOOR.** Pass 1 closed the invariant on `changeResourceStatus` and left `createResource` open: `status` is a public optional input and `"occupied"` is in a bed's vocabulary, so a resource could be **REGISTERED** occupied with the triad NULL — M1's first bullet, through a different function. | **FIXED** `673a8ea`, one leg |
| **R2** | **THE M1 FIX OPENED A 500 AT THE MASTERS COUNTER.** Making `changeResourceStatus` refuse an occupied resource made `already_occupied` reachable from `updateRoom({active:false})`; `OpdError` has no code for an occupied room, so `asOpdError` rethrew and `opd-masters.controller.ts`'s `toHttp` rethrew. **That is Plan 09's `MembershipError` escaping `billing.controller.ts`, one phase later, introduced by the commit that fixed a different defect** — and it is the cautionary tale this plan's own DD14 and `errors.ts` header cite. | **FIXED** `673a8ea` |

A targeted third exchange confirmed all four fixes and found nothing new: R1's guard has no false positive and `createResource`'s default can no longer equal `occupied` (m4 refuses that declaration at boot); R2 maps `already_occupied` to **409**, shadows nothing (every error class in that chain extends `Error` directly, so no clause captures another's), and adds no import edge; m4 refuses none of the kernel five; m5's replacement paragraph is true of the shipped code.

### Minor findings, recorded and not fixed

- **`0032`'s collision guard names ONE collision.** `SELECT string_agg(...) INTO collision ... GROUP BY ... HAVING count(*) > 1` returns one row per colliding GROUP and plpgsql `SELECT INTO` keeps the first. It still RAISEs correctly; the operator fixes one, re-runs, hits the next. **Not edited: `0032` is applied to production and its hash is in `drizzle.__drizzle_migrations`.**
- **`0032` guard (c) checks id collisions, not code collisions** against a pre-existing `resources` row at the same `(site, kind, lower(code))`. Unreachable under the deploy ordering actually used. Same reason not edited.
- **`changeResourceStatus` preserves the invariant but does not REPAIR it.** A row with `occupant_ref` set while status is not the occupied one moves freely with a stale occupant. Proved to be a correct inductive invariant by the reviewer: from a consistent row no transition produces an inconsistent one. Unreachable through the write path after `673a8ea`; `releaseResource` is the repair; **production has no such row (verified).**
- **The worker's registry does not call `collectResourceKinds`.** Nothing installed there declares `resourceKinds` today. **Plan 15 must know**: its mini-OT manifest will likely carry subscriptions and therefore be installed in the worker, which would then boot without the refusal the API now has — the API-and-worker-differ shape `manifests.test.ts` exists to police.
- `app.module.ts` deep-imports `./kernel/resources/kinds` rather than the module index, which `index.ts`'s own header forbids. Defensible at a composition root; the file says otherwise.
- `resourceHistory`'s `limit` returns the OLDEST rows. Pinned deliberately by a named test; recorded because a board asks the opposite question.
- `0032` writes history ids as `'MIG0032-' || id` rather than ULIDs. Self-documenting, and nothing constrains it.
- `updateRoom({active:true})` forces the kind's `initial`. **The `active` toggle is the shape that has to go when the registry gains a second writer** — written into `masters.ts` rather than left to be discovered.

---

## 6.3 MECHANICAL VERIFICATION

- **`pnpm verify` exit 0**, detached, exit value read from a file, on every task and on both remediations. Final: **apps/core 219 suites / 1941 tests · apps/web 43 test files · packages/contracts 4 suites / 21 tests.** Derived pre-phase baseline 214 / 1863 — the phase adds **5 suites and 78 tests and deletes none** (AGENT-RULES §4).
- **Per-commit `git show --stat` against each task's Files list: ALL SEVEN MATCH EXACTLY.** No file touched that its task's list does not name; no file named and not touched. Confirmed independently by the reviewer.
- **Sixteen mutants built**, each a separate scratch file beside its source, each run ISOLATED with counts quoted. **Fifteen DIED on first run; `a2b` SURVIVED and DIED after F1's correction.** The four migration mutants (A8–A11) were run against scratch databases built by applying `0000`–`0031` and seeded with a fixture that **deliberately differs from production** — one room with `floor = '2'`, one INACTIVE — because spike Q1 measured that production holds zero of each and a production-shaped fixture is blind to both mappings (§2.102).
- **All scratch deleted before final counts.** `git log --stat 8c64cad..HEAD` contains **no `*.mutant*`, no `.log`, no `.exit`, no drill file**. Every scratch database (`p13_base`, `p13_run`, `p13_ok`, `p13a`, `p13b`) dropped; `select datname from pg_database where datname like 'p13%'` returns nothing. Working tree clean.
- **Frozen-path audit:** no frozen path in any diff. `truncateAll` gained both new tables in the `patients`/`opd` statement at T1 — parent and children in one statement, correct at T1 and at T6 — and lost `opd_rooms` at T7 in the same commit as `0033`.
- **`_journal.json` never hand-edited** (AGENT-RULES §6): 34 entries, `idx` monotonic 0–33, one per `.sql` file, generator-appended in the three feature commits. No `drizzle.__drizzle_migrations` row inserted or deleted by hand.
- **Censuses moved exactly as DD11 predicted and no others:** manifests **12 → 13** (appended in order; leg 3's assertion AND its title moved from "three" to "four" with the `(1d)` block) · permissions **77 → 78 declared, 63 → 64 held, 14 not-yet-modelled UNCHANGED** · SPA routes **25**, deploy seeds **7**, API prefixes **1**, `packages/contracts` **4/21** — all untouched.

---

## 6.4 THE ACTUALS, AND THE STOP-LOSS WAS BREACHED

| | |
|---|---|
| stop-loss | **660,000** (§ THE LANE) |
| **reviewer tokens, measured** | **604,655** — pass 1 **175,209** · pass 2 **205,365** · targeted check **224,081** |
| main-session tokens | **UNMEASURABLE FROM INSIDE A SESSION** — runbook **O3**, open since Plan 11e |
| agents | ONE, invoked three times |
| commits / CI runs | 10 / 10 green by full SHA |
| deploys | 2, each separately owner-authorised |
| mutants | 16 built, 16 died |
| catches | 4 Assertion Book corrections · 5 MAJOR (pass 1) · 2 MAJOR (pass 2) · 0 CRITICAL |

**The reviewer alone consumed 92% of the whole phase's stop-loss, so the phase breached it.** Stated plainly because §9.4 exists to stop a session reporting a phase as cheap, and this one was not.

**And the shape of the breach is the finding: A RESUMED REVIEWER GETS MORE EXPENSIVE EVERY TIME, WHILE THE WORK IT DOES SHRINKS.** 175,209 → 205,365 → **224,081**, against a workload that went from *review eight commits and a live database* to *review one seven-file diff* to *answer four yes/no questions*. The third invocation cost **28% more than the first and did perhaps 5% of the work.** v3 §9.5 says a resumed agent starts full and the plan's own stop-loss arithmetic budgeted for it — what neither anticipated is that the cost keeps CLIMBING, because each resume replays a transcript that now contains the previous review IN FULL. The budgeted review term (450,230) was set from 16a's fresh pass plus 09a's one resume; it is short by a third against two resumes.

**Was it worth it?** The second pass found two MAJOR defects **in the first pass's own remediation**, one of which (R2) re-introduced the exact 500-at-the-counter defect this plan cites as its cautionary tale. A phase that had stopped after one pass would have shipped it. The plan's argument for budgeting two passes — *"a remediation on that path is unreviewed code on the same path"* — is now evidenced rather than asserted, and it argues for a THIRD pass that this phase deliberately did not take, substituting a bounded four-question check instead. **That substitution is the reusable move**, not the extra pass.

---

## 6.5 LESSONS BOUND FOR THE LEDGER

1. **A MUTANT OF SQL NEEDS A TEST THAT RUNS THE SQL.** Four Assertion Book rows (A8, A9, A11, A12) named mutants of a migration, and the shipped tests exercise the application code either side of it. They were discharged by a scratch-database drill in the executing session — `0000`–`0031` applied by `psql`, a template snapshot, one mutated file per row — and that evidence lives only in a transcript. **A migration whose branches never execute in any environment cannot be regression-tested after its source table is dropped.** Where a backfill's branch matters, the phase that writes it must either ship a migration-level test or accept, in writing, that its only evidence is one session's drill.
2. **"ENFORCE IT AT THE WRITE PATH IN ONE PLACE" IS ONLY SOUND WHEN THERE IS ONE PLACE.** DD6 said one place; there were four write entry points and a facade on top. The first remediation closed one door and the reviewer found the fourth. **Count the doors before writing the sentence.**
3. **A GUARD ADDED IN THE KERNEL CHANGES WHAT A MODULE'S CONTROLLER CAN RECEIVE.** Making `changeResourceStatus` refuse made a new error code reachable from an OPD route whose `toHttp` had never seen it — a 500 introduced by a correctness fix. **When you add a refusal to a shared function, walk every caller's error mapper in the same commit.**
4. **THE GENERATOR'S DEFAULT CAN BE THE DANGEROUS FORM.** `drizzle-kit generate` emits `DROP TABLE … CASCADE`. A plan that treats the safe form as the default and the dangerous one as a deviation has the effort backwards, and the review that catches it is the one that reads the generated file rather than the plan's description of it.
5. **A FIXTURE BUILT THROUGH THE GUARDED PATH CANNOT TEST THE GUARD.** A6 says this about the tree reader; F1 found it true of `since`, and F2 of the migration's precondition. **Raw SQL is the instrument, and a row that needs it should say so.**
6. **RESUMING A REVIEWER COSTS MORE EACH TIME.** See 6.4. Budget a resume at ~1.3× the previous invocation regardless of how small the question is, and prefer a bounded question list over an open re-review once the diff is small.
7. **RE-MEASURING AND FINDING NOTHING MOVED IS WORTH RECORDING.** §2's kickoff re-measure returned every number unchanged. That is not a wasted step: it is what makes the three numbers the launch prompt had wrong (§2, written 24 hours earlier) a measurement rather than a coincidence.

---

## 6.6 THE ROADMAP AMENDMENT

> **Plan 13 — Resource Registry (kernel) — CLOSED AND DEPLOYED 2026-08-27.** `resources` + `resource_status_history` are live; OPD's rooms are registry rows and `opd_rooms` is dropped. The kind seam is open for Plan 15 (`theatre`, `device`), Plan 16 (`store`) and Plan 17 (`bench`, `analyzer`) with no kernel edit. **The hard gate before the IPD cluster is discharged.** Carried forward to Plan 15: the worker's registry does not collect resource kinds; instrument sets are NOT a registry kind (§ 4A item 2, owner-ruled); `class` and its tariff link land with the IPD cluster (§ 4A item 1); master-data change control is its own phase after the IPD cluster and cannot be scheduled before runbook **O1** closes (§ 4A item 3).
