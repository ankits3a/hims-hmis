---
type: decision
id: "0077"
title: "Tele-call appointments: the patient pays first, at the in-person fee; the doctor sees a phone icon, never a payment; the bill is made when the doctor marks 'Spoke to patient'"
description: "Owner 2026-10-09: tele-call is a booked slot (new or follow-up) paid before the consult, same fee as in person, starting the follow-up window; a no-answer carries the advance to a re-booked slot; refunds only on request through approval; the prescription goes by print, WhatsApp or SMS. Shipped in #564 (#559)."
generated: { by: agent:claude, at: 2026-10-15 }
verified: []
status: stable
ruling: ruled
tags: [opd, tele-call, billing, money, doctor, appointments]
supersedes: []
superseded_by: []
sources: []
---
# 0077 — Tele-call appointments

- **Date:** 2026-10-09 (recorded 2026-10-15, #648)   **Status:** Ruled
- **Area:** opd (appointments, doctor's line, prescription), billing (advance, bill)

## The owner's words (2026-10-09)

- *"For Telecall, any patient booked the slot online or from the counter (future appointment, not walkin) then when
  the consultation time comes the doctor can see that patient highlighted in the list of queue with marked clearly
  that it's a telecall (use icon for telecall and not the text as we have limited screen size)."*
- *"Fee: paid at counter before slot / UPI link. No collect later. If appointment booked then the patient must pay
  before getting consulted. Prescription to patient: relative collects / WhatsApp PDF / SMS Link/ all 3. Doctor calls
  from own mobile (patient sees doctor's number): acceptable, yes. Both, new patients on tele-call and follow-up.
  Online booking by patients: later, separate module."*
- *"Fee: tele-call costs same as in-person visit. tele-call start the free follow-up window like a normal visit. 'No
  answer' by patient: carried to a re-booked slot. refund only on request through approval. Bill at slot time:
  automatic; receipt already names the cashier."*
- *"make sure that Doctor will not see 'paid' written or marked against any patient name or id. This is a hospital not
  a clinic. Doctor will see the patient name in his queue only when the patient have paid the amount in terms of
  tele-consultation or future appointment."* (decision 0058 carries the no-money rule for every doctor screen.)

## What is ruled

1. A tele-call is a **booked appointment** (staff book it at the counter; patients booking online is a later module),
   for new patients and follow-ups alike, marked at booking with the patient's phone number.
2. **Pay first, never collect later.** The fee equals the in-person consultation fee and is taken before the slot:
   at the counter, or to the hospital's UPI id with the cashier typing the reference. There is no payment gateway.
3. The doctor sees a tele-call in the line at slot time with a **phone icon, no text**, and only if it is paid. An
   unpaid tele-call is absent from the doctor's line; no paid/unpaid mark is ever drawn (0058).
4. The doctor calls from their own mobile.
5. A tele-call **starts the free follow-up window** like an in-person visit.
6. **No answer:** the advance carries to a re-booked slot. **Refund** only on request, through the approval workflow.
7. The prescription reaches the patient by **print** (a relative collects), **WhatsApp PDF** or **SMS link**, or all three.

## DECIDED (standard practice, told to the owner)

- The payment is an **advance receipt tied to the appointment**; the visit opens at slot time only if it is covered.
- The **bill is made automatically when the doctor marks "Spoke to patient"**, not when the slot opens, so a no-answer
  needs no bill reversal and the advance simply carries over.
- The prescription carries the line **"Tele-consultation · patient not examined"** under the doctor's lines.

## Consequences / how to apply

- Code: `apps/core/src/modules/opd/tele.ts`, `tele-call.ts`, `tele-bill-failures.ts`; `opd_appointments.mode` and
  `tele_phone` (migration 0190); web and phone booking switch; doctor's line phone icon.
- WhatsApp and SMS delivery wait on approved templates and a provider (#649); the hospital's UPI id is an owner entry (#646).
- Shipped in #564 (joined staging build 0.15.0), which carried #559.
