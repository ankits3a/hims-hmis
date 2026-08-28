# Locked decisions — patient self-service, payments, documents
**Date:** 2026-08-28 · **Status:** LOCKED under the owner's standing instruction
**Instruction:** *"When in confusion, go ahead with standard practice that is followed in industry. When all the blockers and decisions are finalised and locked, move ahead."*

Every open question from this series, decided. Where the series recommended something and
the owner did not object, the recommendation is locked. Where we were uncertain, **the
decision is whatever the industry does**, named below.

**Unlocking.** Any row may be reopened by the owner at any time. Three rows marked 🔒⚖ are
**legal**, not engineering — they are locked to the safe default and must be confirmed by
counsel before the behaviour they govern goes live. Two rows marked 🔒₹ carry a rupee
figure and need the owner's number, not a decision.

---

## 1. Identity & amendment

| # | Question | **Locked** | Basis |
|---|---|---|---|
| R-01 | As-of-issue or current demographics on a document? | **As-of-issue**, with a "current name" annotation on reprints | Universal EMR practice; a clinical document is a point-in-time record. Medanta's own reports prove the failure mode |
| R-02 | Who approves a Class I amendment after an artifact exists? | **Registration supervisor or MRD — a second click**, not the owner-approval kernel | Owner-gating pushes staff into creating duplicates, which is worse |
| R-03 | Evidence or reason-only for a first correction? | **Reason-only inside the typo window; evidence mandatory after** | Standard MRD amendment practice |
| R-04 | Former names — searchable by whom? | **Matched but not shown.** Search finds on the old name; seeing it needs a permission | Keeps dedup and MRD retrieval working without printing history on every screen |
| R-05 | Split administrative gender from clinical sex? | **Yes.** Two fields | HL7/FHIR `administrativeGender` vs sex-for-clinical-use; USCDI models it this way. Also Transgender Persons Act 2019 / NALSA |
| R-06 | Move `isConfidential` and `deceasedAt` off `patients.update`? | **Yes** — `patients.confidential.write` and `patients.deceased.write` | Least privilege; these are safety flags, not demographics |
| R-07 | Notify anyone proactively of an amendment? | **No**, except a statutory MLC context and a payer with a claim in flight | |
| S1-R1 | Same-phone dedup match — auto-link on confirm? | **Yes, on confirm** | The caller demonstrably controls the number we already hold |
| S1-R2 | Household member cap | **8**, counter-raisable | Aimed at touts; must not punish a joint family |
| S1-R3 | Class I amendment above `self_declared` without evidence | **Drops to `staff_verified`** | Makes the assurance stamp mean something |
| S1-R4 | May self-service request confidential status? | **Yes — provisional alias applies immediately**, counter task raised | Without it, staff-as-patients are exposed on day one |
| S1-R5 | Draft TTL | **24 h live, readable 7 days** | |
| S1-R6 | May the call centre complete a registration? | **Draft only** | A voice on a phone is not identity verification |

---

## 2. Privacy, family and records

| # | Question | **Locked** | Basis |
|---|---|---|---|
| R-08 | Which results reach the phone without a clinician? | **Release on authorisation — no artificial hold.** Sealed classes never auto-release. Critical values reach the ordering clinician **first by telephone**, per NABL critical-value notification | This *is* the standard, and it is better than the hold I recommended earlier: NABL already mandates the callback, so the clinician is reached before the patient regardless. An artificial portal hold adds paternalism without adding safety, and the global direction (US Cures Act) is against it |
| R-09 | Adult family access default | **Consent-required.** Dependents full access; adults `pending` until they OTP-consent; revocable; silent revocation counter-only | Every mature patient portal works this way |
| R-10 | What does "delete my account" delete? | **App access only.** Clinical record retained under law, with the reason stated on the screen. Renamed **"Close app account"** | DPDP erasure is not absolute against clinical retention |
| R-11 | Recycled phone numbers | **Dormancy re-verification + a second factor (DOB or UHID) on first login from a new device** | Standard account-recovery hygiene |
| R-17 | Do patient-uploaded documents enter the medical record? | **No.** Visible to the treating team, marked patient-supplied | Universal portal practice |
| — | Image retention in the portal | **Clinical retention per R-009; portal availability 3 years, retrieval-on-request beyond** 🔒₹ | Storage cost is the owner's number, not ours |

---

## 3. Booking, queue and journey

| # | Question | **Locked** | Basis |
|---|---|---|---|
| R-12 | Which services may be booked pay-later? | **A property of the service in the tariff.** Consult yes; packages and diagnostics no | |
| R-13 / P-7 | Paid no-show | **Credited to the next visit within 90 days** | Forfeiture reads as a penalty; refund invites casual booking |
| R-14 | Which fee binds when the tariff moves mid-flow? | **The displayed fee, for the life of the hold.** On a *decrease*, no automatic adjustment; the counter may credit on request (S4-R5) | Symmetry — the rule cannot only run in our favour |
| R-15 | Concurrent slot holds per household | **2** | |
| R-16 | Show live queue position? | **Yes** | Data already exists; it is our clearest advantage |
| S5-05 | Patient arrives after their slot | **15-minute grace, then re-queued at the back**, doctor's discretion to override | Standard OPD practice |
| S10-04 | Revisit fee across doctors in one department | **Applies within the department** | Standard; the patient cannot be expected to know which doctor is "theirs" |
| — | Unpaid order expiry | **30 days, then closed with a reason** | |
| — | Manual queue reorder | **Allowed, with a reason and an audit entry** | The desk will do it verbally regardless; model it rather than pretend |
| — | May a proxy build a cart for someone outside their household? | **No** | Otherwise anyone can book in anyone's name |

---

## 4. Payments

| # | Question | **Locked** | Basis |
|---|---|---|---|
| P-1 | Gateway | **Razorpay** | Best webhook reliability and documentation; full refund-to-source and partial refunds; settlement report API. Adapter is five functions, so swappable |
| P-2 | Settlement bank account | **Separate from counter collections** | Shared makes reconciliation permanently ambiguous |
| P-3 | Who bears the gateway fee? | **The hospital absorbs it** 🔒⚖ | UPI and RuPay debit carry zero MDR by statute and a convenience fee on them is not permitted; card surcharging is network-prohibited in practice. Counsel to confirm before any contrary design |
| P-4 | Pay-later deadline | **4 hours before the slot.** Bookings made inside 4 hours require payment upfront | Standard clinic-app practice; protects the doctor's morning |
| P-5 | Hold model | **Two clocks — interaction 10 min, pending 20 min, then hold releases and the intent lives.** Late landing: **slot free → re-take; slot taken → advance + auto-refund** | |
| P-6 | Maximum `pending` before a sweep fails it | **7 days** | |
| S4-R1 | May a cashier take cash against a `pending` intent? | **No.** Wait, or have the patient complete it | The single rule that prevents most double collection |
| S4-R2 | Refund identity check for a non-household payer | **Above ₹10,000** | Matches Plan 08's existing bank-transfer threshold |
| S4-R3 | C-2 cash episode grain — patient or household? | **Keep per-patient, and add payer-level aggregation alongside it** 🔒⚖ | §269ST is drafted *"from a person"* — the payer — while our shipped episode is per patient. Do not change the shipped grain on our own judgment; add the second view and have counsel say which binds |
| S4-R4 | Minimum refund amount | **₹50.** Below it, credit the patient's account | A ₹5 refund costs more in fees than it returns |
| S4-R6 | Refund when the patient has died | **Counter-only, claimant identity verified, approval-gated** | No graceful automation exists |
| S4-R7 | One payment across several patients' carts | **Allowed** | It is the normal family case; refusing it sends them to two queues |
| S4-R8 | Concession / waiver ceiling and approver | **≤ ₹500 front-office supervisor · ≤ ₹5,000 medical superintendent · above, owner.** Reason-classed, visible in the daily close 🔒₹ | Every hospital does this from week one. Figures are the owner's to set |
| X-01 | Refund-to-source returns money to a tout who paid | **Above ₹10k with a payer outside the patient's household → counter identity check** | The control and the harm point the same way; this splits them |
| X-04 | Refund below the fee cost | Covered by S4-R4 | |
| X-07 | Card testing on the public checkout | **Launch requirement, not hardening.** No arbitrary-amount endpoint; per-IP and per-device velocity limits; gateway failure-rate alarm | Standard PSP guidance; the acquirer will notice before we do |
| X-10 | Insider manual refund | **SoD: requester ≠ approver ≠ payee**, plus a payee identity check | Standard treasury control |
| X-14 | Which timestamp owns the accounting day? | **Capture** — never settlement, never the redirect | |

---

## 5. Documents

| # | Question | **Locked** | Basis |
|---|---|---|---|
| — | Document chrome | **One kernel component.** Three-zone header with a type-varying third zone, department band, standard footer with emergency number, CIN, printed-by, page x of y | Copied from Medanta, which got the structure right |
| — | Demographics on a document | **As-of-encounter, always** (R-01), enforced in the renderer, not trusted to callers | |
| — | Document verification | **Document number + QR + numeric access code**, public page, no login, rate-limited, retrieval logged, code revocable | Copied from Medanta; it is the best idea in their document set |
| — | Authorship block | **Performed / prepared / authorized** — timestamped, named, with the acting user | NABL and NABH both expect traceability; Medanta's radiology block is the model |
| — | Amendment | **Reissue marked AMENDED with a reason class; original retained** | NABL requirement; already half-ruled as series R-018 |
| — | Medico-legal disclaimers on results | **We do not print "not valid for medico-legal purposes"** | Legally hollow on an accredited result, and it corrodes trust in the number above it |
| — | Research/education use of specimens | **Real consent at registration, never footer small print** | DPDP; footer notices are not consent |

---

## 6. Still genuinely open — owner or procurement, not decidable by us

| # | Question | Blocks | What is needed |
|---|---|---|---|
| **O-1** | **PACS choice and image storage** | 22c-T9 only | A rupee figure. Recommendation: **Orthanc + OHIF** (open source, DICOMweb native) for a solo-AI build, unless the radiology contract mandates a commercial PACS. Ties to the pending 11b hybrid/on-prem decision |
| **O-2** | **Pine Labs integration mode** | Kiosk only | Ask the vendor: cloud API with an independent callback, or local ECR link? A local-only link dies with the kiosk app, which changes the whole failure design |
| **O-3** | Concession ceilings (S4-R8) and image retention window | Both have a default above | The owner's numbers |
| **O-4** | Counsel: P-3 surcharging · S4-R3 cash grain · RBI reversal timelines quoted to patients | Nothing on the critical path | One legal review, batched |

**None of these blocks the critical path.** O-1 and O-2 gate the last two milestones only.

---

## 7. Changes to earlier recommendations

Two, both toward the industry standard:

1. **R-08** — I previously recommended holding flagged-abnormal results for clinician
   release. **Locked as release-on-authorisation instead.** NABL already mandates a
   telephone callback to the ordering clinician for critical values, so the clinician is
   reached first regardless; an artificial portal hold adds paternalism without safety.
2. **R-14** — extended to cover a fee *decrease* after payment, so the rule does not only
   run in the hospital's favour.
