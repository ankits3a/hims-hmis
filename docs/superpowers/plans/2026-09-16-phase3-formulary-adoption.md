# Phase 3 — the formulary: the prescribing verdict, and a mapping nobody is left waiting for (2026-09-16)

**Lane** `formulary` (`/opt/hmis-lanes/formulary/hmis`), cut from `origin/main` @ `7af21ae9`
(98 migrations). Opened by `/opt/hmis-context/handoffs/2026-09-16-PROMPT-formulary-phase3.md`.
The phase-2 doc (`2026-09-16-phase2-formulary-mapping-loop.md`) still holds except where §1 below
overturns it.

---

## 0. THE HANDOFF, RE-MEASURED

| claim | measured 2026-09-16 | verdict |
|---|---|---|
| `origin/main` is `7af21ae9` | `7af21ae9` | holds |
| 98 migrations, last `0097_formulary_mapping_loop` | 98, `0097_formulary_mapping_loop` | holds |
| lane branch reset to main, test DBs dropped | `lane/formulary` == `origin/main`; the harness recreates the DBs on first run | holds |
| dev DB: both tiers, 1,517 drafts, Paracetamol attested | 3,256 pending + 27 mapped; 568 / 475 / 474 drafts; 1,503 pending with a draft, 1,753 without | holds (production has one more pending: its Paracetamol is not attested) |
| `opd-consult.tsx` is edited by live lanes | the FD-31 hunks in `lane/desk-upcoming` and `lane/front-desk-fd25` are in `issuePrescription`'s authority block, already on main; no open PR edits `runRxChecks` or the notices panel | holds, and no collision |

---

## 1. OWNER RULING, 2026-09-16 (late): R1 IS OVERTURNED

The owner, directly, after phase 2 shipped:

> "do it on behalf of the Pharmacist for those 3,257 substances … do whatever is required to make
> sure there's nothing remains pending … don't keep this [the catalogue load] on hold … I or my
> staff isn't going to decide anything in this case. you need to do right and logical things on
> behalf of staff … use great indian hospital standards whenever in confusion."

Phase 2's R1 was taken under delegation ("the owner may overturn any of them"), and this overturns
it. **DECIDED under this ruling:**

1. **Every pending substance gets a decision.** Nobody reviews them one at a time first. The
   standard is the one Indian hospitals already follow for a drug master: the P&T committee adopts
   a reference source by resolution. Nobody signs each salt → moiety row. Here the reference is the
   national release's own "(as …)" statements, plus a model's drafts. Each model draft is checked by
   a second, independent model pass before it is adopted (maker-checker).
2. **Every record says what happened.** Each decision is recorded as *adopted under the owner's
   resolution*, with the owner's own account as the actor. It is **never** recorded as an
   attestation by a named pharmacist who did not make it: that would be a false clinical record.
   `attester_not_user` stays. The actor is a person, the owner, and the resolution is named on
   every row and event.
3. **Adopted decisions stay correctable.** A pharmacist can correct any of them later through the
   shipped correction path, with a reason, and every correction re-projects.
4. **The catalogue load is no longer held**, once the prescribing verdict (§2) is deployed. The
   verdict was the only reason for the hold.
5. **The open P&T questions are answered by the reference conventions** (RxNorm ingredient / dm+d
   VTM practice), and each answer's reasoning is kept with its draft:
   - **Mineral and inorganic salts** (sodium chloride, sodium bicarbonate, magnesium hydroxide,
     zinc oxide and the like) are **their own moiety**. The anion is part of the therapeutic
     identity, and RxNorm and dm+d both keep the compound as the ingredient.
   - **Enzymes, organisms and blood products** are mapped to themselves, or ruled unmappable when
     they are a grouper, a vehicle or an excipient.
   - **Dual-active salts** (ambroxol acefyllinate): the schema maps one substance to one moiety, so
     such a salt is its own moiety. The gap is named in §4. It is not designed around.

**Not answered by this ruling, and still the owner's (money and procurement):** a licensed
drug-interaction and drug-class knowledge base. Mapping every substance tells the checks what a
product *is*. It does not tell them what that moiety interacts with. Today only the 29 seeded
moieties carry classes and pairs.

---

## 2. T1 — THE PRESCRIBING VERDICT FOR A LINE CHECKED ONLY IN PART (phase-2 doc §3.4)

**The defect.** A product with an unreviewed component (a release entry: no drug class, no
interaction pairs) came back from `runRxChecks` exactly like a checked line: resolved, no hits.
The doctor's picker said "not yet reviewed by pharmacy". The check said nothing.

**As built.**
- `runRxChecks` returns `unreviewedLineIndexes`. These are resolved lines with a component nobody
  has reviewed, and the list is disjoint from `unresolvedLineIndexes`. `precheckPrescription` and
  `issuePrescription` return it, and `prescription.issued` records it (default `[]`, so older
  payloads still parse).
- **One question, one predicate.** `moiety.ts` gains `isReviewedComponent`: a component is
  reviewed when it is a moiety (`isMoiety`), **or** when it is the release entry of a substance
  someone has *mapped*. The second clause matters because the resolver names the moiety beside such
  an entry (`mappedMoieties`), so every check sees what it would see for the moiety.
  - Without the clause, a hand-composed product, a collision product (E2) and an allergy text
    would stay "unreviewed" forever after their substance was decided.
  - The doctor's `reviewed` flag, the census's `unreviewedActiveMedicines` and the verdict all ask
    it. `isMoiety` stays the attestation's *target* test, because a mapped entry is not a moiety.
- `opd` asks through `unreviewedSaltIds` (a bounded read in `reads.ts`, pinned in
  `index.test.ts`), and never spells the predicate.
- **The screen.**
  - The consult screen's soft-notice panel says "Line N: checked only in part…" in one sentence,
    whatever the number of lines.
  - The panel reads the value from the pre-check **and from the issue response**. The pre-check's
    answer is shown only when a hard warning pauses the issue, so otherwise the issue response is
    the doctor's only answer.
  - The sentence is not coverage-gated: it is the server saying what it could not see, not a guess.
  - An older server sends no field and gets no sentence.
- It gates nothing. The doctor is told, not asked.

**Pinned** in `test/formulary-mapping-safety.test.ts`, through the real `runRxChecks` and the real
issue path:
- pending, then mapped, then ruled unmappable;
- the picker, the census and the verdict agreeing product by product;
- a partly reviewed product;
- "its own moiety";
- the event payload.

The web test drives a failed pre-check, so the issue response is the only source.

**Mutants (8, each with a written prediction, all killed):**

| # | mutant | prediction | result |
|---|---|---|---|
| M1 | the verdict never matches | 5 tests fail | 5 |
| M2 | the predicate loses the mapped-entry clause | 2 tests fail | 2 |
| M3 | the picker keeps `isMoiety` | agreement test fails | 1 |
| M4 | any substance status counts | 5 tests fail | **4**: the issue test has no substance row, so dropping the status filter changes nothing there. Prediction wrong; mutant killed |
| M5 | the census keeps `isMoiety` | agreement test fails | 1 |
| M6 | the event omits the lines | issue test fails | 1 |
| M7 | an unresolved line counted as unreviewed | 2 tests fail | 2 |
| M8 | the screen ignores the issue response | web test fails | 1 |

**Named, not built.**
- `pharmacy/verify.ts` runs `runRxChecks` too. The field is there for the dispense screen, and
  that module's lane decides whether to show it.
- A *prior* prescription with an unreviewed component also makes the interaction check partial.
  The list covers this prescription's lines only.

---

## 3. T2 — ADOPTION, AS BUILT

**One act, by a person, through the two writers that already exist.**
- `adoptDecisions(tx, actor, resolution, items)` (`modules/formulary/adoption.ts`) runs each
  decision through `attestSubstance` or `ruleSubstanceUnmappable`. So the row lock, the
  projection, the events and every refusal still apply.
- The actor must be a person (`attester_not_user` is unchanged). The script requires the account
  to be active and to hold `formulary.manage`, which is the `pharmacy` role's grant (16a DD10). In
  production `admin` holds it.

**Provenance.**
- Migration `0098` adds `formulary_substances.adopted_under`: the resolution, on each adopted
  decision.
- `substance.mapped` and `substance.ruled_unmappable` carry `adoptedUnder`. It defaults to null, so
  earlier payloads still parse.
- A pharmacist's correction clears the mark, because the decision is then theirs.
- The worklist card reads "Mapped to X by Y. Adopted under R, not reviewed one by one."
- A check constraint keeps a pending row from carrying a mark.

**Ordering, and what it never does.**
- Unmappable rulings go first.
- A draft that names another substance's unreviewed release entry waits until that substance is
  decided in the same pass.
- If that substance is already mapped, its moiety is used and the redirect is reported.
- Anything else is refused by name. A leftover cycle is refused too.
- A decided substance is never overridden: it is reported as `alreadyDecided`.
- A file that names an sctid this release does not hold refuses the whole run.

**The script.** `scripts/adopt-substance-mappings.ts --decisions f --resolution r --as username
[--apply]`.
- The dry run performs the whole adoption inside one transaction, prints the report and rolls back.
  So its numbers are the numbers `--apply` will write.
- The report names the account and the resolution before anything else.

**Rehearsed** (provisional decisions file, dry runs):

| database | decisions | mapped | new moieties | own entry | unmappable | refused | products moved | pending after | time |
|---|---|---|---|---|---|---|---|---|---|
| production-shaped: release tier only, 29 seed moieties | 3,256 | 3,106 | 2,184 | 0 | 150 | 0 | 0 (no catalogue) | 1 (Paracetamol: attested on dev, pending in production) | 21 s |
| both tiers (`hmis_formulary_dev` copy, 103,383 products) | 3,256 | 3,106 | 425 | 1,758 | 150 | 0 | 68,845 (124 held back by E2 collisions) | 0 | 52 s |

**Mutants (9, each predicted, all killed):**
- a salt that waits is refused instead;
- `attestSubstance` drops the mark;
- a correction keeps the mark;
- decided substances are queued;
- a redirect goes unreported;
- agreement is always true;
- the worklist hides the mark;
- an unknown sctid is not refused;
- the unmappable event drops the mark.

The actor check at the top of `adoptDecisions` is deliberately not mutated. `attestSubstance`
refuses the same actor a line later and the transaction rolls back, so the mutant is equivalent in
effect.

### 3.1 How the decisions were made (out of git: `/opt/hmis-context/nrces-2026-09-drafts/phase3/`)

- **The house standard:** `CONVENTIONS.md`, rules 1 to 8: RxNorm IN and dm+d VTM practice, with
  IP/INN names.
- **Maker.**
  - 1,043 release drafts (the release's own "(as …)" statements) and phase 2's 474 model drafts,
    already on file.
  - Seven model agents drafted the 1,753 substances nobody had drafted: 1,603 moieties and
    150 unmappable. The unmappable ones are almost all class groupers with no product.
- **Checker.** Nine further agents independently re-decided every item and compared:
  - existing drafts: 1,454 agree, 49 disagree;
  - new drafts: the second-round results are in the decisions file's report.
  - Every disagreement carries a reason, and the checker's answer is the one adopted.
- **Checker results.** 1,454 of 1,503 existing drafts agreed and 49 disagreed; 1,722 of 1,753 new
  drafts agreed and 31 disagreed. The checker's answer is the one adopted.
- **Reconciliation.** One pass over all 2,188 names made 20 renames, each unifying one moiety under
  one name (hyoscine, phenobarbital, undecenoic acid, sodium nitroprusside, senna…). It also added
  4 overrides, bare groupers with no products ruled unmappable, and 24 cross-batch rulings
  (`reconcile.json`), for example:
  - liposomal forms map to the parent drug;
  - pegylated conjugates with their own INN stay their own;
  - a salt of salicylic acid maps to it whatever the cation;
  - a bare class is unmappable when every product carries a specific moiety.
- **The files.**
  - `decisions-final.json`: 3,257 decisions, 3,099 moieties under 2,169 names and 158 unmappable
    (md5 `9f998644798a3c438d5abc877ec96503`).
  - `agent-drafts-claude-opus-5-phase3.json`: the maker's 1,603 first answers, loaded as proposals
    so the P&T scorecard can measure the drafter (md5 `6ddb1b014941dd64e9b4da7586af8bf5`).

### 3.2 The production sequence, rehearsed end to end (`hmis_formulary_prodlike`)

The database was built the way production was:
- migrate, then `seed:roles` and `seed:formulary` (29 moieties);
- `import:nrces` under the actor `owner:nrces-load-2026-09-16`;
- the release drafts and phase 2's 474 model drafts;
- an owner-shaped account holding `admin` and `pharmacy`.

That gave 3,257 pending and 26 auto-linked, as production has. Then:

| step | result |
|---|---|
| phase-3 model drafts as proposals | 1,603 written |
| adoption, dry run | 3,099 mapped (2,149 new moieties) · 158 unmappable · **0 refused · 0 pending** · 3,004 agreed with the draft, 95 differed · 23 s |
| adoption, `--apply` | identical report; 3,125 mapped (26 + 3,099), 158 unmappable, every adopted row marked |
| `import-cds-catalogue --apply` | 103,383 products, 142,759 compositions, +1,527 release entries. The load placed 68,809 rows on 56,722 products onto the adopted moieties, and left 120 products on a release entry because a moiety is named twice (E2). 8 min 30 s |
| products still unreviewed | **5 of 103,383**. Each contains a component ruled unmappable: egg phospholipid (2), and one each for a bare "insulin", "interferon" and "prostaglandin". Their prescription lines say "checked only in part", which is true |

## 4. NAMED GAPS

- One substance maps to one moiety. A dual-active salt (ambroxol acefyllinate: ambroxol +
  acefylline) cannot be represented faithfully; it is its own moiety until the schema changes.
- Adopted moieties carry no drug class and no interaction pairs. That is the knowledge-base
  procurement in §1.
