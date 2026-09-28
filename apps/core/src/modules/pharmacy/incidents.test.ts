import { sql } from "drizzle-orm";
import { openSessionFor } from "../../../test/helpers/billing";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkPatient, mkUser, testCfg } from "../../../test/helpers/opd";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { events, pharmacyMedicationIncidents } from "../../kernel/db/schema";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { PharmacyError } from "./errors";
import { handOverDispense } from "./handover";
import {
  addIncidentEvent, getIncident, incidentIndicator, incidentsAwaitingReview, kindOfCategory, listIncidents, recordIncident,
} from "./incidents";
import { buildNeeds } from "./office-needs";
import { pickDispense } from "./pick";
import { verifyDispense } from "./verify";
import type { RecordIncidentInput } from "./incidents";
import type { NeedInputs } from "./office-needs";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY STAGE D2 — THE MEDICATION ERROR AND NEAR-MISS LOG ═══
 *
 * Two things this stage must not get wrong, each tested BOTH ways:
 *   1. KIND AGREES WITH CATEGORY. A and B are near misses; C–I are errors. The database refuses a row that
 *      says otherwise, whoever writes it — the NABH indicator counts errors, so a mislabelled row moves it.
 *   2. BLAME-FREE. The reporter's name reaches a holder of `pharmacy.incidents.review` and nobody else;
 *      everyone else is told the role. Measured on the service's own output, not on a screen.
 */
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { if (e instanceof PharmacyError) return e.code; throw e; }
  return "no refusal";
};

/** A raw insert, bypassing the service: the database's CHECK is the last word, not the service's. */
async function rawInsert(db: Db, reporterId: string, kind: string, category: string): Promise<void> {
  await db.execute(sql`insert into pharmacy_medication_incidents (id, kind, stage, type, category, what_happened, reported_by, reporter_role)
    values (${`raw-${kind}-${category}`}, ${kind}, 'dispensing', 'wrong_drug', ${category}, 'raw', ${reporterId}, 'pharmacy')`);
}

async function dbRefusal(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    const cause = (e as { cause?: { constraint?: string; message?: string } }).cause;
    const text = cause?.constraint ?? cause?.message ?? (e as Error).message;
    return /check constraint "([^"]+)"/.exec(text)?.[1] ?? text;
  }
  return "no refusal";
}

describe("the medication incident log (pharmacy stage D2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let reviewer: Awaited<ReturnType<typeof mkUser>>;

  const base = (over: Partial<RecordIncidentInput> = {}): RecordIncidentInput => ({
    kind: "near_miss", stage: "dispensing", type: "lasa_mixup", category: "B",
    factors: ["lasa", "interruption"], whatHappened: "Picked Chlorpromazine for Chlorpropamide; caught at the second check before the bag was sealed.",
    ...over,
  });

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.incidents.record");
    await grantPermissionToRole(db, fx.registry, "pharmacy_assistant", "pharmacy.incidents.record");
    await ensureRole(db, "medical_superintendent");
    await grantPermissionToRole(db, fx.registry, "medical_superintendent", "pharmacy.incidents.review");
    reviewer = await mkUser(db, "the.ms", ["medical_superintendent"]);
  });
  afterEach(() => { fx.unregister(); });

  describe("kind agrees with the NCC MERP category", () => {
    it("the DATABASE refuses a near miss at C–I and an error at A–B, and holds each agreeing pair", async () => {
      expect(await dbRefusal(rawInsert(db, fx.pharmacist.id, "near_miss", "E"))).toBe("pharmacy_medication_incidents_kind_category_ck");
      expect(await dbRefusal(rawInsert(db, fx.pharmacist.id, "near_miss", "C"))).toBe("pharmacy_medication_incidents_kind_category_ck");
      expect(await dbRefusal(rawInsert(db, fx.pharmacist.id, "error", "A"))).toBe("pharmacy_medication_incidents_kind_category_ck");
      expect(await dbRefusal(rawInsert(db, fx.pharmacist.id, "error", "B"))).toBe("pharmacy_medication_incidents_kind_category_ck");
      await rawInsert(db, fx.pharmacist.id, "near_miss", "A");
      await rawInsert(db, fx.pharmacist.id, "near_miss", "B");
      await rawInsert(db, fx.pharmacist.id, "error", "C");
      await rawInsert(db, fx.pharmacist.id, "error", "I");
      expect(await db.select().from(pharmacyMedicationIncidents)).toHaveLength(4);
    });

    it("the service says so first, in words, and derives nothing silently", async () => {
      expect(await refusal(recordIncident(db, fx.pharmacist.actor, base({ kind: "near_miss", category: "E" }), MON))).toBe("invalid_incident");
      expect(await refusal(recordIncident(db, fx.pharmacist.actor, base({ kind: "error", category: "B" }), MON))).toBe("invalid_incident");
      expect(kindOfCategory("A")).toBe("near_miss");
      expect(kindOfCategory("C")).toBe("error");
      const out = await recordIncident(db, fx.pharmacist.actor, base({ kind: "error", category: "C" }), MON);
      expect(out.no).toBe("MI-000001");
    });

    it("every closed set is a CHECK: a stage, a type, a category or a factor outside its list is refused by the database", async () => {
      const raw = (col: string, v: string) => db.execute(sql.raw(`insert into pharmacy_medication_incidents (id, kind, stage, type, category, factors, what_happened, reported_by, reporter_role)
        values ('x-${col}', 'near_miss', ${col === "stage" ? `'${v}'` : "'dispensing'"}, ${col === "type" ? `'${v}'` : "'wrong_drug'"}, ${col === "category" ? `'${v}'` : "'B'"},
        ${col === "factors" ? `array['${v}']` : "'{}'"}, 'x', '${fx.pharmacist.id}', 'pharmacy')`));
      expect(await dbRefusal(raw("stage", "billing"))).toBe("pharmacy_medication_incidents_stage_ck");
      expect(await dbRefusal(raw("type", "wrong_colour"))).toBe("pharmacy_medication_incidents_type_ck");
      expect(await dbRefusal(raw("category", "J"))).toBe("pharmacy_medication_incidents_category_ck");
      expect(await dbRefusal(raw("factors", "bad_luck"))).toBe("pharmacy_medication_incidents_factors_ck");
    });
  });

  it("is append-only: an incident and its events refuse UPDATE and DELETE", async () => {
    const { incidentId } = await recordIncident(db, fx.pharmacist.actor, base(), MON);
    await addIncidentEvent(db, reviewer.actor, incidentId, { kind: "reviewed", rootCause: "Look-alike boxes shelved side by side", actionTaken: "Separated; tall-man label on both" }, MON2);
    await expect(db.execute(sql`update pharmacy_medication_incidents set category = 'A' where id = ${incidentId}`)).rejects.toThrow(/pharmacy_medication_incident_immutable/);
    await expect(db.execute(sql`delete from pharmacy_medication_incidents where id = ${incidentId}`)).rejects.toThrow(/pharmacy_medication_incident_immutable/);
    await expect(db.execute(sql`update pharmacy_medication_incident_events set root_cause = 'x'`)).rejects.toThrow(/pharmacy_medication_incident_immutable/);
    await expect(db.execute(sql`delete from pharmacy_medication_incident_events`)).rejects.toThrow(/pharmacy_medication_incident_immutable/);
  });

  describe("blame-free: the reporter's name is the reviewer's alone", () => {
    it("a recorder without review is told the ROLE and never the name — not in any field of the row", async () => {
      const { incidentId } = await recordIncident(db, fx.pharmacist.actor, base(), MON);
      await addIncidentEvent(db, reviewer.actor, incidentId, { kind: "reviewed", rootCause: "Interrupted mid-pick", actionTaken: "Quiet zone at the pick bench" }, MON2);
      const [row] = await listIncidents(db, fx.aide.actor);
      expect(row!.reporter).toEqual({ role: "pharmacy", roleTitle: expect.any(String) as string, name: null });
      expect(row!.events.map((e) => e.recordedByName)).toEqual([null]);
      const text = JSON.stringify(await listIncidents(db, fx.aide.actor)) + JSON.stringify(await getIncident(db, fx.aide.actor, incidentId));
      expect(text).not.toContain("ph.mehta");
      expect(text).not.toContain(fx.pharmacist.id);
      expect(text).not.toContain("the.ms");
      expect(text).not.toContain(reviewer.id);
      // The reporter reading their own report is not told more than any other recorder.
      expect((await listIncidents(db, fx.pharmacist.actor))[0]!.reporter.name).toBeNull();
    });

    it("a holder of pharmacy.incidents.review is told the name, beside the role", async () => {
      const { incidentId } = await recordIncident(db, fx.pharmacist.actor, base(), MON);
      await addIncidentEvent(db, reviewer.actor, incidentId, { kind: "reviewed", rootCause: "Interrupted mid-pick", actionTaken: "Quiet zone" }, MON2);
      const row = await getIncident(db, reviewer.actor, incidentId);
      expect(row.reporter).toMatchObject({ role: "pharmacy", name: "ph.mehta" });
      expect(row.events[0]!.recordedByName).toBe("the.ms");
    });

    it("the domain event carries codes only: no name, no narrative", async () => {
      await recordIncident(db, fx.pharmacist.actor, base(), MON);
      const rows = await db.select().from(events).where(sql`${events.name} = 'incident.recorded'`);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/ph\.mehta|Chlorpromazine/);
    });

    it("the reporter's role is snapshotted from the role that grants record; a person with none may not record", async () => {
      expect((await listIncidents(db, fx.aide.actor))).toEqual([]);
      await recordIncident(db, fx.aide.actor, base(), MON);
      expect((await listIncidents(db, reviewer.actor))[0]!.reporter.role).toBe("pharmacy_assistant");
      expect(await refusal(recordIncident(db, fx.clerk.actor, base(), MON))).toBe("permission_denied");
      expect(await refusal(listIncidents(db, fx.clerk.actor))).toBe("permission_denied");
    });
  });

  it("review then close: close needs a review, a closed incident takes no further act, only a reviewer acts", async () => {
    const { incidentId } = await recordIncident(db, fx.pharmacist.actor, base({ kind: "error", category: "E" }), MON);
    expect(await refusal(addIncidentEvent(db, fx.pharmacist.actor, incidentId, { kind: "reviewed", rootCause: "x", actionTaken: "y" }, MON2))).toBe("permission_denied");
    expect(await refusal(addIncidentEvent(db, reviewer.actor, incidentId, { kind: "closed" }, MON2))).toBe("invalid_incident");
    expect(await refusal(addIncidentEvent(db, reviewer.actor, incidentId, { kind: "reviewed", rootCause: " ", actionTaken: "y" }, MON2))).toBe("invalid_incident");
    expect(await incidentsAwaitingReview(db, reviewer.actor)).toHaveLength(1);
    await addIncidentEvent(db, reviewer.actor, incidentId, { kind: "reviewed", rootCause: "Strength not read back", actionTaken: "Read-back at hand-over" }, MON2);
    expect(await incidentsAwaitingReview(db, reviewer.actor)).toEqual([]);
    await addIncidentEvent(db, reviewer.actor, incidentId, { kind: "closed", note: "Committee 2026-08" }, MON3);
    expect(await refusal(addIncidentEvent(db, reviewer.actor, incidentId, { kind: "reviewed", rootCause: "a", actionTaken: "b" }, MON3))).toBe("incident_closed");
    expect(await refusal(addIncidentEvent(db, reviewer.actor, "nope", { kind: "closed" }, MON3))).toBe("unknown_incident");
    const row = await getIncident(db, reviewer.actor, incidentId);
    expect(row.state).toEqual({ reviewed: true, rootCause: "Strength not read back", actionTaken: "Read-back at hand-over", closed: true });
    expect(await listIncidents(db, reviewer.actor, { open: true })).toEqual([]);
  });

  describe("with a dispense on file", () => {
    beforeEach(async () => {
      await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", at: MON });
      await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    });

    /** One prescription of Crocin through the whole counter, handed over a minute after `at`: one dispensed line. */
    async function handedOver(at: Date): Promise<string> {
      const n = 1;
      const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
      const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, at);
      if (r.kind !== "dispense") throw new Error("no dispense");
      const id = r.dispense.id;
      await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, at);
      await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: Array.from({ length: n }, (_, i) => ({ lineIdx: i, qtyBase: 2 })) }, at);
      await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, at);
      const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, at);
      await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, at);
      await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, new Date(at.getTime() + 60_000));
      return id;
    }

    it("the desk's line pre-fills patient and item; a line of another patient is refused", async () => {
      const dispenseId = await handedOver(MON2);
      const { incidentId } = await recordIncident(db, fx.pharmacist.actor, base({ dispenseLine: { dispenseId, lineIdx: 0 } }), MON3);
      const row = await getIncident(db, reviewer.actor, incidentId);
      expect(row.patient?.id).toBe(fx.patient.id);
      expect(row.item?.id).toBe(fx.item.crocin);
      expect(row.lineIdx).toBe(0);
      expect(row.dispenseNo).not.toBeNull();
      const other = await mkPatient(db, fx.clerk.actor, { name: "Ravi Kumar", phone: "9811122233", sex: "male" });
      expect(await refusal(recordIncident(db, fx.pharmacist.actor, base({ dispenseLine: { dispenseId, lineIdx: 0 }, patientId: other.id }), MON3))).toBe("invalid_incident");
      expect(await refusal(recordIncident(db, fx.pharmacist.actor, base({ dispenseLine: { dispenseId, lineIdx: 9 } }), MON3))).toBe("invalid_incident");
    });

    it("the indicator: errors per 1,000 handed-over lines in the IST month, near misses counted apart", async () => {
      for (let i = 0; i < 4; i += 1) await handedOver(MON2);
      await recordIncident(db, fx.pharmacist.actor, base({ kind: "error", category: "D", type: "wrong_dose" }), MON3);
      await recordIncident(db, fx.pharmacist.actor, base(), MON3);
      await recordIncident(db, fx.pharmacist.actor, base({ category: "A" }), MON3);
      const out = await incidentIndicator(db, fx.aide.actor, { months: 2 }, MON3);
      expect(out.months).toEqual([
        { month: "2026-07", errors: 0, nearMisses: 0, dispensedLines: 0, counterLines: 0, walkInLines: 0, errorsPer1000: null },
        { month: "2026-08", errors: 1, nearMisses: 2, dispensedLines: 4, counterLines: 4, walkInLines: 0, errorsPer1000: 250 },
      ]);
      // No person on the indicator, whoever reads it.
      expect(JSON.stringify(await incidentIndicator(db, reviewer.actor, { months: 2 }, MON3))).not.toMatch(/ph\.mehta|role/);
    });
  });
});

describe("buildNeeds — the medication incident side of LAW (pharmacy stage D2)", () => {
  const NOW = new Date("2026-09-28T06:00:00.000Z");
  const none: NeedInputs = { buy: null, pay: null, returns: null, grns: null, retail: null, cabinet: null, pharmacists: null, adr: null, incidents: null };
  const at = (hoursAgo: number): string => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

  it("red at category E or above once 24 h unreviewed; amber below E, and at E inside the 24 h", () => {
    const out = buildNeeds({ ...none, incidents: [
      { id: "e-late", no: "MI-000001", kind: "error", category: "E", stage: "dispensing", type: "wrong_strength", createdAt: at(25) },
      { id: "e-new", no: "MI-000002", kind: "error", category: "G", stage: "administration", type: "wrong_dose", createdAt: at(2) },
      { id: "b-old", no: "MI-000003", kind: "near_miss", category: "B", stage: "dispensing", type: "lasa_mixup", createdAt: at(72) },
      { id: "d-old", no: "MI-000004", kind: "error", category: "D", stage: "dispensing", type: "wrong_quantity", createdAt: at(48) },
    ] }, NOW);
    const byId = Object.fromEntries(out.rows.map((r) => [r.id, r]));
    expect(byId["law:incident:e-late"]).toMatchObject({ source: "LAW", kind: "incident_review_overdue", clock: { code: "waited", n: 25 * 60, tone: "rd" }, tier: 0, ref: { kind: "incident", id: "e-late" } });
    expect(byId["law:incident:e-new"]).toMatchObject({ kind: "incident_review", clock: { tone: "gd" }, tier: 3 });
    expect(byId["law:incident:b-old"]).toMatchObject({ kind: "incident_review", clock: { tone: "gd" }, tier: 3 });
    expect(byId["law:incident:d-old"]).toMatchObject({ kind: "incident_review", clock: { tone: "gd" } });
    expect(out.rows[0]!.id).toBe("law:incident:e-late");
    expect(out.sides).toEqual(["LAW"]);
    // No patient and no person on the office list.
    expect(JSON.stringify(out.rows)).not.toMatch(/patient|uhid|reporter|name/i);
  });
});
