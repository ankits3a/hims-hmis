# 0010 — Lab reception, collection, bench and report rules

- **Date:** 2026-09-25   **Status:** Ruled — ruling 12 superseded by 0013
- **Area:** lab, billing, front desk, printing

## Decision

1. **No token until billed**, "but follow industry best practices". Standard exceptions (DECIDED):
   - Emergency/STAT: the draw comes first and the bill follows, under a waiver in the ordering doctor's name.
   - IPD: charges post to the admission's running bill.
   - Corporate, TPA and schemes: credit against the payer's letter or pre-authorisation.
2. **No discount at the reception** ("this is a hospital, not a kirana store"). A discount needs a supervisor's
   approval, at most 10%. Membership or scheme tariffs are price rules, not counter discounts (DECIDED, open to the
   owner's objection).
3. **Wallet: deduct only.** Reception never takes an advance deposit; advances are taken at the front desk.
4. **Any linked phone number of the patient receives the report.** Legal carve-out kept: HIV status needs the
   person's informed consent before disclosure (HIV and AIDS Act 2017, s.8), so restricted records are handed over
   in person only.
5. **No refund after the sample is drawn** — tightened by ruling 7.
6. **The lab counter never registers a patient** (*"remove the 'Register Walk-in', let the patient register
   themselves at the front desk"*). A walk-in with no UHID is sent to the front desk, and that act is logged.
7. **No refund after the TOKEN.** A patient who refuses or leaves goes back to reception, and the order is held.
8. **Not fasting:** rebook without charge, or HOLD the order until the patient returns fasting within 7 days.
   - Home-collection visit charge: none for now ("will add later").
9. **Reflex tests** (top-hospital standard): reception asks, as an optional check, whether extra tests may be added
   if a result needs them. A reflex test is billed at the listed price on its OWN bill, so the per-invoice delivery
   interlock holds only that part of the report until paid. If the patient said no, the doctor is told and nothing
   is added.
10. **A redraw caused by the hospital** (haemolysed, clotted, too little, wrong tube, label mismatch, leaked, too long
    in transit) is always free to the patient; the cost is charged to collection or transport.
11. **Who is named on a printed lab report** ("go ahead medical college & hospital standards and norms"; DECIDED):
    - The authorising pathologist prints in full: name, MD (Pathology), designation (e.g. Associate Professor,
      Department of Pathology), Doctor ID, e-signature time, and a QR to verify the report (ISO 15189 / NABL).
    - The referring doctor prints as Doctor ID + department only (keeps the 2026-09-06 Doctor-ID-only ruling).
    - No auto-verification. Every report is signed by a pathologist; all-normal reports may be signed together in a
      batch, each logged in the pathologist's name.
    - The e-signature is a PIN asked once every 15 minutes. Three wrong tries lock signing and page the lab director.
12. **Report hand-over (2026-09-26):** a patient's copy held for an unpaid bill is released without payment ONLY by
    the billing manager, and the dues stay on the account. A lab supervisor who tries is refused with
    `release_not_authorised`. The doctor's copy is never held.
    **Superseded by 0013:** once credit became owner-only hospital-wide, releasing an unpaid report moved to the
    owner's approval (approval type `lab_release_unpaid_owner`).

**Standing instruction:** for any lab money question not yet ruled, use the standard of a top Indian corporate
hospital and mark it DECIDED.

## Why

These are money and law rulings, which only the owner makes.

## Consequences / how to apply

- Every lab reception screen and any lab billing code follows these rules.
- Dashboard: the owner removed the Next card, the tiles and "Needs reception" (the right sidebar already shows
  them); quick actions sit inside the scan card.
- Screen board: "Lab Reception Counter", https://claude.ai/artifact/Q55XsWxk8h4rpBK7XfhAN2 (synthetic prices, not
  benchmarked).
