import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { defineEvent } from "@hmis/contracts";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { authManifest } from "../../../kernel/auth/manifest";
import { istDayWindow } from "../../../kernel/approvals/cumulative";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { withTx } from "../../../kernel/db/client";
import { ipdAdmissions, passes } from "../../../kernel/db/schema";
import { appendEvent } from "../../../kernel/events/append";
import { runDispatchCycle } from "../../../kernel/events/dispatcher";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { buildSubscriptionBus } from "../../../kernel/worker/jobs";
import { admit, askApproval, emergencyAdmit, ipdManifest, planAdmission, requestAdmission, takeDeposit } from "../../ipd";
import { patientsManifest } from "../../patients";
import { ensureRole, mkPatient, mkUser } from "../../../../test/helpers/opd";
import { ADMIT_RATES, mkAdmitWorld } from "../../../../test/helpers/ipd";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  PASSES_ADMISSION_CONSUMER, issuePasses, issueVisitorPass, passesAdmissionConsumer, passesManifest, reissuePass, scanPass,
  setPoliceCustody, viewAdmissionPasses,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { AdmitWorld } from "../../../../test/helpers/ipd";

/**
 * E1.3 (#720) — "DONE MEANS" FOR PASSES (SPEC-ipd-companions §8, §11; decision 0072). Every check calls the INTENT,
 * never a screen. Times are explicit instants on a day two days before the real clock (IST hours matter to visiting
 * hours), never a pinned calendar date.
 *
 * The stay-ending acts (discharge, LAMA, absconding, death) belong to ipd-discharge, which does not exist yet: the
 * fixture `endStay` moves the admission row to the terminal state and appends the CONTRACT's event name, exactly what
 * that lane will emit, and the REAL dispatcher delivers it to the passes consumer.
 */

jest.setTimeout(180_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const DAY = istDayWindow(new Date(Date.now() - 2 * 24 * 60 * MIN)).start;
/** An instant on that IST day: `ist(17, 30)` = 17:30 IST. */
const ist = (h: number, m = 0): Date => new Date(DAY.getTime() + (h * 60 + m) * MIN);
const PAPER = { signedBy: "patient" as const, method: "paper" as const, witnessName: "Desk Witness" };
const holder = (name: string) => ({ name, relation: "son", phone: "9876501234" });

describe("E1.3 passes — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: AdmitWorld;
  let desk: Actor;
  let guard: Actor;
  let manager: Actor;
  let wardId: string;
  let n = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkAdmitWorld(db);
    wardId = w.wardId;
    const registry = new ModuleRegistry();
    registry.install(authManifest);
    registry.install(patientsManifest);
    registry.install(ipdManifest);
    registry.install(passesManifest);
    await syncPermissions(db, registry);
    const roles: Record<string, string[]> = {
      t_pass_desk: ["passes.issue"], t_pass_guard: ["passes.scan"], t_pass_mgr: ["passes.issue", "passes.manage"],
    };
    for (const [role, perms] of Object.entries(roles)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    // The admission desk may open a sealed record (its patient is in front of it); the pass still prints the alias.
    for (const p of ["patients.register", "patients.confidential.read", "patients.confidential.write"]) {
      await grantPermissionToRole(db, registry, "front_office", p);
    }
    desk = (await mkUser(db, "pass.desk", ["t_pass_desk"])).actor;
    guard = (await mkUser(db, "pass.guard", ["t_pass_guard"])).actor;
    manager = (await mkUser(db, "pass.mgr", ["t_pass_mgr"])).actor;
  });

  /** An admitted patient on a fresh bed of `cls` through the emergency lane (no deposit, no tariff), admitted at 10:00 IST. */
  async function admitted(cls: string, patient?: string): Promise<string> {
    n += 1;
    const p = patient ?? await w.patient(n % 2 === 0 ? "female" : "male");
    const bed = await w.bed(`T-${cls.toUpperCase()}-${String(n)}`, { class: cls });
    const done = await emergencyAdmit(db, w.admitDesk, {
      idempotencyKey: key(), patientId: p, bedId: bed, consultantId: w.doctor.id, isolation: "none", mlc: false,
    }, { now: ist(10) });
    return done.admissionId;
  }

  /** An ICU admission the governed way: request, plan, deposit, the intensivist's approval granted, admit. */
  async function admittedIcu(): Promise<string> {
    const p = await w.patient("female");
    const bed = await w.bed("T-ICU-A", { class: "icu", icu: true });
    const { admissionId } = await requestAdmission(db, w.doctor, {
      idempotencyKey: key(), patientId: p, source: "direct", consultantId: w.doctor.id, requestedClass: "icu",
      isolation: "none", provisionalDiagnosis: "Synthetic sepsis", mlc: false,
    }, { now: ist(9) });
    await planAdmission(db, w.admitDesk, { idempotencyKey: key(), admissionId, payerKind: "cash", requestedClass: "icu", plan: { kind: "medical" } }, { now: ist(9, 10) });
    const day = ADMIT_RATES.icu.room + ADMIT_RATES.icu.nursing + ADMIT_RATES.icu.visit;
    const { receiptId } = await takeDeposit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId, amountPaise: 3 * day, tender: "upi", tenderRef: "UPI-SYN-P", payer: { name: "Synthetic Payer", relation: "self" },
    }, { now: ist(9, 20) });
    const { approvalId } = await askApproval(db, w.admitDesk, admissionId, { kind: "icu", note: "Synthetic sepsis" });
    await approveRequest(db, w.ms, { approvalId, note: "ICU bed justified" });
    await admit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId, bedId: bed, consent: PAPER, deposit: { receiptId }, intensivistApprovalId: approvalId,
    }, { now: ist(9, 30) });
    return admissionId;
  }

  /** ipd-discharge's half, as that lane will do it: the terminal state, then the contract's event. */
  async function endStay(admissionId: string, state: string, eventName: string, at: Date): Promise<void> {
    const ev = defineEvent(eventName, "ipd", z.object({ admissionId: z.string() }));
    await withTx(db, async (tx) => {
      await tx.update(ipdAdmissions).set({ state, endedAt: at, updatedAt: at }).where(eq(ipdAdmissions.id, admissionId));
      await appendEvent(tx, ev.make({ payload: { admissionId }, actor: w.admitDesk, correlationId: admissionId, occurredAt: at }));
    });
  }
  async function dispatch(): Promise<void> {
    const registry = new ModuleRegistry();
    registry.install(passesManifest);
    const bus = buildSubscriptionBus(registry, { [PASSES_ADMISSION_CONSUMER]: passesAdmissionConsumer(db) });
    await runDispatchCycle(db, bus, { batchSize: 1000 });
  }
  const tokensOf = async (ids: string[]): Promise<string[]> =>
    (await db.select({ token: passes.token }).from(passes).where(inArray(passes.id, ids))).map((r) => r.token);
  const scan = (token: string, at: Date, ward: string | undefined = wardId) =>
    scanPass(db, guard, { token, ...(ward === undefined ? {} : { wardId: ward }) }, { now: at });

  it("(i) passes per bed class at admission: general 1, private 2, ICU none at the bedside and one lounge pass", async () => {
    const general = await admitted("general");
    await expect(issuePasses(db, desk, { idempotencyKey: key(), admissionId: general, holders: [holder("Ravi"), holder("Sita")] }, { now: ist(11) }))
      .rejects.toMatchObject({ code: "entitlement_used", detail: { max: 1, live: 0 } });
    const g = await issuePasses(db, desk, { idempotencyKey: key(), admissionId: general, holders: [holder("Ravi")] }, { now: ist(11) });
    expect(g.passIds).toHaveLength(1);
    await expect(issuePasses(db, desk, { idempotencyKey: key(), admissionId: general, holders: [holder("Sita")] }, { now: ist(11, 5) }))
      .rejects.toMatchObject({ code: "entitlement_used", detail: { max: 1, live: 1 } });

    const priv = await admitted("private");
    const pr = await issuePasses(db, desk, { idempotencyKey: key(), admissionId: priv, holders: [holder("Ravi"), holder("Sita")] }, { now: ist(11) });
    expect(pr.passIds).toHaveLength(2);
    await expect(issuePasses(db, desk, { idempotencyKey: key(), admissionId: priv, holders: [holder("Gita")] }, { now: ist(11, 5) }))
      .rejects.toMatchObject({ code: "entitlement_used", detail: { max: 2, live: 2 } });

    const icu = await admittedIcu();
    await expect(issuePasses(db, desk, { idempotencyKey: key(), admissionId: icu, kind: "attendant", holders: [holder("Ravi")] }, { now: ist(11) }))
      .rejects.toMatchObject({ code: "icu_no_bedside_pass", detail: { entitled: "lounge" } });
    const lounge = await issuePasses(db, desk, { idempotencyKey: key(), admissionId: icu, holders: [holder("Ravi")] }, { now: ist(11) });
    const view = await viewAdmissionPasses(db, desk, icu, ist(11, 1));
    expect(view.entitlement).toMatchObject({ kind: "lounge", max: 1, live: 1 });
    expect(view.passes.map((p) => [p.passId, p.kind])).toEqual([[lounge.passIds[0], "lounge"]]);
    await expect(issuePasses(db, desk, { idempotencyKey: key(), admissionId: icu, holders: [holder("Sita")] }, { now: ist(11, 5) }))
      .rejects.toMatchObject({ code: "entitlement_used", detail: { max: 1 } });
  });

  it("(ii) discharge, transfer out, death and absconding each expire every pass of the admission at once", async () => {
    const cases = [
      { state: "discharged", event: "ipd.admission.discharged", reason: "discharged" },
      { state: "transferred_out", event: "ipd.admission.discharged", reason: "transferred_out" },
      { state: "deceased", event: "ipd.admission.deceased", reason: "deceased" },
      { state: "absconded", event: "ipd.admission.absconded", reason: "absconded" },
    ];
    const made: { admissionId: string; passIds: string[]; reason: string; endAt: Date }[] = [];
    let i = 0;
    for (const c of cases) {
      i += 1;
      const admissionId = await admitted("private");
      const a = await issuePasses(db, desk, { idempotencyKey: key(), admissionId, holders: [holder("Ravi"), holder("Sita")] }, { now: ist(11) });
      const v = await issueVisitorPass(db, desk, { idempotencyKey: key(), admissionId, holder: holder("Mohan") }, { now: ist(16, 30) });
      const endAt = ist(17, i);
      await endStay(admissionId, c.state, c.event, endAt);
      made.push({ admissionId, passIds: [...a.passIds, ...v.passIds], reason: c.reason, endAt });
    }
    // A bystander admission's passes are untouched.
    const other = await admitted("general");
    const kept = await issuePasses(db, desk, { idempotencyKey: key(), admissionId: other, holders: [holder("Kiran")] }, { now: ist(11) });

    await dispatch();
    for (const m of made) {
      const rows = await db.select().from(passes).where(inArray(passes.id, m.passIds));
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r).toMatchObject({ state: "expired", endReason: m.reason });
        expect(r.endedAt!.getTime()).toBe(m.endAt.getTime()); // one instant: the event's own, all at once
      }
      for (const t of await tokensOf(m.passIds)) await expect(scan(t, ist(17, 30))).resolves.toMatchObject({ result: "expired", word: "Expired" });
    }
    expect((await db.select().from(passes).where(inArray(passes.id, kept.passIds)))[0]).toMatchObject({ state: "active" });
    // Delivered again (at-least-once): nothing more is written.
    await dispatch();
    const again = await db.select().from(passes).where(inArray(passes.id, made[0]!.passIds));
    expect(again.every((r) => r.endedAt!.getTime() === made[0]!.endAt.getTime())).toBe(true);
  });

  it("(iii) a lost pass reissued revokes the old one: the old token scans revoked, the new one valid", async () => {
    const admissionId = await admitted("general");
    const { passIds: [oldId] } = await issuePasses(db, desk, { idempotencyKey: key(), admissionId, holders: [holder("Ravi")] }, { now: ist(11) });
    const [oldToken] = await tokensOf([oldId!]);
    await expect(scan(oldToken!, ist(12))).resolves.toMatchObject({ result: "valid", holderName: "Ravi" });
    const re = await reissuePass(db, desk, { idempotencyKey: key(), passId: oldId, reason: "lost" }, { now: ist(13) });
    expect(re.revokedPassId).toBe(oldId);
    const [newToken] = await tokensOf([re.passId]);
    expect(newToken).not.toBe(oldToken);
    await expect(scan(oldToken!, ist(13, 1))).resolves.toMatchObject({ result: "revoked", word: "Revoked" });
    await expect(scan(newToken!, ist(13, 1))).resolves.toMatchObject({ result: "valid", holderName: "Ravi" });
    const old = (await db.select().from(passes).where(eq(passes.id, oldId!)))[0]!;
    expect(old).toMatchObject({ state: "revoked", endReason: "lost", replacedBy: re.passId });
    // The reissue does not consume a second entitlement: the general bed still holds exactly one live pass.
    expect((await viewAdmissionPasses(db, desk, admissionId, ist(13, 2))).entitlement).toMatchObject({ max: 1, live: 1 });
  });

  it("(iv) a visitor pass scanned outside visiting hours answers outside hours; none is issued outside them", async () => {
    const admissionId = await admitted("general");
    await expect(issueVisitorPass(db, desk, { idempotencyKey: key(), admissionId, holder: holder("Mohan") }, { now: ist(12) }))
      .rejects.toMatchObject({ code: "outside_visiting_hours" });
    const { passIds: [vid] } = await issueVisitorPass(db, desk, { idempotencyKey: key(), admissionId, holder: holder("Mohan") }, { now: ist(16, 15) });
    const [token] = await tokensOf([vid!]);
    await expect(scan(token!, ist(17))).resolves.toMatchObject({ result: "valid", kind: "visitor" });
    await expect(scan(token!, ist(19, 30))).resolves.toMatchObject({ result: "outside_hours", word: "Outside visiting hours" });
    // The next day the pass is over.
    await expect(scan(token!, ist(24 + 17))).resolves.toMatchObject({ result: "expired" });
    // At most two live visitors.
    await issueVisitorPass(db, desk, { idempotencyKey: key(), admissionId, holder: holder("Lata") }, { now: ist(16, 20) });
    await expect(issueVisitorPass(db, desk, { idempotencyKey: key(), admissionId, holder: holder("Uma") }, { now: ist(16, 25) }))
      .rejects.toMatchObject({ code: "visitor_limit" });
  });

  it("(v) a sealed admission's pass carries the alias and never the patient's name", async () => {
    const sealed = await mkPatient(db, w.admitDesk, {
      name: "Sealed Celebrity Name", sex: "male", ageYears: 50, phone: "9876512345", isConfidential: true, alias: "Patient Neem",
    });
    const admissionId = await admitted("private", sealed.id);
    await issuePasses(db, desk, { idempotencyKey: key(), admissionId, holders: [holder("Ravi")] }, { now: ist(11) });
    // Read by the issuing desk AND by a manager: the card is the same paper, whoever prints it.
    for (const reader of [desk, manager]) {
      const view = await viewAdmissionPasses(db, reader, admissionId, ist(11, 1));
      expect(view.patientLabel).toBe("Patient Neem");
      expect(view.passes[0]!.patientLabel).toBe("Patient Neem");
      expect(JSON.stringify(view)).not.toContain("Sealed Celebrity Name");
    }
    const [token] = await tokensOf([(await viewAdmissionPasses(db, desk, admissionId, ist(11, 1))).passes[0]!.passId]);
    const answer = await scan(token!, ist(12));
    expect(JSON.stringify(answer)).not.toContain("Sealed Celebrity Name");
    // The QR payload is the opaque token alone.
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("(vi) a police custody admission refuses attendant passes and issues only police guard passes", async () => {
    const admissionId = await admitted("general");
    const before = await issuePasses(db, desk, { idempotencyKey: key(), admissionId, holders: [holder("Ravi")] }, { now: ist(11) });
    const custody = await setPoliceCustody(db, manager, { idempotencyKey: key(), admissionId, custody: true, note: "Arrested patient, guard posted" }, { now: ist(12) });
    expect(custody.revokedPassIds).toEqual(before.passIds); // the attendant's pass ends at once
    await expect(issuePasses(db, desk, { idempotencyKey: key(), admissionId, kind: "attendant", holders: [holder("Sita")] }, { now: ist(12, 5) }))
      .rejects.toMatchObject({ code: "police_custody_guard_only" });
    await expect(issueVisitorPass(db, desk, { idempotencyKey: key(), admissionId, holder: holder("Mohan") }, { now: ist(16, 30) }))
      .rejects.toMatchObject({ code: "police_custody_guard_only" });
    const guards = await issuePasses(db, desk, {
      idempotencyKey: key(), admissionId, holders: [{ name: "HC Yadav", relation: "police guard" }, { name: "Ct Singh", relation: "police guard" }],
    }, { now: ist(12, 10) });
    const view = await viewAdmissionPasses(db, desk, admissionId, ist(12, 11));
    expect(view.entitlement).toMatchObject({ kind: "police_guard", max: 2, live: 2 });
    expect(view.passes.filter((p) => p.state === "active").map((p) => p.kind)).toEqual(["police_guard", "police_guard"]);
    expect(guards.passIds).toHaveLength(2);
    const [oldToken] = await tokensOf(before.passIds);
    await expect(scan(oldToken!, ist(12, 30))).resolves.toMatchObject({ result: "revoked" });
  });
});
