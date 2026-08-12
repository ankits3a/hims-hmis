import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { rolesHeldBy, listApprovals, getApproval } from "./worklist";
import { requestApproval } from "./requests";
import { approveRequest } from "./decisions";
import { registerApprovalType } from "./types";
import { approvalFlowDefinition } from "./flow";
import { createDraft, activateDefinition } from "../workflow/definitions";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { grantTempRole } from "../auth/temp-roles";
import { seedSodPairs } from "../auth/sod";
import { loadConfig } from "../config";
import { approvals, tempRoleGrants } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DRAFTER: Actor = { type: "user", id: "01HDRAFTER000000000000000" };
const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

describe("approver worklist", () => {
  let db: Db; let teardown: () => Promise<void>;
  let activator: Actor; let requester: Actor; let billingHead: Actor; let dutyDoctor: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const mk = async (username: string): Promise<Actor> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { type: "user", id };
    };
    activator = await mk("activator1");
    requester = await mk("requester1");
    billingHead = await mk("billing_head1");
    dutyDoctor = await mk("duty_doctor1");
    await createRole(db, "billing_head", "Billing Head");
    await createRole(db, "duty_doctor", "Duty Doctor");
    await assignRole(db, { userId: billingHead.id, roleKey: "billing_head", scopeType: "hospital" });
    await assignRole(db, { userId: dutyDoctor.id, roleKey: "duty_doctor", scopeType: "department", scopeId: "icu" });

    for (const [typeKey, approverRole, urgencyClass, actFirstAllowed] of [
      ["discount_override", "billing_head", "routine", false],
      ["icu_admission", "duty_doctor", "emergency", true],
    ] as const) {
      const def = approvalFlowDefinition({
        typeKey, title: typeKey, approverRole, closureSlaMinutes: 45,
      });
      const { definitionId } = await createDraft(db, DRAFTER, def);
      await activateDefinition(db, activator, definitionId);
      await registerApprovalType(db, activator, {
        typeKey, title: typeKey, approverRole, urgencyClass, actFirstAllowed,
      });
    }
  });

  async function file(typeKey: string, subjectId: string): Promise<string> {
    const { approvalId } = await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey, subject: { type: "test", id: subjectId },
        ...(typeKey === "icu_admission"
          ? { actFirst: true, requestNote: "unstable — acted first" }
          : {}),
      }),
    );
    return approvalId;
  }

  it("rolesHeldBy: permanent any-scope + unexpired temp grants, deduped and sorted", async () => {
    await grantTempRole(db, cfg, activator, {
      userId: billingHead.id, roleKey: "duty_doctor", reason: "cover", ttlMinutes: 30,
    });
    // temp_role_grants.role_key is FK'd to roles (Plan 02 schema) — the role must exist
    // before the direct expired-grant insert below.
    await createRole(db, "expired_role", "Expired Role");
    await db.insert(tempRoleGrants).values({
      id: "01HGRANTLAPSED00000000000A", userId: billingHead.id, roleKey: "expired_role",
      grantedBy: activator.id, kind: "granted", reason: "lapsed",
      expiresAt: new Date(Date.now() - 60_000),
    });
    await withTx(db, async (tx) => {
      expect(await rolesHeldBy(tx, billingHead.id)).toEqual(["billing_head", "duty_doctor"]);
      expect(await rolesHeldBy(tx, requester.id)).toEqual([]);
    });
  });

  it("auto-scopes to the caller's held roles", async () => {
    const discountId = await file("discount_override", "s1");
    await file("icu_admission", "s2");
    const forBilling = await listApprovals(db, billingHead);
    expect(forBilling.total).toBe(1);
    expect(forBilling.items.map((i) => i.id)).toEqual([discountId]);
    const forRequester = await listApprovals(db, requester); // holds no approver role
    expect(forRequester).toEqual({ items: [], total: 0 });
  });

  it("orders emergency before routine, then oldest first", async () => {
    const routineOld = await file("discount_override", "s1");
    const routineNew = await file("discount_override", "s2");
    const emergency = await file("icu_admission", "s3");
    // Make s1 visibly older (requestedAt is a DB default; backdate directly).
    await db.update(approvals)
      .set({ requestedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(approvals.id, routineOld));
    await assignRole(db, { userId: billingHead.id, roleKey: "duty_doctor", scopeType: "hospital" });
    const list = await listApprovals(db, billingHead);
    expect(list.items.map((i) => i.id)).toEqual([emergency, routineOld, routineNew]);
  });

  it("filters: typeKey, urgencyClass, approverRole (narrowing only), olderThanMinutes, status", async () => {
    const discountId = await file("discount_override", "s1");
    await file("icu_admission", "s2");
    await assignRole(db, { userId: billingHead.id, roleKey: "duty_doctor", scopeType: "hospital" });
    expect((await listApprovals(db, billingHead, { typeKey: "discount_override" })).items.map((i) => i.id)).toEqual([discountId]);
    expect((await listApprovals(db, billingHead, { urgencyClass: "emergency" })).total).toBe(1);
    expect((await listApprovals(db, billingHead, { approverRole: "billing_head" })).total).toBe(1);
    // Narrowing only: filtering on a role the caller does NOT hold returns nothing.
    expect(await listApprovals(db, requester, { approverRole: "billing_head" })).toEqual({ items: [], total: 0 });
    expect((await listApprovals(db, billingHead, { olderThanMinutes: 30 })).total).toBe(0);
    await db.update(approvals)
      .set({ requestedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(approvals.id, discountId));
    expect((await listApprovals(db, billingHead, { olderThanMinutes: 30 })).total).toBe(1);
    // status defaults to pending; decided rows appear only when asked for.
    await approveRequest(db, billingHead, { approvalId: discountId, note: "fine" });
    expect((await listApprovals(db, billingHead, { typeKey: "discount_override" })).total).toBe(0);
    expect((await listApprovals(db, billingHead, { status: "granted" })).total).toBe(1);
  });

  it("paginates with a stable total", async () => {
    for (let i = 0; i < 5; i += 1) {
      await file("discount_override", `s${i}`);
    }
    const page1 = await listApprovals(db, billingHead, { limit: 2, offset: 0 });
    const page2 = await listApprovals(db, billingHead, { limit: 2, offset: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(typeof page1.total).toBe("number"); // count(*) arrives as text — must be forced
    expect(new Set([...page1.items, ...page2.items].map((i) => i.id)).size).toBe(4);
  });

  it("getApproval returns the row or null; non-user actors are refused a worklist", async () => {
    const id = await file("discount_override", "s1");
    expect((await getApproval(db, id))?.id).toBe(id);
    expect(await getApproval(db, "01HNOSUCH0000000000000000")).toBeNull();
    await expect(listApprovals(db, { type: "agent", id: "a1" })).rejects.toMatchObject({
      code: "user_actor_required",
    });
  });
});
