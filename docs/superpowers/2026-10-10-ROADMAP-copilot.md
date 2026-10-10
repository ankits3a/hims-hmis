# ROADMAP — the staff copilot track (C-series)

**Date:** 2026-10-10 · **Measured at:** `main` 21467fd7 (#571) · **Status:** PROPOSAL until the owner says yes.
**Owner request 2026-10-10:** two home-screen widgets (scan a patient; talk to the copilot), then "help me see a bigger
and wider picture of AI agent as co-pilot to my staff… check any brainstorming session already saved, the roadmap,
the current architecture… draw a new roadmap… and then we should start building it."

**What this document is.** A copilot track that sits beside ROADMAP v2 (`2026-09-06-ROADMAP-v2.md`), which stays the
record for department opening and the IPD gate. It does not replace v2; it replaces the never-written v3's AI pillars
(materials on `origin/lane/roadmap-v3`, stopped 2026-09-21) for the part about staff copilots. Every row cites an
artefact; a row with no artefact is not started.

---

## 1. Sources read for this roadmap

| Source | What it gave |
|---|---|
| `brainstorms/2026-08-27-department-series/12-agentic-copilot-layer.md` (AL) | ~85 candidate automations by seat; tiers T0–T4 with clinical cap T2–T3; propose → confirm → act → verify; promotion gates; ledgers |
| `specs/2026-08-25-clinical-copilot-design.md` (CC) | narrate-never-originate; the model sees no more than the caller; per-request token maps |
| `brainstorms/2026-09-17-doctor-copilot/00-BRAINSTORM.md` (DC) | doctor seat: pending-for-me, pre-read, transcript → structured note; R1/R2 open |
| `brainstorms/2026-09-01-hermes-ops-copilot/00-BRAINSTORM.md` (HM, untracked) | owner ops copilot over Telegram, HMIS-side MCP server with Class-0 tools only, 08:00 digest |
| `brainstorms/2026-09-20-obligation-spine/*` (OS) | "who owes what, by when": two clocks, two ladders; T1–T4 merged, T5–T13 not started |
| `2026-09-06-ROADMAP-v2.md` | 12a agent runtime held behind DPIA v0.2; IPD gate for plan 41; 403 commits stale |
| `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md` | data Class 0/1/2, inference locus follows class; still unsigned |
| memory: every-user-has-a-copilot, desk-copilot-must-act | owner thesis 2026-09-17: every seat has a copilot that answers and acts, English + Hinglish |

## 2. What exists today (artefacts on main)

| Piece | Artefact | Limit |
|---|---|---|
| One copilot brain, 15 intents, runs as the asking user | `kernel/copilot/` (#239, #250, #251); `POST /copilot/ask` | **reads only**; intents are a closed list in `phrasebook.ts` (a module cannot add one alone); `patient_dues` has no tool |
| Module tools | `copilotTools` in opd, pharmacy (#247), roster manifests | `draft_*` tools return a plan; the human presses the normal button |
| Routing | phrasebook → chooser (TypeSafe `jev` or OpenAI Decisions) → chat model that may only name a tool | model never writes the answer |
| Identifier masking | `kernel/copilot/mask.ts` `maskQuestion`, `assertNoIdentifiers` | refuses on leak |
| Inference choke module | `kernel/inference/` (`complete`, Workers AI whisper, OpenAI speech) | `complete` is one prompt + one string; `opd/triage.ts` still calls a model directly |
| Doctor voice | `opd/consult-voice.ts`, decisions 0048/0049 | the one Class-2 exception (DPIA §3-B) |
| Self-improving suggestions | decisions 0050–0054, `opd/alias-pipeline.ts` | P1 waits for ~300 typed prescriptions |
| Obligation spine (open loops) | `kernel/obligations`, `kernel/alerts`, `kernel/workflow` timers (#267, #282, #283, #284) | only radiology escalations use it (#404); T5–T13 not built |
| Staff push | web push (#284); phone FCM `kernel/push/fcm.ts` (generic text, no patient detail) | |
| Ask boxes | web `AgentDock` on 12 screens | **mobile app has no copilot**; no widget |
| Agent identity | `agents` table + `x-agent-key` (print relays only) | no `agent_permissions`, no `agent_ledger`, no global halt |
| Scheduled jobs | 29 fixed jobs in `kernel/worker/jobs.ts` | **no user-set reminder or schedule** |
| Bots / MCP | none inbound; WhatsApp + SMS outbound only | |

**The one-line finding:** the copilot has a good brain and good manners (runs as the user, never sees identifiers,
never writes the sentence), but it cannot yet *do* anything, it is not on the phone, it does not *chase*, and the
governance layer v2 called 12a (ledger, grants, kill switch, evals) was never built under the AI that already ships.

## 3. The shape of a mature staff copilot (the target)

Five modes, every seat, each bounded by that seat's own permissions:
1. **Ask** — live answers in English / Hinglish / Devanagari (exists, web only).
2. **Act** — the copilot does the act after one confirm tap (missing).
3. **Chase** — open loops owned and escalated: reports unseen, criticals uncalled, follow-ups missed (spine half-built).
4. **Schedule** — "remind me at 4", "every Monday send me…" (missing).
5. **Draft** — handover, staff message, summary; a human edits and signs (missing; needs a ruling).

Lines that do not move (already decided; restated so no phase weakens them): runs as the asking user; no clinical
decision by a model (clinical cap T2–T3); every write waits for a human tap; every ask and act is ledgered; no patient
identifier to a model except under a numbered decision; proactive alerts suggest, never act.

## 4. The phases

Each phase gets its own ~10-line spec with "done means" before build (CLAUDE.md "spec before build").

### C0 — Ground rules in code (the missing 12a floor) · not started
- `copilot_runs` ledger: every ask, the route taken, tool, outcome, and every act with its confirm — append-only, no
  free-text payload beyond the masked question.
- **Propose → confirm → act → verify** protocol on `POST /copilot/ask`: a write tool returns a signed proposal; a
  second call `POST /copilot/confirm` performs it once (idempotency key), re-checking permission at confirm time.
- **Open the intent seam:** a module declares its intents, cues and answer keys in its manifest; the kernel list
  stops being the bottleneck (finding from the pharmacy F2 lane, memory obs 38709/38711).
- Global halt switch per tool class (read / act / draft), owner-only to clear.
- Hinglish eval fixture set run in CI for the router (no network; recorded chooser answers).
- Done means: an act cannot run without a confirm row; a revoked permission between propose and confirm refuses;
  halt "act" turns every write tool into a refusal while reads still answer.

### C1 — On every phone · next
- **C1a Scan widget** (Android): opens `hmis://scan`. Spec: `/opt/hmis-context/SPEC-home-widgets-2026-10-10.md`
  Part A. No server change. Independent of C0 — can build first.
- **C1b Mobile copilot screen** `/copilot`: chat over `POST /copilot/ask`, en + hi, answer cards, confirm cards once C0
  lands.
- **C1c Copilot widget**: "Ask" + mic. Mic → `POST /speech/transcribe` → same ask (needs ruling R-2).
- **C1d Morning card per seat** on the phone home: "what is waiting for me" — reads only, from existing data
  (my_day_report, roster.my_duties, unread imaging, criticals).

### C2 — Acts (first write tools) · after C0
Owner-picked 2026-10-10: reminders to myself, book / move appointment, leave / duty-swap request, existing desk acts.
- **Reminders and schedules**: a user-owned timer on `kernel/workflow` that ends in an FCM / web push to that user only
  ("remind me at 4 to see bed 12"; "every Monday 9 am send me last week's OPD"). New, small kernel table.
- **Appointment book / move** (opd tool; same rules as the appointments screen; tele-call rules from 2026-10-09).
- **Leave request / duty swap** (roster tool; `roster.ask_cover` already drafts — make it file the request into the
  existing approvals engine).
- **Short-book place, PO "make the drafts"** (pharmacy tools already draft — make the confirm do the act).
- **patient_dues** tool (billing) — closes the one dead intent.

### C3 — Chase (open loops) · after C1d
Finish the obligation spine where staff feel it: T5 addressees and chains, T8 tasks verb + station board, T9 shift
brief / handover, then lab criticals and report-unseen loops onto it. The phone shows "my open loops"; the owner sees
loops by department. Resume from `plans/2026-09-21-obligation-spine-T5-HANDOFF.md`.

### C4 — Drafts · after ruling R-1
Owner-picked 2026-10-10: messages to staff, reports / summaries. New: the model writes prose. Rules carried from
decision 0006: per-user toggle, default off; draft shown editable; never sent or saved without a tap; draft and final
both ledgered; Class 0/1 input only unless R-1 says otherwise. Handover and discharge drafts wait for IPD (plan 41/44).

### C5 — Owner ops copilot (Hermes) · after rulings R-3, R-4
HM brainstorm as written: HMIS serves `POST /mcp`, Class-0 tools only; Hermes on a second server over Telegram or
WhatsApp; 08:00 digest; approvals from the phone in v2. Needs `agents.delegate_user_id` + `agent_permissions`
(user ∩ agent) — that is the first non-human actor with grants.

### C6 — Money: claims and leakage · after plan 46-lite ruling
PM-JAY / TPA pre-auth pack checker, query deadline chaser, rejection patterns; unbilled-service check at bill close.
Needs an insurance module that does not exist (plan 46). Behind the IPD gate in v2 unless the owner rules "46-lite".

### C7 — Ward and clinical copilots · behind the IPD gate
Discharge coordinator ("Magic Discharge", plan 44), nursing due-dose and handover, deterioration nudges, resident
pre-round brief. Each needs IPD (plan 41) and nursing (42) first. Listed so they are designed onto C0–C3, not around.

### C8 — Teaching hospital (CRKMCH) · design only
NMC inspection pack kept current (faculty attendance from the attendance module, clinical material counts),
resident / intern logbooks filled from encounters and signed by faculty. Needs a short brainstorm before a spec.

## 5. Order and dependencies

```
C1a scan widget ──────────────┐ (no dependency — build now)
C0 ground rules ── C2 acts ───┤
     │                        ├── C1c copilot widget
     └── C1b mobile chat ─────┘
C1d morning card ── C3 chase (spine T5/T8/T9)
R-1 ── C4 drafts        R-3/R-4 ── C5 Hermes        46-lite ── C6 claims        plan 41 ── C7 ward
```
Proposed build order: **C1a → C0 → C1b → C2 (reminders first) → C1c → C1d → C3 → C4 → C5**; C6–C8 by ruling.

## 6. Owner rulings owed (money, procurement or law only)

| # | Question | Why it is the owner's |
|---|---|---|
| R-1 | May a model write staff-facing prose (drafts) from Class 0/1 data? From patient-identified data? | DPDP Act / DPIA (law) |
| R-2 | Staff spoken questions to a cloud speech provider (Workers AI whisper today) — the audio may carry patient names | DPDP (law); 0048/0049 covered doctor consult voice only |
| R-3 | A second server for the Hermes ops copilot | money / procurement |
| R-4 | Model provider and budget cap for C5 (AL O-6 proposed ₹5k/day) | money |
| R-5 | Plan 46-lite (insurance / PM-JAY) before IPD | money |
| R-6 | DPIA v0.2 counsel signature — still unsigned while AI ships under decisions 0048–0054 | law |

Everything else is DECIDED by the standard-Indian-corporate-hospital rule and marked in each phase spec.

## 7. What this roadmap does not change
ROADMAP v2's IPD gate, department opening order and commissioning track; the clinical cap (T2–T3); decisions
0006, 0048–0054; the patient WhatsApp bot stays templated-only (AL O-10).
