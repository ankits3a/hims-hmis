# Pharmacy P9 — the Schedule H1 register, read (2026-09-16)

**Lane** `formulary` worktree, branch `lane/pharmacy-h1-register`, stacked on P5–P8 (#217).

## 1. WHY

Drugs and Cosmetics Rules 1945, rule 65(3A), requires a **separate register of every Schedule H1
supply**. It records the prescriber's name and address, the patient's name, the drug and the
quantity, is kept for three years, and is produced when an inspector asks.

`handOverDispense` has written `pharmacy_reg_h1` since 16c, but nothing read it. The runbook §8
admitted: *"Until 16d it is read with `psql`, and that is the only way to answer an inspector."*

That is a statutory gap at go-live, not a 16d feature, and it is small.

## 2. DECISIONS

- **P9-1. A month at a time.**
  - `GET /pharmacy/registers/h1?from&to` takes IST dates, inclusive, at most 31 days.
  - An inspection asks for a period, and a register is reviewed and printed monthly. A bounded
    read never becomes a three-year export.
  - `invalid_range` is returned when the period is not real dates, runs backwards or is too long.
  - The shared `isIsoDate` round-trips the date, because V8 reads 2026-02-30 as 2 March. The same
    defect was in P7's day check and is fixed in the commit before this one.
- **P9-2. In the order written.** Rows are ordered by `seq`, as a paper register reads; the S. no.
  column is `seq`.
- **P9-3. Its own permission.** `pharmacy.register.read` goes to `pharmacy` alone. The register
  lists patients by name and what they were given, so it is not the aide's. The four-edit rule
  applies: manifest, `seed-roles`, the README prose and table row, and the counts.
- **P9-4. A PHI surface of its own.** `pharmacy.h1_register` is appended to the kernel union and
  nothing else changes there. Each read writes one access row per patient shown, `sealed` where
  the patient is, under the surviving id after a merge. This is the `aerb.dose_register` shape.
  An empty read discloses nobody and logs nothing.
- **P9-5. A sealed patient stays sealed — DECIDED, and the law half is the owner's.**
  - The row stores the name as it stood at hand-over. A reader without
    `patients.confidential.read` sees the alias, no address, and `restricted: true`, which the
    screen prints as "sealed record". This is the dose register's rule, and it never weakens the
    seal.
  - An inspector's unredacted copy therefore needs that grant, which no role holds today. **Giving
    it to the pharmacist in charge is the owner's ruling (law)**, and the runbook §8 says so.
- **P9-6. The printed sheet** carries:
  - the rule, and the period as DD-MM-YYYY;
  - a blank line for the drug licence number, because no configuration holds it;
  - the columns S. no., date and time (IST), patient (name and address), prescriber (name and
    registration number), drug, batch, quantity, and pharmacist registration number (P2);
  - a line for the signature of the pharmacist in charge.
- **P9-7. The runbook's refusal table is now pinned.**
  - Its heading said "all 33 codes" while `errors.ts` declared 50, and three codes had no row.
  - `runbook-parity.test.ts` fails when a declared code is missing from §4, or when the heading's
    count is wrong.
  - §8 no longer says the register is unreadable or that nothing watches expiry at the counter.

## 3. AS BUILT, AND WHAT PROVES IT

- **Code.**
  - `registers.ts` (`h1Register`), the route, and `/pharmacy/registers/h1` with the menu entry.
  - The screen `pharmacy-h1-register.tsx`, and `pharmacyH1.*` plus `pharmacyErrors.invalid_range`
    in en and hi.
  - The web route count goes 57 → 58.
  - Grant counts: declared 168, held 154, model pairs 335, model permissions 148, `pharmacy` role 23.
- **Tests.**
  - `registers.test.ts` (3):
    - two entries in order, with every field the rule asks for, and one access row for the
      patient; an empty next period logs nothing;
    - a sealed patient withheld and logged as sealed, then shown in full to a cleared reader;
    - the aide refused; four bad periods refused with no access logged.
  - The e2e check: 403 for the aide, 200 for the pharmacist, 400 without `to`.
  - Web (2): the month's span is requested, the columns and the IST date (a UTC 18:45 prints as
    the next day), the sealed marker and note; February ends on the 29th in 2028, and an empty
    month disables Print.
  - `runbook-parity.test.ts` (1).
- **Mutants: 16, each with a written prediction. All were killed, each by exactly the predicted
  number of tests.**
  - H1: no permission check.
  - H2: 32 days accepted.
  - H3: a backwards period accepted.
  - H4: lenient dates.
  - H5: clearance ignored.
  - H6: the address leaks.
  - H7: the seal not logged.
  - H8: one access row per entry instead of per patient.
  - H9: newest first.
  - H10: the window ends on `from`.
  - W1–W4: the month's end, the sealed marker, the UTC date, and Print always enabled.
  - RB1–RB2: a stale heading, and a missing row.
  - H8, H9 and H5/H6 were only killable after the mutant plan showed the first test draft could
    not see them. That draft had one entry, no address and no cleared reader.

## 4. NOT BUILT

- A CSV or PDF export. The printed sheet is what an inspector takes.
- A Schedule X register (16d, with its custody).
- The drug licence number as configuration. It needs the owner's licence details.

## 5. ADDENDUM — P17 (2026-09-17): who prints the unredacted copy

The owner: *"Admin can do it for sure, managerial position staff can do it for sure … follow top
hospitals in India."*

**DECIDED.**
- In an Indian hospital pharmacy, the pharmacist in charge named on the drug licence maintains the
  statutory registers and produces them to the drug inspector. The administrative head (the
  medical superintendent) and the licensee (the owner) answer for them too.
- A new, narrow permission, `pharmacy.register.read_sealed`, prints a sealed patient's real name
  and address on the H1 register only. It goes to:
  - a new role, `pharmacy_incharge`, held **with** `pharmacy` by the one pharmacist in charge;
  - `medical_superintendent`;
  - `owner`.
  The latter two also gain `pharmacy.register.read`.
- The hospital-wide `patients.confidential.read` still works and is still held by nobody. A
  register grant should not unseal the whole record.
- `admin` keeps only `auth.*` (seed:admin's design). The owner's `admin` login gets the copy by also
  holding `owner`, assigned at `/admin/users`.
- **Proof.** `registers.test.ts` covers a reader cleared by the register grant (real name and
  address, logged sealed) and, separately, by the hospital-wide one. seed-roles pins: 39 roles,
  declared 171, held 157, model pairs 345, the pharmacy table's third column, and
  `H1_SEALED_PAIRS` with its README sentence quoted.
