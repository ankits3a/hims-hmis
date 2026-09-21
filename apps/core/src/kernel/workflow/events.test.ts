import {
  workflowDefinitionUpdated, slaBreached, escalationTriggered, instanceMigrated, instanceAborted,
  respondOverdue,
} from "./events";

const actor = { type: "system", id: "test" } as const;

describe("workflow event definitions", () => {
  // PHASE O T1 (2026-09-21): five -> six. `respond.overdue` is the first workflow event about
  // SILENCE rather than lateness, and it is a catalog ADDITION — every shipped name keeps its
  // version 1, because `escalation.triggered`'s two new payload fields are optional.
  it("declares exactly the six catalog names under module workflow", () => {
    expect(workflowDefinitionUpdated.name).toBe("workflow.definition.updated");
    expect(slaBreached.name).toBe("sla.breached");
    expect(escalationTriggered.name).toBe("escalation.triggered");
    expect(instanceMigrated.name).toBe("instance.migrated");
    expect(instanceAborted.name).toBe("instance.aborted");
    expect(respondOverdue.name).toBe("respond.overdue");
    for (const def of [workflowDefinitionUpdated, slaBreached, escalationTriggered, instanceMigrated, instanceAborted, respondOverdue]) {
      expect(def.module).toBe("workflow");
      expect(def.version).toBe(1);
    }
  });

  it("escalation.triggered still validates WITHOUT percent — a chain rung carries neither new field", () => {
    const chainRung = escalationTriggered.make({
      actor,
      payload: {
        instanceId: "01HINSTANCE00000000000000A", defKey: "test_flow", state: "open", rung: 0,
        role: "supervisor", resolvedUserIds: [], fallback: false, fallbackExhausted: false,
      },
    });
    // The ABSENCE is load-bearing: the obligations consumer files a delay record at
    // `percent >= 100`, and a chain rung defaulted to 0 would silently file none while a chain
    // rung defaulted to 100 would file one for every shipped approval ladder.
    expect((chainRung.payload as Record<string, unknown>).percent).toBeUndefined();
    expect((chainRung.payload as Record<string, unknown>).budgetMinutes).toBeUndefined();
  });

  it("respond.overdue carries ids, codes, instants and minutes — and refuses a payload without them", () => {
    const input = respondOverdue.make({
      actor,
      correlationId: "01HINSTANCE00000000000000A",
      payload: {
        instanceId: "01HINSTANCE00000000000000A", defKey: "approval_billing_refund",
        state: "pending", respondMinutes: 5, dueAt: new Date(0).toISOString(),
      },
    });
    expect(input.correlationId).toBe("01HINSTANCE00000000000000A");
    expect(() => respondOverdue.make({ actor, payload: { instanceId: "x" } })).toThrow();
  });

  it("validates payloads via zod and carries correlationId through make()", () => {
    const input = slaBreached.make({
      actor,
      correlationId: "01HINSTANCE00000000000000A",
      payload: {
        instanceId: "01HINSTANCE00000000000000A",
        defKey: "test_flow",
        definitionVersion: 1,
        state: "open",
        slaMinutes: 30,
        alerting: "active",
        dueAt: new Date(0).toISOString(),
      },
    });
    expect(input.correlationId).toBe("01HINSTANCE00000000000000A");
    expect(() =>
      slaBreached.make({ actor, payload: { instanceId: "x" } }),
    ).toThrow();
  });

  it("rejects an unknown action on workflow.definition.updated", () => {
    expect(() =>
      workflowDefinitionUpdated.make({
        actor,
        payload: {
          definitionId: "d", defKey: "k", version: 1, changeClass: "A", action: "deleted",
        },
      }),
    ).toThrow();
  });
});
