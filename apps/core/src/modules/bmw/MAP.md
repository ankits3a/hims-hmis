---
type: module-notes
title: "bmw — module notes"
description: "Why and traps of bio-medical waste: bag-level tracking from ward to the treatment facility, the bar-code label, the collection task, the 48-hour storage clock on the task clock's tick, the 6 % gap and its disputes, and the two legal reports read off the bags."
resource: apps/core/src/modules/bmw
tags: [bmw, ipd, statutory]
generated: { by: agent:claude, at: 2026-10-12 }
verified: []
stale_after: 2027-01-12
---
# bmw — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/bmw.md`. Paths are relative to `apps/core/src/modules/bmw/` unless they start with a
module name, `kernel/`, `scripts/` or `apps/`. Citations name a file and a symbol, never a line number.
Update this file in the same PR when you change a flow, an invariant or a trap below.
Spec: SPEC-ipd-companions §4, §10, §11 (kept outside the repository); issue #724, decision 0072.
Law: Bio-Medical Waste Management Rules 2016 (amended 2018, 2019).

## 1. Purpose
Every waste bag from the point of generation to the common bio-medical waste treatment facility (CBWTF): a
colour-coded bag with a bar-code label, weighed at the ward and again at the central store, handed over on a
manifest, weighed again by the facility, reconciled. The monthly report and the annual Form IV figures are SUMS
over the bag rows — nobody types a number.

## 2. Key files (owner of what)
- `intents.ts` — every act: `generateBag` (label + collection task), `recordDeptWeight`, `collectBag`, `storeBag`,
  `handOverManifest`, `recordCbwtfWeight`, `verifyManifestGap`, `resolveDispute`; `formatBarcode`, `allocate`.
- `kinds.ts` — the `bmw_collection` task kind and the `waste_handler` skill (→ `support_staff`), defined at import.
- `clock.ts` — `sweepBmwStorage`, the 36 h / 48 h storage clock.
- `label.ts` — `drawBagLabel` (75 × 50 mm, QR + text code), `renderBagLabelJob` (the relay's renderer).
- `reports.ts` — `monthlyReport`, `formIvReport` and their CSVs.
- `reads.ts` — `bmwBoard`, `bmwHandlerView`, `bagByBarcode`, `nextPickupAt` (DECIDED daily 10:00 IST pickup).
- `errors.ts` — `BmwError` (code + sentence + fix, from `BMW_REFUSALS` in `packages/contracts/src/bmw.ts`).
- `bmw.controller.ts` — the doors; `manifest.ts` — `bmw.view`, `bmw.handle`, `bmw.manage`.
- Schema `kernel/db/schema/bmw.ts` — `bmw_bags`, `bmw_bag_events` (append-only by trigger), `bmw_manifests`,
  `bmw_disputes`; sequences `bmw_bag_serial`, `bmw_manifest_serial` (migration `*_bmw.sql`, hand-appended).
- Web: `apps/web/src/screens/bmw-board.tsx` (`/bmw`, 16:9), `apps/web/src/screens/bmw-handle.tsx` (`/bmw/handle`,
  390 px), `apps/web/src/screens/bmw-reports.tsx` (`/bmw/reports`), `apps/web/src/lib/bmw-api.ts`, styles
  `apps/web/src/screens/bmw.css`.
- Test fixture `apps/core/test/helpers/bmw.ts` — the tasks fixture's hospital plus `bagInStore`.

## 3. Main flows
1. **Generate** — place must be a live registry node; cytotoxic only on yellow. Bar code
   `BMW<Y|YC|R|W|B><YYMMDD IST><6-digit serial>` from the standalone sequence (never reset by `truncateAll`, never
   reused). The label goes to the relay (`bmw_bag_label` → destination `bmw_label`) when `relayServes`, otherwise back
   to the browser in the answer (the pharmacy labels shape). A `bmw_collection` task is raised at the place; the engine
   merges a second bag at the same place within 10 minutes into it.
2. **Collect** (scan) — `generated` → `collected`; an unweighed bag must carry `grams` (`weight_needed`). When it was
   the place's last waiting bag, the collection task is driven accept → start → done with `{ kind: "scan" }` proof; if
   the collector cannot hold it (`not_on_duty`, `wrong_skill`) or someone else holds it, it is CANCELLED "Bags
   collected" instead.
3. **Store** — `collected` → `stored` with the central weight; `centralGap` flags ≥ 6 % (no dispute, a board mark).
4. **Hand over** — stored bags only, locked FOR UPDATE in id order; a manifest row with per-category totals.
5. **CBWTF weight** — per bag or per category; a category slip is split over its bags by department weight (largest
   remainder) so the bag rows sum to the slip exactly. Each weighed bag gets `treated_at`; its category with a gap
   ≥ 6 % makes it `disputed` and writes one `bmw_disputes` row (manifest, category) with both weights.
6. **Resolve** — dispute closed with a note; its bags → `treated`.

## 4. Invariants and traps
- **Every bag change bumps `version` and appends one `bmw_bag_events` row with `seq = version`** (`actOn`). A raw
  UPDATE that skips `actOn` shows as a gap.
- **A bag is handed over once**: the intent refuses (`already_handed_over`), the row lock serialises a race, and the
  CHECK `bmw_bags_manifest_ck` ties `manifest_id` to the post-handover states. `acceptance/no-double-handover`.
- **The storage clock runs from GENERATION**, for every bag still on site (`generated`, `collected`, `stored`) —
  DECIDED, the stricter reading of r.8(3). One notice per level per generation hour (`bmw:storage:<level>:<hour>`),
  to every holder of `services_supervisor`; never per bag (a missed pickup would ring dozens of bells).
- **The clock rides the `sweepTasks` job** (`kernel/worker/jobs.ts`, `finally`), not its own job: no extra pool client,
  no job-count census change. Importing the bmw index there is ALSO what defines `bmw_collection` in the worker —
  remove that import and the task sweep sees an unknown kind (tasks MAP §4).
- **The gap rule** (`bmwGapFlagged`, contracts): `|other − dept| × 100 ≥ 6 × dept`, integers — 6.0 % flags, 5.9 % does
  not. Spec §4 says "above 5 %"; the brief and §11 say 6 %, which is what is built (DECIDED).
- **Reports read off rows**: generated = `generated_at` in the IST month (department weight); handed over =
  `handed_over_at` (central, else department); treated = `treated_at` (facility). `yellow_cytotoxic` is shown inside
  yellow and never added to totals. Month edges come from `kernel/approvals/cumulative.ts` `istDayWindow` — never a
  copy of the offset (`test/ist-clock-parity`).
- The web imports only TYPES from `@hmis/contracts`; `apps/web/src/lib/bmw-api.ts` repeats the 36/48 lines and the colour list.
- No patient anywhere: a bag belongs to a place. Notices carry counts and place names only.

## 5. Who calls bmw
- kernel: worker (`sweepBmwStorage` on the `sweepTasks` tick); manifests (`bmwManifest`, API only); printing (the
  module registers the `bmw_bag_label` renderer in `onModuleInit`).
- bmw calls tasks through its index: `defineSkill`, `defineTaskKind`, `raiseTask`, `acceptTask`, `startTask`,
  `completeTask`, `cancelTask`, `TaskError`.
- Out of scope today: CBWTF portal, pollution-board online filing, sharps pit / autoclave logs, segregation audits,
  needle-stick incidents, training and immunisation records, the mobile app.
