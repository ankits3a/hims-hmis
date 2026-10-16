---
issue: 580
status: built
approved: 2026-10-11
---
# SPEC — copilot propose → confirm → act (E0.2) — 2026-10-11

**Status: built at the owner's overnight instruction (2026-10-11 03:00 IST, "keep working on the decided milestones
and goals"); awaiting review.** Lane `lane/copilot-confirm`, DRAFT PR stacked on #677 (E0.3 halt). Plan
`docs/superpowers/plans/2026-10-10-copilot-PLAN.md` §3 E0.2; decisions 0064, 0065; issues #580, #678 (second half).

**Declaring a write.** A tool that writes declares `kind: "act"` AND an `act` block: `args` (zod), `recheck` (re-read
state inside the confirm transaction; returns a refusal key or null), `apply` (the module write; returns its answer, the
module name, the resulting row id and the subject patient id), and `verify` — either a read-back run inside the same
transaction (false ⇒ roll back) or `{ none: "<why not>" }`. Boot refuses `kind: "act"` without `act`, and `act` without
`kind: "act"` (DECIDED: a write that slips the act halt must not exist).

**Propose.** An act tool's `run` answers as any tool does and adds `propose: { args }`. The ask path (only for
`kind: "act"`) validates the args and signs a proposal: `{ v:1, id, userId, tool, args, subject, issuedAt, expiresAt,
sig }`, `expiresAt − issuedAt` ≤ 5 min (tool may ask for less). `sig` = HMAC-SHA256 over the canonical JSON (sorted
keys) of every other field, key = HMAC(`SECRET_KEY`, "hmis.copilot.proposal.v1") (DECIDED: a derived sub-key, no new
env var; the key and signature are never logged). Nothing is written at propose.

**Confirm.** `POST /copilot/confirm { proposal }` (authenticated user; the tool's own permission is the gate, like ask).
Order: user actor → signature → `userId` = caller → not expired (and TTL ≤ 5 min) → tool exists and is `kind: "act"`
with an `act` block → halt (act/global/read) → permission (re-read now) → args re-validated → already confirmed? → ONE
transaction: `recheck` → `apply` → `verify` → `copilot_acts` row (proposal id, confirm id, args hash, subject patient
id, result module + row id). Any throw rolls back both. Every refusal is a 200 with an answer key, never a stack trace.

**Replay (DECIDED).** `confirm_id` = `cf_` + proposal id, so the existing UNIQUE index (migration 0194) makes one
proposal confirmable once — no migration. A replay answers `actAlreadyDone` and writes nothing; a concurrent double
tap loses on the unique index and rolls back its module write.

**New answer keys:** `actDone`, `actExpired`, `actInvalid`, `actAlreadyDone`, `actStateChanged` (en + hi, short).

**Done means (binary, tests):** (1) a replayed confirm writes nothing; (2) an expired proposal refuses; (3) args
changed after signing refuse; (4) permission revoked between propose and confirm refuses; (5) a forced failure after
the module write (verify false, or a throw) leaves neither the write nor the act row; (6) state changed between propose
and confirm (fixture "slot taken") refuses; (7) halt "act" refuses confirm; (8) a tool not declared `act` refuses
confirm (#678); plus another user's proposal refuses. Proved with a test-only fixture tool injected in tests only
(`COPILOT_EXTRA_TOOLS`, empty in production); no real write tool exists until E2.x.

**Not in scope:** web confirm button (E2.x ships with the first real tool), tagging existing draft tools (#678 first
half), async post-commit verification (brainstorm §3 `verifying` state).
