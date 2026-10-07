# Chooser evaluation — TypeSafe's Jev beside OpenAI's Decisions API (2026-10-07)

Owner, 2026-10-07: *"let's try OpenAI Decision API"* and, on whether it understands north Indian
slang and Hinglish better than Jev: measure it. This is that measurement. **Nothing in production
changed**: the order of choosers is a setting and its default is still TypeSafe alone.

Run from the staging/dev box (62.238.106.231) on 2026-10-07 with `apps/core/scripts/eval-choosers.ts`.
Both models were asked through the product's own functions (`chooseDepartments`, `chooseRoute`), so
each saw the instructions, options and descriptions a clerk's question meets. Masked input only; the
sets hold no patient data. Models: `jev-1.13.0` and `gpt-6-luna` (`POST /v1/decisions`, public beta).
Raw results: `/opt/hmis-context/chooser-eval-2026-10-07/run1.json` (outside git).

## The three sets

| Set | Items | What it is |
|---|---|---|
| triage46 | 46 | The complaints in `triage-eval-cases.ts`, 2–4 words, four languages. Jev was tuned against these in September. |
| hinglish | 69 | NEW, written for this run: romanised Hindi with Bhojpuri/Maithili turns, negations, and 6 non-health sentences. Neither model has seen them. |
| copilot | 94 | Counter questions for the copilot router. The 64-question set of PR #250 is lost; this is a re-creation to the same recipe plus pharmacy (18) and roster (12) intents. Not comparable row for row with #250. |

**All labels are the author's, not a clinician's.** Where a complaint honestly fits two departments,
both were accepted.

## Results (first pass; the second pass is under "Stability")

"Answered" = confidence at or above the line. "Wrong" = answered and not an accepted label.

| Set | Model | Top-1 right | Answered at 0.6 | Wrong at 0.6 | at 0.5 (ans / wrong) | at 0.7 | at 0.8 |
|---|---|---|---|---|---|---|---|
| triage46 | Jev | 40/46 (87%) | 39 | **0** | 39 / 0 | 38 / 0 | 36 / 0 |
| triage46 | OpenAI | 45/46 (98%) | 43 | **0** | 43 / 0 | 42 / 0 | 41 / 0 |
| hinglish | Jev | 54/69 (78%) | 52 | **4** | 57 / 6 | 50 / 3 | 44 / 1 |
| hinglish | OpenAI | 66/69 (96%) | 64 | **0** | 66 / 1 | 60 / 0 | 55 / 0 |
| copilot | Jev | 93/94 (99%) | 92 | **1** | 93 / 1 | 91 / 1 | 89 / 1 |
| copilot | OpenAI | 93/94 (99%) | 90 | **0** | 92 / 0 | 89 / 0 | 84 / 0 |

Jev's confident wrong answers (the ones a clerk would have been shown):

- "daad ho gaya jaangh mein" (ringworm on the thigh) → Orthopaedics, 0.62
- "bachcha nahi thehar raha" (cannot conceive) → Paediatrics, 0.72
- "babu ko dast lag gaye hain" (the child has diarrhoea) → General Medicine, 0.78
- "navjaat peela pad gaya hai" (newborn turned yellow) → General Medicine, 0.93
- copilot: "aaj chhutti hai kya hospital mein" → `roster.my_duties`, 0.80 (should be none)

Jev's September misses are still there and still safely under the line: "gala kharab hai" 0.49,
"naak band hai" 0.15, "kaan bahta hai" 0.31 — all sent to General Medicine. OpenAI put all three in
ENT ("kaan bahta hai" at only 0.30, so it too would fall through).

OpenAI's five top-1 misses were all below the line: "masuda soojh gaya", "daad ho gaya jaangh mein",
"safed paani ki shikayat", "pet se hoon, jaanch karani hai" (0.57, the closest call), and the
Bhojpuri "hamar aaj ke ginti batawa".

Two patients in one question (2 items): Jev named the right patient both times; OpenAI once, and was
unsure the other time — which the product treats as "ask which patient", not as a wrong answer.

## Speed, failures, cost (418 calls each, paced 200 ms apart)

| | p50 | p90 | p99 | max | slower than 1.0 s | slower than 1.5 s | failed |
|---|---|---|---|---|---|---|---|
| Jev | 245 ms | 296 ms | 391 ms | 734 ms | 0 | 0 | 0 |
| OpenAI | 233 ms | 384 ms | 1867 ms | 4138 ms | 12 (2.9%) | 6 (1.4%) | 1 (transient; the same sentence answered 4 of 4 on retry) |

OpenAI is as fast as Jev in the middle and has a longer tail. The product timeout for it is set to
1.5 s, so about 1 call in 70 would pass to the next chooser instead of making a clerk wait.

Cost, from the usage each response reported: OpenAI averaged 382 input tokens for a triage question
and 1,094 for a copilot question — **about $0.04 per 1,000 triage questions and $0.11 per 1,000
copilot questions** at the published $0.10 per million input tokens. The whole evaluation (418
calls) cost about $0.03. TypeSafe's price is on its own account and was not measured here.

## Stability (the same 209 questions asked twice)

| | Choice changed between passes | Largest confidence change |
|---|---|---|
| Jev | 6 of 209 (4 hinglish, 2 copilot), all on low-confidence items | 0.17 |
| OpenAI | 0 of 208 answered both times (the 1 failure aside) | 0.00 |

Second-pass confident-wrong counts: Jev 0 / 5 / 1, OpenAI 0 / 0 / 0 (triage46 / hinglish / copilot).

## In a chain (at 0.6; whoever is sure first answers; the rest goes to the chat model)

| Order | Set | Answered | Right | Wrong | Left for the chat model | p50 / p90 |
|---|---|---|---|---|---|---|
| Jev → OpenAI | triage46 | 43 | 43 | 0 | 3 | 242 / 461 ms |
| Jev → OpenAI | hinglish | 66 | 62 | **4** | 3 | 248 / 467 ms |
| Jev → OpenAI | copilot | 92 | 91 | **1** | 2 | 252 / 319 ms |
| OpenAI → Jev | triage46 | 43 | 43 | 0 | 3 | 210 / 461 ms |
| OpenAI → Jev | hinglish | 66 | 64 | **2** | 3 | 225 / 458 ms |
| OpenAI → Jev | copilot | 92 | 92 | 0 | 2 | 225 / 400 ms |
| OpenAI alone | hinglish | 64 | 64 | 0 | 5 | 217 / 455 ms |

With Jev first, its confident mistakes are final — OpenAI is never asked. With OpenAI first and Jev
second, Jev answered 2 more Hinglish complaints and both were wrong; on the copilot set it answered
2 more and both were right.

**Not measured:** the chain into the existing chat model (`gpt-oss-120b`). Its key is only in
production's environment, which this evaluation did not touch. September's figure for it alone on
triage46 was 44/46 at ~700 ms.

## What the numbers support, and what they do not

- **Hinglish at the front desk: OpenAI is clearly better here.** 96% against 78% top-1, and no
  confident mistake against four. This is the owner's hypothesis, and on this set it holds. The gap
  (12 items of 69) is too large to be noise, but the set is 69 sentences written by one author — a
  first reading, not a verdict.
- **The original 46: OpenAI is better, modestly.** 45 against 40; neither was confidently wrong.
- **Copilot routing: no real difference.** 93 of 94 each. Jev had one confident mistake and OpenAI
  none; one item is within noise.
- **Speed: equal in the middle; OpenAI has a tail** that the 1.5 s timeout bounds.
- **OpenAI's endpoint is a public beta with one model.** Behaviour and price can change; one of 418
  calls failed for a reason this run did not capture.

## Recommendation (the owner decides; nothing is switched)

1. **Front-desk department suggestion (`TRIAGE_CHOOSER_ORDER`): `openai,typesafe`** — or `openai`
   alone. OpenAI first removes Jev's confident Hinglish mistakes. Keeping Jev second means the desk
   still gets an answer when OpenAI is down or slow, at the cost of Jev's occasional confident error
   on the few questions OpenAI is unsure of (2 of 69 here). Keep the 0.6 line: OpenAI was never
   wrong at or above it on any set, and 0.5 let one wrong answer through.
2. **Copilot router (`COPILOT_CHOOSER_ORDER`): `openai,typesafe`** for the same reason, though
   either order is defensible on these numbers.
3. **The chat model stays last** in both, unchanged.
4. **Re-measure after a month of real questions.** The plan's growing held-out set (phase P3) will
   replace these author-labelled sentences with real corrections; the order is a setting so it can
   follow the evidence.

## How to switch (when the owner says so)

Two lines in production's environment file, then the normal restart; no code change:

```
TRIAGE_CHOOSER_ORDER=openai,typesafe
COPILOT_CHOOSER_ORDER=openai,typesafe
```

The OpenAI key is the file `HMIS_OPENAI_KEY_FILE` already points at (the one voice notes use); it is
re-read when it changes, so a rotated key needs no restart. With no key readable, OpenAI is skipped
and Jev answers as today. To go back: remove the two lines (the default is `typesafe`).

## Also in this change

- `kernel/inference/openai-decisions.ts`: the second `ChoiceClient`, `chooserChain`, and `chooserFor`
  (the one place triage and the copilot wire their choosers). The closed menu is enforced where the
  bytes arrive, as in `typesafe.ts`; a `refusal` answer is "did not answer".
- `predicate()` on the inference types (probability that one condition is true) — implemented for
  OpenAI, not offered by TypeSafe. It is for the medicine-alias reviewer (decision 0051) and has no
  caller yet.
- `triage-eval-cases.ts`: the 46 complaints moved out of the test file so that tools can read them
  and a future example-miner can refuse them as examples.
- The held-out sets: `apps/core/scripts/data/chooser-eval-sets.ts`. **None of these sentences may
  become an example or a description shown to a model.**

To run it again: `HMIS_EVAL_NETWORK=1 pnpm --filter @hmis/core exec tsx scripts/eval-choosers.ts > out.json`
(it refuses without the flag, and CI never sets it), then
`python3 /opt/hmis-context/chooser-eval-2026-10-07/analyse.py out.json`.
