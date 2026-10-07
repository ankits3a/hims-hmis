# Self-improving suggestions — plan (2026-10-07)

Decision records: `docs/decisions/0050-self-improving-suggestions.md`, `0051` (the AI reviewer for medicine
aliases; US FDA labels as the first drug-reference layer) and `0052` (DDInter major interactions; Indian gap). Read them first; they hold the owner's words. This plan is the spec. Nothing here is built. Two independent reviews shaped it; §15 says where they
differed and what was chosen.

## 1. Goal, in the owner's words

"a system that auto improves, auto evolves based on actions of the doctor and staff. If any suggestion is
crossed multiple times then it should be silently discarded and a better suggestion should appear …
personalised to that specific doctor who is prescribing. Highly personalised. A system that also helps
front desk staff to point the patient to right department."

## 2. Principles

1. **Learn from committed visits.** Evidence is what a completed visit holds: issued prescription lines,
   recorded diagnoses, advised tests, complaints. Taps and crosses only demote and measure.
2. **Counts, not models.** Ranking is arithmetic over the hospital's own history. No model ranks or writes
   a diagnosis, medicine or dose. Never rank by acceptance rate.
3. **Never auto-add.** Every suggestion is tapped by the person. Safety checks (`rx-precheck`) run on every line.
4. **Explain every suggestion** with raw counts: "you gave this in 14 of your last 50 visits for this diagnosis".
5. **Hide after explicit × three times.** Not looking is not a dismissal.
6. **No dose for a child** in the first version (decision 0009; awaiting the owner's yes in 0050).
7. **Stewardship cap.** Personal habit never lifts restricted classes above the department's pattern.
8. **Outside services get no names as data** (0048); a spoken name may travel in audio (0049).
9. **Chips never jump.** Rank once per context change; never re-rank mid-session from the same session's taps.

## 2a. Three levels of learning

| Level | What changes | Who approves |
|---|---|---|
| **1 — Automatic** | Only the ORDER of options that already exist: most-used diagnoses, the medicines this doctor and department pick most. Pure counting (§7). | Nobody. |
| **2 — Proposed vocabulary** | New words the system did not know: aliases ("pan forty" → Pantoprazole 40 mg), new complaint terms, test-name aliases, the desk's learned vocabulary, new Ask phrasings. | **No person.** A chooser and an AI reviewer must agree, rule checks must pass, and then doctors' own use makes it trusted (§7a). The owner gets a weekly list with a one-tap undo. |
| **3 — Never learned** | Clinical facts, doses as rules, interactions, money rules, permissions. | Only an owner ruling in `docs/decisions`. |

An outside session advised a named human reviewer for level 2. The owner ruled otherwise: "currently no one
adds and no one approves. No body has anytime to do it and so I am looking this to be automated using advanced
AI model", and of a pharmacist reviewer he said he has no hope there and "I would ask AI to get in this". So
level 2 waits for no person; it is gated by agreement between two models, hard rules, and approval by use.

## 2b. The two-way loop

- **Staff teach the system with no extra work:** corrections to a voice note; a suggestion crossed off or
  replaced by typing; "didn't understand" in Ask; which search result was picked; saved sets and phrases.
- **The system helps staff:** better-ordered suggestions; one card, one action; drafts confirmed by a tap;
  refusals explained; personal shortcuts.
- **The engine:** signals → patterns found nightly → proposals (versioned, audited) → a weekly scorecard.
- **Learn only from confirmed outcomes:** the saved prescription, not the first tap.

## 3. The fallback ladder — Jev as the chooser

1. An exact rule or exact match.
2. The hospital's own counts (personal → department → hospital).
3. Jev (TypeSafe classifier): picks one of OUR options with a confidence.
4. A second, larger model when Jev is unsure.
5. "Not sure — please choose."

Jev is never used where step 1 or 2 decides, never for doses or amounts, sees masked text only, and every use
keeps working when the vendor is slow or down. See §9.

## 4. What exists to extend (do not rebuild)

- `opd_complaint_term_usage` — per (term, doctor) counter written at completion (`modules/opd/complaints.ts`).
- `myTerms` and `testsForDiagnosis` "mine then hospital" (`modules/opd/term-suggest.ts`).
- `complaint-ranker.ts` — token-IDF complaint ranking. `proposeConceptFor` — trigram concept proposals.
- `formulary/reads.ts` — substring then `pg_trgm` similarity > 0.3. No alias table ("DECIDED: not aliases").
- `triage-choice.ts` / `triage.ts` — Jev then a chat model for the front desk's department;
  `kernel/copilot/choice-route.ts` — the same chooser for copilot intents, with its example mechanism;
  `kernel/inference/types.ts` `ChoiceClient.choose`; `mask.ts` / `assertNoIdentifiers`.
- `rx-precheck`, the 400 curated `formulary_interactions`, the override columns on `opd_prescriptions`.
- `cds/regimen.ts` `bandFor` (adult vs paediatric: under 40 kg or under 12 years); `cds/rx.ts` `frequencyOf`.
- The phone consult (lane `phone-consult`) already uses frequency chips, records each line's source and a
  "no match" log. Reconcile names with it; do not add a second copy.

## 5. Phase 0 precondition — make the ground truth countable

Today `RxLine.dose` and `.frequency` are free strings (`modules/opd/fhir.ts:17-45`; the web form validates
frequency as `z.string().min(1)`, `opd-consult.tsx:210`; the `FREQUENCY_OPTIONS` that `cds/rx.ts:29` mentions
does not exist in the web app). "41 of 50" never appears while "1 tab", "1 Tab" and "one tablet" count apart.
Before any learning:

- A closed frequency set on web, phone and the scribe desk, reusing `frequencyOf`.
- Dose parsed into `{amount, unit}` with the raw string kept.
- A backfill over historical lines that reports the unparsed share. A model may propose a canonical form for
  an unparsed string, offline, as a proposal only.
- Text keys when a diagnosis is uncoded (lowercased text).
- One pass mapping the top 50 unmapped complaint terms to existing concepts.

## 6. Data model (all additive)

| Piece | Shape | Phase |
|---|---|---|
| Provenance | optional `source` (`typed`/`suggested`/`set`/`repeat_last`/`voice`/`search`) and `suggestionEventId` on `RxLine`; nullable `source` on `opd_encounter_diagnoses` | P0 |
| `cds_suggestion_events` | append-only: id, at, surface, doctor_id, user_id, department_id, encounter_id (null at the desk; **no patient_id**), context_key, context jsonb, item_kind, item_key, rank_shown, source_level (`personal`/`dept`/`hospital`/`starter`/`alias`), outcome (`shown`/`tapped`/`dismissed`/`edited`/`manual`), batch_id. One `shown` row per batch with an items array. | P0 |
| `cds_rx_lines` | one row per issued line, written **inside the issue transaction**: doctor_id, department_id, encounter_id, dx_key, band, medicine_id, moiety set, dose amount/unit, frequency, days, raw strings, `had_override`, `from_suggestion`, AWaRe / schedule / NDPS flags, `transcribed` (a scribe's line counts as the doctor's). Lines with a null doctor are excluded from learning. | P0 |
| Reset watermark | `cds_doctor_learning_reset_at` per doctor (and per surface). Personal levels ignore evidence before it; department and hospital levels keep the lines anonymously. | P4 |
| `cds_aliases` | term, kind (`complaint`/`drug`/`test`), target_key, proposed_by (`model`/`trigram`), taps, distinct_doctors, dismissals, edited_to_other, status (`proposed`/`trusted_by_use`/`dropped`), never_trust | P2 |
| `cds_desk_routing_outcomes` | triage_id, masked concept set, suggested departments, picked department, final department, moved (yes/no), referred (yes/no) | P3 |
| Look-alike (LASA) list | table of name pairs with source and review date. None exists in the repo. Either a curated list (candidates: Indian Pharmacopoeia Commission / PvPI advisories, NABH medication-safety lists, ISMP's confused-names list filtered to our formulary) or, until then, edit distance ≤ 2 among the top 500 prescribed names. | P2 |
| `cds_rank_tables` | nightly rollup beside `rollupUserDayFacts`: (level, scope_id, surface, context_key, item_key) → raw n, decayed n, last_at | P5 (live SQL + 60 s cache until then) |

`encounter_id` stays on the internal event log: it is the join to ground truth. The no-identity rule is for
outside services. Model prompts are never logged beyond the term itself.

## 7. Scoring

**Keys**
- Medicines, doses, tests, advice: keyed on the **diagnosis** — `dx_key` = ICD-10 three-character prefix, else
  the lowercased text.
- Diagnosis: keyed on the complaint concept set, and only when that exact set has n ≥ 5 hospital-wide;
  otherwise on its most specific single concept.
- Two age bands only (`bandFor`: adult, paediatric). No sex. Season is recency weight only.
- If production shows under about half of visits carry a diagnosis (§10), medicines fall back to the
  complaint key for visits without one.

**Rank** — recency-weighted P(item issued | context) with pseudo-count back-off:

```
w(visit)  = 0.5^(age_days / 90)
p̂_level  = (Σ w·[item issued] + α · p̂_parent) / (Σ w + α)          α = 5
levels    : doctor+band → doctor → department+band → department → hospital → signed starter set
show only if p̂ ≥ 0.15 and raw n ≥ 5 (personal) / 10 (department) / 20 (hospital)
```

**Dismissal**

```
d      = Σ explicit × · 0.5^(age_days / 30)        an accept (tap or manual add) resets d to 0
score  = p̂ · max(0, 1 − d/3)                       hidden at d ≥ 3
"shown, not tapped, and a different item issued for that slot" = 0.3 of a dismissal
```

A manual add of the same item in the same context un-hides it at once. A hidden item returns by decay in
about 30–50 days. Shown-and-ignored with nothing else issued counts for nothing. The last slot is the
department's best item not already in the doctor's list; there is no random exploration.

**Diagnosis from complaint combinations** — naive Bayes over the set's members when the exact set is thin:

```
log s(dx) = log (n_dx + α·p_dx,parent)/(N + α) + Σ_{c present} log (n_c,dx + β·p_c,parent)/(n_dx + β)     α = β = 5
```

Presence only (an absent complaint is usually "not recorded"). Show the top 5 with share ≥ 0.10 and n_dx ≥ 5.
The same counts give complaint-chip completion (P(cough | fever)). Evidence is counted from committed visits
only; suggested-provenance evidence is discounted to 0.7; a suggested share above 80% is reported as echo.

**Stewardship** — for Watch/Reserve antibiotics, `antimicrobial_restricted`, systemic glucocorticoids (needs a
small moiety list), Schedule H1/X and NDPS: `score = min(score, department p̂)`. On those items only, the chip
shows the comparator "you: 41/50 · department: 12/50" and never "because you chose this".

**Adult dose** — the doctor's modal (dose, frequency, days) for (medicine or moiety set, `dx_key`), only when
raw n ≥ 5 and the mode holds ≥ 60%. Refused when: pregnancy is asserted; a coded CKD or chronic liver disease
(N18, K70–K74) within 365 days; H1/X/NDPS; a high-alert class (insulin, anticoagulants, digoxin,
methotrexate, opioids); the dose is unparsed; any source line carried a safety override; age under 1 month or
weight under 3 kg. Otherwise the medicine is suggested with the dose blank. No eGFR exists in the system;
the coded-diagnosis gate is the only renal guard and the plan says so.

**Children** — no dose suggestion in the first version (decision 0009). A later option for the owner: the
doctor's own line only, when a weight is charted on this visit and the history is in the same weight band
with n ≥ 5 — never a computed mg/kg.

**Aliases**
- Complaint terms: trusted by use at ≥ 3 distinct doctors and ≥ 5 taps with no × in 30 days.
- Drug aliases: trusted by **composition agreement** — the alias resolves to one medicine or generic, the full
  product name is always on the chip, ≥ 3 distinct doctors and ≥ 10 taps, zero "edited after tap to a different
  moiety set", never when two targets each hold > 20% of its taps, never H1/X/NDPS.
- An untrusted alias only ever shows as a suggestion.

## 7a. Level 2 pipeline — chooser, AI reviewer, rules, then use

For a medicine term nothing matched ("pan forty", a brand nickname, a mishearing):

1. **Candidates:** exact match, then trigram candidates from the formulary.
2. **Chooser — Jev:** a closed set (the candidates plus "none of these"), given the masked term only.
3. **AI reviewer:** a second, stronger text model (OpenAI, the owner-approved vendor; the model id is a server
   setting) is asked one closed question per proposal: "does <term> mean <generic · strength · form>? yes / no
   / unsure", with the top competing candidates shown. It answers only from that set and gives one fixed reason
   code: name match, strength match, common brand nickname, ambiguous strength, ambiguous form, look-alike
   risk, not a medicine. It never writes free text into the product. It sees the term and catalogue rows only —
   no patient data.
4. **Rule checks:** a single target; a strength in the term, if any, equals the target's; never H1/X/NDPS; not in
   a look-alike conflict with another formulary name unless the second-tap guard applies.
5. **Live as a suggestion** only when chooser and reviewer agree, each above its own confidence line, and the
   rules pass. Disagreement or "unsure" stays in the no-match log, is retried when new evidence arrives, and is
   never shown.
6. **Trusted (ranked first)** only by composition-agreeing use by several different doctors (§7).
7. **Re-audit:** the reviewer re-checks trusted aliases monthly and whenever the formulary changes. It can only
   DEMOTE; nothing is promoted without use.

**Evaluation before go-live:** a held-out labelled set of at least 200 real Hinglish and brand-nickname terms →
the correct medicine, built from formulary brand names, common Indian abbreviations and deliberately tricky
look-alikes. Report precision at the chosen confidence line. Target: zero wrong at the line (abstain instead).
The measured numbers are stated before it is switched on.

The same pattern — chooser, AI reviewer, rule checks, trust by use — serves new complaint terms and test-name
aliases with lighter thresholds. A web search by an agent is only for building reference or evaluation
material, and only with the owner's approval each time.

## 8. Phases

Each phase is its own PR(s), tests fail-first, web and phone both, English and Hindi.

**P0 — Countable ground truth and instrumentation** (about 5 days; 1–2 migrations)
- §5 in full. Provenance fields, `cds_suggestion_events`, `cds_rx_lines` written at issue, a × on every
  suggestion chip (web consult, phone consult, scribe). Production coverage measured (§10).
- Touches: `modules/opd` (fhir, prescriptions, consultation), `cds/rx.ts`, web `opd-consult*.tsx` and the
  scribe, `apps/mobile` consult.
- Accept: a new line stores a closed frequency and a parsed dose; the backfill reports its unparsed share; a
  committed line carries its source; a × writes one dismissal; ranking is unchanged.
- Risk: changing the frequency field is a UX change for doctors — the owner looks at it on staging first.
- Owner sees: frequency as chips everywhere; a × on suggestions.

**P1 — Own-pattern medicines, diagnosis from complaints, three numbers** (about 7 days; 0–1 migration)
- §7 rank, dismissal, stewardship and adult dose; naive-Bayes diagnosis chips; complaint completion; live SQL
  with a 60 s cache; a kill switch per surface.
- Touches: `modules/opd/term-suggest.ts` and a new `cds/suggest/`, formulary class flags, web and phone consult.
- Accept: fixtures prove each back-off level and threshold, the hide rule and its return, no dose for a child,
  no dose from an overridden line, capped classes show the comparator, chips do not re-rank mid-session.
- Owner sees, weekly: "7 of 10 medicines were tapped, not typed"; "the right answer was in the top 3 for
  71%"; "tapped lines raised a hard warning 0.8% of the time, typed lines 1.1%".

**P2 — Automatic aliases and complaint normalisation through Jev** (about 6 days; 1 migration)
- `cds_aliases`; the no-match log feeds proposals; the §7a pipeline (Jev chooser, AI reviewer, rule checks,
  trust by use, monthly re-audit that only demotes); `choose()` also classifies an unmapped complaint phrase
  into the EXISTING concept set; LASA second tap from the interim edit-distance rule, then the curated list; the
  owner's weekly list with a one-tap undo per item.
- Accept: the reviewer's 200-item evaluation is reported with zero wrong at the line; each new Jev use has its
  eval set and confidence line (§9); an alias the two models disagree on is never shown; an untrusted alias
  only ever shows as a suggestion with the full name; a two-target alias is never trusted; undo removes one
  alias and is audited.

**P3 — Front desk and Jev** (about 7 days; 1 migration)
- `POST /opd/triage` returns a `triageId`; walk-in and appointment create carry it; `cds_desk_routing_outcomes`.
- **Labels:** the department where the visit COMPLETED after a move, or an unsuggested desk pick that completed
  there. A referral is a metric, not a label.
- **Three feeding channels, safest first:**
  1. A statistical prior P(final department | concept set), used only with ≥ 80% token coverage and no negation
     token: n ≥ 20 and p ≥ 0.8 answers first; n 10–19 only re-ranks when Jev's top two are within 0.15.
  2. A learned vocabulary TAIL appended to (never rewriting) the hand-written `DESCRIPTIONS`: tokens with
     P(dept | token) ≥ 0.8, n ≥ 10, unique to one department, capped at about 12, versioned nightly. The triage
     cache key includes a fingerprint of the descriptions.
  3. Few-shot examples mined from corrections: ≤ 12 words, passes `assertNoIdentifiers`, recurred ≥ 2, not in
     the holdout, at most 3 per department, through choice-route's existing example mechanism.
- **Holdout:** a stable hash of the normalised masked text, mod 10 < 3 → holdout, never promoted. The 46 in-repo
  evaluation cases stay the regression floor and move to a non-test module so the promoter can refuse their
  hashes. Nightly evaluation; a drop of more than 5 points in a week freezes channels 2 and 3.
- **Guardrails:** red flags first and never learned; a child by age goes to Paediatrics first (Jev's specialty
  may take slot two); the prior never routes a child to adult medicine; only active departments; never an
  empty list. Age is not passed to Jev today — it is applied by rule around it.

**P4 — What the system learned about me; stewardship; digest** (about 4 days; 1 migration)
- A doctor's page: top patterns per diagnosis, what is hidden, Reset (the watermark; personal levels only).
  The monthly stewardship number. A weekly owner digest as templated numbers — no model prose.

**P5 — Scale and reference** (later; 1–2 migrations)
- Nightly `cds_rank_tables` when the live query's p95 passes about 150 ms. Local embeddings as a fallback only
  if the no-match log shows concept misses that aliases and trigram cannot cover (pgvector is not installed on
  production or staging and is not in staging's database image). A drug-information store from a real source (§11).

## 9. Jev everywhere — the chooser pattern

**Used today:** the front desk's department (`triage-choice.ts`; 40/46 alone, 45/46 in cascade, every miss
under the 0.6 line) and the copilot's question routing (`choice-route.ts`; 63/64 on counter questions).

**New uses in this plan:** matching a Hinglish or misheard term to one of our candidates; classifying a typed
or spoken complaint into an existing concept. Both run offline as proposals first (P2).

**Checklist for every use**
1. A closed set of OUR options, plus "none of these".
2. Masked input only; no patient name, UHID, phone or address.
3. An evaluation set of at least 40 real examples that are never used as examples or descriptions.
4. A confidence line chosen from that evaluation, recorded with the score.
5. A fallback below the line (second model, then "please choose").
6. A latency budget (about 300 ms warm; a 1,000 ms timeout).
7. A versioned model id, never an alias such as `jev-latest`.
8. Vendor-down behaviour written and tested: the screen still works.

### 9a. A second chooser to evaluate — OpenAI's Decisions API (owner 2026-10-07: "let's try OpenAI Decision API")

Per OpenAI's docs, 2026-10-07: `POST /v1/decisions`, public beta, only model `gpt-6-luna`. Question types:
`predicate` (the probability a condition is true), `choice` (one of the supplied values, with `probabilities`
and `confidence`), `score` (a probability-weighted level index). Text and image input; several independent
questions per request; a `refusal` answer type exists. Pricing $0.10 per 1M input tokens, no output charge.
ZDR / HIPAA for eligible customers. Guidance: "Use labeled examples from your application to set thresholds".

Decided by delegation:
- **A second `ChoiceClient` provider beside TypeSafe's Jev** in `kernel/inference/`, same interface: a closed
  set in; choice, confidence and probabilities out; a versioned model id as config; a timeout; masked input
  through the existing choke point; `refusal` handled as "unsure".
- **A new `predicate` capability on the interface**, for the AI reviewer step of medicine aliases ("does
  <term> mean <product>?", §7a) and later yes/no checks.
- **Side-by-side evaluation BEFORE choosing an order**, on the same held-out sets: the 46 triage complaints,
  the 64 copilot questions (82 with pharmacy), and the new ≥ 200-item Hinglish alias set. Report top-1,
  accuracy at the confidence line, answer rate, latency p50 / p90 from this server, and cost per 1,000 calls.
  Primary and fallback are then set per USE by the numbers — a config, not code. Whether it handles Hinglish
  and north-Indian vocabulary better is the hypothesis to test, not a claim.
- **Beta caveats:** behaviour and price may change; it is never the only chooser; it has its own kill switch.
- **Dependency (owner action):** the OpenAI key must also be on this server (staging and building) at
  `/root/.config/hmis/openai/key.txt` for the evaluation. Today it appears to exist only on the production host.

Not adopted now: the Live voice conversation of the decisions-voice guide (a model listening and speaking
continuously). It conflicts with standing rulings — no chat, answers shown not spoken, a model never writes or
speaks the answer — and needs a continuous audio stream. Only the pattern is taken: speech → text → a chooser
picks among the actions available on the CURRENT screen → the app shows a draft the person taps.

**Candidate later uses**

| Decision | Verdict |
|---|---|
| Department at the front desk | Jev, after red-flag and child rules, with the hospital prior |
| Which lookup an Ask question means | Jev, after the phrasebook |
| Hinglish term → medicine / test / complaint | Jev over trigram candidates |
| Kind of a photographed paper (prescription, report, referral) | Jev, once an eval set exists |
| Handwritten test name → catalogue test | Jev over trigram candidates |
| Visit type, fee, who may approve | Rule |
| Danger signs (chest pain, a blue baby) | Rule |
| Which medicine this doctor usually gives | Count |
| Voice commands inside the consult screen ("add paracetamol 500 TDS five days" → a draft line to tap) | Chooser, later, with its own eval set |
| Dose, amount, anything computed | Never a chooser |

## 10. Coverage — measure before P1

Staging (a copy with test activity only), last 60 days, measured 2026-10-07:

| Measure | Staging | Production |
|---|---|---|
| Completed OPD visits | 7 | |
| Doctors with a completed visit | 3 | |
| Median completed visits per doctor per day | 1 | |
| Visits with any diagnosis | 3 | |
| Visits with a coded diagnosis | 1 | |
| Visits with a chief complaint | 7 | |
| Visits completed on paper | 0 | |
| … of those, with a scribe's transcription | 0 | |
| Visits with an issued prescription | 0 | |
| Issued prescription lines | 0 | |
| … of those, linked to a medicine in our list | 0 | |
| Distinct dose strings / frequency strings | 0 / 0 | |
| Complaint concepts / terms | 13 / 118 | |
| Rows in the complaint usage counter (uses) | 13 (15) | |

Staging tells us nothing about real use: it has no issued prescription. Production's numbers decide the key
(diagnosis or complaint) and whether the scribe's typed prescriptions are the main fuel.

The owner runs this once (counts only, no patient data; the query is `/opt/hmis-context/suggest-measure.sql`):

```
! ssh -i /root/.ssh/hmis_deploy root@2.28.235.10 "docker exec -i hmis-prod-db-1 psql -U hmis -d hmis -At" < /opt/hmis-context/suggest-measure.sql
```

No routing suggestion is linked to a visit today, on either system: there is nothing to count until P3.

## 11. Drug information — phase D (owner 2026-10-07: "yes add this to the plan")

The in-house clinical-master bundle is template text and is never used (decision 0050). The first real layer is
the US FDA's public drug labels. Coverage was measured on 2026-10-07 (report and data:
`/opt/hmis-context/fda-coverage-2026-10-07/`).

| Measure | Exact US label | Notes |
|---|---|---|
| Formulary rows (10,303) | 79.1% (8,150) | 7% more have every component but no combination label; 8.9% have nothing |
| Stocked items (350) | 90.6% (317) | 17 have nothing |
| Indian brands (~103,000) | 72.1% | |
| Single substances | 88.8% | |
| Combinations | 41.9% | a further 35.3% by components only |

Sections present on covered substances: indications 99%, dosage 99%, warnings 99%, adverse reactions 93%,
populations 94%, contraindications 92%, patient information 83%, interactions 77%, overdose 77%. A label runs
to a median of about 42,000 characters; 94 of the best labels are older than 2016.

**What is built (about 6 days; 1 migration)**
- A separate reference layer per generic — a new table, not the reviewed `formulary_monographs` store, which
  stays for text a pharmacist wrote and a physician reviewed. Sections: uses, directions, common and serious
  side effects, warnings and boxed warning, contraindications, interactions (text), pregnancy / lactation /
  children / elderly, overdose, storage, patient information.
- Ingestion from the bulk export with name and text matching and the 337-entry Indian/INN → US synonym map
  (68% of labels lack the `openfda` block, so the search API misses them). A monthly refresh, versioned.
- Every entry is labelled "US FDA label · <product> · <effective date>" and "reference only — the US product
  may differ in strength, dose and approved use".
- It NEVER feeds a dose or a safety check. Safety stays on the 400 curated interactions.
- A combination covered by components only shows each component's entry and a plain line that the combination
  itself has no reference.
- Where nothing exists: "No reference information yet". Never the template bundle.
- Search over the store is plain text and trigram first.

**Licence and the owner's decision.** openFDA: "Unless otherwise noted, the content, data, documentation, code,
and related materials on openFDA is public domain and made available with a Creative Commons CC0 1.0 Universal
dedication." Every response also carries "Do not rely on openFDA to make decisions regarding medical care".
The text is written by manufacturers. Showing it to clinicians as labelled reference text is the owner's
decision (he agreed to these terms; decision 0051).

**Open:** summarising label text into short, phone-readable text is a model writing clinical text. It is a
later step and needs the owner's explicit ruling.

### 11a. Indian gap — sources in order (owner 2026-10-07: "yes. I will go with your recommendation")

About 480 substances sold only in India and about 680 Indian fixed-dose combinations have no US label. The
commonest misses: ornidazole, domperidone, ambroxol, serrapeptase, thiocolchicoside, etoricoxib,
levocetirizine + montelukast, aceclofenac + paracetamol, ofloxacin + ornidazole, pantoprazole + domperidone.

Sources, used in this order; each entry names its source and date on screen:

1. **Combination banner + approval status.** A combination with no reference of its own shows each
   component's entry and its CDSCO approval status as a fact. Wording: "No reference exists for this
   combination. Its parts are shown separately; they do not describe the combined dose."
2. **NHS Medicines A–Z** through its API (Open Government Licence v3; attribution line shown).
3. **EMA product information and referral restriction texts** (credit EMA).
4. **Medsafe New Zealand data sheets**, verbatim only (credit Medsafe; no summarising).
5. **LiverTox and LactMed sections** (public domain).
6. **National Formulary of India 2026** — only after the Indian Pharmacopoeia Commission's permission.
7. **Wikipedia** as a labelled last resort — needs the owner's separate yes.
8. **A CIMS India licence** for combinations and brands — on a quote.

Wording for any foreign source: "Reference from <source>, <country>, <date>. The product sold in India may
differ in strength, dose and approved use."

**Owner actions:** two emails — to the IPC for permission to use the National Formulary of India 2026, and to
CIMS India for a quote.

**Not permitted:** scraping Apollo, 1mg or Medindia; the BNF and Martindale need paid licences; the Indian
Pharmacopoeia is a quality-standards compendium, not a source of uses or side effects.

**Unverified:** whether the NHS API issues a key to an organisation outside the UK; the contents of NFI 2026
and the terms of NFI Online; MHRA and TGA reuse terms are unclear, so neither is used.

Stocked items without an exact label (count of stocked items):
- Nothing at all: diethylcarbamazine (3), carbimazole (3), flunarizine (2), domperidone (2), cloxacillin (2),
  ormeloxifene, teneligliptin, fusidic acid, framycetin, betahistine.
- Components only or in part: levocetirizine + montelukast (2); ambroxol + guaifenesin + levosalbutamol (2);
  ambroxol + guaifenesin; ofloxacin + ornidazole; domperidone + rabeprazole; domperidone + pantoprazole;
  dicycloverine + paracetamol; dicycloverine + mefenamic acid; aceclofenac + paracetamol; two antacid
  combinations; oral rehydration salts; two vitamin and iron combinations.

### 11b. Interactions layer 2 — DDInter, MAJOR only (owner 2026-10-07)

Facts, verified on the owner's file `/opt/hmis-context/cds-bundle/incoming/hmis_clinical_master-owner-2026-10-07.db`
(sha256 33bf5c5d…); the supplier independently confirmed the template finding:

- `clinical_knowledge`: 6 distinct profiles over 10,303 generics. Never shown, never used. 83% of
  `prescribing_defaults` read "1-0-1 (BD)".
- `ddi_interactions_master`: 236,834 pairs, source "DDInter 2.0 (CC BY-NC-SA 4.0)", 1,972 drugs — Major 39,482,
  Moderate 145,129, Minor 9,808, Unknown 42,415. Guidance text is 4 templates by level. Names are INN/US
  (acetaminophen). Nothing for domperidone, ornidazole, ambroxol, etoricoxib, aceclofenac, thiocolchicoside or
  drotaverine. 19% of our 3,283 substances match by exact name before mapping.
- `drug_disease_contraindications`: 15 hand-written rows (real).

**What is built (about 5 days; 1 migration)**
- Map DDInter names to our substances with the 337-entry Indian/INN → US synonym map and salt stripping;
  report the mapped share.
- Load **MAJOR pairs only** into a separate table. Never mixed into the 400 curated `formulary_interactions`.
  Curated always wins; a curated "no interaction" or lower severity is not overridden without review.
- `rx-precheck` shows it as a distinct class, "Reference interaction (DDInter)", with the source. An override
  needs a reason, as today. Its template guidance text is not shown as advice.
- Attribution and the share-alike notice are kept with the data.
- **Before switching on:** replay historical prescription lines and measure warnings per 100 prescriptions.
  If it would more than double the current rate, it goes to the owner first.
- A kill switch. Moderate, Minor and Unknown are NOT loaded.
- The 15 disease contraindication rows: compare with the existing drug–disease checks and propose the missing
  ones, with their stated mechanism, as a reviewed seed.

**Licence:** DDInter is CC BY-NC-SA 4.0. Treating a hospital's internal clinical use as non-commercial is the
owner's accepted judgement (decision 0052).

## 12. Measuring it

The weekly scorecard for the owner — corrections % (voice notes), unanswered % (Ask and search), accepted %
(suggestions) — plus three headline numbers: the share of issued medicines that were tapped, not typed; how
often the right answer was in the top three; hard-warning rate on tapped lines against typed lines.
Behind them: × per 100 shown; edited-after-tap per 100 taps; median minutes from consult start to issue;
top-1 diagnosis hit on TYPED-only diagnoses (the honest one); desk moved or referred per 100 routed; Jev's
unsure rate; overrides per 100 prescriptions; Watch + Reserve share and steroid share.
Getting worse — the top-3 hit falls more than 10 points in a week, or tapped lines out-warn typed ones — names
the surface in the digest. The scorecard also carries a spot-check sample of accepted suggestions and newly
live aliases. Thresholds in §7 are re-read after the first month's drift report.

## 13. What we will not build

A graph database · conversational memory · model-written clinical text · a random exploration slot ·
children's dose suggestions · scraping a third party's site without permission · embeddings before the
no-match log proves a gap · ranking by acceptance rate.

## 14. Kill switches

A server setting per surface (complaints, diagnosis, medicines, dose, tests, desk prior, desk vocabulary tail,
desk examples, aliases, the AI reviewer, Jev per use), changed without a deploy.

**Every learned change is versioned and audited, with a one-click rollback of any single change:** an alias, a
version of the desk's learned vocabulary tail, an example set, a hidden-suggestion state.

## 15. Where the two reviews differed, and what was chosen

| Point | First review | Second review | Chosen |
|---|---|---|---|
| Medicine key | diagnosis, else complaint set | diagnosis only (ICD-10 3-char, else text) | Second; complaint key only as the fallback when a visit has no diagnosis |
| Score | `log(1+E) × (a+1)/(a+d+2)` | `p̂ × max(0, 1 − d/3)`, never by acceptance rate | Second — simpler, and acceptance does not rank |
| Minimum counts | 3 / 5 / 8 | 5 / 10 / 20 and p̂ ≥ 0.15 | Second — the more conservative |
| Hide rule | d ≥ 3 and accept share < 25% | d ≥ 3; an accept resets d | Second |
| Ignored suggestion | counts for nothing | 0.3 of a dismissal when another item was issued for the slot | Second |
| Adult dose evidence | ≥ 3 identical lines in 180 days | modal line, n ≥ 5, share ≥ 60%, more refusals | Second — stricter |
| Children's dose | none in v1 | own line in the same weight band, n ≥ 5 | First for v1 (decision 0009); the second is the later option for the owner |
| Drug alias trust | ≥ 3 doctors, ≥ 10 taps | composition agreement, ≥ 3 doctors, ≥ 5 taps | Both: composition agreement AND ≥ 10 taps |
| Table names | `opd_*` | `cds_*`, `cds_rx_lines` at issue | Second |
| Precondition | normalise dose strings minimally | canonicalise dose and frequency first | Second — P0 |
| Desk labels | completed department, moves, referrals | completed-after-move or unsuggested pick; referral is a metric | Second |

## 16. Open

- The owner's yes on "no dose for a child" (decision 0050).
- Production coverage numbers (§10).
- A reviewed look-alike list (§6).
- Decision 0006's "proactive suggestions default OFF" per doctor: no server-side switch was found. If it is
  only a browser setting, these suggestions must honour a real per-doctor switch before they appear unasked.
- Whether sending masked complaint phrases to a text model for alias proposals is covered by the privacy
  assessment (decision 0048 lists text-model sorting as open). Medicine terms and catalogue rows carry no
  patient data.
- Summarising FDA label text for the phone (§11) — needs the owner's explicit ruling.
- Wikipedia as a last-resort drug reference (§11a) — needs the owner's separate yes.
- The IPC's permission and the CIMS quote (§11a) — the owner's two emails.
