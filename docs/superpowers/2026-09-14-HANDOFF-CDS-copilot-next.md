# HANDOFF — the doctor's CDS co-pilot, next session

**Read this file and `CLAUDE.md`. Nothing else, until a task below names something.**

---

## ⓪ THE PROMPT — paste this to start

> Read `docs/superpowers/2026-09-14-HANDOFF-CDS-copilot-next.md` in the `cds` lane
> (`/opt/hmis-lanes/cds/hmis`), then brainstorm with me, in this order:
>
> 1. **The Diagnosis field** — how it should suggest, and where the suggestions come from.
> 2. **The Advice field** — same, plus the doctor's own saved templates ("a prefilled template saved
>    as a module"), and remember the patient READS this one.
> 3. **Allergies** — autocomplete, autocorrect and autosuggest on the field I can already type into.
>
> Brainstorm first, build after I pick. §5 of the handoff has my constraints and the measurements
> you already paid for — do not re-derive them.

---

## ① WHERE THE WORK IS

| | |
|---|---|
| lane | `/opt/hmis-lanes/cds/hmis`, branch **`lane/cds`**, pushed, **no PR yet** |
| commits | 5, listed in §4 |
| base | `origin/main` after #183 + #184 merged (the doctor-desk pair: park/resume, session reopen, skip reasons) |
| migration | **0084** `formulary_catalogue_codes` — additive: 4 columns + 4 indexes |
| preview | web **:5195** → api **:3013** → db **`hmis_cds_dev`**, `demo.desai` / `DoctorDesk!Preview2026` |
| tunnel | `ssh -N -L 5195:127.0.0.1:5195 root@62.238.106.231` |
| docs | `/opt/hmis-preview-cds/README.md` (start/stop/teardown), plan at `docs/superpowers/plans/2026-09-14-PLAN-CDS-copilot.md` |
| source data | `/opt/hmis-context/cds-bundle/` (out of git, SHA256SUMS beside it) |

**Do not drop the `doctor-desk` lane or its preview (:5194/:3012)** — the owner may still be testing
the park/skip work there. `tools/lane.sh status` before any full suite; one jest pool per lane.

---

## ② THE OWNER'S RULINGS (verbatim where it matters)

1. *"The doctor must have the fields that he already have now."* — **sharpen the existing screen, do
   not replace it.** A stage-based redesign was built and REJECTED; the design canvas is
   https://claude.ai/code/artifact/24b678be-e26e-4fe7-97f6-e362849a40bc and is now only a record of
   that turn. Don't revive it.
2. *"If doctor types 'fever' and presses enter, 'fever' will be added a tag EXACTLY AS THE DOCTOR
   WROTE."* — the field never rewrites the doctor's words.
3. Diagnosis, Advice and Advised investigations suggest **only when the AI co-pilot is enabled**.
   The drug field's autocomplete works **always**, co-pilot or not.
4. *"I wanted AI co-pilot to assist the doctor as much as it can with LOW help from LLM."*
5. Catalogue into **`formulary_*`**, the same tables the safety checks read — one drug list, one
   safety layer. (Asked and confirmed, 2026-09-14.)
6. Standing rule: pick the standard Indian-corporate-hospital answer and mark it DECIDED; stop only
   for money, procurement or law.

---

## ③ MEASUREMENTS ALREADY PAID FOR — DO NOT RE-DERIVE

**The bundle (`/opt/hmis-context/cds-bundle/`):**

- `syndromes-a.json` (76 KB) is the **whole curated corpus**: 8 syndromes + 22 rule domains, ~150
  rows. `syndromes-b.json` is a strict SUBSET of it — ignore.
- `cds-bundle.sql` (136 MB) = the catalogue + the same rules + **fanned-out template text**.
- **The per-drug knowledge is six templates.** `clinical_knowledge`: 43 columns × 10,303 rows, **6
  distinct values per column** (`storage`: ONE, for every drug). `drug_faqs`: 42,819 rows, **27
  distinct Q/A pairs** (one repeated 7,830×). `prescribing_defaults`: 6–9 distinct values. Fanned out
  BY CLASS, so the **ampicillin** monograph cites **azithromycin's** ATC code. **Never ship this as
  molecule-level knowledge.**
- **Every pediatric dose is a worked example for a 14 kg child.** 19 lines; only 4 state a mg/kg
  rate. Classified once, offline, in `scripts/build-cds-knowledge.ts`.
- The catalogue IS real: 3,283 SNOMED substances, 10,303 generics with `hmis_code` (`D0230`), 93,905
  brands with manufacturers.

**After import (live in `hmis_cds_dev`):** salts **3,283** · medicines **103,383** · compositions
**142,759** · medicines with no moiety **8** (none of them generics).

**The hospital records NO pregnancy status** — not on the encounter, the patient or the chart.
Measured. The co-pilot therefore ASKS rather than assumes.

---

## ④ WHAT IS BUILT (5 commits on `lane/cds`)

1. `4669b8ce` — knowledge as **code** (`src/modules/cds/knowledge.json`, 80 KB, zod-gated at boot),
   the syndrome matcher (keywords, no model), and `regimen.ts` which **refuses to compute a dose
   from an unreviewed rate**.
2. `6c9b8c08` — `guardrails.ts` (allergy · paediatric · pregnancy · G6PD · QTc · AWaRe cards, each
   carrying its rule id) and two reads under `opd.consult`: `GET /opd/cds/suggest`,
   `GET /opd/cds/regimen`. **Every dosing input is read from the record; the weight is not a
   parameter.**
3. `fd367f87` — the co-pilot on the consult screen: syndrome chips under the complaint, the regimen
   card with danger cards, 1-tap fill. `toRxDraft()` maps a line to the form server-side.
4. `770d7389` — **chief complaint is a TagField** (`components/tag-field.tsx`) and the doctor can
   **record an allergy** from the consult screen (`source: "consult"`, no new permission).
5. `02da6afb` — the **catalogue import** (`scripts/import-cds-catalogue.ts`) and the **drug
   typeahead** (`components/drug-field.tsx`, `modules/formulary/search.ts`).

Green at the last run: web **106 files / 934 tests**, core cds+opd+formulary **47 suites / 455
tests**, typecheck and lint clean.

---

## ⑤ WHAT TO BRAINSTORM NEXT — with the groundwork already done

### 5.1 · Diagnosis

The field today: free text `diagnosis` + a separate `icd10Code` text input, both typed from memory.

What exists to draw on:
- Each of the 8 syndromes carries an **ICD-10 code** already (`J06.9` etc.) — tapping a syndrome
  could fill diagnosis + code together, which is the cheapest win and needs no new data.
- There is **no ICD-10 catalogue** in this repo. Importing one is a real task (the bundle does not
  ship it; `clinical_knowledge.icd10_indication_mapping` is template text — 6 distinct values).
- `TagField` already exists and takes any suggester, so a multi-diagnosis field (comorbidities) is
  a small step; **decide whether diagnosis is one value or many** — the encounter column is a single
  string today, and the ` · ` tag convention already solves that shape.

Questions worth putting to the owner: one diagnosis or several? ICD-10 required or optional at the
desk (MRD codes later)? Is "provisional vs final" a distinction this OPD makes?

### 5.2 · Advice

- **The patient reads this one.** It prints on the slip. So the suggester should be able to offer
  **Hindi** text, and the stored value may need both scripts. That is the strongest design
  constraint here and it is unique to this field.
- The bundle's `diet_and_lifestyle_advice` is template text (6 values) — weak as a source.
- The owner's own idea: *"a prefilled template saved as a module"* — doctor-owned advice templates.
  Where do they live? A per-doctor table, a department default, or a shared library with the
  doctor's favourites on top? This is the real question.

### 5.3 · Allergies — autocomplete / autocorrect / autosuggest

Directly buildable now, and it makes an existing guardrail more reliable:
- **Source**: the 3,283 imported substances (`formulary_salts`, already trigram-indexed) **plus** the
  bundle's six allergen classes (`allergy_rules.allergen` / `allergen_class`, e.g. "Penicillins /
  Beta-Lactams" with its `blocked_classes` list).
- **Autocorrect** is genuinely available: `pg_trgm` + `similarity()` over the salts table turns
  `pencilin` into `Penicillin` without a model. `fuzzystrmatch` is installed too.
- **Why it matters beyond convenience**: `regimen.ts`'s `blockedBy()` matches the patient's allergy
  text against `blocked_classes` on **word tokens of ≥5 letters**. A typo'd allergy silently matches
  nothing, so the guardrail goes quiet. A picked substance makes the block reliable; free text must
  stay legal (same law as the drug field) but should warn when it matches no known allergen.

---

## ⑥ TRAPS THIS SESSION PAID FOR

- **` | ` is the bundle's multi-value separator.** Missing it imported every fixed-dose combination
  with NO moiety — 31,168 medicines invisible to interaction checking. Caught by asking why
  compositions were short of medicines.
- **`INSERT OR REPLACE INTO`** — the dump uses two verbs and explicit column lists. Parse by column
  NAME.
- **A backtick inside a `sql` tagged template closes the template.** Comments with `identifiers` go
  above the query, not in it.
- **Locale keys inserted by line-number land in the wrong namespace.** A parity test catches it
  ("these t() keys are in no locale file") — anchor on a key only the target namespace has, and
  `json.loads` before writing.
- **Ranking must be measured against the real catalogue.** Three drafts were wrong: `Parcar` above
  paracetamol; `clav` never reaching amoxicillin-clavulanate; `Amoxapine` (14 products) above
  `Amoxicillin` (3,830). The sort key is `salt_rank`, set by the import.
- **An `OR` across a trigram match and a correlated EXISTS defeats the index** (seq scan of 103,383
  rows); `formulary_medicine_salts`' PK leads with `medicine_id`, so the reverse lookup scanned
  142,759 rows. UNION + an index on `salt_id`: 800 ms → 220 ms.
- **A `<select>` of the whole catalogue is 15 MB.** Any new picker must be a typeahead.
- The comma is not a safe tag separator — a doctor writes *"fever since 3 days, worse at night"*.
  ` · ` is.

---

## ⑦ HOW TO RUN THINGS

```bash
# preview (already up; README has stop/restart)
ssh -N -L 5195:127.0.0.1:5195 root@62.238.106.231     # then http://localhost:5195/opd/consult

# rebuild the API after a server change
cd /opt/hmis-lanes/cds/hmis && pnpm --filter @hmis/core build
ss -ltnp | grep ':3013 ' | grep -o 'pid=[0-9]*' | cut -d= -f2 | xargs -r kill
cd apps/core && DATABASE_URL=postgres://hmis:hmis@localhost:5433/hmis_cds_dev PORT=3013 \
  MEMBER_BENEFITS_ENABLED=true HMIS_ENVIRONMENT_LABEL="CDS CO-PILOT" \
  nohup node dist/src/main.js > /opt/hmis-preview-cds/api.log 2>&1 &

# tests
pnpm typecheck && pnpm lint
pnpm --filter @hmis/core exec jest -w 2 src/modules/cds src/modules/opd src/modules/formulary
pnpm --filter @hmis/web exec vitest run src/screens/opd-consult.test.tsx

# re-import the catalogue (idempotent: skips names already present)
cd apps/core && DATABASE_URL=... pnpm exec tsx scripts/import-cds-catalogue.ts \
  --bundle /opt/hmis-context/cds-bundle/cds-bundle.sql [--apply]

# rebuild the knowledge fixture from the bundle
pnpm exec tsx scripts/build-cds-knowledge.ts /opt/hmis-context/cds-bundle/syndromes-a.json \
  src/modules/cds/knowledge.json
```

**Still open:** the co-pilot toggle (nothing gates the AI-only fields yet), a PR for `lane/cds`, and
a clinician signing the 3 unreviewed paediatric rates — until then those lines show the 14 kg
example and no number, by design.
