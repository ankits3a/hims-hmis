import {
  workflowDefinitionUpdated, slaBreached, escalationTriggered, instanceMigrated, instanceAborted,
} from "./events";

const actor = { type: "system", id: "test" } as const;

describe("workflow event definitions", () => {
  it("declares exactly the five catalog names under module workflow", () => {
    expect(workflowDefinitionUpdated.name).toBe("workflow.definition.updated");
    expect(slaBreached.name).toBe("sla.breached");
    expect(escalationTriggered.name).toBe("escalation.triggered");
    expect(instanceMigrated.name).toBe("instance.migrated");
    expect(instanceAborted.name).toBe("instance.aborted");
    for (const def of [workflowDefinitionUpdated, slaBreached, escalationTriggered, instanceMigrated, instanceAborted]) {
      expect(def.module).toBe("workflow");
      expect(def.version).toBe(1);
    }
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
