import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { startInstance, transition } from "../../kernel/workflow/instances";
import { medicinesByIds, ndpsClassByMedicine, resolveDrugTexts } from "../formulary";
import { findStoreByCode, listItems } from "../materials";
import { findVisitByToken, getPrescription, getVisit, listVisits, verifyPrescriptionQr } from "../opd";
import { getPatientSummaries, searchPatients, verifyQrScan } from "../patients";
import { OPD_PHARMACY_STORE_CODE, SCHEDULED_FLAGS, istDateOf } from "./config";
import { assertControlledLinesAllowed, controlOf } from "./controlled";
import { dispenseClaimed, lineMatched } from "./events";
import { MATCH_ACTOR, chooseMatch, matchesFor, shelfIndex, targetOf } from "./auto-match";
import type { Matched } from "./auto-match";
import { PharmacyError } from "./errors";
import { enqueueDispense, getDispense, getDispenseRow, liveDispenseFor, userNames } from "./queue";
import { prefillQtyBase } from "./qty";
import { PHARMACY_DISPENSE_DEF_KEY } from "./workflow-def";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db, Tx } from "../../kernel/db/client";
import type { PrescriptionRow, RxLine } from "../opd";
import type { DispenseRow, DispenseView } from "./queue";

export type CounterDoor = "rx_qr" | "patient_qr" | "token" | "uhid";

export type FindResult =
  | { kind: "dispense"; door: CounterDoor; dispense: DispenseView }
  | { kind: "patients"; door: "uhid"; patients: { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean }[] }
  | { kind: "none"; door: CounterDoor; reason: "not_found" | "qr_invalid" | "no_prescription_today" | "restricted" };

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
    /*
      PD-3 / E3b — the signature has just proved this prescription exists, so a null from the
      reader's own read has one meaning: a sealed patient this pharmacist may not open. The patient
      is at the window holding the slip; "not found" would send them away with a real prescription.
    */
    if (rx === null) return { kind: "none", door: "rx_qr", reason: "restricted" };
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
  return getDispense(db, actor, dispenseId, now);
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
/**
 * PD-1 / E1 — the refusal a second pharmacist meets, and it says WHO. Read at the moment of refusal:
 * the loser of a race learns the winner, which the list they clicked from could not yet show.
 */
async function notQueued(db: Db | Tx, d: DispenseRow): Promise<PharmacyError> {
  const claimedByName = d.claimedBy === null ? null : ((await userNames(db, [d.claimedBy])).get(d.claimedBy) ?? null);
  const who = d.status === "claimed" && claimedByName !== null ? ` by ${claimedByName}` : "";
  return new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}${who}, not queued`, {
    status: d.status, claimedBy: d.claimedBy, claimedByName,
  });
}

export async function claimDispense(
  db: Db,
  actor: Actor,
  input: { dispenseId: string; door: CounterDoor },
  now: Date,
): Promise<DispenseView> {
  const d = await getDispenseRow(db, input.dispenseId);
  if (d.status !== "queued") throw await notQueued(db, d);
  const rx = await getPrescription(db, actor, d.prescriptionId);
  /*
    PD-1 — NOT "not found". `pharmacy_dispenses.prescription_id` is a foreign key, so the row EXISTS;
    `getPrescription` answers null only because this reader may not see the patient — a sealed record
    and neither `patients.confidential.read` nor break-glass. The ticket is on this pharmacist's own
    list under the alias, so "no such prescription" was a false sentence about a real one. The grant
    is not widened here; the refusal says who can take it.
  */
  if (rx === null) {
    throw new PharmacyError(
      "permission_denied",
      "this ticket is a sealed record — a pharmacist who may read sealed records, or break-glass, must take it",
      { reason: "patient_restricted" },
    );
  }
  if (rx.status !== "active") {
    await withTx(db, (tx) => tx.update(pharmacyDispenses)
      .set({ status: "cancelled", cancelledBy: actor.id, cancelledAt: now, cancelReason: "prescription superseded" })
      .where(and(eq(pharmacyDispenses.id, d.id), eq(pharmacyDispenses.status, "queued"))));
    throw new PharmacyError("prescription_superseded", `prescription ${rx.id} v${String(rx.version)} is ${rx.status} — scan the current version`);
  }
  const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  if (store === undefined) throw new PharmacyError("store_missing", `no materials store "${OPD_PHARMACY_STORE_CODE}" — the go-live runbook creates it`);

  const lines = rx.lines as RxLine[];
  /**
   * THE TWO STATEMENTS SWAPPED ORDER, and the compiler now enforces it: the set of medicines this
   * claim names is not known until the free-text lines have been resolved, so resolution comes
   * first and the id-keyed read second. `const`'s temporal dead zone makes the wrong order a
   * compile error — but only the ORDER, not the COMPLETENESS of the set, which is why the test
   * beside this pins the brand a claimed line actually renders.
   */
  const texts = lines.filter((l) => !l.medicineId).map((l) => l.drug);
  const resolved = texts.length === 0 ? new Map<string, { medicineId: string | null } | null>() : await resolveDrugTexts(db, texts);
  const medicines = await medicinesByIds(db, [
    ...lines.map((l) => l.medicineId ?? null),
    ...[...resolved.values()].map((r) => r?.medicineId ?? null),
  ].filter((x): x is string => x !== null));
  const drugItems = await listItems(db, { class: "drug", active: true });
  const itemByMedicine = new Map(drugItems.filter((i) => i.formularyMedicineId !== null).map((i) => [i.formularyMedicineId as string, i]));
  // PHARMACY P6 — the NDPS class beside the schedule flag: together they say which lines are controlled.
  const ndps = await ndpsClassByMedicine(db, [...medicines.keys()]);

  const laid = lines.map((line, lineIdx) => {
    const ordered = line.medicineId ?? null;
    const viaText = ordered === null ? (resolved.get(line.drug)?.medicineId ?? null) : null;
    const dispensedMedicineId = ordered ?? viaText;
    const med = dispensedMedicineId === null ? undefined : medicines.get(dispensedMedicineId);
    const scheduleFlag = med?.scheduleFlag ?? null;
    const ndpsClass = dispensedMedicineId === null ? null : (ndps.get(dispensedMedicineId) ?? null);
    const item = dispensedMedicineId === null ? undefined : itemByMedicine.get(dispensedMedicineId);
    return {
      id: newId(), dispenseId: d.id, lineIdx, rxLine: line,
      orderedMedicineId: ordered, dispensedMedicineId,
      substitutionType: (ordered === null && viaText !== null ? "resolved" : "none") as "resolved" | "none",
      itemId: (item?.id ?? null) as string | null, qtyBase: prefillQtyBase(line), scheduleFlag: scheduleFlag as string | null,
      ndpsClass: ndpsClass as string | null, status: "open" as const,
    };
  });
  /**
   * R-3 (owner ruling 2026-09-02) AS PHARMACY P6 LEFT IT: a Schedule X line was refused here outright
   * "until double custody"; the custody now exists, so the refusal stands exactly where the LICENCE is
   * missing or lapsed — Form 20F for Schedule X, RMI recognition for a narcotic drug — and names it.
   */
  await assertControlledLinesAllowed(db, laid.map((l) => ({ lineIdx: l.lineIdx, drug: l.rxLine.drug, scheduleFlag: l.scheduleFlag, ndpsClass: l.ndpsClass })), now);
  /*
    2026-09-23 — a line the doctor named no brand on (free words, or a formulary generic) is filled
    with the stocked brand of exactly its composition (`auto-match.ts`), before the line is written,
    so the pharmacist opens a ticket that already has its item, batch and price.
  */
  const unplaced = laid.filter((l) => l.itemId === null);
  const matched = new Map<number, Matched>();
  if (unplaced.length > 0) {
    const ix = await shelfIndex(db);
    for (const l of unplaced) {
      const target = targetOf(l.rxLine, l.orderedMedicineId === null ? undefined : medicines.get(l.orderedMedicineId), l.dispensedMedicineId === null ? undefined : medicines.get(l.dispensedMedicineId));
      if (target === null) continue;
      const m = await chooseMatch(db, store.id, matchesFor(ix, target), now);
      if (m === null) continue;
      matched.set(l.lineIdx, m);
      Object.assign(l, { dispensedMedicineId: m.medicineId, itemId: m.itemId, substitutionType: "resolved", scheduleFlag: m.scheduleFlag ?? l.scheduleFlag });
    }
  }
  const scheduled = laid.some((l) => (l.scheduleFlag !== null && (SCHEDULED_FLAGS as readonly string[]).includes(l.scheduleFlag)) || controlOf(l.scheduleFlag, l.ndpsClass).controlled);

  await withTx(db, async (tx) => {
    const won = await tx.update(pharmacyDispenses)
      .set({ status: "claimed", claimedBy: actor.id, claimedAt: now, storeResourceId: store.id, scheduled })
      .where(and(eq(pharmacyDispenses.id, d.id), eq(pharmacyDispenses.status, "queued")))
      .returning({ id: pharmacyDispenses.id });
    if (won.length === 0) throw await notQueued(tx, await getDispenseRow(tx, d.id));
    await tx.insert(pharmacyDispenseLines).values(laid);
    const { instanceId } = await startInstance(tx, PHARMACY_DISPENSE_DEF_KEY, { type: "pharmacy_dispense", id: d.id, patientId: d.patientId, encounterId: d.encounterId });
    await transition(tx, instanceId, "claimed", actor);
    await tx.update(pharmacyDispenses).set({ workflowInstanceId: instanceId }).where(eq(pharmacyDispenses.id, d.id));
    for (const l of laid) {
      const m = matched.get(l.lineIdx);
      if (m === undefined) continue;
      await appendEvent(tx, lineMatched.make({
        occurredAt: now, actor: MATCH_ACTOR, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
        payload: {
          dispenseId: d.id, lineIdx: l.lineIdx, patientId: d.patientId, orderedMedicineId: l.orderedMedicineId,
          dispensedMedicineId: m.medicineId, itemId: m.itemId, rule: "salt", candidates: m.candidates, onClaimOf: actor.id,
        },
      }));
    }
    await appendEvent(tx, dispenseClaimed.make({
      occurredAt: now, actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: { dispenseId: d.id, patientId: d.patientId, encounterId: d.encounterId, prescriptionId: d.prescriptionId, lineCount: laid.length, door: input.door },
    }));
  });
  return getDispense(db, actor, d.id, now);
}
