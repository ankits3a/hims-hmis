---
type: module-notes
title: "icu — module notes"
description: "Why and traps of the ICU core (IC-1, #984, decision 0090 option A): the ICU request with priority and scores on the ipd_icu_admission approval, device links by double scan on radiology's device kind, the hall gateway's numbers (5 s, partitioned daily, 72 h) and their attribution, the hourly chart signed into the vitals record, the alarm ladder on its own 10-second clock, 24-hour limits and advisory alarms, feed gaps and grey-out, bundles and line-days, and the family's daily word."
resource: apps/core/src/modules/icu
tags: [icu, ipd, devices, alarms, chart]
generated: { by: agent:claude, at: 2026-10-27 }
verified: []
stale_after: 2027-01-27
---
# icu — module notes

Hand-written notes: the WHY and the traps. Signatures are generated in `docs/architecture/modules/icu.md`. Spec
`docs/specs/984-icu-core.md`; rulings decision 0090; plan `docs/superpowers/plans/2026-10-26-ic1-icu-core.md`.
Paths are relative to `apps/core/src/modules/icu/` unless they name a module, `kernel/`, `packages/`, `tools/` or `apps/`.

## 1. Purpose
Every ICU bed watched and charted (option A): HMIS keeps NUMBERS (one sample per 5 s from one gateway per hall), trends,
the hourly chart and the alarm ladder; the maker's central station keeps the waves and stays the primary alarm. Dark
behind `HMIS_MODULES_ON` (`icu`, decision 0085). IC-2 (#985) adds live waves per hall after the regulatory check.

## 2. Key files (owner of what)
- `requests.ts` — D1: `requestIcu` (asks `ipd_icu_admission` AT RAISE, requester = the doctor; subject = the open
  admission, else the PATIENT — the downtime/ER lanes' subject rule), `decideIcuRequest` (approve = the engine's
  `approveRequest` by an `intensivist`; refuse / hold need a reason; hold sets `review_at`, default +60 min),
  `listIcuRequests`. NEWS2/qSOFA pre-filled from the ward's latest `ipd_vitals`.
- `devices.ts` — D2: `linkDevice` (device scan + band scan → `resolveBandScan` + `admissionForTransport`; only on a
  critical-care bed), `unlinkDevice`, `reconcileLinks` (the sweep: a link whose stay ended closes AT THE STAY'S END —
  transfer / discharge / death), `deviceDays` (IST calendar days touched; also line-days).
- `feed.ts` — D3/D7: `registerGateway` (a kernel interface, stale after 300 s, bound to the gateway's agent),
  `mapSlot`, `mapCode`, `ingestBatch` (agent-only; a batch is the heartbeat; attribution; quarantine; minute rollup;
  device alarms; advisory evaluation), `hallFeed` (grey = silent > 5 min or the kernel says down).
- `chart.ts` — D4/D7: `prefillHour`, `signHour` (→ `ipd.recordIcuChartVitals`), `correctValue`, `enterManualHour`,
  `readChart`, `isIstHourMark` (a chart hour is an IST hour mark = UTC :30).
- `alarms.ts` — D5/D6: `raiseAlarm` (dedupe, storm flag), `evaluateAdvisory`, `setAlarmLimit`, `confirmLimitOnMonitor`,
  `acknowledgeAlarm` (`deviceSilenced: false`), `escalateAlarms`, `syncFeedGaps`.
- `bundles.ts` — D8: lines, `startSepsisBundle`, `completeBundle`, `ensureBundles`, `icuOccupants`.
- `family.ts` — D9: `logVisit`, `logFamilyUpdate`, `familyToday`; `installFamilyToday` (run by `index.ts` on import)
  plugs the reader into ipd's `registerFamilyTodayProvider`.
- `partitions.ts` — `ensureNumericsPartitions` (on ingest, advisory-locked), `dropExpiredNumericsPartitions` (hourly).
- `sweep.ts` — `sweepIcuAlarms`: ladder, gaps, links, bundles, partitions; each part in its own try.
- `reads.ts` — the station, the bed, trends, my beds, the night view, the in-charge view, halls.
- `kernel/db/schema/icu.ts`, migration `0262_icu_core` (the ONE hand edit: `icu_numerics ... PARTITION BY RANGE`).
- `packages/contracts/src/icu.ts`; `tools/icu-gateway` (MLLP → JSON, spool, 30-second batches).
- Web: `apps/web/src/screens/icu-{station,bed,chart,phone,desk}.tsx`, `apps/web/src/lib/icu-api.ts`.

## 3. Main flows
- Request → approval → the admit desk passes `request.approvalId` as `intensivistApprovalId` (the existing gate).
- Gateway batch → numerics (attributed or not) → minute table → advisory alarms; device alarms → ladder.
- Hour mark → pre-fill (median of the last 60 s, linked, non-technical) → nurse signs → `ipd_vitals` (source `icu_chart`).
- Feed silent > 5 min → station grey at once (read side); the kernel's interface sweep downs it → the ICU sweep opens a
  gap; the next batch (heartbeat) restores → the sweep closes it at the restoring sighting.

## 4. Invariants and traps
- NUMBERS ARE NEVER EVENTS. One event per request decision, link, gap, alarm, signed hour.
- Attribution is decided AT INGEST from the link open at the observed instant; rows are never re-attributed (a link
  does not reach back; a mismatched `deviceSerial` = unconfirmed = never charted).
- `device` is RADIOLOGY's kind (`RADIOLOGY_RESOURCE_KINDS`): never redeclare; ICU devices carry `attributes.icuType`.
- `recordVitals` refuses device rows and anything > 24 h old; the signed hour uses `recordIcuChartVitals` instead, which
  raises NO NEWS2 alert (ICU alarms replace them) and writes once per hour (`client_key icu_chart:<hour>`).
- No silence anywhere: no column, no act, no command to the gateway.
- The ladder climbs only LIFE-THREATENING alarms (classified by the device alone); advisory alarms stay with the bed
  nurse and are capped during a storm (10 alarms / 10 min / bed, flagged once per window to the in-charge).
- Gaps open on the KERNEL's `down` verdict only (not on silence alone), so a test or a sweep at an odd instant never
  opens a phantom gap; the grey-out is the read side's and needs no sweep.
- Chart hours are IST hour marks; `prefillHour` refuses a non-mark and a future hour; manual entry is refused while the
  feed is live (`feed_live`, checked before the hour).
- `sweepIcuAlarms` is its own 10-second job (pool 30). Its cadence is overridable only for a scheduler test
  (`JobIntervals.icuAlarmSweepIntervalMs`).
- Device-days are COUNTED only: no charge lines until the owner rules the money (device-day charge vs bed rate).

## 5. Who calls icu
- `kernel/worker/jobs.ts` (`sweepIcuAlarms`), `app.module.ts` (dark `IcuModule`), `kernel/modules/manifests.ts`.
- ipd's family page reads today's update through the provider icu installs.
- Owed (issues): roster-based "station" rung per hall, a nurse-to-bed assignment for "my beds", lab pre-fill of SOFA /
  lactate, the IP allowlist for `/icu/feed/*` at go-live, legal-hold copy before a partition drop.
