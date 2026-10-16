import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { idempotencyKeys, ipdEmarLabels } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { authManifest } from "../../kernel/auth/manifest";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkEmarWorld } from "../../../test/helpers/ipd";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { admissionPlace } from "./admission-place";
import {
  IpdRefusal, administerDose, followNarcoticsIn, ipdManifest, issueMed, placeIpOrder, readNarcoticWard, recordNarcoticCount,
  resolveNarcoticException, returnMed, secondCheck, verifyOrder,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { EmarWorld } from "../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * 2026-10-14 review of the ward narcotic register (PR #797). Each case failed against the code it guards:
 *   1. a movement written after the count's instant but committed before the count read the register was in the count's
 *      expected AND again after the agreed count (counted twice);
 *   2. the counting nurse (a supervisor counting) could close their own count's exception;
 *   3. the second nurse's PIN is never stored, not even inside the idempotency store's body hash;
 *   4. a count a few minutes before a shift began left the new shift "count due" all shift;
 *   5. after a move capped by a short ward, the patient's remainder stayed "theirs" on the old ward and a LATER move (or
 *      a replay of the same move) swept it again — out of another patient's units;
 *   6. a register row stamped BEFORE a count's instant but committed AFTER the count read the register was on no balance.
 * Explicit IST instants; nothing reads the real clock.
 */
jest.setTimeout(300_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const H = (h: string): Date => ist(`2026-03-11T${h}`);
const key = (): string => randomUUID();
const TICKS = { allergy: true, interaction: true, dose: true, duplicate: true };

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
const sha = (body: unknown): string => createHash("sha256").update(canonical(body)).digest("hex");

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof IpdRefusal) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("ward narcotic register — review fixes", () => {
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

  async function morphine(): Promise<{ admissionId: string; issueId: string; orderId: string; medicineId: string; labelCode: string; band: string; wardId: string }> {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Morphine 10 mg/ml inj", { narcotic: true, form: "injection", strength: "10 mg/ml", baseUom: "ampoule" });
    const placed = await placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId: med.medicineId, dose: { value: 5, unit: "mg" }, route: "iv", frequency: "BD", startAt: H("07:00:00").toISOString(), antibiotic: false, durationDays: 5 },
    }, { now: H("07:00:00") });
    await verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, decision: "verified", checks: TICKS, note: "checked" }, { now: H("07:30:00") });
    const issued = await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, units: 4, ownMedicine: false }, { now: H("07:40:00") });
    const labelCode = (await db.select().from(ipdEmarLabels).where(eq(ipdEmarLabels.issueId, issued.issueId)))[0]!.code;
    const wardId = (await admissionPlace(db, admissionId))!.wardId!;
    return { admissionId, issueId: issued.issueId, orderId: placed.orderId, medicineId: med.medicineId, labelCode, band: await w.band(admissionId), wardId };
  }
  const count = (by: Actor, wardId: string, medicineId: string, counted: number, at: Date) =>
    recordNarcoticCount(db, by, {
      idempotencyKey: key(), wardId, lines: [{ medicineId, unit: "ampoule", counted }], secondNurse: { username: w.pins.nurse2.username, pin: w.pins.nurse2.pin },
    }, { now: at });

  it("a dose written after the count's instant is counted once — after the count, never also in it", async () => {
    const m = await morphine();
    // The dose's instant (09:00:30) is after the count's (09:00:00), but its row is committed first (the count's PIN
    // check and transaction run after the count's clock was read).
    const p = await secondCheck(db, w.nurse, { idempotencyKey: key(), purpose: "high_alert_dose", orderId: m.orderId, username: w.pins.nurse2.username, pin: w.pins.nurse2.pin, doseDueAt: H("09:00:00").toISOString() }, { now: H("09:00:30") });
    await administerDose(db, w.nurse, {
      idempotencyKey: key(), orderId: m.orderId, doseDueAt: H("09:00:00").toISOString(), givenAt: H("09:00:30").toISOString(),
      patientCheck: { kind: "scan", wristbandCode: m.band }, labelCode: m.labelCode, secondNurse: { userId: p.userId, pinProof: p.pinProof },
    }, { now: H("09:00:30") });
    // At 09:00:00 the cabinet held 4: the count agrees with the register as it stood at its own instant.
    const c = await count(w.nurse, m.wardId, m.medicineId, 4, H("09:00:00"));
    expect(c.lines[0]).toMatchObject({ expected: 4, counted: 4, variance: 0 });
    // From the agreed 4, the half ampoule given at 09:00:30 comes off once: 3.5.
    const view = await readNarcoticWard(db, w.nurse, { wardId: m.wardId, now: H("09:05:00") });
    expect(view.drugs[0]).toMatchObject({ opening: 4, given: 0.5, expected: 3.5 });
  });

  it("the nurse who counted, or witnessed, a mismatch cannot close it", async () => {
    const m = await morphine();
    const bad = await count(supervisor, m.wardId, m.medicineId, 3, H("14:00:00"));
    expect(bad.mismatches).toBe(1);
    const countId = bad.lines[0]!.countId;
    expect(await refusal(resolveNarcoticException(db, supervisor, { idempotencyKey: key(), countId, note: "found it" }, { now: H("14:10:00") }))).toBe("not_narcotic_resolver");
    // Another resolver (the pharmacist) can.
    await resolveNarcoticException(db, w.pharmacist, { idempotencyKey: key(), countId, note: "Ampoule broken; incident filed" }, { now: H("14:20:00") });
  });

  it("the second nurse's PIN never reaches the idempotency store's request hash", async () => {
    const m = await morphine();
    const body = {
      idempotencyKey: key(), wardId: m.wardId, lines: [{ medicineId: m.medicineId, unit: "ampoule", counted: 4 }],
      secondNurse: { username: w.pins.nurse2.username, pin: w.pins.nurse2.pin },
    };
    await recordNarcoticCount(db, w.nurse, body, { now: H("14:00:00") });
    const row = (await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.route, "ipd:record_narcotic_count")))[0]!;
    expect(row.requestHash).not.toBe(sha(body));
    expect(row.requestHash).toBe(sha({ ...body, secondNurse: { username: body.secondNurse.username } }));
  });

  it("a count shortly before a shift begins is that shift's handover count (not due again all shift)", async () => {
    const m = await morphine();
    await count(w.nurse, m.wardId, m.medicineId, 4, H("13:50:00"));
    expect((await readNarcoticWard(db, w.nurse, { wardId: m.wardId, now: H("14:30:00") })).countDue).toBe(false);
    // An earlier count, well inside the morning, does not stand for the evening.
    await count(w.nurse, m.wardId, m.medicineId, 4, H("19:00:00"));
    expect((await readNarcoticWard(db, w.nurse, { wardId: m.wardId, now: H("20:30:00") })).countDue).toBe(true);
  });

  /**
   * The short-ward setup: patient X on the MED ward holds 4 ampoules; the ward counts 3 and the supervisor agrees it (the
   * ward's shortfall). X moves to SUR (`moveId` T1): min(4 own, 3 held) = 3 go. Then patient Y arrives on MED with 4 of
   * the same drug — MED holds Y's 4 and nothing of X's.
   */
  async function shortWardThenAnotherPatient() {
    const x = await morphine();
    const fromBed = (await admissionPlace(db, x.admissionId))!.bedId!;
    const bad = await count(w.nurse, x.wardId, x.medicineId, 3, H("10:00:00"));
    await resolveNarcoticException(db, supervisor, { idempotencyKey: key(), countId: bad.lines[0]!.countId, note: "Ampoule broken; incident filed" }, { now: H("10:10:00") });
    await w.board(x.admissionId, H("11:00:00"));
    const moved = await withTx(db, (tx) => followNarcoticsIn(tx, w.nurse, x.admissionId, H("11:00:00"), { moveId: "T1", fromBedId: fromBed }));
    expect(moved).toBe(1);
    // Y: same drug, same ward.
    const { admissionId: yAdm } = await w.admitMed(H("11:30:00"));
    const placed = await placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId: yAdm, kind: "drug",
      drug: { itemId: x.medicineId, dose: { value: 5, unit: "mg" }, route: "iv", frequency: "BD", startAt: H("11:40:00").toISOString(), antibiotic: false, durationDays: 5 },
    }, { now: H("11:40:00") });
    await verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, decision: "verified", checks: TICKS, note: "checked" }, { now: H("11:45:00") });
    await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, units: 4, ownMedicine: false }, { now: H("11:50:00") });
    const surWard = (await admissionPlace(db, x.admissionId))!.wardId!;
    const surBed = (await admissionPlace(db, x.admissionId))!.bedId!;
    const med = async () => (await readNarcoticWard(db, w.nurse, { wardId: x.wardId, now: H("13:00:00") })).drugs[0]!;
    const sur = async () => (await readNarcoticWard(db, w.nurse, { wardId: surWard, now: H("13:00:00") })).drugs[0]!;
    expect(await med()).toMatchObject({ opening: 3, transferredOut: 3, received: 4, expected: 4 });
    expect(await sur()).toMatchObject({ transferredIn: 3, expected: 3 });
    return { x, fromBed, surBed, med, sur };
  }

  it("a short ward, then a second move of the same patient: no other patient's units are taken", async () => {
    const { x, surBed, med, sur } = await shortWardThenAnotherPatient();
    // X moves again, to another SUR bed (T2): nothing on MED is X's any more.
    await w.board(x.admissionId, H("12:30:00"));
    expect(await withTx(db, (tx) => followNarcoticsIn(tx, w.nurse, x.admissionId, H("12:30:00"), { moveId: "T2", fromBedId: surBed }))).toBe(0);
    expect(await med()).toMatchObject({ transferredOut: 3, expected: 4 });
    expect(await sur()).toMatchObject({ transferredIn: 3, expected: 3 });
  });

  it("a replayed transfer moves nothing more", async () => {
    const { x, fromBed, med, sur } = await shortWardThenAnotherPatient();
    // The same transfer (T1, from the same MED bed) handled again: it moved once; it moves nothing more.
    expect(await withTx(db, (tx) => followNarcoticsIn(tx, w.nurse, x.admissionId, H("12:30:00"), { moveId: "T1", fromBedId: fromBed }))).toBe(0);
    expect(await med()).toMatchObject({ transferredOut: 3, expected: 4 });
    expect(await sur()).toMatchObject({ transferredIn: 3, expected: 3 });
  });

  it("a row stamped before a count's instant but committed after the count is on the next balance, never lost", async () => {
    const m = await morphine();
    // The count (09:00) commits first and agrees 4.
    expect((await count(w.nurse, m.wardId, m.medicineId, 4, H("09:00:00"))).lines[0]).toMatchObject({ expected: 4, variance: 0 });
    // A return stamped 08:59 commits after it (its request began before the count's, its transaction ended after).
    await returnMed(db, w.pharmacist, { idempotencyKey: key(), issueId: m.issueId, units: 1, reason: "Order changed" }, { now: H("08:59:00") });
    const view = await readNarcoticWard(db, w.nurse, { wardId: m.wardId, now: H("09:10:00") });
    expect(view.drugs[0]).toMatchObject({ opening: 4, returned: 1, expected: 3 });
  });
});
