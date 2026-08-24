# Prompt — brainstorm and rule the next phase after Plan 11e (NO EXECUTION)

> **For a fresh session.** Written 2026-08-24 by the session that executed, closed and deployed
> Plan 11e. Your job is to **decide what is next and rule it** — then, if the answer is a plan,
> write that plan's phase document. **You do not execute anything.** A different session does, and
> that separation has now paid five times.
>
> Under EXECUTE-METHOD-V3 the brainstorm's outcome becomes the phase document's §1 "Why this
> phase". So what you produce is either a phase document, or a ruling that says why the next thing
> is not a phase at all.

---

## Read these first, in this order

| # | file | why |
|---|---|---|
| 1 | `docs/superpowers/plans/2026-08-23-phase1-11e-user-administration.md` — **especially THE CLOSE section** | the state you are building on. Under v3 the CLOSE **is** the gate report: eight findings, the reviewer's verdict, the actuals, and four open items |
| 2 | `docs/superpowers/EXECUTE-METHOD-V3.md` §2 and §7 | the lane ruling you must make, and the pilot measurements 11e left partly undischarged |
| 3 | `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` §2.87–§2.91 and §5 | five entries 11e bought. **2.88 in particular is about your job**: a check that compares two hand-maintained lists to each other is blind to what is in neither |
| 4 | `docs/superpowers/plans/2026-08-11-phase1-plan-series.md` | the roadmap. Plan 09's slot is RULED — read the ruling's DATE before trusting it |
| 5 | `docs/superpowers/AGENT-RULES.md` | the contract |
| 6 | the owner's out-of-git `hmis-context/plan-09-channel-partners-2026-08-23.md` | **only if you rule Plan 09 next.** It is not on this host; ask the owner for it |

## Where things stand — MEASURED 2026-08-24, not recalled

**The software.** `pnpm verify` exit 0 at `f8885be`: `apps/core` **152 suites / 1167 tests** ·
`apps/web` **36 files / 190 tests** · `packages/contracts` **3 / 7**. Next migration is **`0019`**
(latest applied: `0018_bright_hairball`). Twelve API prefixes are proxied, and a parity leg now
reads a third source derived from what the SPA actually calls.

**Production.** `hmis-prod` LIVE on `https://hmis.crkmch.com`, 9 services, `/health` 200 over
HTTPS, WAL archiving to R2, nightly full + weekly restore drill. Migrations **19**. **16 users, all
active** · **2 patients** · **3 encounters** · **0 live sessions**.

**And this is the number that should stop you: `operating_mode_changes` is EMPTY.** The hospital
has never left `commissioning`. Two patients and three encounters are a smoke test, not an
operation. **The software is deployed. The hospital is not running on it.**

**Three things are true about credentials right now.** The pilot roster of 15 accounts was burned
into a session transcript on 2026-08-23 and **has not been rotated** — D5 is owner-only work and
is still outstanding. **Production has exactly ONE holder of the full `auth.*` set (`admin`)**, and
11e's takeover ruling means nobody may reset that account: today the top credential's only repair
is direct database access. And `seed:admin` applies no password policy to `ADMIN_PASSWORD` — a
stated seam that wants a ruling.

## The actual question, and it is genuinely open

**The roadmap says Plan 09 (memberships, coupons, channel partners) runs NEXT. That ruling was
made on 2026-08-23 — before 11e ran, and before 11e's reviewer found that Plan 11c's downtime-kit
surface had been unreachable in production for an entire plan cycle under a green test.**

So argue this, do not assume it:

> **Does the next phase build new revenue features on a hospital that is not yet operating — or
> does it close the gap between "shipped" and "actually in use"?**

The case for **Plan 09 next**: it is ruled, it is the first *business* consumer of the dispatcher,
the channel-partner reshape is fresh in the owner's mind, and features do not build themselves
while operations are sorted out.

The case for **a go-live / operability phase next**: the hospital is in `commissioning` with a
burned roster, one irreplaceable admin account, and a go-live gate (D-17's config validation) that
has never been satisfied in production. 11e found a whole plan's surface dark in production —
which is *evidence about the size of the gap between shipped and working*, not an anecdote. Adding
Plan 09's surface area to an unexercised system makes the next such gap bigger and later to find.

**A third possibility you should price rather than dismiss:** the next phase is small and
verification-shaped — rotate, prove the go-live gate, drive one real day through the system, and
close the four open items 11e left — and Plan 09 follows it immediately. That may be a *runbook and
an afternoon* rather than a plan, and ruling "this is not a phase" is a legitimate outcome.

## What you must rule, explicitly

1. **What is next, and why** — one recorded sentence, with the losing option named and marked dead
   in place (§2.48: a refuted alternative left unmarked reads as an option to the next reader).
2. **The lane** (v3 §2), in one sentence, with the reasoning. 11e was LIGHT and held.
3. **The stop-loss** (v3 §6), from the last comparable phase's actuals — and note that **11e could
   not measure its own token total**, so if you want a number for the comparison you must ask the
   owner for it (`/cost`). Do not invent one, and do not let the comparison quietly lapse: §7's
   cost claim for the v3 pilot is currently UNDISCHARGED in both directions.
4. **`seed:admin`'s password floor** — 11e left it stated and open on purpose.
5. **Whether the two-full-admins requirement gets enforced in code or stays operational.** 11e
   ruled the takeover rule and named the cost; nothing enforces the mitigation.

## What you must NOT do

- **No execution.** No code, no migrations, no deploys, no `seed:*` runs. If you find yourself
  wanting to "just check" something in production, a read-only SELECT is fine and a write is not.
- **Do not perform D5's rotation**, and do not design a way for an agent to perform it. It is
  owner-only *by construction* — an agent doing it puts 15 credentials into a transcript, which is
  the exact state Plan 11e was built to end. Authorisation does not change that; it removes the
  permission question, not the reason.
- **Do not re-litigate what 11e ruled**: the password policy (10 chars, no composition), the
  takeover rule (`auth.*` superset), the lockout invariant's hospital scope, or D5's owner-only
  status. If you think one is wrong, say so as a finding with evidence — do not quietly redesign it.

## Two loose threads worth ten minutes each

- **Two of 11e's commits went RED in CI** (`3eec860`, `c760586`) and the cause was never
  identified — job logs need an authenticated `gh`. `gh run view 32668118868 --log-failed` settles
  it. The leading unconfirmed candidate is `test/auth.e2e.test.ts:77`, the suite's only
  single-sample wall-clock assertion. If it is a flake, it will bite again.
- **The build host CAN read public CI over plain `curl`** (ledger 2.91) even though `gh` cannot
  authenticate there. `ci-watch.sh` is still ruled off-host on the strength of the `gh` finding.
  A ~15-line poller would make "CI is watched, not assumed" true for build-host sessions.

## Deliverable

Either a **phase document** (v3 §1: why · spike questions written BEFORE the answers · design
decisions · tasks with inline Assertion Book rows for CRITICAL ones · an empty CLOSE), or a
**ruling document** saying what happens instead and why it is not a phase. Both end with the
losing option marked dead in place.

Update the roadmap entry for whatever you rule, in the same session. 11e's own entry sat stale as
"BOOKED, NOT WRITTEN" until its executing session fixed it — that is the §2.78 class this project
keeps re-earning.
