# Commissioning acts that exist only in a `beforeEach` — a census

**2026-09-07.** Asked for after §OPD-UNSEEDED (PR #155), which was the fifth instance of the same
shape found by accident. **This is a census, not a hunt: the point is to stop guessing.** It reports
the list and not the fix, because some entries need a ceremony rather than code and that is a
per-module judgement.

## The question

> Which acts must be performed once per environment for a module to work, and are performed **only**
> by a test fixture?

A suite that performs a missing step in its own `beforeEach` is green **because** the step is missing
everywhere else. **A test helper is not a commissioning path.**

## Method

The search that found the first five was the function name (`activateOpdVisitDefinition`), and it is
the wrong instrument: **a script that inlines the four kernel calls is invisible to it** — which is
exactly how this census caught an overclaim in my own PR #155. The discriminator used here is, per
act: which files name the **definition key** *and* call `createDraft` / `activateDefinition`, split
into the test tree and everything else. Populations swept: the 8 kernel workflow definitions, the 8
module approval-type registrars, and the 8 approval-flow definitions.

## Result — workflow definitions

| definition | class | runbook | census row | verdict |
|---|---|---|---|---|
| `lab_item` | C | ✅ `lab-go-live.md` | ✅ G2 | ✅ `seed:lab` activates |
| `lab_specimen` | C | ✅ `lab-go-live.md` | ✅ G2 | ✅ `seed:lab` activates |
| `pharmacy_dispense` | C | ✅ `pharmacy-go-live.md` | ✅ G2 | ✅ `seed:pharmacy` activates |
| `imaging_study` | **A** | ✅ `radiology-go-live.md` §3 | ✅ G3 | ✅ ceremony documented |
| `imaging_gate` | **A** | ✅ `radiology-go-live.md` §3 | ✅ G3 | ✅ ceremony documented |
| `opd_visit` | **A** | ✅ **as of #155** | ✅ **as of #155** | was neither |
| **`daycare_case`** | **A** | ❌ | ❌ | **OPEN** |
| **`ot_gate`** | **A** | ❌ | ❌ | **OPEN** |

**Approval types: clean.** All eight registrars (`registerBillingApprovalTypes` …
`registerTariffApprovalTypes`) have real callers in `scripts/seed-*.ts`.
**Approval-flow definitions: clean.** Each module's `approval-types.ts` drafts and activates its own.

## The rule the census establishes

> **A seed can perform a Class C activation and cannot perform a Class A one.**
> So every Class C definition was commissioned by a seed, and every Class A definition was left to
> "a human" — and whether that human was ever told depends entirely on whether somebody wrote a
> runbook.

That is one systematic cause, not five accidents. **The discriminator is therefore not "is there a
seed"** — for a Class A definition there must not be — **but "is the ceremony written in a runbook
AND checked by the readiness census".** Radiology passes both. OPD passed neither until #155.

## The one open instance: the OT

`daycare_case` and `ot_gate` are Class A. `seed-ot.ts` is **the most honest seed in the tree** — it
drafts the definitions, refuses to activate them, and says so on stdout:

```
NOTHING IS ACTIVE: an MS publishes the three drafts and drafts `privileges` themselves (DD6, T9's runbook)
```

**And T9's runbook does not exist.** `docs/runbooks/` holds six files and none is the OT's; the only
document naming these keys is the *plan* (`2026-08-28-phase1-15-mini-ot-daycare.md`), which is not
where an operator looks. So the seed correctly declines to weaken a two-key clinical-safety approval
and then points at a page nobody wrote — **the operator is stranded by a pointer, not by a silence**,
which is a better failure than OPD's and still a blocking one.

The OT also has **no row set in the readiness census at all**, so `standup:check` cannot report it.

**Recommended, for whoever owns the OT — not done here:** an `ot-go-live.md` carrying the ceremony,
and an `ot` row set whose first row is the two definitions. The measured grants for any Class A
ceremony are `draft: opd_admin only`, `approve: medical_superintendent + owner`,
**`activate: owner only`** — and the trap that follows from them is in `opd-go-live.md` §1.6: **the
owner must not be the drafter**, because drafter ≠ activator is enforced and no other role can
activate, so that draft dies with no override.

## Two blind spots this census found in the instruments

1. **The readiness census's completeness guard walked the runbook FILES on disk** and asked each for a
   row set — so a module with no runbook was not in the population and could not be found short a
   row. Closed in #155 by running it both directions. **It still will not catch the OT**, because the
   OT has no row set at all: the population is now "modules the census already knows about."
2. **Searching for the helper's NAME cannot see a script that inlines the calls.** That is how #155
   came to overstate its own evidence, and the correction is in that PR.

## Status

**The shape is closed.** Five instances were found by accident over two days; this sweep found no
sixth beyond the OT's two, and both were already suspected. Approval types and approval-flow
definitions are clean, so there is nothing further to sweep in this family.
