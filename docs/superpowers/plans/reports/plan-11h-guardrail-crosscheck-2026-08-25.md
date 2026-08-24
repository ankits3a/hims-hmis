# Plan 11h — guardrail cross-check (2026-08-25, owner-requested)

**Checked:** `2026-08-25-phase1-11h-global-search-command-palette.md` (written before the roadmap's
in-flight-AI guardrail landed at `a1513cd`) against that guardrail, the inference-locus ruling
(2026-08-23), and deferred notes 13/14/17/18. **Verdict: PASS on every axis — and it exceeds the
guardrail in three places.** No rework requested.

| Guardrail item | 11h's answer | Verdict |
|---|---|---|
| One choke module, becomes 12a's `InferenceClient` | DD10.4 — writes no second client; `INFERENCE_*` config defaulted empty; NL lane inert until 12a's client exists | PASS |
| Voice = Class 2; ship as dictation into read-only search | DD11 — transcript feeds the deterministic DD2 parser on the read-only search path; propose→confirm preserved (DD10.3); push-to-talk, 15 s cap, nothing persisted, desk-level off-switch, `VOICE_SEARCH_ENABLED=false` until the law amendment is recorded | PASS |
| Router is config behind the seam, never a subsystem | DD10.4 | PASS |
| Search permission-scoped per requester | DD1 (fan-out only to permission-held providers) + DD3 (sealed class has *no representation* — "a field for it would be the leak"; WHERE-clause enforcement, D-37 extended to every provider) | PASS, exemplary |
| Read the design law before merging | DD10.1 cites the locus ruling verbatim; the tokenize-before-model shape *is* note 13's boundary | PASS |

**Where it exceeds the guardrail:**
1. **Q1's measured finding kills a lazy assumption:** the "self-hosted" router routes each request to a
   third-party provider chosen per call — so **the data processor cannot be named in advance**, which
   is exactly what a DPIA must name. Consequence adopted by the plan: the router is unusable for
   anything PHI-adjacent until a model/provider is pinned. This finding is now folded into the DPIA
   draft (v0.2).
2. **"NL → answer synthesis is REFUSED, not deferred"** — stronger than the guardrail asked.
3. **DD11 does the honest governance move:** rather than treating voice as an implementation detail,
   it states that the PHI law and cloud speech-to-text cannot both stand unqualified, and proposes a
   **named carve-out for the owner to accept or refuse** (one nameable processor · contractual
   no-training/no-retention · transcript-only output · flag-gated · audited per use with
   `source:'voice'` so the exposure is measurable · revisited when in-region or on-prem ASR exists),
   with the cross-border transfer written down rather than assumed away.

**Two follow-ups, neither blocking 11h:**
1. **The carve-out needs the owner's explicit accept/refuse**, and on accept it is a spec amendment
   (the PHI law gains its one named exception when the law lands in the spec at 12a plan-writing).
   Until then `VOICE_SEARCH_ENABLED` stays false — which the plan already enforces.
2. **DPIA updated to v0.2** (same file): §3 gains the router per-request sub-processor finding, and a
   new §3-A records the proposed speech carve-out for the DPDP specialist to review.
