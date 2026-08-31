# Vitals Desk (Bay One) — reconnaissance before phase one

**Written 2026-08-31**, in `/opt/hmis` at `226a775`, against
[`../2026-08-31-EXECUTE-PROMPT-vitals-desk.md`](../2026-08-31-EXECUTE-PROMPT-vitals-desk.md).
Everything below was READ in this checkout today; nothing is remembered. The handoff's own
instruction is that this report exists before phase one is authored.

---

## 1. The lane situation, first, because it governs the schedule

**Three Claude sessions are live in this one checkout right now** (measured: `ps` shows several
`claude` processes; dirty-file mtimes 20:06–20:15; `.rc1-ci-t2.log` written at 20:19 against a
20:19 clock). Two of them are coding lanes:

| lane | uncommitted in this tree | overlap with this seat |
|---|---|---|
| **RC-1 T3** (registration counter rails) | `billing/{index,invoices,receipts}.ts`, `billing/{fee-status,settle-hooks}.ts` (new), `opd/{encounters,events,index,opd-visits.controller,opd.module,queue,realtime}.ts` | **direct — every OPD file this seat must edit** |
| **18a T5** (radiology core) | `radiology/*` incl. 8 mutant pairs | none |

**No worktree is taken, and that is a ruling rather than an omission.** The handoff says
"worktrees per the protocol doc"; the protocol doc
([`2026-08-26-parallel-session-protocol.md`](2026-08-26-parallel-session-protocol.md)) prescribes
no worktree — it prescribes staging by path, scoped suites and queued verifies — and
`AGENT-RULES.md` §1.3 is absolute that `/opt/hmis` and `/opt/hmis-prod` are the only writable
paths on this host, which forbids a sibling worktree directory. The mechanism the method actually
sanctions for lane isolation is **EXECUTE-METHOD-V3 §9.1 rule 8: a per-lane
`TEST_DATABASE_URL`**, which is what RC-1 is already using (`hmis_rc_scratch`).

**So this lane takes `hmis_vd_scratch`, names it in every commit that cites evidence (§2.137),
stages by path only, and orders its tasks so the contested OPD files are edited AFTER RC-1 T3
commits.** Docs-only work is collision-free and happens now.

---

## 2. Already wired — verify, then reuse, never rebuild

Each row was read in the file named.

1. **`POST /opd/visits/:id/vitals` → `recordVitals`** (`modules/opd/vitals.ts:46`). Band-aware
   required set enforced SERVER-side (`missingRequired` → 400 `vitals_incomplete` with
   `detail.missing`), danger flags from `evaluateVitals`, `vitals.recorded` +
   `vitals.danger_flagged` events, PHI-audited read on `listVitals`. Permission
   `opd.vitals.record`.
2. **The vitals→callable gate is REAL, not ruling-only.** `openVisit` inserts the queue entry at
   `status: "waiting_vitals"` (`encounters.ts:155`); `listQueue` orders only
   `rows.filter(r => r.status === "waiting")` (`queue.ts:97`); `recordVitals` flips
   `waiting_vitals → waiting` in the same transaction as the encounter move (`vitals.ts:62-67`).
   **A patient without vitals cannot be called.** flow3 T6's headline half shipped.
3. **Class 0 already exists and already fires.** `opd_queue_entries.danger` → `classOf` returns 0
   (`queue-engine.ts:11`). `recordVitals` sets it on ANY danger flag and it never auto-clears (D4).
   See §4 — this is the one place the shipped behaviour and the signed-off design disagree.
4. **The valve pill needs no new server work.** `GET /opd/queues/summary` already returns
   `waitingCount` (callable) and `waitingVitalsCount` (bench depth) per doctor
   (`queue.ts:288-290`).
5. **`usePatientInHand`** (`apps/web/src/lib/patient-in-hand.tsx`) — ids only, never a name,
   `sessionStorage`, released on sign-out. The session column consumes it; it is not a new store.
6. **PHI read logging** (`kernel/phi/audit.ts`) with an `opd.vitals` surface already declared and
   called.
7. **Realtime**: `useRealtime(queue:{doctorId}:{date})` + a 15 s poll, hint-not-correctness (D6),
   already the shipped pattern in `opd-vitals.tsx`.
8. **The amendment house pattern exists and is not ours to invent**: LIMS corrects a signed value
   by writing a NEW row that names its predecessor (`lab_results.supersedes_result_id`,
   `lab_reports.prior_version_id`, `amendment_reason_code`) — *"there is no edit endpoint and
   there must not be one"* (`schema/lab.ts:502`).
9. **RC-1 T3, in flight**, adds `feeStatus` to `QueueEntryView` and a `queue.fee_settled` topic.
   The bench consumes it; this lane does not build it.

---

## 3. Ruling-only or absent — the real build list

Every item here was searched for and is NOT in the tree.

| # | thing | evidence |
|---|---|---|
| R1 | **Carried-forward height, greyed + locked, preset unlock reasons** (flow3 T5) | the deployed screen does `form.reset(EMPTY_VITALS)` on every row select (`opd-vitals.tsx:196,206`); no carry-forward reader exists |
| R2 | **Two takes kept as a pair** | `opd_vitals` holds one scalar per vital; nothing can express 172/104 → 146/88 |
| R3 | **A reading's SOURCE** (`typed \| device \| counted`) | no column, no field, no wire type |
| R4 | **MUAC** | absent from `VITAL_KEYS`, from every band's `required`, and from the table |
| R5 | **"BP not routine under 5"** | the `child_1_5` band correctly does not *require* sbp/dbp — but a supplied child BP is still range-flagged, and no "not routine" concept exists |
| R6 | **Emergency trimmed set** (BP + pulse + SpO₂ only) | no concept anywhere |
| R7 | **Sanity gates** — slipped digit, shrinking adult, probe-error SpO₂ held OUT of the chart, RR honesty nudge | `validateVitalsRanges` has only wide plausibility bounds: `weightKg [0.3, 400]` admits **4.8 kg on a 72-year-old**, `spo2 [0, 100]` admits **45 %**, straight onto the chart |
| R8 | **The escalation state machine** — one danger reading ⇒ recheck demanded; double-confirm ⇒ bump; 10-s cancel; supervisory reversal after | none of it; see §4 |
| R9 | **Bench states** `resting(recall_at)` / `away(turn held)` | none |
| R10 | **Amend a saved vitals chart** | none for vitals (LIMS has the pattern — R8 of §2) |
| R11 | **Context chips** (BP-med-taken, fasting, just-climbed-stairs) riding the encounter | nothing |
| R12 | **Any priority / reorder route** | the queue controller has call-next, skip, transfer, status — and no way to change a class. flow3 T6's other half is also ruling-only |
| R13 | **`agent_ledger`** | `grep -rn "agent_ledger\|agentLedger" apps packages` → **zero hits**. RC-4 owns it and is three phases out |
| R14 | **Theming alias layer** | RC-3's concern, not yet written |

### R15 — a permission gap the seat's own role cannot cross

`vitals_desk` holds exactly `opd.visits.read`, `opd.vitals.record`, `opd.queue.read`,
`patients.read`, `patients.update` (`scripts/seed-roles.ts:142`). The cross-visit reader
`GET /opd/patients/:patientId/vitals` is gated on **`opd.consult`**
(`opd-visits.controller.ts:334`).

**So the seat's headline behaviours — "pre-staged with last vitals, band and expected flags" and
the carried-forward height of R1 — are unreachable by the role that works the bay.** This is not
a screen problem; it is a missing narrow permission, and it must be part of phase one.

---

## 4. The one real contradiction between the design and the shipped code

**Shipped:** a single out-of-band reading ⇒ `danger = true` ⇒ class 0, immediately, no recheck,
no cancel, never cleared.

**Signed off:** one danger reading only *demands the other arm now*; only a **double-confirmed**
danger reading bumps the class, and a **10-second CANCEL** at the desk restores the original
queuing.

They collide at the save: if `recordVitals` keeps setting `danger = true` from the flags, then a
cancelled bump is re-applied the moment the nurse saves, and cancel is theatre. If it stops, a
patient-safety flag has been weakened.

**The resolution the phase document will carry (DECIDED — the owner ruled the behaviour on
31-Aug; this is only its mechanism): split the clinical fact from the queue priority.**
`opd_encounters.danger_flagged` and the `vitals.danger_flagged` event keep firing on every danger
reading, exactly as shipped — the doctor's record is unchanged and complete. What the cancel
reverts is `opd_queue_entries.danger`, the *board* fact, and only when a named human cancelled
inside the window; that cancellation is itself an event with an actor and a clock. The autonomy
ladder in the signed-off schema says it in as many words: *"ASKS (never alone): anything that
downgrades urgency."* The agent bumps; only a person un-bumps, with their name on it.

---

## 5. Two more decisions taken here rather than left open

- **`opd-vitals.tsx` is REPLACED, not extended.** Its atom is a form field; this seat's atom is a
  reading with a source, a band, a history and sometimes a second take, and the signed-off design
  names that divergence as load-bearing. Two vitals screens on one hospital is the drift this
  project spends its ledger fighting. The new seat mounts at `/opd/vitals` and the old file is
  deleted in the task that lands the replacement — not before it is green.
- **No `agent_ledger` is built in this lane.** Every act it would hold — unlock, gate override,
  auto-bump, cancel, amendment — is a domain fact, and this codebase's audit spine is the
  append-only event log that `recordVitals` already writes to. This lane emits proper events;
  RC-4 projects them into the footer bar it owns. Building a second store here would duplicate the
  shared primitive the handoff explicitly forbids duplicating.

---

## 6. What genuinely stops for the owner

**Procurement only, and it does not block a line of code.** The serial devices are ordered
(₹70,960/bay serial vs ₹16,110 manual, per the prototype's own ledger); model/vendor confirmation
and the driver integration scope stop for the owner when real hardware arrives. This lane builds
**the seam and the toggle, shipped OFF** — never a driver.

---

## 7. The phase cut

Cut at the seam the CONTRACT freezes, so the halves are independently reviewable
(EXECUTE-METHOD-V3 §2.141), and following the sibling lane's proven shape (RC-1 rails → RC-3
seat):

- **VD-1 · The reading and the bench (server rails).** The reading model (takes, source, MUAC,
  supersede-not-edit), the extended band rules (child BP not-routine, emergency trimmed set), the
  server-enforced sanity gates, the bench states with `recall_at`, the pre-stage/carry-forward
  reader plus its narrow permission (R15), the escalation state machine with the 10-second
  compensating cancel, and the events RC-4 will project.
- **VD-2 · Bay One (the seat).** Three doors into one lane, the tile grid, the typing lane (⏎
  commits and jumps, 1–8 address fields, keystroke counter), client-immediate gates over the
  server-enforced ones, the always-on bench rail with the live recall, the bold-✓ confirmation,
  the cancel countdown, amend-from-a-✓-row, the session column.
- **VD-3 · The serial seam.** The lane toggle as config, the device-driver interface stub,
  keystrokes-vs-device-reads telemetry, and the procurement stop. Small; folds into VD-2 if VD-2
  comes in light.

A–E from the handoff maps onto this without loss: A and B split across VD-1's model and VD-2's
seat, C is VD-1's state machine plus VD-2's countdown, D rides both, E is VD-3.
