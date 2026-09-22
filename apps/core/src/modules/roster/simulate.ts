import type { Db, Tx } from "../../kernel/db/client";
import { absentUserIds } from "./absences";
import { periodWithAssignments } from "./periods";
import type { RosterAssignmentRow } from "./periods";
import { teamMembers } from "./teams";
import { validate } from "./validator";
import type { HypotheticalRoster, RosterFinding } from "./validator";

/**
 * PHASE R (R8) — **WHAT IF?**
 *
 * A head asks two questions about a roster that does not exist yet: *what would break*, and *who
 * could do it instead*. `simulate()` answers both without touching a row.
 *
 * ═══ IT WRITES NOTHING, AND THAT IS ASSERTED RATHER THAN INTENDED ═══
 *
 * The deltas are applied to an in-memory copy of the assignment rows and handed to `validate()` as
 * a hypothetical. No insert, no update, no stamp, and no `now` parameter it could stamp with. The
 * test that guards this counts rows in every roster table before and after — because "it doesn't
 * write" is the kind of claim that stays true right up until somebody adds a convenience audit
 * line, and a reviewer reading the function would not see it.
 *
 * ═══ `excluded[].reason` IS A RULE CODE, AND AN ABSENCE IS `unavailable` ═══
 *
 * Every exclusion names the rule that produced it, so a screen can say *why* somebody is not on the
 * list in the hospital's own vocabulary. With exactly one deliberate flattening: a person on
 * approved leave is **`unavailable`**, never the KIND of leave they are on.
 *
 * A what-if is run by whoever is trying to fill a hole — a night administrator, a senior resident,
 * a clerk. "Dr Rao — maternity leave" or "Dr Khan — bereavement" would tell all of them a fact
 * about a colleague's life that filling a slot never required them to know. The exclusion carries
 * exactly what the decision needs: this person cannot be asked. `absences.ts` redacts the reason
 * for the same reason (D6), and this is that rule surviving into the layer above it.
 */

export type SimulateDelta =
  | { readonly kind: "fill"; readonly assignmentId: string; readonly userId: string | null }
  | { readonly kind: "remove"; readonly assignmentId: string }
  | { readonly kind: "add"; readonly slot: RosterAssignmentRow };

export type Exclusion = {
  readonly userId: string;
  /** A rule code, never prose, and never the kind of an absence. */
  readonly reason: string;
};

export type SimulateResult = {
  readonly findings: readonly RosterFinding[];
  /** Who could take the slot named in `forAssignmentId`, best-effort and in id order. */
  readonly candidates: readonly string[];
  readonly excluded: readonly Exclusion[];
};

export type SimulateOptions = {
  /** The hole being filled. Candidates and exclusions are about THIS slot. */
  readonly forAssignmentId?: string;
  /** Who to consider. Defaults to the members of the slot's own team. */
  readonly pool?: readonly string[];
};

const HOUR_MS = 3_600_000;

/** Apply the deltas to a COPY. The caller's rows are never mutated. */
function applyDeltas(
  rows: readonly RosterAssignmentRow[], deltas: readonly SimulateDelta[],
): RosterAssignmentRow[] {
  let out = rows.map((r) => ({ ...r }));
  for (const d of deltas) {
    if (d.kind === "fill") {
      out = out.map((r) => (r.id === d.assignmentId ? { ...r, userId: d.userId } : r));
    } else if (d.kind === "remove") {
      out = out.filter((r) => r.id !== d.assignmentId);
    } else {
      out = [...out, { ...d.slot }];
    }
  }
  return out;
}

export async function simulate(
  exec: Db | Tx,
  base: string | HypotheticalRoster,
  deltas: readonly SimulateDelta[] = [],
  opts: SimulateOptions = {},
): Promise<SimulateResult> {
  const loaded = typeof base === "string"
    ? await periodWithAssignments(exec, base)
    : { period: base.period, assignments: [...base.assignments] };
  const live = loaded.assignments.filter((a) => a.liveTo === null);
  const after = applyDeltas(live, deltas);

  const findings = await validate(exec, { period: loaded.period, assignments: after });

  if (opts.forAssignmentId === undefined) {
    return { findings, candidates: [], excluded: [] };
  }

  const slot = after.find((a) => a.id === opts.forAssignmentId)
    ?? live.find((a) => a.id === opts.forAssignmentId);
  if (slot === undefined) return { findings, candidates: [], excluded: [] };

  const pool = opts.pool !== undefined
    ? [...opts.pool]
    : slot.teamId === null
      ? []
      : (await teamMembers(exec, slot.teamId, slot.startsAt)).map((m) => m.userId);

  const absent = new Set(await absentUserIds(exec, slot.startsAt, slot.endsAt));

  const candidates: string[] = [];
  const excluded: Exclusion[] = [];

  for (const userId of [...new Set(pool)].sort()) {
    // Approved leave, said as `unavailable` and nothing more. See this file's header.
    if (absent.has(userId)) {
      excluded.push({ userId, reason: "unavailable" });
      continue;
    }

    // Already physically somewhere else across the window — R2's own refusal code, reused so the
    // what-if and the publish gate name the same fact the same way.
    const clash = after.some((a) =>
      a.id !== slot.id && a.userId === userId && a.mode === "presence" && slot.mode === "presence"
      && a.startsAt.getTime() < slot.endsAt.getTime()
      && a.endsAt.getTime() > slot.startsAt.getTime());
    if (clash) {
      excluded.push({ userId, reason: "presence_overlap" });
      continue;
    }

    // What this person's roster would look like if they took it. The rule codes that come back are
    // the exclusion reasons: no second opinion about rest, nights or hours lives here.
    const hypothetical = applyDeltas(after, [{ kind: "fill", assignmentId: slot.id, userId }]);
    const theirs = await validate(exec, { period: loaded.period, assignments: hypothetical });
    const newForThem = theirs.filter((f) =>
      f.userId === userId
      && !findings.some((b) => b.userId === userId && b.ruleKey === f.ruleKey
        && b.assignmentId === f.assignmentId));

    const blocking = newForThem.find((f) => f.severity === "block");
    if (blocking !== undefined) {
      excluded.push({ userId, reason: blocking.ruleKey });
      continue;
    }
    const warned = newForThem.find((f) => f.severity === "warn");
    if (warned !== undefined) {
      excluded.push({ userId, reason: warned.ruleKey });
      continue;
    }
    candidates.push(userId);
  }

  return { findings, candidates, excluded };
}

/** Hours a person is already carrying inside a window — the number a head asks for next. */
export const hoursCarried = (
  rows: readonly RosterAssignmentRow[], userId: string, from: Date, to: Date,
): number => rows
  .filter((a) => a.userId === userId && a.kind === "duty" && a.mode === "presence"
    && a.startsAt.getTime() < to.getTime() && a.endsAt.getTime() > from.getTime())
  .reduce((n, a) => n + (a.endsAt.getTime() - a.startsAt.getTime()) / HOUR_MS, 0);
