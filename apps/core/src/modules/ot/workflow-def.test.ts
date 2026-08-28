import { defineWorkflow } from "../../kernel/workflow/definition";
import {
  DAYCARE_CASE_DEF_KEY, OT_GATE_DEF_KEY, OT_WORKFLOW_DEFINITIONS, POSTPONE_REASONS,
  daycareCaseDefinition, otGateDefinition,
} from "./workflow-def";

/**
 * PLAN 15 T3 / DD4 — the two definitions, validated by the ENGINE rather than by a copy of its
 * rules. `defineWorkflow` runs at import time, so a definition that violated §10.3 or §18 would
 * fail this file at collection; the legs below assert the properties the engine does NOT check.
 */
describe("the OT workflow definitions (Plan 15 T3 / DD4)", () => {
  it("both validate under `defineWorkflow`, are Class A, and are the two the module ships", () => {
    // Re-run the validator on the exported objects: the constants are already the validator's
    // OUTPUT, so this proves the round trip a stored jsonb definition takes (`parseDefinition`).
    expect(defineWorkflow(daycareCaseDefinition).key).toBe(DAYCARE_CASE_DEF_KEY);
    expect(defineWorkflow(otGateDefinition).key).toBe(OT_GATE_DEF_KEY);
    expect(OT_WORKFLOW_DEFINITIONS.map((d) => ({ key: d.key, changeClass: d.changeClass })))
      .toEqual([
        { key: "daycare_case", changeClass: "A" },
        { key: "ot_gate", changeClass: "A" },
      ]);
  });

  /**
   * ═══ THE MATRIX'S WHOLE JOB, ASSERTED AS AN ABSENCE ═══
   *
   * There is no `signed_in → incision` edge. The WHO time-out is a STATE the case must pass
   * through, not a checkbox that can be skipped when the list is running late. The assertion is
   * written against the edge rather than against a comment because "we always do the time-out" is
   * exactly the kind of claim that is true until the day it is not.
   */
  it("has NO `signed_in → incision` path — the time-out is a state, not a checkbox", () => {
    const edge = daycareCaseDefinition.transitions.find((t) => t.from === "signed_in" && t.to === "incision");
    expect(edge).toBeUndefined();
    // And the ONLY way out of `signed_in` towards the knife is through `timed_out`.
    const fromSignedIn = daycareCaseDefinition.transitions.filter((t) => t.from === "signed_in").map((t) => t.to).sort();
    expect(fromSignedIn).toEqual(["deceased", "timed_out"]);
    // The mirror: `incision` is reachable from `timed_out` and from nowhere else at all.
    const intoIncision = daycareCaseDefinition.transitions.filter((t) => t.to === "incision").map((t) => t.from);
    expect(intoIncision).toEqual(["timed_out"]);
  });

  /**
   * B8 — the ORDER of the theatre states, asserted as a chain rather than as a set. A definition
   * carrying every state and a spurious short-cut would pass a set assertion and fail this one.
   */
  it("the theatre spine is a single ordered chain from `booked` to `discharged`", () => {
    const spine = [
      "booked", "listed", "ready", "in_holding", "signed_in", "timed_out", "incision",
      "closing", "signed_out", "in_recovery", "discharge_ready", "discharged",
    ];
    for (let i = 0; i < spine.length - 1; i += 1) {
      const from = spine[i]!;
      const to = spine[i + 1]!;
      expect({ edge: `${from}->${to}`, present: daycareCaseDefinition.transitions.some((t) => t.from === from && t.to === to) })
        .toEqual({ edge: `${from}->${to}`, present: true });
    }
    // No edge SKIPS a link in the chain — the property a set of states cannot express.
    for (let i = 0; i < spine.length; i += 1) {
      for (let j = i + 2; j < spine.length; j += 1) {
        const skip = daycareCaseDefinition.transitions.some((t) => t.from === spine[i] && t.to === spine[j]);
        expect({ skip: `${spine[i]!}->${spine[j]!}`, present: skip }).toEqual({ skip: `${spine[i]!}->${spine[j]!}`, present: false });
      }
    }
  });

  it("cancellation is reachable from every pre-`signed_in` state INCLUDING `in_holding`, and from none after", () => {
    const cancellable = daycareCaseDefinition.transitions.filter((t) => t.to === "cancelled").map((t) => t.from).sort();
    expect(cancellable).toEqual(["booked", "in_holding", "listed", "postponed", "ready"]);
    // A case that has been signed in cannot be "cancelled": it has happened. The exits after that
    // point are `deceased` (R-3.22) and the recovery three, and they mean different things.
    for (const after of ["signed_in", "timed_out", "incision", "closing", "signed_out", "in_recovery"]) {
      expect({ from: after, cancellable: cancellable.includes(after) }).toEqual({ from: after, cancellable: false });
    }
  });

  /** `postponed` comes BACK; `cancelled` does not. That difference is why one is terminal and one
   *  is a live state with an SLA — and why §3A keeps the deposit on a postponement. */
  it("`postponed` is a LIVE state that returns to `booked`; `cancelled` is terminal", () => {
    const postponed = daycareCaseDefinition.states.find((s) => s.name === "postponed")!;
    const cancelled = daycareCaseDefinition.states.find((s) => s.name === "cancelled")!;
    expect({ terminal: postponed.terminal ?? false, hasSla: postponed.sla !== undefined })
      .toEqual({ terminal: false, hasSla: true });
    expect({ terminal: cancelled.terminal, hasSla: cancelled.sla !== undefined })
      .toEqual({ terminal: true, hasSla: false });
    expect(daycareCaseDefinition.transitions.some((t) => t.from === "postponed" && t.to === "booked")).toBe(true);
    expect(daycareCaseDefinition.transitions.filter((t) => t.from === "cancelled")).toEqual([]);
  });

  /** F12 — `no_sterile_set` is a legal reason today even though the sterile-set GATE is 15c's: the
   *  set can be missing whether or not this system tracks sets. */
  it("carries `no_sterile_set` among the postponement reasons, before 15c builds the gate (F12)", () => {
    expect(POSTPONE_REASONS).toContain("no_sterile_set");
    expect(POSTPONE_REASONS).toContain("surgeon_no_show");
    expect(POSTPONE_REASONS).toContain("payer_denied");
    expect(POSTPONE_REASONS).toContain("patient_unfit");
  });

  /**
   * DD4's SLA ruling: record-only everywhere EXCEPT the two states where a delay has a patient or a
   * bay behind it. Asserted as a partition, so a well-meaning edit that made another state "active"
   * has to come here and argue for it.
   */
  it("exactly two states alert — `in_holding` (45 min, escalating) and `discharge_ready` (120 min)", () => {
    const active = daycareCaseDefinition.states
      .filter((s) => s.sla?.alerting === "active")
      .map((s) => ({ name: s.name, minutes: s.sla!.minutes, escalatesTo: s.sla!.escalation?.map((e) => e.toRole) ?? [] }));
    expect(active).toEqual([
      { name: "in_holding", minutes: 45, escalatesTo: ["ot_incharge"] },
      { name: "discharge_ready", minutes: 120, escalatesTo: [] },
    ]);
    // Every other non-terminal state carries a record-only SLA — the engine requires one and this
    // pins that none of them was quietly given an alert.
    const recordOnly = daycareCaseDefinition.states.filter((s) => s.sla?.alerting === "record_only");
    expect(recordOnly).toHaveLength(daycareCaseDefinition.states.filter((s) => s.terminal !== true).length - 2);
  });

  /**
   * DD4 — the two computed moves. `listed → ready` is `evaluateReadiness`'s and
   * `in_recovery → discharge_ready` is `evaluateDischargeReady`'s. Pinning `roles: ["system"]`
   * matters because giving either one a HUMAN role is precisely how a gate becomes skippable: a
   * coordinator who can move a case to `ready` does not need the gates to be satisfied.
   */
  it("the two COMPUTED transitions carry `system` and no human role", () => {
    const computed = daycareCaseDefinition.transitions.filter((t) => t.roles.includes("system"));
    expect(computed.map((t) => `${t.from}->${t.to}`)).toEqual(["listed->ready", "in_recovery->discharge_ready"]);
    for (const t of computed) expect(t.roles).toEqual(["system"]);
  });

  /** DD5 — three terminal exits, and `overridden` reachable by the two clinical roles ONLY. */
  it("the gate definition has three terminal exits and an override lane only two roles can reach", () => {
    expect(otGateDefinition.states.map((s) => ({ name: s.name, terminal: s.terminal ?? false }))).toEqual([
      { name: "open", terminal: false },
      { name: "satisfied", terminal: true },
      { name: "waived", terminal: true },
      { name: "overridden", terminal: true },
    ]);
    const override = otGateDefinition.transitions.find((t) => t.to === "overridden")!;
    expect(override.roles).toEqual(["surgeon", "anaesthetist"]);
    // The in-charge can WAIVE (only where the criteria allow) and cannot OVERRIDE — DD14's first
    // separation, expressed in the matrix as well as in the permission table.
    expect(override.roles).not.toContain("ot_incharge");
    expect(otGateDefinition.transitions.find((t) => t.to === "waived")!.roles).toContain("ot_incharge");
  });

  it("no state of either definition is unreachable or dangling — the engine's own §18 check, re-run", () => {
    // `defineWorkflow` throws on both; running it over a deliberately broken COPY is what proves the
    // check is live rather than assumed, which is rule 21's standard applied to a validator.
    // A DANGLING path: `postponed` stays reachable and loses every way out. Removing only its
    // `→ booked` edge is NOT enough — `postponed → cancelled` still reaches a terminal, which is
    // itself worth knowing: the two exits are independent safety properties, not one.
    const dangling = {
      ...daycareCaseDefinition,
      transitions: daycareCaseDefinition.transitions.filter((t) => t.from !== "postponed"),
    };
    expect(() => defineWorkflow(dangling)).toThrow(/cannot reach any terminal state/);

    // An UNREACHABLE state: nothing leads into `postponed` any more.
    const unreachable = {
      ...daycareCaseDefinition,
      transitions: daycareCaseDefinition.transitions.filter((t) => t.to !== "postponed"),
    };
    expect(() => defineWorkflow(unreachable)).toThrow(/is unreachable from "booked"/);

    // And the SHIPPED definitions pass both checks — the guard is real, not vacuous.
    expect(() => defineWorkflow(daycareCaseDefinition)).not.toThrow();
    expect(() => defineWorkflow(otGateDefinition)).not.toThrow();
  });
});
