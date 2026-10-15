import { taskKind } from "../../modules/tasks";
import "./jobs";

/**
 * ER review (2026-10-15) — the worker's task clock must know the emergency module's kinds. The worker process loads them
 * through `jobs.ts` (`worker.ts` → `registerAllJobs` → `modules/emergency`, whose index defines them at import), not
 * through `worker.module.ts`; this file imports only what `worker.ts` imports for its jobs and the tasks index.
 */
describe("the worker process knows the emergency module's task kinds", () => {
  it("ER lane 2 — re-triage and door-to-triage are defined, on the casualty nurses' skill", () => {
    expect(taskKind("er_retriage")).toMatchObject({ skill: "er_triage", escalateTo: "er_nurse", doneWithinMin: 15 });
    expect(taskKind("er_triage_due")).toMatchObject({ skill: "er_triage", escalateTo: "er_nurse", doneWithinMin: 5 });
  });

  it("ER lane 4 — the police-intimation kind is defined, on the MLC desk's skill, its own rung the casualty nurses'", () => {
    expect(taskKind("er_mlc_intimation")).toMatchObject({ skill: "er_mlc", escalateTo: "er_nurse", doneWithinMin: 30 });
  });
});
