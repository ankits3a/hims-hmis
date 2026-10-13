import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { events, ipdAdmissions, ipdClassChanges, ipdTransfers } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkTransferWorld } from "../../../../test/helpers/ipd";
import {
  IpdRefusal, acceptHandover, askApproval, askEmergencyIcuApproval, changeClass, emergencyAdmit, lapseBedReservations, postNightlyIpdCharges,
  startTransfer, swapBeds, transferOptions,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { TransferWorld } from "../../../../test/helpers/ipd";

/**
 * E3.1 review (PR #759) — the six findings, each pinned with explicit instants (IST, `+05:30`).
 */

jest.setTimeout(180_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const SBAR = { situation: "s", background: "b", assessment: "a", recommendation: "r" };

async function refusal(p: Promise<unknown>): Promise<IpdRefusal> {
  try { await p; } catch (e) { if (e instanceof IpdRefusal) return e; throw e; }
  throw new Error("expected a refusal");
}

describe("E3.1 transfer review — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: TransferWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkTransferWorld(db); });

  const admitOn = async (bedId: string, sex: "male" | "female", isolation: "none" | "contact", at: Date) => {
    const patientId = await w.patient(sex, 45);
    return emergencyAdmit(db, w.admitDesk, {
      idempotencyKey: randomUUID(), patientId, bedId, consultantId: w.doctor.id, isolation, mlc: false,
    }, { now: at });
  };
  const swap = (a: string, b: string, at: Date, extra: Record<string, unknown> = {}) =>
    swapBeds(db, w.sender, { idempotencyKey: randomUUID(), admissionIdA: a, admissionIdB: b, reason: "clinical", ...extra }, { now: at });

  it("1. a swap onto an ICU bed from a ward bed needs a granted intensivist approval for that patient", async () => {
    const ward = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const icuBed = await w.bed2("R-ICU-1", { class: "icu", icu: true });
    const icuPatient = await w.patient("male", 50);
    const asked = await askEmergencyIcuApproval(db, w.admitDesk, { patientId: icuPatient, note: "Sepsis" });
    await approveRequest(db, w.ms, { approvalId: asked.approvalId, note: "ok" });
    const icu = await emergencyAdmit(db, w.admitDesk, {
      idempotencyKey: randomUUID(), patientId: icuPatient, bedId: icuBed, consultantId: w.doctor.id, isolation: "none", mlc: false,
      admissionId: asked.admissionId, intensivistApprovalId: asked.approvalId,
    }, { now: ist("2026-03-10T10:30:00") });
    expect((await refusal(swap(ward.admissionId, icu.admissionId, ist("2026-03-11T09:00:00")))).code).toBe("icu_needs_intensivist");
    const { approvalId } = await askApproval(db, w.admitDesk, ward.admissionId, { kind: "icu", note: "Step-up" });
    await approveRequest(db, w.ms, { approvalId, note: "ok" });
    const done = await swap(ward.admissionId, icu.admissionId, ist("2026-03-11T09:05:00"), { intensivistApprovalIdA: approvalId });
    expect(done.a.bedId).toBe(icuBed);
  });

  it("2. a swap is refused when either patient is in isolation (the bed needs a terminal clean)", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const isoBed = await w.bed2("R-ISO-1", { isolation: "contact" });
    const iso = await admitOn(isoBed, "male", "contact", ist("2026-03-10T10:30:00"));
    const r = await refusal(swap(a.admissionId, iso.admissionId, ist("2026-03-11T09:00:00")));
    expect(r.code).toBe("swap_isolation");
  });

  it("3. a lapsed target hold refuses acceptance; the lapse job closes the transfer and says so", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const target = await w.bed2("R-W2-1");
    const t = await startTransfer(db, w.sender, { idempotencyKey: randomUUID(), admissionId, toBedId: target, reason: "bed_management", handover: SBAR }, { now: ist("2026-03-11T09:00:00") });
    const late = ist("2026-03-11T21:30:00");
    expect((await refusal(acceptHandover(db, w.receiver, { idempotencyKey: randomUUID(), transferId: t.transferId }, { now: late }))).code).toBe("transfer_hold_lapsed");
    await lapseBedReservations(db, late);
    const [row] = await db.select().from(ipdTransfers).where(eq(ipdTransfers.id, t.transferId));
    expect(row).toMatchObject({ status: "cancelled", cancelReason: "hold_lapsed" });
    expect((await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!.state).toBe("admitted");
    const cancelled = await db.select().from(events).where(eq(events.name, "ipd.transfer.cancelled"));
    expect(cancelled.map((e) => (e.payload as { reason: string }).reason)).toEqual(["hold_lapsed"]);
  });

  it("4. asking for the class already in effect revokes a pending change; the bill never sees it", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const consent = { signedBy: "patient" as const, method: "paper" as const, witnessName: "Test Witness" };
    await changeClass(db, w.sender, { idempotencyKey: randomUUID(), admissionId, toClass: "private", consent, roomRentCapAcknowledged: true }, { now: ist("2026-03-11T09:00:00") });
    await changeClass(db, w.sender, { idempotencyKey: randomUUID(), admissionId, toClass: "general", consent, roomRentCapAcknowledged: false }, { now: ist("2026-03-11T10:00:00") });
    const active = await db.select().from(ipdClassChanges).where(and(eq(ipdClassChanges.admissionId, admissionId), eq(ipdClassChanges.status, "active")));
    expect(active).toHaveLength(0);
    await w.discharge(admissionId, ist("2026-03-12T15:00:00"));
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    const lines = (await db.execute(sql.raw(`select billed_class as c from ipd_charge_lines where admission_id = '${admissionId}' and component = 'room' order by service_date`))).rows;
    expect(lines.map((l) => l.c)).toEqual(["general", "general", "general"]);
  });

  it("5. the panel's targets leave out a twin-room bed whose room is the other gender", async () => {
    const roomBed1 = await w.bed("R-ROOM-1", {}, "room");
    const roomBed2 = await w.bed("R-ROOM-2", {}, "room");
    await admitOn(roomBed1, "female", "none", ist("2026-03-10T09:00:00"));
    const male = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const opts = await transferOptions(db, w.sender, male.admissionId, { now: ist("2026-03-11T09:00:00") });
    expect(opts.targets.map((t) => t.bedId)).not.toContain(roomBed2);
  });

  it("6. a hospital-initiated move keeps the lower class; a patient-requested move bills the new bed", async () => {
    const run = async (reason: "bed_management" | "patient_request") => {
      const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
      const target = await w.bed2(`R-PVT-${reason}`, { class: "private" });
      const t = await startTransfer(db, w.sender, { idempotencyKey: randomUUID(), admissionId, toBedId: target, reason, handover: SBAR }, { now: ist("2026-03-11T09:00:00") });
      await acceptHandover(db, w.receiver, { idempotencyKey: randomUUID(), transferId: t.transferId }, { now: ist("2026-03-11T09:20:00") });
      return (await w.openStay(admissionId))!;
    };
    expect(await run("bed_management")).toMatchObject({ bedClass: "private", billedClass: "general" });
    expect(await run("patient_request")).toMatchObject({ bedClass: "private", billedClass: "private" });
  });
});
