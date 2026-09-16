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

## 3. T2 — ADOPTION (planned, next PR)

Written when built.

## 4. NAMED GAPS

- One substance maps to one moiety. A dual-active salt (ambroxol acefyllinate: ambroxol +
  acefylline) cannot be represented faithfully; it is its own moiety until the schema changes.
- Adopted moieties carry no drug class and no interaction pairs. That is the knowledge-base
  procurement in §1.
