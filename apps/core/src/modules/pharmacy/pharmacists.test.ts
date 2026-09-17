import { and, eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { mkUser, testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, orders, pharmacyPharmacistRegistrations, pharmacyRegH1 } from "../../kernel/db/schema";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { labelFor } from "./label";
import {
  currentRegistration, endPharmacistRegistration, listPharmacists, recordPharmacistRegistration,
} from "./pharmacists";
import { pickDispense } from "./pick";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P2 — THE REGISTER OF PHARMACISTS ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p2-pharmacist-register.md`. The
 * fixture's `ph.mehta` holds `pharmacy` and a registration filed by `ph.incharge`, who holds
 * `pharmacy` and has none. So the in-charge may do everything a role allows and nothing the Act
 * reserves.
 */
describe("the register of pharmacists (pharmacy P2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  const COUNCIL = "Maharashtra State Pharmacy Council";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", expiryDate: "2027-06-30", qtyBase: 30, mrpPaise: 15000 });
  });
  afterEach(() => { fx.unregister(); });

  const file = (by: { actor: PharmacyFixture["incharge"]["actor"] }, userId: string, over: Partial<{ council: string; registrationNo: string; validUntil: string | null }> = {}, at = MON) =>
    withTx(db, (tx) => recordPharmacistRegistration(tx, by.actor, {
      userId, council: over.council ?? COUNCIL, registrationNo: over.registrationNo ?? "MSPC-777777", validUntil: over.validUntil ?? null,
    }, at));

  async function claimed(): Promise<{ id: string; tokenNo: number | null }> {
    const { issued, tokenNo } = await issueRx(db, fx, [line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    return { id: r.dispense.id, tokenNo };
  }

  describe("filing", () => {
    it("files a colleague's registration, and never one's own", async () => {
      await expect(file(fx.incharge, fx.incharge.id)).rejects.toMatchObject({ code: "self_registration" });
      const { id } = await file(fx.pharmacist, fx.incharge.id);
      expect(await currentRegistration(db, fx.incharge.id, "2026-08-17")).toMatchObject({
        id, council: COUNCIL, registrationNo: "MSPC-777777", recordedBy: fx.pharmacist.id, validUntil: null,
      });
      const [ev] = await db.select().from(events)
        .where(and(eq(events.name, "pharmacist.registered"), sql`${events.payload}->>'registrationId' = ${id}`));
      expect(ev?.payload).toMatchObject({ registrationId: id, userId: fx.incharge.id, supersededId: null });
      // The event carries the act's clock, not the wall's (P7).
      expect(ev?.occurredAt).toEqual(MON);
    });

    it("refuses a person who does not hold the pharmacy role, a blank field, a lapsed certificate and a number already on file", async () => {
      const clerk = await mkUser(db, "clerk.two", ["front_office"]);
      await expect(file(fx.incharge, clerk.id)).rejects.toMatchObject({ code: "not_a_pharmacist_role" });
      await expect(file(fx.pharmacist, fx.incharge.id, { council: "  " })).rejects.toMatchObject({ code: "invalid_registration" });
      await expect(file(fx.pharmacist, fx.incharge.id, { validUntil: "17/08/2027" })).rejects.toMatchObject({ code: "invalid_registration" });
      await expect(file(fx.pharmacist, fx.incharge.id, { validUntil: "2026-08-16" })).rejects.toMatchObject({ code: "registration_expired" });
      // ph.mehta's own number, in another letter case.
      await expect(file(fx.pharmacist, fx.incharge.id, { council: COUNCIL.toUpperCase(), registrationNo: "mspc-123456" }))
        .rejects.toMatchObject({ code: "registration_in_use" });
    });

    it("a renewal ends the current row in the same act, and the register keeps both", async () => {
      const [first] = (await listPharmacists(db, MON)).filter((p) => p.userId === fx.pharmacist.id);
      const { id, supersededId } = await file(fx.incharge, fx.pharmacist.id, { registrationNo: "MSPC-123456-R", validUntil: "2031-03-31" }, MON2);
      expect(supersededId).toBe(first?.current?.id);
      const [after] = (await listPharmacists(db, MON3)).filter((p) => p.userId === fx.pharmacist.id);
      expect(after?.current?.id).toBe(id);
      expect(after?.history.map((h) => [h.registrationNo, h.endedAt === null])).toEqual([["MSPC-123456-R", true], ["MSPC-123456", false]]);
      expect(after?.history[1]?.endReason).toBe("superseded by Maharashtra State Pharmacy Council MSPC-123456-R");
    });

    it("ends a registration with a reason, by someone else, once", async () => {
      const reg = await currentRegistration(db, fx.pharmacist.id, "2026-08-17");
      if (reg === null) throw new Error("fixture registration missing");
      await expect(withTx(db, (tx) => endPharmacistRegistration(tx, fx.pharmacist.actor, reg.id, "left the hospital", MON2)))
        .rejects.toMatchObject({ code: "self_registration" });
      await expect(withTx(db, (tx) => endPharmacistRegistration(tx, fx.incharge.actor, reg.id, " ", MON2)))
        .rejects.toMatchObject({ code: "invalid_registration" });
      await withTx(db, (tx) => endPharmacistRegistration(tx, fx.incharge.actor, reg.id, "left the hospital", MON2));
      await expect(withTx(db, (tx) => endPharmacistRegistration(tx, fx.incharge.actor, reg.id, "again", MON2)))
        .rejects.toMatchObject({ code: "registration_ended" });
      expect(await currentRegistration(db, fx.pharmacist.id, "2026-08-17")).toBeNull();
    });

    it("the database refuses a self-filed row and a half-ended one", async () => {
      await expect(db.execute(sql`
        insert into pharmacy_pharmacist_registrations (id, user_id, council, registration_no, recorded_by)
        values ('r-self', ${fx.incharge.id}, 'X', 'Y', ${fx.incharge.id})
      `)).rejects.toThrow(/pharmacy_pharmacist_reg_not_self_ck/);
      await expect(db.update(pharmacyPharmacistRegistrations).set({ endedAt: MON2 })
        .where(eq(pharmacyPharmacistRegistrations.userId, fx.pharmacist.id))).rejects.toThrow(/pharmacy_pharmacist_reg_ended_ck/);
    });
  });

  describe("the gate: the acts the Pharmacy Act reserves", () => {
    it("verify refuses a pharmacy login with no registration and leaves no order behind; the registered pharmacist verifies", async () => {
      const { id } = await claimed();
      await expect(verifyDispense(db, fx.incharge.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2))
        .rejects.toMatchObject({ code: "pharmacist_not_registered" });
      expect(await db.select().from(orders)).toHaveLength(0);
      const v = await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2);
      expect(v.status).toBe("verified");
      const [ev] = await db.select().from(events).where(eq(events.name, "dispense.verified"));
      expect(ev?.payload).toMatchObject({ pharmacistRegNo: "MSPC-123456" });
    });

    it("a registration past its valid-until date does not count", async () => {
      await file(fx.incharge, fx.pharmacist.id, { registrationNo: "MSPC-123456-R", validUntil: "2026-08-16" }, new Date("2026-08-01T04:00:00Z"));
      const { id } = await claimed();
      await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2))
        .rejects.toMatchObject({ code: "pharmacist_not_registered" });
    });

    it("a scheduled hand-over needs the registration too, and the H1 register, the event and the label carry the number", async () => {
      const { id, tokenNo } = await claimed();
      await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2);
      await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
      const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
      await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);

      // ph.incharge holds `pharmacy.dispense.scheduled` and no registration.
      await expect(handOverDispense(db, fx.incharge.actor, fx.decls, id, { identity: { via: "token", value: String(tokenNo) } }, MON3))
        .rejects.toMatchObject({ code: "pharmacist_not_registered" });
      await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "token", value: String(tokenNo) } }, MON3);
      expect((await db.select().from(pharmacyRegH1)).map((r) => r.pharmacistRegNo)).toEqual(["MSPC-123456"]);
      const [ev] = await db.select().from(events).where(eq(events.name, "dispense.handed_over"));
      expect(ev?.payload).toMatchObject({ pharmacistRegNo: "MSPC-123456" });

      // A renewal after the dispense: the label still names the number the dispense was checked under.
      await file(fx.incharge, fx.pharmacist.id, { registrationNo: "MSPC-123456-R" }, new Date(MON3.getTime() + 60_000));
      const label = await labelFor(db, fx.pharmacist.actor, id);
      expect(label.pharmacist).toEqual({ name: expect.any(String), council: COUNCIL, registrationNo: "MSPC-123456" });
    });
  });

  it("lists every pharmacy role holder with what the register says about them", async () => {
    const list = await listPharmacists(db, MON2);
    expect(list.map((p) => [p.username, p.current?.registrationNo ?? null, p.renewalDueInDays]).sort()).toEqual([
      ["ph.incharge", null, null], ["ph.mehta", "MSPC-123456", null],
    ]);
  });

  /** P15 — a registration inside its last sixty days says how many are left; one beyond it, or with no end, says nothing. */
  it("says how many days a registration has left once it is inside its renewal window", async () => {
    await file(fx.pharmacist, fx.incharge.id, { validUntil: "2026-09-16" });
    // MON2 is 2026-08-17 (IST): thirty days to 2026-09-16.
    expect((await listPharmacists(db, MON2)).find((p) => p.username === "ph.incharge")?.renewalDueInDays).toBe(30);
    await file(fx.pharmacist, fx.incharge.id, { registrationNo: "MSPC-777777-R", validUntil: "2026-10-17" }, MON2);
    expect((await listPharmacists(db, MON2)).find((p) => p.username === "ph.incharge")?.renewalDueInDays).toBeNull();
    // On the last day it is 0, and the day after there is no current registration at all.
    const last = new Date("2026-10-17T06:00:00.000Z");
    expect((await listPharmacists(db, last)).find((p) => p.username === "ph.incharge")?.renewalDueInDays).toBe(0);
    const after = new Date("2026-10-18T06:00:00.000Z");
    expect((await listPharmacists(db, after)).find((p) => p.username === "ph.incharge")).toMatchObject({ current: null, renewalDueInDays: null });
  });
});
