# The doctor's copilot — brainstorm record

**Date:** 2026-09-17 · **Lane:** `copilot` · **Status:** brainstorm, three owner rulings recorded,
one question delegated back and DECIDED here.

---

## 0. What this document is

The owner restated the product thesis: *"agentic AI hospital operating system where AI agents are a
copilot to human users… each user will have a co-pilot. We have just got a little use case of front
desk."* The front-desk copilot shipped on lane `copilot` (`POST /copilot/ask`, seven commits). This
record is the second seat.

It is a brainstorm, not a phase document. It records what was **measured** about the doctor's seat
this session, what should be built and in what order, the three rulings the owner gave, and the
decisions taken under the standing rule that anything outside money, procurement and law is decided
by picking the standard Indian-corporate-hospital answer and marking it DECIDED.

---

## 1. Where the house is (measured this session, not remembered)

### 1.1 The doctor already has a copilot — inside the prescription form

This was the surprise, and it inverts the obvious plan. `modules/cds/**` is a deterministic clinical
library that already does:

- **complaint → syndrome**, `rankSyndromes(complaint, limit)` (`cds/matcher.ts:40`), whole-word
  sequence matching, stable tie-break.
- **syndrome → regimen**, `buildRegimen(syndromeKey, facts)` (`cds/regimen.ts:170`).
- **weight-aware dose checking**, `doseFor(...)` (`cds/regimen.ts:77`) returning a SIX-way verdict —
  `computed` | `blocked{safeAlternatives}` | `fixed` | `advice_only` | `needs_review` | `no_weight`.
  A dose engine that can say *"I do not know"* is rarer than one that can compute.
- **guardrail cards**, `cardsFor(...)` (`cds/guardrails.ts:59`) — allergy, pediatric, pregnancy,
  pregnancy-unknown, G6PD, QTc, stewardship — each carrying `ruleKeys` as provenance under the
  comment *"a card with no provenance is an opinion"* (`:34`).
- **ICD-10 typeahead** over 74,044 assignable codes of 97,296 (`cds/icd10.ts:24–29`).
- **prescribing safety**, `runRxChecks(...)` (`modules/opd/prescriptions.ts:144`) — one read block
  called by BOTH the pre-check route and issue, deliberately, so the two can never disagree.

And `cds/matcher.ts:6–17` already carries the owner's own law for this seat: *"I wanted AI co-pilot
to assist the doctor as much as it can with LOW help from LLM"* — the model is a **tie-breaker over
this function's output, never a source**.

**The doctor's seat is not short of clinical intelligence.**

### 1.2 What it does not have is REACH

`opd-consult.tsx` is 3,102 lines and its F2 dock (`:1285–1331`) is five regexes over a `useRef`
snapshot of screen state, with **no model, no network, no server call**. Everything the CDS knows
lives inside the prescription form. Ask the dock anything not on screen and it says it cannot.

That is the same gap the front desk had, and it is the gap this seat should close — not smarter
medicine, **reach**.

### 1.3 Nothing chases the doctor

There is **no doctor-scoped "what is waiting on me" reader anywhere**. Every underlying row and
permission exists; nothing composes them:

| waiting on the doctor | where it lives | why they never see it |
|---|---|---|
| pending Rx drafts | `prescription-drafts.ts:69` `getPendingDraft` | keyed by **encounter, not doctor** — found only by reopening that patient |
| parked consultations | `consultation.ts:297` | surface only inside their own queue view, never across days |
| published imaging reports gone unread | `radiology/chasers.ts:172` `sweepUnreadWatchman` | the sweep DETECTS it, stamps `unread_chased_at`, emits an event — **and there is no inbox for it to land in** |
| open lab criticals | `lab/criticals.ts:288` `openCriticalCalls` | the doctor is the callee of the escalation ladder; no route answers "criticals waiting on me" |

The system already knows a report went unread. It has nobody to tell.

### 1.4 The seat is EMPTY — the fact that shapes the whole plan

Measured in production 2026-09-17: 24 OPD doctors provisioned that morning;
**`opd_encounter_diagnoses` = 1 row.** Essentially no doctor has ever completed a consultation in
HMIS.

This is `readers-without-writers` at the product level, and it changes the brief. The front-desk
copilot accelerated a seat people already sit in. Here there is no usage to accelerate. If the
copilot is designed for the consult screen as an *ornament*, it decorates a screen the doctor walks
past on the way to the prescription pad.

**So the question this seat must answer is not "what can AI do for a doctor". It is: what makes the
screen faster than paper for a doctor seeing 60 patients before lunch — and which of that is a
copilot's job?** Some of the answer is not AI at all. Much of it is, because the bottleneck is
*typing*, and typing is what a copilot removes.

---

## 2. Three modes, and mixing them is the entire risk

The clerk's copilot did one thing: look up a fact. The doctor's does three, carrying completely
different risk, and the design must keep them apart.

1. **Retrieval** — "what did I give her last time?", *"uski sugar report aa gayi?"*. Existing
   readers, existing permissions. **No new risk.**
2. **Vigilance** — the four prescribing-safety axes, all deterministic and all already built:
   drug×drug (P21/P21b, 387 pairs), drug×allergy (P22), duplicate class (P23), drug×disease (P24,
   PR #236). The copilot's job is **timing and delivery, not invention**.
3. **Drafting** — clinical text a human signs. The only mode where a model produces something a
   patient is affected by. Requires the provenance stamp Plan 12a already specifies (model id,
   prompt version, input hash, output hash) and the owner's opt-in (§4.1).

**The minutes are in modes 1 and 2. The excitement is in mode 3.** Those are not the same list and
the plan should not pretend otherwise.

---

## 3. The slice — recommendation

### v0 — reach, and the pile nobody sees (no model at all)

1. `pendingForDoctor` — the union in §1.3. One reader, zero model. Makes *"mere paas kya pending
   hai?"* answerable for the first time.
2. The consult dock's five regexes replaced by `useCopilot` — the shape already shipped for the
   front desk.
3. Doctor-seat tools on `opd`'s existing `copilotTools` manifest entry: patient history, last
   prescription, this visit's results, allergies, **test prices at the chair**.

### v1 — the two toggles, and "same as last time"

4. The proactive/ask-only toggle and the drafting toggle (§4.1, §4.2).
5. The pre-read, shown on patient-open when proactive is on.
6. "Same as last time" → a **draft**, re-checked against today (§4.6).
7. One verdict instead of four streams (§4.4, §4.5).

### v2 — drafting, gated on law rather than engineering

8. Transcript → structured note as a **proposal with provenance**, following `drafter.ts`'s pattern
   of refusing a proposal rather than overriding it. Blocked on the DPIA revision, not on code
   (§4.7).

---

## 4. Design

### 4.1 The two toggles — OWNER RULED 2026-09-17

> *"it's the choice of the doctor to disable/enable the toggle to switch between Proactive or
> ask-only."*
>
> *"only if the doctor has enable the copilot to draft clinical prose only then it will draft
> (confirmation/submition will always be from doctor side), else it will only retrieve, check and
> structure."*

Two independent per-doctor switches:

| toggle | off (default) | on |
|---|---|---|
| `proactive` | the copilot speaks only when asked — F2, exactly like the front desk | it may offer the pre-read and the pending pile unasked, on patient-open |
| `draftProse` | retrieve, check and structure ONLY — no generated clinical sentence, ever | it may draft prose **as a proposal**; the doctor confirms and submits, always |

**Both default OFF.** A copilot that starts talking on day one is a copilot that gets switched off
permanently on day two, and a seat with no usage (§1.4) cannot afford that first impression.

**"Confirmation/submission will always be from the doctor side" is absolute and is not itself a
toggle.** There is no setting that lets the copilot commit clinical state. This matches what the
kernel already enforces — `orders/place.ts:254` and `orders/advance.ts:269` refuse agent actors
under *"THE LLM NARRATES AND NEVER ORIGINATES"* — and what the front-desk copilot already does:
it runs as the asking user and writes nothing.

### 4.2 Where the toggles live — **DECIDED: server-side, per user, and the prose one is EVENTED**

Measured: **there is no per-user server-side preference store.** The only existing preference —
language — lives in `localStorage` (`apps/web/src/lib/i18n.ts:10,35`).

`localStorage` is the wrong home for these, and for the drafting toggle it is disqualifying:

- It is **per-device**. A doctor on the consulting-room desktop and the ward tablet would get two
  different answers about whether a model may write their notes.
- It can throw or return empty (private window, blocked site data), so the fail state is undefined
  exactly where it must be defined.
- Above all: **an audit must be able to answer "was the copilot permitted to draft on the day this
  note was signed?"** A browser-local flag cannot answer that. Anything that governs what a signed
  clinical document may contain is a **governed setting, not a preference** — which is the standard
  hospital answer and the one this repo already takes everywhere else.

So: a small per-user settings row, server-side. **Turning `draftProse` on or off appends an event**
(it changes what a clinical document may contain). `proactive` is pure UX and needs no event, but
lives in the same place so there is one home rather than two.

### 4.3 `pendingForDoctor` — the highest-value tool, and it has no model in it

One reader unioning the four rows in §1.3, all of which the doctor already holds permission for:
pending drafts on my encounters, parked consults, published-but-unread imaging reports where I am
the referrer (`radiology.reports.read` — held), verified lab results on my encounters
(`lab.results.read` — held), open criticals where I am the callee.

Note the permission asymmetries that must be respected rather than widened:
`radiology.worklist.read` is **deliberately not held** (`seed-roles.ts:284–287`: the doctor reads
the report of the patient in front of them, never browses the department's queue), and
`lab.reports.print` is not held either. The union must be built from what the doctor holds, not by
granting more.

### 4.4 One verdict, not four streams

Four independent notice streams is how alert fatigue starts, and after that doctors click through
all four. `runRxChecks` already returns allergy + interaction + duplicate in ONE block; P24 adds the
fourth axis. The copilot answers once.

**It may never say "safe".** It says **"nothing flagged"** — a materially smaller claim. A copilot
that says "safe" has made a clinical judgement; one that says "nothing flagged" has reported on a
check that ran. The distinction is the difference between a tool and a liability, and it belongs in
the answer key's own text, not in a convention somebody remembers.

### 4.5 The two drug-disease engines — **DECIDED (owner delegated)**

The owner was asked which is authoritative and answered: *"I don't have answer… follow what seems
logical to you and fallback to what great hospitals"* do. Decided here under the standing rule.

**They are not competing engines and neither is authoritative, because they key off different
inputs:**

- `cds/guardrails.ts` keys off **physiological state the record may not hold** — pregnancy asserted
  at the chair, G6PD, age/weight band — plus stewardship policy. It exists in that shape precisely
  *because* the hospital records no structured problem list (`guardrails.ts:14`).
- P24 keys off **coded diagnoses in the record** — ICD-10 prefixes, 27 rules over 19 prefixes, 148
  rows over 56 moieties.

A pregnant patient with no `O`/`Z33` code on file is invisible to P24 and caught by guardrails. A
patient with `N18` CKD and no asserted condition is the reverse. **Suppressing either loses real
hazards, so the union is correct.** The real problem is not authority, it is double-reporting and
severity disagreement. Four rules, which are the standard CDS conventions:

1. **Deduplicate by `(moiety, hazard class)`, never by rule id.** Two rules naming the same hazard
   for the same drug are one alert.
2. **On collision, severity is the MAXIMUM.** Fail-safe: a moderate from one engine and a severe
   from the other presents as severe. Never averaged, never "most recent wins".
3. **Both provenances are cited.** `guardrails.ts` already holds that a card with no provenance is
   an opinion; a merged card carrying one of its two sources is half an opinion.
4. **Freshness modulates confidence, never severity.** P24's D2 (a diagnosis over 365 days old is
   downgraded to a notice) stays as-is *within P24* — nothing retires a diagnosis, so gating for
   ever would let one mistyped code block a patient for life. But it must never downgrade a
   guardrail card that fired on a fact asserted **today**.

**And the trap that is already known:** P24's own ruling D6 exists because `I50` offers carvedilol,
which `J45` forbids — so every alternative offered is re-run through `runRxChecks` for that patient
before it is shown. **That rule must apply to the MERGED output**, not only to the engine that
proposed the alternative. An offer checked by half the checker is the adjacent-property defect.

### 4.6 "Same as last time"

Roughly two in five OPD attendances are follow-ups whose answer is the previous prescription.
`patientRxHistory` (`opd/history.ts:89`) has it; `saveDraft` stages it; `runRxChecks` re-runs it
against **today's** state — a new allergy, a new diagnosis, a newly interacting drug, a changed
weight band.

Nothing new is needed for the safety story: `prescription-drafts.ts:14–38` already states the
draft-then-confirm doctrine, and `issueDraft` calls the shipped `issuePrescription` **with the
doctor as actor**, so every gate runs. This is the owner's approved "prepare, human commits" shape
already implemented — the copilot only has to reach it.

### 4.7 The scribe is built and switched off

`consult-scribe.tsx` (208 lines) is complete and inert, and it is careful work: push-to-hold only
(never a toggle), a hard 15-second cap, audio discarded on success *and* failure, nothing persisted,
a 503 rendered as a sentence rather than an error, and the transcript delivered as a **suggestion**
with Insert/Discard rather than an edit.

It is blocked by `VOICE_SEARCH_ENABLED = false` (`apps/web/src/lib/voice-flag.ts:27`), gated on a
**DPIA revision** (voice audio is Class 2) and measured Hinglish accuracy. So v2 — transcript →
structured note — is gated on **law and measurement, not engineering**. The most exciting item on
the list is not an engineering question, and the plan should stop pretending otherwise.

When it is unblocked, the pattern to follow already exists: `radiology/drafter.ts` carries a
mandatory `provenance{drafter, version, inputs, at}` and `proposalLockoutHits` **refuses** a
proposal rather than overriding it.

### 4.8 Permissions — **DECIDED: ride `opd.consult`, mint nothing**

`opd.consult` IS the prescribing surface and the grant the CDS routes already ride;
`modules/cds/index.ts:1–7` and `opd-cds.controller.ts:20–28` both say a second permission would be
"a second name for the same thing". A new string also drags in README prose and a change to
`seed-roles.test.ts`'s pinned census. The doctor's 21 grants are sufficient for everything in v0 and
v1.

### 4.9 The one-action constraint may not survive this seat

`AgentDock` supports exactly ONE optional action button, and its rationale (`agent-dock.tsx:40–54`)
was written for a bar with no model and nothing to do: *"a row of actions would be a menu pretending
to be an agent."* A doctor's copilot naturally wants several — issue the draft, order the advised
tests, print. **Raise it as a deliberate decision in the phase doc rather than letting it erode**;
the reasoning behind the constraint is sound and deserves an explicit overrule, not a quiet second
button.

---

## 5. What must NOT be built

- **The model proposing a diagnosis from symptoms as a SOURCE.** `cds/matcher.ts` already forbids
  it: the model is a tie-breaker over our ranked output, returning indexes. Crossing this turns a
  hospital OS into a regulated medical device.
- **The model deciding a drug is safe.** The deterministic checks decide; the model may route and
  phrase. See §4.4.
- **Anything that commits clinical state.** Not a toggle, not a setting, not a fast path.
- **A second drug-disease engine.** There are already two; §4.5 merges them rather than adding.

---

## 6. Owner rulings required (money, procurement, law only)

| # | ruling | why it is the owner's |
|---|---|---|
| R1 | **The DPIA revision covering voice in the consulting room** — Class 2 audio, with a patient in the room. | Law. It blocks v2 entirely and nothing else can unblock it. |
| R2 | **Whether a model-drafted clinical note is acceptable under the hospital's own clinical governance**, given the doctor signs it and provenance is stamped. R1 covers the audio; this covers the text. | Law. |
| R3 | Nothing in v0 or v1 needs a ruling. | — |

Recorded as already given, 2026-09-17: the two toggles (§4.1) and their default-off (decided here).

---

## 7. Task sketch

| T | what | model? | blocked on |
|---|---|---|---|
| T1 | `pendingForDoctor` reader + tool + answer keys | no | — |
| T2 | consult dock → `useCopilot`; doctor tools on `opd`'s catalog | no | — |
| T3 | per-user settings row + the two toggles + the event on `draftProse` | no | — |
| T4 | the pre-read, shown on patient-open when `proactive` | no | T3 |
| T5 | "same as last time" → draft, re-checked | no | — |
| T6 | merge the four axes into one verdict per §4.5 | no | P24 (#236) merging |
| T7 | ICD-10 tie-break by model, `triage.ts`'s index-only pattern | yes | — |
| T8 | transcript → structured note, provenance, refusal-not-override | yes | **R1 + R2** |

Seven of eight tasks need no model at all. That is the honest shape of this seat.

---

## 8. Edge-case pass

- **A doctor with `proactive` on opens a patient with no history.** The pre-read must say "first
  visit" rather than render an empty block — an empty pre-read teaches the doctor to ignore it.
- **`draftProse` off, doctor asks for a draft anyway.** Answer honestly that drafting is switched
  off and name the setting. Never silently degrade to a worse answer.
- **`draftProse` toggled off between draft and signature.** The draft already made stands as a
  proposal; it is the doctor's signature that matters, and the provenance stamp records the state at
  drafting time.
- **Two engines, same drug, different severity.** §4.5 rule 2 — max wins.
- **An alternative offered that the patient's other diagnosis forbids.** §4.5 rule 4 / P24 D6 — the
  merged checker re-runs it.
- **The copilot answers about a patient the doctor is not treating.** The doctor holds
  `opd.visits.read` hospital-wide, so this is reachable. The PHI access log makes it *answerable*
  rather than *impossible* — `copilot.visit_status` already exists as a surface. Decide in the phase
  doc whether clinical reads via the copilot require the treating relationship the way
  `precheckPrescription` does via `requireTreatingDoctor`.
- **Pregnancy asserted at the chair for a male patient.** `mayBePregnant` already windows 12–50
  (`guardrails.ts:53–58`); the copilot must not widen it.

---

## 9. What the phase doc must state that this record cannot

1. The **settings table's** exact shape and migration number (taken at rebase, never at start).
2. Whether clinical copilot reads require the **treating-doctor** relationship (§8).
3. The **one-action** decision (§4.9) — overruled deliberately, or the doctor's copilot lives with
   one button.
4. The answer keys, in `contracts/copilot.ts` and BOTH locale files, with matching placeholders —
   the copilot's own test already enforces that, and this seat roughly doubles the key count.
5. Whether `pendingForDoctor` gets a **desk card** as well as a copilot tool. It probably should:
   the pile should be visible to a doctor who never presses F2, and `opdDeskProvider` already
   branches on `doctorForUser`.
