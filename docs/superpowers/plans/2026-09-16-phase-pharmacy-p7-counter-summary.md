# Pharmacy P7 — the counter's day, in one read (2026-09-16)

**Lane** `formulary` worktree, branch `lane/pharmacy-summary`, stacked on P6.

## 1. WHY

Doc 16 §8 lists the counter's KPIs, and §14's 16f promises "KPIs, digest … after 30 days of live
data". The baselines need the 30 days; **the day's own figures do not**. A pharmacist in charge
wants them from the first morning: what went out, how long patients waited, what is stuck, what was
declined and why, and what money came back.

## 2. DECISIONS

- **P7-1. One IST day.** `counterSummary(db, "YYYY-MM-DD")`, and
  `GET /pharmacy/summary?day=…` (today when absent; `pharmacy.dispense.read`). Anything but a
  date is refused with `invalid_day`.
- **P7-2. The figures.**
  - Handed over.
  - Median minutes, queue → hand-over and claim → hand-over.
  - The billed net.
  - What is open **now**, by status.
  - Declined lines, with the five commonest reasons.
  - Substitutions.
  - Cancellations, and how many came after the bill (P5's refunds).
  - Returns (P6).
  - Partly-checked lines (P3).
  - Schedule H1 hand-overs (the register's rows).
- **P7-3. The counter's events now carry the counter's clock.**
  - Every pharmacy `…make({…})` passes `occurredAt: now`, the instant the act was given. They
    used to default to the wall clock, so a downtime back-entry, or any test, landed on the wrong
    day.
  - This is the ledger's `occurred_at` convention (Plan 14), applied to the counter's own events.
  - Events are windowed on `occurred_at`, with `recorded_at >= start` to bound the partition
    scan: an event is never recorded before it occurred.
- **P7-4. A glance, not a gate.** The counter screen shows one line under its title and refreshes
  once a minute. A failed read shows nothing.

## 3. AS BUILT, AND WHAT PROVES IT

- `summary.ts`, the route, `CounterDayStrip`, and `pharmacyDay.*` in both locales.
- **Tests.**
  - `summary.test.ts` (2):
    - a handed-over dispense with a declined line, and a second left at the claim: the counts, the
      top reason, the open backlog, the billed net, and two different medians (20 and 10 minutes);
    - another day reads as zero;
    - the refusal of a non-date.
  - HTTP gates (clerk 403, aide 200, non-date 400).
  - Two web tests: the line, and nothing on a failed read.

- **Mutants, each with a written prediction.** All five were killed.
  - S1: one event back on the wall clock.
  - S2: the medians swapped.
  - S3: the window left unbounded.
  - S4: the backlog counting every status.
    - It **survived first**, because `toMatchObject` ignores an extra `handed_over` key.
    - `open` is now pinned with `toEqual`, and S4 is killed.
  - S5: the strip rendering zeros on a failed read.
    - Predicted to fail one test; it failed two. `findByTestId` settles on the zero strip before
      the data arrives.
- **The clock change's own fallout.** `pharmacists.test.ts` took "the latest" event by
  `occurred_at`, which was the wall clock. It now finds the event by its `registrationId`, and
  pins `occurredAt` to the act's time.

## 4. NOT BUILT

- 30-day baselines and trends, a date picker, and the owner's daily digest. The digest is 16f's
  proper scope, and it needs the data first.
- The value of refunds and returns. The events carry the credit-note ids, and the value is billing's
  to report.
