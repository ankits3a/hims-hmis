# HANDOFF — the doctor's CDS co-pilot

**Read this file and `CLAUDE.md`. Nothing else, until a task below names something.**

Supersedes the 2026-09-14 brainstorm handoff: those three questions were put to the owner, answered,
and built. What follows is the state after that.

---

## ① WHERE THE WORK IS

| | |
|---|---|
| lane | `/opt/hmis-lanes/cds/hmis` |
| branch | **`lane/cds-dx-advice-allergy`** on the remote, **no PR yet**, 11 commits ahead of `origin/main` |
| ⚠ `lane/cds` | the remote branch is the PRE-REBASE history (`f7b969c1`) and is now dead. Do not build on it. |
| migrations | **0085–0089** (0085 is the regenerated catalogue-codes; 0086 ICD-10; 0087 diagnoses; 0088 coded allergen; 0089 advice library) |
| preview | web **:5195** → api **:3013** → db **`hmis_cds_dev`**, `demo.desai` / `DoctorDesk!Preview2026` |
| tunnel | `ssh -N -L 5195:127.0.0.1:5195 root@62.238.106.231` then `http://localhost:5195/opd/consult` |
| source data | `/opt/hmis-context/cds-bundle/` — now also `icd10-catalog.sql` (25 MB), sha256 in `SHA256SUMS` |

---

## ② THE OWNER'S RULINGS (the four new ones are 7–10)

1. *"The doctor must have the fields that he already have now."* — sharpen, do not replace.
2. *"If doctor types 'fever' and presses enter, 'fever' will be added a tag EXACTLY AS THE DOCTOR WROTE."*
3. Diagnosis / Advice / Advised investigations **suggest** only when the co-pilot is on. Drug
   autocomplete works always.
4. *"AI co-pilot to assist the doctor as much as it can with LOW help from LLM."*
5. Catalogue into `formulary_*` — one drug list, one safety layer.
6. Standing rule: the standard Indian-corporate-hospital answer, marked DECIDED; stop only for
   money, procurement or law.
7. **Diagnosis is SEVERAL TAGS**, not one value. (2026-09-14)
8. **ICD-10 comes from a real imported catalogue**, and the owner supplied it. (2026-09-14)
9. **Advice templates: a hospital library with the doctor's own favourites on top.** (2026-09-14)
10. **The doctor chooses the LANGUAGE per advice template** — English and Hindi side by side,
    tapping inserts only the one tapped. (2026-09-14)

**DECIDED without asking** (rule 6): completing a word the doctor is TYPING is autocomplete and is
never co-pilot-gated; what the co-pilot gates is proposing something nobody typed. ICD-10 category
headers are never offered (23,252 of them may group children but may never be assigned). No
provisional/final diagnosis flag.

---

## ③ WHAT IS BUILT (11 commits)

1. `784d513a` — **the rebase onto #186.** Two lanes built one drug field; both routes survive
   (`/formulary/suggest`, `/formulary/medicines/search`), the screen renders `DrugField`, and
   `searchMedicines` no longer offers a row with no moiety so a pick always carries a checkable id.
2. `da07992b` — **the ICD-10 catalogue** (97,296 codes) + the diagnosis typeahead.
3. `5039887f` — **diagnosis as tags**, each keeping its own code (`opd_encounter_diagnoses`).
4. `73e17fe6` — **the coded allergen**, which repairs a guard a typo could silence.
5. `52a51f01` — **the advice library**, bilingual, hospital + per-doctor.

Green at the last run: web **107 files / 972 tests**; core opd+cds+patients+formulary+schema+parity
**96 suites / 980 tests**; typecheck clean; lint 0 errors (4 pre-existing warnings).

---

## ④ MEASUREMENTS ALREADY PAID FOR — DO NOT RE-DERIVE

**The ICD-10 catalogue (`icd10-catalog.sql`):** 97,296 rows · 97,296 distinct codes · 96,507
distinct short descriptions · 74,044 billable · 22 chapters. Real data, not the six-template
fan-out the drug tables are. **Chapter 19 (injury) is 53,944 rows and chapter 20 (external causes)
10,573 — 66% of the book between them**, because ICD-10-CM gives almost every injury a 7th
character for the encounter episode.

**The formulary after the import:** salts 3,283 · medicines 103,383 · compositions 142,759 ·
**active medicines with NO moiety: 8** (99.992% curated). #186's "97.7% uncurated" is a measurement
of a formulary that no longer exists.

**The advice sources:** the 8 syndromes carry **no advice text at all** — only a key, keywords,
ICD-10, description, lines and substitutions. The bundle's `diet_and_lifestyle_advice` is six
distinct strings over 10,303 rows. Both were checked; the seeded library is authored, generic and
hospital-owned.

**Per-drug knowledge is still six templates** and must never ship as molecule-level knowledge.
**Every paediatric dose is a worked example for a 14 kg child.** **The hospital records no pregnancy
status** — the co-pilot ASKS.

---

## ⑤ WHAT IS OPEN

- **A PR for `lane/cds-dx-advice-allergy`.** `origin/main` moved 2 commits while this was built;
  rebase again before opening it, and renumber 0085–0089 at that point if main has taken any of them.
- **The two drug pickers.** `DrugCombobox` (#186, generics, no id) and `DrugField` (catalogue, with
  id) both live in the tree; only `DrugField` is wired. The owner should settle which survives —
  it is a real product question, not a merge artefact, and the rebase deliberately did not decide it.
- **The co-pilot toggle.** Nothing gates the AI-only fields yet (ruling 3).
- **A clinician signing the 3 unreviewed paediatric rates.** Until then those lines show the 14 kg
  example and no number, by design.
- **Usage-ranked diagnoses.** The structural ranking gets the right code into the visible list but
  `diabet` and `hyperten` need a few more characters. No structural property of ICD-10 separates
  E11.9 from E08.9 — only usage does. `curation.ts` already has the pattern (the prescribing stream
  is the worklist); ranking by this hospital's own assignments is the real fix, and it needs
  diagnoses to be recorded first, which they now are.
- **Nothing here is deployed.**

---

## ⑥ TRAPS THIS LANE PAID FOR

- **` | ` is the bundle's multi-value separator.** Missing it imported 31,168 fixed-dose
  combinations with NO moiety.
- **`icd10_catalog` is written POSITIONALLY** — `INSERT INTO t VALUES (...)`, no column list —
  unlike every other table in the bundle. A parser that keys on column names reads nothing and
  reports success.
- **A backtick inside a `sql` tagged template closes the template.**
- **An array parameter needs binding per value:** `= any(${arr})` fails with *op ANY/ALL (array)
  requires array on right side*; `in (${sql.join(...)})` works.
- **Ranking must be measured against the real catalogue.** Three drafts were wrong for drugs and
  three more for ICD-10 (`Diabetes insipidus` above type 2 diabetes; I10 not in ten rows;
  "Other asthma" above the residual code; five 7th-character variants of one fracture).
- **A regenerated migration is a NEW migration to a database that applied the old one.** It
  presents as `teardown is not a function`. Drop the lane test DBs; do not debug it.
- **Locale keys inserted by line number land in the wrong namespace.** `json.loads` before writing.
- **A surviving mutant is not always a weak test.** R2 has two independent defences; removing
  either leaves it green and removing both turns it red. Recorded beside the test.
