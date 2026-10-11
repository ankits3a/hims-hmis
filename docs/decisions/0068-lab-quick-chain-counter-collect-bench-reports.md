---
type: decision
id: "0068"
title: "The quick lab chain: /lab/counter bills (or sends free) an order, /lab/qcollect confirms blood and stamps a sample number, /lab/qbench saves drafts or completes, /lab/qreports prints and hands over — still no signature"
description: "Owner 2026-10-11: the lab's everyday path in four screens with /counter's look. A request or a walk-in becomes a real lab order at the counter (billed, or sent to sample collection when the lab fee is Free); staff confirm Blood collected themselves; results are drafted or completed; the report is printed and handed over or sent back to the bench. Builds on 0061's quick results and keeps its no-signature rule; the full lab path stays."
generated: { by: agent:claude, at: 2026-10-11 }
verified: []
status: stable
ruling: ruled
tags: [lab, billing, printing]
supersedes: []
superseded_by: []
sources:
  - { id: spec-lab-quick-chain, resource: "/opt/hmis-context/SPEC-lab-quick-chain-2026-10-11.md", title: "Spec: the quick lab chain" }
  - { id: spec-lab-desk-flow, resource: "/opt/hmis-context/SPEC-lab-desk-flow-2026-10-11.md", title: "Spec: lab desk, from picking the patient to the sample" }
---
# 0068 — The quick lab chain

- **Date:** 2026-10-11   **Status:** Ruled
- **Area:** lab (counter, collection, results, report hand-over), billing fee switch

## What is ruled (owner, 2026-10-11)

1. **/lab/counter** — /counter's first screen for the lab: one search, then two columns. Left: the patient,
   credit with the hospital, memberships, the last three tests (View more). Right: the doctor's requests, or
   **New walk-in** · **Future appointment**. A request is billed into an order (order no. + visit no.); when
   Billing office → Fees has the lab fee Free there is no billing screen and **Send to Sample Collection**
   makes the order. A walk-in chooses tests (coloured chips + search), **Next**, then the bill (skipped when Free).
2. **/lab/qcollect** — staff confirm **Blood collected** themselves (no label printing, no tube scan). This
   stamps a **sample number** (the specimen `S` series); the order and visit were made at billing/send.
3. **/lab/qbench** — results with H/L flags and the drafted summary; **Save draft** keeps it on the bench,
   **Save & Complete** sends it to /lab/qreports.
4. **/lab/qreports** — **Print & Hand over** records who handed it over and when; **Send back to Quick
   Bench** makes it a draft again, until it is handed over.
5. **No pathologist signature for now** — reports print "Quick lab · not signed", as 0061.
6. **Both paths stay**: the full lab screens (desk, collection, bench, verify, report centre) are unchanged
   and remain the signed path.

## DECIDED (standard practice, open to the owner's objection)

- A report that has been handed over is closed: no edit and no send-back. A correction after hand-over is a
  new order.
- Blood is confirmed once per order (a unique key on the order). Either the lab counter's grant
  (`lab.desk.operate`) or the phlebotomist's (`lab.collection.operate`) may confirm it.
- An order the quick chain collected never walks the full item workflow, so the SLA sweep and the full
  collection screen's label queue skip it.
- No new permission: the counter rides `lab.desk.operate`, the collection queue `lab.worklist.read`, the
  bench `lab.results.enter`, the hand-over counter `lab.reports.print` (each report read there is
  access-logged).

## Consequences / how to apply

- `lab_quick_reports` gains `order_id`, `sample_no`, status `draft`, `handed_over_at/by` (migration with the
  lane's lab bookings tables).
- Routes: `GET /lab/quick/collect`, `POST /lab/quick/collect/:orderId`, `GET /lab/quick/ready`,
  `GET /lab/quick/ready/:id`, `POST /lab/quick/reports/:id/hand-over`, `POST /lab/quick/reports/:id/send-back`,
  `GET /lab/desk/patient/:id/recent`; `PUT /lab/quick/reports/:id` takes `complete: false` for a draft.
- Events `lab.quick_handed_over`, `lab.quick_sent_back`.
- When signing arrives, a new decision says whether quick reports then need a signature.
