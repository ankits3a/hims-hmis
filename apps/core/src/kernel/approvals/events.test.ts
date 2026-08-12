import { approvalRequested, approvalGranted, approvalRejected } from "./events";

const actor = { type: "user", id: "01HREQUESTER0000000000000" } as const;

describe("approvals event definitions", () => {
  it("declares exactly the three catalog names under module approvals", () => {
    expect(approvalRequested.name).toBe("approval.requested");
    expect(approvalGranted.name).toBe("approval.granted");
    expect(approvalRejected.name).toBe("approval.rejected");
    for (const def of [approvalRequested, approvalGranted, approvalRejected]) {
      expect(def.module).toBe("approvals");
      expect(def.version).toBe(1);
    }
  });

  it("validates the requested payload via zod and carries correlationId through make()", () => {
    const input = approvalRequested.make({
      actor,
      correlationId: "01HINSTANCE00000000000000A",
      patientId: "01HPAT000000000000000000A",
      payload: {
        approvalId: "01HAPPROVAL000000000000000",
        typeKey: "discount_override",
        requesterId: actor.id,
        approverRole: "billing_head",
        urgencyClass: "routine",
        actedFirst: false,
        slaMinutes: 45,
        subjectType: "invoice",
        subjectId: "inv1",
        amountPaise: 50_000,
        cumulativePatientPaise: 50_000,
      },
    });
    expect(input.correlationId).toBe("01HINSTANCE00000000000000A");
    expect(input.patientId).toBe("01HPAT000000000000000000A");
    expect(() =>
      approvalRequested.make({ actor, payload: { approvalId: "x" } }),
    ).toThrow();
  });

  it("rejects an unknown urgency class and a missing note on decisions", () => {
    expect(() =>
      approvalRequested.make({
        actor,
        payload: {
          approvalId: "a", typeKey: "t", requesterId: "r", approverRole: "ar",
          urgencyClass: "critical", actedFirst: false, slaMinutes: 10,
          subjectType: "s", subjectId: "s1",
        },
      }),
    ).toThrow();
    expect(() =>
      approvalGranted.make({
        actor,
        payload: {
          approvalId: "a", typeKey: "t", requesterId: "r", decidedBy: "d",
          note: "", urgencyClass: "routine", actedFirst: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a valid decision payload on both granted and rejected", () => {
    const payload = {
      approvalId: "01HAPPROVAL000000000000000",
      typeKey: "discount_override",
      requesterId: "01HREQUESTER0000000000000",
      decidedBy: "01HAPPROVER00000000000000",
      note: "senior-citizen discount verified",
      urgencyClass: "routine",
      actedFirst: false,
    } as const;
    expect(approvalGranted.make({ actor, correlationId: "c1", payload }).name).toBe("approval.granted");
    expect(approvalRejected.make({ actor, correlationId: "c1", payload }).name).toBe("approval.rejected");
  });
});
