import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import {
  pcpndtFormF, pcpndtFormFSerials, pcpndtRegisteredPersons,
} from "../../kernel/db/schema/pcpndt";
import { PcpndtError } from "./errors";
import { formFRecorded } from "./events";
import { activeRegistrationFor } from "./registrations";
import type { FormFApplicability } from "../../kernel/db/schema/pcpndt";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";

/**
 * PLAN 18a T6 — **FORM F: the gap-free serial, the membership checks, and the one completion.**
 *
 * ═══ THE SERIAL IS MINTED BY THE DATABASE'S COUNTER, NOT BY A READ (A1) ═══
 *
 * `nextEpisodeNo`'s exact shape, transcribed: `INSERT … ON CONFLICT DO NOTHING` for the cold start,
 * then a single `UPDATE … SET next_no = next_no + 1 … RETURNING`, whose returned value is the POST
 * increment so the number just handed out is one less. Twelve concurrent openings contend on ONE
 * ROW and serialise there, which is what makes them mint 1..12 rather than two forms sharing a
 * serial.
 *
 * **A1's mutant is a read-then-write counter**, and it is the defect an inspector finds by counting:
 * two forms with serial 7 in a register whose whole evidential value is that it has no duplicates.
 * The `UNIQUE (machine_id, serial_year, serial_no)` behind it is the second line of defence.
 *
 * **The serial is minted at OPEN and is irreversible.** A sonologist who starts a form and abandons
 * it has still consumed a number, and the register shows an incomplete form rather than nothing —
 * which is the point. A serial minted at RECORD would let an abandoned scan leave no trace at all.
 *
 * ═══ MEMBERSHIP, NEVER EXISTENCE (A2) ═══
 *
 * Both checks below resolve THE MACHINE'S registration first and ask about that one. A2's mutant
 * asks whether the person is registered ANYWHERE, and what it lets through is the doctor registered
 * at the satellite clinic scanning on the main site's machine — two true answers and one unlawful
 * scan.
 *
 * ═══ THE ROW IS WRITTEN TWICE AND FROZEN FOR EVER AFTER — SEE MIGRATION `0050` / F25 ═══
 *
 * `0047`'s trigger froze every column from INSERT, which made `open → recorded` impossible and every
 * applicable scan permanently unacquirable. `0050` permits exactly that one transition and nothing
 * else: the serial, machine, study and patient are frozen from the moment the form is opened, a
 * recorded form cannot be reopened, and `verified_by`/`verified_at` remain the only columns a
 * recorded row may ever change.
 */

const WRITE = "pcpndt.form_f.write";
const VERIFY = "pcpndt.form_f.verify";

export type FormFRow = typeof pcpndtFormF.$inferSelect;

async function assertPermission(exec: Db | Tx, actor: Actor, permission: string): Promise<void> {
  if (actor.type !== "user") {
    throw new PcpndtError(
      "person_not_registered",
      "a Form F is signed by a person — a system actor cannot write or verify one",
    );
  }
  if (!(await hasPermission(exec as Db, actor.id, permission, "hospital"))) {
    throw new PcpndtError("person_not_registered", `${actor.id} does not hold ${permission}`, { permission });
  }
}

/**
 * A2 — the machine is on an ACTIVE registration whose validity window contains the scan day.
 * Returns the registration so the caller does not read it twice.
 */
export async function assertMachineRegistered(
  exec: Db | Tx, deviceResourceId: string, onDate: string,
): Promise<{ registrationId: string; machineId: string }> {
  const found = await activeRegistrationFor(exec, deviceResourceId, onDate);
  if (!found) {
    throw new PcpndtError(
      "machine_not_registered",
      `device ${deviceResourceId} is not on an active PCPNDT registration on ${onDate} — an `
      + "ultrasound machine outside Form B may not perform a scan the Act covers",
      { deviceResourceId, onDate },
    );
  }
  return { registrationId: found.registration.id, machineId: found.machine.id };
}

/**
 * A2's third leg — the person must be on **THIS** registration. `registrationId` is the machine's,
 * resolved by `assertMachineRegistered`, and passing it in rather than looking it up again is what
 * makes the membership question unavoidable.
 */
export async function assertPersonRegistered(
  exec: Db | Tx, userId: string, registrationId: string,
): Promise<{ personId: string }> {
  const rows = await (exec as Db).select({ id: pcpndtRegisteredPersons.id })
    .from(pcpndtRegisteredPersons)
    .where(and(
      eq(pcpndtRegisteredPersons.userId, userId),
      eq(pcpndtRegisteredPersons.registrationId, registrationId),
      eq(pcpndtRegisteredPersons.active, true),
    ));
  const person = rows[0];
  if (!person) {
    throw new PcpndtError(
      "person_not_registered",
      `${userId} is not a registered person on registration ${registrationId} — being registered `
      + "somewhere else is not being registered here (A2)",
      { userId, registrationId },
    );
  }
  return { personId: person.id };
}

/**
 * A1 — the gap-free counter, per PHYSICAL machine per calendar year. `nextEpisodeNo`'s pattern.
 *
 * ═══ F61 (CLOSE REVIEW) — THE KEY IS THE DEVICE, NOT THE REGISTRATION ROW ═══
 *
 * It was keyed on `pcpndt_registered_machines.id`, which belongs to ONE registration. There is no
 * renew path in this module, so the same physical scanner gets a NEW machine row on renewal and the
 * counter restarted at 1 in the middle of a calendar year — 1..47 under the old certificate, then
 * 1..38 under the new one, forty duplicate serials in the book an inspector counts. The unique
 * index was keyed the same way and could not see one of them.
 *
 * The MECHANISM was never wrong and is unchanged: insert-if-absent, then one `UPDATE … RETURNING`
 * post-increment on a single row, so concurrency serialises and a rollback rolls the number back
 * with it. Only the key moved.
 */
async function nextSerialNo(
  tx: Tx, deviceResourceId: string, machineId: string, year: number,
): Promise<number> {
  await tx.insert(pcpndtFormFSerials)
    .values({ deviceResourceId, machineId, year, nextNo: 1 }).onConflictDoNothing();
  const rows = await tx
    .update(pcpndtFormFSerials)
    .set({ nextNo: sql`${pcpndtFormFSerials.nextNo} + 1` })
    .where(and(
      eq(pcpndtFormFSerials.deviceResourceId, deviceResourceId),
      eq(pcpndtFormFSerials.year, year),
    ))
    .returning({ nextNo: pcpndtFormFSerials.nextNo });
  const row = rows[0];
  if (!row) throw new PcpndtError("serial_conflict", `the serial counter for device ${deviceResourceId} vanished`);
  return row.nextNo - 1;
}

/**
 * ═══ F58 (CLOSE REVIEW) — THE SUBJECT RESOLVER, AND WHY IT IS A REGISTRY ═══
 *
 * `openFormF` writes the patient, the machine, the performing doctor and the serial YEAR into the
 * statutory register from FOUR CALLER-SUPPLIED FIELDS, and cross-checked none of them against the
 * scan named by `studyId`. Nothing on the radiology side checked either: the gate reads the form by
 * `study_id` alone and `assertFormFRecorded` looks only at `status`. So a mis-clicked patient picker
 * minted serial 48/2026 naming a woman who was never scanned — the gate satisfied, the scan was
 * acquired and reported, and because `0050` freezes `patient_id` from INSERT and refuses DELETE in
 * every state, **the entry can never be corrected.**
 *
 * DD1 is why this is a REGISTRY and not a join: `pcpndt` is its own manifest so 15b and 62 can
 * install the register without installing radiology, and `study_id` is `text` for exactly that
 * reason. So the owning module REGISTERS a resolver for its own id space — the same shape as the
 * kernel's `registerEncounterResolver` — and this file asks whoever owns the study whether the
 * caller's facts match. A study nobody claims is accepted as before, which keeps 15b and 62 working
 * against their own study-shaped rows.
 */
export type FormFSubject = {
  patientId: string;
  /** `null` — the owning module claims this study and it has no machine yet (F58, second pass). */
  deviceResourceId: string | null;
};
export type FormFSubjectResolver = (tx: Tx, studyId: string) => Promise<FormFSubject | null>;

const SUBJECT_RESOLVERS = new Map<string, FormFSubjectResolver>();

/** Returns an unregister function, so a test can install one for its own lifetime. */
export function registerFormFSubjectResolver(key: string, fn: FormFSubjectResolver): () => void {
  SUBJECT_RESOLVERS.set(key, fn);
  return () => { SUBJECT_RESOLVERS.delete(key); };
}

async function assertSubjectMatches(tx: Tx, input: OpenFormFInput): Promise<void> {
  for (const resolve of SUBJECT_RESOLVERS.values()) {
    const subject = await resolve(tx, input.studyId);
    if (subject === null) continue;
    if (subject.patientId !== input.patientId) {
      throw new PcpndtError(
        "unknown_form",
        `this Form F names patient ${input.patientId} and study ${input.studyId} is ${subject.patientId} — `
        + "a register entry against the wrong woman cannot be corrected once it is written",
        { studyId: input.studyId, given: input.patientId, actual: subject.patientId },
      );
    }
    if (subject.deviceResourceId === null) {
      throw new PcpndtError(
        "unknown_form",
        `study ${input.studyId} is not booked onto a machine yet — a Form F records the machine the `
        + "scan happened on, and there is nothing yet to check the caller's answer against",
        { studyId: input.studyId, given: input.deviceResourceId },
      );
    }
    if (subject.deviceResourceId !== input.deviceResourceId) {
      throw new PcpndtError(
        "unknown_form",
        `this Form F names device ${input.deviceResourceId} and study ${input.studyId} is booked on `
        + `${subject.deviceResourceId} — the register records the machine the scan happened on`,
        { studyId: input.studyId, given: input.deviceResourceId, actual: subject.deviceResourceId },
      );
    }
    return;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OpenFormFInput = {
  studyId: string;
  patientId: string;
  deviceResourceId: string;
  /**
   * The user who will PERFORM the scan, checked for membership of the machine's registration.
   *
   * **OPTIONAL, and defaults to the ACTOR (F57/F58).** It was required, so the console had to send
   * back the id of the person already authenticated on the request — a caller-supplied fact the
   * server already knew, which is the same shape as the four facts F58 is about. The sonologist
   * opening the form is normally the sonologist performing the scan; a different registered person
   * is the exception and is the only case that needs to say so.
   */
  personUserId?: string;
  indicationCode: string;
  applicability: FormFApplicability;
  /**
   * F52/F58 — the scan's IST calendar day is DERIVED FROM THE SERVER CLOCK, not accepted from the
   * caller, because it decides the serial YEAR: a client posting `2025-12-30` on 2 January minted
   * serial 1/**2025** into a year whose statutory return may already have been filed. Kept as an
   * optional override for a BACKFILL, bounded against the clock when supplied.
   */
  onDate?: string;
  /**
   * The clock, passed by the caller. `applicability.ts` takes `asOf` for the same reason and F28 is
   * the cost of not doing it: a rule that reads `new Date()` internally is a rule whose tests are
   * about the day they run on.
   */
  now?: Date;
};

/**
 * E13 — a downtime scan is written up after the fact, and 31 December belongs to that year's book
 * however late it is completed (the serials table's own header). So a backfill may look BACK across
 * a year boundary; what it may not do is pick a year.
 */
export const FORM_F_BACKFILL_DAYS = 7;

/**
 * Opens the form and MINTS ITS SERIAL. One per study — `pcpndt_form_f_study_ux` refuses a second,
 * so a redelivered call cannot consume a second number.
 */
export async function openFormF(
  tx: Tx, actor: Actor, input: OpenFormFInput,
): Promise<{ formFId: string; serialNo: number; serialYear: number }> {
  await assertPermission(tx, actor, WRITE);
  const now = input.now ?? new Date();
  const today = istDayString(now);
  const onDate = input.onDate ?? today;
  if (!DATE_RE.test(onDate)) {
    throw new PcpndtError("unknown_form", `onDate must be an IST calendar date (YYYY-MM-DD), got "${onDate}"`);
  }
  /**
   * ═══ F52's SIBLING — THE SERIAL YEAR IS NOT THE CALLER'S TO CHOOSE ═══
   *
   * `onDate` decides `serial_year`, and it arrived from the request body validated only as a date
   * shape. A client posting `2025-12-30` on 2 January minted serial 1/**2025** into a year whose
   * statutory return may already have been filed — and the shipped console was sending the
   * browser's UTC day, which is the PREVIOUS day for five and a half hours every night, so the
   * 00:30 scan on 1 January landed in last year's book without anybody typing anything.
   *
   * A backfill may look BACK, bounded: E13's downtime form is written up after the fact and a
   * 31 December scan belongs to 2026's book however late it is completed. Nothing may look FORWARD,
   * and nothing may reach back far enough to choose a year at will.
   */
  if (onDate > today) {
    throw new PcpndtError(
      "unknown_form",
      `onDate ${onDate} is in the future — a Form F is opened for a scan that is happening`,
      { onDate, today },
    );
  }
  const oldest = istDayString(new Date(now.getTime() - FORM_F_BACKFILL_DAYS * 86_400_000));
  if (onDate < oldest) {
    throw new PcpndtError(
      "serial_conflict",
      `onDate ${onDate} is more than ${String(FORM_F_BACKFILL_DAYS)} days before today (${today}) — `
      + "a backfill writes up a scan that happened, and a serial year is not a caller's choice",
      { onDate, today, oldest },
    );
  }
  await assertSubjectMatches(tx, input);
  const { registrationId, machineId } = await assertMachineRegistered(tx, input.deviceResourceId, onDate);
  const performerId = input.personUserId ?? actor.id;
  const { personId } = await assertPersonRegistered(tx, performerId, registrationId);

  const existing = await (tx as unknown as Db).select({ id: pcpndtFormF.id, serialNo: pcpndtFormF.serialNo, serialYear: pcpndtFormF.serialYear })
    .from(pcpndtFormF).where(eq(pcpndtFormF.studyId, input.studyId));
  if (existing[0]) {
    throw new PcpndtError(
      "form_already_recorded",
      `study ${input.studyId} already has Form F serial ${String(existing[0].serialNo)}/${String(existing[0].serialYear)} — N1 is one form per scan`,
      { formFId: existing[0].id },
    );
  }

  const serialYear = Number(onDate.slice(0, 4));
  const serialNo = await nextSerialNo(tx, input.deviceResourceId, machineId, serialYear);
  const formFId = newId();
  await tx.insert(pcpndtFormF).values({
    id: formFId,
    serialNo, serialYear, machineId, personId,
    deviceResourceId: input.deviceResourceId,
    studyId: input.studyId,
    patientId: input.patientId,
    indicationCode: input.indicationCode,
    applicability: input.applicability,
    /** Empty until the completion — `pcpndt_form_f_recorded_shape_ck` permits an unsigned `open`. */
    sections: {}, declaration: {}, referral: {},
    status: "open",
  });
  return { formFId, serialNo, serialYear };
}

export type RecordFormFInput = {
  formFId: string;
  sections: Record<string, unknown>;
  declaration: { signature_kind: "signature" | "thumb"; witness_name?: string };
  referral: { slip_doc_id?: string; self_referral: boolean; paper_serial?: string };
  applicability?: FormFApplicability;
  gestationWeeks?: number | null;
  resultSummary?: string | null;
};

/**
 * THE COMPLETION — the one UPDATE migration `0050` permits, and the only way a form becomes
 * `recorded`. The signer is the ACTOR: a declaration under §5 is signed by the person making it,
 * never by a name typed into a field.
 */
export async function recordFormF(
  tx: Tx, actor: Actor, input: RecordFormFInput,
): Promise<{ formFId: string; serialNo: number }> {
  await assertPermission(tx, actor, WRITE);
  const rows = await (tx as unknown as Db).select().from(pcpndtFormF).where(eq(pcpndtFormF.id, input.formFId));
  const form = rows[0];
  if (!form) throw new PcpndtError("unknown_form", `no Form F ${input.formFId}`, { formFId: input.formFId });
  if (form.status !== "open") {
    throw new PcpndtError(
      "form_already_recorded",
      `Form F ${input.formFId} is already ${form.status} — a recorded declaration cannot be rewritten`,
      { formFId: input.formFId, status: form.status },
    );
  }
  /** K4's shape, one statute over: a thumb impression with no named witness fails in court. */
  if (input.declaration.signature_kind === "thumb"
    && (input.declaration.witness_name === undefined || input.declaration.witness_name.trim() === "")) {
    throw new PcpndtError(
      "declaration_incomplete",
      "a thumb-impression declaration requires a named witness",
    );
  }

  /**
   * A2 RE-EVALUATED AT COMPLETION, not merely at opening. A registration can lapse, a machine can
   * be sold and a doctor can be struck off between the two acts, and the statement being signed is
   * *"this scan was performed on a registered machine by a registered person"* — which is a claim
   * about now, not about when the form was started.
   */
  await assertPersonRegisteredForMachine(tx, actor.id, form.machineId);

  await tx.update(pcpndtFormF).set({
    status: "recorded",
    sections: input.sections,
    declaration: input.declaration,
    referral: input.referral,
    applicability: input.applicability ?? (form.applicability as FormFApplicability),
    gestationWeeks: input.gestationWeeks ?? form.gestationWeeks,
    resultSummary: input.resultSummary ?? null,
    signedBy: actor.id,
    signedAt: new Date(),
  }).where(eq(pcpndtFormF.id, input.formFId));

  /**
   * The one event, and its payload carries NO patient — `events.ts`'s header is the argument: a
   * monthly return needs a serial, a machine and a date, and does not need to know who was scanned.
   * The envelope's own `patientId` is left unset for the same reason.
   */
  await appendEvent(tx, formFRecorded.make({
    actor,
    payload: {
      formFId: form.id, serialNo: form.serialNo, serialYear: form.serialYear,
      machineId: form.machineId, studyId: form.studyId,
    },
  }));
  return { formFId: form.id, serialNo: form.serialNo };
}

/** The membership question asked from a MACHINE rather than a registration — the completion's form. */
async function assertPersonRegisteredForMachine(tx: Tx, userId: string, machineId: string): Promise<void> {
  const rows = (await tx.execute(sql`
    select p.id as "id" from pcpndt_registered_persons p
      join pcpndt_registered_machines m on m.registration_id = p.registration_id
      join pcpndt_registrations r on r.id = p.registration_id
     where m.id = ${machineId} and p.user_id = ${userId}
       and p.active = true and m.active = true and r.status = 'active'
     limit 1
  `)).rows as { id: string }[];
  if (!rows[0]) {
    throw new PcpndtError(
      "person_not_registered",
      `${userId} is not a registered person on the registration this machine belongs to`,
      { userId, machineId },
    );
  }
}

/**
 * A4's second half — the in-charge counter-signs, ONCE, and is never the signer.
 *
 * `pcpndt.form_f.verify` and `pcpndt.form_f.write` are held by no common role (manifest §5), and
 * this refuses `same_actor` on top of that: the permission split is the policy and this is the
 * enforcement, because a temporary grant could put both in one pair of hands for an afternoon.
 */
export async function verifyFormF(
  tx: Tx, actor: Actor, formFId: string,
): Promise<{ formFId: string; verifiedAt: Date }> {
  await assertPermission(tx, actor, VERIFY);
  const rows = await (tx as unknown as Db).select().from(pcpndtFormF).where(eq(pcpndtFormF.id, formFId));
  const form = rows[0];
  if (!form) throw new PcpndtError("unknown_form", `no Form F ${formFId}`, { formFId });
  if (form.status !== "recorded") {
    throw new PcpndtError(
      "not_recorded",
      `Form F ${formFId} is ${form.status} — an inspector's counter-signature on a blank is exactly what the constraint refuses`,
      { formFId, status: form.status },
    );
  }
  if (form.verifiedAt !== null) {
    throw new PcpndtError("form_already_recorded", `Form F ${formFId} is already verified`, { formFId });
  }
  if (form.signedBy === actor.id) {
    throw new PcpndtError(
      "same_actor",
      "the officer who verifies a Form F is never the one who signed it — an officer who can do "
      + "both is a single point of failure with a criminal statute behind it",
      { formFId },
    );
  }
  const verifiedAt = new Date();
  await tx.update(pcpndtFormF).set({ verifiedBy: actor.id, verifiedAt })
    .where(eq(pcpndtFormF.id, formFId));
  return { formFId, verifiedAt };
}

/**
 * ═══ A3 — THE STATUTORY GATE ON ACQUISITION, AND IT PASSES ONLY ON `recorded` ═══
 *
 * A3's mutant passes on `open`, and H8 is what that costs: *"Form F filled after the scan closed"* —
 * a form opened to satisfy a check, the scan performed, and the declaration written afterwards to
 * match whatever was found. The whole point of the Act's paperwork is that it precedes the act.
 *
 * A study that is not `form_f_required` passes with NO form at all: the register is for the scans
 * the Act covers, and demanding a Form F for a chest X-ray would make the control noise.
 */
export async function assertFormFRecorded(
  exec: Db | Tx, studyId: string, formFRequired: boolean,
): Promise<FormFRow | null> {
  if (!formFRequired) return null;
  const rows = await (exec as Db).select().from(pcpndtFormF).where(eq(pcpndtFormF.studyId, studyId));
  const form = rows[0];
  if (!form) {
    throw new PcpndtError(
      "form_f_missing",
      `study ${studyId} is covered by the PCPNDT Act and has no Form F`,
      { studyId },
    );
  }
  if (form.status !== "recorded") {
    throw new PcpndtError(
      "form_f_missing",
      `study ${studyId} has an ${form.status} Form F (serial ${String(form.serialNo)}) — an OPEN form is a form nobody has signed, and the declaration must precede the scan (H8)`,
      { studyId, formFId: form.id, status: form.status },
    );
  }
  return form;
}
