import { and, desc, eq, gte, inArray, lt, or } from "drizzle-orm";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import { ipdAdmissions, ipdConsults, ipdDischarges, ipdOrders, ipdRounds, resources, services } from "../../kernel/db/schema";
import { getPatientSummaries, listAllergies } from "../patients";
import { holdsPermission, readAdmission, requireIpdPermission } from "./admission-core";
import { IPD_PLACED_STATES, admissionPlace } from "./admission-place";
import { userNames } from "./admissions";
import { consultantChoices } from "./admission-read";
import { allergyWords } from "./bands";
import { IPD_SYSTEM_ACTOR } from "./beds";
import { ageInYears } from "./bed-rules";
import { dayOfStay } from "./daily-totals";
import { isTreatingConsultant } from "./discharge";
import { nowIdentities } from "./now-cards";
import { IpdRefusal } from "./errors";
import { drugFactsOf } from "./orders";
import { IPD_DISCHARGE_DECLARE, IPD_ORDER_PLACE, IPD_ROUND_SIGN } from "./permissions";
import { consultantIdsAmong, mayCosign, onTeam, treatingTeamOf, unitsOn } from "./rounds-team";
import type {
  Actor, IpdAdmissionState, IpdConsultView, IpdCosignItem, IpdOrderView, IpdRoundIdentity, IpdRoundPatient, IpdRoundView, IpdRoundsList,
  IpdRoundsRow, IpdRoundsWhy,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";
import type { IpdOrderRow } from "./orders";

/**
 * E4.2 (#734) — THE ROUNDS SURFACE'S READS (spec §4.9 E). No money anywhere (decision 0058): nothing here reads a charge
 * line, and a round's `visit_outcome` is never selected.
 *
 * THE LIST (spec §4.5A): the doctor's own patients (admitting or covering consultant), their clinical unit's patients
 * (roster parent unit on the IST day), and patients they are consulted on — wherever the patient lies. A patient on a
 * ward that is not the admitting department's is BOARDED and marked with the ward (DECIDED: judged when the admission
 * names its department; the ward's `department` attribute is the bed registry's). Sorted by need: not yet rounded
 * today first, then day-one admissions, then by bed.
 */

type Place = { bedCode: string | null; wardCode: string | null; wardName: string | null; wardDepartment: string | null };

export async function placesOf(db: Db, admissionIds: readonly string[]): Promise<Map<string, Place>> {
  const out = new Map<string, Place>();
  const wardIds = new Map<string, string>();
  for (const id of admissionIds) {
    const p = await admissionPlace(db, id);
    out.set(id, { bedCode: p?.bedCode ?? null, wardCode: p?.wardCode ?? null, wardName: p?.wardName ?? null, wardDepartment: null });
    if (p?.wardId) wardIds.set(id, p.wardId);
  }
  if (wardIds.size > 0) {
    const wards = await db.select({ id: resources.id, attributes: resources.attributes }).from(resources).where(inArray(resources.id, [...new Set(wardIds.values())]));
    const dept = new Map(wards.map((w) => [w.id, ((w.attributes ?? {}) as { department?: string }).department ?? null] as const));
    for (const [aid, wid] of wardIds) out.get(aid)!.wardDepartment = dept.get(wid) ?? null;
  }
  return out;
}

const boardedOf = (a: AdmissionRow, p: Place | undefined): boolean =>
  a.department !== null && p?.wardDepartment != null && p.wardDepartment.toUpperCase() !== a.department.toUpperCase();

export async function identitiesOf(db: Db, reader: Actor, admissions: readonly AdmissionRow[], at: Date): Promise<Map<string, IpdRoundIdentity>> {
  const who = await nowIdentities(db, reader, admissions);
  const people = new Map((await getPatientSummaries(db, reader, admissions.map((a) => a.patientId))).map((p) => [p.requestedId, p] as const));
  const out = new Map<string, IpdRoundIdentity>();
  for (const a of admissions) {
    const id = who.get(a.id)!;
    const p = people.get(a.patientId);
    out.set(a.id, {
      name: id.name, uhid: id.uhid, sealed: id.sealed,
      ageYears: id.sealed || p?.dob == null ? null : ageInYears(p.dob, at),
      sex: id.sealed ? null : (p?.administrativeGender ?? null),
    });
  }
  return out;
}

const ORDER_RANK: Record<string, number> = { none: 0, draft: 1, remote: 2, signed: 3 };

function roundTodayOf(rows: readonly { status: string; mode: string }[]): IpdRoundsRow["roundToday"] {
  if (rows.some((r) => r.status === "signed" && r.mode === "bedside")) return "signed";
  if (rows.some((r) => r.status === "signed")) return "remote";
  return rows.length > 0 ? "draft" : "none";
}

function roundView(r: typeof ipdRounds.$inferSelect, names: Map<string, string>): IpdRoundView {
  return {
    roundId: r.id, admissionId: r.admissionId, authorId: r.authorId, authorName: names.get(r.authorId) ?? r.authorId,
    authorKind: r.authorKind as "consultant" | "resident", mode: r.mode as "bedside" | "remote_review", seenAt: r.seenAt.toISOString(),
    soap: r.soap, status: r.status as "signed" | "awaiting_cosign", source: r.source as IpdRoundView["source"],
    provenance: r.provenance as IpdRoundView["provenance"],
    cosignedByName: r.cosignedBy === null ? null : (names.get(r.cosignedBy) ?? r.cosignedBy), cosignedAt: r.cosignedAt?.toISOString() ?? null,
  };
}

export async function readRoundsList(db: Db, actor: Actor, now: Date = new Date()): Promise<IpdRoundsList> {
  await requireIpdPermission(db, actor, IPD_ROUND_SIGN);
  const date = istDayString(now);
  const units = await unitsOn(db, date);
  const myUnit = units.get(actor.id);
  const mates = new Set(myUnit === undefined ? [] : [...units.entries()].filter(([, t]) => t === myUnit).map(([u]) => u));
  const consulted = new Map((await db.select({ id: ipdConsults.id, admissionId: ipdConsults.admissionId }).from(ipdConsults)
    .where(and(eq(ipdConsults.consultantId, actor.id), eq(ipdConsults.status, "open")))).map((c) => [c.admissionId, c.id] as const));
  // Review of 72f10b68: the list is filtered in SQL — own, covering, the unit's consultants' and consulted admissions only.
  const mine = [eq(ipdAdmissions.consultantId, actor.id), eq(ipdAdmissions.coveringFor, actor.id)];
  if (mates.size > 0) mine.push(inArray(ipdAdmissions.consultantId, [...mates]));
  if (consulted.size > 0) mine.push(inArray(ipdAdmissions.id, [...consulted.keys()]));
  const open = await db.select().from(ipdAdmissions).where(and(inArray(ipdAdmissions.state, [...IPD_PLACED_STATES]), or(...mine)));

  const picked: { a: AdmissionRow; why: IpdRoundsWhy }[] = [];
  for (const a of open) {
    const why: IpdRoundsWhy | null = a.consultantId === actor.id ? "own" : a.coveringFor === actor.id ? "covering"
      : consulted.has(a.id) ? "consult" : mates.has(a.consultantId) ? "unit" : null;
    if (why !== null) picked.push({ a, why });
  }
  const isConsultant = (await consultantIdsAmong(db, [actor.id], now)).has(actor.id);
  const cosignQueue = isConsultant ? await cosignQueueOf(db, actor, units, now) : [];
  if (picked.length === 0) return { asOf: now.toISOString(), isConsultant, rows: [], cosignQueue };

  const ids = picked.map((p) => p.a.id);
  const { start, end } = istDayWindow(now);
  const today = await db.select({ admissionId: ipdRounds.admissionId, status: ipdRounds.status, mode: ipdRounds.mode }).from(ipdRounds)
    .where(and(inArray(ipdRounds.admissionId, ids), gte(ipdRounds.seenAt, start), lt(ipdRounds.seenAt, end)));
  const last = await db.selectDistinctOn([ipdRounds.admissionId], { admissionId: ipdRounds.admissionId, seenAt: ipdRounds.seenAt })
    .from(ipdRounds).where(inArray(ipdRounds.admissionId, ids)).orderBy(ipdRounds.admissionId, desc(ipdRounds.seenAt));
  const lastAt = new Map(last.map((l) => [l.admissionId, l.seenAt] as const));
  const orders = await db.select({ admissionId: ipdOrders.admissionId }).from(ipdOrders)
    .where(and(inArray(ipdOrders.admissionId, ids), eq(ipdOrders.status, "active")));
  const fits = new Map((await db.select({ admissionId: ipdDischarges.admissionId, fitWhen: ipdDischarges.fitWhen }).from(ipdDischarges)
    .where(and(inArray(ipdDischarges.admissionId, ids), eq(ipdDischarges.status, "active")))).map((d) => [d.admissionId, d.fitWhen] as const));
  const places = await placesOf(db, ids);
  const who = await identitiesOf(db, actor, picked.map((p) => p.a), now);
  const names = await userNames(db, picked.map((p) => p.a.consultantId));

  const rows: IpdRoundsRow[] = picked.map(({ a, why }) => {
    const place = places.get(a.id);
    const identity = who.get(a.id)!;
    return {
      admissionId: a.id, admissionNo: identity.sealed ? null : a.admissionNo, patient: identity,
      // A sealed patient's row names no bed or ward (review #767's rule for every IPD list).
      bedCode: identity.sealed ? null : (place?.bedCode ?? null),
      wardCode: identity.sealed ? null : (place?.wardCode ?? null),
      wardName: identity.sealed ? null : (place?.wardName ?? null),
      boarded: boardedOf(a, place), why, consultantName: names.get(a.consultantId) ?? "",
      state: a.state as IpdAdmissionState,
      dayOfStay: Math.max(1, a.admittedAt === null ? 1 : dayOfStay(a.admittedAt, date)),
      roundToday: roundTodayOf(today.filter((t) => t.admissionId === a.id)),
      lastRoundAt: lastAt.get(a.id)?.toISOString() ?? null,
      activeOrders: orders.filter((o) => o.admissionId === a.id).length,
      fitWhen: (fits.get(a.id) ?? null) as IpdRoundsRow["fitWhen"],
      consultId: consulted.get(a.id) ?? null,
    };
  });
  rows.sort((x, y) => (ORDER_RANK[x.roundToday]! - ORDER_RANK[y.roundToday]!) || (Number(y.dayOfStay === 1) - Number(x.dayOfStay === 1))
    || (x.bedCode ?? "~").localeCompare(y.bedCode ?? "~") || x.admissionId.localeCompare(y.admissionId));
  return { asOf: now.toISOString(), isConsultant, rows, cosignQueue };
}

/** Draft rounds this consultant may co-sign: on patients of whom they are the admitting, covering or a unit consultant. */
/** Review of 72f10b68 (DECIDED): drafts on stays that ENDED in the last 7 days still wait here — discharge never waits on a co-sign. */
export const COSIGN_AFTER_EXIT_DAYS = 7;

async function cosignQueueOf(db: Db, actor: Actor, units: Map<string, string>, now: Date): Promise<IpdCosignItem[]> {
  const waiting = await db.select().from(ipdRounds).where(eq(ipdRounds.status, "awaiting_cosign")).orderBy(ipdRounds.seenAt);
  if (waiting.length === 0) return [];
  const since = new Date(now.getTime() - COSIGN_AFTER_EXIT_DAYS * 86_400_000);
  const open = (await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, [...new Set(waiting.map((r) => r.admissionId))])))
    .filter((a) => (IPD_PLACED_STATES as readonly string[]).includes(a.state) || (a.endedAt !== null && a.endedAt.getTime() >= since.getTime()));
  const byId = new Map(open.map((a) => [a.id, a] as const));
  const mine: typeof waiting = [];
  for (const r of waiting) {
    const a = byId.get(r.admissionId);
    if (a === undefined) continue;
    if (mayCosign(await treatingTeamOf(db, a, now, units), actor.id, true)) mine.push(r);
  }
  if (mine.length === 0) return [];
  const admissions = [...new Set(mine.map((r) => r.admissionId))].map((id) => byId.get(id)!);
  const who = await identitiesOf(db, actor, admissions, now);
  const places = await placesOf(db, admissions.map((a) => a.id));
  const names = await userNames(db, mine.map((r) => r.authorId));
  return mine.map((r) => {
    const identity = who.get(r.admissionId)!;
    return { ...roundView(r, names), patient: identity, bedCode: identity.sealed ? null : (places.get(r.admissionId)?.bedCode ?? null) };
  });
}

function orderView(o: IpdOrderRow, names: Map<string, string>, testNames: Map<string, string>): IpdOrderView {
  const drug = drugFactsOf(o);
  const tests = o.kind === "drug" ? null : { department: o.department as "lab" | "imaging", names: (o.serviceIds ?? []).map((s) => testNames.get(s) ?? s) };
  const title = drug !== null
    ? [o.medicineName ?? "", `${String(drug.doseValue)} ${drug.doseUnit}`, drug.route.toUpperCase(), drug.frequency].join(" · ")
    : (tests?.names.join(", ") ?? "");
  const endedAt = o.stoppedAt ?? o.cancelledAt;
  return {
    orderId: o.id, kind: o.kind as IpdOrderView["kind"], status: o.status as IpdOrderView["status"],
    verification: (o.verification ?? null) as IpdOrderView["verification"], title,
    drug: drug === null ? null : { ...drug, medicineName: o.medicineName ?? "" }, tests,
    orderedByName: names.get(o.orderedBy) ?? o.orderedBy, orderedAt: o.orderedAt.toISOString(), issuedAt: o.issuedAt?.toISOString() ?? null,
    endedAt: endedAt?.toISOString() ?? null, endReason: o.stopReason ?? o.cancelReason ?? null, returnOwed: o.returnOwed,
  };
}

export async function readRoundPatient(db: Db, actor: Actor, admissionId: string, now: Date = new Date()): Promise<IpdRoundPatient> {
  await requireIpdPermission(db, actor, IPD_ROUND_SIGN);
  const a = await readAdmission(db, admissionId);
  const date = istDayString(now);
  const team = await treatingTeamOf(db, a, now);
  // Review of 72f10b68: the round page is the treating team's (unit, covering, open consult) — anyone else is refused.
  if (!onTeam(team, actor.id)) throw new IpdRefusal("not_treating_team");
  const iAmConsultant = (await consultantIdsAmong(db, [actor.id], now)).has(actor.id);
  const placed = (IPD_PLACED_STATES as readonly string[]).includes(a.state);
  const rounds = await db.select().from(ipdRounds).where(eq(ipdRounds.admissionId, a.id)).orderBy(desc(ipdRounds.seenAt)).limit(30);
  const orders = await db.select().from(ipdOrders).where(eq(ipdOrders.admissionId, a.id)).orderBy(desc(ipdOrders.orderedAt)).limit(200);
  const consults = await db.select().from(ipdConsults).where(eq(ipdConsults.admissionId, a.id)).orderBy(desc(ipdConsults.requestedAt));
  const serviceIds = [...new Set(orders.flatMap((o) => o.serviceIds ?? []))];
  const testNames = new Map(serviceIds.length === 0 ? [] : (await db.select({ id: services.id, name: services.name }).from(services)
    .where(inArray(services.id, serviceIds))).map((s) => [s.id, s.name] as const));
  const names = await userNames(db, [
    a.consultantId, ...(a.coveringFor === null ? [] : [a.coveringFor]), ...rounds.map((r) => r.authorId),
    ...rounds.flatMap((r) => (r.cosignedBy === null ? [] : [r.cosignedBy])), ...orders.map((o) => o.orderedBy),
    ...consults.flatMap((c) => [c.consultantId, c.requestedBy]),
  ]);
  const identity = (await identitiesOf(db, actor, [a], now)).get(a.id)!;
  const place = (await placesOf(db, [a.id])).get(a.id);
  const fit = (await db.select({ fitWhen: ipdDischarges.fitWhen }).from(ipdDischarges)
    .where(and(eq(ipdDischarges.admissionId, a.id), eq(ipdDischarges.status, "active"))))[0];
  const active = (o: IpdOrderRow): number => (o.status === "active" ? 0 : 1);
  const mayOrder = await holdsPermission(db, actor, IPD_ORDER_PLACE);
  const mayFit = await holdsPermission(db, actor, IPD_DISCHARGE_DECLARE);
  return {
    // Review of 72f10b68: a SEALED patient keeps every safety word (allergies, isolation); only identity is masked —
    // name, UHID, bed, ward, admission number, and the diagnosis and admission time that would identify the stay.
    asOf: now.toISOString(), admissionId: a.id, admissionNo: identity.sealed ? null : a.admissionNo, patient: identity,
    alerts: [...allergyWords(await listAllergies(db, a.patientId)), ...(a.isolation !== "none" ? [`Isolation: ${a.isolation}`] : [])],
    bedCode: identity.sealed ? null : (place?.bedCode ?? null), wardName: identity.sealed ? null : (place?.wardName ?? null),
    boarded: boardedOf(a, place), state: a.state as IpdAdmissionState, admittedAt: identity.sealed ? null : (a.admittedAt?.toISOString() ?? null),
    dayOfStay: Math.max(1, a.admittedAt === null ? 1 : dayOfStay(a.admittedAt, date)),
    provisionalDiagnosis: identity.sealed ? null : a.provisionalDiagnosis, consultantName: names.get(a.consultantId) ?? "",
    coveringName: a.coveringFor === null ? null : (names.get(a.coveringFor) ?? null),
    fitWhen: (fit?.fitWhen ?? null) as IpdRoundPatient["fitWhen"],
    vitals: null,
    rounds: rounds.map((r) => roundView(r, names)),
    orders: [...orders].sort((x, y) => active(x) - active(y)).map((o) => orderView(o, names, testNames)),
    consults: consults.map((c): IpdConsultView => ({
      consultId: c.id, consultantId: c.consultantId, consultantName: names.get(c.consultantId) ?? c.consultantId, question: c.question,
      urgency: c.urgency as "routine" | "urgent", status: c.status as "open" | "closed",
      requestedByName: names.get(c.requestedBy) ?? c.requestedBy, requestedAt: c.requestedAt.toISOString(),
    })),
    can: {
      sign: placed && onTeam(team, actor.id),
      order: placed && mayOrder && onTeam(team, actor.id),
      cosign: mayCosign(team, actor.id, iAmConsultant),
      declareFit: a.state === "admitted" && mayFit && iAmConsultant && isTreatingConsultant(a, actor),
    },
  };
}

/** The consultants a cross-consult can be asked of (the admission desk's own list, read under the rounds permission). */
export async function roundsConsultantChoices(db: Db, actor: Actor): Promise<{ userId: string; name: string; department: string | null }[]> {
  await requireIpdPermission(db, actor, IPD_ROUND_SIGN);
  return (await consultantChoices(db, IPD_SYSTEM_ACTOR)).filter((c) => c.userId !== actor.id);
}
