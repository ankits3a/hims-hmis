import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { alerts, events, ipdEmarLabels, ipdEmarNarcoticRegister, ipdNarcoticCounts } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { authManifest } from "../../kernel/auth/manifest";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkEmarWorld } from "../../../test/helpers/ipd";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { admissionPlace } from "./admission-place";
import {
  IpdRefusal, administerDose, followNarcoticsIn, ipdManifest, issueMed, placeIpOrder, readNarcoticWard, recordNarcoticCount, recordNarcoticWastage,
  resolveNarcoticException, returnMed, secondCheck, verifyOrder,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { EmarWorld } from "../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * 2026-10-14 — THE WARD NARCOTIC REGISTER (NDPS / NABH): a per-ward running balance of each controlled drug (received,
 * given, wasted with a witness, returned, the expected balance), the shift-change count by two nurses, a mismatch raised
 * to the nursing supervisor and the pharmacy, closed with a note; append-only; the patient's units follow a ward move.
 * Explicit IST instants; nothing reads the real clock.
 */
jest.setTimeout(300_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const H = (h: string): Date => ist(`2026-03-11T${h}:00`);
const key = (): string => randomUUID();
const TICKS = { allergy: true, interaction: true, dose: true, duplicate: true };

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof IpdRefusal) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("ward narcotic register — balance, two-nurse count, exceptions", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: EmarWorld;
  let supervisor: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkEmarWorld(db);
    const registry = new ModuleRegistry();
    registry.install(authManifest);
    registry.install(ipdManifest);
    await ensureRole(db, "nursing_supervisor");
    for (const p of ["ipd.emar.view", "ipd.emar.give"]) await grantPermissionToRole(db, registry, "nursing_supervisor", p);
    supervisor = (await mkUser(db, "emar.supervisor", ["nursing_supervisor"])).actor;
  });

  async function morphine(): Promise<{ admissionId: string; orderId: string; medicineId: string; issueId: string; labelCode: string; band: string; wardId: string }> {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Morphine 10 mg/ml inj", { narcotic: true, form: "injection", strength: "10 mg/ml", baseUom: "ampoule" });
    const placed = await placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId: med.medicineId, dose: { value: 5, unit: "mg" }, route: "iv", frequency: "BD", startAt: H("07:00").toISOString(), antibiotic: false, durationDays: 5 },
    }, { now: H("07:00") });
    await verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, decision: "verified", checks: TICKS, note: "checked" }, { now: H("07:30") });
    const issued = await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, units: 4, ownMedicine: false }, { now: H("07:40") });
    const labelCode = (await db.select().from(ipdEmarLabels).where(eq(ipdEmarLabels.issueId, issued.issueId)))[0]!.code;
    const wardId = (await admissionPlace(db, admissionId))!.wardId!;
    return { admissionId, orderId: placed.orderId, medicineId: med.medicineId, issueId: issued.issueId, labelCode, band: await w.band(admissionId), wardId };
  }
  const proof = async (orderId: string, at: Date, purpose: "high_alert_dose" | "narcotic_wastage", due?: Date) => {
    const p = await secondCheck(db, w.nurse, { idempotencyKey: key(), purpose, orderId, username: w.pins.nurse2.username, pin: w.pins.nurse2.pin, ...(due ? { doseDueAt: due.toISOString() } : {}) }, { now: at });
    return { userId: p.userId, pinProof: p.pinProof };
  };
  const count = (by: Actor, wardId: string, lines: { medicineId: string; unit: string; counted: number }[], at: Date, second = w.pins.nurse2) =>
    recordNarcoticCount(db, by, { idempotencyKey: key(), wardId, lines, secondNurse: { username: second.username, pin: second.pin } }, { now: at });

  it("keeps a per-ward running balance; two nurses count; a mismatch tells the supervisor and the pharmacy; a resolution agrees it", async () => {
    const m = await morphine();
    await administerDose(db, w.nurse, {
      idempotencyKey: key(), orderId: m.orderId, doseDueAt: H("09:00").toISOString(), givenAt: H("09:00").toISOString(),
      patientCheck: { kind: "scan", wristbandCode: m.band }, labelCode: m.labelCode, secondNurse: await proof(m.orderId, H("09:00"), "high_alert_dose", H("09:00")),
    }, { now: H("09:00") });
    await recordNarcoticWastage(db, w.nurse, {
      idempotencyKey: key(), orderId: m.orderId, qty: 0.5, reason: "Half ampoule discarded", witness: await proof(m.orderId, H("09:05"), "narcotic_wastage"),
    }, { now: H("09:05") });

    // The register's rows carry the ward; the balance: 4 received − 0.5 given − 0.5 wasted = 3 ampoules.
    const rows = await db.select().from(ipdEmarNarcoticRegister).where(eq(ipdEmarNarcoticRegister.orderId, m.orderId));
    expect(new Set(rows.map((r) => r.wardId))).toEqual(new Set([m.wardId]));
    let view = await readNarcoticWard(db, w.nurse, { wardId: m.wardId, now: H("09:10") });
    expect(view.drugs).toHaveLength(1);
    expect(view.drugs[0]).toMatchObject({ medicineId: m.medicineId, unit: "ampoule", opening: 0, received: 4, given: 0.5, wasted: 0.5, returned: 0, expected: 3 });
    expect(view.countDue).toBe(true);
    expect(view.lines.map((l) => l.kind).sort()).toEqual(["given", "received", "wasted"]);

    // Two nurses: the second nurse's own PIN, never the counting nurse; every expected drug counted.
    const other = await w.stocked("Fentanyl 50 mcg/ml inj", { narcotic: true, form: "injection", strength: "50 mcg/ml", baseUom: "ampoule" });
    expect(await refusal(count(w.nurse, m.wardId, [{ medicineId: other.medicineId, unit: "ampoule", counted: 0 }], H("14:00")))).toBe("narcotic_count_incomplete");
    expect(await refusal(count(w.nurse, m.wardId, [{ medicineId: m.medicineId, unit: "ampoule", counted: 3 }], H("14:00"), { username: w.pins.nurse2.username, pin: "0000" }))).toBe("second_nurse_not_confirmed");
    expect(await refusal(count(w.nurse, m.wardId, [{ medicineId: m.medicineId, unit: "ampoule", counted: 3 }], H("14:00"), w.pins.nurse))).toBe("second_nurse_same_person");
    expect(await refusal(count(w.nurse, m.wardId, [{ medicineId: m.medicineId, unit: "ampoule", counted: 3 }], H("14:00"), w.pins.consultant))).toBe("second_nurse_not_nurse");

    // A matching count: no exception, nobody told.
    const ok = await count(w.nurse, m.wardId, [{ medicineId: m.medicineId, unit: "ampoule", counted: 3 }], H("14:00"));
    expect(ok).toMatchObject({ mismatches: 0, lines: [{ expected: 3, counted: 3, variance: 0 }] });
    expect(await db.select().from(alerts).where(eq(alerts.kind, "ipd.narcotic.count_mismatch"))).toHaveLength(0);
    view = await readNarcoticWard(db, w.nurse, { wardId: m.wardId, now: H("14:05") });
    expect(view.countDue).toBe(false);
    expect(view.drugs[0]).toMatchObject({ opening: 3, received: 0, given: 0, wasted: 0, expected: 3 });

    // One ampoule back to the pharmacy → 2 expected; the night count finds 1: an exception.
    await returnMed(db, w.pharmacist, { idempotencyKey: key(), issueId: m.issueId, units: 1, reason: "Order changed" }, { now: H("19:00") });
    const bad = await count(w.nurse, m.wardId, [{ medicineId: m.medicineId, unit: "ampoule", counted: 1 }], H("20:05"));
    expect(bad).toMatchObject({ mismatches: 1, lines: [{ expected: 2, counted: 1, variance: -1 }] });
    const told = await db.select().from(alerts).where(eq(alerts.kind, "ipd.narcotic.count_mismatch"));
    expect(new Set(told.map((a) => a.userId))).toEqual(new Set([supervisor.id, w.pharmacist.id]));
    expect((await db.select().from(events).where(eq(events.name, "ipd.narcotic.count_mismatch")))).toHaveLength(1);
    view = await readNarcoticWard(db, supervisor, { wardId: m.wardId, now: H("20:10") });
    expect(view.canResolve).toBe(true);
    expect(view.exceptions).toMatchObject([{ countId: bad.lines[0]!.countId, expected: 2, counted: 1, variance: -1, resolution: null }]);
    // Unresolved, the register still expects 2 (the last agreed count stands).
    expect(view.drugs[0]!.expected).toBe(2);

    // A ward nurse cannot close it; the supervisor can, once; a matched count has nothing to close.
    const countId = bad.lines[0]!.countId;
    expect((await readNarcoticWard(db, w.nurse, { wardId: m.wardId, now: H("20:10") })).canResolve).toBe(false);
    expect(await refusal(resolveNarcoticException(db, w.nurse, { idempotencyKey: key(), countId, note: "x" }, { now: H("20:20") }))).toBe("not_narcotic_resolver");
    expect(await refusal(resolveNarcoticException(db, supervisor, { idempotencyKey: key(), countId: ok.lines[0]!.countId, note: "x" }, { now: H("20:20") }))).toBe("narcotic_count_matched");
    await resolveNarcoticException(db, supervisor, { idempotencyKey: key(), countId, note: "Ampoule broken in the tray; incident filed" }, { now: H("20:30") });
    expect(await refusal(resolveNarcoticException(db, w.pharmacist, { idempotencyKey: key(), countId, note: "again" }, { now: H("20:31") }))).toBe("narcotic_count_resolved");
    view = await readNarcoticWard(db, w.nurse, { wardId: m.wardId, now: H("20:40") });
    expect(view.drugs[0]).toMatchObject({ opening: 1, expected: 1 });
    expect(view.exceptions[0]!.resolution).toMatchObject({ note: "Ampoule broken in the tray; incident filed" });

    // Append-only: a count row is never changed or deleted.
    await expect(db.execute(sql`update ipd_narcotic_counts set counted_qty = 2 where id = ${countId}`)).rejects.toThrow(/append-only/);
    await expect(db.execute(sql`delete from ipd_narcotic_count_resolutions`)).rejects.toThrow(/append-only/);
    expect(await db.select().from(ipdNarcoticCounts).where(and(eq(ipdNarcoticCounts.wardId, m.wardId)))).toHaveLength(2); // refused counts wrote nothing

    // The patient moves to another ward: the unused ampoule goes with them (transfer out here, in there).
    const fromBedId = (await admissionPlace(db, m.admissionId))!.bedId!;
    await w.board(m.admissionId, H("21:00"));
    const surWard = (await admissionPlace(db, m.admissionId))!.wardId!;
    expect(surWard).not.toBe(m.wardId);
    expect(await withTx(db, (tx) => followNarcoticsIn(tx, w.nurse, m.admissionId, H("21:00"), { moveId: "T1", fromBedId }))).toBe(1);
    expect(await withTx(db, (tx) => followNarcoticsIn(tx, w.nurse, m.admissionId, H("21:01"), { moveId: "T1", fromBedId }))).toBe(0);
    expect((await readNarcoticWard(db, w.nurse, { wardId: m.wardId, now: H("21:05") })).drugs[0]).toMatchObject({ transferredOut: 1, expected: 0 });
    expect((await readNarcoticWard(db, w.nurse, { wardId: surWard, now: H("21:05") })).drugs[0]).toMatchObject({ transferredIn: 1, expected: 1 });
  });
});
