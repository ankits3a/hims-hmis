import { NotFoundException } from "@nestjs/common";
import { WorkflowController } from "./workflow.controller";
import type { Db } from "../db/client";

/**
 * Decision 0085 invariant 1, dark by default — the workflow definitions board (`GET /workflow/definitions/board`, the
 * go-live screen behind `/admin/workflows`) is an IPD go-live surface: with `ipd` off (production, `HMIS_MODULES_ON`
 * empty) it answers 404 before it reads anything. The jest harness switches all ten on, so this test switches off.
 */
describe("decision 0085 — the workflow board is dark while ipd is off", () => {
  const saved = process.env.HMIS_MODULES_ON;
  afterEach(() => { process.env.HMIS_MODULES_ON = saved; });
  const untouchable = new Proxy({}, { get: () => { throw new Error("the board read the database while dark"); } }) as unknown as Db;
  const actor = { type: "user", id: "u-owner" } as const;

  it("ipd off: 404, and no read", async () => {
    process.env.HMIS_MODULES_ON = "";
    await expect(new WorkflowController(untouchable).board(actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("ipd on: the board is read", async () => {
    process.env.HMIS_MODULES_ON = "ipd";
    await expect(new WorkflowController(untouchable).board(actor)).rejects.toThrow("the board read the database while dark");
  });
});
