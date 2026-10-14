---
issue: 584
status: built
approved: 2026-10-11
---
# SPEC — copilot name-aware masking (plan E0.6) — 2026-10-11 — DRAFT, awaiting owner yes

Lane `copilot-names` (branch lane/copilot-names from main 6baec16b). Plan: docs/superpowers/plans/2026-10-10-copilot-PLAN.md §3 E0.6, §7.
Problem: `maskQuestion` masks UHID/visit/phone/5+-digit shapes and the web screen's `terms`; a name has no shape, the phone
sends no `terms`, so "[a patient name] ka bill" would reach the chooser model unmasked. Until this ships the phone stays phrasebook-only.

What gets built (every line DECIDED; none is money, procurement or law):
1. **Name source, server-side, loaded once per ask (no cross-request cache, so a patient registered 10 s ago is covered).**
   New `kernel/copilot/names.ts` reads, for the IST day: patients with an OPD encounter on today or yesterday (night spill),
   an appointment today not cancelled/rescheduled, or registered today. HOSPITAL-WIDE, not filtered by the asker's
   visibility: over-masking costs a little routing, under-masking costs a patient, and a confidential patient's REAL
   name must be masked even for a user who only sees the alias. Per patient: `name`, `alias`, `father_husband_name`
   (J1: kin is an identifier). IPD admissions join this list when IPD ships (no admissions table today).
2. **Cost:** one query, ~3–4k rows on a busy day. One additive migration (numbered at merge): btree indexes on
   `opd_encounters(service_date)`, `opd_appointments(service_date)`, `patients(created_at)` — none exist today
   (Postgres 16, no skip-scan). Hard timeout 300 ms. Cap 20,000 names.
3. **Matching:** question and names folded by the existing `kernel/search/normalize.ts` `normalizeForSearch`
   (Devanagari→Latin, NFKD, lowercase — J2), then vowel doubles collapsed (aa→a, ee→i, oo→u) so a name in its short-vowel, long-vowel and Devanagari spellings meets ([a patient name]).
   Tokens split on non-letters; a trailing "ji"/"जी" is the name. Match = full name (any length) or a name part of
   ≥3 letters, whole-word only (no "aaram"→"Ram"). Initials and 1–2-letter parts never match. A part that is a
   phrasebook cue word or a fixed Hinglish function word (ko, ka, kal, aaj …) is not masked alone; inside a full name it is.
4. **Near-match** (folded token ≥5 letters within one edit of a name part, not an exact hit, not a stopword): the
   token is masked too AND that ask runs phrasebook-only (no chooser, no model). Logged as a count, never the text.
5. **Fail closed:** name source errors, times out or exceeds the cap → phrasebook-only, and the ledger keeps no
   question text for that ask (as `identifierLeak` does today). The ledger's masked question is always name-masked.
6. **Composition:** `maskQuestion(question, terms, { nameTerms })` — web `terms` run first exactly as today (substring,
   case-insensitive), server names second (whole-word), identifier shapes last; one placeholder numbering.
   `assertNoIdentifiers` unchanged; beside it, before either wire, a separate witness `assertNoNames(masked, names)`
   (own token check, not the masker's code) throws `IdentifierLeak` → phrasebook answer. Applies to web AND phone asks.
7. **A server-name placeholder is never a tool subject:** it rehydrates to null for tools (tool answers "which
   patient? UHID please"), because no tool resolves a name to a patient and a name is not a visit number. Web
   `terms` placeholders rehydrate exactly as today. Name→patient lookup is a later epic.
Out of scope: quasi-identifiers (village, "sarpanch's wife") — residual risk, stated in the DPIA (R-6); spoken names (0049).

**Done means** (each a test; fail-first):
1. A question naming a patient registered today, with name masking switched off, makes **zero** model and chooser
   calls (recorded chooser + model stubs, call counts asserted = 0) — the guard refuses rather than sends.
2. With masking, the chooser/model request body contains `<<Pn>>` and never the name — roman, Devanagari ([a patient name]) and a
   long-vowel spelling variant ([a patient name]) each asserted; a confidential patient's real name and alias both masked.
3. The web path's `terms` behaviour is unchanged: existing mask/router/controller tests pass unedited, and a web ask with
   `terms` and no server-name hit yields the byte-identical masked string and slots as before.
4. Latency: on a fixture of 4,000 patients with encounters today, the name step finishes under 300 ms per ask, and
   EXPLAIN of its query shows no Seq Scan on `opd_encounters`, `opd_appointments` or `patients`; G4 (phrasebook +
   chooser p95 < 4 s) is not threatened by more than that step.
5. A near-match ([a patient name] with one extra letter) and a name-source failure each make zero model calls and still answer by phrasebook.
6. "aaram se", "kal aana" and a phrasebook cue word are not masked when a patient part equals "ram"/"kal".

Owner questions: none (no money, procurement or law in this change).
