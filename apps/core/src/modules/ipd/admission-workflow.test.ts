import { IPD_INTENTS } from "@hmis/contracts";
import { defineWorkflow, WorkflowValidationError } from "../../kernel/workflow/definition";
import {
  ADMISSION_TRANSITIONS, ADMISSION_WORKFLOW_DEF_KEY, IPD_ACTOR_ROLE_KEYS, admissionIntentFor, admissionWorkflowDefinition,
} from "./admission-workflow";

/**
 * E0.2 (#714) — the admission workflow (spec §0B; spec v4.6 §10.2: one instance per admission). The engine's
 * own validator runs at import (`defineWorkflow`); the graph checks below are run AGAIN, independently, so a
 * future change to the engine cannot quietly stop checking what this definition depends on.
 */
const def = admissionWorkflowDefinition;
const names = def.states.map((s) => s.name);
const terminals = new Set(def.states.filter((s) => s.terminal).map((s) => s.name));
const edge = (from: string, to: string) => ADMISSION_TRANSITIONS.find((t) => t.from === from && t.to === to);

describe("the IPD admission workflow definition", () => {
  it("passes the kernel validator and starts at requested", () => {
    expect(defineWorkflow(def).key).toBe(ADMISSION_WORKFLOW_DEF_KEY);
    expect(def.initialState).toBe("requested");
  });

  it("has no dangling state: every state is reachable from requested", () => {
    const seen = new Set([def.initialState]);
    const queue = [def.initialState];
    while (queue.length) {
      const at = queue.shift()!;
      for (const t of def.transitions) if (t.from === at && !seen.has(t.to)) { seen.add(t.to); queue.push(t.to); }
    }
    expect(names.filter((n) => !seen.has(n))).toEqual([]);
  });

  it("every non-terminal state reaches a terminal", () => {
    const reaches = new Set(terminals);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of def.transitions) if (reaches.has(t.to) && !reaches.has(t.from)) { reaches.add(t.from); grew = true; }
    }
    expect(names.filter((n) => !reaches.has(n))).toEqual([]);
  });

  it("every terminal has no outgoing edge", () => {
    expect(def.transitions.filter((t) => terminals.has(t.from))).toEqual([]);
  });

  it("every transition names an intent that exists, and the engine's edges are exactly the named ones", () => {
    for (const t of ADMISSION_TRANSITIONS) expect([t.intent, t.intent in IPD_INTENTS]).toEqual([t.intent, true]);
    expect(def.transitions.map((t) => `${t.from}>${t.to}`).sort())
      .toEqual(ADMISSION_TRANSITIONS.map((t) => `${t.from}>${t.to}`).sort());
  });

  it("a transition's roles are the role keys of its intent's actors (plus system for a timer edge)", () => {
    for (const t of def.transitions) {
      const intent = admissionIntentFor(t.from, t.to)!;
      const expected = new Set(IPD_INTENTS[intent].actors.flatMap((a) => IPD_ACTOR_ROLE_KEYS[a]));
      if (edge(t.from, t.to)?.timer) expected.add("system");
      expect([intent, [...t.roles].sort()]).toEqual([intent, [...expected].sort()]);
    }
  });

  it("has the §0B spine and its named side doors", () => {
    expect(edge("requested", "reserved")?.intent).toBe("reserve_bed");
    expect(edge("reserved", "admitted")?.intent).toBe("admit");
    expect(edge("admitted", "transferring")?.intent).toBe("start_transfer");
    expect(edge("transferring", "admitted")?.intent).toBe("accept_handover");
    expect(edge("admitted", "fit_declared")?.intent).toBe("declare_fit");
    expect(edge("fit_declared", "admitted")?.intent).toBe("cancel_fit");
    expect(edge("discharging", "discharged")?.intent).toBe("scan_gate_pass");
    expect(edge("requested", "cancelled")).toBeDefined();
    expect(edge("reserved", "cancelled")).toBeDefined();
    expect(edge("admitted", "lama")?.intent).toBe("record_lama");
    expect(edge("admitted", "absconded")?.intent).toBe("record_abscond");
    expect(edge("admitted", "deceased")?.intent).toBe("record_death");
    // The discharge cascade is a state the stay must pass through: no admitted → discharged shortcut.
    expect(edge("admitted", "discharged")).toBeUndefined();
    expect(edge("fit_declared", "discharged")).toBeUndefined();
  });

  it("the transferring state escalates when no nurse accepts within 30 minutes (§4.4)", () => {
    const transferring = def.states.find((s) => s.name === "transferring")!;
    expect(transferring.sla).toMatchObject({ minutes: 30, alerting: "active" });
  });

  it("a definition with a dangling state is refused by the engine (the validator is live, not decorative)", () => {
    const broken = { ...def, states: [...def.states, { name: "limbo", sla: { minutes: 5, alerting: "record_only" } }] };
    expect(() => defineWorkflow(broken)).toThrow(WorkflowValidationError);
  });
});
