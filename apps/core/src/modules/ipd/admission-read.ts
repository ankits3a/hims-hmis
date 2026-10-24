import { and, asc, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  events, ipdAdmissionDeposits, ipdAdmissions, ipdBands, ipdBedReservations, ipdBedStays, resources,
} from "../../kernel/db/schema";
import { getDoctor, listDepartments, listDoctors } from "../opd";
import { getPatientSummaries, listAllergies } from "../patients";
import { needOf, readAdmission, requireIpdPermission } from "./admission-core";
import { incompleteOf, userNames } from "./admissions";
import { IPD_APPROVAL_SUBJECT, latestApproval, requestIpdApproval } from "./approval-types";
import { allergyWords } from "./bands";
import { initialsOf } from "./beds-board";
import { ageInYears } from "./bed-rules";
import { proposeBeds } from "./beds";
import { classQuotes, depositPaidPaise, loadPriceBook } from "./deposit";
import { IpdError, IpdRefusal } from "./errors";
import { IPD_ADMIT, IPD_ADMIT_REQUEST } from "./manifest";
import { capWarningsFor } from "./payer-bill";
import type {
  Actor, IpdAdmissionView, IpdAdvice, IpdApprovalKind, IpdBedClass, IpdBedProposal, IpdClassQuote,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * E1.2 (#719) — THE ADMISSION DESK'S READS: one admission as the sheet shows it, the class cards, the top three beds,
 * the open requests (the sheet's list and the Beds board's waiting column) and recent OPD advice to admit.
 */

const SHEET_STATES = ["requested", "reserved", "admitted"] as const;

function ageSex(dob: Date | null, gender: string, at: Date): string {
  const age = ageInYears(dob, at);
  const sex = gender === "male" ? "M" : gender === "female" ? "F" : "O";
  return `${sex} ${age === null ? "?" : String(age)}`;
}

export async function viewAdmission(db: Db, actor: Actor, admissionId: string, at: Date = new Date()): Promise<IpdAdmissionView> {
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const a = await readAdmission(db, admissionId);
  return (await toViews(db, actor, [a], at))[0]!;
}

async function toViews(db: Db, actor: Actor, rows: AdmissionRow[], at: Date): Promise<IpdAdmissionView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const people = new Map((await getPatientSummaries(db, actor, rows.map((r) => r.patientId))).map((p) => [p.requestedId, p] as const));
  const names = await userNames(db, rows.map((r) => r.consultantId));
  const holds = await db.select({ id: ipdBedReservations.id, admissionId: ipdBedReservations.admissionId, bedId: ipdBedReservations.bedId, expiresAt: ipdBedReservations.expiresAt, code: resources.code })
    .from(ipdBedReservations).innerJoin(resources, eq(resources.id, ipdBedReservations.bedId))
    .where(and(inArray(ipdBedReservations.admissionId, ids), eq(ipdBedReservations.status, "active")));
  const stays = await db.select({ admissionId: ipdBedStays.admissionId, bedId: ipdBedStays.bedId, code: resources.code, parentId: resources.parentId })
    .from(ipdBedStays).innerJoin(resources, eq(resources.id, ipdBedStays.bedId))
    .where(and(inArray(ipdBedStays.admissionId, ids), isNull(ipdBedStays.endedAt)));
  const deps = await db.select().from(ipdAdmissionDeposits).where(inArray(ipdAdmissionDeposits.admissionId, ids))
    .orderBy(asc(ipdAdmissionDeposits.takenAt));
  const bands = await db.select().from(ipdBands).where(and(inArray(ipdBands.admissionId, ids), eq(ipdBands.status, "printed")));
  const out: IpdAdmissionView[] = [];
  for (const a of rows) {
    const p = people.get(a.patientId);
    const hold = holds.find((h) => h.admissionId === a.id);
    const stay = stays.find((s) => s.admissionId === a.id);
    const band = bands.find((b) => b.admissionId === a.id);
    const ward = stay?.parentId ? (await db.select({ name: resources.name, kind: resources.kind, parentId: resources.parentId }).from(resources).where(eq(resources.id, stay.parentId)))[0] : undefined;
    const wardName = ward === undefined ? null : ward.kind === "room" && ward.parentId !== null
      ? (await db.select({ name: resources.name }).from(resources).where(eq(resources.id, ward.parentId)))[0]?.name ?? null : ward.name;
    const c = a.consent as Record<string, string | null> | null;
    const name = p === undefined ? null : p.restricted ? p.alias : p.name;
    out.push({
      id: a.id, admissionNo: a.admissionNo, state: a.state as IpdAdmissionView["state"], source: a.source as IpdAdmissionView["source"],
      patient: {
        id: a.patientId, uhid: p?.uhid ?? "", name, initials: initialsOf(name ?? p?.uhid ?? "?"),
        ageSex: p === undefined ? "" : ageSex(p.dob, p.administrativeGender, at),
        allergies: allergyWords(await listAllergies(db, a.patientId)).filter((w) => w !== "Allergy: none recorded"),
      },
      consultant: { id: a.consultantId, name: names.get(a.consultantId) ?? a.consultantId },
      department: a.department, provisionalDiagnosis: a.provisionalDiagnosis, mlc: a.mlc,
      requestedClass: a.requestedClass as IpdBedClass, isolation: a.isolation as IpdAdmissionView["isolation"], icu: a.icu,
      requestedAt: a.requestedAt.toISOString(), plannedFor: a.plannedFor?.toISOString() ?? null, expiresAt: a.expiresAt.toISOString(),
      payerKind: a.payerKind, coverageId: a.coverageId, estimatePaise: a.estimatePaise, depositRequiredPaise: a.depositRequiredPaise,
      depositBasis: a.depositBasis, depositPaidPaise: await depositPaidPaise(db, a.id), depositCheckPending: a.depositCheckPending,
      deposits: deps.filter((d) => d.admissionId === a.id).map((d) => ({
        receiptId: d.receiptId, receiptNo: d.receiptNo, amountPaise: d.amountPaise, takenAt: d.takenAt.toISOString(),
      })),
      consent: c === null || a.consentAt === null ? null : {
        signedBy: (c.signedBy ?? "patient") as "patient", method: (c.method ?? null) as "paper" | null, signerName: c.signerName ?? null,
        relation: c.relation ?? null, witnessName: c.witnessName ?? null, at: a.consentAt.toISOString(),
      },
      reservation: hold === undefined ? null : { id: hold.id, bedId: hold.bedId, bedCode: hold.code, expiresAt: hold.expiresAt.toISOString() },
      bed: stay === undefined ? null : { id: stay.bedId, code: stay.code, wardName },
      band: band === undefined ? null : { id: band.id, serial: band.serial, printedAt: band.printedAt.toISOString() },
      icuApproval: a.icu ? (a.icuApprovalId !== null ? { id: a.icuApprovalId, status: "granted" } : await latestApproval(db, "icu", [a.id, a.patientId])) : null,
      admittedAt: a.admittedAt?.toISOString() ?? null, stabilisedAt: a.stabilisedAt?.toISOString() ?? null,
      erArrivedAt: a.erArrivedAt?.toISOString() ?? null,
      downtimeSerial: a.downtimeSerial,
      erArrivedAt: null, // IPD/ER train B2 — the contracts are final; the ER arrival time arrives with the ER lanes (B4)
      incomplete: a.state === "admitted" ? incompleteOf(a, band !== undefined) : [],
    });
  }
  return out;
}

/** The sheet's list: open requests, and admitted patients still incomplete or without a band (newest first). */
export async function listDeskAdmissions(db: Db, actor: Actor, at: Date = new Date()): Promise<IpdAdmissionView[]> {
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const rows = await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.state, [...SHEET_STATES]))
    .orderBy(desc(ipdAdmissions.requestedAt)).limit(200);
  const views = await toViews(db, actor, rows, at);
  return views.filter((v) => v.state !== "admitted" || v.incomplete.length > 0).slice(0, 60);
}

export async function quotesFor(db: Db, actor: Actor, admissionId: string, at: Date = new Date()): Promise<IpdClassQuote[]> {
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const a = await readAdmission(db, admissionId);
  const { freeByClass } = await proposeBeds(db, actor, { patientId: a.patientId, need: needOf(a), at, limit: 0 });
  const base: IpdBedClass[] = ["general", "semi_private", "private", "deluxe"];
  const classes = base.includes(a.requestedClass as IpdBedClass) ? base : [a.requestedClass as IpdBedClass, ...base.slice(0, 3)];
  const quotes = await classQuotes(db, a, classes, freeByClass, at);
  // E2.2 (#726): the room-rent cap warning on each class card (§4.9 B), from the authorisation's cap when recorded.
  const warnings = await capWarningsFor(db, a, classes, at, await loadPriceBook(db, at));
  return quotes.map((q) => ({ ...q, capWarning: warnings.get(q.class) ?? null }));
}

export async function bedProposalsFor(db: Db, actor: Actor, admissionId: string, at: Date = new Date()): Promise<IpdBedProposal[]> {
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const a = await readAdmission(db, admissionId);
  const held = (await db.select({ bedId: ipdBedReservations.bedId }).from(ipdBedReservations)
    .where(and(eq(ipdBedReservations.admissionId, a.id), eq(ipdBedReservations.status, "active"))))[0];
  const { beds } = await proposeBeds(db, actor, { patientId: a.patientId, need: needOf(a), at, heldBedId: held?.bedId ?? null });
  return beds;
}

/**
 * Recent OPD advice to admit (OPD's `admission.requested` event, last 48 h) not yet raised as a request. DECIDED:
 * OPD keeps only an "admission advised" flag; the desk raises the request from this list, naming the advising doctor.
 */
export async function recentAdvice(db: Db, actor: Actor, now: Date = new Date()): Promise<IpdAdvice[]> {
  await requireIpdPermission(db, actor, IPD_ADMIT_REQUEST);
  const rows = await db.select({ payload: events.payload, at: events.occurredAt }).from(events)
    .where(and(eq(events.name, "admission.requested"), eq(events.module, "opd"), gte(events.recordedAt, new Date(now.getTime() - 48 * 3_600_000))))
    .orderBy(desc(events.occurredAt)).limit(100);
  const raised = new Set((await db.select({ ref: ipdAdmissions.sourceRef }).from(ipdAdmissions)
    .where(and(eq(ipdAdmissions.source, "opd_advice"), isNotNull(ipdAdmissions.sourceRef)))).map((r) => r.ref));
  const items = rows.map((r) => ({ ...(r.payload as { encounterId: string; patientId: string; doctorId: string; departmentId: string; note: string | null }), at: r.at }))
    .filter((r) => !raised.has(r.encounterId));
  const people = new Map((await getPatientSummaries(db, actor, items.map((i) => i.patientId))).map((p) => [p.requestedId, p] as const));
  const out: IpdAdvice[] = [];
  for (const i of items) {
    const d = await getDoctor(db, i.doctorId);
    const p = people.get(i.patientId);
    out.push({
      encounterId: i.encounterId, patientId: p?.id ?? i.patientId, doctorId: d?.userId ?? i.doctorId, doctorName: d?.displayName ?? "",
      departmentId: i.departmentId, patientName: p === undefined ? null : p.restricted ? p.alias : p.name, uhid: p?.uhid ?? "",
      note: i.note, advisedAt: i.at.toISOString(),
    });
  }
  return out;
}

/** Consultants the desk may name (active OPD doctors), with their department code. */
export async function consultantChoices(db: Db, actor: Actor): Promise<{ userId: string; name: string; department: string | null }[]> {
  await requireIpdPermission(db, actor, IPD_ADMIT_REQUEST);
  const depts = new Map((await listDepartments(db)).map((d) => [d.id, d.code] as const));
  return (await listDoctors(db, { activeOnly: true })).map((d) => ({
    userId: d.userId, name: d.displayName, department: d.departmentId === null ? null : depts.get(d.departmentId) ?? null,
  }));
}

/** The desk asks for an approval on an admission (ICU intensivist, a scheme's non-covered line, a deposit waiver). */
export async function askApproval(
  db: Db, actor: Actor, admissionId: string, body: { kind: IpdApprovalKind; note: string; amountPaise?: number },
): Promise<{ approvalId: string }> {
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const a = await readAdmission(db, admissionId);
  // E3.1 review (#759): an admitted ward patient may need an ICU step-up (a transfer or swap onto an ICU bed).
  if (body.kind === "icu" && !a.icu && a.state !== "admitted") throw new IpdRefusal("admission_wrong_state", "Not an ICU admission");
  // Review RED 2: a non-covered line names its amount — the cap every receipt is held to.
  if (body.kind === "non_covered" && body.amountPaise === undefined) {
    throw new IpdError("non_covered_amount_required", "a non-covered line must name its amount in paise");
  }
  return withTx(db, (tx) => requestIpdApproval(tx, actor, {
    kind: body.kind, subjectId: a.id, patientId: a.patientId, note: body.note,
    ...(body.amountPaise === undefined ? {} : { amountPaise: body.amountPaise }),
  }));
}

/**
 * Review #10 — the emergency lane's ICU approval, asked BEFORE the admission exists: the server mints the admission id
 * the approval names, and `emergencyAdmit` creates the admission under that id. Scoped to one admission, never to the
 * patient at large.
 */
export async function askEmergencyIcuApproval(db: Db, actor: Actor, body: { patientId: string; note: string }): Promise<{ approvalId: string; admissionId: string }> {
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const admissionId = newId();
  const { approvalId } = await withTx(db, (tx) => requestIpdApproval(tx, actor, { kind: "icu", subjectId: admissionId, patientId: body.patientId, note: body.note }));
  return { approvalId, admissionId };
}

/** Review #7 — the bill desk's list: downtime admissions whose paper deposit is not yet checked. */
export async function pendingDepositChecks(db: Db, actor: Actor, at: Date = new Date()): Promise<IpdAdmissionView[]> {
  await requireIpdPermission(db, actor, IPD_ADMIT);
  const rows = await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.depositCheckPending, true))
    .orderBy(asc(ipdAdmissions.requestedAt)).limit(200);
  return toViews(db, actor, rows, at);
}

export { IPD_APPROVAL_SUBJECT };
