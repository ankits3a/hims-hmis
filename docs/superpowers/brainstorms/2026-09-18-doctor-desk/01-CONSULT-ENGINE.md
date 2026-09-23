# Doctor Desk, part 2: the consult engine

**This brainstorm restarts on 2026-09-23.** The owner unparked the Doctor Desk brainstorm after
comparing our consult screen with Healthray's doctor OPD: *"I feel it's not good enough and we are
falling behind a HIMS provider."*

This file is the consult-screen half of the Doctor Desk. `00-BRAINSTORM.md` is the other half: the
unit head's control tower, the ward round and the phone. The two meet at `OpdDesk.dc.html`, where
the OPD line is the screen.

**Status.** This is a brainstorm. Nothing here authorises code, a migration or a plan until the
owner approves the cut in §12. Measurements were taken at `origin/main` `3813a80c` on 2026-09-23.

**Reference material.** The 26 Healthray screenshots are at
`/opt/hmis-context/reference/2026-09-23-healthray-doctor-opd/`, outside git. They are the benchmark
for the non-AI basics of a doctor's desk. They are not the design target.

---

## 1. Owner rulings, 2026-09-23

1. **Who configures layouts: the admin and the doctor.** The admin sets each department's default
   layout. The doctor adjusts it for their own practice, inside what the admin allows.
2. **Specialty order: ophthalmology, then paediatrics, then gynaecology.** General medicine is the
   default profile that every other profile starts from.
3. **Coding:** ICD-10 is the primary code. An ICD-11 or SNOMED CT map comes later, for ABDM.
4. **Work-up before the doctor.** Eventually the optometrist, the antenatal nurse and the paediatric
   nurse each fill whole sections before the doctor sees the patient. **For now the work-up is
   vitals only.** There will be **a toggle to switch the work-up mode on and off** (§8).
5. **The Doctor Desk brainstorm is unparked.**
6. **Standing product frame, restated:** *"we are building Agentic AI based hospital operating
   system that will use AI agent as human copilot and so we have to design the software
   accordingly."*
7. **The owner's top priorities, in his words:** *"accuracy, speed, auditable, complaint* [meaning
   compliant] *and user experience of the dashboard."* Every design decision below is checked
   against these five (§10).

---

## 2. What the Healthray benchmark taught us

The Healthray consult screen is built from seven layers. Copying its screens without these layers
would give us the look without the capability.

| # | Layer | What Healthray does | Where we are today |
|---|---|---|---|
| 1 | **Catalogs** | Each section has a chip library that grows from what the doctor types. It also holds saved groups (`MB_*` chips) and a drug library and groups | Only complaint terms (`opd_complaint_terms` plus usage ranking), advice templates and the formulary |
| 2 | **Section definitions** | Each section has categories. Each category has a form type (vital sign, chip list or grid). Each chip carries **detail questions**; for example `FEVER (headache\|vomiting, Yes, 3d)` is a chip plus its answers | Hard-coded in `opd-consult.tsx`: complaint, diagnosis, advice, Rx |
| 3 | **Layout profile** | Sections can be ordered, shown or hidden, made expandable, printed or not, shown on the dashboard. Each section also has **SNOMED CT search** and **AI suggestion** toggles | Hard-coded. A new specialty is a code change |
| 4 | **Visit record** | Entries stored per section, read back on a Summary page with a count for each section | Complaint, diagnosis, Rx and advice columns on the encounter |
| 5 | **Longitudinal views** | Earlier visits load inline and can be printed or have documents uploaded; Previous RX; Patient Report (one section across a date range); vitals Graph | A History tab that is a list, and a vitals trend shown as text |
| 6 | **Output** | 30 print formats. Style for each label. Language choice. Hide header. WhatsApp, SMS and email. Send to the referring doctor | Server-side Rx print with a signed QR |
| 7 | **Actions out** | Admit, appointment, bill, send order, certificate, consent, vaccination, blood request, ABHA | Only an "admission advised" checkbox |

**Our real gap is layers 2 and 3.** Until those exist, every specialty screen costs a pass through
`opd-consult.tsx` (3,562 lines) and the shared files.

**Healthray weaknesses we will not copy:**
- **Unmoderated catalogs.** Junk chips sit in live libraries, for example "guuryjhfdkjhdujedfu",
  "hhjdghjdgshsds", "pagal" and "dgfgd".
- **Tests filed as diagnoses** ("Blood test", "Scalp biopsy").
- **Sections switched on by sex alone.** A 2-year-old girl gets Antenatal Sheet and Menstrual
  History tabs.
- **No prescribing safety check visible anywhere** on the Rx grid.

**Where we are already ahead:**
- The Rx safety checks: allergy, interaction, duplicate salt and drug–disease, each with an override
  reason.
- The queue engine: park, skip, held-for-payment.
- Complaint ranking learned from the doctor's own usage.
- A keyboard-first flow.

---

## 3. The model we build: sections as data, profiles as data

```
Catalog item   ── hospital master → department list → the doctor's own entries
     │            (curated)          (curators)        (private to the doctor until promoted)
     ▼
Section def    ── kind (chips | grid | eye-grid | vitals | table-per-visit | free note)
     │            items come from a catalog; each item carries detail questions
     │            coded? (ICD-10 / SNOMED / LOINC)  printable?  who may fill it (role)
     ▼
Profile        ── department default (admin) + doctor overlay (doctor, within the admin's bounds)
     │            which sections, in what order, collapsed or not, printed or not, which print format
     │            gates: sex, age band, pregnancy flag (not sex alone)
     ▼
Visit record   ── one entry per section item: value, detail answers,
                  author, source (tap | typed | template | group | agent-draft | work-up),
                  time, and what it supersedes
```

**DECIDED (planner, the owner may overturn):**
- **D1. A section definition is versioned.** A visit stores the version it was filled under, so a
  later layout change never rewrites how an old visit reads or prints. This serves audit.
- **D2. Gates use age band, sex and pregnancy flag together.** A menstrual history section needs
  female AND age ≥ 9 years. An antenatal section needs the pregnancy flag. Growth charts need age
  < 18 years.
- **D3. Coded sections stay coded.** A diagnosis chip must resolve to an ICD-10 code or be marked
  "uncoded", and uncoded is counted and shown to the curator. A test can never be entered as a
  diagnosis, because the investigation and diagnosis catalogs are separate kinds.
- **D4. The doctor's own catalog is private until promoted.** The doctor's typed items stay in
  their own list and appear on no one else's screen. A curator promotes them to the department
  list. Per the owner's ruling (§11), the curators are the department head, a medical-records
  officer and the admin. This is the fix for Healthray's junk chips. The curator screen already exists as a pattern
  in the formulary (a mapping proposal that a person signs).
- **D5. Groups and templates are catalog items too.** A group is a set of items within one section,
  for example a CBC+LFT profile or a "NAD" systemic exam. A full-visit template is a set of groups
  across sections, for example "Fracture calcaneum". Both come in three tiers: hospital,
  department and doctor.
- **D6. The existing consult keeps working throughout.** General medicine is re-built on the engine
  first and must be at least as fast and as safe as today before any specialty is added.

---

## 4. The copilot inside the engine

The engine is what makes the copilot possible. An agent can only draft into a section that has a
definition, and it can only choose items that exist in a catalog. This is the pattern `triage.ts`
already uses: the model gets **our** list and returns **indexes** into it, so it cannot invent an
item.

### 4.1 The ladder of cost (cheapest first; stop at the first confident answer)

| Step | Tool | Cost | Already in main |
|---|---|---|---|
| 1 | The doctor's own usage: most-used chips, last visit, Previous RX | a DB read | Complaint usage ranking (`complaint-ranker.ts`, `opd_complaint_term_usage`) |
| 2 | Deterministic matchers: keyword and IDF over our books | microseconds | `cds/matcher.ts` (complaint → syndrome), `complaint-ranker.ts` (IDF over 82 syndromes and 782 phrasings) |
| 3 | Rules from the clinical master: regimens, prescribing defaults, safety rules | a DB read | Regimens (`cds/regimen.ts`); interactions, drug–disease and allergy classes adopted into the formulary |
| 4 | **Jev (TypeSafe) as the decision model:** picks an index from our list, with a confidence score | about 300 ms | Adopted for the copilot router (#250) and triage (#252); `MIN_CONFIDENCE=0.6` |
| 5 | LLM, last and bounded: prose drafts (history of present illness, a referral letter), summarising old visits | seconds, and tokens | Groq as fallback; the scribe is built but returns 503 until a speech provider is configured |

**A correction the owner should have.** The owner remembers the complaint → diagnosis matrix as
*"mapped through vector embedding"*. What is in main is different. `complaint-ranker.ts` records
that the engine delivered with the bundle "scored character-trigram overlap and called it an
embedding". Measured, it could not read Devanagari and routed "mera mobile kho gaya" to Emergency
with no confidence floor. It was replaced by inverse-document-frequency token scoring, which is
explainable (the seat can name the word that decided it). **No vector embedding is in the
consult path today.** Adding a real embedding model is possible as step 2b, but only if it is
measured against the IDF scorer on our own complaints first.

### 4.2 Where the agent acts in the consult

- **Pre-fill before the doctor sits down.** From the work-up entries, the last visit, and the
  complaint matched to a syndrome, the agent suggests chips for the examination, a template and a
  regimen. Suggestions appear as **ghost chips**: one tap accepts, one key dismisses. The
  doctor-controlled "proactive" toggle already ruled for the doctor copilot governs this.
- **Draft, never sign.** An agent entry is stored with `source = agent-draft`. It does not count as
  the doctor's entry until the doctor accepts it. It is visible as a draft in the audit trail.
- **Each section's AI switch lives in the profile**, like Healthray's "Show AI Suggestion", so an
  admin can switch agent help off for a section (for example psychiatry notes).
- **The agent can also act on the desk**, not just answer questions. It can book the follow-up,
  send the order, or draft the certificate. Every act needs the doctor's one-tap confirmation and
  is audited. This follows the ruling that the desk copilot must act.

---

## 5. What the clinical data we hold can configure

| Asset | Where | What it configures in the consult |
|---|---|---|
| NRCES medicines: 10,303 generics and about 103k brands | `/opt/hmis-context/nrces-2026-09/`; formulary tables in main | Drug search, brand → generic, the composition line under the brand (as Healthray shows it) |
| `prescribing_defaults` (10,303 rows: frequency, food relation, default days, dispense quantity, indications) and `clinical_knowledge` (10,303 rows, 43 columns: direction of use, paediatric use, renal and hepatic adjustment, side effects, counselling, Beers criteria, LASA, ATC/DDD) | `hmis_clinical_master-2026-09-17.sql` | **The right columns, but the content is filled by drug class, not by drug. See §5.1 before using any of it** |
| `ddi_rules`, `cyp`, allergy cross-reactivity, drug–disease (ICD-10 contraindications) | Adopted into the formulary (P21, P21b, P22) | The existing safety checks |
| `amsp_antimicrobial_rules` (WHO AWaRe category, ICMR tier, maximum empirical days, mandatory culture order) | Clinical master | **Antimicrobial policy on the Rx line.** Healthray only links to a policy document; we can enforce it at the line, for example by warning on days over the limit |
| `pregnancy_trimester_matrix` | Clinical master | Gynaecology profile: a trimester-aware check when the pregnancy flag is on |
| `vitals_safety_rules`, `lab_diagnostic_rules` (LOINC cutoffs against conflicting drugs) | Clinical master | Checks that read vitals and lab results against the Rx. Example: a drug that raises BP when today's BP is high |
| `symptom_drug_mapping`, `clinical_syndromes_regimens` | Clinical master, partly in `cds/` | Complaint → syndrome → regimen suggestions |
| `dpco_jan_aushadhi_index`, NLEM 2022 (`scripts/data/nlem-2022.ts`), drug schedules (H, H1, X) | Clinical master; scripts | Cost and NLEM badge on the line; schedule rules on the print; the Jan Aushadhi alternative |
| ICD-10 catalogue (74k codes) | `cds/icd10.ts` | The diagnosis section |

### 5.1 The dose, frequency and instruction tables, measured (2026-09-23)

The owner pointed to the dose, frequency and instruction tables he supplied. I loaded
`/opt/hmis-context/cds-bundle/hmis_clinical_master-2026-09-17.sql` into SQLite and measured it.

**Every field is filled, and the columns are exactly the ones the consult needs.** Every column
is filled on all 10,303 generics. The schema is a good model for our own rule tables.

**But the content repeats a few class-level templates. It is not written for each drug:**

| Column (10,303 rows each) | Distinct values |
|---|---|
| `clinical_knowledge.pediatric_child_use` | **7** |
| `clinical_knowledge.direction_of_use` | 6 |
| `clinical_knowledge.renal_dose_adjustment` | 8 |
| `clinical_knowledge.common_side_effects` | 6 |
| `prescribing_defaults.default_frequency` | 7 |
| `prescribing_defaults.default_dispense_qty` | 9 |
| `prescribing_defaults.common_indications` | 8 |

**What the paediatric column actually holds:**
- **7,830 rows (76%)** hold one sentence: "Pediatric dosage must be determined strictly based on child
  age and body weight in consultation with a qualified pediatrician."
- **413 rows** hold the ibuprofen text ("Pediatric safe: 10–15 mg/kg… max 60 mg/kg/day"). That text
  is also on **codeine + paracetamol** and **oxycodone + paracetamol**. Codeine is contraindicated
  under 12 years. It is also on naproxen, diclofenac + metaxalone, and an ibuprofen IV infusion.
- **617 rows** hold the amoxicillin/azithromycin text. That text is also on vancomycin, cefazolin,
  penicillin G, cefotaxime and erythromycin, whose doses differ.
- **359 eye products** hold a text about diagnostic tonometry and a numbed cornea. That text
  describes a local anaesthetic. It is on **brimonidine** (contraindicated under 2 years),
  timolol, pilocarpine, gentamicin and ketorolac drops.

**The frequency defaults have the same problem.** Paracetamol suspension defaults to
"1-0-1 (BD) or SOS". For fever, paracetamol is given every 4 to 6 hours as needed, not twice a day.

**The syndrome regimens** (`clinical_syndromes_regimens.pediatric_regimen_json`) are written for a
single 14 kg child, for example "3.5 mL (for 14kg: 12.5 mg/kg)". They are examples, not rules that
scale with weight.

**What this means (D10, DECIDED on the owner's accuracy priority):**
- **Keep the schema; the content is a draft that must be reviewed.** No field from these two
  tables pre-fills an Rx line, a print or a warning as a fact until it has been reviewed for that
  drug.
- **Promotion is per drug and signed.** A curator (§11 item 2) and, for doses, the Pharmacy &
  Therapeutics committee (§11.1) promote a row. The row then records the reviewer, the date and the
  source.
- **Start with what is prescribed.** Review the ~300 starter-list generics
  (`scripts/data/pharmacy-starter-list.csv`) plus the drugs our doctors actually prescribe. That
  is a few hundred rows, not 10,303.
- **The agent can do the first pass** (the NRCES drafts of 2026-09-16 did this for mappings). An
  agent drafts the per-drug text with its source. A person signs. The agent never signs.
- **Unreviewed rows still help as prompts.** The generic paediatric sentence can show as "no
  reviewed paediatric dose — dose manually". It is honest, and it never looks like a dose.

**Gaps in the data for the specialty order the owner chose:**
- **Paediatrics:** the columns exist, but only 1,030 rows carry any mg/kg text, and those come from
  two class templates (above). A structured rule (mg/kg per dose and per day, maximum doses, age
  bands, available strengths for rounding) must be built per drug from the §11.1 sources, starting
  with the most-prescribed paediatric drugs. This is the largest data task across the three
  specialties.
- **Ophthalmology:** eye drop sigs (drops per eye, which eye, taper over weeks) do not fit the
  `1-0-1` grammar. The Rx line needs a **site** (right eye / left eye / both) and a **taper**
  (Healthray shows two dose lines for one drug).
- **Gynaecology:** the pregnancy matrix exists. The obstetric calculators (EDD, gestational age)
  are formulas, not data.

---

## 6. Specialty profiles, in the owner's order

Each profile is **general medicine plus or minus sections, a work-up split and print formats.** It
is data, per D6 and §3.

### 6.1 Ophthalmology (first)

- **Sections:**
  - Visual acuity (unaided, with glasses, pinhole, near, colour vision; right and left eye with
    copy across)
  - Auto-refraction (AR)
  - Current glasses power
  - Refraction and the final glasses prescription (sphere, cylinder, axis, add, for each eye)
  - Pupils
  - Slit-lamp examination by structure (lids, conjunctiva, cornea, anterior chamber, iris, lens)
  - Fundus
  - IOP (method: NCT or GAT)
  - A-scan and IOL power
  - Topography
- **The work-up split (when the toggle is on):** the optometrist fills VA, AR, current glasses and
  IOP. The doctor sees them as filled sections and does refraction, slit lamp, fundus, diagnosis
  and Rx.
- **Queue state:** "work-up done" becomes a state in the queue. The line goes optometrist → doctor.
- **Rx:** the eye drop line needs an eye site and a taper (§5).
- **Prints:** the spectacle prescription is its own print; the surgery and IOL advice is another.
- **Chips:** eye diagnoses in ICD-10 H00–H59 carry a **laterality** detail question.

### 6.2 Paediatrics (second)

- **Age** shown in years, months and days.
- **Weight-based dosing** on the Rx line (§5 gap). The weight comes from today's vitals, and a
  stale weight is flagged.
- **Growth:** weight, length or height, head circumference and BMI plotted on WHO charts (under 5)
  and IAP charts (5–18), as percentile and z-score.
- **Immunisation:** the IAP schedule, with due and overdue items and "given today". A vaccination
  card print.
- **History sections:** birth history (gestation, birth weight, NICU stay), developmental
  milestones, feeding.
- **The informant is recorded:** the history comes from a parent or guardian, so the record says
  who gave it.
- **Work-up split:** the paediatric nurse fills anthropometry, vaccination status and possibly
  milestones.

### 6.3 Gynaecology and obstetrics (third)

- **Obstetric score** (G P L A). **LMP → EDD and gestational age**, calculated. A pregnancy flag on
  the banner. High-risk flags.
- **Antenatal sheet:** one row per visit (weight, BP, fundal height, FHS, presentation, oedema, Hb,
  urine), shown as a running table across visits.
- **Other history:** menstrual history (cycle, flow, LMP, dysmenorrhoea), post-natal, contraception.
- **USG findings.** The **PCPNDT Form F link** comes from the existing `pcpndt` module. This is law,
  and a Form F obligation cannot be skipped.
- **The trimester-aware prescribing check** (§5).
- **Work-up split:** the antenatal nurse fills the vitals row of the antenatal sheet.

---

## 7. General medicine rebuilt on the engine (the base every profile extends)

**Sections:**
- Complaints, with duration, severity and detail questions
- History of present illness (a note, and the agent may draft it)
- Past medical and surgical history
- Family history
- Personal history (smoking, alcohol, diet, sleep)
- Current medications
- Allergies (as today)
- Vitals (read from the bay; the doctor may add a reading)
- General examination
- Systemic examination
- Local examination
- Provisional and final diagnosis (ICD-10)
- Investigations (lab, radiology and ECG, with order sets)
- Procedures
- Rx
- Advice (general and dietary)
- Follow-up (a date, with booking)
- Referral (internal to a department or doctor, or external)
- Notes (§7.1)

**Longitudinal views:**
- **Summary.** This visit read back, with a count for each section.
- **Previous consultations inline.** Each earlier visit in full, collapsible. It can be copied into
  today by section or whole, printed again, or have documents attached.
- **Previous RX.** Copies the last Rx into today, line by line, and **the safety checks run again**
  on every copied line.
- **Section report.** One section across a date range.
- **Vitals graph.**

**Calculators:** BMI, BSA, eGFR (CKD-EPI 2021), waist–hip ratio, and a diabetes risk score. Each
shows its formula and inputs, so the result can be audited.

**Actions menu:**
- Certificate (medical, fitness)
- Consent form
- Vaccination
- Admission request (links to the IPD workflow when IPD exists)
- Blood request
- ABHA create or link
- Label print
- Payment history (read-only)

### 7.1 Notes: five kinds, each with an audience and a lifetime

| Note | Audience | Lifetime | Printed |
|---|---|---|---|
| Detail on an item (for example "Detailed information of NORMAL") | The clinical record | This visit | Yes, as a qualifier |
| Doctor's note | The clinical record | This visit | Profile setting, off by default |
| Internal comment | Staff and the next doctor | This visit | Never |
| **Patient reminder** (sticky) | Everyone who opens this patient | **Across visits**, until resolved | Never |
| Allergy | Everyone, on the banner | Permanent (entered-in-error strike, as today) | Yes |

**D7. Every note records its author and time and is append-only.** An edit supersedes; it never
overwrites. The sealed-record model and the `permission_denied` rules apply as they do today.

---

## 8. The work-up mode toggle

- **What it does.** When off (today), the work-up seat fills only vitals, as the vitals bay does
  now. When on, the work-up role for that department fills the sections its profile assigns to it
  (optometrist, antenatal nurse or paediatric nurse), and the queue line gains a "work-up done"
  state before the doctor.
- **D8. Where it lives.** The toggle is **per department, set by the admin**, not per doctor. The
  reason is that it changes staff flow and queue states for everyone in that department. A doctor
  sees the setting but cannot flip it.
- **D9. It is audited like any configuration change.** Who changed it, when, from what to what.
  The change applies to new visits only. A visit already in work-up finishes under the mode it
  started in.
- **Off must be exactly today's behaviour.** A test pins this before the toggle ships.

---

## 9. Output: print and share

- **One server-side print engine**, per the existing printing ruling, with a **print format per
  profile**: Rx, spectacle prescription, ANC card, vaccination card, investigation slip,
  certificate. Label style (font, bold, visibility, uppercase) is set per section in the profile,
  as Healthray does.
- **Print options:** language (English and Hindi only — owner ruling), hide header and footer (for pre-printed
  pads), hide patient details.
- **Share:** WhatsApp, SMS, email, and send to the referring doctor. The WhatsApp rail already
  carries lab reports (`reach`). Sharing requires the patient's consent on record (DPDP Act 2023),
  and every send is logged with its channel and recipient.
- **Prescription content required by law and regulation:**
  - generic name printed legibly (NMC 2023 prescribing guidance)
  - the doctor's registration number
  - Schedule H, H1 and X marks where they apply
  - for teleconsult, the Telemedicine Practice Guidelines 2020 drug lists (List O, A and B) limit
    what can be prescribed, and the Rx grid must enforce that on a teleconsult visit

---

## 10. The owner's five priorities as design tests

| Priority | Test each deliverable must pass |
|---|---|
| **Accuracy** | Coded fields stay coded (D3). Catalogs are curated (D4). Every calculator shows its formula. Safety checks re-run on copied and templated lines. Agent output is picked from our lists, never free-generated into a coded field |
| **Speed** | A routine follow-up visit completed with a template or Previous RX in **under 60 seconds** and **under 15 taps**. A chip search answers in under 100 ms. The keyboard path covers every section. The LLM is never on the critical path of a tap |
| **Auditable** | Every entry records author, source (tap, typed, template, group, agent-draft, work-up), time and what it supersedes. Section definitions and profiles are versioned (D1). Configuration changes are audited (D9) |
| **Compliant** | ICD-10 now, with a map to ICD-11 or SNOMED for the ABDM OPConsultation record later. PCPNDT Form F on obstetric USG. NMC and Drugs & Cosmetics Rules content on the Rx. Telemedicine lists on teleconsult. DPDP consent before any share |
| **User experience of the dashboard** | The live summary strip at the top (the whole visit at a glance, as Healthray has). Ghost chips from the agent. Nothing modal in the main path. The Doctor Desk dashboard (`00-BRAINSTORM.md`) and the consult share one visual system |

---

## 11. Owner rulings on the open questions (2026-09-23, second round)

1. **Doctor overlay limits: RULED.** A doctor cannot hide a section that the admin marked
   mandatory. The doctor may only reorder or collapse it.
2. **Catalog curation: RULED.** Three roles curate: the department head, a medical-records officer
   and the admin. **A doctor's own entries are private.** They can be used on that doctor's screen
   only and are never shown to another doctor until one of the three curators promotes them to the
   department list (D4). *(The owner's sentence reads "it will reflect in other's until one of them
   promotes them". It is read here as "will NOT reflect", because the purpose he states is keeping
   junk out. Confirm at the canvas.)* Every promotion records who promoted, when, and from which
   doctor's entry.
3. **Paediatric dosing source: RULED "follow what top hospital standards are".** See §11.1.
4. **Print languages: RULED.** English and Hindi only.
5. **Teleconsult: RULED in scope.** Legal limits apply, following the standards of top hospitals.
   See §11.2.

### 11.1 Paediatric dosing — DECIDED on the standard practice of Indian corporate hospitals

These decisions follow what Indian corporate hospitals do, and what NABH asks for in its standards
on the management of medication.

- **The hospital formulary is approved by a Pharmacy & Therapeutics (Drugs & Therapeutics)
  committee.** A paediatric dose rule enters the system only through that committee's sign-off. In
  the system, that sign-off is a named approver on each rule, with a date and a version.
- **Sources, in order of precedence:**
  1. **IAP Drug Formulary** (Indian Academy of Pediatrics). It is the Indian primary reference.
  2. **BNF for Children** as the cross-check where IAP is silent.
  3. The **Harriet Lane Handbook** or the **Lexicomp Pediatric & Neonatal Dosage Handbook** for
     neonatal and special cases.
  4. Every rule cites its source and page or edition.
- **A rule holds:**
  - dose per kg per dose, and per day
  - frequency
  - **maximum single dose and maximum daily dose**, never exceeding the adult dose
  - age bands (neonate / infant / child / adolescent)
  - the available strengths, so the dose is rounded to a measurable syrup volume or tablet fraction
  - renal adjustment where it applies
- **The weight used is today's measured weight.** A weight older than the rule's allowed age (for
  example 30 days for an infant) forces a re-weigh or an explicit override with a reason.
- **An override above the maximum is a hard stop with a reason and a second signature**, the same
  pattern as today's interaction override.
- **Licensing.** The IAP formulary, BNFc and Lexicomp are copyrighted. The rule set is built by
  doctors transcribing into our own table with a source citation, or through a licence. **A licence
  is money, so it is an owner ruling.** It is left open until the canvas.

### 11.2 Teleconsult — DECIDED on the Telemedicine Practice Guidelines 2020 and the practice of top hospitals

The Telemedicine Practice Guidelines of 2020 were issued by the Board of Governors in supersession
of the Medical Council of India and are now held under the NMC. Large hospital teleconsult services
follow them.

- **Identity.** The doctor's name and registration number are shown to the patient and printed on
  every Rx. The patient's identity is verified and recorded (name, age, and an ID or ABHA). For a
  minor, the guardian's identity is recorded too.
- **Consent.** If the patient starts the teleconsult, consent is implied. If the hospital or doctor
  starts it, explicit consent is recorded. Either way, the consent is stored on the visit.
- **Mode is recorded:** video, audio or text. It controls what may be prescribed.
- **Drug lists are enforced on the Rx grid for teleconsult visits:**
  - **List O:** over-the-counter medicines and similar. Allowed in any mode.
  - **List A:** medicines safe on a first consult. Allowed on a **video** first consult, and as a
    re-fill on follow-up.
  - **List B:** add-on medicines. Allowed only on a follow-up for a condition already diagnosed
    in person.
  - **Prohibited list:** Schedule X drugs and NDPS narcotic and psychotropic drugs. These can never
    be prescribed by teleconsult.

  Each formulary item carries its telemedicine list. An unlisted drug on a teleconsult is blocked
  with a reason. This must be checked against the formulary's drug schedules
  (`scripts/data/drug-schedules.ts`).
- **First consult or follow-up** is derived from the patient's history with this doctor. It is not
  typed.
- **Emergencies.** The teleconsult screen always offers "advise in-person or emergency visit".
  Using it ends the teleconsult with a referral record.
- **Records.** The teleconsult is kept in the patient's record like any visit (the guidelines ask
  for at least 3 years). It includes the mode, the consent and a copy of the Rx sent.
- **Sending the Rx** uses the share rail of §9, with consent under the DPDP Act, and each send is
  logged.
- **The same engine serves it.** Teleconsult is a visit mode, not a separate screen. The profile
  hides sections that need a physical examination, or marks them "not examined (teleconsult)".

---

## 12. The cut, when approved (proposal only)

| Step | Deliverable | Shared files it touches |
|---|---|---|
| **C0** | Engine: section definitions, catalogs in three tiers, profiles (department plus doctor), a versioned visit-entry store with audit. General medicine re-platformed. Summary page and previous consultations inline. Previous RX. Rx pre-fill from REVIEWED rows only (§5.1) | Schema, one migration, `router.tsx`, locales, and `opd` (which many modules import) |
| **C1** | Groups and full-visit templates; the catalog curator screen; the live summary strip; calculators | the `opd` module |
| **C2** | Ophthalmology profile, the eye-site and taper Rx line, the spectacle print | a migration |
| **C3** | The work-up mode toggle with the optometrist seat (the first use of the toggle) | the queue states in `opd` |
| **C4** | Paediatrics: weight-based dosing rules (after the owner answers question 3), growth charts, IAP immunisation | a migration; data |
| **C5** | Gynaecology: obstetric calculators, antenatal sheet, the PCPNDT link, the trimester check | `pcpndt` via its index |
| **C6** | Share (WhatsApp, SMS, email) with consent; the actions menu; the ICD-11 / SNOMED map | `reach`; a migration |

C0 is the risky step. It moves the doctor's live screen onto a new store, so it ships behind a
switch for each department, with the old path kept until general medicine is proved equal.

**The next step, before any plan:** canvas boards of the consult engine, which the owner rules on
by comment, as for Desk One and the Tower:
1. general medicine consult
2. ophthalmology
3. the profile builder (admin view and doctor overlay)
4. the catalog curator
5. the work-up toggle
6. the print and share dialog
