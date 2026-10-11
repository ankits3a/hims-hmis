import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { opdAppointments, opdDoctorLeaves, opdDoctors, patients } from "../../kernel/db/schema";
import { defineAct } from "../../kernel/copilot/types";
import { searchPatients } from "../patients";
import { LIVE_APPOINTMENT_STATUSES, bookAppointmentInTx, rescheduleAppointmentInTx } from "./appointments";
import { availableSlots } from "./schedules";
import { asksTele, nameQuery, namedDoctors, parseWhen } from "./copilot-appt-words";
import { addDays, ageYearsAt, istDate, istHourMinute } from "./time";
import type { DoctorLite, When } from "./copilot-appt-words";
import type { CopilotAnswer, CopilotToolCtx, CopilotToolDecl } from "../../kernel/copilot/types";
import type { Db, Tx } from "../../kernel/db/client";
import type { CopilotAnswerKey, CopilotApptPick, CopilotApptRow } from "@hmis/contracts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * E2.1 — BOOK OR MOVE AN APPOINTMENT FROM THE COPILOT CHAT
 * (plan §M2 E2.1; spec /opt/hmis-context/SPEC-copilot-appt-2026-10-11.md, owner yes 2026-10-11)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The ask WRITES NOTHING. It reads the doctor, the day and the time from the words by rules (no
 * model), finds the patient with the asker's own clearance, and hands back up to three free times
 * per patient — each a signed proposal (`kernel/copilot/act.ts`). The clerk taps a time and then
 * Confirm; only `POST /copilot/confirm` books, inside one transaction with its `copilot_acts` row.
 *
 * ═══ NO ACT ON THE WRONG PATIENT (G7) ═══
 *
 * A UHID is an exact identity, so it goes straight to the times. A mobile number or a name is a
 * SEARCH, so the clerk taps the patient — even when there is one match (owner, 2026-10-11). The
 * proposal binds the patient id the clerk saw, and confirm re-reads the row before writing.
 *
 * ═══ THE SAME BOOKING AS THE SCREEN ═══
 *
 * `bookAppointmentInTx` / `rescheduleAppointmentInTx` are the screen's own functions: same checks,
 * same row, same event, same appointment number series. "Via copilot" is the `copilot_acts` row
 * pointing at the appointment, not a different kind of appointment.
 */

/** Patients offered for one ask; times per patient. 5 × 3 = 15 = `MAX_PROPOSALS`. */
const MAX_PATIENTS = 5;
const TIMES = 3;
/** With no day named, the next free times are looked for this many days ahead. */
const LOOK_AHEAD_DAYS = 14;

const UHID_SHAPE_RE = /^[A-Za-z]{1,5}\d{8}$/;
const PHONE_RE = /^(?:\+?91)?([6-9]\d{9})$/;

/* ═══ FINDING THINGS — with the asker's own clearance ═══ */

type Candidate = { id: string; uhid: string; name: string; ageSex: string; phoneLast4: string | null; hasPhone: boolean };

type Found =
  | { kind: "direct"; list: Candidate[] }
  | { kind: "pick"; list: Candidate[] }
  | { kind: "none" }
  | { kind: "which" };

function ageSexOf(dob: Date | null, gender: string, now: Date): string {
  const sex = gender === "male" ? "M" : gender === "female" ? "F" : "O";
  return dob === null ? sex : `${String(ageYearsAt(dob, now))}${sex}`;
}

async function findPatients(ctx: CopilotToolCtx, doctorTokens: ReadonlySet<string>, now: Date): Promise<Found> {
  const subject = (ctx.subject ?? "").trim();
  const toCandidate = (p: Awaited<ReturnType<typeof searchPatients>>[number]): Candidate => ({
    id: p.id, uhid: p.uhid, name: p.name, ageSex: ageSexOf(p.dob, p.administrativeGender, now),
    phoneLast4: p.phone === null ? null : p.phone.slice(-4), hasPhone: p.phone !== null,
  });
  /* searchPatients applies `patients.confidential.read`: a sealed patient is "no such patient" here, as on the screen. */
  if (UHID_SHAPE_RE.test(subject)) {
    const uhid = subject.toUpperCase();
    const hit = (await searchPatients(ctx.db, ctx.actor, uhid, 1)).find((p) => p.uhid === uhid);
    return hit === undefined ? { kind: "none" } : { kind: "direct", list: [toCandidate(hit)] };
  }
  const phone = PHONE_RE.exec(subject.replace(/[\s-]/g, ""));
  if (phone !== null) {
    const hits = await searchPatients(ctx.db, ctx.actor, phone[1]!, MAX_PATIENTS);
    return hits.length === 0 ? { kind: "none" } : { kind: "pick", list: hits.map(toCandidate) };
  }
  const q = nameQuery(ctx.typed ?? ctx.question, doctorTokens);
  if (q === "") return { kind: "which" };
  let hits = await searchPatients(ctx.db, ctx.actor, q, MAX_PATIENTS);
  /* A stray word the list above does not know makes a three-word search miss; two words still find the person. */
  if (hits.length === 0 && q.split(" ").length > 2) hits = await searchPatients(ctx.db, ctx.actor, q.split(" ").slice(0, 2).join(" "), MAX_PATIENTS);
  return hits.length === 0 ? { kind: "none" } : { kind: "pick", list: hits.map(toCandidate) };
}

async function activeDoctors(db: Db): Promise<DoctorLite[]> {
  return db.select({ id: opdDoctors.id, displayName: opdDoctors.displayName }).from(opdDoctors).where(eq(opdDoctors.active, true));
}

/** The next free times for one doctor: on the day asked (from the time asked), or from now over the look-ahead. */
async function nextFree(db: Db, doctorId: string, when: When, now: Date, skip: number | null = null): Promise<Date[]> {
  const today = istDate(now);
  if (when.day !== null && when.day < today) return [];
  const days = when.day !== null ? [when.day] : Array.from({ length: LOOK_AHEAD_DAYS }, (_, i) => addDays(today, i));
  const out: Date[] = [];
  for (const [i, d] of days.entries()) {
    const slots = await availableSlots(db, doctorId, d, now);
    for (const s of slots) {
      if (s.booked || s.past || s.start.getTime() <= now.getTime() || s.start.getTime() === skip) continue;
      if (i === 0 && when.from !== null && istHourMinute(s.start) < when.from) continue;
      out.push(s.start);
      if (out.length === TIMES) return out;
    }
  }
  return out;
}

async function recordLookups(ctx: CopilotToolCtx, list: readonly Candidate[]): Promise<void> {
  for (const c of list) {
    await recordPhiAccess(ctx.db, {
      actor: ctx.actor, patientId: c.id, surface: "copilot.appointment", encounterId: null,
      reason: "desk copilot offered this patient for an appointment",
    });
  }
}

const say = (key: CopilotAnswerKey, params: Record<string, string | number> = {}): CopilotAnswer => ({ key, params });

const patientOf = (c: Candidate): CopilotApptRow["patient"] => ({ name: c.name, uhid: c.uhid, ageSex: c.ageSex, phoneLast4: c.phoneLast4 });

/* ═══ CONFIRM-TIME CHECKS, shared by book and move — each a sentence, never a stack trace ═══ */

async function slotRefusal(tx: Tx, doctorId: string, slotStart: Date, now: Date): Promise<CopilotAnswerKey | null> {
  if (slotStart.getTime() <= now.getTime()) return "copilot.answer.apptPast";
  const day = istDate(slotStart);
  const leave = await tx.select({ id: opdDoctorLeaves.id }).from(opdDoctorLeaves).where(and(
    eq(opdDoctorLeaves.doctorId, doctorId), eq(opdDoctorLeaves.status, "scheduled"),
    lte(opdDoctorLeaves.fromDate, day), gte(opdDoctorLeaves.toDate, day),
  ));
  if (leave.length > 0) return "copilot.answer.apptDoctorOnLeave";
  const taken = await tx.select({ id: opdAppointments.id }).from(opdAppointments).where(and(
    eq(opdAppointments.doctorId, doctorId), eq(opdAppointments.slotStart, slotStart),
    inArray(opdAppointments.status, [...LIVE_APPOINTMENT_STATUSES]),
  ));
  return taken.length > 0 ? "copilot.answer.apptSlotTaken" : null;
}

async function doneAnswer(tx: Tx, key: CopilotAnswerKey, appointmentId: string): Promise<CopilotAnswer> {
  const [row] = await tx.select({ name: patients.name, uhid: patients.uhid, doctor: opdDoctors.displayName, at: opdAppointments.slotStart })
    .from(opdAppointments)
    .innerJoin(patients, eq(patients.id, opdAppointments.patientId))
    .innerJoin(opdDoctors, eq(opdDoctors.id, opdAppointments.doctorId))
    .where(eq(opdAppointments.id, appointmentId));
  return row === undefined ? say("copilot.answer.actDone")
    : say(key, { patient: row.name, uhid: row.uhid, doctor: row.doctor, when: row.at.toISOString() });
}

const isoInstant = z.string().datetime();

const bookArgs = z.object({
  patientId: z.string().min(1).max(64),
  doctorId: z.string().min(1).max(64),
  slotStart: isoInstant,
  mode: z.enum(["in_person", "tele"]),
}).strict();
type BookArgs = z.infer<typeof bookArgs>;

const moveArgs = z.object({
  appointmentId: z.string().min(1).max(64),
  patientId: z.string().min(1).max(64),
  doctorId: z.string().min(1).max(64),
  slotStart: isoInstant,
}).strict();
type MoveArgs = z.infer<typeof moveArgs>;

const PERMISSION = "opd.appointments.manage";

export const appointmentBookTool: CopilotToolDecl = {
  intent: "appointment_book",
  /* The booking screen's own gate (`POST /opd/appointments`): never more reachable than the screen. */
  permission: PERMISSION,
  needsSubject: false,
  kind: "act",
  async run(ctx): Promise<CopilotAnswer> {
    const now = new Date();
    const typed = ctx.typed ?? ctx.question;
    const { doctors, tokens } = namedDoctors(typed, await activeDoctors(ctx.db));
    if (doctors.length === 0) return say("copilot.answer.apptWhichDoctor");
    if (doctors.length > 1) return say("copilot.answer.apptDoctorUnclear", { doctors: doctors.slice(0, 4).map((d) => d.displayName).join(", ") });
    const doctor = doctors[0]!;

    const found = await findPatients(ctx, tokens, now);
    if (found.kind === "which") return say("copilot.answer.apptWhichPatient");
    if (found.kind === "none") return say("copilot.answer.apptNoPatient");

    const when = parseWhen(typed, istDate(now));
    const times = await nextFree(ctx.db, doctor.id, when, now);
    if (times.length === 0) {
      return when.day === null
        ? say("copilot.answer.apptNoSlots", { doctor: doctor.displayName })
        : say("copilot.answer.apptNoSlotsOn", { doctor: doctor.displayName, day: when.day });
    }
    const mode = asksTele(typed) ? "tele" : "in_person";
    await recordLookups(ctx, found.list);

    const proposeMany: { args: BookArgs; subject: string }[] = [];
    const rows: CopilotApptRow[] = found.list.map((c) => {
      /* A tele-call rings the patient's own registered mobile; none on record ⇒ the screen, which can take one. */
      const noMobile = mode === "tele" && !c.hasPhone;
      return {
        patient: patientOf(c), doctor: doctor.displayName, mode, from: null, noMobile,
        times: noMobile ? [] : times.map((t) => {
          proposeMany.push({ args: { patientId: c.id, doctorId: doctor.id, slotStart: t.toISOString(), mode }, subject: c.id });
          return { at: t.toISOString(), proposal: proposeMany.length - 1 };
        }),
      };
    });
    if (proposeMany.length === 0) return say("copilot.answer.apptNoMobile");
    const pick: CopilotApptPick = { kind: "apptPick", action: "book", pickPatient: found.kind === "pick", rows };
    const answer = found.kind === "direct"
      ? say("copilot.answer.apptPickTime", { patient: found.list[0]!.name, doctor: doctor.displayName })
      : say("copilot.answer.apptPick", { count: found.list.length });
    return { ...answer, payload: pick, proposeMany };
  },
  act: defineAct<BookArgs>({
    args: bookArgs,
    async recheck(tx, a) {
      const refusal = await slotRefusal(tx, a.doctorId, new Date(a.slotStart), new Date());
      if (refusal !== null) return refusal;
      if (a.mode === "tele") {
        const [p] = await tx.select({ phone: patients.phone }).from(patients).where(eq(patients.id, a.patientId));
        if (p?.phone == null) return "copilot.answer.apptNoMobile";
      }
      return null;
    },
    async apply(tx, a, ctx) {
      const [p] = await tx.select({ phone: patients.phone }).from(patients).where(eq(patients.id, a.patientId));
      const { appointment } = await bookAppointmentInTx(tx, ctx.actor, {
        patientId: a.patientId, doctorId: a.doctorId, slotStart: new Date(a.slotStart), source: "desk",
        mode: a.mode, telePhone: a.mode === "tele" ? p?.phone ?? null : null,
      });
      return {
        answer: await doneAnswer(tx, "copilot.answer.apptBooked", appointment.id),
        module: "opd", rowId: appointment.id, subjectPatientId: appointment.patientId,
      };
    },
    verify: {
      /* The row as written: booked, for the patient the clerk tapped, with that doctor at that time. */
      async readBack(tx, a, result) {
        const [row] = await tx.select().from(opdAppointments).where(eq(opdAppointments.id, result.rowId));
        return row !== undefined && row.status === "booked" && row.patientId === result.subjectPatientId
          && row.doctorId === a.doctorId && row.slotStart.getTime() === new Date(a.slotStart).getTime() && row.mode === a.mode;
      },
    },
  }),
};

export const appointmentMoveTool: CopilotToolDecl = {
  intent: "appointment_move",
  /* `POST /opd/appointments/:id/reschedule`'s gate. */
  permission: PERMISSION,
  needsSubject: false,
  kind: "act",
  async run(ctx): Promise<CopilotAnswer> {
    const now = new Date();
    const typed = ctx.typed ?? ctx.question;
    const { doctors, tokens } = namedDoctors(typed, await activeDoctors(ctx.db));
    if (doctors.length > 1) return say("copilot.answer.apptDoctorUnclear", { doctors: doctors.slice(0, 4).map((d) => d.displayName).join(", ") });
    const target = doctors[0] ?? null;

    const found = await findPatients(ctx, tokens, now);
    if (found.kind === "which") return say("copilot.answer.apptWhichPatient");
    if (found.kind === "none") return say("copilot.answer.apptNoPatient");

    /* Each patient's live appointments from today on, soonest first; one row per appointment, five rows at most. */
    const live = await ctx.db.select({
      id: opdAppointments.id, patientId: opdAppointments.patientId, doctorId: opdAppointments.doctorId,
      slotStart: opdAppointments.slotStart, mode: opdAppointments.mode, doctor: opdDoctors.displayName,
    }).from(opdAppointments)
      .innerJoin(opdDoctors, eq(opdDoctors.id, opdAppointments.doctorId))
      .where(and(
        inArray(opdAppointments.patientId, found.list.map((c) => c.id)),
        inArray(opdAppointments.status, ["booked", "needs_rebooking"]),
        gte(opdAppointments.serviceDate, istDate(now)),
      ))
      .orderBy(asc(opdAppointments.slotStart));
    const pairs = found.list.flatMap((c) => live.filter((a) => a.patientId === c.id).slice(0, TIMES).map((a) => ({ c, a }))).slice(0, MAX_PATIENTS);
    if (pairs.length === 0) return say("copilot.answer.apptNoneToMove");
    await recordLookups(ctx, [...new Map(pairs.map((x) => [x.c.id, x.c])).values()]);

    const when = parseWhen(typed, istDate(now));
    const proposeMany: { args: MoveArgs; subject: string }[] = [];
    const rows: CopilotApptRow[] = [];
    for (const { c, a } of pairs) {
      const doctorId = target?.id ?? a.doctorId;
      const times = await nextFree(ctx.db, doctorId, when, now, a.slotStart.getTime());
      rows.push({
        patient: patientOf(c), doctor: target?.displayName ?? a.doctor, mode: a.mode === "tele" ? "tele" : "in_person",
        from: a.slotStart.toISOString(), fromDoctor: a.doctor, noMobile: false,
        times: times.map((t) => {
          proposeMany.push({ args: { appointmentId: a.id, patientId: c.id, doctorId, slotStart: t.toISOString() }, subject: c.id });
          return { at: t.toISOString(), proposal: proposeMany.length - 1 };
        }),
      });
    }
    if (proposeMany.length === 0) {
      const doctor = rows[0]!.doctor;
      return when.day === null ? say("copilot.answer.apptNoSlots", { doctor }) : say("copilot.answer.apptNoSlotsOn", { doctor, day: when.day });
    }
    const direct = found.kind === "direct" && rows.length === 1;
    const pick: CopilotApptPick = { kind: "apptPick", action: "move", pickPatient: !direct, rows };
    const answer = direct
      ? say("copilot.answer.apptPickTime", { patient: found.list[0]!.name, doctor: rows[0]!.doctor })
      : say("copilot.answer.apptPick", { count: rows.length });
    return { ...answer, payload: pick, proposeMany };
  },
  act: defineAct<MoveArgs>({
    args: moveArgs,
    async recheck(tx, a) {
      const [row] = await tx.select({ status: opdAppointments.status, patientId: opdAppointments.patientId })
        .from(opdAppointments).where(eq(opdAppointments.id, a.appointmentId));
      if (row === undefined || row.patientId !== a.patientId || (row.status !== "booked" && row.status !== "needs_rebooking")) {
        return "copilot.answer.apptChanged";
      }
      return slotRefusal(tx, a.doctorId, new Date(a.slotStart), new Date());
    },
    async apply(tx, a, ctx) {
      const { to } = await rescheduleAppointmentInTx(tx, ctx.actor, a.appointmentId, { slotStart: new Date(a.slotStart), doctorId: a.doctorId });
      return {
        answer: await doneAnswer(tx, "copilot.answer.apptMoved", to.id),
        module: "opd", rowId: to.id, subjectPatientId: to.patientId,
      };
    },
    verify: {
      /* The new row: booked, the same patient, moved from the appointment the clerk tapped, to that time. */
      async readBack(tx, a, result) {
        const [row] = await tx.select().from(opdAppointments).where(eq(opdAppointments.id, result.rowId));
        return row !== undefined && row.status === "booked" && row.patientId === a.patientId && row.rescheduledFromId === a.appointmentId
          && row.doctorId === a.doctorId && row.slotStart.getTime() === new Date(a.slotStart).getTime();
      },
    },
  }),
};

export const opdAppointmentCopilotTools: readonly CopilotToolDecl[] = [appointmentBookTool, appointmentMoveTool];
