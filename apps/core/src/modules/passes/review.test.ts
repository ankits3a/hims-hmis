import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { authManifest } from "../../kernel/auth/manifest";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { ipdBedStays, passes } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { KERNEL_RESOURCE_KINDS, createResource } from "../../kernel/resources";
import { emergencyAdmit, ipdManifest } from "../ipd";
import { patientsManifest } from "../patients";
import { ensureRole, mkPatient, mkUser } from "../../../test/helpers/opd";
import { mkAdmitWorld } from "../../../test/helpers/ipd";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  issuePasses, issueVisitorPass, passesAdmissionConsumer, passesManifest, pausePasses, resumePasses, scanPass, viewAdmissionPasses,
} from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { AdmitWorld } from "../../../test/helpers/ipd";

/** E1.3 review of PR #755 — tokens only for issuers, sealed patients unplaced, the baby's lock, the ban's scope, transfer re-entitles. */

jest.setTimeout(120_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const DAY = istDayWindow(new Date(Date.now() - 2 * 24 * 60 * MIN)).start;
const ist = (h: number, m = 0): Date => new Date(DAY.getTime() + (h * 60 + m) * MIN);
const holder = (name: string) => ({ name, relation: "son" });

describe("passes — review findings (PR #755)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: AdmitWorld;
  let desk: Actor;
  let doctor: Actor;
  let manager: Actor;
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
    const roles = { r_desk: ["passes.issue"], r_doc: ["passes.pause"], r_mgr: ["passes.issue", "passes.manage"], r_guard: ["passes.scan"] };
    for (const [role, perms] of Object.entries(roles)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    for (const p of ["patients.register", "patients.confidential.read", "patients.confidential.write"]) {
      await grantPermissionToRole(db, registry, "front_office", p);
    }
    desk = (await mkUser(db, "rv.desk", ["r_desk"])).actor;
    doctor = (await mkUser(db, "rv.doc", ["r_doc"])).actor;
    manager = (await mkUser(db, "rv.mgr", ["r_mgr"])).actor;
    guard = (await mkUser(db, "rv.guard", ["r_guard"])).actor;
  });

  async function admitted(cls: string, opts: { patientId?: string; sex?: "male" | "female"; age?: number } = {}): Promise<string> {
    n += 1;
    const p = opts.patientId ?? await w.patient(opts.sex ?? "female", opts.age ?? 30);
    const bed = await w.bed(`T-R-${String(n)}`, { class: cls });
    return (await emergencyAdmit(db, w.admitDesk, {
      idempotencyKey: key(), patientId: p, bedId: bed, consultantId: w.doctor.id, isolation: "none", mlc: false,
    }, { now: ist(10) })).admissionId;
  }
  const sealedPatient = async (): Promise<string> => (await mkPatient(db, w.admitDesk, {
    name: "Sealed Celebrity Name", sex: "male", ageYears: 50, phone: "9876512399", isConfidential: true, alias: "Patient Neem",
  })).id;
  const tokenOf = async (id: string): Promise<string> => (await db.select().from(passes).where(eq(passes.id, id)))[0]!.token;

  it("1 · the token travels only to a passes.issue holder; a doctor sees the pass without it", async () => {
    const a = await admitted("general");
    await issuePasses(db, desk, { idempotencyKey: key(), admissionId: a, holders: [holder("Ravi")] }, { now: ist(11) });
    const forDesk = await viewAdmissionPasses(db, desk, a, ist(11, 1));
    expect(forDesk.passes[0]!.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const forDoctor = await viewAdmissionPasses(db, doctor, a, ist(11, 1));
    expect(forDoctor.passes).toHaveLength(1);
    expect(forDoctor.passes[0]!.token).toBeNull();
  });

  it("2 · a sealed patient's scan says Valid with no ward and no bed", async () => {
    const a = await admitted("private", { patientId: await sealedPatient() });
    const { passIds: [pid] } = await issuePasses(db, desk, { idempotencyKey: key(), admissionId: a, holders: [holder("Ravi")] }, { now: ist(11) });
    const answer = await scanPass(db, guard, { token: await tokenOf(pid!), wardId: w.wardId }, { now: ist(12) });
    expect(answer).toMatchObject({ result: "valid", word: "Valid", wardName: null, bedCode: null });
  });

  it("3 · a sealed patient's printed card carries the alias only: no IP number, bed or ward", async () => {
    const a = await admitted("private", { patientId: await sealedPatient() });
    await issuePasses(db, desk, { idempotencyKey: key(), admissionId: a, holders: [holder("Ravi")] }, { now: ist(11) });
    const c = (await viewAdmissionPasses(db, desk, a, ist(11, 1))).passes[0]!;
    expect(c).toMatchObject({ patientLabel: "Patient Neem", admissionNo: null, bedCode: null, wardName: null });
  });

  it("4 · a NICU mother pass waits for the baby admission's pass lock", async () => {
    const mother = await admitted("ldr");
    const baby = await admitted("nicu", { sex: "male", age: 0 });
    let settled = false;
    let issue: Promise<unknown> = Promise.resolve();
    await withTx(db, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`passes:${baby}`}))`);
      issue = issuePasses(db, desk, {
        idempotencyKey: key(), admissionId: mother, kind: "nicu_mother", babyAdmissionId: baby, holders: [holder("Mother")],
      }, { now: ist(11) }).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 700));
      expect(settled).toBe(false);
    });
    await expect(issue).resolves.toMatchObject({ passIds: [expect.any(String)] });
  });

  it("5 · a doctor lifts only a visitor ban: a manager's pause-all needs passes.manage, and attendants stay paused", async () => {
    const a = await admitted("general");
    const att = await issuePasses(db, desk, { idempotencyKey: key(), admissionId: a, holders: [holder("Ravi")] }, { now: ist(11) });
    await pausePasses(db, manager, { idempotencyKey: key(), admissionId: a, reason: "Ward lockdown", scope: "all" }, { now: ist(12) });
    // A doctor's later visitor ban does not narrow the manager's pause-all.
    await pausePasses(db, doctor, { idempotencyKey: key(), admissionId: a, reason: "Infection", scope: "visitors" }, { now: ist(12, 5) });
    await expect(resumePasses(db, doctor, { idempotencyKey: key(), admissionId: a }, { now: ist(13) })).rejects.toMatchObject({ code: "resume_needs_manage" });
    expect((await db.select().from(passes).where(eq(passes.id, att.passIds[0]!)))[0]!.state).toBe("paused");

    // A doctor's own visitor ban: the doctor lifts it, and a manager-paused attendant stays paused.
    const b = await admitted("general");
    const att2 = await issuePasses(db, desk, { idempotencyKey: key(), admissionId: b, holders: [holder("Asha")] }, { now: ist(11) });
    const vis = await issueVisitorPass(db, desk, { idempotencyKey: key(), admissionId: b, holder: holder("Lata") }, { now: ist(16, 10) });
    await db.update(passes).set({ state: "paused", pauseReason: "manager hold" }).where(eq(passes.id, att2.passIds[0]!));
    await pausePasses(db, doctor, { idempotencyKey: key(), admissionId: b, reason: "Infection" }, { now: ist(16, 20) });
    const r = await resumePasses(db, doctor, { idempotencyKey: key(), admissionId: b }, { now: ist(16, 30) });
    expect(r.resumedPassIds).toEqual(vis.passIds);
    expect((await db.select().from(passes).where(eq(passes.id, att2.passIds[0]!)))[0]!.state).toBe("paused");
    expect((await viewAdmissionPasses(db, desk, b, ist(16, 31))).visitorBan).toBeNull();
  });

  it("6 · a transfer to ICU revokes the attendant passes ('transfer to icu'); the lounge pass is issued on request", async () => {
    const a = await admitted("private");
    const att = await issuePasses(db, desk, { idempotencyKey: key(), admissionId: a, holders: [holder("Ravi"), holder("Sita")] }, { now: ist(11) });
    const SETUP: Actor = { type: "system", id: "test-transfer" };
    const icuWard = (await withTx(db, (tx) => createResource(tx, SETUP, KERNEL_RESOURCE_KINDS, {
      kind: "ward", code: "F-T-ICU", name: "MICU", parentId: w.floorId, attributes: { department: "MED", unitType: "ICU", wardType: "ward" },
    }))).resourceId;
    const icuBed = (await withTx(db, (tx) => createResource(tx, SETUP, KERNEL_RESOURCE_KINDS, {
      kind: "bed", code: "F-T-ICU-B1", name: "B1", parentId: icuWard, attributes: { class: "icu", icu: true },
    }))).resourceId;
    await db.update(ipdBedStays).set({ bedId: icuBed, bedClass: "icu", billedClass: "icu" })
      .where(and(eq(ipdBedStays.admissionId, a), isNull(ipdBedStays.endedAt)));
    await passesAdmissionConsumer(db)({
      seq: 9, eventId: "E-ICU", name: "ipd.transfer.accepted", payload: { admissionId: a }, patientId: null, correlationId: a, occurredAt: ist(13),
    });
    for (const pid of att.passIds) {
      expect((await db.select().from(passes).where(eq(passes.id, pid)))[0]).toMatchObject({ state: "revoked", endReason: "transfer to icu" });
    }
    const lounge = await issuePasses(db, desk, { idempotencyKey: key(), admissionId: a, holders: [holder("Ravi")] }, { now: ist(13, 5) });
    expect((await db.select().from(passes).where(eq(passes.id, lounge.passIds[0]!)))[0]).toMatchObject({ kind: "lounge", wardId: icuWard });
  });
});
