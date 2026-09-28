import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkPatient, mkUser } from "../../../test/helpers/opd";
import { MON, issueRx, line, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  events, formularySalts, patientAllergies, pharmacyAdrEvents, pharmacyAdrReports, pharmacyAdrSuspects, pharmacyDispenses,
} from "../../kernel/db/schema";
import { runRxChecks } from "../opd";
import { addAdrEvent, adrAwaitingPvpi, allergySeverityOf, getAdr, listAdr, recordAdr } from "./adr";
import { adrDocument, initialsOf } from "./adr-print";
import { PharmacyError } from "./errors";
import { enqueueDispense } from "./queue";
import type { RecordAdrInput } from "./adr";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY STAGE D1 — THE ADR REGISTER, AND THE LOOP THAT HAS TO CLOSE ═══
 *
 * The defect this stage exists to prevent is a reported reaction that does not reach the next allergy
 * gate. The first test is that loop, end to end: a reaction reported against ONE brand of a moiety,
 * and the next prescription of a DIFFERENT brand of the same moiety is caught by opd's allergy check.
 */
const NOW = new Date("2026-09-28T06:10:00.000Z");

async function saltId(db: Db, name: string): Promise<string> {
  const rows = await db.select({ id: formularySalts.id }).from(formularySalts).where(eq(formularySalts.name, name));
  return rows[0]!.id;
}

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { if (e instanceof PharmacyError) return e.code; throw e; }
  return "no refusal";
};

describe("the ADR register (pharmacy stage D1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let manager: Awaited<ReturnType<typeof mkUser>>;
  let para: string;

  const base = (over: Partial<RecordAdrInput> = {}): RecordAdrInput => ({
    patientId: fx.patient.id, reaction: "Generalised urticaria and lip swelling 40 minutes after the second dose", onsetDate: "2026-09-20",
    seriousness: "hospitalisation", outcome: "recovered", dechallenge: "yes", rechallenge: "na",
    suspects: [{ saltId: para, name: "Crocin 500", batchNo: "CR2211", dose: "500 mg", route: "oral", frequency: "TDS", startDate: "2026-09-19", stopDate: "2026-09-20" }],
    ...over,
  });

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.adr.record");
    await ensureRole(db, "adr_manager");
    await grantPermissionToRole(db, fx.registry, "adr_manager", "pharmacy.adr.manage");
    manager = await mkUser(db, "the.ms", ["adr_manager"]);
    para = await saltId(db, "Paracetamol");
  });
  afterEach(() => { fx.unregister(); });

  it("THE LOOP: a reaction reported against one brand is caught on the next prescription of another brand of the same moiety", async () => {
    const calpol = [line({ drug: "Calpol 500", medicineId: fx.med.calpol })];
    const before = await runRxChecks(db, fx.patient.id, calpol, NOW);
    expect(before.allergyMatches).toEqual([]);

    const out = await recordAdr(db, fx.pharmacist.actor, base(), NOW);
    expect(out.no).toBe("ADR-000001");

    const after = await runRxChecks(db, fx.patient.id, calpol, NOW);
    expect(after.allergyMatches).toEqual([{ lineIndex: 0, substance: "Paracetamol" }]);
    // And an unrelated drug is not caught.
    expect((await runRxChecks(db, fx.patient.id, [line({ drug: "Azee 500", medicineId: fx.med.azithro })], NOW)).allergyMatches).toEqual([]);
  });

  it("writes the allergy in the same transaction: source pharmacy, the moiety coded, severity from seriousness, one per moiety", async () => {
    const out = await recordAdr(db, fx.pharmacist.actor, base({
      suspects: [{ saltId: para, name: "Crocin 500" }, { saltId: para, name: "Calpol 500" }, { name: "Ayurvedic cough syrup" }],
    }), NOW);
    const allergies = await db.select().from(patientAllergies).where(eq(patientAllergies.patientId, fx.patient.id));
    expect(allergies.map((a) => [a.substance, a.source, a.saltId, a.severity]).sort()).toEqual([
      ["Ayurvedic cough syrup", "pharmacy", null, "severe"],
      ["Paracetamol", "pharmacy", para, "severe"],
    ]);
    expect(out.allergyIds).toHaveLength(2);
    const suspects = await db.select().from(pharmacyAdrSuspects).orderBy(pharmacyAdrSuspects.position);
    expect(suspects.map((s) => s.name)).toEqual(["Crocin 500", "Calpol 500", "Ayurvedic cough syrup"]);
    // Two brands of one moiety point at ONE allergy.
    expect(suspects[0]!.allergyId).toBe(suspects[1]!.allergyId);
    // The event carries ids and codes, never the reaction's words.
    const ev = (await db.select().from(events).where(eq(events.name, "adr.reported")))[0]!;
    expect(JSON.stringify(ev.payload)).not.toContain("urticaria");
    expect(allergySeverityOf("not_serious")).toBe("mild");
    expect(allergySeverityOf("other_medically_important")).toBe("moderate");
  });

  it("a refused report writes nothing — no allergy survives a report that did not file", async () => {
    expect(await refusal(recordAdr(db, fx.pharmacist.actor, base({ onsetDate: "2026-10-30" }), NOW))).toBe("invalid_adr");
    expect(await refusal(recordAdr(db, fx.pharmacist.actor, base({ suspects: [{ saltId: "01NOSUCHSALT000000000000000" }] }), NOW))).toBe("invalid_adr");
    expect(await refusal(recordAdr(db, fx.pharmacist.actor, base({ suspects: [] }), NOW))).toBe("invalid_adr");
    expect(await refusal(recordAdr(db, fx.pharmacist.actor, base({ recoveryDate: "2026-09-10" }), NOW))).toBe("invalid_adr");
    expect((await db.select().from(patientAllergies)).length).toBe(0);
    expect((await db.select().from(pharmacyAdrReports)).length).toBe(0);
  });

  it("a dispense named on the form must be this patient's", async () => {
    const other = await mkPatient(db, fx.clerk.actor, {});
    const rx = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })], { patientId: other.id, at: MON });
    const { dispenseId } = await withTx(db, (tx) => enqueueDispense(tx, fx.pharmacist.actor, {
      prescriptionId: rx.issued.prescriptionId, prescriptionVersion: rx.issued.version, patientId: other.id, encounterId: rx.encounter.id, source: "scan",
    }, MON));
    expect((await db.select().from(pharmacyDispenses).where(eq(pharmacyDispenses.id, dispenseId)))[0]!.patientId).toBe(other.id);
    expect(await refusal(recordAdr(db, fx.pharmacist.actor, base({ suspects: [{ saltId: para, dispenseId }] }), NOW))).toBe("invalid_adr");
    expect((await db.select().from(patientAllergies)).length).toBe(0);
  });

  it("the three tables are append-only by trigger", async () => {
    const { reportId } = await recordAdr(db, fx.pharmacist.actor, base(), NOW);
    await addAdrEvent(db, manager.actor, reportId, { kind: "causality_assessed", causality: "probable" }, NOW);
    await expect(db.update(pharmacyAdrReports).set({ outcome: "fatal" }).where(eq(pharmacyAdrReports.id, reportId))).rejects.toThrow(/pharmacy_adr_immutable/);
    await expect(db.delete(pharmacyAdrReports).where(eq(pharmacyAdrReports.id, reportId))).rejects.toThrow(/pharmacy_adr_immutable/);
    await expect(db.execute(sql`update pharmacy_adr_suspects set name = 'x'`)).rejects.toThrow(/pharmacy_adr_immutable/);
    await expect(db.execute(sql`delete from pharmacy_adr_suspects`)).rejects.toThrow(/pharmacy_adr_immutable/);
    await expect(db.execute(sql`update pharmacy_adr_events set causality = 'certain'`)).rejects.toThrow(/pharmacy_adr_immutable/);
    await expect(db.execute(sql`delete from pharmacy_adr_events`)).rejects.toThrow(/pharmacy_adr_immutable/);
  });

  it("later acts are events: causality, sent to PvPI once, closed; a closed report takes nothing more", async () => {
    const { reportId } = await recordAdr(db, fx.pharmacist.actor, base(), NOW);
    expect((await adrAwaitingPvpi(db, manager.actor)).map((a) => a.id)).toEqual([reportId]);
    // Closing an unsent report needs a reason.
    expect(await refusal(addAdrEvent(db, manager.actor, reportId, { kind: "closed" }, NOW))).toBe("invalid_adr");
    await addAdrEvent(db, manager.actor, reportId, { kind: "causality_assessed", causality: "possible" }, NOW);
    await addAdrEvent(db, manager.actor, reportId, { kind: "causality_assessed", causality: "probable", note: "positive dechallenge" }, NOW);
    expect(await refusal(addAdrEvent(db, manager.actor, reportId, { kind: "sent_to_pvpi", sentOn: "2026-10-01", channel: "amc" }, NOW))).toBe("invalid_adr");
    await addAdrEvent(db, manager.actor, reportId, { kind: "sent_to_pvpi", sentOn: "2026-09-28", channel: "pvpi_app", pvpiRef: "IN-IPC-300012345" }, NOW);
    expect(await adrAwaitingPvpi(db, manager.actor)).toEqual([]);
    expect(await refusal(addAdrEvent(db, manager.actor, reportId, { kind: "sent_to_pvpi", sentOn: "2026-09-28", channel: "email" }, NOW))).toBe("invalid_adr");
    await addAdrEvent(db, manager.actor, reportId, { kind: "closed" }, NOW);
    expect(await refusal(addAdrEvent(db, manager.actor, reportId, { kind: "causality_assessed", causality: "certain" }, NOW))).toBe("adr_closed");
    const detail = await getAdr(db, manager.actor, reportId);
    expect(detail.state).toEqual({ causality: "probable", sentOn: "2026-09-28", channel: "pvpi_app", pvpiRef: "IN-IPC-300012345", closed: true });
    expect(detail.events.map((e) => e.kind)).toEqual(["causality_assessed", "causality_assessed", "sent_to_pvpi", "closed"]);
    expect((await db.select().from(pharmacyAdrEvents)).length).toBe(4);
    expect(await refusal(addAdrEvent(db, manager.actor, "01NOSUCHREPORT0000000000000", { kind: "closed", note: "x" }, NOW))).toBe("unknown_adr");
  });

  it("the register is read by those who record or manage it, and nobody else", async () => {
    await recordAdr(db, fx.pharmacist.actor, base(), NOW);
    expect(await refusal(listAdr(db, fx.clerk.actor))).toBe("permission_denied");
    expect(await refusal(adrAwaitingPvpi(db, fx.clerk.actor))).toBe("permission_denied");
    const byRecorder = await listAdr(db, fx.pharmacist.actor);
    const byManager = await listAdr(db, manager.actor, { open: true });
    expect(byRecorder.map((r) => r.no)).toEqual(["ADR-000001"]);
    expect(byManager.map((r) => [r.no, r.suspects, r.seriousness])).toEqual([["ADR-000001", ["Crocin 500"], "hospitalisation"]]);
    expect(byManager[0]!.patient?.uhid).toBe(fx.patient.uhid);
  });

  it("prints the PvPI form: the form's items, initials and the reporter's staff ID — never the reporter's name", async () => {
    const { reportId } = await recordAdr(db, fx.pharmacist.actor, base({ weightKg: 58, concomitants: [{ name: "Pantoprazole 40", dose: "40 mg", route: "oral" }] }), NOW);
    const doc = await adrDocument(db, manager.actor, reportId);
    expect(doc.page).toEqual({ widthMm: 210, heightMm: 297 });
    for (const s of ["Suspected Adverse Drug Reaction Reporting Form", "1. Patient initials", "Generalised urticaria", "Crocin 500", "CR2211", "Pantoprazole 40", "58.0 kg", "ADR-000001"]) {
      expect(doc.html).toContain(s);
    }
    expect(doc.html).not.toContain("ph.mehta"); // the reporter's name/username
    expect(initialsOf("Asha Devi Kumari")).toBe("A. D. K.");
    expect(initialsOf(null)).toBe("");
  });
});
