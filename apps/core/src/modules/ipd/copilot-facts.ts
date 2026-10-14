import { createHash } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import {
  dietNpo, dietOrders, ipdConsults, ipdEmarActs, ipdEmarDoses, ipdIntakeOutput, ipdNursingNotes, ipdOrders, ipdRounds, ipdVitals,
  orderItems, services,
} from "../../kernel/db/schema";
import { istMinutesOfInstant } from "../roster";
import { mkFact as fact, quantitiesIn, shown } from "./copilot-lines";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";
import type { EwsBand, Fact, FactRecord, VitalParam } from "./copilot-lines";

/**
 * E5.3 (#740) — THE FACT BUILDER. Reads what was RECORDED for one admission in a window `(since, until]` and answers
 * typed facts; each carries the ids of its rows, the numbers and clock times counted or read from them, and the drug and
 * test names the rows hold. Nothing here is inferred and nothing is written (a read): the same builder feeds "Since
 * yesterday" (window = since the doctor's last round), the nurse's SBAR (window = the shift) and the discharge draft.
 *
 * WHAT IS LEFT OUT, AND WHY (DECIDED):
 *  - Lab VALUES: the lab's result reader is not on its module index (and answers no row ids), so a result is a count of
 *    the stay's own lab / imaging order items the department completed in the window, with the test's name. A
 *    restricted item (HIV, PCPNDT-class) is omitted, not counted (the kernel's DD11 rule).
 *  - Money: no charge line, tariff or invoice is read (decision 0058).
 *  - A refused vitals set and an administration later marked entered-in-error are not counted.
 *  - "Abnormal" for one vital sign is judged only for a NEWS2 patient (adult ranges, RCP chart); a child's or a mother's
 *    deterioration is the early-warning band's to say (PEWS / MEOWS), which is age- and context-aware.
 */

export const FACT_ROW_LIMIT = 500;

/** Adult ranges outside which a single reading is "abnormal" here: the NEWS2 chart's score-2-or-more edges. */
const ADULT_RANGE: Record<VitalParam, { low: number; high: number } | null> = {
  temperatureC: { low: 36.1, high: 38.0 }, pulse: { low: 51, high: 110 }, respRate: { low: 12, high: 20 }, systolic: { low: 101, high: 219 },
  spo2: { low: 94, high: 100 }, painScore: { low: 0, high: 6 },
};
const VITAL_PARAMS: readonly VitalParam[] = ["temperatureC", "pulse", "respRate", "systolic", "spo2", "painScore"];
const VITAL_LABEL: Record<VitalParam, string> = { temperatureC: "Temp", pulse: "Pulse", respRate: "RR", systolic: "Systolic", spo2: "SpO2", painScore: "Pain" };
const VITAL_UNIT: Record<VitalParam, string> = { temperatureC: " °C", pulse: "/min", respRate: "/min", systolic: " mmHg", spo2: "%", painScore: "" };

const round1 = (n: number): number => Math.round(n * 10) / 10;
/** "14:05", the hospital's clock (the roster's own offset — `test/ist-clock-parity.test.ts`). */
function istClock(at: Date): string {
  const m = istMinutesOfInstant(at);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export type FactWindow = { since: Date; until: Date };

export type FactSet = { facts: Fact[]; /** Kinds of record whose list was cut at the limit (the NEWEST rows were kept). */ truncated: string[] };

export async function buildFacts(db: Db, a: Pick<AdmissionRow, "id" | "patientId">, w: FactWindow, opts: { actorId?: string; rowLimit?: number } = {}): Promise<Fact[]> {
  return (await buildFactSet(db, a, w, opts)).facts;
}

/**
 * NO SILENT CAP (review of 1f7cc591): every list is read NEWEST FIRST, one row past the limit; a list that was cut is
 * named in `truncated`, and what is kept is the newest (then put back in time order). The caller shows the cut.
 */
export async function buildFactSet(db: Db, a: Pick<AdmissionRow, "id" | "patientId">, w: FactWindow, opts: { actorId?: string; rowLimit?: number } = {}): Promise<FactSet> {
  const out: Fact[] = [];
  const LIMIT = opts.rowLimit ?? FACT_ROW_LIMIT;
  const truncated: string[] = [];
  const newest = <T>(kind: string, rows: T[]): T[] => {
    if (rows.length > LIMIT) { truncated.push(kind); return rows.slice(0, LIMIT).reverse(); }
    return rows.reverse();
  };
  const inWindow = (col: AnyPgColumn) => and(gt(col, w.since), lte(col, w.until));

  // ── vitals and the early-warning band ──
  const sets = await db.select().from(ipdVitals)
    .where(and(eq(ipdVitals.admissionId, a.id), eq(ipdVitals.refused, false), inWindow(ipdVitals.observedAt)))
    .orderBy(desc(ipdVitals.observedAt), desc(ipdVitals.id)).limit(LIMIT + 1).then((r) => newest("vitals", r));
  const scored = sets.filter((v) => v.scoreKind !== null && v.scoreBand !== null && v.scoreValue !== null);
  const adult = scored.length > 0 ? scored[scored.length - 1]!.scoreKind === "news2" : sets.length > 0;
  for (const param of VITAL_PARAMS) {
    const read = sets.flatMap((v) => (v[param] === null ? [] : [{ id: v.id, at: v.observedAt, value: round1(v[param]) }]));
    if (read.length === 0) continue;
    const values = read.map((r) => r.value);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const latest = read[read.length - 1]!.value;
    const range = ADULT_RANGE[param];
    out.push(fact({
      kind: "vital", key: `vital:${param}`, source: "vitals", param, max, min, latest, count: read.length,
      abnormal: adult && range !== null && (max > range.high || min < range.low),
      numbers: [max, min, latest, read.length],
      records: read.map((r) => ({ id: r.id, at: r.at, label: `${VITAL_LABEL[param]} ${shown(r.value)}${VITAL_UNIT[param]} at ${istClock(r.at)}` })),
    }));
  }
  if (scored.length > 0) {
    const before = (await db.select({ band: ipdVitals.scoreBand }).from(ipdVitals)
      .where(and(eq(ipdVitals.admissionId, a.id), eq(ipdVitals.refused, false), lte(ipdVitals.observedAt, w.since)))
      .orderBy(desc(ipdVitals.observedAt), desc(ipdVitals.id)).limit(20)).find((v) => v.band !== null);
    const last = scored[scored.length - 1]!;
    const from = (before?.band ?? (scored.length > 1 ? scored[0]!.scoreBand : null)) as EwsBand | null;
    const rank = (b: string | null): number => ["low", "low_medium", "medium", "high"].indexOf(b ?? "low");
    // The worst set of the window: highest band, then highest score, then the latest.
    const peak = scored.reduce((m, v) => (rank(v.scoreBand) > rank(m.scoreBand) || (rank(v.scoreBand) === rank(m.scoreBand) && v.scoreValue! >= m.scoreValue!) ? v : m));
    out.push(fact({
      kind: "ews", key: "ews", source: "ews", scoreKind: last.scoreKind as "news2", from, to: last.scoreBand as EwsBand,
      latestValue: last.scoreValue!, latestAt: istClock(last.observedAt), sets: scored.length,
      peak: peak.scoreBand as EwsBand, peakValue: peak.scoreValue!, peakAt: istClock(peak.observedAt),
      numbers: [last.scoreValue!, peak.scoreValue!, scored.length], times: [istClock(last.observedAt), istClock(peak.observedAt)],
      records: scored.map((v) => ({ id: v.id, at: v.observedAt, label: `${(v.scoreKind ?? "").toUpperCase()} ${String(v.scoreValue)} (${(v.scoreBand ?? "").replace("_", "–")}) at ${istClock(v.observedAt)}` })),
    }));
  }

  // ── medicines given, missed, refused, held; PRN use ──
  const acts = await db.select({
    id: ipdEmarActs.id, kind: ipdEmarActs.kind, at: ipdEmarActs.at, orderId: ipdEmarActs.orderId, prn: ipdEmarDoses.prn, name: ipdOrders.medicineName,
  }).from(ipdEmarActs).innerJoin(ipdEmarDoses, eq(ipdEmarDoses.id, ipdEmarActs.doseId)).innerJoin(ipdOrders, eq(ipdOrders.id, ipdEmarActs.orderId))
    .where(and(eq(ipdEmarActs.admissionId, a.id), inArray(ipdEmarActs.kind, ["given", "missed", "refused", "held"]), inWindow(ipdEmarActs.at)))
    .orderBy(desc(ipdEmarActs.at), desc(ipdEmarActs.id)).limit(LIMIT + 1).then((r) => newest("doses", r));
  const struck = acts.length === 0 ? new Set<string>() : new Set((await db.select({ id: ipdEmarActs.correctsActId }).from(ipdEmarActs)
    .where(and(eq(ipdEmarActs.kind, "entered_in_error"), inArray(ipdEmarActs.correctsActId, acts.map((x) => x.id))))).map((r) => r.id));
  const live = acts.filter((x) => !struck.has(x.id));
  const actRecord = (x: (typeof live)[number]): FactRecord => ({ id: x.id, at: x.at, label: `${x.name ?? "Medicine"} — ${x.kind} at ${istClock(x.at)}` });
  const of = (kind: string) => live.filter((x) => x.kind === kind);
  const scheduledGiven = of("given").filter((x) => !x.prn);
  const exceptions = [...of("missed"), ...of("refused"), ...of("held")];
  if (live.length > 0) {
    out.push(fact({
      kind: "emar_exceptions", key: "emar:exceptions", source: "emar", missed: of("missed").length, refused: of("refused").length, held: of("held").length,
      given: scheduledGiven.length, numbers: [of("missed").length, of("refused").length, of("held").length, scheduledGiven.length],
      terms: [...new Set(exceptions.flatMap((x) => (x.name === null ? [] : [x.name])))],
      records: (exceptions.length > 0 ? exceptions : scheduledGiven).map(actRecord),
    }));
  }
  const prn = of("given").filter((x) => x.prn);
  if (prn.length > 0) {
    out.push(fact({
      kind: "emar_prn", key: "emar:prn", source: "emar", count: prn.length, numbers: [prn.length],
      terms: [...new Set(prn.flatMap((x) => (x.name === null ? [] : [x.name])))], records: prn.map(actRecord),
    }));
  }

  // ── orders: new, stopped; results the departments completed ──
  const orders = await db.select().from(ipdOrders).where(eq(ipdOrders.admissionId, a.id)).orderBy(desc(ipdOrders.orderedAt), desc(ipdOrders.id)).limit(LIMIT + 1).then((r) => newest("orders", r));
  const serviceIds = [...new Set(orders.flatMap((o) => o.serviceIds ?? []))];
  const testNames = new Map(serviceIds.length === 0 ? [] : (await db.select({ id: services.id, name: services.name }).from(services)
    .where(inArray(services.id, serviceIds))).map((s) => [s.id, s.name] as const));
  const titleOf = (o: (typeof orders)[number]): string => (o.kind === "drug" ? (o.medicineName ?? "Medicine") : (o.serviceIds ?? []).map((s) => testNames.get(s) ?? "Test").join(", "));
  const between = (at: Date | null): boolean => at !== null && at.getTime() > w.since.getTime() && at.getTime() <= w.until.getTime();
  const fresh = orders.filter((o) => between(o.orderedAt) && o.status !== "cancelled");
  if (fresh.length > 0) {
    out.push(fact({
      kind: "orders_new", key: "orders:new", source: "order", count: fresh.length, numbers: [fresh.length], terms: fresh.map(titleOf),
      records: fresh.map((o) => ({ id: o.id, at: o.orderedAt, label: `${titleOf(o)} — ordered at ${istClock(o.orderedAt)}` })),
    }));
  }
  const ended = orders.filter((o) => o.kind === "drug" && between(o.stoppedAt));
  if (ended.length > 0) {
    out.push(fact({
      kind: "orders_stopped", key: "orders:stopped", source: "order", count: ended.length, numbers: [ended.length], terms: ended.map(titleOf),
      records: ended.map((o) => ({ id: o.id, at: o.stoppedAt, label: `${titleOf(o)} — stopped at ${istClock(o.stoppedAt!)}` })),
    }));
  }
  const activeNow = orders.filter((o) => o.status === "active");
  if (fresh.length === 0 && ended.length === 0 && activeNow.length > 0) {
    out.push(fact({
      kind: "orders_active", key: "orders:active", source: "order", count: activeNow.length, numbers: [activeNow.length],
      records: activeNow.map((o) => ({ id: o.id, at: o.orderedAt, label: titleOf(o) })),
    }));
  }
  const placed = orders.filter((o) => o.departmentOrderId !== null && (o.kind === "lab" || o.kind === "imaging"));
  if (placed.length > 0) {
    const kindOf = new Map(placed.map((o) => [o.departmentOrderId!, o.kind as "lab" | "imaging"] as const));
    const done = await db.select({ id: orderItems.id, orderId: orderItems.orderId, at: orderItems.completedAt, name: services.name })
      .from(orderItems).innerJoin(services, eq(services.id, orderItems.serviceId))
      .where(and(inArray(orderItems.orderId, [...kindOf.keys()]), eq(orderItems.restricted, false), inWindow(orderItems.completedAt)))
      .orderBy(desc(orderItems.completedAt), desc(orderItems.id)).limit(LIMIT + 1).then((r) => newest("results", r));
    for (const department of ["lab", "imaging"] as const) {
      const mine = done.filter((d) => kindOf.get(d.orderId) === department);
      if (mine.length === 0) continue;
      out.push(fact({
        kind: "results", key: `results:${department}`, source: department, department, count: mine.length, numbers: [mine.length],
        terms: [...new Set(mine.map((d) => d.name))],
        records: mine.map((d) => ({ id: d.id, at: d.at, label: `${d.name} — reported at ${d.at === null ? "" : istClock(d.at)}` })),
      }));
    }
  }

  // ── nursing notes, intake and output ──
  const notes = await db.select().from(ipdNursingNotes).where(and(eq(ipdNursingNotes.admissionId, a.id), inWindow(ipdNursingNotes.observedAt)))
    .orderBy(desc(ipdNursingNotes.observedAt), desc(ipdNursingNotes.id)).limit(LIMIT + 1).then((r) => newest("notes", r));
  if (notes.length > 0) {
    const flagged = notes.filter((n) => n.category !== "general");
    out.push(fact({
      kind: "notes", key: "notes", source: "note", count: notes.length, flagged: flagged.length, numbers: [notes.length, flagged.length],
      records: (flagged.length > 0 ? flagged : notes).map((n) => ({ id: n.id, at: n.observedAt, label: `${n.category.replace(/_/g, " ")}: ${n.text.slice(0, 160)}` })),
    }));
  }
  const io = await db.select().from(ipdIntakeOutput).where(and(eq(ipdIntakeOutput.admissionId, a.id), inWindow(ipdIntakeOutput.observedAt)))
    .orderBy(desc(ipdIntakeOutput.observedAt), desc(ipdIntakeOutput.id)).limit(LIMIT + 1).then((r) => newest("io", r));
  if (io.length > 0) {
    const inMl = io.filter((e) => e.direction === "in").reduce((s, e) => s + e.volumeMl, 0);
    const outMl = io.filter((e) => e.direction === "out").reduce((s, e) => s + e.volumeMl, 0);
    out.push(fact({
      kind: "io", key: "io", source: "io", inMl, outMl, balanceMl: inMl - outMl, numbers: [inMl, outMl, inMl - outMl],
      records: io.map((e) => ({ id: e.id, at: e.observedAt, label: `${e.direction === "in" ? "In" : "Out"} ${String(e.volumeMl)} ml (${e.kind.replace(/_/g, " ")}) at ${istClock(e.observedAt)}` })),
    }));
  }

  // ── consults, diet and NPO, other doctors' rounds ──
  const consults = await db.select().from(ipdConsults).where(eq(ipdConsults.admissionId, a.id)).orderBy(desc(ipdConsults.requestedAt), desc(ipdConsults.id)).limit(LIMIT + 1).then((r) => newest("consults", r));
  const asked = consults.filter((c) => between(c.requestedAt));
  const answered = consults.filter((c) => between(c.closedAt));
  if (asked.length + answered.length > 0) {
    out.push(fact({
      kind: "consults", key: "consults", source: "consult", asked: asked.length, answered: answered.length, numbers: [asked.length, answered.length],
      records: [
        ...asked.map((c) => ({ id: c.id, at: c.requestedAt, label: `Consult asked (${c.urgency}) at ${istClock(c.requestedAt)}` })),
        ...answered.map((c) => ({ id: c.id, at: c.closedAt, label: `Consult answered at ${istClock(c.closedAt!)}` })),
      ],
    }));
  }
  // The eMAR's own NPO predicate (`emar.ts` `npoAt`): set, not lifted, begun, not ended.
  const npo = (await db.select().from(dietNpo).where(and(
    eq(dietNpo.patientId, a.patientId), isNull(dietNpo.liftedAt), lte(dietNpo.startsAt, w.until), or(isNull(dietNpo.endsAt), gt(dietNpo.endsAt, w.until)),
  )).orderBy(dietNpo.startsAt).limit(1))[0];
  if (npo !== undefined) {
    out.push(fact({
      kind: "npo", key: "npo", source: "diet", since: istClock(npo.startsAt), numbers: [], times: [istClock(npo.startsAt)],
      records: [{ id: npo.id, at: npo.startsAt, label: `NPO from ${istClock(npo.startsAt)} — ${npo.reason.slice(0, 120)}` }],
    }));
  }
  const diet = (await db.select().from(dietOrders).where(and(eq(dietOrders.admissionId, a.id), isNull(dietOrders.endedAt), inWindow(dietOrders.startedAt)))
    .orderBy(desc(dietOrders.startedAt)).limit(1))[0];
  if (diet !== undefined) {
    out.push(fact({
      kind: "diet", key: "diet", source: "diet", code: diet.code, numbers: quantitiesIn(diet.code.replace(/_/g, " ")).numbers,
      records: [{ id: diet.id, at: diet.startedAt, label: `Diet ${diet.code.replace(/_/g, " ")} from ${istClock(diet.startedAt)}` }],
    }));
  }
  const others = (await db.select({ id: ipdRounds.id, at: ipdRounds.seenAt, authorId: ipdRounds.authorId }).from(ipdRounds)
    .where(and(eq(ipdRounds.admissionId, a.id), inWindow(ipdRounds.seenAt))).orderBy(desc(ipdRounds.seenAt), desc(ipdRounds.id)).limit(LIMIT + 1).then((r) => newest("rounds", r)))
    .filter((r) => r.authorId !== opts.actorId);
  if (opts.actorId !== undefined && others.length > 0) {
    out.push(fact({
      kind: "rounds_other", key: "rounds:other", source: "round", count: others.length, numbers: [others.length],
      records: others.map((r) => ({ id: r.id, at: r.at, label: `Round at ${istClock(r.at)}` })),
    }));
  }
  return { facts: out, truncated };
}

/** The fingerprint of the records a draft was built from: any row added, or any number changed, changes it. */
export function factsHash(facts: readonly Fact[]): string {
  const canon = facts.map((f) => [f.key, f.numbers, f.times, f.terms, f.records.map((r) => r.id)]);
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 32);
}
