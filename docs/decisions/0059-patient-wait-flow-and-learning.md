---
type: decision
id: "0059"
title: "How long patients wait: desk → vitals → doctor from stored timestamps, and a nightly learning that suggests from a closed set of fixed templates"
description: "The owner asked to see the waits from the registration desk to vitals and from vitals to the doctor, hospital-wide and per department, with comparisons, and a system that keeps learning them and suggests improvements. Numbers come from stored timestamps; suggestions are fixed templates filled with numbers; no model writes or calls anything."
generated: { by: agent:claude, at: 2026-10-09 }
verified: []
status: stable
ruling: ruled
tags: [opd, reports, mobile, owner]
supersedes: []
superseded_by: []
sources: []
---
# 0059 — Patient waits and the learning behind "To improve"

- **Date:** 2026-10-09   **Status:** Decided (owner's ask; the shape below is the standard answer, not a money/law ruling)
- **Area:** opd, owner app

Owner, 2026-10-09: *"I want to track how much time its being taken by hospital to get the patient from registration
desk to Vital desk and then how much time it is taking for a patient from vitals to getting consulted … I want a system
in place that keeps learning these metrics and show suggestions to improve the metrics based on analysis."*

**DECIDED**

1. **Legs** from stored timestamps only: desk → vitals = `opd_encounters.opened_at` → first `opd_vitals.recorded_at`;
   vitals → doctor = that save → `consult_started_at`; desk → doctor = both. Dropped and counted: guardian visits,
   abandoned / left the line, paper closes with no start of their own, same-day re-entries (leg B), waits < 0 or
   > 480 min. Lab walk-ins and pharmacy visits are not consultations. No tele-call column exists, so none is split.
2. **"Desk → paid" is not built**: no column stamps when the consult fee settled; a guess would be shown as fact.
3. **Floor**: a figure shows only with ≥ 5 visits. No patient or staff name in any payload.
4. **Learning** runs inside the existing 23:55 IST OPD job (no new job): 28-day baselines per department and leg by
   weekday × hour (`opd_flow_baselines`); findings from a closed set (`bay_peak`, `doctor_start_late`, `dept_outlier`,
   `week_regression`; thresholds in `modules/opd/flow-rules.ts`) in `opd_flow_findings`; resolved when back within
   1.1× baseline over two weeks, with minutes won. × keeps a finding quiet 28 days unless 20 % worse; "Tried it" stamps
   a before. Only the owner and the Medical Superintendent act; both acts are audited events.
5. **No model**: suggestion text is fixed en/hi templates filled with numbers (the owner's standing rule: a model never
   writes a fact shown as fact). A later chooser may only re-rank open findings (`rankFindings` seam).
   `FLOW_FINDINGS_ENABLED` (default true) switches the learning; it calls no outside service.
6. `doctor_start_late` reads "the first hour" as the 60 minutes from the department's first vitals save of the day — it
   never names a doctor. `bay_peak` uses fixed two-hour windows (08–10 … 18–20) so a finding keeps its key night to night.
