import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { startInstance, transition } from "../../kernel/workflow/instances";
import { listMedicines, resolveDrugTexts } from "../formulary";
import { findStoreByCode, listItems } from "../materials";
import { findVisitByToken, getPrescription, getVisit, listVisits, verifyPrescriptionQr } from "../opd";
import { getPatientSummaries, searchPatients, verifyQrScan } from "../patients";
import { OPD_PHARMACY_STORE_CODE, REFUSED_FLAGS, SCHEDULED_FLAGS, istDateOf } from "./config";
import { dispenseClaimed } from "./events";
import { PharmacyError } from "./errors";
import { enqueueDispense, getDispense, getDispenseRow, liveDispenseFor } from "./queue";
import { prefillQtyBase } from "./qty";
import { PHARMACY_DISPENSE_DEF_KEY } from "./workflow-def";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { PrescriptionRow, RxLine } from "../opd";
import type { DispenseView } from "./queue";

export type CounterDoor = "rx_qr" | "patient_qr" | "token" | "uhid";

export type FindResult =
  | { kind: "dispense"; door: CounterDoor; dispense: DispenseView }
  | { kind: "patients"; door: "uhid"; patients: { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean }[] }
  | { kind: "none"; door: CounterDoor; reason: "not_found" | "qr_invalid" | "no_prescription_today" };

/**
 * PLAN 16c D4 — ONE FIELD, THREE DOORS (17c D4's shape). What the pharmacist types or scans decides
 * the door; a NAME never selects — a list of matches comes back for a person to confirm.
 *
 *   `rx1.…`  the printed e-Rx's signed QR → that prescription, exactly
 *   `q1.…`   the patient card's signed QR  → that patient's prescription of today
 *   `T-14`   today's token                 → that visit's prescription
 *   else     a UHID or a name              → `searchPatients`, one hit resolves, many confirm
 *
 * Whatever the door, the answer is the QUEUED dispense for the prescription, created here if the
 * `prescription.issued` consumer has not run yet (D10's second writer).
 */
export async function findAtCounter(db: Db, cfg: AppConfig, actor: Actor, q: string, now: Date): Promise<FindResult> {
  const text = q.trim();
  if (text === "") return { kind: "none", door: "uhid", reason: "not_found" };

  if (text.startsWith("rx1.")) {
    const v = await verifyPrescriptionQr(db, cfg, actor, text);
    if (!v.ok) return { kind: "none", door: "rx_qr", reason: "qr_invalid" };
    const rx = await getPrescription(db, actor, v.prescription.id);
    if (rx === null) return { kind: "none", door: "rx_qr", reason: "not_found" };
    return { kind: "dispense", door: "rx_qr", dispense: await ensureQueued(db, actor, rx, now) };
  }

  if (text.startsWith("q1.")) {
    const v = await verifyQrScan(db, cfg, actor, text);
    if (!v.ok) return { kind: "none", door: "patient_qr", reason: "qr_invalid" };
    return todaysDispense(db, actor, v.patient.id, "patient_qr", now);
  }

  const token = /^t-?\s*(\d{1,5})$/i.exec(text);
  if (token !== null) {
    const visit = await findVisitByToken(db, { serviceDate: istDateOf(now), tokenNo: Number(token[1]) });
    if (visit === null) return { kind: "none", door: "token", reason: "not_found" };
    const rx = await activePrescriptionOf(db, actor, visit.id);
    if (rx === null) return { kind: "none", door: "token", reason: "no_prescription_today" };
    return { kind: "dispense", door: "token", dispense: await ensureQueued(db, actor, rx, now) };
  }

  const hits = await searchPatients(db, actor, text);
  if (hits.length === 0) return { kind: "none", door: "uhid", reason: "not_found" };
  if (hits.length > 1) {
    const summaries = await getPatientSummaries(db, actor, hits.map((h) => h.id));
    return { kind: "patients", door: "uhid", patients: summaries.map((s) => ({ id: s.id, uhid: s.uhid, name: s.name, alias: s.alias, restricted: s.restricted })) };
  }
  return todaysDispense(db, actor, hits[0]!.id, "uhid", now);
}

/** The patient's prescription of today, through the visit read (which logs the PHI access). */
async function todaysDispense(db: Db, actor: Actor, patientId: string, door: CounterDoor, now: Date): Promise<FindResult> {
  const visits = (await listVisits(db, { serviceDate: istDateOf(now) })).filter((v) => v.patientId === patientId);
  for (const visit of visits.reverse()) {
    const rx = await activePrescriptionOf(db, actor, visit.id);
    if (rx !== null) return { kind: "dispense", door, dispense: await ensureQueued(db, actor, rx, now) };
  }
  return { kind: "none", door, reason: "no_prescription_today" };
}

async function activePrescriptionOf(db: Db, actor: Actor, encounterId: string): Promise<PrescriptionRow | null> {
  const visit = await getVisit(db, actor, encounterId);
  if (visit === null) return null;
  const active = visit.prescriptions.filter((p) => p.status === "active").sort((a, b) => b.version - a.version);
  return active[0] ?? null;
}

async function ensureQueued(db: Db, actor: Actor, rx: PrescriptionRow, now: Date): Promise<DispenseView> {
  const live = await liveDispenseFor(db, rx.id, rx.version);
  const dispenseId = live?.id ?? (await withTx(db, (tx) => enqueueDispense(tx, actor, {
    prescriptionId: rx.id, prescriptionVersion: rx.version, patientId: rx.patientId, encounterId: rx.encounterId, source: "scan",
  }, now))).dispenseId;
  return getDispense(db, actor, dispenseId);
}

/**
 * THE CLAIM: a QUEUED dispense becomes this counter's, its lines are laid out (resolved medicine,
 * schedule, stocked item, prefilled quantity), and the `pharmacy_dispense` instance starts.
 *
 * ═══ A1 — TWO COUNTERS, ONE CLAIM ═══
 *
 * The UPDATE is conditional on `status = 'queued'` and returns the row it changed; the second
 * counter's UPDATE changes nothing and is refused with `dispense_not_in_state`. No `for update`
 * needed: the conditional write IS the arbiter, and it never double-claims.
 *
 * ═══ SCHEDULE X IS REFUSED HERE (D7, owner ruling R-3) ═══
 *
 * Before any line is written: a prescription carrying an X line cannot be dispensed at this counter
 * at all in 16c, and the pharmacist is told which line and why rather than finding out at hand-over.
 */
export async function claimDispense(
  db: Db,
  actor: Actor,
  input: { dispenseId: string; door: CounterDoor },
  now: Date,
): Promise<DispenseView> {
  const d = await getDispenseRow(db, input.dispenseId);
  if (d.status !== "queued") throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}, not queued`, { status: d.status });
  const rx = await getPrescription(db, actor, d.prescriptionId);
  if (rx === null) throw new PharmacyError("unknown_prescription", `prescription ${d.prescriptionId} not found`);
  if (rx.status !== "active") {
    await withTx(db, (tx) => tx.update(pharmacyDispenses)
      .set({ status: "cancelled", cancelledBy: actor.id, cancelledAt: now, cancelReason: "prescription superseded" })
      .where(and(eq(pharmacyDispenses.id, d.id), eq(pharmacyDispenses.status, "queued"))));
    throw new PharmacyError("prescription_superseded", `prescription ${rx.id} v${String(rx.version)} is ${rx.status} — scan the current version`);
  }
  const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  if (store === undefined) throw new PharmacyError("store_missing", `no materials store "${OPD_PHARMACY_STORE_CODE}" — the go-live runbook creates it`);

  const lines = rx.lines as RxLine[];
  const medicines = new Map((await listMedicines(db)).map((m) => [m.id, m]));
  const texts = lines.filter((l) => !l.medicineId).map((l) => l.drug);
  const resolved = texts.length === 0 ? new Map<string, { medicineId: string | null } | null>() : await resolveDrugTexts(db, texts);
  const drugItems = await listItems(db, { class: "drug", active: true });
  const itemByMedicine = new Map(drugItems.filter((i) => i.formularyMedicineId !== null).map((i) => [i.formularyMedicineId as string, i]));

  const laid = lines.map((line, lineIdx) => {
    const ordered = line.medicineId ?? null;
    const viaText = ordered === null ? (resolved.get(line.drug)?.medicineId ?? null) : null;
    const dispensedMedicineId = ordered ?? viaText;
    const med = dispensedMedicineId === null ? undefined : medicines.get(dispensedMedicineId);
    const scheduleFlag = med?.scheduleFlag ?? null;
    if (scheduleFlag !== null && (REFUSED_FLAGS as readonly string[]).includes(scheduleFlag)) {
      throw new PharmacyError(
        "schedule_x_not_dispensed_here",
        `line ${String(lineIdx + 1)} (${line.drug}) is Schedule ${scheduleFlag} — not dispensed at the OPD counter until double custody (16d)`,
        { lineIdx, scheduleFlag },
      );
    }
    const item = dispensedMedicineId === null ? undefined : itemByMedicine.get(dispensedMedicineId);
    return {
      id: newId(), dispenseId: d.id, lineIdx, rxLine: line,
      orderedMedicineId: ordered, dispensedMedicineId,
      substitutionType: ordered === null && viaText !== null ? "resolved" : "none",
      itemId: item?.id ?? null, qtyBase: prefillQtyBase(line), scheduleFlag, status: "open" as const,
    };
  });
  const scheduled = laid.some((l) => l.scheduleFlag !== null && (SCHEDULED_FLAGS as readonly string[]).includes(l.scheduleFlag));

  await withTx(db, async (tx) => {
    const won = await tx.update(pharmacyDispenses)
      .set({ status: "claimed", claimedBy: actor.id, claimedAt: now, storeResourceId: store.id, scheduled })
      .where(and(eq(pharmacyDispenses.id, d.id), eq(pharmacyDispenses.status, "queued")))
      .returning({ id: pharmacyDispenses.id });
    if (won.length === 0) throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} was claimed by another counter`, { status: "claimed" });
    await tx.insert(pharmacyDispenseLines).values(laid);
    const { instanceId } = await startInstance(tx, PHARMACY_DISPENSE_DEF_KEY, { type: "pharmacy_dispense", id: d.id, patientId: d.patientId, encounterId: d.encounterId });
    await transition(tx, instanceId, "claimed", actor);
    await tx.update(pharmacyDispenses).set({ workflowInstanceId: instanceId }).where(eq(pharmacyDispenses.id, d.id));
    await appendEvent(tx, dispenseClaimed.make({
      actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: { dispenseId: d.id, patientId: d.patientId, encounterId: d.encounterId, prescriptionId: d.prescriptionId, lineCount: laid.length, door: input.door },
    }));
  });
  return getDispense(db, actor, d.id);
}
