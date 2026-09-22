import { RosterError } from "./errors";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R1) — **THE ONE FUNCTION THAT SAYS `never`** (stress test §4, invariant V8).
 *
 * ═══ WHAT THIS IS FOR ═══
 *
 * The owner's HMIS is *"an agentic-AI hospital operating system that uses AI agents as co-pilots to
 * human users"*. The roster is the first thing those agents touch that decides **who is woken at
 * 02:00 to see a patient** — and the stress test's answer to "what may an agent do to it?" is a
 * matrix, not a habit. A rota that a machine can publish is a rota in which nobody can be said to
 * have taken responsibility, and the whole point of publishing one is that somebody has.
 *
 * So: **the system proposes; a human publishes, approves, overrides and acknowledges** (Plan 20 D4).
 * This file is where that sentence is enforceable rather than aspirational, and it is enforced in
 * ONE place so that the enumeration test (V8) has one thing to enumerate.
 *
 * ═══ WHY `via`, AND WHY `packages/contracts` IS NOT TOUCHED ═══
 *
 * The matrix distinguishes *a user* from *that user's copilot* — the copilot may read and may
 * DRAFT a proposal, and may never confirm one. But the `Actor` union is frozen for this phase
 * (plan §5) and a copilot acting for a user is, correctly, that user: it acts inside their grants
 * and every write already records them. The distinction is therefore about the CHANNEL, not the
 * identity, and it arrives as `via` — which is also the honest shape, because the same human may
 * do the same act by hand a second later and should be allowed to.
 *
 * ═══ THE MATRIX IS DATA, AND EVERY CELL IS DECLARED ═══
 *
 * `MATRIX` has a row per act and a cell per actor kind, with no defaults and no fall-through. A new
 * act cannot be added without deciding, in writing, what a machine may do with it — which is the
 * property that makes this a policy rather than a pile of `if`s. The test walks every cell.
 */

/**
 * The acts, exactly the rows of stress test §4. Grouped by what they COST if a machine does them
 * wrongly, not by which function implements them — several functions share an act.
 */
export const ROSTER_ACTS = [
  /** Read who is on, my own duties, a what-if, an explanation. Costs nothing; everyone may. */
  "read",
  /** Draft a MACHINE-ORIGIN period and its slots — the proposer's own output, marked as its own. */
  "draft_machine_period",
  /** Edit a draft a HUMAN has already touched. The lost-update the stress test found (S2a), as a rule. */
  "edit_human_draft",
  /** Propose a cover, a swap or a split. A copilot may draft one; the human confirms it. */
  "propose",
  /** Accept a warning finding, or override a rule. The HOD's own judgement, and nobody else's. */
  "accept_warning",
  /** Publish, amend, approve a swap, approve a leave. The governed acts (D3/D4). */
  "publish",
  /** Declare a holiday or skeleton mode — the medical superintendent's, or a named delegate's. */
  "declare",
  /** Acknowledge an alert or pass it on. `on_behalf` names the human who actually did it. */
  "acknowledge",
  /** Raise a nag about a hole in a roster. Rate-limited and killable when a machine does it. */
  "nag",
  /**
   * PHASE R (R4) — ask to be away. **This act is NOT in stress test §4**, which is about acts on a
   * roster; being absent is a fact about a person's own life and the document does not cover it.
   * Added here rather than assumed, because that is what the matrix is for.
   */
  "request_absence",
] as const;
export type RosterAct = (typeof ROSTER_ACTS)[number];

/**
 * `user` acting directly, `copilot` = that same user's assistant acting for them, and the three
 * non-human actor types the envelope already has. `patient` is here because the `Actor` union has
 * it and an undeclared cell is exactly what this table exists to prevent — a patient has no
 * business anywhere in a staff rota, and the table says so rather than leaving it to a type error.
 */
export const ROSTER_ACTOR_KINDS = ["user", "copilot", "agent", "system", "patient"] as const;
export type RosterActorKind = (typeof ROSTER_ACTOR_KINDS)[number];

export const ROSTER_VIAS = ["direct", "copilot"] as const;
export type RosterVia = (typeof ROSTER_VIAS)[number];

/**
 * `grant` — allowed, and the named permission is then checked at the right scope by `access.ts`.
 * `open` — allowed with no permission (a named `system` job reading its own scope).
 * `never` — refused for this KIND of actor, whatever it holds. This is the word V8 is about.
 */
type Cell = { readonly verdict: "grant"; readonly permission: RosterPermission }
  | { readonly verdict: "open" }
  | { readonly verdict: "never" };

export const ROSTER_MANAGE = "roster.periods.manage";
export const ROSTER_PUBLISH = "roster.periods.publish";
export const ROSTER_READ = "roster.read";
export const ROSTER_PERMISSIONS = [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ] as const;
export type RosterPermission = (typeof ROSTER_PERMISSIONS)[number];

const grant = (permission: RosterPermission): Cell => ({ verdict: "grant", permission });
const open: Cell = { verdict: "open" };
const never: Cell = { verdict: "never" };

/**
 * STRESS TEST §4, TRANSCRIBED. Read a row as a sentence: *"an agent may read, scoped; may not edit
 * a human's draft; may never publish."* Where the matrix says an agent may do something "later
 * (needs agent grants)", the cell is `never` TODAY — agent grants live in `kernel/auth` and are
 * explicitly out of this plan (§7), and a cell that anticipates a grant that does not exist is a
 * cell that is wrong now.
 */
const MATRIX: Record<RosterAct, Record<RosterActorKind, Cell>> = {
  read: { user: grant(ROSTER_READ), copilot: grant(ROSTER_READ), agent: grant(ROSTER_READ), system: open, patient: never },

  // The proposer (R9) runs as a named `system` job and drafts a month marked `origin='machine'`.
  // A user drafting by hand is drafting a human-origin period, which is `propose`/`edit`, not this.
  draft_machine_period: { user: grant(ROSTER_MANAGE), copilot: never, agent: never, system: open, patient: never },

  // S2(a): the SR's v2 and the swap's v3 both drafted from v1. A machine must not be the second
  // writer on a draft a person is working in — it cannot see what they meant, only what they typed.
  edit_human_draft: { user: grant(ROSTER_MANAGE), copilot: never, agent: never, system: never, patient: never },

  // A copilot MAY draft a cover or a swap: that is the whole value of it at 02:00. It may not
  // confirm one, and `propose` never writes anything live — R8's `simulate` is the read behind it.
  propose: { user: grant(ROSTER_MANAGE), copilot: grant(ROSTER_MANAGE), agent: never, system: open, patient: never },

  // Accepting a `block` finding is a clinician deciding the hospital will run short tonight and
  // signing their name to it. There is no machine version of that act.
  accept_warning: { user: grant(ROSTER_PUBLISH), copilot: never, agent: never, system: never, patient: never },

  publish: { user: grant(ROSTER_PUBLISH), copilot: never, agent: never, system: never, patient: never },

  declare: { user: grant(ROSTER_PUBLISH), copilot: never, agent: never, system: never, patient: never },

  acknowledge: { user: grant(ROSTER_READ), copilot: never, agent: never, system: never, patient: never },

  // The ladder's own pacing raises these; a human may always raise one about their own unit.
  nag: { user: grant(ROSTER_READ), copilot: never, agent: open, system: open, patient: never },

  /**
   * `open` for a person, and the function enforces the part a matrix cannot: you may file YOUR OWN
   * absence holding nothing at all — a junior resident asking for two days is not an act on the
   * roster and must not need a roster string — and filing somebody ELSE's additionally requires
   * `roster.periods.manage`.
   *
   * **`never` for the copilot**, which is the one cell worth arguing. A leave request carries a
   * reason, and the reason is *"my father is in ICU"* or *"chemotherapy"* — the single most
   * sensitive string this phase stores, and the one A-4/L-13 says never reaches an external model.
   * A copilot that files one has to handle it. The person can file it themselves in the same
   * number of taps, so the cell costs nothing and closes the path.
   */
  request_absence: { user: open, copilot: never, agent: never, system: never, patient: never },
};

export type RosterActVerdict =
  /** Permitted for this kind of actor. `permission` is what `access.ts` must then check, or null. */
  { readonly permission: RosterPermission | null };

/**
 * May this KIND of actor perform this act at all? Throws `act_not_available_to_actor` when not.
 *
 * It answers nothing about what the actor HOLDS — that is `requireRosterAct` in `access.ts`, which
 * calls this first. The split is deliberate: this half is pure, synchronous and total, so the V8
 * enumeration can walk every cell of it without a database.
 */
export function rosterActPolicy(actor: Actor, act: RosterAct, via: RosterVia = "direct"): RosterActVerdict {
  const kind: RosterActorKind = actor.type === "user" && via === "copilot" ? "copilot" : actor.type;
  const cell = MATRIX[act][kind];
  if (cell.verdict === "never") {
    throw new RosterError("act_not_available_to_actor", undefined, { act, actorType: actor.type, via });
  }
  return { permission: cell.verdict === "grant" ? cell.permission : null };
}

/** The matrix, for the census test and for anything that wants to render it. Never for deciding. */
export function rosterActMatrix(): Record<RosterAct, Record<RosterActorKind, Cell["verdict"]>> {
  const out = {} as Record<RosterAct, Record<RosterActorKind, Cell["verdict"]>>;
  for (const act of ROSTER_ACTS) {
    const row = {} as Record<RosterActorKind, Cell["verdict"]>;
    for (const kind of ROSTER_ACTOR_KINDS) row[kind] = MATRIX[act][kind].verdict;
    out[act] = row;
  }
  return out;
}
