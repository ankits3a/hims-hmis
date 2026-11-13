import { and, asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyAuthorisations } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { isEquivalentMedicine, medicinesByIds } from "../formulary";
import { getDoctor, getPrescription } from "../opd";
import { getPatientSummaries } from "../patients";
import { PharmacyError } from "./errors";
import { authorisationDecided, authorisationRequested } from "./events";
import { requireRegisteredPharmacist } from "./pharmacists";
import { getDispenseRow, linesOf, userNames } from "./queue";
import { refusalKey, refusalsOn } from "./refusals";
import { swapNeedsPrescriber, ticketRefusals } from "./verify";
import type { AuthorisationRow } from "./authorisation-reads";
import type { AuthorisationBook, RefusalBook } from "./refusals";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RxLine } from "../opd";

/**
 * ═══ PD-9 — THE PRESCRIBER AUTHORISES WHAT THE CHECK WOULD REFUSE ═══
 *
 * Owner ruling 2026-09-19: "the doctor must authorise dispensing against a recorded allergy." The
 * standard a teaching hospital's pharmacy keeps: a hard clinical stop at the window is resolved by the
 * PRESCRIBER — the pharmacist intervenes, the doctor decides and signs a reason — and never by the
 * pharmacist overriding it. The same path serves all four books `refusalsOf` refuses on (allergy,
 * severe interaction, a duplicate only a reading can make, a severe contraindication), because each
 * is the same act: a decision the prescriber did not make at issue.
 *
 * ADDRESSED TO A PERSON. The request names the prescriber's user; only that user may decide, and the
 * database refuses a decision by the person who asked. It names ONE hit on ONE line by its identity
 * (`refusalKey`), and only a hit the check really raises on that line — so nothing can be authorised
 * that nobody is being stopped by, and an authorisation clears nothing it does not name.
 */
export type AuthorisationInput = {
  dispenseId: string;
  lineIdx: number;
  /** One of the four books, or (0093, spec #1046 D7) `substitution`: a Schedule H/H1 brand swap. */
  book: AuthorisationBook;
  /** The hit's identity — `refusalKey` — as the line's refusal carried it; for `substitution`, the substitute medicine's id. */
  about: string;
  /** What the pharmacist wants the doctor to know ("tolerated it last year"). */
  note?: string | null;
  /** The medicine the pharmacist is about to give on that line, when it is not the line's own (a substitute, a reading). */
  medicineId?: string | null;
};

function keysOn(refused: Parameters<typeof refusalsOn>[0], lineIdx: number, book: RefusalBook): string[] {
  const r = refusalsOn(refused, lineIdx);
  switch (book) {
    case "allergy": return r.allergy.map((x) => refusalKey("allergy", x));
    case "interaction": return r.interaction.map((x) => refusalKey("interaction", x));
    case "duplicate": return r.duplicate.map((x) => refusalKey("duplicate", x));
    case "drug_disease": return r.drugDisease.map((x) => refusalKey("drug_disease", x));
  }
}

export async function requestAuthorisation(db: Db, actor: Actor, input: AuthorisationInput, now: Date): Promise<AuthorisationRow> {
  const d = await getDispenseRow(db, input.dispenseId);
  if (d.status !== "claimed") {
    throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}; the check has already spoken`, { status: d.status });
  }
  /* A pharmacist-to-prescriber intervention is the pharmacist's act, as the check is (the Act, P2). */
  await requireRegisteredPharmacist(db, actor, now);
  let doctorId: string | null;
  if (input.book === "substitution") {
    doctorId = await swapToAsk(db, actor, input.dispenseId, input.lineIdx, input.about);
  } else {
    const book: RefusalBook = input.book;
    const instead = input.medicineId === undefined || input.medicineId === null ? null : { lineIdx: input.lineIdx, medicineId: input.medicineId };
    const checked = await ticketRefusals(db, actor, input.dispenseId, now, instead);
    doctorId = checked.doctorId;
    if (!keysOn(checked.refused, input.lineIdx, book).includes(input.about)) {
      throw new PharmacyError("authorisation_not_needed", `the check raises no ${input.book} refusal "${input.about}" on line ${String(input.lineIdx + 1)} — there is nothing for the doctor to authorise`, { lineIdx: input.lineIdx });
    }
  }
  const open = await db.select().from(pharmacyAuthorisations).where(and(
    eq(pharmacyAuthorisations.dispenseId, input.dispenseId), eq(pharmacyAuthorisations.lineIdx, input.lineIdx),
    eq(pharmacyAuthorisations.book, input.book), eq(pharmacyAuthorisations.about, input.about), eq(pharmacyAuthorisations.status, "pending"),
  ));
  if (open[0] !== undefined) return open[0];
  // An OUTSIDE doctor's paper prescription (2026-09-30) has no hospital prescriber to ask.
  const doctor = doctorId === null ? null : await getDoctor(db, doctorId);
  if (doctor === null) throw new PharmacyError("not_found", "the prescriber of this prescription is not on record");
  const id = newId();
  const note = (input.note ?? "").trim();
  await withTx(db, async (tx) => {
    await tx.insert(pharmacyAuthorisations).values({
      id, dispenseId: d.id, lineIdx: input.lineIdx, book: input.book, about: input.about,
      prescriberUserId: doctor.userId, requestedBy: actor.id, requestedAt: now, requestNote: note === "" ? null : note, status: "pending",
    });
    await appendEvent(tx, authorisationRequested.make({
      occurredAt: now, actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: { authorisationId: id, dispenseId: d.id, lineIdx: input.lineIdx, patientId: d.patientId, book: input.book, prescriberUserId: doctor.userId, requestedBy: actor.id },
    }));
  });
  const [row] = await db.select().from(pharmacyAuthorisations).where(eq(pharmacyAuthorisations.id, id));
  return row!;
}

/**
 * ═══ 0093 / SPEC #1046 D7 — THE SWAP THE PRESCRIBER IS ASKED TO AGREE TO ═══
 *
 * A real swap on an open line: the substitute is a generic equivalent of the line's medicine (the one
 * equality `verifyDispense` holds), the prescriber did not write "no substitution", and one side of it is
 * Schedule H/H1 (an OTC swap needs only the patient). A paper from a doctor who is not a user here cannot be
 * agreed to by anybody: the pharmacist gives the brand written or the doctor changes the prescription.
 * Returns the prescriber's doctor id.
 */
async function swapToAsk(db: Db, actor: Actor, dispenseId: string, lineIdx: number, substituteId: string): Promise<string> {
  const d = await getDispenseRow(db, dispenseId);
  const rx = await getPrescription(db, actor, d.prescriptionId);
  if (rx === null) throw new PharmacyError("permission_denied", "this ticket is a sealed record — its checks are read by a pharmacist who may read it", { reason: "patient_restricted" });
  const line = (await linesOf(db, dispenseId)).find((l) => l.lineIdx === lineIdx);
  if (line === undefined) throw new PharmacyError("unknown_line", `line ${String(lineIdx)} not found`);
  if (line.status !== "open" || line.dispensedMedicineId === null) throw new PharmacyError("line_not_open", `line ${String(lineIdx + 1)} has no medicine to swap`);
  if (line.dispensedMedicineId === substituteId) throw new PharmacyError("authorisation_not_needed", `line ${String(lineIdx + 1)} already gives that brand`, { lineIdx });
  if ((line.rxLine as RxLine).noSubstitution) throw new PharmacyError("substitution_not_allowed", `line ${String(lineIdx + 1)} is marked no-substitution by the prescriber`, { lineIdx });
  const meds = await medicinesByIds(db, [line.dispensedMedicineId, substituteId]);
  const from = meds.get(line.dispensedMedicineId);
  const to = meds.get(substituteId);
  if (from === undefined || to === undefined || !(await isEquivalentMedicine(db, from.id, to.id))) {
    throw new PharmacyError("substitution_not_allowed", `that medicine is not a generic equivalent of line ${String(lineIdx + 1)} (same salts, strength, form and route)`, { lineIdx });
  }
  if (!swapNeedsPrescriber(from.scheduleFlag, to.scheduleFlag)) {
    throw new PharmacyError("authorisation_not_needed", `${from.brandName} is not Schedule H/H1 — the patient's consent is enough for this swap`, { lineIdx });
  }
  if (rx.doctorId === null) {
    throw new PharmacyError(
      "substitution_needs_prescriber",
      `this paper's doctor is not on the system to agree to ${to.brandName} — dispense ${from.brandName} as written, or have the doctor change the prescription`,
      { lineIdx, from: from.id, to: to.id, prescriberOnRecord: false },
    );
  }
  return rx.doctorId;
}

async function requirePrescriber(db: Db, actor: Actor, id: string): Promise<AuthorisationRow> {
  const [row] = await db.select().from(pharmacyAuthorisations).where(eq(pharmacyAuthorisations.id, id));
  if (row === undefined) throw new PharmacyError("unknown_authorisation", `authorisation ${id} not found`);
  if (actor.id !== row.prescriberUserId) {
    const names = await userNames(db, [row.prescriberUserId]);
    throw new PharmacyError(
      "permission_denied",
      `only the prescribing doctor, ${names.get(row.prescriberUserId) ?? "who wrote this prescription"}, may decide this`,
      { reason: "not_the_prescriber" },
    );
  }
  return row;
}

export async function decideAuthorisation(
  db: Db, actor: Actor, id: string, input: { authorise: boolean; reason: string }, now: Date,
): Promise<AuthorisationRow> {
  const row = await requirePrescriber(db, actor, id);
  if (row.status !== "pending") throw new PharmacyError("authorisation_not_pending", `this request was already ${row.status}`, { status: row.status });
  const reason = input.reason.trim();
  if (reason.length < 3) throw new PharmacyError("reason_required", "a decision about a patient's safety records WHY");
  const d = await getDispenseRow(db, row.dispenseId);
  const status = input.authorise ? "authorised" : "declined";
  await withTx(db, async (tx) => {
    const won = await tx.update(pharmacyAuthorisations)
      .set({ status, decidedBy: actor.id, decidedAt: now, decisionReason: reason })
      .where(and(eq(pharmacyAuthorisations.id, id), eq(pharmacyAuthorisations.status, "pending")))
      .returning({ id: pharmacyAuthorisations.id });
    if (won.length === 0) throw new PharmacyError("authorisation_not_pending", "this request was decided a moment ago");
    await appendEvent(tx, authorisationDecided.make({
      occurredAt: now, actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: { authorisationId: id, dispenseId: d.id, lineIdx: row.lineIdx, patientId: d.patientId, status, decidedBy: actor.id },
    }));
  });
  const [after] = await db.select().from(pharmacyAuthorisations).where(eq(pharmacyAuthorisations.id, id));
  return after!;
}

/** The requests waiting on THIS doctor — their desk card. */
export async function pendingAuthorisationsFor(db: Db, actor: Actor): Promise<AuthorisationRow[]> {
  return db.select().from(pharmacyAuthorisations)
    .where(and(eq(pharmacyAuthorisations.prescriberUserId, actor.id), eq(pharmacyAuthorisations.status, "pending")))
    .orderBy(asc(pharmacyAuthorisations.requestedAt));
}

/** What the doctor's page shows: the request, the ticket, the patient as this doctor may see them, and the line as written. */
export type AuthorisationDetail = {
  authorisation: AuthorisationRow;
  requestedByName: string | null;
  dispenseNo: string | null;
  patient: { name: string | null; alias: string | null; uhid: string; restricted: boolean } | null;
  line: { drug: string; dose: string; frequency: string; durationDays: number | null; instructions: string | null } | null;
  /** 0093 — a `substitution` request: the brand on the line and the brand the pharmacist would give instead. */
  swap: { from: string; to: string } | null;
};

export async function authorisationDetail(db: Db, actor: Actor, id: string): Promise<AuthorisationDetail> {
  const row = await requirePrescriber(db, actor, id);
  const d = await getDispenseRow(db, row.dispenseId);
  const [summary] = await getPatientSummaries(db, actor, [d.patientId]);
  const rx = await getPrescription(db, actor, d.prescriptionId);
  const rxLine = rx === null ? undefined : (rx.lines as RxLine[])[row.lineIdx];
  const dispenseLine = (await linesOf(db, d.id)).find((l) => l.lineIdx === row.lineIdx);
  const names = await userNames(db, [row.requestedBy]);
  const written = rxLine ?? (dispenseLine?.rxLine as RxLine | undefined);
  const swapMeds = row.book !== "substitution" ? null
    : await medicinesByIds(db, [dispenseLine?.dispensedMedicineId ?? null, row.about].filter((x): x is string => x !== null));
  return {
    swap: swapMeds === null ? null : {
      from: swapMeds.get(dispenseLine?.dispensedMedicineId ?? "")?.brandName ?? written?.drug ?? "",
      to: swapMeds.get(row.about)?.brandName ?? row.about,
    },
    authorisation: row,
    requestedByName: names.get(row.requestedBy) ?? null,
    dispenseNo: d.dispenseNo,
    patient: summary === undefined ? null : { name: summary.name, alias: summary.alias, uhid: summary.uhid, restricted: summary.restricted },
    line: written === undefined ? null : {
      drug: written.drug, dose: written.dose, frequency: written.frequency, durationDays: written.durationDays ?? null, instructions: written.instructions ?? null,
    },
  };
}
