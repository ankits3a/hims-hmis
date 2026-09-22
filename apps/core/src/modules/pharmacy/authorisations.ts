import { and, asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyAuthorisations } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { getDoctor, getPrescription } from "../opd";
import { getPatientSummaries } from "../patients";
import { PharmacyError } from "./errors";
import { authorisationDecided, authorisationRequested } from "./events";
import { requireRegisteredPharmacist } from "./pharmacists";
import { getDispenseRow, linesOf, userNames } from "./queue";
import { refusalKey, refusalsOn } from "./refusals";
import { ticketRefusals } from "./verify";
import type { AuthorisationRow } from "./authorisation-reads";
import type { RefusalBook } from "./refusals";
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
  book: RefusalBook;
  /** The hit's identity — `refusalKey` — as the line's refusal carried it. */
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
  const instead = input.medicineId === undefined || input.medicineId === null ? null : { lineIdx: input.lineIdx, medicineId: input.medicineId };
  const { doctorId, refused } = await ticketRefusals(db, actor, input.dispenseId, now, instead);
  if (!keysOn(refused, input.lineIdx, input.book).includes(input.about)) {
    throw new PharmacyError("authorisation_not_needed", `the check raises no ${input.book} refusal "${input.about}" on line ${String(input.lineIdx + 1)} — there is nothing for the doctor to authorise`, { lineIdx: input.lineIdx });
  }
  const open = await db.select().from(pharmacyAuthorisations).where(and(
    eq(pharmacyAuthorisations.dispenseId, input.dispenseId), eq(pharmacyAuthorisations.lineIdx, input.lineIdx),
    eq(pharmacyAuthorisations.book, input.book), eq(pharmacyAuthorisations.about, input.about), eq(pharmacyAuthorisations.status, "pending"),
  ));
  if (open[0] !== undefined) return open[0];
  const doctor = await getDoctor(db, doctorId);
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
  return {
    authorisation: row,
    requestedByName: names.get(row.requestedBy) ?? null,
    dispenseNo: d.dispenseNo,
    patient: summary === undefined ? null : { name: summary.name, alias: summary.alias, uhid: summary.uhid, restricted: summary.restricted },
    line: written === undefined ? null : {
      drug: written.drug, dose: written.dose, frequency: written.frequency, durationDays: written.durationDays ?? null, instructions: written.instructions ?? null,
    },
  };
}
