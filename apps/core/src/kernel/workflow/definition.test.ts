import { defineWorkflow, parseDefinition, WorkflowValidationError } from "./definition";

const VALID = {
  key: "test_flow",
  title: "Test Flow",
  changeClass: "C",
  initialState: "open",
  states: [
    {
      name: "open",
      sla: { minutes: 30, alerting: "active", escalation: [{ afterMinutes: 10, toRole: "duty_manager" }] },
    },
    { name: "in_progress", sla: { minutes: 60, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [
    { from: "open", to: "in_progress", roles: ["nurse"] },
    { from: "in_progress", to: "done", roles: ["nurse", "doctor"] },
    { from: "in_progress", to: "open", roles: ["doctor"] },
  ],
};

function problemsOf(def: unknown): string[] {
  try {
    defineWorkflow(def);
    return [];
  } catch (e) {
    if (e instanceof WorkflowValidationError) return e.problems;
    throw e;
  }
}

describe("defineWorkflow", () => {
  it("accepts a valid definition and returns it typed", () => {
    const def = defineWorkflow(VALID);
    expect(def.key).toBe("test_flow");
    expect(def.states).toHaveLength(3);
    expect(def.transitions).toHaveLength(3);
  });

  it("round-trips through JSON (parseDefinition on stored jsonb)", () => {
    const def = parseDefinition(JSON.parse(JSON.stringify(VALID)));
    expect(def.initialState).toBe("open");
  });

  it("rejects a malformed shape via zod (bad key, empty roles)", () => {
    expect(problemsOf({ ...VALID, key: "Bad-Key" }).join(" ")).toMatch(/key/);
    expect(
      problemsOf({
        ...VALID,
        transitions: [{ from: "open", to: "done", roles: [] }],
      }).join(" "),
    ).toMatch(/roles/);
  });

  it("rejects an unknown initialState", () => {
    expect(problemsOf({ ...VALID, initialState: "nowhere" })).toContain(
      'initialState "nowhere" is not a declared state',
    );
  });

  it("rejects a terminal initialState", () => {
    const def = {
      key: "degenerate",
      title: "Degenerate",
      changeClass: "C",
      initialState: "done",
      states: [{ name: "done", terminal: true }],
      transitions: [],
    };
    expect(problemsOf(def)).toContain('initialState "done" must not be a terminal state');
  });

  it("requires at least one terminal state", () => {
    const def = {
      key: "loop",
      title: "Loop",
      changeClass: "C",
      initialState: "a",
      states: [
        { name: "a", sla: { minutes: 5, alerting: "record_only" } },
        { name: "b", sla: { minutes: 5, alerting: "record_only" } },
      ],
      transitions: [
        { from: "a", to: "b", roles: ["r"] },
        { from: "b", to: "a", roles: ["r"] },
      ],
    };
    expect(problemsOf(def)).toContain("at least one state must be terminal");
  });

  it("requires an SLA on every non-terminal state and forbids it on terminals", () => {
    const def = {
      key: "sla_rules",
      title: "SLA Rules",
      changeClass: "C",
      initialState: "a",
      states: [
        { name: "a" },
        { name: "z", terminal: true, sla: { minutes: 5, alerting: "record_only" } },
      ],
      transitions: [{ from: "a", to: "z", roles: ["r"] }],
    };
    const problems = problemsOf(def);
    expect(problems).toContain(
      'non-terminal state "a" must carry an SLA (spec §10.3: structure everywhere)',
    );
    expect(problems).toContain('terminal state "z" must not carry an SLA');
  });

  it("rejects transitions referencing unknown states and duplicates", () => {
    const def = {
      ...VALID,
      transitions: [
        { from: "open", to: "gone", roles: ["r"] },
        { from: "open", to: "in_progress", roles: ["r"] },
        { from: "open", to: "in_progress", roles: ["r"] },
        { from: "in_progress", to: "done", roles: ["r"] },
      ],
    };
    const problems = problemsOf(def);
    expect(problems).toContain('transition to unknown state "gone"');
    expect(problems).toContain("duplicate transition open→in_progress");
  });

  it("rejects outgoing transitions from a terminal state", () => {
    const def = {
      ...VALID,
      transitions: [...VALID.transitions, { from: "done", to: "open", roles: ["r"] }],
    };
    expect(problemsOf(def)).toContain('terminal state "done" must have no outgoing transitions');
  });

  it("rejects duplicate state names", () => {
    const def = {
      ...VALID,
      states: [...VALID.states, { name: "open", sla: { minutes: 1, alerting: "record_only" } }],
    };
    expect(problemsOf(def)).toContain("state names must be unique");
  });

  it("rejects states unreachable from the initial state", () => {
    const def = {
      key: "orphan",
      title: "Orphan",
      changeClass: "C",
      initialState: "a",
      states: [
        { name: "a", sla: { minutes: 5, alerting: "record_only" } },
        { name: "b", sla: { minutes: 5, alerting: "record_only" } },
        { name: "z", terminal: true },
      ],
      transitions: [
        { from: "a", to: "z", roles: ["r"] },
        { from: "b", to: "z", roles: ["r"] },
      ],
    };
    expect(problemsOf(def)).toContain('state "b" is unreachable from "a"');
  });

  it("rejects dangling paths — a reachable state that cannot reach any terminal (spec §18)", () => {
    const def = {
      key: "dangling",
      title: "Dangling",
      changeClass: "C",
      initialState: "a",
      states: [
        { name: "a", sla: { minutes: 5, alerting: "record_only" } },
        { name: "trap", sla: { minutes: 5, alerting: "record_only" } },
        { name: "z", terminal: true },
      ],
      transitions: [
        { from: "a", to: "z", roles: ["r"] },
        { from: "a", to: "trap", roles: ["r"] },
      ],
    };
    expect(problemsOf(def)).toContain(
      'state "trap" cannot reach any terminal state (dangling path, spec §18)',
    );
  });

  it("collects every problem into one error", () => {
    const def = {
      ...VALID,
      initialState: "nowhere",
      states: [...VALID.states, { name: "open", sla: { minutes: 1, alerting: "record_only" } }],
    };
    expect(problemsOf(def).length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * ═══ PHASE O T1 — THE TWO NEW SLA KEYS, AND THE TWO PROBLEMS THEY CAN CAUSE ═══
 *
 * These are validation claims only: what `timers.ts` does with a ladder is `timers.test.ts`'s
 * business. What matters here is that a definition which cannot be scheduled coherently is
 * refused at AUTHORING time rather than discovered at 03:00 by a rung that fired twice.
 */
describe("defineWorkflow — percent ladders and the respond clock (phase O T1)", () => {
  const withSla = (sla: unknown): unknown => ({
    key: "ladder_flow",
    title: "Ladder Flow",
    changeClass: "C",
    initialState: "open",
    states: [{ name: "open", sla }, { name: "done", terminal: true }],
    transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
  });

  it("accepts a ladder and a respond clock together — they are different clocks, not alternatives", () => {
    const def = defineWorkflow(withSla({
      minutes: 360, alerting: "active", respondMinutes: 30,
      ladder: [{ atPercent: 40, toRole: "supervisor" }, { atPercent: 100, toRole: "duty_manager" }],
    }));
    expect(def.states[0]!.sla).toEqual({
      minutes: 360, alerting: "active", respondMinutes: 30,
      ladder: [{ atPercent: 40, toRole: "supervisor" }, { atPercent: 100, toRole: "duty_manager" }],
    });
  });

  it("refuses a state that declares BOTH escalation and ladder", () => {
    expect(() => defineWorkflow(withSla({
      minutes: 60, alerting: "active",
      escalation: [{ afterMinutes: 10, toRole: "supervisor" }],
      ladder: [{ atPercent: 100, toRole: "duty_manager" }],
    }))).toThrow(/declares both escalation and ladder/);
  });

  it("refuses ladder percents that are not strictly ascending — equal is not ascending either", () => {
    expect(() => defineWorkflow(withSla({
      minutes: 60, alerting: "active",
      ladder: [{ atPercent: 100, toRole: "a" }, { atPercent: 70, toRole: "b" }],
    }))).toThrow(/strictly ascending/);
    expect(() => defineWorkflow(withSla({
      minutes: 60, alerting: "active",
      ladder: [{ atPercent: 70, toRole: "a" }, { atPercent: 70, toRole: "b" }],
    }))).toThrow(/strictly ascending/);
  });

  it("a rung may sit ABOVE 100 % — that is the one that fires when the work is already late", () => {
    const def = defineWorkflow(withSla({
      minutes: 60, alerting: "active",
      ladder: [{ atPercent: 100, toRole: "a" }, { atPercent: 200, toRole: "b" }],
    }));
    expect(def.states[0]!.sla!.ladder!.map((r) => r.atPercent)).toEqual([100, 200]);
    // …but not arbitrarily far above it: 400 % is the ceiling, and an empty ladder is not a ladder.
    expect(() => defineWorkflow(withSla({ minutes: 60, alerting: "active", ladder: [{ atPercent: 401, toRole: "a" }] }))).toThrow();
    expect(() => defineWorkflow(withSla({ minutes: 60, alerting: "active", ladder: [] }))).toThrow();
    expect(() => defineWorkflow(withSla({ minutes: 60, alerting: "active", respondMinutes: 0 }))).toThrow();
  });

  it("the shipped shape is untouched: a state with neither key parses to exactly what it did", () => {
    const def = defineWorkflow(withSla({ minutes: 45, alerting: "active" }));
    expect(def.states[0]!.sla).toEqual({ minutes: 45, alerting: "active" });
  });
});
