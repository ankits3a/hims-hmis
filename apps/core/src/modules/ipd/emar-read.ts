import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { IPD_EMAR_LABEL_PREFIX } from "@hmis/contracts";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import {
  dietNpo, ipdAdmissions, ipdBedStays, ipdEmarActs, ipdEmarAllergyFlags, ipdEmarDoses, ipdEmarInfusionEvents, ipdEmarIssues, ipdEmarLabels,
  ipdEmarNarcoticRegister, ipdEmarReturns, ipdEmarVerbalOrders, ipdOrders, resources,
} from "../../kernel/db/schema";
import { listAllergies } from "../patients";
import { readAdmission, requireIpdPermission } from "./admission-core";
import { userNames } from "./admissions";
import { allergyWords } from "./bands";
import { emarDrugsOf } from "./emar-drug";
import { bandOf, givenTimesOf, infusionStateOf, labelOf, verifyFindingsOf } from "./emar";
import { doseWordsOf, giveTiming, prnState } from "./emar-rules";
import { IpdRefusal } from "./errors";
import { IPD_NURSING_STATES } from "./nursing";
import { pickWard, wardsWithBeds } from "./nursing-read";
import { IPD_EMAR_GIVE, IPD_EMAR_VERIFY, IPD_EMAR_VIEW } from "./permissions";
import { identitiesOf, placesOf } from "./rounds-read";
import type {
  Actor, IpdEmarDose, IpdEmarDueList, IpdEmarLabelSheet, IpdEmarNarcoticEntry, IpdEmarOrderLine, IpdEmarOutcome, IpdEmarOverrideCounts,
  IpdEmarPatient, IpdEmarPharmacyQueue, IpdEmarScan, IpdEmarWardChart, IpdRoundIdentity,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";
import type { IpdOrderRow } from "./orders";

/**
 * E4.3 (#735) — THE eMAR's READS: the pharmacist's queue (desktop), one patient's MAR (the bedside, board D2), the ward's
 * MAR chart (16:9), the phone's due list, the bedside scan's five checks, the label sheet and the override counts.
 * No money anywhere (decision 0058). SEALED patients: alias or "Sealed patient", no UHID, no bed, no ward, no admission
 * number (the shared identity rule, `identitiesOf` / `nowIdentities`).
 */

const nursingStates = IPD_NURSING_STATES as readonly string[];

type Ctx = { drugs: Awaited<ReturnType<typeof emarDrugsOf>>; issued: Map<string, { own: boolean }>; verbal: Map<string, typeof ipdEmarVerbalOrders.$inferSelect>;
  flags: Set<string>; infusion: Map<string, string>; given: Map<string, Date[]> };

async function ctxOf(db: Db, orders: readonly IpdOrderRow[]): Promise<Ctx> {
  const ids = orders.map((o) => o.id);
  if (ids.length === 0) return { drugs: new Map(), issued: new Map(), verbal: new Map(), flags: new Set(), infusion: new Map(), given: new Map() };
  const [drugs, issues, verbal, flags, inf, given] = await Promise.all([
    emarDrugsOf(db, orders),
    db.select({ orderId: ipdEmarIssues.orderId, own: ipdEmarIssues.ownMedicine }).from(ipdEmarIssues).where(inArray(ipdEmarIssues.orderId, ids)),
    db.select().from(ipdEmarVerbalOrders).where(inArray(ipdEmarVerbalOrders.orderId, ids)),
    db.select({ orderId: ipdEmarAllergyFlags.orderId }).from(ipdEmarAllergyFlags).where(and(inArray(ipdEmarAllergyFlags.orderId, ids), isNull(ipdEmarAllergyFlags.resolvedAt))),
    db.select({ orderId: ipdEmarInfusionEvents.orderId, event: ipdEmarInfusionEvents.event, at: ipdEmarInfusionEvents.at }).from(ipdEmarInfusionEvents)
      .where(inArray(ipdEmarInfusionEvents.orderId, ids)).orderBy(asc(ipdEmarInfusionEvents.at), asc(ipdEmarInfusionEvents.id)),
    givenTimesOf(db, ids),
  ]);
  const issued = new Map<string, { own: boolean }>();
  for (const i of issues) issued.set(i.orderId, { own: (issued.get(i.orderId)?.own ?? true) && i.own });
  const infusion = new Map<string, string>();
  for (const e of inf) infusion.set(e.orderId, e.event);
  return { drugs, issued, verbal: new Map(verbal.map((v) => [v.orderId, v] as const)), flags: new Set(flags.map((f) => f.orderId)), infusion, given };
}

function lineOf(o: IpdOrderRow, c: Ctx, at: Date): IpdEmarOrderLine {
  const d = c.drugs.get(o.id);
  const v = c.verbal.get(o.id);
  const inf = c.infusion.get(o.id);
  const prn = o.prn === null ? null : prnState(c.given.get(o.id) ?? [], o.prn, at);
  return {
    orderId: o.id, title: o.medicineName ?? "—", tallMan: d?.tallMan ?? null, lasa: d?.lasa === true, highAlert: d?.highAlert === true,
    narcotic: d?.narcotic === true, timeCritical: d?.timeCritical === true || o.antibiotic, doseWords: doseWordsOf(o),
    doseValue: o.doseValue ?? 0, doseUnit: o.doseUnit ?? "", route: (o.route ?? "other") as IpdEmarOrderLine["route"], frequency: o.frequency ?? "",
    prn: o.prn, weightBased: o.weightBasedPerKg, weightKg: o.weightKg, startAt: (o.startAt ?? o.orderedAt).toISOString(), stopAt: o.stopAt?.toISOString() ?? null,
    status: o.status as IpdEmarOrderLine["status"], verification: o.verification as IpdEmarOrderLine["verification"], issued: o.issuedAt !== null,
    ownMedicine: c.issued.get(o.id)?.own === true, verbal: v !== undefined, verbalSignBy: v === undefined || v.signedAt !== null ? null : v.signBy.toISOString(),
    allergyFlag: c.flags.has(o.id), infusion: inf === undefined ? null : (infusionStateOf(inf) as "running" | "paused" | "stopped"),
    prnNextAt: prn?.nextAt?.toISOString() ?? null, prnGiven24h: prn?.in24h ?? 0,
  };
}

async function dosesOf(db: Db, orderIds: readonly string[], from: Date, to: Date): Promise<IpdEmarDose[]> {
  if (orderIds.length === 0) return [];
  const slots = await db.select().from(ipdEmarDoses).where(and(
    inArray(ipdEmarDoses.orderId, [...orderIds]),
    or(and(gte(ipdEmarDoses.dueAt, from), lt(ipdEmarDoses.dueAt, to)), and(gte(ipdEmarDoses.reofferedAt, from), lt(ipdEmarDoses.reofferedAt, to))),
  )).orderBy(asc(ipdEmarDoses.dueAt));
  const lastIds = slots.map((s) => s.lastActId).filter((x): x is string => x !== null);
  const acts = lastIds.length === 0 ? [] : await db.select().from(ipdEmarActs).where(inArray(ipdEmarActs.id, lastIds));
  const outcomeIds = acts.map((a) => (a.correctsActId ?? a.id));
  const allActs = outcomeIds.length === 0 ? [] : await db.select().from(ipdEmarActs).where(or(inArray(ipdEmarActs.id, outcomeIds), inArray(ipdEmarActs.correctsActId, outcomeIds)));
  const byId = new Map(allActs.map((a) => [a.id, a] as const));
  const correctionOf = new Map(allActs.filter((a) => a.correctsActId !== null).map((a) => [a.correctsActId!, a.kind] as const));
  const names = await userNames(db, [...new Set(allActs.flatMap((a) => [a.actorId, a.secondNurseId]).filter((x): x is string => x !== null))]);
  return slots.map((s) => {
    const w = s.windowMinutes * 60_000;
    const anchor = s.reofferedAt ?? s.dueAt;
    const last = s.lastActId === null ? undefined : byId.get(s.lastActId);
    // A correction's slot shows the corrected outcome with its mark; an entered-in-error give that reopened the slot shows none.
    const shown = last === undefined ? undefined : last.correctsActId !== null ? (s.status === "scheduled" || s.status === "cancelled" ? undefined : byId.get(last.correctsActId)) : last;
    const outcome: IpdEmarOutcome | null = shown === undefined || ["reoffered"].includes(shown.kind) ? null : {
      actId: shown.id, kind: shown.kind as IpdEmarOutcome["kind"], at: shown.at.toISOString(), byName: names.get(shown.actorId) ?? (shown.provenance === "system" ? "System" : "—"),
      reason: shown.reason, patientCheck: shown.patientCheck as IpdEmarOutcome["patientCheck"], late: shown.late,
      secondNurseName: shown.secondNurseId === null ? null : (names.get(shown.secondNurseId) ?? null),
      corrected: (correctionOf.get(shown.id) as IpdEmarOutcome["corrected"] | undefined) ?? null,
    };
    return {
      doseId: s.id, orderId: s.orderId, dueAt: s.dueAt.toISOString(),
      windowStart: new Date(Math.min(anchor.getTime(), s.dueAt.getTime()) - (s.reofferedAt === null ? w : 0)).toISOString(),
      windowEnd: new Date(anchor.getTime() + w).toISOString(), status: s.status as IpdEmarDose["status"], reoffer: s.reoffer, prn: s.prn, outcome,
    };
  });
}

/**
 * NPO at `at`: diet's rule (`diet` `npoCovering`) read on its own table. diet imports `ipd` at load (its manifest), so
 * importing diet's index here would make a load-time cycle; the predicate is copied, one row, read-only.
 */
async function npoOf(db: Db, patientId: string, at: Date): Promise<boolean> {
  const row = (await db.select({ id: dietNpo.id }).from(dietNpo).where(and(
    eq(dietNpo.patientId, patientId), isNull(dietNpo.liftedAt), lte(dietNpo.startsAt, at), or(isNull(dietNpo.endsAt), gt(dietNpo.endsAt, at)),
  )).limit(1))[0];
  return row !== undefined;
}

async function patientBlock(db: Db, actor: Actor, a: AdmissionRow, at: Date, from: Date, to: Date, ids: Map<string, IpdRoundIdentity>, places: Awaited<ReturnType<typeof placesOf>>) {
  const orders = (await db.select().from(ipdOrders).where(and(eq(ipdOrders.admissionId, a.id), eq(ipdOrders.kind, "drug"))).orderBy(asc(ipdOrders.orderedAt)))
    .filter((o) => o.status === "active" || (o.stoppedAt ?? o.cancelledAt ?? at).getTime() >= from.getTime());
  const c = await ctxOf(db, orders);
  const identity = ids.get(a.id)!;
  const place = places.get(a.id);
  return {
    admissionId: a.id, admissionNo: identity.sealed ? null : a.admissionNo, identity,
    bedCode: identity.sealed ? null : place?.bedCode ?? null, wardName: identity.sealed ? null : place?.wardName ?? null,
    alerts: allergyWords(await listAllergies(db, a.patientId)), npo: await npoOf(db, a.patientId, at),
    weightKg: orders.map((o) => o.weightKg).filter((w): w is number => w !== null).at(-1) ?? null,
    orders: orders.map((o) => lineOf(o, c, at)), doses: await dosesOf(db, orders.map((o) => o.id), from, to),
  };
}

/** One patient's MAR: the bedside (now − 12 h … now + 12 h by default) or a chart day. */
export async function readEmarPatient(db: Db, actor: Actor, admissionId: string, opts: { now?: Date; from?: Date; to?: Date } = {}): Promise<IpdEmarPatient> {
  await requireIpdPermission(db, actor, IPD_EMAR_VIEW);
  const at = opts.now ?? new Date();
  const a = await readAdmission(db, admissionId);
  const from = opts.from ?? new Date(at.getTime() - 12 * 3_600_000);
  const to = opts.to ?? new Date(at.getTime() + 12 * 3_600_000);
  const ids = await identitiesOf(db, actor, [a], at);
  const block = await patientBlock(db, actor, a, at, from, to, ids, await placesOf(db, [a.id]));
  const narc = await db.select().from(ipdEmarNarcoticRegister).where(eq(ipdEmarNarcoticRegister.admissionId, a.id)).orderBy(desc(ipdEmarNarcoticRegister.at)).limit(50);
  const names = await userNames(db, [...new Set(narc.flatMap((n) => [n.actorId, n.witnessId]).filter((x): x is string => x !== null))]);
  const narcotic: IpdEmarNarcoticEntry[] = narc.map((n) => ({
    entryId: n.id, orderId: n.orderId, kind: n.kind as IpdEmarNarcoticEntry["kind"], qty: n.qty, unit: n.unit, at: n.at.toISOString(),
    byName: names.get(n.actorId) ?? "—", witnessName: n.witnessId === null ? null : names.get(n.witnessId) ?? null,
  }));
  return { asOf: at.toISOString(), ...block, narcotic };
}

async function wardAdmissions(db: Db, wardId: string | undefined): Promise<{ ward: { id: string; code: string; name: string } | null; wards: { id: string; code: string; name: string }[]; admissions: AdmissionRow[] }> {
  const { wards, beds } = await wardsWithBeds(db);
  const ward = pickWard(wards, wardId);
  if (ward === null) return { ward: null, wards, admissions: [] };
  const bedIds = beds.filter((b) => b.wardId === ward.id).map((b) => b.id);
  const order = new Map(bedIds.map((id, i) => [id, i] as const));
  const stays = bedIds.length === 0 ? [] : await db.select().from(ipdBedStays).where(and(inArray(ipdBedStays.bedId, bedIds), isNull(ipdBedStays.endedAt)));
  const admissions = stays.length === 0 ? [] : (await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, stays.map((s) => s.admissionId))))
    .filter((a) => nursingStates.includes(a.state));
  const bedOf = new Map(stays.map((s) => [s.admissionId, s.bedId] as const));
  admissions.sort((x, y) => (order.get(bedOf.get(x.id)!) ?? 0) - (order.get(bedOf.get(y.id)!) ?? 0));
  return { ward, wards, admissions };
}

/** The ward MAR chart for an IST day (default today): every patient on the ward, orders and the day's doses. */
export async function readWardChart(db: Db, actor: Actor, opts: { wardId?: string; now?: Date; day?: Date } = {}): Promise<IpdEmarWardChart> {
  await requireIpdPermission(db, actor, IPD_EMAR_VIEW);
  const at = opts.now ?? new Date();
  const { start, end } = istDayWindow(opts.day ?? at);
  const { ward, wards, admissions } = await wardAdmissions(db, opts.wardId);
  const ids = await identitiesOf(db, actor, admissions, at);
  const places = await placesOf(db, admissions.map((a) => a.id));
  const patients = [];
  for (const a of admissions) patients.push(await patientBlock(db, actor, a, at, start, end, ids, places));
  return { asOf: at.toISOString(), dayStart: start.toISOString(), dayEnd: end.toISOString(), ward, wards, patients };
}

/** The phone's due list: open doses whose window has opened (or that are re-offered, or missed inside the catch-up). */
export async function readEmarDue(db: Db, actor: Actor, opts: { wardId?: string; now?: Date } = {}): Promise<IpdEmarDueList> {
  await requireIpdPermission(db, actor, IPD_EMAR_VIEW);
  const at = opts.now ?? new Date();
  const { admissions } = await wardAdmissions(db, opts.wardId);
  if (admissions.length === 0) return { asOf: at.toISOString(), items: [] };
  const slots = await db.select().from(ipdEmarDoses).where(and(
    inArray(ipdEmarDoses.admissionId, admissions.map((a) => a.id)), inArray(ipdEmarDoses.status, ["scheduled", "missed"]),
    gte(sql`coalesce(${ipdEmarDoses.reofferedAt}, ${ipdEmarDoses.dueAt})`, new Date(at.getTime() - 6 * 3_600_000)),
    lt(ipdEmarDoses.dueAt, new Date(at.getTime() + 2 * 3_600_000)),
  )).orderBy(asc(ipdEmarDoses.dueAt));
  const live = slots.filter((s) => {
    const t = giveTiming(s, at);
    return s.status === "scheduled" ? t !== "closed" && (t !== "early" || s.dueAt.getTime() - at.getTime() <= 2 * 3_600_000) : t === "late";
  });
  const orders = live.length === 0 ? [] : await db.select().from(ipdOrders).where(and(inArray(ipdOrders.id, [...new Set(live.map((s) => s.orderId))]), eq(ipdOrders.status, "active")));
  const byOrder = new Map(orders.map((o) => [o.id, o] as const));
  const drugs = await emarDrugsOf(db, orders);
  const ids = await identitiesOf(db, actor, admissions, at);
  const places = await placesOf(db, admissions.map((a) => a.id));
  return {
    asOf: at.toISOString(),
    items: live.filter((s) => byOrder.has(s.orderId)).map((s) => {
      const o = byOrder.get(s.orderId)!;
      const id = ids.get(s.admissionId)!;
      const windowEnd = new Date((s.reofferedAt ?? s.dueAt).getTime() + s.windowMinutes * 60_000);
      return {
        doseId: s.id, admissionId: s.admissionId, bedCode: id.sealed ? null : places.get(s.admissionId)?.bedCode ?? null, name: id.name, sealed: id.sealed,
        orderId: o.id, title: o.medicineName ?? "—", doseWords: doseWordsOf(o), route: (o.route ?? "other") as IpdEmarDueListRoute,
        dueAt: (s.reofferedAt ?? s.dueAt).toISOString(), windowEnd: windowEnd.toISOString(), status: s.status as "scheduled" | "missed",
        overdue: at.getTime() > s.dueAt.getTime(), highAlert: drugs.get(o.id)?.highAlert === true,
      };
    }),
  };
}
type IpdEmarDueListRoute = IpdEmarDueList["items"][number]["route"];

/**
 * The bedside scan (§4.9 D): the band pivots the screen to ITS patient (never silently keeps the previous one — edge 7);
 * a label adds the five checks — patient, drug, dose, time, route — and what the give will still need.
 */
export async function scanAtBedside(db: Db, actor: Actor, input: { wristbandCode?: string; admissionId?: string; labelCode?: string }, opts: { now?: Date } = {}): Promise<IpdEmarScan> {
  await requireIpdPermission(db, actor, IPD_EMAR_GIVE);
  const at = opts.now ?? new Date();
  let admissionId = input.admissionId ?? null;
  let bandSerial: string | null = null;
  if (input.wristbandCode !== undefined && input.wristbandCode.trim() !== "") {
    const band = await bandOf(db, input.wristbandCode);
    if (band === null) throw new IpdRefusal("wrong_patient_scanned", undefined, { reason: "band_unknown" });
    admissionId = band.admissionId;
    bandSerial = band.serial;
  }
  if (admissionId === null) throw new IpdRefusal("wristband_scan_required");
  const a = await readAdmission(db, admissionId);
  if (input.labelCode === undefined || input.labelCode.trim() === "") return { asOf: at.toISOString(), admissionId: a.id, bandSerial, label: null };
  const label = await labelOf(db, input.labelCode);
  if (label === null) throw new IpdRefusal("wrong_drug_scanned", undefined, { reason: "label_unknown", prefix: IPD_EMAR_LABEL_PREFIX });
  const o = (await db.select().from(ipdOrders).where(eq(ipdOrders.id, label.orderId)))[0]!;
  const c = await ctxOf(db, [o]);
  const line = lineOf(o, c, at);
  const slots = o.prn !== null ? [] : await dosesOf(db, [o.id], new Date(at.getTime() - 6 * 3_600_000), new Date(at.getTime() + 6 * 3_600_000));
  const dose = slots.filter((d) => d.status === "scheduled" || d.status === "missed")
    .sort((x, y) => Math.abs(new Date(x.dueAt).getTime() - at.getTime()) - Math.abs(new Date(y.dueAt).getTime() - at.getTime()))[0] ?? null;
  const samePatient = label.admissionId === a.id;
  const timing = dose === null ? null : giveTiming({ dueAt: new Date(dose.dueAt), windowMinutes: (new Date(dose.windowEnd).getTime() - new Date(dose.dueAt).getTime()) / 60_000, reofferedAt: null }, at);
  const timeOk = o.prn !== null ? line.prnNextAt === null : timing === "open" || timing === "late";
  return {
    asOf: at.toISOString(), admissionId: a.id, bandSerial,
    label: {
      labelId: label.id, orderId: o.id, order: line, dose,
      checks: [
        { key: "patient", ok: samePatient, words: samePatient ? "Right patient" : "Label is for another patient" },
        { key: "drug", ok: o.status === "active" && o.verification === "verified" && !line.allergyFlag, words: line.allergyFlag ? "Allergy flag open" : o.status !== "active" ? "Order not active" : line.tallMan ?? line.title },
        { key: "dose", ok: true, words: line.doseWords },
        { key: "time", ok: timeOk, words: o.prn !== null ? (line.prnNextAt === null ? "PRN · may give now" : `PRN · not before ${line.prnNextAt}`) : dose === null ? "No dose due" : timing === "late" ? "Late · reason needed" : timing === "open" ? "Due now" : "Not due yet" },
        { key: "route", ok: true, words: line.route.toUpperCase() },
      ],
      needs: { secondNurse: line.highAlert, lasaConfirm: line.lasa, weight: o.weightBasedPerKg && o.weightKg === null, lateReason: timing === "late" || dose?.status === "missed" },
    },
  };
}

/** The pharmacist's desktop queue. */
export async function readPharmacyQueue(db: Db, actor: Actor, opts: { now?: Date } = {}): Promise<IpdEmarPharmacyQueue> {
  await requireIpdPermission(db, actor, IPD_EMAR_VERIFY);
  const at = opts.now ?? new Date();
  const live = await db.select().from(ipdOrders).where(and(eq(ipdOrders.kind, "drug"), eq(ipdOrders.status, "active"))).orderBy(asc(ipdOrders.orderedAt)).limit(300);
  const admissionsAll = live.length === 0 ? [] : await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, [...new Set(live.map((o) => o.admissionId))]));
  const admissions = admissionsAll.filter((a) => nursingStates.includes(a.state));
  const byAdmission = new Map(admissions.map((a) => [a.id, a] as const));
  const orders = live.filter((o) => byAdmission.has(o.admissionId));
  const c = await ctxOf(db, orders);
  const ids = await identitiesOf(db, actor, admissions, at);
  const places = await placesOf(db, admissions.map((a) => a.id));
  const names = await userNames(db, [...new Set(orders.map((o) => o.orderedBy))]);
  const alerts = new Map<string, string[]>();
  for (const a of admissions) alerts.set(a.id, allergyWords(await listAllergies(db, a.patientId)));
  const base = (o: IpdOrderRow) => {
    const id = ids.get(o.admissionId)!;
    return {
      order: lineOf(o, c, at), admissionId: o.admissionId, identity: id, bedCode: id.sealed ? null : places.get(o.admissionId)?.bedCode ?? null,
      wardName: id.sealed ? null : places.get(o.admissionId)?.wardName ?? null, alerts: alerts.get(o.admissionId) ?? [],
      orderedByName: names.get(o.orderedBy) ?? "—", orderedAt: o.orderedAt.toISOString(), allergyOverrideReason: o.allergyOverrideReason,
    };
  };
  const toVerify = [];
  for (const o of orders.filter((x) => x.verification === "pending" || x.verification === "query")) {
    const f = await verifyFindingsOf(db, o, c.drugs.get(o.id), at);
    toVerify.push({ ...base(o), ...f });
  }
  const toIssue = orders.filter((o) => o.verification === "verified" && o.issuedAt === null).map(base);
  const flagRows = await db.select().from(ipdEmarAllergyFlags).where(isNull(ipdEmarAllergyFlags.resolvedAt)).orderBy(asc(ipdEmarAllergyFlags.raisedAt)).limit(100);
  const flagOrders = flagRows.length === 0 ? [] : await db.select().from(ipdOrders).where(inArray(ipdOrders.id, flagRows.map((f) => f.orderId)));
  const flagAdm = flagRows.length === 0 ? [] : await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, [...new Set(flagRows.map((f) => f.admissionId))]));
  const flagIds = await identitiesOf(db, actor, flagAdm, at);
  const flagPlaces = await placesOf(db, flagAdm.map((a) => a.id));
  const allergyFlags = flagRows.map((f) => {
    const o = flagOrders.find((x) => x.id === f.orderId);
    const id = flagIds.get(f.admissionId)!;
    return {
      flagId: f.id, orderId: f.orderId, admissionId: f.admissionId, identity: id, bedCode: id.sealed ? null : flagPlaces.get(f.admissionId)?.bedCode ?? null,
      title: o?.medicineName ?? "—", substances: f.substances, raisedAt: f.raisedAt.toISOString(), orderActive: o?.status === "active",
    };
  });
  // Returns owed: issues on orders that stopped after issue and still owe, with what came back so far.
  const owed = await db.select().from(ipdOrders).where(and(eq(ipdOrders.kind, "drug"), eq(ipdOrders.returnOwed, true))).limit(100);
  const issues = owed.length === 0 ? [] : await db.select().from(ipdEmarIssues).where(inArray(ipdEmarIssues.orderId, owed.map((o) => o.id)));
  const back = issues.length === 0 ? [] : await db.select({ issueId: ipdEmarReturns.issueId, n: sql<number>`sum(${ipdEmarReturns.units})` }).from(ipdEmarReturns)
    .where(inArray(ipdEmarReturns.issueId, issues.map((i) => i.id))).groupBy(ipdEmarReturns.issueId);
  const backOf = new Map(back.map((b) => [b.issueId, Number(b.n)] as const));
  const owedAdm = owed.length === 0 ? [] : await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, [...new Set(owed.map((o) => o.admissionId))]));
  const owedIds = await identitiesOf(db, actor, owedAdm, at);
  const owedPlaces = await placesOf(db, owedAdm.map((a) => a.id));
  const returnsOwed = issues.filter((i) => (backOf.get(i.id) ?? 0) < i.units).map((i) => {
    const id = owedIds.get(i.admissionId)!;
    return {
      issueId: i.id, orderId: i.orderId, admissionId: i.admissionId, identity: id, bedCode: id.sealed ? null : owedPlaces.get(i.admissionId)?.bedCode ?? null,
      title: owed.find((o) => o.id === i.orderId)?.medicineName ?? "—", units: i.units, returnedUnits: backOf.get(i.id) ?? 0, ownMedicine: i.ownMedicine,
      issuedAt: i.issuedAt.toISOString(),
    };
  });
  return { asOf: at.toISOString(), toVerify, toIssue, allergyFlags, returnsOwed };
}

/** The labels of one issue, for the A4 sheet or the label slips (and the browser fallback). */
export async function readLabelSheet(db: Db, actor: Actor, issueId: string): Promise<IpdEmarLabelSheet> {
  await requireIpdPermission(db, actor, IPD_EMAR_VERIFY);
  const issue = (await db.select().from(ipdEmarIssues).where(eq(ipdEmarIssues.id, issueId)))[0];
  if (issue === undefined) throw new IpdRefusal("issue_not_found");
  const o = (await db.select().from(ipdOrders).where(eq(ipdOrders.id, issue.orderId)))[0]!;
  const a = await readAdmission(db, issue.admissionId);
  const id = (await identitiesOf(db, actor, [a], issue.issuedAt)).get(a.id)!;
  const place = (await placesOf(db, [a.id])).get(a.id);
  const drug = (await emarDrugsOf(db, [o])).get(o.id);
  const labels = await db.select().from(ipdEmarLabels).where(eq(ipdEmarLabels.issueId, issue.id)).orderBy(asc(ipdEmarLabels.seq));
  return {
    issueId: issue.id,
    labels: labels.map((l) => ({
      labelId: l.id, code: l.code, seq: l.seq, of: labels.length, units: l.units, drug: o.medicineName ?? "—", tallMan: drug?.tallMan ?? null,
      doseWords: doseWordsOf(o), uhid: id.uhid, name: id.name, admissionNo: id.sealed ? null : a.admissionNo, bedCode: id.sealed ? null : place?.bedCode ?? null,
      issuedAt: issue.issuedAt.toISOString(), ownMedicine: issue.ownMedicine, highAlert: drug?.highAlert === true,
    })),
  };
}

/** Wristband overrides counted per nurse and per ward over a period (default the last 30 days). */
export async function readOverrideCounts(db: Db, actor: Actor, opts: { now?: Date; days?: number } = {}): Promise<IpdEmarOverrideCounts> {
  await requireIpdPermission(db, actor, IPD_EMAR_VIEW);
  const to = opts.now ?? new Date();
  const from = new Date(to.getTime() - (opts.days ?? 30) * 86_400_000);
  const rows = await db.select({ actorId: ipdEmarActs.actorId, wardId: ipdEmarActs.wardId, check: ipdEmarActs.patientCheck }).from(ipdEmarActs)
    .where(and(eq(ipdEmarActs.kind, "given"), gte(ipdEmarActs.at, from), lt(ipdEmarActs.at, to)));
  const byNurse = new Map<string, { overrides: number; gives: number }>();
  const byWard = new Map<string, { overrides: number; gives: number }>();
  for (const r of rows) {
    const n = byNurse.get(r.actorId) ?? { overrides: 0, gives: 0 };
    n.gives += 1; if (r.check === "override") n.overrides += 1; byNurse.set(r.actorId, n);
    const wk = r.wardId ?? "unknown";
    const w = byWard.get(wk) ?? { overrides: 0, gives: 0 };
    w.gives += 1; if (r.check === "override") w.overrides += 1; byWard.set(wk, w);
  }
  const names = await userNames(db, [...byNurse.keys()]);
  const wardIds = [...byWard.keys()].filter((k) => k !== "unknown");
  const wards = wardIds.length === 0 ? [] : await db.select({ id: resources.id, code: resources.code }).from(resources).where(inArray(resources.id, wardIds));
  const codeOf = new Map(wards.map((w) => [w.id, w.code] as const));
  return {
    from: from.toISOString(), to: to.toISOString(),
    byNurse: [...byNurse].map(([userId, v]) => ({ userId, name: names.get(userId) ?? "—", ...v })).sort((x, y) => y.overrides - x.overrides || x.name.localeCompare(y.name)),
    byWard: [...byWard].map(([wardId, v]) => ({ wardId, wardCode: codeOf.get(wardId) ?? "—", ...v })).sort((x, y) => y.overrides - x.overrides),
  };
}

