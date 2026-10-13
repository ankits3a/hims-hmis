import { taskKind } from "../../modules/tasks";
import { WORKER_TASK_KINDS } from "./worker.module";

/**
 * The task clock (`sweepTasks`) runs in the WORKER, and the kind registry is in-process (tasks MAP §4): a kind the
 * worker never loaded is swept with the default ladder and escalates to no one. This file imports only the worker
 * module and the tasks index — never an owning module — so the worker's own imports must define each kind.
 */
describe("the worker process knows the owning modules' task kinds", () => {
  it("E2.4 LINEN — linen_change is defined in the worker, with its own windows and escalation", () => {
    expect(WORKER_TASK_KINDS).toContain("linen_change");
    expect(taskKind("linen_change")).toMatchObject({ skill: "general", doneWithinMin: 60, escalateTo: "services_supervisor" });
  });

  it("E4.4 DIET — the delivery and ward-notice kinds are defined in the worker (its consumer imports the module)", () => {
    expect(WORKER_TASK_KINDS).toEqual(expect.arrayContaining(["diet_delivery", "diet_ward_notice"]));
    expect(taskKind("diet_delivery")).toMatchObject({ skill: "diet_ward", escalateTo: "services_supervisor" });
    expect(taskKind("diet_ward_notice")).toMatchObject({ skill: "diet_ward", doneWithinMin: 15 });
  });
});
