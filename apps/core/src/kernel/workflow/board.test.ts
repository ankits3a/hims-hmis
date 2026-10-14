import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser } from "../auth/identity";
import { assignRole, createRole } from "../auth/permissions";
import { seedSodPairs } from "../auth/sod";
import { approveDefinition, createDraft } from "./definitions";
import { readWorkflowBoard } from "./board";
import type { Db } from "../db/client";

/** GO-LIVE SCREENS — the board's read model: state, approvals received, roles still missing, the viewer's policy roles. */
const def = {
  key: "board_test", title: "Board test", changeClass: "A", initialState: "a",
  states: [{ name: "a", sla: { minutes: 30, alerting: "active" } }, { name: "b", terminal: true }],
  transitions: [{ from: "a", to: "b", roles: ["front_office"] }],
};

describe("readWorkflowBoard", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); await seedSodPairs(db); });

  it("shows a class A draft waiting for both roles, then for the owner alone after the MS approves", async () => {
    await createRole(db, "owner", "Owner");
    await createRole(db, "medical_superintendent", "MS");
    const ms = await createUser(db, { username: "ms", fullName: "The MS", password: "p1234567" });
    const owner = await createUser(db, { username: "own", fullName: "The Owner", password: "p1234567" });
    await assignRole(db, { userId: ms.id, roleKey: "medical_superintendent", scopeType: "hospital" });
    await assignRole(db, { userId: owner.id, roleKey: "owner", scopeType: "hospital" });
    const d = await createDraft(db, { type: "system", id: "drafter" }, def);

    const before = await readWorkflowBoard(db, owner.id);
    const row = before.definitions.find((x) => x.id === d.definitionId)!;
    expect(row).toMatchObject({ status: "draft", version: 1, missingRoles: ["owner", "medical_superintendent"], diff: null });
    expect(row.steps.transitions).toEqual([{ from: "a", to: "b", roles: ["front_office"] }]);
    expect(before.viewer.policyRoles).toEqual(["owner"]);

    await approveDefinition(db, { type: "user", id: ms.id }, { definitionId: d.definitionId, roleKey: "medical_superintendent", note: "ok by MS" });
    const after = (await readWorkflowBoard(db, ms.id));
    const r2 = after.definitions.find((x) => x.id === d.definitionId)!;
    expect(r2.missingRoles).toEqual(["owner"]);
    expect(r2.approvals).toMatchObject([{ approverName: "The MS", roleKey: "medical_superintendent" }]);
    expect(after.viewer.policyRoles).toEqual(["medical_superintendent"]);
  });
});
