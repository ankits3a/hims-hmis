# Review — the patient self-service series (rulings, plan, five phase docs)

**Date:** 2026-08-28 · **Reviewer:** an independent session on the build host, reading code, not plans · **Status:** findings; nothing here is approved for execution.

**What was read, in order:** `06-RULINGS-LOCKED.md` · `07-IMPLEMENTATION-PLAN.md` · `03-JOURNEY-SEGMENTS.md` · the five phase docs (22c-A/B/C, 22a-1/2) · the segment deep-dives 04/05/08/09/10 · `00-RECORD-AND-PLAN.md` §5A/§6/§7 · `01-MEDANTA-TEARDOWN.md` §2, §G/H/I/J · `02-PLAN-22A-PAYMENTS.md` §1.2, §8, §9 · `EXECUTE-METHOD-V3.md` · `AGENT-RULES.md` §1, §3, §5 · department series `00-INDEX`, `02-central-lab` (release, interlock, sealed classes), `01-radiology` (PCPNDT, release). The ledger was **not** read (cited by number where the phase docs cite it).

**Every ground-truth claim in the five docs was re-measured** (§4 below). All of them held. The defects are not in the measurements; they are in the seams the measurements did not reach.

**CONFIRMED** = verified against code on this host, file:line given. **PLAUSIBLE** = reasoned from the docs and the schema, not executed.

---

## 1. Defects, ranked

### D1 — CRITICAL · CONFIRMED · 22a-1 T8 / 22a-2 DD1 — an automatic refund-to-source leaves the patient's advance balance intact

`advanceOf` (`modules/billing/receipts.ts:158-171`) is **Σ receipt totals − Σ effective allocations − Σ advance-refund vouchers**. Nothing else. 22a-2 DD1 correctly observes that `refund_vouchers.approval_id` is `NOT NULL` (`schema/billing.ts:226`) and that the approvals kernel refuses a system actor at both ends — `requestApproval` (`kernel/approvals/requests.ts:36`) and `approveRequest` (`decisions.ts:42`, *"a system actor would bypass the approver-role check"*) — and concludes that 22a-1's automatic refunds are `payment_refunds` rows, not vouchers.

Put those together with 22a-1 T6 A16 (*booking lost its slot ⇒ receipt still written, allocation omitted, refund raised*): the receipt is an **advance**; the money goes back through the gateway as a `payment_refunds` row; `advanceOf(patient)` still reports the full amount. The counter's `advance_refund` guard (`refunds.ts:479-480`, *"the ask must fit inside the patient's advance balance"*) passes, so the same rupee can be refunded a second time in cash at a desk — or allocated to the next invoice for a free consult. This is a silent double refund, on the most common hospital-fault path, and none of A24–A27 would catch it (they test the refund object, not the balance it should have consumed).

**Fix (minimal, in 22a-1 T8):** `advanceOfExcluding` subtracts `payment_refunds` in every non-failed state for the patient's online receipts, and T8 gains the assertion *"after an automatic refund of an unallocated online receipt, `advanceOf(patient)` is 0"* with the mutant *"subtract vouchers only"* — it must die at `{advance: 50000, refunded: 50000}`. **Fix (right, in 22a-2 DD1):** every rupee that leaves is a voucher. That needs a kernel `grantByPolicy(tx, typeKey, …)` that creates an already-granted approval row with `decided_by = 'policy:<type>'` — the approvals kernel's refusal is about a *human-shaped* auto-approve, not a bounded policy one; say so in the kernel and pin it. Until (b) exists, (a) is mandatory.

**A second gap in the same seam:** a gateway refund is **asynchronous and can fail** (Razorpay: `pending → processed | failed`, with `refund.processed` / `refund.failed` webhooks; a refund to a closed account bounces days later). Neither 22a doc models `payment_refunds.status`, the refund webhooks, or what happens to a voucher marked `paid` when the gateway later says `failed`. A voucher's `paid` must mean *processed*, not *initiated*; a failed refund is a worklist row for 22a-2 T3's surface. Add to 22a-1 T4 (webhook kinds) and T8 (states), and to 22a-2 T6 (the voucher's `paid` transition waits on `processed`).

### D2 — CRITICAL · CONFIRMED · 22a-1 T6 (and 22cC T7) — the "success transaction" has nothing to allocate to, because the encounter does not exist yet

`feeCovered` (`modules/billing/gate.ts:45-50`) looks for an invoice with **`invoices.encounter_id = <this encounter>`** carrying the fee line. The encounter is minted at **check-in** (`checkInAppointment` → `openVisitInTx`, `modules/opd/encounters.ts:57-104`). At booking time there is no encounter, and `invoices` is immutable (the 0012 trigger set), so an invoice issued at booking cannot be back-filled with the encounter id later.

Therefore 22a-1 T6's *intent → receipt → tender → allocation → booking* cannot be built as written, and A17 (*`fee_unsettled` clears the instant the transaction commits*) is unreachable at booking. The same hole sits under 22cC T7's pay-later-at-counter and every "prepaid appointment" in the segment docs (S4-01, S4-14, S5-16).

**The correct shape, which the ledger already supports:** a prepayment is an **advance** — `receipts.ts`'s own comment: *"a bill payment and an advance are the SAME row — the difference is allocation."* The online success transaction is *intent → receipt → tender → booking (hold→booked)*, **no allocation**. At **check-in**, inside `checkInAppointment`'s transaction, billing issues the consult invoice for the new encounter and allocates from the advance — through a **dependency-inverted hook** (the `ConsultStartGuard` / `registerConsultStartGuard` precedent, `gate.ts:10-27`; the ESLint isolation rule forbids OPD importing billing). Then `feeCovered` is true at the consult door, which is the only place it is read.

Three consequences the docs must state: (i) "paid" on the UNPAID card means *advance held against this booking*, and the desk needs the same word; (ii) the visit type the encounter stamps at open (`encounters.ts:74`) may differ from the prospective one (an intervening visit turns a `renewal` into a free `revisit`) — the advance then stays an advance and R-13's 90-day credit rule applies, no refund cycle; (iii) 22a-1 A19 (cash law unchanged) and A18 (revisit never reaches the path) move to check-in time. **This hook is money, so it belongs to 22a-1; M3 (check-in) consumes it.** If M3 executes before 22a-1, the hook lands in M3 with 22a-1's Assertion Book rows.

### D3 — MAJOR · CONFIRMED · 22cC DD1/T1/T4 — three declarations of "live", not one

The predicate is declared **three times**: the index (`schema/opd.ts:151-153`, migration 0010:223), `LIVE_APPOINTMENT_STATUSES` exported from `appointments.ts:18`, and a **private copy** at `schedules.ts:111` that feeds `availableSlots(...).booked` (`schedules.ts:124-131` → `slots.ts` `booked: booked.has(s)`). 22cC T1 changes only the index. A `held` row would then block the insert (correct) but **render as free** in `availableSlots` and in every projection built from it — the opposite of DD7 (*taken slots render disabled*), and every patient who clicks a held slot gets `slot_taken` instead of a disabled cell. T4's A5 mutant tests the index alone and would pass.

**Fix:** T1's Files list gains `schedules.ts` and `appointments.ts` (and the two lists should become one import — the private copy is a latent §2.78-class defect already). T3/T4 gain: *"a held slot renders `booked: true` from `availableSlots`"*, mutant: drop `'held'` from `schedules.ts:111`.

### D4 — MAJOR · CONFIRMED (by reading) · 22cC T1 — the CHECK constraint is inverted

T1 writes `status <> 'held' OR appointment_no IS NULL`. For every non-held row the left disjunct is true, so the constraint is a tautology there; it only forces *held ⇒ null*. DD2 says *"NOT NULL for every status except `held`"* — the direction the constraint does not enforce. A `booked` row with a null number would be accepted, and nothing prints.

**Fix:** `(status = 'held') = (appointment_no IS NULL)`, the exact shape the house already uses for `ot_case_implants_source_lot_ck` (0035:66). Add to T4: *"a non-held row with a null number is refused by the database"*, mutant: the one-directional form.

### D5 — MAJOR · CONFIRMED · 22cC T4 — holds are invisible to leave, and conversion re-checks nothing

`scheduleLeave` flips **`booked` only** to `needs_rebooking` (`leaves.ts:40-42`); `cancelLeave` restores only what it pushed (`:75-76`). A `held` row on a leave day survives untouched, and T4's hold→booked is an in-place UPDATE (A6) that, as described, does not re-run `assertNotOnLeave`, `doctor.active`, or the `availableSlots` membership check that `bookAppointment` runs (`appointments.ts:48-58`). S3-10 (*hold survives or fails loudly*) has no task.

**Fix:** conversion re-runs the three checks inside its transaction and returns `doctor_on_leave` / `invalid_slot`; `scheduleLeave` releases held rows (`status='released', release_reason='doctor_leave'`) and invalidates the projection cells (DD4). Assertion: *a hold on a leave day cannot convert*; mutant: skip the re-check.

### D6 — MAJOR · CONFIRMED · 22cC — `source` is a closed enum and the phase never widens it

`appointmentBooked`'s payload is `source: z.enum(["desk","phone"])` (`opd/events.ts:34`) and the controller body matches (`opd-visits.controller.ts:35`); the schema comment reserves `'self'` for *"Plan 10"*. `appendEvent` validates the payload, so the first self-booking throws a `ZodError` at `appointmentBooked.make`. The Medanta register's I8 (*`source` gains `'self'` and `'kiosk'` — the field every KPI and fraud rule keys off*) is the requirement; no task owns it. Add to T1/T4 Files; `'self' | 'kiosk' | 'call'`.

### D7 — MAJOR · CONFIRMED · 22cB T5 A12 — "byte-identical" is not achievable and is the wrong assertion

Per the band table (`04-S1-IDENTITY.md` §4.2) both the no-match and the cross-phone-match paths **create a new patient** and return its UHID. Two responses that each contain a freshly minted UHID are never byte-identical. What is achievable and what matters: identical **status, schema and field set**, and a **constant server-side write set**. Today only the match path appends `patient.duplicate_suspected` — a second event, a second row, measurable as latency; the doc's DD6 says the emission is on the shared path, but an event carrying a candidate list cannot exist on the path with no candidates unless it is *always* emitted.

**Fix:** emit `patient.registration_screened { candidateCount, bandsHit }` on **every** self-registration in the same transaction (count 0 on no-match); derive `duplicate_suspected` for MRD from it (consumer) or emit it always with an empty list. Reword A12 to *"the response is schema-identical and the transactional write set differs by zero rows"*; mutant: skip the screened event on the no-match path. A14/A15 (confidential/deceased never *surfaced*) stand; note the confidential candidate must still reach the MRD emission, readable only under `patients.confidential.read`.

### D8 — MAJOR · PLAUSIBLE · 22a-1 T6 — daily close and counter recon will swallow online tenders

`runDailyClose` sums **every** tender of the day by `mode` (`daily-close.ts:95-103`, `byMode.upi += …`) with no channel filter; counter recon matches `receipt_tenders.ref_text` for `mode in ('upi','card')` regardless of provenance (`recon.ts:159`). After 22a-1, an online UPI tender lands in the day's counter UPI total and the acquirer's CSV never contains it → a counter mismatch on every self-service payment, from day one. 22a-1 A15 pins `cashier_session_id IS NULL`; nothing pins the two readers. **Add** to T1's S6 audit and to T6: *the daily close reports `online` as its own column and counter recon matches only `channel='counter'`*; mutant: drop the filter.

### D9 — MAJOR · CONFIRMED · 22a-2 S1 is answerable now, and the answer is "no"

`cumulativeAmount` (`kernel/approvals/cumulative.ts:24-56`) aggregates by **patient XOR payee** over the **IST calendar day**, over *requested* amounts of pending+granted rows. It has no approver dimension and no rolling window. DD3 (a per-approver ceiling) needs its own query over `approvals.decided_by` + `decided_at`, on **decided** rows. Also check that `registerApprovalType` can express an amount-banded approver role (supervisor ≤ ₹500, MS ≤ ₹5,000, owner above) — if it holds one `approver_role` per type, S4-R8 is **three types**, not one banded type. Convert S1 into that question.

### D10 — MAJOR · CONFIRMED · M3 (unwritten) — check-in is neither idempotent nor early-tolerant today

`checkInAppointment` claims `booked → checked_in` and throws `appointment_state_conflict` otherwise (`appointments.ts:184-198`); `appointment_not_today` refuses any other date; and `openVisitInTx` **allocates a token and a `waiting_vitals` queue entry immediately** (`encounters.ts:81-96`), regardless of the session's `not_started` status. So S5-01 (*two writes → one token*) needs "already checked in ⇒ 200 with the existing token", and S5-04 (*early arrival held until the session opens*) is not what the code does — a 7 a.m. self check-in takes token 1. `patientCheckedIn.payload.kind` is `"arrival"` only (`encounters.ts:101`); source attribution (self/kiosk/desk/proxy) needs a payload widening. Recorded here so the M3 doc designs it rather than wraps it.

### D11 — MAJOR · PLAUSIBLE · 22cA T2 — `getPatientSummaries` will alias a confidential patient *to themselves*

`registration.ts:347-351`: for `actor.type !== "system"` it checks `hasPermission(db, actor.id, "patients.confidential.read")` — a lookup against the users table. A `patient` actor's id is not a user id → `canSee=false` → `restricted=true` → a confidential patient reading their own record sees `P-4821`, not their name. 22cA's S2 asks about `=== "user"` proxies; this is the sibling class — **`hasPermission(actor.id, …)` called with a non-user id** — and it will recur in every summary/visibility reader. Add it to T2's audit; the rule is *a patient actor is "self" for its own accessible set, and the permission check is bypassed only for that set*.

### D12 — MINOR · CONFIRMED · 22cC S1 is answerable now: yes

`classifyVisit(anchor, now)` (`visit-type.ts:9-13`) is pure with `now` as a parameter — prospective classification is `classifyVisit(anchor, slotStart)`. The anchor query (newest completed consult in the department **across the merge chain**, `encounters.ts:66-73`) is private to OPD; export `classifyVisitAt(db, patientId, departmentId, at)` from OPD and have the app call that, so A12's "same value for the same inputs" is by construction. DD5's fallback ("show the rule") is not needed, but keep it for the *stale-between-booking-and-check-in* case in D2(ii).

### D13 — MINOR · 07-IMPLEMENTATION-PLAN §5 — K2 is drawn on M1's path

The diagram feeds K2 into T4b; K2 lives in 22a-1 T1 and 22cC does not need it. Redraw.

### D14 — MINOR · 22a-1 A13 vs T5 — "respond fast" makes the sweep the executor

If the webhook persists and returns (DD4/A13), the success transaction runs later. T5 is specified as a *stale-intent* sweep. State the cadence for the *fresh* case (seconds) or run the transaction from the webhook after the raw persist and accept the gateway's timeout budget. Either is fine; the doc must pick one.

### D15 — MINOR · CONFIRMED · two locked registers disagree about unpaid reports

`02-central-lab-lims.md` §D2: unpaid OPD report → *"print/WhatsApp blocked (locked)"*, override approval-gated. `06-RULINGS-LOCKED.md` H2/S9-02: *"do not withhold a critical result over money; separate the dues nudge from release."* Both say locked. They are reconcilable — the lab's D3 already exempts criticals, which are phoned regardless — but the portal must obey the lab's `interlock_state` for non-critical unpaid OPD reports, and M5's doc must say so rather than inherit S9-02's broader wording.

---

## 2. What the locked rulings get wrong

### R-08 — release on authorisation, no hold — **partly wrong, and the hospital's own lab plan already contradicts it**

I am not a clinician either; the argument below is from statute and from the department series, not from clinical judgement.

1. **NABL's critical-value callback covers the panic list** — potassium, glucose, troponin, INR, a positive blood culture — values that threaten life in hours. It does **not** cover the results that devastate: a histopathology malignancy, a first reactive HIV, a positive HBsAg/HCV in a family, a genetic result, a positive pregnancy test on a 16-year-old's household phone. Those are never "critical values" in the NABL sense, so the callback does not reach a clinician first, and the ruling's justification does not apply to exactly the class it most needs to.
2. **HIV is statute, not paternalism.** The HIV and AIDS (Prevention and Control) Act 2017 and NACO guidelines require post-test counselling and disclosure to the person by a counsellor/clinician; the lab plan's own E1 says *"no WhatsApp publishing; patient collects in person"* and forces the publish channel to `in_person`. The owner's standing rule stops for law. This is law.
3. **The lab plan has already carved the classes** (`02-central-lab-lims.md` E1 HIV in-person, E4 adolescent sensitive tests → guardian with counselling flag, E9 genetic → sealed class, J3 *"sensitive results in person only"* default for pregnancy/HIV/STI/genetic). R-08 as locked would have the portal override those. Two locked registers cannot both be obeyed.
4. The original "hold every flagged-abnormal" was too broad — every CBC has a flag — and the ruling was right to drop it. The mistake is the swing to blanket release.

**Recommended restatement (data, not code — the R-12 pattern):** *Release on authorisation by default. `release_policy` is a property of the catalogue entry* ∈ `immediate | clinician_first | in_person_only | never` — `in_person_only` for HIV and genetic (statute/NACO), `clinician_first` (bounded, e.g. 72 h or on the clinician's release, whichever first) for histopathology/cytology and first-positive serology, `never` for sealed classes. Images follow their report (S9-18). The hold is bounded so it cannot become the information-blocking the Cures Act direction objects to. M5's phase doc below is written to this restatement; the register row should be amended before M5 executes.

### S4-R3 / X-02 — §269ST grain — **the refusal to decide was right about the law and wrong about the engineering**

§269ST(a) aggregates *"from a person in a day"* — the payer. Our episode is per patient. A family splitting cash across four members defeats a per-patient rule and a per-payer-per-day rule only if the payer is unrecorded. Two facts change the picture: (i) Rule 114B already forces a PAN on cash to a hospital above ₹50,000 — `receipts.pan_number` / `form60` exist (`schema/billing.ts:175-176`) — so payer identity *does* exist on the receipts that matter most; (ii) **refusing cash is never unlawful.** A rule that trips on *whichever grain trips first* — per patient-episode **or** per payer (PAN, else declared payer phone) per day — is a superset of both readings of the statute and needs no counsel to *adopt*, only to *relax*. **Engineering answer:** keep the shipped per-patient grain; add payer aggregation keyed on PAN where present and on a declared payer phone otherwise (capture it on cash receipts at or above the PAN threshold's half, ₹25,000 — the number is a default, not a ruling); the C-2 block fires on the first grain to trip. Counsel's batched question (O-4) shrinks to "may we relax this".

### R-01 vs K3 — as-of-*issue* vs as-of-*encounter*

R-01 says *as-of-issue*; the documents section and K3 say *as-of-encounter, always*. They differ when a name is amended between the encounter and issue (a report authorised three days after collection). The lab and imaging case is exactly that gap. Rule one: **as-of-encounter** (the document describes the person who was seen), with the annotation on reprint. kernel-D below uses that.

### Locked and fine, with one note each

- **P-3 hospital absorbs the fee** — correct; note the GST treatment of the absorbed fee is the CA's, not counsel's (index §4 theme 17).
- **R-11 recycled numbers** — DOB as the second factor is weak inside a household; UHID is the stronger one. Prefer UHID, fall back to DOB + a registered document last-4 where the counter captured one.
- **S1-R2 cap 8** — cap by *verified phone*, not by household: a patient in two households (B6) would otherwise be counted twice.
- **R-15 two concurrent holds per household** — same: cap per verified phone.

---

## 3. Gaps the 170-case register and the ten segments miss

| # | Gap | Where it bites | What to do |
|---|---|---|---|
| **G1** | **Counter-entered phones were never verified.** A clerk mistypes a phone at registration; the stranger who owns that number can OTP-login (22cB T2) and read the record. R-11 covers *recycled* numbers and *new devices*, not *never-verified* numbers — and every pre-22c patient is one | 22cB T2/T6 | `patients.phone_verified_at` (null for every existing row); first app claim of a record whose phone is unverified requires UHID **and** DOB (or the counter). Same for `alt_phone` and clerk-added household members |
| **G2** | **What is a patient actor's `id`?** 22cB DD2 says the session carries the verified *phone*, not a patient; 22cA never says what `Actor.id` is. A phone with three profiles booking for the mother stamps `actor.id = ?` on `appointment.booked`, `bookedBy`, `idempotency_keys.actor_id` | 22cA T2, 22cB T2 | Rule it: `actor.id` = the `patient_credentials` row id (the phone identity), and the *subject* patient is always `patientId` in the envelope. Desk screens resolving `bookedBy` to a user name must tolerate a non-user id |
| **G3** | **Chargebacks** — a *successful* card payment disputed at the issuing bank weeks later, after the consult. Not "failed-but-debited". Money is clawed back from settlement | 22a-2 | `payment_chargebacks` from the gateway's dispute webhook; evidence upload; the invoice's settlement flips to *disputed*; day book shows it |
| **G4** | **Captured amount ≠ intent amount** (partial capture, a gateway-side rounding, a tampered order) | 22a-1 T4/T6 | Assertion: a webhook whose amount differs from the frozen intent amount is an exception, never a success. Mutant: trust the webhook's amount |
| **G5** | **Refund failure states** (D1's second half) | 22a-1 T8, 22a-2 T6 | Model `payment_refunds.status`, the `refund.failed` webhook, and the voucher's `paid` waiting on `processed` |
| **G6** | **Revoked consent vs. a live hold/cart.** The son holds a slot for the mother; she revokes his access (R-09). DD2 makes *reads* re-evaluate per request; the hold and cart are rows | 22cB T6, 22cC T6 | Rule: the hold survives (it is hers), the proxy loses visibility of it on the next request; the cart is orphaned to her. Assertion + mutant |
| **G7** | **Pay-later deadline sweep — where is UNPAID at the desk?** A pay-later booking is a plain `booked` row; the 4-hour sweep must cancel it (reason `unpaid`), release the slot, notify — and S4-09 says never cancel someone in the building, which only check-in can prove | 22cC T7 / M3 | 22cC owns the sweep and the `unpaid` marker on the appointment (a column, so `listAppointments` and the desk list show it); M3 adds the in-building exemption via `checked_in` |
| **G8** | **The verification portal's QR must not carry the code.** If the QR encodes doc-no + code, a photographed QR alone opens the document; Medanta prints the password *beside* the QR for that reason | kernel-D | QR = URL + document number; the code is typed. Code CSPRNG, 8 digits, stored hashed, throttled per document number (enumeration-safe, the `auth_throttle` property) |
| **G9** | **Confidential patients' own documents carry the alias.** `rx-print.tsx:47` already prints the alias when the printing user lacks `confidential.read`. A prescription in the name "P-4821" cannot be filled outside — Schedule H requires the patient's name — and a referral letter in an alias is useless | kernel-D | Rule: the **patient-held original** carries the real name (the alias protects against *staff* surfaces, not against the patient); staff reprints without the permission carry the alias; sealed-class documents never leave the portal |
| **G10** | **OTP economics and DLT.** Transactional SMS in India needs a DLT-registered header and template (TRAI); OTP bombing costs money per send, not just CPU | 22cB T2 | Launch dependency, not procurement: the sender uses the DLT-registered route; add a global send-rate alarm beside the per-number/device throttle |
| **G11** | **Uploads in Postgres.** The only blob precedent is `patient_photos` as `bytea` capped at 512,000 bytes (`schema/patients.ts:102-108`). Pre-consult uploads are multi-MB PDFs × thousands/day; in Postgres they balloon the database and every backup. The 11b storage decision is still pending | M3 T5d | Default (owner-standing-rule DECIDED, tied to 11b): `bytea`, 2 MB/file, 5 files/appointment, purged 90 days after the visit (they are not the record, R-17). Revisit when 11b lands |
| **G12** | **Realtime for the patient app leaks the queue.** Topics are `queue:<doctorId>:<date>` under `opd.queue.read` (`opd/realtime.ts:4-8`) and carry every patient's summary. A patient cannot hold that permission and must not see that topic | M3 T5c | A patient-scoped topic `appointment:<id>` derived from `queue.called`/`queue.skipped`, carrying position only; `orderQueue` reused for the number |
| **G13** | **Position can go up.** `orderQueue` applies danger/re-entry/perk classes and appointment-time ordering; an emergency insert or a perk moves a patient *back*. S6-13 wants this said as it happens | M3 T5c | Position deltas are pushed with a reason class, never silently |
| **G14** | **"Visit summary" is not a document today.** Records (T6) promises visit summaries; the encounter has `diagnosis/advice/followUpDays` fields and the e-Rx already prints them. There is no summary artifact | M4 | A kernel-D document type `visit_summary` issued on `consultation.completed`; or drop the promise |
| **G15** | **Page x of y is not free.** There is no server-side renderer (no pdf/puppeteer/playwright in either `package.json`); printing is browser `.print-doc` CSS at A5 (`styles.css:147-150`). Browser paged-media `counter(pages)` support is uneven; NABL reports want the count | kernel-D | Spike, with the fallback stated: browser print without a total, server-side Chromium as a later dependency |
| **G16** | **DPDP privacy-notice versioning and re-consent** (H8) and the consent record the app must hold before any read | 22cB T8 / M4 | A `privacy_notice_versions` row and `patient_consents(phone_identity, version, at)`; a login against a newer material version re-consents |
| **G17** | **The hold sweep vs. conversion race** is unstated | 22cC T4 | Both are conditional UPDATEs on `status='held'` with opposite `expires_at` predicates; write it down and pin it (A8's sibling) |
| **G18** | **Amended document + old paper.** The old paper's code must resolve to *something*: "superseded by v2, issued <date>" — the holder already has the paper, hiding v1 protects nobody and confuses everyone | kernel-D | Codes are per version; v1's code resolves to v1 with the supersession banner |

---

## 4. Ground truth, re-measured (all held)

| Claim | Doc | Measured |
|---|---|---|
| 36 migrations, next `0036` | 22cA | `ls apps/core/drizzle/*.sql \| wc -l` → 36 ✓ |
| 29 files read `actor.type` | 22cA | 29 ✓ |
| 46 `user_actor_required` sites | 22cA | 46 ✓ |
| 48 `.sex` readers | 22cA | 48 ✓ |
| `patients.sex text NOT NULL` at `patients.ts:55` | 22cA | ✓ line 55 |
| `Actor` is a three-member union | 22cA | `packages/contracts/src/envelope.ts:3` ✓ |
| `patientFuzzyCondition` at `search.ts:186`, `TRIGRAM_THRESHOLD = 0.3`, GIN in 0021 | 22cB | function at :185 (one line off), threshold ✓, `0021_search_trigram.sql` ✓ |
| throttle kinds `login \| pin`, backoff not lockout, enumeration property | 22cB | `kernel/auth/throttle.ts` header ✓ |
| `patient_merge_requests_pending_loser_ux` | 22cB | `patients.ts:193` ✓ |
| slot index predicate, 0010 | 22cC | `0010:223`, `schema/opd.ts:151-153` ✓ |
| `availableSlots` = 4 queries per doctor-day | 22cC | config, templates, leaves, booked rows in `schedules.ts` ✓ |
| `appointment_no` allocated before insert; lost race burns a number | 22cC | `appointments.ts:60-63` ✓ |
| nothing reads `appointment_no` before check-in | 22cC S2 | **nothing reads it at all** outside allocation — no web, contracts or event reader (`grep appointmentNo\|appointment_no` over core/web/packages, non-test) ✓ nullable is free |
| `feeServiceFor` returns null for `revisit` | 22cC | `gate.ts:71-72` ✓ |
| `receipts.cashier_session_id NOT NULL` FK | 22a-1 | `billing.ts:170` ✓ |
| `idempotency_keys (actor_id, route, key)`, claim deleted on failure | 22a-1 | `billing.ts:313-326`, `idempotency.ts:95` ✓ |
| `receipt_tenders.state` lifecycle, `expected_net_paise` | 22a-1 | `billing.ts:183-194` ✓ |
| `reconUpload({csv, source:'upi'\|'card'})` | 22a-1/2 | `recon.ts:112,122` ✓ |
| `refund_vouchers.approval_id NOT NULL`, methods `cash\|bank_transfer`, payee identity | 22a-2 | `billing.ts:211-233` ✓ |
| `cumulativeAmount` exists | 22a-2 | ✓ — but per patient/payee only (D9) |
| `orphanScan` in daily-close | 22a-2 | present ✓ |
| Plan 16a rate 20,178; Plan 14 passes 244,568 + 213,923 | all | `pipelines/token-baselines.json` ✓ |

---

## 5. The eight questions, answered

**(a) `held` in the predicate.** Adding a status to the partial index is safe for the insert path: `onConflictDoNothing()` with no target handles every unique violation including a partial index, so a hold conflict yields `slot_taken` exactly as a booking does. It breaks nothing in `checkIn` (requires `booked`), `reschedule`/`cancel` (require `booked|needs_rebooking`), or `sweepAppointmentNoShows` (selects `booked`). It **does** break the grid (D3) and is invisible to leave (D5), and the same-patient re-hold from another device (A9) must be a lookup *before* the insert because the index will refuse it. A10's "your hold expired" needs the expired row kept (`status='expired'`), not deleted.

**(b) `appointment_no` nullable.** Free — nothing reads it (§4). Fix the constraint direction (D4).

**(c) Byte-identical.** Not achievable as stated; schema-identical with a constant write set is (D7).

**(d) Voucher + `payment_refunds`.** Not over-engineered — under-applied. The voucher is the only object `advanceOf` and the day book understand; a refund that is not a voucher is invisible to both (D1). The right end state is *every* refund is a voucher, with a policy grant for the automatic ones.

**(e) R-08.** Take the other side for a named class of results; the lab plan already did (§2).

**(f) §269ST.** Refusing to change the shipped grain was right; there is a defensible engineering answer that needs no counsel to adopt (§2).

**(g) Slices.** M1 into three is right. 22a into two is right **but 22a-1 is not a safe minimum as written** (D1, D2). And **the M2 go-live gate is wrong**: 07 §6 gate 2 lists A7/A8/A9 only; a system taking money without settlement reconciliation (A12), the absence watcher, or a dispute surface (A13) is one that cannot tell for weeks whether the money arrived, and whose first debited-but-failed patient meets a blind cashier. Recommend: 22a-1 stays a *code* slice; production online payment waits for 22a-2 T2 and T3. Concessions (A14) depend on nothing in 22a and every hospital needs them week one — they can execute as a half-day phase of their own whenever a session is free.

**(h) Stop-loss.** The arithmetic is muddled but the number is fine. For a LIGHT phase the "per-task rate" *is* the reviewer (the docs admit it), so the task term and the review term are the same cost counted twice, and the total is insensitive to task count — 22cA's 7 tasks and 22a-1's 9 differ by 9%. The honest LIGHT formula is *review passes × measured per-pass × 1.5*: `1.5 × 2 × 229,246 (Plan 14's mean pass) = 687,738`, within 2% of every number the series carries. Keep the numbers; state the derivation as that, and add 22a-1's escalation clause (a third pass needs owner authorisation) to every money phase. The docs below use this form.

---

## 6. The four unwritten phase docs — scope and order

| Doc | 07's scope | Verdict | Written as |
|---|---|---|---|
| **kernel-D** | K3: chrome, snapshot, number, QR + code, authorship, amendment | Correct, with three changes: **gate it on 22cA** (the renderer needs `resolveIdentityAt` and `patient_identity_versions`; 07 draws K3 ‖ K4, which is wrong); **move 22cA T6's conversion of the two print surfaces into kernel-D** so they are converted once, to the chrome, not twice; **the public verification lookup belongs here** (it is the same code path as issue, and lab needs it), leaving only patient-side controls to M4 | `2026-08-28-phase1-kernelD-document-chrome.md` |
| **M3** | T5a–T5d | Correct, plus D10/G7/G11/G12/G13 and the check-in billing hook from D2 (consumed, owned by 22a-1) | `2026-08-28-phase1-22cD-appointment-journey.md` |
| **M4** | T6, T7 | T7's public page moves to kernel-D; M4 keeps household-scoped records, release of prescriptions/receipts/visit summaries (G14), patient-side verification controls (S9-15, S9-14), close-app-account (R-10), DPDP export (H7), notice versioning (G16) | `2026-08-28-phase1-22cE-records-and-account.md` |
| **M5** | T8, T9 | **Cannot be execution-ready**: Plan 17 (lab) and 18 (imaging) are unbuilt — `apps/core/src/modules/` has no lab or radiology module; only the series letters `L S R` are reserved. Written as a **contract phase**: the record-source seam, the release-policy vocabulary (R-08 restated), the two document types through kernel-D, and images gated on O-1 | `2026-08-28-phase1-22cF-reports-and-images.md` |

**Write order:** kernel-D → M3 → M4 → M5 (done below in that order). **Execution order recommended:** 22cA → **kernel-D** → 22cB → 22cC (= M1) → 22a-1 → 22a-2 (= M2, go-live gate amended per (g)) → M3 → M4 → M5. Two of the four (M3, M4) do not depend on M2 and can run before it if the owner wants queue relief before online money.
