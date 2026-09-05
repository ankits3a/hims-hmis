# FD-25 — the backlog session: what was taken, what the review found inside the fixes, and what is still owed

**Written** 2026-09-05, at the end of the session that executed
`2026-09-05-HANDOFF-front-desk-FD25-next.md`.
**Branch** `lane/front-desk-fd25` · **PR #92** · nothing here is deployed.

This closes the handoff's three steps: merge `origin/main` in, work the §3 backlog in order, and do
not mark #92 ready without the owner. The third one changed — the owner answered.

---

## 1 · The five owner rulings taken today

Asked directly, in session. Three were the handoff's own open questions; two came out of the work.

| # | Question | Ruling |
|---|---|---|
| 1 | May the lane mark #92 ready? | **Ready ONCE THE BACKLOG IS FIXED.** Not ready-now, not draft-indefinitely. |
| 2 | Does a lab-only walk-in carry an OPD consult fee? | first: *"only if a doctor is involved"* → **reversed after measurement** (see §5) → **a diagnostic-only visit carries NO consult fee, EVER, and is never re-charged.** A later doctor visit is a NEW visit with its own fee. |
| 3 | Whose name is on a §14 reprint? | **The alias.** The legal name only when the operator holds `patients.confidential.read` **or has an active break-glass grant for that patient** — already logged. |
| 4 | The billing model behind #2 | *"Consultation fee is collected separately and diagnostic fee is collected and billed separately."* |
| 5 | The panel/TPA wording change | answered with the model rather than the wording. **The behaviour fix ships; the exact sentence is NOT confirmed** and a front-desk briefing is owed before it reaches a live counter. |

Ruling 3 is implemented and in this branch. **Ruling 2 is NOT implemented** — §5 has its scoping.

---

## 2 · The merge — the census, measured one failure at a time

`origin/main` had moved 7 commits. **One conflicting file, not the three the handoff predicted:**
`README.md` and `seed-roles.ts` auto-merged; only `test/seed-roles.test.ts` needed hands.

Resolved by taking **main's numbers** and keeping **both sides' prose**, then measured:

| site | value | how |
|---|---|---|
| `modelPairs()` | **307** | read off `Received length: 307` |
| granted-length array | **index 7, 11 → 13** | and nothing else moved |
| already-length array | the same index, its twin | |
| caddyfile SPA routes | **50** | re-measured green, not assumed |
| `seed-staff.test.ts` | green | these grants add no role key |

Index 7 was confirmed to be `cashier` **by reading `ROLE_MODEL`'s key order**, not by counting along
the row — that array's own comment records that somebody has already moved the wrong `2` in it. The
array is 37 entries on both sides; 17-E T3 moved index 35 (`lab_bridge` 1 → 2) and main's value for
it was taken wholesale.

`305 + 2 = 307` is the same number and **that is not why it is written here.**

---

## 3 · The eight backlog findings

All eight were investigated first, and each investigation was checked by an independent agent
briefed to refute it. **Seven of the eight survived refutation; the eighth's checker died with an API
error and was therefore treated as an unverified hypothesis and re-derived by its implementer.**

| # | Finding | Outcome |
|---|---|---|
| 1 | `appointment.test.tsx` asserts no request body in any of its 16 tests | **The reviewer's headline was wrong and the situation was worse.** All four named call sites were CORRECT — but the missing assertions were hiding TWO REAL defects: a booking that took the patient from app-wide `sessionStorage` while the rail read "Nobody picked yet", and a held slot that survived a change of doctor AND day. |
| 2 | The tender lane seeds an amount the cashier cannot see, then posts it | Fixed. The seeded amount never reached the field's `value`. |
| 3 | `/billing` derives UNPAID from `intendedPayer` | Fixed. A payer is not a payment; a failed preview is not zero. |
| 4 | The relay's `jobs/` spool is write-only | Fixed — replay implemented, with idempotence. |
| 5 | A `JSON.parse` outside the `try` in `relay.mjs` | Fixed. |
| 6 | `/billing` draws keycaps `1 2 3` and binds nothing | Bound. |
| 7 | The plural guard is keyed on `{{count}}`; the offenders use `(s)` | Fixed. **The census could not see the instance that prompted it** — see below. |
| 8 | `TabStrip`'s arrow keys change selection without moving focus | Fixed; the component got its first test file. |

---

## 4 · Then an independent review read the fixes, and found 27 defects inside them

Five lenses (money, §14 privacy, guard-integrity, UI correctness, relay+CI), each finding
adversarially verified. **One CRITICAL, eleven MAJOR.** Nearly all of them were in code written
earlier the same day, over a tree whose full suites were green.

The three that matter most, because each is a *shape* rather than an incident:

**1 · THE FIX CLOSED THE INSTANCE, NOT THE RULE.** `/billing`'s morning fix established "the counter
cannot issue against a price it has not got" and implemented it as `payablePaise === null`. But
TanStack Query deliberately KEEPS `data` when a *background* fetch fails. So `isError && data` is a
first-class state, and in it the red alert reading *"Do not tell the patient anything is due — or not
due — until it loads"* rendered directly above a **live submit button** over a stale figure, with all
three tender lanes armed at it. The morning's test mocked a 503 on the FIRST fetch — the branch that
was not broken.

**2 · THE FIX MOVED THE WEDGE, AND THE WEDGE STARTED MOVING PAPER.** The spool-replay fix left its
marker writes unguarded. A spool that cannot write a marker throws out of `replaySpool`, out of
`tick` *before* the claim, into `main`'s retry loop — which replays the same job three seconds later,
for ever. Reproduced: with the marker directories unwritable, replay rejected *after* `lp` had
accepted the job, and the next pass printed the same slip again. A pre-existing silent stall had been
converted into a runaway printer.

**3 · A GUARD WITHOUT AN ESCAPE, AND A SCREEN THAT CONTRADICTED ITSELF.** `/appointment`'s new
"booking-for" card became the sole decider of who gets booked, and nothing on the screen could clear
it. And the rule moved the button, its label and the caption onto `held` while the board went on
painting raw `picked` — so a slot taken by another clerk stayed highlighted as yours while the button
refused it, silently. **A refusal a user cannot explain is the defect, not the refusal.**

All confirmed findings were remediated, each fixed at its definition rather than at its consumers.

### One finding was REFUTED, and how is the point

The claim that the actor TYPE is manufactured so the §14 guard cannot fire rested on a comment in
`display-name.ts` asserting `break_glass_grants.user_id` is *"plain text with no foreign key"*. The
review read that comment, built a MINOR on it, and the fix was written from the review — **then the
database refused the fixture, because the foreign key exists.** That is the citation loop exactly: a
claim gaining false independence by being echoed back through a second voice. Corroboration needs a
second OBSERVATION, not a second VOICE. The false sentence is corrected in all three files that had
come to agree on it.

### And one CI comment of ours asserted the opposite of the truth

The new relay test was wired into `static` with a comment claiming `ubuntu-latest` has no chromium,
letting the test decide for itself whether to skip. **It does have one** —
`actions/runner-images` symlinks it in `install-google-chrome.sh`. So a headless browser with a
hard-coded 900 ms layout settle would have been running inside a **required check**, one runner-image
bump from reddening `main` for all eight lanes. `RELAY_CHROMIUM` is now pinned at a path that cannot
exist, so the skip is FORCED. **An assumption that happens to hold is not a control.**

---

## 5 · Ruling 2 is NOT implemented, and the reason is worth reading

The investigation was asked to measure, not to assume, and it came back **B-contradicts**: a lab-only
walk-in raises the full `opdConsult.new` obligation *every time*. A lab walk-in is a `V` visit by
design; `classifyVisit(null)` makes it `"new"`; `feeServiceFor` switches on `visitType` alone. The
patient lands on the cashier's collection worklist and the daily close reports every lab walk-in as
an uncharged visit. FD-25 had changed only the PAPER — the slip stops asserting an answer — and said
so in its own commit message. The ledger underneath was untouched.

**Then the measurement changed the ruling.** The first wording — *"only if a doctor is involved"* —
has two contradictory readings, and the literal one backfires: **the pathologist signs every lab
report**, so *"a doctor reviews or signs off"* fires for every lab walk-in and re-charges exactly the
patients the exemption exists for. Re-asked; the owner ruled the visit is exempt and is never
re-charged. *A measurement changing a ruling is the right reason to change one, and the record should
show that is what happened rather than presenting the final wording as if it were the first.*

**The implementable shape**, for whoever takes it:
- one additive column, `opd_encounters.attendance_kind` (default `'consult'`), beside `visit_type`;
- written at `openLabWalkinInTx`; every other opener keeps the default;
- the decision at **`feeServiceFor`** (`billing/charge-rules.ts`) returning null — the same free
  branch a revisit already takes, which every downstream reader handles;
- **and sweep the duplicated copy at `refunds.ts:225`.** One definition, not two.

**Do NOT key it on the LAB department code.** That misses radiology, ECG and every other
diagnostic-only attendance — and it misses the `/registration` road into the identical defect, which
needs no lab module at all, only a Laboratory department row with an active doctor. **Do NOT patch
the consumption points** (`worklist.ts`, `daily-close.ts`, `fee-status.ts`): that closes one instance
of three and makes the projection disagree with `feeGate`, which is a defect this module has already
had once and recorded.

It is not in this branch because it is a schema migration plus a change to a hub module, and folding
that into a 44-commit body about to be marked ready would be trading a bounded risk for an unbounded
one. It wants its own PR.

**One thing to know before cutting that migration**, measured by two peer lanes the same evening and
worth more than the numbering rule in CLAUDE.md: **drizzle decides on `created_at` alone.** It writes
a `hash` per applied migration and never reads it, so the serial number in the filename decides
nothing.

**A REGENERATED MIGRATION IS A NEW MIGRATION**, not the same one renumbered — it is a different
migration that happens to run the same SQL, and BOTH directions fail silently:

| the regenerated `when` is… | what happens |
|---|---|
| EARLIER than the database's watermark | silently **SKIPPED** — the table is never created |
| LATER than the watermark | silently **RE-RUN** — `relation "…" already exists` |

The radiology lane hit the second one and lost **20 suites in `beforeAll`, 257 tests**, from a
migration that was perfectly correct. The failure looks exactly like broken SQL and the instinct is
to debug the SQL. It is not the SQL.

Two consequences for this lane specifically:
- **Never regenerate a migration that has already merged.** FD-24's `0069` is on main, so
  regenerating it would create a second migration that re-runs wherever the first was applied.
- CI is safe (a fresh database every run); **the lane test databases are not.** After any
  regeneration, drop `hmis_lane_front-desk_test_1` and `_2` rather than debug the red —
  `ensureWorkerDatabaseExists` recreates them, one per jest worker.

---

## 6 · What is still owed

**All eight backlog items are closed.** Item 7 is worth one paragraph because of what it taught: the
guard required `{{count}}` to be present *before* looking for a hand-spelled plural — the
post-condition of the fix used as the pre-condition of the hunt — so it detected zero of the twelve
strings it existed to catch. And the count was **fourteen, not twelve**: two offenders were hardcoded
in `.tsx` template literals, invisible to any locale-scoped census, **and one of those two was the
exact string whose screenshot motivated the guard in the first place.** A census that cannot see the
instance that prompted it is the same shape as a negative control drawn with the instrument that
cannot see the positive. Two latent Hindi agreement bugs fell out that no version of the guard could
ever have caught, because they are not parentheticals.

Carried forward from the fix reports, each recorded rather than quietly dropped:

- **`billing-dues.tsx:338`** has the same null-as-zero shape just removed from the counter:
  `payablePaise={allocatePaise ?? 0}` prints "Payable: ₹0.00" beside a green "Exact" pill before the
  cashier has allocated anything. Now a **one-token fix**, because the prop accepts null.
- **The relay's geometry check fails 2 runs in 20 on a loaded box** — measured at the same rate on
  `HEAD:relay.mjs` as on this tree, so today's work neither caused it nor affects it. A FIXED 900 ms
  sleep before measuring the laid-out document; under load the measurement returns the viewport
  height. It is the same path that renders real slips, so **a loaded hospital PC can print a token as
  a ~297 mm page** — about twelve inches of thermal roll per token. A wall-clock budget where
  `Page.loadEventFired` is available. It deserves its own red-first evidence, not a bundle.
- **The `/counter` → `/appointment` handover** still makes a clerk re-pick. The repair carries a real
  question: the patient strip deliberately aliases a confidential patient *even for a permission
  holder*, because it is furniture on every screen — a booking card is not furniture. Somebody has to
  rule which.
- **`Segmented`** (same file as `TabStrip`) publishes `role="radiogroup"`/`role="radio"` with no
  roving tabindex and no arrow keys at all — a worse instance of item 8, live on `/registration`.
  Two more hand-rolled tablists with the same gap in `opd-appointments.tsx` and
  `radiation-safety.tsx`.
- **The shell's F8 keycap** is drawn on every route where it does nothing and hidden on the only
  route where it works — the same class as item 6 and louder.
- **`desk-one/stages.tsx`** has item 1's `setPicked(null)` omission in three handlers.
- **`EncounterFeeStatus` is not on the fee-quote contract**, so a second visit to `/billing` for an
  already-settled encounter still stamps UNPAID rather than PAID.
- **The lane press still overwrites a typed amount** — now *visibly*, which is what removed the money
  hole; fixing the overwrite itself changes documented re-seed semantics and is a product call.
- **One leg of the billing null guard renders "—" for two different causes** and no test tells them
  apart. Said rather than papered over.

---

## 7 · Evidence

Every number below was measured on this tree, under the box-wide test lock, with no peer runner.

```
merge tree      core  391 suites / 4021 tests   exit 0   (705 s)
                web   103 files  /  827 tests   exit 0
after backlog   core  391 suites / 4041 tests   exit 0
                web   104 files  /  855 tests   exit 0
after review    core  391 suites / 4047 tests   exit 0
  remediation   web   104 files  /  874 tests   exit 0
                relay  23 checks /   23 pass    exit 0   (20 pass / 3 skip browserless, as CI runs it)

FINAL, after item 7, with every exit code captured explicitly rather than inferred:
                TYPECHECK_EXIT=0   LINT_EXIT=0
                CORE_EXIT=0        391 suites / 4047 tests
                WEB_EXIT=0         104 files  /  878 tests
                RELAY_EXIT=0        23 checks /   23 pass
```

**Those exit codes are captured with a redirect, not a pipe, and that is deliberate.** A peer lane
measured the trap the same evening: `$?` after a pipeline is the LAST command's status, so
`pnpm test | tee run.log; echo $?` reports `tee`'s success no matter what the suite did, and
`set -o pipefail` inside a script you CALL does not help — pipefail belongs to the shell that BUILDS
the pipeline. An earlier check in this very session read `pnpm typecheck 2>&1 | tail -8`. The
conclusion held only because tsc's evidence is its OUTPUT; the mechanism was wrong and would have
hidden a non-zero exit with an empty log. **Nobody investigates a green.**

`dmesg -T | grep -i oom-kill` was clean across all runs — checked because a peer lane warned that
the box was tight and the kernel had already killed two of its processes. **Step 0 of the flake
procedure is "was anything OOM-killed?", and it comes before reading any failure text.**

The final merge of `origin/main` (`91ed5d1`, pharmacy handoff) is **documentation only** — one
markdown file, no code — so the suite numbers above stand unchanged over it. CI is the gate.

## 8 · The method note worth carrying

Every defect in §4 was found by *looking* — an independent reader, a revert pair, a mutant — and
every one of them was green in CI at the time. **Green is the state these bugs live in.**

The revert-pair discipline earned its keep again and in a new way: three separate agents reported a
revert that came up GREEN and re-aimed their own test rather than claiming the fix was held. One
reported a fix (`key={row.key}`) that **nothing holds at all**, measured it, kept it for clarity, and
refused to count it as a fix. That is the standard: a change no test holds is an edit, and saying so
is worth more than the change.
