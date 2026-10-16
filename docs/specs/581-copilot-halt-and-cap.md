---
issue: 581
status: built
approved: 2026-10-11
---
# SPEC — copilot halt switch and AI spend cap (E0.3, E0.5) — 2026-10-11

**Status: built at the owner's overnight instruction (2026-10-11 03:00 IST, "keep working on the decided milestones
and goals"); awaiting review.** Lane `lane/copilot-halt`, DRAFT PR. Plan `docs/superpowers/plans/2026-10-10-copilot-PLAN.md`
§3 E0.3, E0.5; decision 0064 (₹5,000/day cap, phrasebook-only till midnight IST, health page says so).

**E0.3 halt.** Table `copilot_halts` (one row per halted scope: read / act / draft / global; row present = halted).
Every ask does ONE DB round trip that reads the halts and today's spend together, no cache (`getOperatingMode` pattern).
read or global halted → the ask answers `copilot.answer.paused`, ledgered `halted`, no routing, no model. A tool declares
`kind` read (default) / draft / act; act halted → act tools refuse with `paused` while read tools answer; draft halted →
draft tools refuse. Halt and clear each append an audit event naming who (`copilot.halt_set`, `copilot.halt_cleared`).
Permissions (DECIDED): `copilot.halt.set` owner, admin (IT), quality_manager (steward, runs the drill), duty_manager;
`copilot.halt.clear` (read/act/draft) owner, duty_manager; `copilot.halt.clear_global` owner only. duty_manager also gets
`copilot.health.read` so the buttons on /copilot-health are reachable at 2 a.m. Failover reads the same replicated table.

**E0.5 cost.** Every chooser/model call of an ask is metered: provider, model, tokens (chat model: the provider's
`usage`, else chars÷4; choosers: chars÷4 — no usage on their wire), estimated ₹ from a price table in config
(`COPILOT_PRICES_INR`, JSON `{"provider:model":{"in":₹/1M,"out":₹/1M}}`, merged over defaults). Stored on the ask's
ledger row (`model_calls`, `cost_micro_inr`, `model_usage` jsonb, `capped`), so spend is pruned with the ask (180 d).
Cap: `COPILOT_DAILY_CAP_INR` default 5000. Check = SUM(cost) over today's IST rows via a partial index (in the same round
trip as the halt read). spent ≥ cap → phrasebook only (zero model calls), row `capped=true`, health page says
"capped until midnight IST". Assumed prices are ESTIMATES (USD→₹88): Groq gpt-oss-120b ₹13.2 in / ₹52.8 out per 1M;
TypeSafe Jev and OpenAI Decisions unknown → conservative ₹110 in / ₹880 out per 1M (also the default for any unknown model).
Only the copilot's own calls are counted (triage and the formulary reviewer are not — noted as not done).

**Done means (binary, tests):** (1) after halting act, a fixture act tool refuses while a read tool answers; (2) each
halt/clear writes one audit event naming the actor; (3) a non-owner (duty manager) cannot clear global — 403;
(4) duty manager can clear act; (5) a halted (read/global) ask is ledgered `halted` and reaches no model;
(6) a model call records tokens + ₹ on the ask row; (7) at the cap the next ask makes zero model calls and health says
capped; (8) the spend sum resets at midnight IST (injected clock, rows at 23:59 / 00:01 IST).
