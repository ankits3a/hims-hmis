# 0005 — DDInter is an internal benchmark only; no dataset is bought

- **Date:** 2026-09-17   **Status:** Ruled
- **Area:** formulary, cds (drug interactions), pharmacy, legal

## Decision

- DDInter is licensed CC BY-NC-SA 4.0 ("personal, non-commercial, informational or scholarly use"). It is an
  internal benchmark and gap specification ONLY. Clinicians see only vetted rules.
- Never import DDInter into the `formulary` interaction tables or show it in the UI without a new owner ruling.
- If leadership ever rules it live: Major = hard stop, Moderate = notice, Minor and Unknown hidden, with the
  attribution "DDInter 2.0 (Academic Research Release)".
- **Later the same day the owner ruled they will NOT buy a dataset**: "I asked Gemini to save money as I don't want to
  buy a dataset … if we need to take an idea from the gemini work then this is it". This replaced the morning's
  plan to send an RFQ for a licensed feed (CIMS/MIMS India, FDB, Lexicomp) in parallel; the RFQ PR (#233) was closed.
- The interaction book grows by curated, checked rules adopted under the owner's resolution. The owner's 18-rule
  "clinical matrix" was adopted this way as P21b (#234: +230 pairs after checking; book 387 pairs).
- Do not propose buying a dataset again unless the owner raises it.
- The owner confirmed that the `admin` login is the owner's own (used for `--as admin` adoption records).

## Why

The licence is non-commercial; the owner does not want to pay for a dataset.

## Consequences / how to apply

- Parse the raw DDInter CSVs directly (a proper CSV parser) rather than trusting the owner's derived SQLite. That
  conversion had three defects: a naive `split(',')` corrupted 1,159 rows at the 8 drug names that contain commas;
  Unknown was defaulted to AMBER; `clinical_action` held only 2 template sentences, so per-pair advice was not in
  the data.
- Dataset shape for reference: 236,834 unique pairs over 1,972 drugs; Major 39,482 / Moderate 145,129 /
  Minor 9,808 / Unknown 42,415; no pair has two levels.

## Open

- The matrix's "one-tap switch" (a structured alternative offered on an alert) is a good UI idea, not yet built.
