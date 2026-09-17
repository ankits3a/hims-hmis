# P25 — the drug field finds what the doctor means, and the line says each thing once

Lane `drug-search`, branch `lane/drug-search`, cut from `origin/main` at `ab46a794`.

Owner's direction, 2026-09-17 evening: the Gemini prescription UI
(`exports/hmis_prescription_ui.html` in the Drive zip) and a screenshot of its Rx tab, with
*"clean drug listing better formatting"* and *"remove the duplicacy in sentence while autosuggesting
drugs"*. Stated priority: **UX is second only to making the OS agentic-AI ready.**

## Part 1 — SHIPPING HERE: the search finds what was typed

**The defect, measured on the real catalogue (`hmis_formulary_dev`, 103,383 products):**

    lower(brand_name) like '%para 500%'   ->  0 rows
    lower(brand_name) like '%par 5%'      ->  0 rows

Both of the owner's own examples returned **nothing**. The words are in "Paracetamol 500 mg oral
tablet"; the phrase is not, and the search was one substring. A doctor who types the molecule and
the strength — which is how a drug is said out loud — got an empty box and had to guess what the
field wanted instead.

**Fixed:** the query is now TOKENS, every one of which must match. The **longest** token is the
anchor and keeps the two indexed branches the UNION exists for; the rest filter the survivors.
Length rather than position, so `500 para` and `para 500` are the same request.

The other tokens deliberately do **not** see the catalogue code: `par 5` with the code in the
haystack returned "Paracetamol 100 mg" first, because its code is `D9225`. A bare digit matching a
code is noise dressed as a match. A doctor searching by code types the whole code, which is then the
longest token and is matched where codes belong.

Measured after: 142 ms on the real catalogue.

## Part 2 — SHIPPING HERE: the suggestion says each thing once

One real catalogue row rendered as:

    Paracetamol 500 mg oral tablet
    Paracetamol · 500 mg · D0230                        [Tablet]

The molecule, the strength and the form all repeated the title the doctor was already reading —
the owner's "duplicacy". The second line exists to say what the NAME does not, so a moiety already
in the name is dropped, a strength already in the name is dropped, and the form pill goes when the
name says the form. What survives is the code, and the moieties of a combination whose brand name
hides them — which is the case that line was written for:

    Augmentin 625                                       [Tablet]
    Amoxicillin + Clavulanic acid · 625 mg · D1680

Compared with spacing and punctuation squashed out, because `500mg` in a name and `500 mg` in a
column are one fact written two ways.

The placeholder now teaches the syntax the way the owner's UI does — and stops claiming a
three-letter floor, which was never true: the route answers from two.

## Part 3 — NOT BUILT HERE. The sig builder and the basket, and why they need a decision first

The screenshot shows a different screen from ours, and it is better in three ways:

1. **A tap-drawer instead of five inputs.** Pick a drug and get INDICATIONS → FREQUENCY
   (`1-0-1 (BD)`, `1-1-1 (TDS)`, `1-0-0 (OD)`, `SOS`) → TIMING (`After Food (PC)`, `Before Food
   (AC)`, `Empty Stomach`) → DURATION (3 / 5 / 7 / 14 days), each one tap, with a default already
   selected. Ours is a row of free-text and select inputs per line.
2. **A basket table with a shorthand line:** the name in bold, then `[228.5 mg/5ml | Syrup | D1680]`
   in monospace, then the sig, the duration, and Remove.
3. **Protocol items that are not catalogue rows** — ORS Pediatric, zinc, racecadotril, ondansetron,
   each carrying its own dose text and the code `CDS`.

**Why this is a separate phase and not a quiet edit here.** It replaces the prescribing surface a
doctor uses, and this lane has a written scar about exactly that: an approved design was once
overridden by the agent's own judgement. The owner has shown what they want, which is direction
rather than a signed artboard, and three questions have to be answered before code:

- **Where do the frequency, timing and duration DEFAULTS come from?** Gemini's HTML carries
  `defaults.common_indications` per drug. Ours has no such column. Curated per moiety? Per
  indication? Or a fixed four-by-three of presets with no per-drug intelligence (much cheaper, and
  most of the benefit)?
- **What are the `CDS` protocol items?** They are not in `formulary_medicines` and cannot be, since
  they carry no composition to check. A second list that the safety layer cannot see is exactly
  what the 2026-09-14 ruling ("one drug list, one safety layer") was against. They may need to be
  real catalogue rows with a protocol flag.
- ~~Does the tap-drawer replace the line inputs?~~ **DECIDED (owner delegated, 2026-09-17): it sits
  IN FRONT of them and writes into the same fields.** Picking a drug opens the drawer with a
  default already selected; each tap fills `frequency`, `instructions` (the timing) and
  `durationDays` on the line being written; Add commits and closes. The line's own inputs stay
  visible and editable afterwards.

  The reasoning, since this was delegated rather than dictated: the presets are an ACCELERATOR over
  the existing fields, not a replacement for them. That keeps `1-0-0 for 4 days` reachable by
  typing, keeps the data model and every safety check untouched (no migration, no new shape on the
  wire), and means a preset list that is missing a case costs a doctor nothing but a tap they did
  not take. A drawer that OWNED the sig would make the preset list a gate, and every gap in it a
  prescription somebody could not write.

  One trap to test for explicitly: this lane has a scar where *every* test drove a field through its
  accelerator, so the manual path was never exercised and broke unnoticed. The manual path gets its
  own tests here.

## Indian abbreviations — MEASURED, and mostly already there

The owner asked for Indian abbreviations and, separately, for no hallucination. Those two pull in
the same direction here, because the first draft of this section asserted that `pcm` could not work
and that a curated abbreviation book was needed. **That was written before the catalogue was
asked.** Measured on `hmis_formulary_dev` (103,383 products):

    dolo      149 products        pcm         6 products
    hcqs        2 products        pan 40      1 product        augmentin   8 products

The national release carries Indian brand names, and it spells forms in English (`Eye drops`,
`Solution for infusion`). So every one of the owner's own placeholder examples is answered by the
token search alone, with **no abbreviation book at all** — run against the real catalogue:

    par            → Paracetamol 1 g / 100 mg / 500 mg …                    (3 hits)
    para 500       → Paracetamol 500 mg capsule, suppository, effervescent  (3 hits)
    pcm inf        → PCM 1000mg (paracetamol) 1 g/100 ml solution for infusion
    prop eye       → Propcaine (proxymetacaine) 5 mg/mL eye drops
    D0478          → Acetaminophen solution for infusion                    (2 hits)
    dolo 650       → Dolo (paracetamol) 650 mg oral tablet
    amox clav 625  → amoxicillin 500 + clavulanate 125 brands

`pcm` works because six products are literally named `PCM (paracetamol) …`; `inf` and `eye` are
ordinary words in the form column. An abbreviation book would have duplicated, in curated data a
person has to maintain, what the release already ships.

**So the book shrinks to what is genuinely absent, and that is a much safer thing to build.** An
abbreviation is a mapping a doctor cannot see: if `MTX` resolves wrongly, the wrong drug is under
the cursor and nothing on screen says so. The rule for any entry that does get added:

- it EXPANDS the candidate set and never replaces or auto-picks;
- an ambiguous abbreviation returns every candidate, never a chosen one;
- the row always shows the real product name, so the doctor sees what they are taking;
- each entry names a moiety that exists here, checked at adoption the way P24's book is;
- entries are adopted under a resolution, with their source recorded — not invented by the agent.

**A second claim this doc retracts, and it was mine.** An earlier draft said oral rehydration salts
are "not in the catalogue at all — zero rows for `rehydration`". **Wrong, and the probe was the
reason:** the NRCeS generic is named by its formula, not by the word rehydration. It is there —

    D5230  Product containing precisely glucose 13.5 gram and potassium chloride 1.5 gram and
           sodium chloride 2.6 gram and sodium citrate 2.9 gram/1 sachet …

— together with the brands `Electral`, `Walyte`, `Rejulyte`, `Glenvita` and `Ajantas`. So `ors`
failing is a RANKING problem, not a data gap: `Orsodic-SP` and `Orsimox CV` merely contain the
letters, and the real sachet never reaches the top. A query that is a standalone token or an exact
brand should outrank an incidental substring. That is the next search change, and it is cheap.

An empty result is evidence about the SEARCH before it is evidence about the data — and here the
search was mine.

## Never adopt a code binding from a document — check it against THIS catalogue

The other model proposed binding the syndromic one-tap items to catalogue codes, which is the right
instinct (it is what "one drug list, one safety layer" demands). **Six of its eight bindings check
out against `hmis_formulary_dev`. Two do not, and one of those is dangerous:**

| proposed | what that code is HERE | |
|---|---|---|
| `D5230` WHO ORS sachet | the ORS formula row | ok |
| **`D5231` "WHO ORS sachet / Electral"** | **Hyoscine methylbromide 2.5 mg oral tablet** | **a different drug** |
| `D2197` zinc sulfate 20 mg/5 mL syrup | exactly that | ok |
| `D5845` racecadotril 15 mg sachet | exactly that | ok |
| `D3021` racecadotril 100 mg capsule | exactly that | ok |
| `D6461` ofloxacin 200 + ornidazole 500 | exactly that | ok |
| `D4392` ondansetron 4 mg orodispersible TABLET | orodispersible FILM | wrong form |
| **`D2364` ondansetron SYRUP 2 mg/5 mL** | **oromucosal SPRAY, 2 mg/actuation** | **wrong form** |

A paediatric diarrhoea bundle bound to `D5231` hands a child an anticholinergic antispasmodic
instead of rehydration salts — and hyoscine is in P24's own book as contraindicated in
angle-closure glaucoma and in benign prostatic hyperplasia. `D2364` pairs a "3.5 mL" dose with a
metered spray.

The two may simply be different releases: their SQLite export and this Postgres import can disagree
about which product a code names. That is exactly the point. **A code binding is a clinical claim,
and it is verified against the catalogue the doctor will actually be prescribing from, by a test
that fails when a code names something else.** Never by reading it off a document, whoever wrote it.

Any protocol-item work therefore ships with a binding test: for each item, the code must resolve,
and the resolved product's composition must contain the moieties the item claims.

**A claim this doc retracts.** An earlier draft called `amox clav 625` a ranking defect for putting
`Bjoclav-625 LB` above Augmentin. It is not a defect: those rows ARE amoxicillin 500 + clavulanate
125, and **Augmentin 625 does not exist in this catalogue** — its rows are DDS, DUO, ES and IV at
400, 875, 250, 600 and 1 g. Whether a better-known brand should outrank an obscure one is a real
question, but it was not measured, so it is not asserted.

## Verification for parts 1 and 2

- The owner's two examples are tests (S6, S8), and both were **proven red against the shipped
  search** before the fix — `git show HEAD~1:…` restored, suite run, three failures read.
- The code-only-match case is its own test (S8), because that is the false match the first draft
  produced on real data.
- Browser walk before this is called done.
