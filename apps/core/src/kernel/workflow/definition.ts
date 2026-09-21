import { z } from "zod";

export type ChangeClass = "A" | "B" | "C";

const KEY_RE = /^[a-z][a-z0-9_]*$/;

/**
 * ═══ PHASE O T1 — TWO CLOCKS, TWO LADDERS ═══
 *
 * `escalation` (shipped) is a chain of DELTAS anchored on the breach: rung k fires at
 * `entry + minutes + Σ afterMinutes[0..k]`, scheduled one rung at a time as the previous one
 * fires. Seven tests pin that arithmetic and none of them moves.
 *
 * `ladder` (new) is a set of PERCENTAGES of the budget, anchored at STATE ENTRY and all
 * scheduled at once: a rung at 70 % of a six-hour budget fires at 4 h 12 m, not at six hours
 * plus something. That is what makes a budget change re-schedulable (`rescheduleBudget`) and a
 * storm coalescible (C4) — a chain of deltas is neither, because each rung's time is only known
 * once its predecessor has fired.
 *
 * The two are mutually exclusive per state, and `defineWorkflow` refuses a state that declares
 * both: they would schedule two independent sets of escalation timers over one silence.
 *
 * `respondMinutes` is the OTHER clock. Silence and lateness are different failures — an ack
 * stops the respond timer and never touches the budget — so it is a separate timer kind rather
 * than a rung at some small percentage.
 */
const ladderRungSchema = z.object({
  /** Of the budget. Over 100 is the point: a rung at 150 % is the one that fires when it is late. */
  atPercent: z.number().int().min(1).max(400),
  toRole: z.string().min(1),
});

const slaSchema = z.object({
  minutes: z.number().int().positive(),
  alerting: z.enum(["active", "record_only"]),
  escalation: z
    .array(z.object({ afterMinutes: z.number().int().positive(), toRole: z.string().min(1) }))
    .optional(),
  respondMinutes: z.number().int().positive().optional(),
  ladder: z.array(ladderRungSchema).min(1).optional(),
});

const stateSchema = z.object({
  name: z.string().min(1),
  terminal: z.boolean().optional(),
  sla: slaSchema.optional(),
});

const transitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  roles: z.array(z.string().min(1)).min(1),
});

const definitionSchema = z.object({
  key: z.string().regex(KEY_RE, "definition key must be lowercase snake_case"),
  title: z.string().min(1),
  changeClass: z.enum(["A", "B", "C"]),
  initialState: z.string().min(1),
  states: z.array(stateSchema).min(1),
  transitions: z.array(transitionSchema),
});

export type LadderRungSpec = z.infer<typeof ladderRungSchema>;
export type SlaSpec = z.infer<typeof slaSchema>;
export type StateSpec = z.infer<typeof stateSchema>;
export type TransitionSpec = z.infer<typeof transitionSchema>;
export type WorkflowDefinition = z.infer<typeof definitionSchema>;

export class WorkflowValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid workflow definition:\n- ${problems.join("\n- ")}`);
    this.name = "WorkflowValidationError";
  }
}

/**
 * Validates a workflow definition (spec §10.2/§10.3 + the §18 no-dangling-paths rule).
 * Pure — no DB, no clock. Collects every problem into a single throw so an author
 * fixes a definition in one pass, not one error at a time.
 */
export function defineWorkflow(defJson: unknown): WorkflowDefinition {
  const parsed = definitionSchema.safeParse(defJson);
  if (!parsed.success) {
    throw new WorkflowValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const def = parsed.data;
  const problems: string[] = [];

  const names = def.states.map((s) => s.name);
  const nameSet = new Set(names);
  if (nameSet.size !== names.length) problems.push("state names must be unique");

  const terminals = def.states.filter((s) => s.terminal === true).map((s) => s.name);
  if (terminals.length === 0) problems.push("at least one state must be terminal");

  if (!nameSet.has(def.initialState)) {
    problems.push(`initialState "${def.initialState}" is not a declared state`);
  } else if (def.states.find((s) => s.name === def.initialState)?.terminal === true) {
    problems.push(`initialState "${def.initialState}" must not be a terminal state`);
  }

  for (const s of def.states) {
    if (s.terminal === true && s.sla !== undefined) {
      problems.push(`terminal state "${s.name}" must not carry an SLA`);
    }
    if (s.terminal !== true && s.sla === undefined) {
      problems.push(`non-terminal state "${s.name}" must carry an SLA (spec §10.3: structure everywhere)`);
    }
    // PHASE O T1 — the two ladder shapes are alternatives, never a pair: both scheduled over one
    // silence would climb twice, to two different people, from two different anchors.
    if (s.sla?.escalation !== undefined && s.sla.ladder !== undefined) {
      problems.push(`state "${s.name}" declares both escalation and ladder — a state may declare one or the other`);
    }
    // Strictly ascending, so "the highest rung that is due" (the coalescing rule, C4) names
    // exactly one rung, and so a reader can see the order the hospital climbs in.
    const ladder = s.sla?.ladder;
    if (ladder !== undefined) {
      for (let i = 1; i < ladder.length; i += 1) {
        if (ladder[i]!.atPercent <= ladder[i - 1]!.atPercent) {
          problems.push(`state "${s.name}" ladder percents must be strictly ascending (${String(ladder[i - 1]!.atPercent)} then ${String(ladder[i]!.atPercent)})`);
          break;
        }
      }
    }
  }

  const terminalSet = new Set(terminals);
  const seenPairs = new Set<string>();
  for (const t of def.transitions) {
    if (!nameSet.has(t.from)) problems.push(`transition from unknown state "${t.from}"`);
    if (!nameSet.has(t.to)) problems.push(`transition to unknown state "${t.to}"`);
    if (terminalSet.has(t.from)) problems.push(`terminal state "${t.from}" must have no outgoing transitions`);
    const pair = `${t.from}→${t.to}`;
    if (seenPairs.has(pair)) problems.push(`duplicate transition ${pair}`);
    seenPairs.add(pair);
  }

  // Graph checks only run over a structurally sound definition — otherwise they'd
  // report noise derived from problems already listed above.
  if (problems.length === 0) {
    const out = new Map<string, string[]>(names.map((n) => [n, []]));
    const into = new Map<string, string[]>(names.map((n) => [n, []]));
    for (const t of def.transitions) {
      out.get(t.from)!.push(t.to);
      into.get(t.to)!.push(t.from);
    }

    const reachable = new Set<string>([def.initialState]);
    const queue = [def.initialState];
    while (queue.length > 0) {
      for (const next of out.get(queue.shift()!)!) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    for (const n of names) {
      if (!reachable.has(n)) problems.push(`state "${n}" is unreachable from "${def.initialState}"`);
    }

    // Reverse reachability from the terminals: every reachable state must be able
    // to finish (spec §18 — "every branch reaches a terminal state").
    const reachesTerminal = new Set<string>(terminals);
    const rqueue = [...terminals];
    while (rqueue.length > 0) {
      for (const prev of into.get(rqueue.shift()!)!) {
        if (!reachesTerminal.has(prev)) {
          reachesTerminal.add(prev);
          rqueue.push(prev);
        }
      }
    }
    for (const n of reachable) {
      if (!reachesTerminal.has(n)) {
        problems.push(`state "${n}" cannot reach any terminal state (dangling path, spec §18)`);
      }
    }
  }

  if (problems.length > 0) throw new WorkflowValidationError(problems);
  return def;
}

/** Re-parses a definition previously stored as jsonb. Throws if the stored row is corrupt. */
export function parseDefinition(stored: unknown): WorkflowDefinition {
  return defineWorkflow(stored);
}
