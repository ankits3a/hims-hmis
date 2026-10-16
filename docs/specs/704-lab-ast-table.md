---
issue: 704
status: built
approved: 2026-10-12
---
# SPEC — Antibiotic sensitivity table on culture reports (owner 2026-10-12: "yes, build the antibiotic sensitivity table")

Status: APPROVED 2026-10-12 (owner: "yes, build the antibiotic sensitivity table").

## What
1. Every culture test (CS_URINE, CS_BLOOD, CS_PUS, … — the 13 C&S tests) gets an **antibiotic table** on the
   Quick Bench (web and phone): one row per antibiotic, result **S / I / R** (sensitive, intermediate, resistant),
   and an optional MIC value (µg/mL). Rows left blank are not printed.
2. The technician picks a **panel** once and its antibiotics fill the table. There are 5 standard panels (CLSI 2025
   groups, as Indian labs use them): Enterobacterales – urine; Enterobacterales – other; Pseudomonas /
   Acinetobacter; Staphylococcus / Enterococcus; Streptococcus. Antibiotics can be added or removed per report. Urine-only
   drugs (nitrofurantoin, fosfomycin) appear only for urine.
3. "No growth" / "Sterile" needs no table. The colony count and resistance type (ESBL / MRSA / CRE / VRE) fields stay.
4. The **printed report** and the on-screen preview show the table: Antibiotic | Result | MIC, with R in bold.
   The old free-text "sensitivity summary" box stays for a remark.
5. Stored with the quick report (new column, one additive migration). It is shown in the profile's lab visit and
   in Quick Reports.

Out of scope now: Full lab mode's verify screen (follows later as an issue), WHONET export, and the antibiogram
statistics (hospital resistance trends).

## Done means
- On a urine culture, picking "Enterobacterales – urine" lists its antibiotics. Marking 3 as S and 2 as R,
  then Save & Complete, prints a table with exactly those 5 rows, the R rows in bold.
- The same report entered on the phone prints the same.
- A culture with "No growth" prints no table.
- The server refuses a result other than S, I or R, and a MIC that is not a number.
- Tests are green, staging first, then the owner's OK for production.
