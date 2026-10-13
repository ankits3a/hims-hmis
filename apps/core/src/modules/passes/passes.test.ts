import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { authManifest } from "../../kernel/auth/manifest";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { ipdBedStays, passEvents, passes } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { KERNEL_RESOURCE_KINDS, createResource } from "../../kernel/resources";
import { emergencyAdmit, ipdManifest } from "../ipd";
import { patientsManifest } from "../patients";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { mkAdmitWorld } from "../../../test/helpers/ipd";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  issuePasses, issueVisitorPass, passesAdmissionConsumer, passesManifest, pausePasses, resumePasses, scanPass,
} from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { AdmitWorld } from "../../../test/helpers/ipd";

/** E1.3 (#720) — the visitor ban, the NICU mother pass, a ward transfer moving passes, and the permission walls. */

jest.setTimeout(120_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const DAY = istDayWindow(new Date(Date.now() - 2 * 24 * 60 * MIN)).start;
const ist = (h: number, m = 0): Date => new Date(DAY.getTime() + (h * 60 + m) * MIN);
const holder = (name: string) => ({ name, relation: "daughter" });

describe("passes — ban, NICU mother, transfer, permissions", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: AdmitWorld;
  let desk: Actor;
  let doctor: Actor;
  let guard: Actor;
  let n = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkAdmitWorld(db);
    const registry = new ModuleRegistry();
    for (const m of [authManifest, patientsManifest, ipdManifest, passesManifest]) registry.install(m);
    await syncPermissions(db, registry);
    for (const [role, perms] of Object.entries({ t_p_desk: ["passes.issue"], t_p_doc: ["passes.pause"], t_p_guard: ["passes.scan"] })) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    desk = (await mkUser(db, "p.desk", ["t_p_desk"])).actor;
    doctor = (await mkUser(db, "p.doc", ["t_p_doc"])).actor;
    guard = (await mkUser(db, "p.guard", ["t_p_guard"])).actor;
  });

  async function admitted(cls: string, sex: "male" | "female" = "female", age = 30): Promise<string> {
    n += 1;
    const p = await w.patient(sex, age);
    const bed = await w.bed(`T-P-${String(n)}`, { class: cls });
    return (await emergencyAdmit(db, w.admitDesk, {
      idempotencyKey: key(), patientId: p, bedId: bed, consultantId: w.doctor.id, isolation: "none", mlc: false,
    }, { now: ist(10) })).admissionId;
  }
  const tokenOf = async (id: string): Promise<string> => (await db.select().from(passes).where(eq(passes.id, id)))[0]!.token;

  it("a doctor's visitor ban pauses visitor passes, refuses new ones, leaves the attendant; resume lifts it", async () => {
    const a = await admitted("general");
    const att = await issuePasses(db, desk, { idempotencyKey: key(), admissionId: a, holders: [holder("Asha")] }, { now: ist(11) });
    const vis = await issueVisitorPass(db, desk, { idempotencyKey: key(), admissionId: a, holder: holder("Lata") }, { now: ist(16, 10) });
    await expect(pausePasses(db, doctor, { idempotencyKey: key(), admissionId: a, reason: "Infection risk", scope: "all" }, { now: ist(16, 20) }))
      .rejects.toMatchObject({ code: "pause_needs_manage" });
    await expect(pausePasses(db, desk, { idempotencyKey: key(), admissionId: a, reason: "x" }, { now: ist(16, 20) }))
      .rejects.toMatchObject({ name: "PassForbidden" });
    const paused = await pausePasses(db, doctor, { idempotencyKey: key(), admissionId: a, reason: "Infection risk" }, { now: ist(16, 20) });
    expect(paused.pausedPassIds).toEqual(vis.passIds);
    await expect(scanPass(db, guard, { token: await tokenOf(vis.passIds[0]!), wardId: w.wardId }, { now: ist(16, 30) })).resolves.toMatchObject({ result: "paused" });
    await expect(scanPass(db, guard, { token: await tokenOf(att.passIds[0]!), wardId: w.wardId }, { now: ist(16, 30) })).resolves.toMatchObject({ result: "valid" });
    await expect(issueVisitorPass(db, desk, { idempotencyKey: key(), admissionId: a, holder: holder("Uma") }, { now: ist(16, 40) }))
      .rejects.toMatchObject({ code: "visitors_banned" });
    const resumed = await resumePasses(db, doctor, { idempotencyKey: key(), admissionId: a }, { now: ist(17) });
    expect(resumed.resumedPassIds).toEqual(vis.passIds);
    await expect(scanPass(db, guard, { token: await tokenOf(vis.passIds[0]!), wardId: w.wardId }, { now: ist(17, 1) })).resolves.toMatchObject({ result: "valid" });
  });

  it("a NICU mother pass needs the baby's NICU admission, opens the baby's ward and expires with the baby's stay", async () => {
    const mother = await admitted("ldr");
    await expect(issuePasses(db, desk, { idempotencyKey: key(), admissionId: mother, kind: "nicu_mother", holders: [holder("Mother")] }, { now: ist(11) }))
      .rejects.toMatchObject({ code: "baby_admission_required" });
    const notNicu = await admitted("general", "male", 40);
    await expect(issuePasses(db, desk, { idempotencyKey: key(), admissionId: mother, kind: "nicu_mother", babyAdmissionId: notNicu, holders: [holder("Mother")] }, { now: ist(11) }))
      .rejects.toMatchObject({ code: "baby_not_in_nicu" });
    const baby = await admitted("nicu", "male", 0);
    const m = await issuePasses(db, desk, { idempotencyKey: key(), admissionId: mother, kind: "nicu_mother", babyAdmissionId: baby, holders: [holder("Mother")] }, { now: ist(11) });
    const row = (await db.select().from(passes).where(eq(passes.id, m.passIds[0]!)))[0]!;
    expect(row).toMatchObject({ kind: "nicu_mother", linkedAdmissionId: baby, admissionId: mother, wardId: w.wardId });
    // The mother's bedside pass is still hers to take: the NICU pass does not use the LDR entitlement.
    await expect(issuePasses(db, desk, { idempotencyKey: key(), admissionId: mother, holders: [holder("Husband")] }, { now: ist(11, 5) })).resolves.toBeDefined();
    // The baby's discharge ends the mother's NICU pass.
    await passesAdmissionConsumer(db)({
      seq: 1, eventId: "E-BABY", name: "ipd.admission.discharged", payload: { admissionId: baby }, patientId: null, correlationId: baby, occurredAt: ist(12),
    });
    expect((await db.select().from(passes).where(eq(passes.id, m.passIds[0]!)))[0]).toMatchObject({ state: "expired", endReason: "baby_discharged" });
  });

  it("a ward transfer's acceptance moves the live passes to the new ward: the old door now says wrong ward", async () => {
    const a = await admitted("general");
    const att = await issuePasses(db, desk, { idempotencyKey: key(), admissionId: a, holders: [holder("Asha")] }, { now: ist(11) });
    // ipd-transfer's half (that lane does not exist yet): the open stay moves to a bed in another ward.
    const SETUP: Actor = { type: "system", id: "test-transfer" };
    const ward2 = (await withTx(db, (tx) => createResource(tx, SETUP, KERNEL_RESOURCE_KINDS, {
      kind: "ward", code: "F-T-W2", name: "Ward 5B", parentId: w.floorId, attributes: { department: "MED", unitType: "WARD", wardType: "ward" },
    }))).resourceId;
    const bed2 = (await withTx(db, (tx) => createResource(tx, SETUP, KERNEL_RESOURCE_KINDS, {
      kind: "bed", code: "F-T-W2-B1", name: "B1", parentId: ward2, attributes: { class: "general" },
    }))).resourceId;
    await db.update(ipdBedStays).set({ bedId: bed2 }).where(and(eq(ipdBedStays.admissionId, a), isNull(ipdBedStays.endedAt)));
    const handler = passesAdmissionConsumer(db);
    const ev = { seq: 2, eventId: "E-T", name: "ipd.transfer.accepted", payload: { admissionId: a, transferId: "x" }, patientId: null, correlationId: a, occurredAt: ist(13) };
    await handler(ev);
    await handler(ev); // at least once: the second delivery moves nothing
    expect((await db.select().from(passes).where(eq(passes.id, att.passIds[0]!)))[0]!.wardId).toBe(ward2);
    expect(await db.select().from(passEvents).where(eq(passEvents.kind, "moved"))).toHaveLength(1);
    const token = await tokenOf(att.passIds[0]!);
    await expect(scanPass(db, guard, { token, wardId: w.wardId }, { now: ist(13, 5) })).resolves.toMatchObject({ result: "wrong_ward" });
    await expect(scanPass(db, guard, { token, wardId: ward2 }, { now: ist(13, 5) })).resolves.toMatchObject({ result: "valid", word: "Valid · Ward 5B" });
    await expect(scanPass(db, guard, { token: "no-such-token-at-all" }, { now: ist(13, 6) })).resolves.toMatchObject({ result: "unknown", word: "Not a pass" });
  });

  it("the walls: a guard cannot issue, a desk cannot scan, and the log refuses an edit", async () => {
    const a = await admitted("general");
    await expect(issuePasses(db, guard, { idempotencyKey: key(), admissionId: a, holders: [holder("Asha")] }, { now: ist(11) }))
      .rejects.toMatchObject({ name: "PassForbidden" });
    await expect(scanPass(db, desk, { token: "x".repeat(32) }, { now: ist(11) })).rejects.toMatchObject({ name: "PassForbidden" });
    await issuePasses(db, desk, { idempotencyKey: key(), admissionId: a, holders: [holder("Asha")] }, { now: ist(11) });
    await expect(db.update(passEvents).set({ reason: "edited" })).rejects.toThrow(/append-only/);
  });
});
