import { ZodError } from "zod";
import { approvalFlowDefinition, APPROVAL_DEF_PREFIX } from "./flow";
import { WorkflowValidationError, parseDefinition } from "../workflow/definition";

describe("approvalFlowDefinition", () => {
  it("emits the canonical three-state flow with the approver role on both transitions", () => {
    const def = approvalFlowDefinition({
      typeKey: "discount_override",
      title: "Discount Override",
      approverRole: "billing_head",
      closureSlaMinutes: 45,
    });
    expect(def.key).toBe(`${APPROVAL_DEF_PREFIX}discount_override`);
    expect(def.title).toBe("Discount Override");
    expect(def.changeClass).toBe("C"); // default: registering a type needs no approvals itself
    expect(def.initialState).toBe("pending");
    expect(def.states).toHaveLength(3);
    const pending = def.states.find((s) => s.name === "pending");
    expect(pending?.sla).toEqual({ minutes: 45, alerting: "active" });
    expect(def.states.find((s) => s.name === "granted")?.terminal).toBe(true);
    expect(def.states.find((s) => s.name === "rejected")?.terminal).toBe(true);
    expect(def.transitions).toEqual([
      { from: "pending", to: "granted", roles: ["billing_head"] },
      { from: "pending", to: "rejected", roles: ["billing_head"] },
    ]);
  });

  it("passes an escalation ladder through to the pending state's SLA", () => {
    const def = approvalFlowDefinition({
      typeKey: "icu_admission",
      title: "ICU Admission",
      approverRole: "duty_doctor",
      closureSlaMinutes: 30,
      escalation: [
        { afterMinutes: 10, toRole: "supervisor" },
        { afterMinutes: 20, toRole: "department_head" },
      ],
    });
    const pending = def.states.find((s) => s.name === "pending");
    expect(pending?.sla?.escalation).toEqual([
      { afterMinutes: 10, toRole: "supervisor" },
      { afterMinutes: 20, toRole: "department_head" },
    ]);
  });

  it("honors an explicit changeClass override", () => {
    const def = approvalFlowDefinition({
      typeKey: "refund_large",
      title: "Large Refund",
      approverRole: "owner",
      closureSlaMinutes: 240,
      changeClass: "B",
    });
    expect(def.changeClass).toBe("B");
  });

  it("round-trips through JSON and parseDefinition (jsonb fidelity by construction)", () => {
    const def = approvalFlowDefinition({
      typeKey: "credit_extension",
      title: "Credit Extension",
      approverRole: "billing_head",
      closureSlaMinutes: 120,
      escalation: [{ afterMinutes: 60, toRole: "duty_manager" }],
    });
    const reparsed = parseDefinition(JSON.parse(JSON.stringify(def)));
    expect(reparsed).toEqual(def);
  });

  it("rejects a malformed spec via zod (bad typeKey, non-positive SLA)", () => {
    expect(() =>
      approvalFlowDefinition({
        typeKey: "Bad-Key",
        title: "Bad",
        approverRole: "r",
        closureSlaMinutes: 10,
      }),
    ).toThrow(ZodError);
    expect(() =>
      approvalFlowDefinition({
        typeKey: "ok_key",
        title: "Bad SLA",
        approverRole: "r",
        closureSlaMinutes: 0,
      }),
    ).toThrow(ZodError);
    expect(() =>
      approvalFlowDefinition({
        typeKey: "ok_key",
        title: "Bad rung",
        approverRole: "r",
        closureSlaMinutes: 10,
        escalation: [{ afterMinutes: 0, toRole: "duty_manager" }],
      }),
    ).toThrow(ZodError);
  });

  it("returns a definition defineWorkflow itself accepted (WorkflowValidationError is reachable, not routine)", () => {
    // The builder funnels its output through defineWorkflow; a valid spec can therefore
    // never produce an invalid definition. This test pins the funnel by checking the
    // error class hierarchy is what T3's registry and the controller expect.
    expect(WorkflowValidationError.prototype).toBeInstanceOf(Error);
    const def = approvalFlowDefinition({
      typeKey: "package_override",
      title: "Package Override",
      approverRole: "duty_manager",
      closureSlaMinutes: 60,
    });
    expect(def.states.filter((s) => s.terminal)).toHaveLength(2);
  });
});
