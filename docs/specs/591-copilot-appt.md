---
issue: 591
status: built
approved: 2026-10-11
---
# SPEC — E2.1 book / move an appointment from copilot chat (APPROVED by owner 2026-10-11)

Plan: docs/superpowers/plans/2026-10-10-copilot-PLAN.md §M2 E2.1 · decisions 0064/0065/0066 · rides E0.2 (`kernel/copilot/act.ts`)
Lane: /opt/hmis-lanes/copilot-appt · Owner answers 2026-10-11: 3 slot buttons · patient by UHID, mobile or name · tele-call yes (own mobile) · no cancel.

## What it does
1. Two act tools in `modules/opd/copilot-tools.ts`: `appointment_book`, `appointment_move` (kind "act", permission
   `opd.appointments.manage`, same as the screen — DECIDED). Web ask box and phone app both; act halt applies.
2. Patient: UHID books straight on. Mobile or name: server lookup with the asker's clearance (`searchPatients`), chat lists
   matches as cards (name, age/sex, UHID, last 4 mobile digits) and the clerk taps one — even when there is one match.
3. Doctor and day read from the words by rules, no model ("Dr X kal", "parso", "Monday", "12 Oct"; same doctor by
   default on a move). Chat shows the next 3 free slots as buttons; one tap makes the proposal.
4. Confirm card: patient name + UHID, doctor, date, time, in person / tele-call. Confirm = existing `POST /copilot/confirm`.
5. Book = `bookAppointment`; move = `rescheduleAppointment` (paid tele-call keeps its payment). Same rows, events and
   numbers as the screen; `source` stays the channel; "via copilot" shown in the list from the `copilot_acts` row.
6. "tele" / "phone pe" in the question = tele-call to the patient's registered mobile; no mobile on record ⇒ "use the
   screen". Pay-first unchanged. Move picks the patient's next live appointment; several ⇒ list to tap.
7. No migration. Cancel stays on the screen. Book/move phrases sit in the phrasebook, so these questions reach no model.

## Done means (become `kernel/copilot/acceptance/` + opd tests; each fails first)
1. A chat booking equals a screen booking (same row fields, event, appointment no. series) except "via copilot".
2. G7: on the fixture, every `copilot_acts.subject_patient_id` equals the appointment event's patient id (query test).
3. A chat-booked tele-call is absent from the doctor's queue until paid; a moved paid tele-call keeps its payment.
4. A name with 2 matches makes no proposal until one is tapped; a sealed patient never appears to a clerk without clearance.
5. Slot taken between propose and confirm ⇒ "slot just taken", nothing written; doctor on leave ⇒ refused.
6. "Dr X kal 10 baje [a UHID] ka appointment" routes by phrasebook: zero chooser/model calls (call count asserted).
7. Without `opd.appointments.manage`, or with act halt on, nothing is proposed or written.
8. Phone and web show the same answer text (parity test); browser walk on staging, web and phone widths.
