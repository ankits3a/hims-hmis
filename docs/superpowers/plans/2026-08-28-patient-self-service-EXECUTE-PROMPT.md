# EXECUTE PROMPT — the patient self-service programme, in order

**For the executing session (Opus), on the build host, in `/opt/hmis`.** Paste this file's path as the seed; read nothing else first.

---

## 0. What you are, and what you are not

You are the **main session of a LIGHT-lane phase under EXECUTE-METHOD-V3 §3**. That means:

- **You code, task by task, sequentially, yourself.** No coding subagents. No Workflow tool. No compiled pipeline. The v3 pilot data (Plans 11e → 14, `pipelines/token-baselines.json`) is unambiguous: in-session coding with one or two *fresh* reviewer agents at close beats every multi-agent shape this project has tried, by 5–13×, with nothing verified less.
- **Subagents are used for exactly one thing: the independent close review.** One fresh-context reviewer agent after the phase's last task; a **second fresh** agent over the remediation if the first found anything (v3 §6 amendment, §9.5 — *resume for MEMORY, spawn FRESH for SCOPE*; never resume a reviewer to re-check a diff). Restricted tool set, no MCP roster, pointed at the phase's commits and `AGENT-RULES.md`, cited ledger entries by number.
- **The Workflow tool is NOT to be used for any phase in this programme.** Every phase document below rules LIGHT; a workflow would re-create the brief-compilation and context-re-billing classes v3 §3 deleted. If a phase turns out to exceed one context, **stop and say so** — re-tiering to HEAVY is the owner's call (v3 §7), not yours.

You are **not** authorised to deploy, to widen your own permissions, or to run anything against `/opt/hmis-prod`. Deploys are owner-authorised in as many words, per phase, after CLOSE.

## 1. Read, in this order, before the first tool call

1. `docs/superpowers/AGENT-RULES.md` — in full. Rule 3 (no `/tmp`, ever — the heredoc alternative), rule 21 (build the mutant, never predict it), §3 (mutant discipline by tier), §5 (the finish block), §6 (migrations are irreversible host mutations).
2. `docs/superpowers/EXECUTE-METHOD-V3.md` §3 (the LIGHT lane), §6 (stop-loss), §9.1/§9.5/§9.6 (context, resumed agents, handoffs spend their last budget on running).
3. `docs/superpowers/plans/reports/2026-08-26-parallel-session-protocol.md` — **another session may be executing Plan 15 in this checkout.** Run its §2 pre-flight before every phase and before every broad suite. Never `git add -A`. Read `git status --porcelain` before every `git add`.
4. `docs/superpowers/plans/reports/2026-08-28-patient-self-service-review.md` — the review that found 15 defects and 18 gaps in the phase docs. **Its defect fixes are amendments to the phase docs and bind you where the docs and the review disagree** (§4 below says how).
5. The ledger `reports/EXECUTION-LESSONS.md` — **§5 only** (lines 1132–1146). Never the whole file: 377 KB, re-billed per tool call. Entries cited by number in a phase doc are read by number.
6. The phase document for the phase you are about to execute — and only that one.

Do **not** read the brainstorm series, the department series, or the other phase docs unless the current phase doc points at a specific section.

## 2. The order, and the gates between phases

Execute strictly in this order. Each phase starts only when the previous one's CLOSE §6.6 is written and its reviewer's CRITICAL findings are remediated and re-reviewed.

| # | Phase | Document | Gate to start | Milestone |
|---|---|---|---|---|
| 1 | **22c-A** patient actor + identity spine | `2026-08-28-phase1-22cA-patient-actor-identity-spine.md` | none — **this is the single point of failure; do it first and alone** | — |
| 2 | **kernel-D** document chrome | `2026-08-28-phase1-kernelD-document-chrome.md` | 22c-A closed (it reads `resolveIdentityAt`) | — |
| 3 | **22c-B** self-registration | `2026-08-28-phase1-22cB-self-registration.md` | 22c-A closed | — |
| 4 | **22c-C** browse and book | `2026-08-28-phase1-22cC-browse-and-book.md` | 22c-B closed | **M1** |
| 5 | **22a-1** payments, money in | `2026-08-28-phase1-22a1-payment-money-in.md` | 22c-C closed; **Razorpay sandbox account exists (owner action P-1)** | — |
| 6 | **22a-2** reconciliation, refunds, concessions | `2026-08-28-phase1-22a2-reconciliation-refunds-concessions.md` | 22a-1 closed | **M2** — and **online payment does not go live before this phase's T2 and T3 are green** (review §5(g)) |
| 7 | **22c-D** appointment journey | `2026-08-28-phase1-22cD-appointment-journey.md` | 22c-C closed (may run before 5–6 if the owner says so) | **M3** |
| 8 | **22c-E** records and account | `2026-08-28-phase1-22cE-records-and-account.md` | kernel-D and 22c-B closed | **M4** |
| 9 | **22c-F** reports and images | `2026-08-28-phase1-22cF-reports-and-images.md` | **Plan 17 shipped** (half A); Plan 18 + O-1 (half B). **Do not start this phase from this prompt** — it is a contract phase and its §2 must be re-measured against Plan 17's real tables first | M5 |

**One phase per session is the expected shape.** If context allows two, the second starts only after the first's CLOSE is committed — never interleave. If you must hand off mid-phase, v3 §9.6 governs: typecheck, run the narrowest suite, *then* write the handoff.

## 3. Per phase — the loop

1. **Pre-flight** (parallel-session protocol §2). Note who else is working and which migration number is free — the phase doc's number is a label; **the free number is the fact**.
2. **Re-measure §2 of the phase doc** (AGENT-RULES §6). Every `how` column is a command; run it. A changed number is corrected in place in the doc, with the date. Do not proceed on a stale measurement.
3. **Answer the spike (§3)** by the cheapest honest means — read-only SQL against production from the main session where that suffices; never a write. Record answers in §6.3 *before* T1.
4. **Apply the review's amendments for this phase** (§4 of this prompt) to the doc's task text and Assertion Books *before* coding, so the executed book is the amended book.
5. **Tasks in order.** For each: Files list, tests, and for CRITICAL tasks every Assertion Book row's mutant **built and executed** as a separate scratch file beside the source, run isolated, DIED/SURVIVED with counts (rule 21). A surviving required-DIED mutant is a CHAIN HALT with the two branches of AGENT-RULES §3 — never fixed silently. Finish block (§5) per task: read porcelain, `rm -f` scratch, commit with the plan's message, pull --rebase, push, report the SHA.
6. **CI watched, not assumed:** `docs/superpowers/pipelines/ci-watch-host.sh` by full SHA, in the background, from the first commit.
7. **Stop-loss:** the phase doc's number is a tripwire. Crossing it halts for an owner decision — do not quietly continue, and do not pad. 22a-1's escalation clause (a third review pass needs owner authorisation) applies to every money phase.
8. **Close:** one fresh reviewer agent over every commit of the phase (v3 §3.4). CRITICAL findings block close. Remediate; **second fresh reviewer** over the remediation. Then mechanical close (detached `pnpm verify` with the exit value read from a file, per-commit `git show --stat` against Files lists, frozen-path audit, clean tree), the actuals row, and `pipelines/token-audit.js` via the `token-audit` skill. Write CLOSE §6.1–§6.6 in the phase doc. Commit the doc.
9. **Deploy: ask.** State the migration(s), the precondition query, and the rollback posture; wait for the owner's authorisation in as many words. Production has never left `commissioning`; do not assume.

## 4. The review's amendments — binding, by phase

Where a phase doc and `reports/2026-08-28-patient-self-service-review.md` disagree, **the review wins**, because it was verified against code and the docs were not. Fold each item into the doc's task text and Assertion Book before coding that task; keep the review's D/G number in the row.

**22c-A**
- D11: T2's audit gains the class *"`hasPermission(actor.id, …)` called with a non-user id"* (`patients/registration.ts:347-351` is the first specimen). Rule: a patient actor is "self" for its accessible set; no permission lookup on a patient id.
- G2: T2 rules what `Actor.id` is for `type: "patient"` — the `patient_credentials` row id (the phone identity); the subject patient is always `patientId` in the envelope. Record it in §6.3.
- T6: keep the resolver and its as-of test on a fixture; **the conversion of the two print surfaces moves to kernel-D T6** (they are converted once, to the chrome).

**kernel-D** — written after the review; no amendments. S1 (page totals) decides DD8 — do not add a PDF dependency on a plan sentence.

**22c-B**
- D7: A12 is reworded — *schema-identical response and a constant transactional write set*. Emit `patient.registration_screened { candidateCount }` on **every** self-registration; derive `duplicate_suspected` from it. Mutant: skip the screened event on the no-match path.
- G1: T1 adds `patients.phone_verified_at` (null for every existing row). T2/T6: a first app claim of a record whose phone is unverified requires UHID **and** DOB. Same for `alt_phone` and clerk-added members.
- G6: T6 rules that a revoked consent leaves the patient's own hold/cart intact and removes the proxy's visibility on the next request. Assertion + mutant.
- G10: the OTP sender uses the DLT-registered route; add a global send-rate alarm beside the per-number/device throttle.
- G16: T1 adds `privacy_notice_versions` + `patient_consents`; T8 records consent before the first read.
- S1-R2 / R-15: cap by **verified phone**, not by household.

**22c-C**
- D3: T1's Files gain `opd/schedules.ts` and `opd/appointments.ts`; the private `LIVE_APPOINTMENT_STATUSES` at `schedules.ts:111` becomes an import of the exported one; both gain `'held'`. T3/T4 assertion: *a held slot renders `booked: true` from `availableSlots`*; mutant: drop `'held'` from the schedules list.
- D4: the CHECK is `(status = 'held') = (appointment_no IS NULL)`. Assertion: a non-held row with a null number is refused; mutant: the one-directional form.
- D5: hold→booked conversion re-runs `assertNotOnLeave`, `doctor.active` and the `availableSlots` membership check inside its transaction; `scheduleLeave` releases held rows (`status='released', release_reason='doctor_leave'`) and invalidates the projection. Assertion: a hold on a leave day cannot convert.
- D6: `source` widens to `'desk' | 'phone' | 'self' | 'kiosk' | 'call'` in `opd/events.ts:34`, the controller body, and the schema comment.
- D12: S1 is answered — `classifyVisit(anchor, at)` is pure. Export `classifyVisitAt(db, patientId, departmentId, at)` from OPD (the merge-chain anchor query at `encounters.ts:66-73`); the app calls that. Keep DD5's rule-not-number fallback for the stale-between-booking-and-check-in case.
- D2: pay-later settlement at the counter is an **advance** until check-in (see 22a-1 below); T7's "paid" wording says so. T7 adds the `unpaid` marker as a column on the appointment so the desk list shows it (G7); the 4-hour sweep skips `checked_in` rows (22c-D T7 owns the test).
- G17: A8 gains the sweep-vs-conversion race statement — both are conditional UPDATEs on `status='held'` with opposite `expires_at` predicates. Expired holds are kept as `status='expired'` (A10 needs them).
- A9: the same-patient reclaim is a lookup **before** the insert; the index will refuse the insert.

**22a-1**
- **D2 (structural):** T6 becomes *intent → receipt → tender → booking*, **no allocation**. The receipt is an advance. A registered check-in hook (the `ConsultStartGuard` shape, `billing/gate.ts:10-27`) issues the consult invoice for the new encounter and allocates from the advance inside `checkInAppointment`'s transaction. A17, A18, A19 move to the hook. A revisit at check-in issues nothing and the advance stays (R-13's 90-day credit). If 22c-D has already executed and built the hook, consume it.
- **D1 (CRITICAL):** T8 — `advanceOfExcluding` subtracts `payment_refunds` in every non-failed state. Assertion: *after an automatic refund of an unallocated online receipt, `advanceOf(patient)` is 0*; mutant: subtract vouchers only, must die at `{advance: 50000, refunded: 50000}`. T4 gains the `refund.processed` / `refund.failed` webhook kinds; T8 models `payment_refunds.status`.
- D8: T1's S6 audit and T6 — the daily close reports `online` as its own column; counter recon matches `channel='counter'` only. Mutant: drop the filter.
- G4: T4 — a webhook whose amount ≠ the frozen intent amount is an exception, never a success. Mutant: trust the webhook's amount.
- D14: pick one — the success transaction runs from the webhook after the raw persist, within the gateway's timeout budget; **or** T5 runs a fast (seconds) executor for fresh intents. State it in §6.3.
- G12: T7's "counter visibility" resolves `bookedBy`/actor ids that are patient credentials without crashing the desk screens.

**22a-2**
- D1: DD1's end state — every rupee out is a voucher. Build `grantByPolicy(tx, typeKey, …)` in the approvals kernel (an already-granted row, `decided_by='policy:<type>'`, bounded by the receipt), pin why the kernel's system-actor refusal does not apply to it, and convert 22a-1's automatic refunds to vouchers on it. A voucher's `paid` waits on the gateway's `processed`.
- D9: S1 is answered — no. DD3 needs its own per-approver, per-window query over `approvals.decided_by`/`decided_at` on decided rows. Check whether `registerApprovalType` expresses amount-banded approver roles; if not, S4-R8 is three types.
- G3: T3 gains `payment_chargebacks` from the gateway's dispute webhook; the invoice's settlement shows *disputed*; the day book shows it.
- Review §2 (S4-R3): C-2 trips on whichever grain trips first — per patient-episode **or** per payer (PAN, else declared payer phone) per day. Capture the payer phone on cash receipts at or above ₹25,000 (a default). Counsel's question shrinks to "may we relax this".

**22c-D, 22c-E, 22c-F** — written after the review; execute as written. For 22c-F, **do not start** until Plan 17 exists and §2 has been re-measured.

## 5. Owner rulings you must surface before the phase that needs them

Say these in one message, at the start of the relevant phase, and proceed on the default unless overruled:

| Phase | Item | Default you proceed on |
|---|---|---|
| kernel-D | DD6 — a confidential patient's **own** copy prints the real name (reverses Plan 07's alias-on-print) | proceed |
| 22a-1 | P-1 — the Razorpay sandbox **account** (the decision is locked; the account is an owner action) | **blocked** until it exists |
| 22a-2 | O-3 — the three concession ceilings (₹500 / ₹5,000 / owner) | proceed on the defaults |
| 22a-2 | the M2 go-live gate now includes 22a-2 T2 + T3 | proceed; deploy waits |
| 22c-D | DD7 — uploads as capped `bytea` pending 11b | proceed |
| 22c-F | R-08 restated as `release_policy` per catalogue entry (statute: HIV Act 2017) | **ratify before executing** |
| 22c-F | O-1 — the PACS, with its rupee figure | **blocked** for half B |

## 6. What "done" means for each phase

CLOSE §6.1–§6.6 written; every CRITICAL row's mutant DIED with counts quoted; `pnpm verify` green with the exit value read from a file; CI green by full SHA; both reviewer passes returned and their CRITICAL/MAJOR findings remediated; `token-audit` run and the baseline row appended; tree clean; doc committed and pushed. **Then stop and report** — the phase SHA range, the reviewer's findings and what was done with them, the actuals row, the migration(s) awaiting deploy authorisation, and the next phase's gate status. Do not start the next phase in the same message.
