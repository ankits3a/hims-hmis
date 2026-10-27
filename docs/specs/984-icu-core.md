---
issue: 984
status: built
approved: 2026-10-26
built: 2026-10-27
---
# SPEC — ICU IC-1: core — admission, device links, numbers and trends, hourly chart, alarm ladder, bundles (#984)

Status: APPROVED 2026-10-26 by the owner ("go ahead with your recommendation"). The rulings are in decision 0090. This
spec builds on IPD (#967): ICU approval gate, nursing, eMAR, transfers, discharge and the family link. The live-wave view
is IC-2 (#985). Other ICU dependencies are #986–#993.

## What

Every ICU bed is watched every second and charted every hour. Every alarm reaches a person who acts.

- **Admission.** A request comes from the ER, a ward or OT. It carries a priority class (1–4) and triage scores, filled
  from the latest vitals and labs. The intensivist approves it; the approval gate already exists. A refusal, or a hold
  with monitoring, is logged with a reason and a name.
- **Devices.** The monitor, ventilator and pumps are linked to the bed and the patient by scanning both. Device-days
  start at the link and stop at the unlink, or at discharge.
- **Numbers and trends.** One gateway per ICU hall sends numbers from the monitor maker's central station (option A;
  decision 0090). HMIS keeps numbers every second for 72 hours and one value per minute with the medical record. It
  shows 24-hour trends. The maker's station stays the primary alarm and keeps the waves.
- **Hourly chart.** Device values pre-fill each hour. A nurse checks and signs the hour, and only a signed hour is the
  legal record. Corrections keep the original value. Technical readings, such as a probe off, are marked.
- **Alarm ladder.** Device alarms become tasks with a clock, escalating from the bed nurse to the station, then the duty
  doctor, then the intensivist. HMIS records who acknowledged an alarm and never silences a device. Doctor-set limits
  last 24 hours. An alarm storm is flagged to the in-charge.
- **Downtime.** If the gateway feed is lost for more than 5 minutes, the station tiles turn grey and nurses chart by hand
  every hour. Back-filled hours carry both times.
- **Bundles.** Ventilator, central line, catheter, sepsis hour-1, DVT and pressure care are each due per bed with a clock.
  Line-days and ventilator-days are counted.
- **Family.** Visiting slots and a daily doctor update are logged. The family link shows the day's summary, never live
  numbers.
- **Screens.**
  - ICU central station: numbers, alarms and trends per bed
  - one-bed view
  - hourly chart
  - nurse phone (web)
  - intensivist night view

## Done means

- **D1** An ICU request from the ER, a ward or OT carries a priority class (1–4) and triage scores. Admission happens
  only after the intensivist approves. A refusal, or a hold with monitoring, is logged with a reason and a name.
- **D2** A device is linked to a bed and a patient only by scanning both. A second device of the same kind on one bed is
  refused. The device-day starts at the link and stops at the unlink or at discharge.
- **D3** Numbers from an unlinked or unconfirmed device never reach a chart.
- **D4** The hourly chart pre-filled from devices is not the record until a nurse signs it. A corrected value keeps the
  original visible, with a reason. Technical readings (probe off) are marked, and never pre-filled as real.
- **D5** A life-threatening alarm escalates from bed nurse to station to duty doctor to intensivist, on a clock, until
  someone acknowledges it. HMIS never silences a device.
- **D6** Doctor-set alarm limits expire after 24 hours.
- **D7** If the gateway feed is lost for more than 5 minutes, the station tiles turn grey and charting switches to manual
  every hour. Back-filled hours carry both a happened-at time and an entered-at time.
- **D8** Bundles are due per bed with clocks. A missed bundle shows on the in-charge view. Line-days and ventilator-days
  are counted.
- **D9** Visiting slots and a daily family update are logged. The family link shows the day's summary, never live
  numbers.

## Build notes (2026-10-27, lane icu-984)

Built as `modules/icu` behind `HMIS_MODULES_ON` (`icu`). Acceptance: `apps/core/src/modules/icu/acceptance/icu-core-984.acceptance.test.ts`
(`spec #984 D1`..`D9`). DECIDED in the build (none is money):
- An ICU request asks the `ipd_icu_admission` approval when it is raised; the intensivist's "approve" grants it, and the
  admit desk passes that approval to the existing gate. A hold reviews again after 60 minutes unless a time is named.
  NEWS2 and qSOFA fill from the ward's latest vitals; lab scores (SOFA, lactate) are typed until a lab read seam exists.
- A device is an ICU device when radiology's `device` resource carries `icuType`; the link takes the device scan and
  the wristband scan, and the bed is where that admission lies (an ICU bed, or refused).
- A number reaches a chart only if a link was open on the slot's bed at the observed instant and the station's device
  serial (when sent) is the linked device's. Rows are never re-attributed afterwards.
- A chart hour is an IST hour mark. The signed hour writes one `ipd_vitals` row (source `icu_chart`, no NEWS2 alert).
  A correction after signing is shown on the chart (the legal record) and does not rewrite that row.
- The ladder: the bed nurse sees the alarm on the station and the phone; the station rung tells `icu_incharge` (else
  `nursing_supervisor`); the duty-doctor rung the admission's duty doctors; the last rung every `intensivist`. Only
  life-threatening device alarms climb. No nurse-to-bed assignment exists yet, so "my beds" is every ICU bed.
- Feed gaps open on the kernel's interface `down` verdict and close on the next batch; the station greys from the
  heartbeat itself after 5 minutes. The `/icu/feed/*` IP allowlist is a go-live step (the hall addresses are not known).
- Bundle clocks: ventilator 8 h, central line and catheter 24 h, DVT 24 h, pressure care 2 h, sepsis hour-1 once.

