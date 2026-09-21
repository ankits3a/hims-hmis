# VERIFY · P1-fabric-multilingual · lens = AUTHORITY AND SAFETY

Target: `wf/design/P1-fabric-multilingual.md`. Read against `main-ro` @ `b04cbd9`; `H` = the untracked Hermes brainstorm at `/opt/hmis/docs/superpowers/brainstorms/2026-09-01-hermes-ops-copilot/00-BRAINSTORM.md`; `DPIA` = `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md`; `spec` = `docs/superpowers/specs/2026-08-10-hmis-architecture-design.md`; `REG` = the rulings register (R-nnn at line 12+nnn); `RM` = `docs/superpowers/2026-09-06-ROADMAP-v2.md`; `12` = `…department-series/12-agentic-copilot-layer.md`; `11h` = `…plans/2026-08-25-phase1-11h-global-search-command-palette.md`; `11i` = `…plans/2026-09-06-phase1-11i-the-stand-up-path.md`. Code paths under `apps/core/src` and `apps/web/src`.

**Verdict: needs-amendment.** The decision hygiene is mostly right — the DECIDED/RULING split follows the register's own categories, every epic names a fail-open path, no agent exceeds its spec tier. It fails on one load-bearing claim: E4's "one-line flip" does not switch on voice *search*; it switches on the shared `/speech/transcribe` route, and the OPD consult scribe — clinical dictation into the note — is wired to that same route with no gate of its own. That is R-059's blocked class, and the design's own §6 forbids it. Everything else below is an amendment.

---

## 1. KILL — E4's flip activates clinical dictation to a non-India cloud, not just search (E4 build (c)/(e), E4-M4, edge 13, §0 (ii), "Tier: a processor, no tier")

**What the design claims.** E4 = "11h-ii: voice search, the switch-on, measured"; the scribe is folded in as a search seam ("(c) the scribe passes the i18n language; `scribe.suggestion_accepted/discarded` events"; edge 13 "A Hindi-UI doctor holds the scribe key… the transcript is a suggestion with Insert/Discard" as an **E4-M2** acceptance); E4-M4 "the flip is one line" with `SPEECH_*` set on production (build (e)); "Tier: a processor, no tier; the transcript never chains into a model". Meanwhile §6 says "No ambient scribe, no dictation-to-note" and D16/D18 hand dictation to P2 (43c).

**What the code does.**
- `apps/web/src/components/consult-scribe.tsx:91` — `api("POST", "/speech/transcribe", { audio })`. The file imports `react`, `react-i18next`, `../lib/api` only (`:1-3`); it does **not** import `voice-flag`. `VOICE_SEARCH_ENABLED` is read by exactly one component, `voice-button.tsx:16` (grep over `apps/web/src`).
- `apps/web/src/screens/opd-consult.tsx:1089-1091` — `<ConsultScribe onInsert={(text) => setNote(n => ({...n, chiefComplaint: …text}))} />`, mounted unconditionally in the note tab; the note "autosaves on blur" (`:1080`). The transcript becomes the chief complaint of a signed consult note. `consult-scribe.tsx:41-43` says so: "the text goes into the note the doctor is already writing, under their own name".
- `kernel/inference/speech.controller.ts:30-34` — the body is `{ audio, language }`; there is no `surface`, `desk` or caller discriminator (grep `surface|desk|scribe|search` in the file: comments only). Its only gates are `actor.type === "user"` (`:80`) and the three `SPEECH_*` keys (`:65-68`). So the moment `SPEECH_*` is set on production for search, the scribe route answers too — the component's own docstring says switching it on is "ONE ENVIRONMENT CHANGE" (`consult-scribe.tsx:28`).

**What the law of the project says.**
- R-059 (REG:71): "transcript-to-note, dictation-to-draft… Keep blocked until the §19 amendment is ruled; until then ASR only per 11h DD11… no transcript-to-note agent scheduled" — `legal`, pre-plan-authoring.
- 12:514 (§9.6 Voice): "clinical dictation for drafters is a separate, later carve-out requiring in-region or on-prem ASR… **cloud ASR for clinical narratives is not proposed**"; 12:541 "on-prem whisper.cpp before any clinical dictation".
- DPIA:33 §3-A: the single named exception is "**Voice search**… transcript enters a deterministic parser as data, never chains into a text model". A chief complaint is not a parser input.
- RM:428: "No 12a agent runtime. DPIA v0.2 is counsel's; **the voice scribe stays inert at 503**."
- 11h:557-560: India is not among Cloudflare's regions; the audio's processing location "is not ours to choose".
- spec:789 draft provenance: "every model-produced draft stamps model id, prompt version, input hash and output hash into its event and into the signed document". The design's `scribe.suggestion_accepted` event carries none of these, and the note the doctor signs carries no stamp.

**Why kill, not amend.** The claim "E4-M4 flips search" is false as mechanised: the flip's real blast radius is dictation into the medical record via a processor the DPIA names only for search, in a class R-059 keeps blocked, on a route with no way to tell the two callers apart. The design also mis-attributes the scribe's dropped language hint to 11h:525-526, which specifies the *palette's* button (`voice-button.tsx`), not FD-25's scribe.

**Fix.** (1) The server discriminates callers — `surface: 'search' | 'scribe'` in the body (or a second route) — and refuses `scribe` with a coded 403 until a *dictation* addendum is ruled (P2/43c); the CI pin of edge 20 also pins that refusal on `main`. (2) E4 (c) and edge 13 leave E4: either "the scribe stays refused, tested" (an E4-M2 acceptance) or they move to P2 with R-059 named as their gate. (3) "Tier: a processor, no tier" is true of search only; say so. (4) If a dictation carve-out is ever ruled, `scribe.suggestion_accepted` must carry spec:789's stamps and the inserted text must be marked in the note.

---

## 2. AMEND — E4-M3 sends real counter audio off-shore before the owner's accept and counsel's signature

E4-M3 "Measured on UAT: real clips… ≥ 3 clips from a real counter… `SPEECH_*` on UAT" has `depends_on: E4-M2, 11i T3` — **not E4-M1** (owner accepts §3-A; counsel). §7's prose sequences E4-M1 first, but the milestone graph and edge 20 (which pins only the *flag*) do not encode it, and `speech-bench.ts` runs "only with `SPEECH_*` set" — i.e. it bypasses `VOICE_SEARCH_ENABLED` by construction.

- DPIA:33: "**feature-flag inert until this carve-out is accepted and recorded**". The bench is the same egress without the flag.
- DPIA:38 §4: staff data is a `[COUNSEL]` item — "Required: staff notice text and purpose limitation statement". A clip set of the registrar's voice is staff personal data; a clip recorded at a live counter carries whatever name was spoken.
- 11i:113 (§2b row 23, DECIDED): "UAT… must never hold a real person"; 11i:258 "UAT never restores a production backup". A fixture of real counter audio on the UAT box is a real person on UAT.
- R-009 (REG:21): recordings 90 d — the design never says where the clip set lives or when it is destroyed; a repo fixture would put it on GitHub.
- 11h:688 "no synthetic clip can stand in" is about *code-switched speech*, not about real patient names: scripted Hinglish utterances with fictitious names, spoken by consenting staff, satisfy Q6.

**Fix.** E4-M3 `depends_on` gains E4-M1; the bench refuses to run unless `docs/compliance/` holds the §3-A addendum with the owner's row filled (make that the CI-pinned precondition, beside the flag); the clip protocol is written into E4-M1 — scripted, fictitious names, consenting staff, stored outside the repo with a 90-day destroy line and a staff notice.

---

## 3. AMEND — E6-M1's vendor bench sends ≥ 50 clips per language to ≥ 2 un-contracted vendors

E6-M1: "≥ 2 candidates on the same clip set… ≥ 50 clips each; residency · **the DPA draft**". The DPA is *drafted* at the milestone that ships the clips. Same class as §2: personal audio to processors with no contract, and 12:539-541 makes residency ("in-region or on-prem") the whole point of E6. **Fix:** candidates are benched under an evaluation DPA/NDA, or on-prem, or on the §2 scripted no-PHI set; E6-M1's acceptance names which.

---

## 4. AMEND — the inbound Telegram → model-provider leg is a data flow the design does not model (E3 goal, D12, edge 7, edge 25)

E3's goal: "no patient ever leaving"; edge 7: the owner types "show me Ram Kumar's bill" → "scripted refusal… **zero egress**". H:134 justifies Telegram's residency on the **outbound** payload ("the payload is Class 0 so residency of the chat is not a DPDP question"); H:143's skill refuses *after* the pinned model has read the prompt. The name the owner typed reached Telegram's servers and the provider before HMIS was called. HMIS's ledger cannot see it (H:147: "HMIS records what it served, not what the model said").

DPIA:11 §1 also fixes the Digest Writer's delivery as "via the notification gateway to the owner"; H moves it to Hermes's Telegram gateway (H:30, H:132) — a change the Class-0 addendum must state, not inherit silently.

**Fix.** Edge 7 reads "zero egress **from HMIS**; the typed name has reached Telegram and the provider — the addendum names both as processors of the owner's own prompts, and the skill tells the owner not to type names". D12 (Telegram) stays DECIDED; the addendum content becomes an E3-M1 deliverable line.

---

## 5. AMEND — "the addendum's sign-off row is filled" is not "DPIA v0.2 (counsel)" (D4, E3-M4, E4-M4)

- The standing rule (CONTEXT.md:28): "Nothing with inference runs on production before DPIA v0.2 (counsel)". RM:404: "DPIA v0.2 | law (counsel) | one counsel session (R-262) | … yes for 12a, 43c, 44's Drafter, the voice scribe".
- The file already calls itself "**0.2 DRAFT**… not yet reviewed, not yet signed" (DPIA:3) with open `[COUNSEL]` items at DPIA:27 (whether Class-0 payloads trigger transfer analysis — the exact question E3 rests on), :29 (router), :38 (staff data), :56 (erasure), and an empty §8 table (DPIA:66-72).
- R-262's default (REG:274): "One DPIA v0.2 pass before the first Track-C plan deploys; **per-module addenda after**." D4 inverts it: addenda first, base pass later.

D4 calls this "document structure, not law". Deciding what counsel must have reviewed before an activation is a law-process question. E3-M4's acceptance can be met with the base unsigned, which the standing rule forbids. **Fix:** E3-M4 and E4-M4 gates read "DPIA §8 counsel row filled **and** the relevant addendum signed"; D4 becomes a recommendation *to counsel* on structure (keep the useful part: a Class-0 addendum can be reviewed in the same session as the base, independently of §3-A); the design names which base `[COUNSEL]` items E3 needs closed (DPIA:27, :29).

---

## 6. AMEND — Coverage Resolver T3 proposals on a production that has never left `commissioning` (E1 tier, D9, edge 4, E1-M4)

12:176 (G4): "Commissioning mode (today) → only T0 reports + Fraud Sentinel shadow; anything higher fails CI's mode matrix". Production has never left `commissioning` (CONTEXT.md:21); RM:441 makes O6 the only gate on leaving it. E1-M4 puts the roster live on production for 30 days with the Coverage Resolver at T3 (E1 "Tier"; RM:296) and edge 4 exercises proposals at E1-M3. Nothing says proposals are suppressed on production while `mode = commissioning`. **Fix:** `coverage.proposed` is mode-gated — off in `commissioning`, T3 after, T1 in `disaster` (12:174) — and the mode-matrix assertion is an E1-M2 acceptance. The `resolveOnDuty` function itself is T0 and unaffected.

---

## 7. AMEND — the global halt E3 builds cannot carry the authority D16 adopts (E3 build, D16, E3-M2, E3-M4 drill)

H:152: "Global halt: `COPILOT_GATEWAY_ENABLED=false` makes `/mcp` return 503 before auth" — an env var: needs a container restart, is not evented, records no raiser or clearer. spec:789: "**global halt** — one flag pauses every agent and automation, **itself evented**". R-127 (REG:139), adopted by D16: "Any on-call raises; clearing needs owner OR two of {duty manager, QM, steward}" — a quorum rule needs a DB-held flag with actor rows. H:151's own argument ("a CLI-only kill switch is not a kill switch the owner can reach at 2 a.m.") applies verbatim. E3-M2's acceptance events the *per-agent* kill switch (`agent.kill_switch_set`) and E3-M4 drills "kill-switch + global-halt", but the halt being drilled is a redeploy. **Fix:** global halt = a DB row surfaced on `/admin/agents`, events `agent.global_halt_set/cleared` with actor, R-127's clearing rule enforced; the env var remains the deploy-time master only.

---

## 8. AMEND — NEW-P1-4 is staffing, which the standing rule DECIDES

"who translates ~8 templates + 4 papers into a third language — money (small) — the hospital's own bilingual staff, reviewed by the department head". Zero rupees; the register's legend (REG:9) classes this `staffing`, which is not money/procurement/law. Move to DECIDED (D21) with the same line. (NEW-P1-1/-2/-3 are correctly rulings: no register row exists for an ASR/TTS vendor, the GPU box, or WABA/DLT — grep `WABA|DLT|WhatsApp Business|Telegram|ASR|whisper|TTS` over REG returns only R-006 and R-059.)

---

## 9. AMEND — E4's cross-border leg "joins" a gate that does not exist on disk (E4 gates, E4-M4)

DPIA:33: "cross-border transfer acknowledged, not assumed away… it **joins the transfer class the staged-deployment pilot already opened and gated**". That gate is spec §19's last bullet: "PRE-PILOT (stage 2…): **a DPDP posture for real patient data on a cloud host outside India**". `docs/compliance/` holds one file (the DPIA); no posture artefact exists anywhere under `docs/` (grep `DPDP posture|cloud host outside India` hits only the spec, 11h, 11a and the brief). E4-M4's gates (owner accept, counsel, WER) do not name it. **Fix:** E4-M4 depends on that posture being on file, or E4-M1's addendum states the posture for the voice class explicitly — a counsel item, not a session's.

---

## 10. Notes (no change to the verdict)

- **N1 · D8 mis-cites R-110.** REG:122 R-110 is "Escalation timers and interrupt list… Blocks **43**" (IPD rapid response), not Plan 20; the ladder timers E1 consumes already exist (`kernel/workflow/timers.ts:148-168`). Cite what E1 actually adopts or drop the id.
- **N2 · R-262 vs E1 "No DPIA".** REG:274's text says "before the first Track-C plan deploys"; Plan 20 is Track C's first deploy (RM:278-282) but is absent from R-262's Blocks column (12a, 21b, 24a, 27, 42a) and RM:404 rules "no for 41 (no inference)". E1's "No DPIA (no inference)" is defensible — say the reconciliation in one line so a reader of R-262's text does not stop E1-M4.
- **N3 · E6-M3 server TTS must be token-only.** `announcements` carries `token_no` as its only patient identifier, lint-tested (20:233); today's browser TTS speaks token + room (`opd-display.tsx:45-52`). E6's "server TTS adapter for `announcements(language, tts_ref)`" should pin that a TTS vendor never receives a name; the design does not say it.
- **N4 · E2-M3 phone worklist = patient identity on personal phones.** Q-next, but 19a's phase doc must carry the BYOD/consent line (DPIA:38 staff data; patient data on unmanaged devices). Not this quarter's problem; flag it in E2's deps.
- **N5 · "T0 automation" implies a harness that does not exist.** spec:780 has automations "running under the agent harness (identity, kill switch, heartbeat, mode/backfill gates, tier)"; RM:428 has no 12a runtime this quarter. E1's `resolveOnDuty` and E2's chaser follow today's ladders (`timers.ts:148-154`, no harness) — no new breach, but say "flag-gated function, no harness" rather than "T0".
- **N6 · D17 decides against the mission's letter.** "15 Indian languages" (MISSION-BRIEF.md:7) becomes "the registry's ceiling, N measured". Within the standing rule and transparent in §0 — but it is the one DECIDED that reframes an owner sentence, so it belongs in the first paragraph the owner reads, not only in D17.
- **N7 · E3-M2 in wk 7–9 revises RM §5.** RM:428 "No 12a agent runtime", RM:419 "No new module… except Plan 20"; `kernel/copilot` + `agent_permissions` discharge the seam `guards.ts:99-101` says arrives "with the agent runtime (Plan 12)". The design's H:13 argument is fair; mark it as a revision of RM §5's line, not a reading around it.
- **N8 · What checked out.** Tiers match spec:783-788 (Ops Copilot/Digest T0, SLA Chaser T1, Coverage Resolver T3, Turnover Dispatcher T4 operational — spec:778 lets operational domains reach T4; the clinical cap is untouched, nothing in P1 drafts clinical content). Every epic names a fail-open path (E1 broadcast, E2 broadcast, E3 "nothing depends on Hermes" H:90, E4 typing `voice-button.tsx:16`, E5 `hi` fallback, E6 typing). Hermes is API-only (`x-agent-key` path `guards.ts:47-52`; user ∩ agent per `clinical-copilot-design.md:13`; kill switch `guards.ts:51`). E3-M3's UAT is synthetic by 11i's own ruling (11i:113, :258), which satisfies H:181 "staging under a synthetic DB". D2/D3/D5/D6/D7/D10/D11/D13/D14/D15/D19/D20 are judgement calls in the register's non-ruling categories. The ruling table's money/procurement/law rows are correctly rulings (second server RM:439-440; R-131 REG:143 `money`; H R3 H:183; §3-A DPIA:31).

---

## Amendments (ordered)

1. E4: server-side caller discrimination; the scribe refused (coded 403) until a dictation addendum is ruled under R-059; E4 (c) and edge 13 out of E4 or re-scoped to "stays refused, tested"; the edge-20 CI pin covers the refusal; draft-provenance stamps named for any future dictation carve-out.
2. E4-M3 depends on E4-M1; bench refuses to run without the owner-signed addendum on disk; clip protocol (scripted, fictitious names, consenting staff, off-repo, 90-day destroy, staff notice).
3. E6-M1: evaluation DPA/NDA or on-prem or the no-PHI set before any clip leaves.
4. Edge 7 rewritten as "zero egress from HMIS"; the addendum names Telegram + the provider for the owner's own prompts; the skill says "don't type names"; the delivery-channel change from DPIA:11 stated.
5. E3-M4/E4-M4 gates = base DPIA §8 counsel row + addendum; D4 becomes a recommendation to counsel; the `[COUNSEL]` items E3 needs (DPIA:27, :29) named.
6. `coverage.proposed` mode-gated (off in `commissioning`); mode-matrix test in E1-M2.
7. Global halt as a DB row on `/admin/agents`, evented, with R-127's clearing rule.
8. NEW-P1-4 → DECIDED D21.
9. E4-M4 names the stage-2 DPDP-posture artefact (spec §19) as a gate, or E4-M1's addendum states the posture for the voice class.
10. N1 (R-110 citation), N3 (token-only TTS), N5 ("flag-gated function, no harness"), N7 (mark the RM §5 revision) as one-line edits.
