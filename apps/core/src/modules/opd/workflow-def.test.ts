import { defineWorkflow } from "../../kernel/workflow/definition";
import { OPD_VISIT_DEFINITION_JSON, OPD_VISIT_DEF_KEY, OPD_VISIT_STATES, opdVisitDefinition } from "./workflow-def";
import { OPD_ROLE_KEYS } from "./config";

describe("opd_visit workflow definition (data)", () => {
  it("validates against Plan 03's defineWorkflow: 6 states, 8 transitions, Class A, initial registered", () => {
    const def = opdVisitDefinition();
    expect(def.key).toBe(OPD_VISIT_DEF_KEY);
    expect(def.changeClass).toBe("A");
    expect(def.initialState).toBe("registered");
    expect(def.states.map((s) => s.name)).toEqual([...OPD_VISIT_STATES]);
    expect(def.transitions).toHaveLength(8);
    expect(defineWorkflow(OPD_VISIT_DEFINITION_JSON)).toEqual(def); // the JSON constant IS what the runbook posts
  });
  it("the OPD wait is the active alert: waiting carries a 45-min SLA with a two-rung ladder; every other non-terminal is record_only", () => {
    const def = opdVisitDefinition();
    const waiting = def.states.find((s) => s.name === "waiting")!;
    expect(waiting.sla).toEqual({ minutes: 45, alerting: "active", escalation: [{ afterMinutes: 15, toRole: "front_office_supervisor" }, { afterMinutes: 30, toRole: "duty_manager" }] });
    for (const name of ["registered", "in_consultation", "awaiting_results"]) {
      expect(def.states.find((s) => s.name === name)!.sla!.alerting).toBe("record_only");
    }
    expect(def.states.filter((s) => s.terminal).map((s) => s.name)).toEqual(["completed", "abandoned"]);
  });
  it("every transition role is a seeded OPD role key", () => {
    const keys = new Set(OPD_ROLE_KEYS.map((r) => r.key));
    for (const t of opdVisitDefinition().transitions) for (const r of t.roles) expect(keys.has(r)).toBe(true);
  });
});
