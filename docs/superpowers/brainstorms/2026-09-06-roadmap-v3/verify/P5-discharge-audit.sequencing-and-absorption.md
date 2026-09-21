# Verify — P5 discharge-audit · lens: SEQUENCING AND ABSORPTION

Target: `wf/design/P5-discharge-audit.md`. Read against ROADMAP v2 §0c–§8 (`docs/superpowers/2026-09-06-ROADMAP-v2.md`, RM), the index §3 (`00-INDEX-AND-SYNTHESIS.md:55-108`, IDX), the IPD gate (RM:391-409), CLAUDE.md:36-42, and **`origin/main` measured at `41a4be4` on 2026-09-08 ~17:30 UTC** (the checkout `main-ro` is at `ff07cbc`; everything below that is newer was read with `git show origin/main:<path>`). The design itself was written against `b04cbd9` (09-06); five merges since then change its baseline (R1, R13, R14). Orchestrator state read from `/opt/hmis-lanes/.orchestrator/` (read-only). PR state via `gh pr list/view`.

**Verdict: needs-amendment.** No kill. The spine holds on this lens: nothing behind the IPD gate is built (E4 authored only once 41 has been live 30 d — IDX:86, RM:419-420); the only inference (E4-M5) is last and behind DPIA v0.2 + R-126 + 12a (RM:428); E3/E5 wait on the lab's G6 and on signed rulings; the letters `15e` and `11l` are free on `origin/main` (grep: 0 hits); every RM line the design cites (RM:34, 183-191, 334-339, 341-342, 375, 405, 415-420, 428, 469-470) says what the design says. What fails is under the spine: one milestone re-proposes work `#157` merged two days ago under another file name; the human-act bill for the mini-OT is half the runbook's; the pilot depends on a money fact the ruling table waives; the lane the calendar uses is allocated elsewhere by RM §2 and is not free; one calendar claim is false by the design's own arithmetic; eight of CLAUDE.md's everyone's-files are touched by an epic that says "none hard"; one E4 acceptance names a kernel primitive that a merged PR says does not exist; and two acceptance thresholds measure a console log. 11 amendments, 9 notes, 11 missing edge rows.

---

## 1. What holds (checked, so the amendments are read in proportion)

- E4/E5 starts are named human acts with categories (§5 table); the IPD gate binds E4 only; E4-M5 (the Drafter) is behind DPIA v0.2 + R-126 + `complete()` + 12a and is last (RM:405,428; DPIA:3). No "build behind the gate".
- The RM §5 "not this quarter" list is respected for 12a, 21, 28a/28e, 29/31, and 44 (RM:414-428); the design says so in §6 with line cites, and its cites are accurate.
- The gate events the design lists for G3 all exist on `origin/main` (`gate.overridden`, `timeout.halted`, `count.mismatch`, `sod.violation_blocked`, `lab.sod_violation_blocked`, `lab.report_print_blocked`, `lab.tube_mismatch_flagged`, `imaging.critical_overdue`, `break_glass.used`, `emergency_elevation.used` — each ≥ 2 files); `sla.breached` has 3 files and none is a reader; `charge.orphan_flagged` is OPD-only (`billing/daily-close.ts:295-304`). §0.6's "no reader" stands.
- The `handoffDocumentId = newId()` ULID (`ot/recovery.ts:525`) still has no body; `daycare.discharged` still carries `{encounterId, patientId, bayResourceId, at}` (`ot/events.ts:85-87`). E1-M1/M2's gap is real.
- P15:339 did promise "DD10 + follow-up recall task via the notifications/scheduler seam"; the recall gap is real (but see R13 for what #164 did to the comment).

---

## 2. Refutations

### R1 — E1-M3 re-proposes what `#157` merged, under a new file name — **amend**
Design (E1 Build; E1-M3): "`ot` rows in `standup:check`", "`docs/runbooks/mini-ot-go-live.md`", "module keys 4 → 5 · ≥ 8 rows"; §0.5 "no `ot` rows in `standup:check`", "no runbook (`docs/runbooks/` = four files, none OT)".
Evidence on `origin/main`: `docs/runbooks/ot-go-live.md` exists (#157 `b2baade`, merged 2026-09-07) with §0 bite · §1 preconditions · §2 activate · §3 publish · §4 privileges · §5 unit · §6 people · §7 money · §8 not covered · §9 why — and **no** §Seat walk, §Harvest or §Executed. `apps/core/scripts/standup-check.ts:458-522` has an `ot:` key with six rows (`ot_approval_types_registered`, `ot_theatre_present`, `ot_workflow_definitions_active`, `ot_definitions_published`, `ot_surgeon_held`, `ot_anaesthetist_held`); module keys are six (`hospital`:138, `lab`:295, `pharmacy`:407, `ot`:458, `pcpndt`:544, `radiology`:595), not four. Nine runbooks exist (CONTEXT:53).
Fix: E1-M3 becomes a delta — append §Seat walk / §Harvest (six rows) / §Executed to `ot-go-live.md`; add only the rows absent (`ot_incharge`, `recovery_nurse`, `daycare_coordinator` held; package priced; relay reachable); acceptance "rows 6 → ≥ 11 at rebase". Never create `mini-ot-go-live.md` (CONTEXT:45 rule 2: name what already occupies the name).

### R2 — E1's human-act bill is half the runbook's: six roles, a Class-A ceremony, and a credentialling draft — **amend**
Design: G4 "OT in-charge, recovery nurse, anaesthetist *named*"; NEW-P5-2 names the same three; the only ceremony named is "the MS publishes the DD6 drafts" (Class B, R-247).
Evidence: `ot-go-live.md` §6 lists **six** roles with what stops without each (`surgeon` — no case can be booked; `anaesthetist`; `ot_incharge`; `daycare_coordinator` — no one schedules or discharges; `ot_nurse`, `recovery_nurse`); §0 rows 1–3: `daycare_case` and `ot_gate` are **Class A** ("two approvals and a distinct activator"), and `privileges` must be **drafted** and published by the MS — "which surgeon may do which procedure is *this* hospital's fact … an OT with everything else done still cannot pass a case through its gate"; §1 "THE TRAP WITH NO WAY OUT — the owner must not be the drafter" (`workflow_drafter_activator`; `workflow.definitions.draft` is `opd_admin` only, activate is `owner` only). P15:201: the MS (`anand.rao`) and `owner` exist on production, so the pair is satisfiable — but `opd_admin` must draft and `department_head` has zero holders.
Fix: NEW-P5-2 lists six names; E1-M3's human act adds (a) the Class-A activation ceremony (drafter `opd_admin` ≠ activator `owner`, MS approves) and (b) the `privileges` draft (surgeon × procedure — the MS's fact). Edge rows 7 and 28 cover "drafts unpublished" and "`ot_incharge` unheld" only; see §3 for the two missing.

### R3 — E1-M5 depends on a money act the ruling table waives — **amend**
Design: G3 "package tariff (placeholders on UAT; O6 for a live invoice, never the pilot — 'discharge is never blocked on money', P15:172)"; ruling row O6 "unblocks E1-M5's first *live* invoice, not the pilot".
Evidence: `ot-go-live.md` §7: "The day-care **packages** and the **implant** service must exist and be priced in the active tariff version, with their GST categories set. An unpriced package fails **at booking, in front of a patient**". P15:172 (DD12) is about *discharge*, not booking. E1-M5 is "first 20 real discharges" on production — twenty real bookings first. The lab prices its catalogue on production in week 3 without O6 (RM:336), so pricing precedes G7; but the *number* is the owner's/CA's (R-255), not a placeholder.
Fix: E1-M5's gate row gains "day-care package + implant prices in production's active tariff (money; R-255; the owner's number, before the first real booking)"; O6 stays for the CA signature and the exit.

### R4 — The calendar's lane is allocated elsewhere by RM §2 and is not free — **amend**
Design §7: "Weeks 3–5 — E2 (11l) by **F** … weeks 6–8 — E1-M1/M2 by **F**".
Evidence: RM:334-335 (wk 1–2) F = FD-25 backlog, printing v2, FD-25 close review; RM:337 (wk 4–6) "**F closes its lane after the FD-25 close; F's capacity joins S for the pilots**". No RM row gives F a build after week 2. F's actual state: `lane/front-desk-fd25` +70 commits, local only, no PR (CONTEXT:54); last orchestrator heartbeat `front-desk.status` 2026-09-05 06:52; MERGE-TRAIN.md: "MERGE main INTO IT, NEVER REBASE" (a stale-branch shape). Two migration serials it took are already used on main (CONTEXT:41).
Fix: say "this re-plans F for weeks 3–8" and cost it against the FD-25 landing, or give E2 to **L** (on S from week 3, RM:336 — the lane RM frees) and E1-M1/M2 to whoever finishes printing v2. Either way the departure from RM §2 is stated, not implied.

### R5 — "The sheet is live before the lab pilot's harvest week" is false by the design's own numbers — **amend**
Design §7: E2 starts week 3; "The sheet is live before the lab pilot's harvest week (RM:337)".
Arithmetic from the milestone table: M1 4 d + M2 3 d + M3 3 d + M4 2 d = 12 lane-days → Tuesday of week 5 at best; the lab pilot window opens **week 4** (RM:337). Add the two close passes (RM:433 "the two-pass discipline stays") and a production deploy by the owner's hand, weekly (RM:342) → on production week 6. The lab harvest runs on prose (`docs/runbooks/lab-go-live.md:207-218`) for at least two of its three weeks.
Fix: drop the claim, or start E2-M1 in week 1–2 by a named lane, and make "the lab's harvest rows on the sheet by the pilot's day N" E2-M4's dated acceptance.

### R6 — E2 "Deps: none hard … one lane" touches eight of the everyone's-files — **amend**
Design E2: "`kernel/ops` is everyone's (CLAUDE.md:38) — one lane"; E2-M2 names `router.tsx` and `caddyfile-parity`; nothing else.
Evidence: a daily job registers in `kernel/worker/jobs.ts` (`scheduler.register({name, dailyIst})`, :199-215) and moves `jobs.test.ts`'s census — its own comment (:331-350): "a task that registers a job edits `jobs.ts`, FOUR censuses and `alerts.yml`, and no Files list has yet named all six"; `ops_fact_sheets` → `kernel/db/schema/index.ts` + a drizzle serial taken at rebase (CLAUDE.md:39-40); `ops.fact_sheet.read` → `kernel/ops/manifest.ts:27-29` (three `ops.*` strings today) + `scripts/seed-roles.ts` + five pinned counts in `test/seed-roles.test.ts` (:886 161 permissions, :1102 308 pairs, :1120 141, :1191 147, :1195 the identity); the template key → `kernel/notify/templates.ts`; E2-M3's lint → a CI guard over every module's `errors.ts`/`events.ts`; E2-M5 → `billing` (imported by every lane, CLAUDE.md:41; and see R8). CLAUDE.md:36-40 names all of these.
Fix: E2's Deps row lists the files and the rule: a rebase slot on the train, counts re-measured at rebase by landing and reading the failures (MERGE-TRAIN.md's practice), one migration serial at rebase.

### R7 — E2-M3's lint can redden `main` on landing; the ordering with the radiology lane is unstated — **amend**
Design E2-M3: a lint that fails CI when a 403 authority code has no event twin; "(today ≥ 1: `device_not_licensed`, `aerb/errors.ts:19`)"; "radiology lane adds the one event".
Evidence: the first finding is a *live* gate (RM:34; 18c deployed at `399f92c`); the twin is assigned to another lane (radiology on `lane/formf-backfill-clock`, CONTEXT:54). If the lint merges first, `main` is red and "A red `main` freezes merges" (CLAUDE.md:19). Every open lane carrying an unmerged `*.blocked|*.overridden|*.refused|*_flagged` `defineEvent` goes red at its next rebase.
Fix: sequence it — `aerb.acquisition_refused` lands first (or the lint lands with a dated allowlist that must be empty at E2-M3's close), and the landing is announced on the train. Edge row 11 covers the after-state, not the landing.

### R8 — E2-M5 as "a new billing function" creates an import cycle — **amend**
Design E2-M5 / D16: "the orphan scan widened to lab/imaging/pharmacy as a new billing function, no signature change".
Evidence: `billing/daily-close.ts:8` imports `listVisits` from `../opd`; billing imports opd (13), tariff (24), patients (20), membership (11), partners (2) — never lab, radiology, pharmacy. The reverse edges exist: `lab` imports `../billing` in 13 files, `ot` 10, `pharmacy` 5, `radiology` 3, `opd` 5. A billing function that reads lab/imaging/pharmacy orders adds `billing → lab` while `lab → billing` exists. D16 covers signatures, not a new dependency edge into the module every lane imports.
Fix: each module exposes `unbilledOrdersFor(day)` on its `index.ts`; the join lives in `kernel/ops/fact-sheet.ts` (the reader), and `charge.orphan_flagged{feeKind}` is emitted from there or from each module — not from billing.

### R9 — The notify channel is a procurement plus a kernel build, and two thresholds measure a console log — **amend**
Design: D6 "by email/in-app until WABA/DLT"; E1-M5 "recalls · `notification.sent` per `daycare_followup` row · ≥ 95 %"; E2-M4 "delivery 07:00 IST · `notification.sent` · 7/7"; NEW-P5-3 names WABA/DLT for "E1-M1's channel; E2-M4's".
Evidence: `kernel/notify/adapters.ts:11` `channel: "whatsapp" | "sms"` — no email, no in-app; `adaptersFor` (:56-66) has one provider case, `console`, whose `send` logs and returns `providerMessageId: null`; the file header (:4-8): "`notification.sent` is defined on exactly that basis … a statement about THIS GATEWAY, not about delivery"; `notify/events.ts:24` pins `channel: z.enum(["whatsapp","sms"])`. So both thresholds are green with nobody receiving anything, and "email/in-app" is a kernel change (enum, adapter case, event payload) nobody has scheduled.
Fix: NEW-P5-3 is a gate on E1-M5's recall row and on E2-M4, not only on "the channel"; until a provider exists the artefact is the `notifications` row + the printed slip (E1) and a dated read line (E2), and `notification.sent` is not a delivery parameter. The measurability lens will say the same; on this lens the point is the gate is missing from the rows that need it.

### R10 — E4-M3 names a primitive that does not exist and that D1 says 44 will not have — **amend**
Design E4-M3: "bed `dirty → available` · registry · via `task.verified`"; "`pass.issued`/`pass.scanned` · 1 each"; row 19 "`undertaking.signed`"; D1 "no tasks engine before 44".
Evidence: `task.verified`, `pass.issued`, `pass.scanned`, `undertaking.signed`, `patient.discharged`, `draft.provenance`, `report.signed`: **0** files each in `apps/core/src` + `packages` (the design concedes the last two in §0.1). `resource.status_changed` exists (2 files). #164 (`a0148ad`, merged) recorded "there is no task primitive in the kernel" (CONTEXT:46). Turnover-by-task is Plan 19a's engine (IDX:60,89 "19a tasks"), which RM:414-415 excludes ("no consumer opens this quarter"). Passes are 41's object (IDX:81 "wristbands/passes").
Fix: E4-M3 says which — bed release is `resource.status_changed` by a named housekeeping human with no engine, or E4-M3 depends on 19a (then name 19a, behind RM §5). Passes: "on 41's pass object" in the Deps column, not only "41 live 30 d" as a gate.

### R11 — `death` rides a plan two plans behind E4 and is not carried as NOT MODELLED — **amend**
Design: E4 gates "43b for `death`"; edge row 21 branches to 43b's MCCD chain; E4-M2..M4 carry `pharmacy_returns` as `NOT MODELLED → runbook` but not `death`.
Evidence: 43b is a sub-plan of 43 (IDX:85), which needs 20 and 42a; 42a needs 20, 41, 16d (IDX:83); 16d is excluded this quarter (RM:424 "no 16d (ward pharmacy — IPD)"). IDX:86 lists 43b as 44's need, so E4's first cut cannot wait for it without waiting for nursing.
Fix: `discharge_type: death` = `NOT MODELLED → runbook (MCCD by the certifier, R-111; no gate pass)` in E4-M2's acceptance, the way `pharmacy_returns` is carried.

### R12 — Roles named as holders/readers that `seed-roles.ts` does not have — **note**
`quality_manager` (G2/G3/G5 reader; E5-M3 "QM paged"), `discharge_coordinator` (E4-M6, IPD:46), `rmo` (E4-M2), `department_head` (P15:201: zero holders): 0 hits as `roleKey:` in `scripts/seed-roles.ts`. Each is a change to an everyone's-file and a name the owner fills. `duty_manager`, `medical_superintendent`, `daycare_coordinator`, `opd_admin`, `ot_incharge`, `recovery_nurse` exist. For this quarter only the QM matters: the sheet's second reader is a role that does not exist — the owner at 07:00 is the reader until it does.

### R13 — Two baselines moved under E1-M1 — **note**
(a) `recovery.ts:549` "markAbsconded's comment promises [a recall]": on `origin/main` after #164 the comment (:553-565) says the opposite — "THIS SAID 'AND A RECALL TASK', AND NOTHING HERE MAKES ONE … the `ot_incidents` row … is the recall register's input on the day somebody builds one". E1-M1's recall as a `notifications` row does not contradict #164 (a notification is an existing primitive, `enqueue.ts:66-73`; a task is not) — say so in one line, or a session reads E1-M1 as re-opening what #164 closed. (b) D10 "next working day on holidays": `holiday` has **0** hits in `apps/core/src` + `packages` — a holiday calendar is a configuration surface that does not exist; RM rule 4's config-before-guard shape, with no row, no owner, no edge case.

### R14 — UAT is a merge-train fact, not "week 2"; the freeze is never named — **note**
Design: "Deps: 11i T3/T5 (UAT, week 2)"; no mention of #117–#122, the freeze, or the accidental deploy's ratification (grep of the design: 0 hits for `#117|#118|held|freeze`).
Measured today: #117 merged (`91c34fc`), #118 merged (`41a4be4`, 2026-09-08 17:29 IST), the train is updating #119 (`train-11i.log` 11:59 UTC) — the owner's line appears to have arrived; **#119–#122 still OPEN** (`gh pr list`), and T3 = #120 (UAT as a `deploy.sh` target, plan:244-268), T5 = #121. Every G5 row (E1-M4, E3-M3, E4-M4) inherits the train's date. Write the dependency as "#120 + #121 landed and `deploy.sh` run with `HMIS_TARGET=uat`", so a slip reads as a PR number.

### R15 — A fifth department on Track S, added to RM §2 without saying so — **note**
RM §2's Track S names lab (wk 2–6), pharmacy (4–6), front desk (4–6), radiology (7–9); RM:211-214 orders lab → pharmacy → radiology. The mini-OT is in no row. The design's E1-M3..M5 add it (wk 5–6, 9, 10–13) and §6 correctly does not build 29/31 (RM:418). This is a proposal to amend RM §2 — say "RM §2 gains a Track S row for 15" and cost S: in wk 4–6 S already carries the lab harvest, pharmacy UAT + production, two loaders and the front desk's screens (RM:337); L joins S from week 3 (RM:336) — give E1-M3 to L.

### R16 — Inside E1, 7 d of build precede the walk that would find the gaps — **note**
E1-M1/M2 (weeks 6–8) are built before E1-M4's UAT walk (week 9); the milestone table has E1-M4 ← E1-M1..M3 with no reason. RM:236-237: "everything else the lanes build this quarter comes out of the pilots, not out of the department series". The thesis-shaped order is E1-M3 → E1-M4 (the walk finds the ULID handoff and the absent recall) → E1-M1/M2 as pilot fixes → re-walk → E1-M5. If the slip and the recall are G5 prerequisites (a walk without a slip proves nothing to an attendant), one line says so; today nothing does.

### R17 — 28 lane-days is build-only — **note**
Two close passes per phase (RM:433) and the S-gate afternoon (RM §8) are not in the 28; the last four phases' pass-2 findings ran 12–20 MAJOR each (memory `close-review-two-pass-lesson`). Say "build-only" or budget ≈ +30 %.

### R18 — D8 and the milestone table disagree about when kernel-D must exist — **note**
D8: "Kernel-D is revived before 44 is *authored*"; the table: E4-M1 (authoring) ← "41 live 30 d; O1" only, E4-M2 ← E3. The table is right (authoring needs no table); fix D8.

### R19 — E3 is kernel work with L named as adopter while L is on S — **note**
E3 = `kernel/documents` (new), `kernel/db/schema/index.ts`, a migration, `kernel/printing/render.ts`, a new route (`caddyfile-parity`). "Deps: printing v2; the lab lane as adopter" — L joins S from week 3 (RM:336, §0c.5) and is still there in Q1 2027 on the design's own calendar. Name the kernel coordination and L's substitute.

### R20 — Plan 20 is authored, for approval, not executed — **note**
`docs/superpowers/plans/2026-09-06-phase1-20-workforce-roster.md:3` "FOR APPROVAL. NOT EXECUTED." (#150); its build waits on the owner's approval line (CONTEXT:39). E4/E5 say "Plan 20 live" — right — but the approval line is a human act on the path that §5's ruling table does not list.

---

## 3. Missing edge rows (11i §2b shape: the day · expected · artefact · milestone)

| # | the day | expected behaviour | artefact | milestone |
|---|---|---|---|---|
| M1 | **Config-before-guard:** the MS published the three drafts but never drafted `privileges`; the first case is booked | `ot_gate` refuses every surgeon; `standup:check ot` → `ot_definitions_published` RED with §4 as the fix; the walk stops at booking, never at discharge | census row + refusal (`ot-go-live.md` §0 row 3, §4) | E1-M3 |
| M2 | **Ceremony:** the owner drafted `daycare_case` himself | nobody can activate (`workflow_drafter_activator`); discard and redraft by `opd_admin`; a runbook line, never a seed | refusal + runbook §1 trap | E1-M3 |
| M3 | **Deploy-day / money:** production's first real day-care booking; the package is unpriced | refuses `tariff_item_missing` in front of the patient; the fix is a tariff row by the owner/CA (R-255); day-1 count is 0 bookings, never "0 breaches" | refusal + census `package priced` RED | E1-M5 |
| M4 | **Deploy-day:** the deploy lands `ops_fact_sheets` + the 07:00 job at 14:00 IST | the first sheet covers a partial day, flagged `partial` from the deploy-time watermark — never `no_data`, never a full-day number | first row's watermark | E2-M1 |
| M5 | **Role-unheld (reader):** no recipient configured; `quality_manager` is not a role | the sheet is produced, `notification.suppressed`; G2 must count a read (`notification.sent` with a real provider, or a dated read line), never `fact_sheet_produced` | suppressed event + G2 row | E2-M4 |
| M6 | **Event-before-reader:** the sheet is deployed one deploy before `aerb.acquisition_refused` | the AERB line reads `no_data` (not 0) until the twin lands; the census row explains | sheet section | E2-M3 |
| M7 | **Lint landing:** lane X has an unmerged `*.refused` event when the lint merges | X's rebase goes red; the fix is one name on the list, never a weaker pattern; the landing was announced on the train | red → green on X's PR | E2-M3 |
| M8 | **Session / train:** #120/#121 have not landed when E1-M4 is due | every G5 row reads "blocked: #120" with the PR number, never "rehearsal late" | milestone row text | E1-M4, E3-M3, E4-M4 |
| M9 | **Session / name collision:** a lane finds `ot-go-live.md` exists | it appends §Seat walk/§Harvest/§Executed; never creates `mini-ot-go-live.md` | one file in `docs/runbooks/` | E1-M3 |
| M10 | **Deploy-day / version:** D12 flips `summary_countersign_pending` from `record_only` to `active` after the pilot | a definition version bump; in-flight admissions complete on the old version (SPEC:196-199) and never breach; the sheet shows the version split | `workflow_instances.definition_version` per breach line | E4-M2 |
| M11 | **Role-unheld:** 02:00 deviation, nobody holds the reviewer role | ladder to `duty_manager`; `fallbackExhausted` recorded; never auto-closed | `escalation.triggered{fallbackExhausted}` (`timers.ts:150-165`) | E5-M2 |

---

## 4. Amendments, in the order a redraft would apply them

1. **E1-M3 → a delta on `#157`**: append §Seat walk/§Harvest/§Executed to `docs/runbooks/ot-go-live.md`; add only the census rows absent (`ot_incharge`/`recovery_nurse`/`daycare_coordinator` held, package priced, relay reachable); acceptance "rows 6 → ≥ 11 at rebase"; delete `mini-ot-go-live.md` and "module keys 4 → 5" (R1).
2. **NEW-P5-2 names six roles** (§6 of the runbook) and E1-M3's human act adds the Class-A ceremony (`opd_admin` drafts, MS + `owner` approve, non-drafter activates) and the `privileges` draft (R2); edge rows M1, M2, M9.
3. **E1-M5's gate row** gains "day-care package + implant prices in production's active tariff (money; R-255) before the first real booking"; O6 stays for the CA signature (R3); edge row M3.
4. **§7 names the lane departure**: "re-plans F for weeks 3–8" with its cost, or E2 → L (on S from wk 3) and E1-M1/M2 → whoever lands printing v2 (R4); E1-M3 → L, and "RM §2 gains a Track S row for 15" (R15).
5. **§7 drops "the sheet is live before the harvest week"** or starts E2-M1 in week 1–2 by a named lane; E2-M4's acceptance becomes "the lab's harvest rows on the sheet by pilot day N, dated" (R5).
6. **E2's Deps row lists the everyone's-files** (`kernel/worker/jobs.ts` + its census and `alerts.yml`, `schema/index.ts` + one serial at rebase, `kernel/ops/manifest.ts` + `seed-roles.ts` + five pins, `notify/templates.ts`, the CI lint, `router.tsx` + `caddyfile-parity`) and the rule: a rebase slot, counts re-measured at rebase (R6).
7. **E2-M3 sequence**: `aerb.acquisition_refused` first, or the lint with a dated allowlist emptied at close; announced on the train (R7); edge rows M6, M7.
8. **E2-M5 moves out of billing**: per-module `unbilledOrdersFor(day)` on each `index.ts`, the join in `kernel/ops/fact-sheet.ts` (R8).
9. **NEW-P5-3 becomes a gate on E1-M5's recall row and on E2-M4**; until a provider exists the artefact is the `notifications` row + printed slip / a dated read line, and `notification.sent` is not a delivery parameter; D6's "email/in-app" is either a named kernel/notify build or deleted (R9); edge rows M4, M5.
10. **E4-M3 says which**: bed release = `resource.status_changed` by a named human, or a dependency on 19a (behind RM §5); passes "on 41's pass object" (R10). **`death` = `NOT MODELLED → runbook (R-111)`** in E4-M2 until 43b (R11); edge row M10.
11. **Small text**: E1-M1 cites `recovery.ts:553-565` and says "a `notifications` row, the primitive #164 said exists — not the task it refused"; D10 names the holiday calendar as a config surface that does not exist (R13); "Deps: 11i T3/T5" → "#120 + #121 landed, `deploy.sh` `HMIS_TARGET=uat`" (R14, edge row M8); roles `quality_manager`/`discharge_coordinator`/`rmo` marked "not in `seed-roles.ts` — a grant and a name" (R12); "28 lane-days, build-only" (R17); D8 reworded to match the table (R18); E3 names its kernel files and L's substitute adopter (R19); Plan 20's approval line joins the ruling table as a fact the owner holds (R20); edge row M11.
