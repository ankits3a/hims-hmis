import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { breakGlassGrants, events, phiAccessLog } from "../../kernel/db/schema";
import { pendingReviews, useBreakGlass } from "../../kernel/auth/break-glass";
import { breakGlassUsed } from "../../kernel/auth/events";
import { registerOpdCareContextProvider } from "./opd.module";
import { patientTimeline } from "./encounters";
import { OpdError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07a T3 — BREAK-GLASS REACHES A DECISION FOR THE FIRST TIME.
 *
 * The mechanism shipped complete and inert: the grants table, the guard check, the endpoints and
 * the mandatory after-the-fact review all existed, and `breakGlassBypass: true` appeared on ZERO
 * routes. It could not have helped the sealed-record case even if a route had opted in, because
 * that flag bypasses `@RequirePermission` at the guard and the sealed refusal is `hasPermission`
 * called directly inside `getPatient`. The two never met.
 *
 * The rule these assertions defend: ACCESS IS LOGGED, NOT BLOCKED — but the key is not a master
 * key. A grant is for one patient (or explicitly hospital-wide), it expires, and using it puts the
 * holder on a review queue with their stated reason attached.
 */
const T0 = new Date("2026-08-17T04:00:00.000Z");

describe("break-glass on the sealed read path (07a T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let unregister: () => void;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let sealed: { id: string; uhid: string };
  let other: { id: string; uhid: string };

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    unregister = registerOpdCareContextProvider();
  });
  afterAll(async () => { unregister(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    sealed = await mkPatient(db, clerk.actor, {
      name: "Asha Confidential", phone: "9111111111", isConfidential: true, alias: "Guest One",
    });
    other = await mkPatient(db, clerk.actor, {
      name: "Bina Confidential", phone: "9111111112", isConfidential: true, alias: "Guest Two",
    });
    await openOpdVisit(db, { clerk: clerk.actor, patientId: sealed.id, departmentId: deptId, doctorId: dra.doctorId }, T0);
  });

  /** The baseline the whole task rests on: without a grant, nothing changed. */
  it("A1: with no grant the sealed record is still refused", async () => {
    await expect(patientTimeline(db, clerk.actor, sealed.id)).rejects.toMatchObject({ code: "patient_not_found" });
  });

  it("A1b: a patient-scoped grant opens THAT patient and no other", async () => {
    await useBreakGlass(db, testCfg, clerk.actor, { patientId: sealed.id, reason: "unconscious, 2 a.m." });
    expect((await patientTimeline(db, clerk.actor, sealed.id)).length).toBeGreaterThan(0);
    // The key fits one lock. A second sealed patient stays shut.
    await expect(patientTimeline(db, clerk.actor, other.id)).rejects.toMatchObject({ code: "patient_not_found" });
  });

  it("A1c: an EXPIRED grant opens nothing", async () => {
    await db.insert(breakGlassGrants).values({
      id: newId(), userId: clerk.id, patientId: sealed.id, reason: "yesterday's emergency",
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(patientTimeline(db, clerk.actor, sealed.id)).rejects.toMatchObject({ code: "patient_not_found" });
  });

  it("A1d: a hospital-wide grant is allowed — it is the shape a night emergency actually takes", async () => {
    await useBreakGlass(db, testCfg, clerk.actor, { reason: "mass casualty, ids unknown" });
    expect((await patientTimeline(db, clerk.actor, sealed.id)).length).toBeGreaterThan(0);
    expect((await patientTimeline(db, clerk.actor, other.id)).length).toBe(0); // visible, simply has no visits
  });

  /** A2 — a control nobody reviews is not a control. */
  it("A2: using break-glass is evented AND lands on the pending review queue", async () => {
    const { grantId } = await useBreakGlass(db, testCfg, clerk.actor, { patientId: sealed.id, reason: "unconscious" });
    const appended = await db.select().from(events).where(eq(events.name, breakGlassUsed.name));
    expect(appended.length).toBeGreaterThan(0);
    const queue = await pendingReviews(db);
    expect(queue.map((r) => r.id)).toContain(grantId);
    expect(queue.find((r) => r.id === grantId)).toMatchObject({ userId: clerk.id, reason: "unconscious" });
  });

  /** The reason is the record: a break-glass read whose justification is not stored is unauditable. */
  it("A3(server): the access-log row carries the grant's stated reason and marks the record sealed", async () => {
    await useBreakGlass(db, testCfg, clerk.actor, { patientId: sealed.id, reason: "unconscious, 2 a.m." });
    await patientTimeline(db, clerk.actor, sealed.id);
    const [row] = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "opd.timeline"));
    expect(row).toMatchObject({ actorId: clerk.id, sealed: true, reason: "unconscious, 2 a.m." });
  });

  it("A3b(server): an ordinary permitted read records NO reason — the field means break-glass", async () => {
    const open = await mkPatient(db, clerk.actor, { name: "Ramesh Kale", phone: "9876540003" });
    await patientTimeline(db, clerk.actor, open.id);
    const [row] = await db.select().from(phiAccessLog).where(eq(phiAccessLog.patientId, open.id));
    expect(row).toMatchObject({ sealed: false, reason: null });
  });

  it("the refusal still cannot be told from a missing patient (07a DD2 survives T3)", async () => {
    const sealedErr = await patientTimeline(db, clerk.actor, sealed.id).catch((e: unknown) => e);
    const absentErr = await patientTimeline(db, clerk.actor, newId()).catch((e: unknown) => e);
    expect((sealedErr as OpdError).code).toBe((absentErr as OpdError).code);
  });
});
