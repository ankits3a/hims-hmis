import { and, asc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { dietEntry } from "@hmis/contracts";
import { dietConsults, dietMealLines, dietMealLists, dietNpo, dietOrders, patientAllergies, resources } from "../../kernel/db/schema";
import { allergyWords, nowIdentities, placedCensus } from "../ipd";
import { linesOfLists, listsOfSlot } from "./lists";
import { mealRounds, nextSlot, slotOf } from "./rounds";
import { npoCovering, trayFor } from "./trays";
import { holds } from "./guard";
import { DIET_CLINICAL_VIEW } from "./names";
import type {
  Actor, DietCode, DietConsultView, DietKitchenBoardView, DietLineView, DietListState, DietListView, DietMeal, DietNpoView,
  DietOrderView, DietPatient, DietPreference, DietProvenance, DietSource, DietWard, DietWardSheetView, DietWithdrawReason,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { NowIdentity, PlacedPatient } from "../ipd";
import type { MealSlot } from "./rounds";

/**
 * THE READS: the kitchen board (every ward's list for one meal: built, or a live preview before the cut-off), one list
 * (the print), the ward diet sheet, the dietician's consult queue. NO MONEY on any of them (decision 0058).
 *
 * IDENTITY: names come from ipd's `nowIdentities` for the READER — a sealed patient is the alias (or "Sealed patient")
 * with no UHID; a confidential one is the alias for a reader without the confidential permission. The BED stays on a
 * sealed patient's tray (DECIDED: the tray must reach the bed; a bed is a place, not an identity). Allergies are shown
 * for everyone — a sealed patient's peanut allergy matters more than their name.
 */
type LineRow = typeof dietMealLines.$inferSelect;
type ListRow = typeof dietMealLists.$inferSelect;

async function identities(db: Db, reader: Actor, pairs: readonly { id: string; patientId: string }[]): Promise<Map<string, NowIdentity>> {
  const uniq = [...new Map(pairs.map((p) => [p.id, p] as const)).values()];
  return nowIdentities(db, reader, uniq);
}

function patientOf(who: Map<string, NowIdentity>, admissionId: string): DietPatient {
  const id = who.get(admissionId);
  if (id === undefined) return { name: "—", uhid: "", sealed: false };
  return { name: id.name, uhid: id.sealed ? "" : id.uhid, sealed: id.sealed };
}

async function allergiesOf(db: Db, patientIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (patientIds.length === 0) return out;
  const rows = await db.select({ patientId: patientAllergies.patientId, substance: patientAllergies.substance, severity: patientAllergies.severity, status: patientAllergies.status })
    .from(patientAllergies).where(inArray(patientAllergies.patientId, [...new Set(patientIds)]));
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.patientId, [...(by.get(r.patientId) ?? []), r]);
  for (const id of new Set(patientIds)) out.set(id, allergyWords(by.get(id) ?? []).filter((w) => w !== "Allergy: none recorded"));
  return out;
}

function lineView(l: LineRow, who: Map<string, NowIdentity>, allergies: Map<string, string[]>): DietLineView {
  return {
    id: l.id, admissionId: l.admissionId, bedCode: l.bedCode, patient: patientOf(who, l.admissionId), code: l.code as DietCode,
    label: dietEntry(l.code as DietCode).label, preference: l.preference as DietPreference, tube: l.tube,
    allergies: allergies.get(l.patientId) ?? [], defaulted: l.defaulted, late: l.late, state: l.state as "active" | "withdrawn",
    withdrawnReason: l.withdrawnReason as DietWithdrawReason | null, served: l.served as "delivered" | "refused" | null,
    changedAt: l.changedAt?.toISOString() ?? null, onLoad: l.onLoad,
  };
}

function stateOf(l: ListRow): DietListState {
  if (l.deliveredAt !== null) return "delivered";
  if (l.dispatchedAt !== null) return "dispatched";
  if (l.printedAt !== null) return "printed";
  return "built";
}

function countsOf(lines: readonly DietLineView[]): DietListView["counts"] {
  const byDiet: Partial<Record<DietCode, number>> = {};
  let trays = 0; let npo = 0; let withdrawn = 0; let late = 0;
  for (const l of lines) {
    if (l.state === "active") {
      trays += 1;
      byDiet[l.code] = (byDiet[l.code] ?? 0) + 1;
      if (l.late) late += 1;
    } else if (l.withdrawnReason === "npo") npo += 1;
    else withdrawn += 1;
  }
  return { trays, npo, withdrawn, late, byDiet };
}

function listView(l: ListRow, wardName: string, lines: DietLineView[]): DietListView {
  return {
    id: l.id, wardId: l.wardId, wardName, meal: l.meal as DietMeal, date: l.serviceDate, serveAt: l.serveAt.toISOString(), state: stateOf(l),
    builtAt: l.builtAt.toISOString(), printedAt: l.printedAt?.toISOString() ?? null, lastPrintedAt: l.lastPrintedAt?.toISOString() ?? null,
    changedSincePrint: l.changedSincePrint, dispatchedAt: l.dispatchedAt?.toISOString() ?? null,
    deliveredAt: l.deliveredAt?.toISOString() ?? null, counts: countsOf(lines), lines,
  };
}

async function wardNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  return new Map((await db.select({ id: resources.id, name: resources.name }).from(resources).where(inArray(resources.id, [...new Set(ids)]))).map((r) => [r.id, r.name] as const));
}

/** Before the build: what the list WOULD be (the same tray rules), so the kitchen can plan. Ids are `preview:<admission>`. */
async function previewLines(db: Db, people: readonly PlacedPatient[], slot: MealSlot, who: Map<string, NowIdentity>, allergies: Map<string, string[]>): Promise<DietLineView[]> {
  const out: DietLineView[] = [];
  for (const p of people) {
    const npo = await npoCovering(db, p.patientId, slot.serveAt);
    const tray = await trayFor(db, p.admissionId);
    out.push({
      id: `preview:${p.admissionId}`, admissionId: p.admissionId, bedCode: p.bedCode, patient: patientOf(who, p.admissionId), code: tray.code,
      label: dietEntry(tray.code).label, preference: tray.preference, tube: tray.tube, allergies: allergies.get(p.patientId) ?? [],
      defaulted: tray.defaulted, late: false, state: npo === null ? "active" : "withdrawn", withdrawnReason: npo === null ? null : "npo", served: null,
      changedAt: null, onLoad: false,
    });
  }
  return out;
}

export async function kitchenBoard(db: Db, reader: Actor, now: Date = new Date(), q: { meal?: DietMeal; date?: string } = {}): Promise<DietKitchenBoardView> {
  const rounds = await mealRounds(db);
  const round = q.meal === undefined ? undefined : rounds.find((r) => r.meal === q.meal);
  const slot = round !== undefined && q.date !== undefined ? slotOf(round, q.date) : nextSlot(rounds, now);
  const stored = await listsOfSlot(db, slot.date, slot.meal);
  const storedLines = await linesOfLists(db, stored.map((l) => l.id));
  const census = await placedCensus(db);
  const builtWards = new Set(stored.map((l) => l.wardId));
  const pending = census.filter((p) => !builtWards.has(p.wardId));
  const who = await identities(db, reader, [
    ...storedLines.map((l) => ({ id: l.admissionId, patientId: l.patientId })), ...pending.map((p) => ({ id: p.admissionId, patientId: p.patientId })),
  ]);
  const allergies = await allergiesOf(db, [...storedLines.map((l) => l.patientId), ...pending.map((p) => p.patientId)]);
  const names = await wardNames(db, stored.map((l) => l.wardId));
  const lists: DietListView[] = stored.map((l) => listView(l, names.get(l.wardId) ?? "—",
    storedLines.filter((x) => x.listId === l.id).map((x) => lineView(x, who, allergies))));
  const byWard = new Map<string, PlacedPatient[]>();
  for (const p of pending) byWard.set(p.wardId, [...(byWard.get(p.wardId) ?? []), p]);
  for (const [wardId, people] of byWard) {
    const lines = await previewLines(db, people, slot, who, allergies);
    lists.push({
      id: null, wardId, wardName: people[0]!.wardName, meal: slot.meal, date: slot.date, serveAt: slot.serveAt.toISOString(), state: "preview",
      builtAt: null, printedAt: null, lastPrintedAt: null, changedSincePrint: false, dispatchedAt: null, deliveredAt: null, counts: countsOf(lines), lines,
    });
  }
  lists.sort((a, b) => a.wardName.localeCompare(b.wardName));
  return {
    serverNow: now.toISOString(), meal: slot.meal, date: slot.date, cutoffAt: slot.cutoffAt.toISOString(), serveAt: slot.serveAt.toISOString(),
    lists, rounds,
  };
}

/** One built list, for the print (A4 and the tray labels). */
export async function readList(db: Db, reader: Actor, listId: string): Promise<DietListView | null> {
  const l = (await db.select().from(dietMealLists).where(eq(dietMealLists.id, listId)))[0];
  if (l === undefined) return null;
  const lines = await linesOfLists(db, [l.id]);
  const who = await identities(db, reader, lines.map((x) => ({ id: x.admissionId, patientId: x.patientId })));
  const allergies = await allergiesOf(db, lines.map((x) => x.patientId));
  const names = await wardNames(db, [l.wardId]);
  return listView(l, names.get(l.wardId) ?? "—", lines.map((x) => lineView(x, who, allergies)));
}

/**
 * Review item 14 (DECIDED): a reader without `diet.clinical.view` (the kitchen) sees the TRAY only — no order note, no
 * NPO reason (it reads "NPO"), and provenance with the source but no person id and no source reference.
 */
const prov = (clinical: boolean, source: string, by: string, at: Date, ref: string | null = null): DietProvenance =>
  ({ source: source as DietSource, by: clinical ? by : "", at: at.toISOString(), ref: clinical ? ref : null });

function orderView(o: typeof dietOrders.$inferSelect, clinical = true): DietOrderView {
  return {
    id: o.id, code: o.code as DietCode, label: dietEntry(o.code as DietCode).label, preference: o.preference as DietPreference,
    tubeVolumeMl: o.tubeVolumeMl, tubeEveryHours: o.tubeEveryHours, note: clinical ? o.note : null, startedAt: o.startedAt.toISOString(),
    provenance: prov(clinical, o.source, o.orderedBy, o.startedAt),
  };
}

function npoView(n: typeof dietNpo.$inferSelect, now: Date, clinical = true): DietNpoView {
  return {
    id: n.id, startsAt: n.startsAt.toISOString(), endsAt: n.endsAt?.toISOString() ?? null, reason: clinical ? n.reason : "NPO",
    provenance: prov(clinical, n.source, n.setBy, n.setAt, n.sourceRef), live: n.startsAt.getTime() <= now.getTime(),
  };
}

export async function wardSheet(db: Db, reader: Actor, wardId: string, now: Date = new Date()): Promise<DietWardSheetView> {
  const people = await placedCensus(db, wardId);
  const names = await wardNames(db, [wardId]);
  const admissionIds = people.map((p) => p.admissionId);
  const patientIds = people.map((p) => p.patientId);
  const orders = admissionIds.length === 0 ? [] : await db.select().from(dietOrders).where(and(inArray(dietOrders.admissionId, admissionIds), isNull(dietOrders.endedAt)));
  const npos = patientIds.length === 0 ? [] : await db.select().from(dietNpo).where(and(
    inArray(dietNpo.patientId, patientIds), isNull(dietNpo.liftedAt), or(isNull(dietNpo.endsAt), gt(dietNpo.endsAt, now)),
  )).orderBy(asc(dietNpo.startsAt));
  const consults = admissionIds.length === 0 ? [] : await db.select({ a: dietConsults.admissionId }).from(dietConsults)
    .where(and(inArray(dietConsults.admissionId, admissionIds), eq(dietConsults.state, "open")));
  const slot = nextSlot(await mealRounds(db), now);
  const list = (await db.select().from(dietMealLists).where(and(
    eq(dietMealLists.wardId, wardId), eq(dietMealLists.serviceDate, slot.date), eq(dietMealLists.meal, slot.meal),
  )))[0];
  const lines = list === undefined ? [] : await linesOfLists(db, [list.id]);
  const who = await identities(db, reader, people.map((p) => ({ id: p.admissionId, patientId: p.patientId })));
  const allergies = await allergiesOf(db, patientIds);
  const consultSet = new Set(consults.map((c) => c.a));
  const clinical = await holds(db, reader, DIET_CLINICAL_VIEW);
  return {
    serverNow: now.toISOString(), wardId, wardName: names.get(wardId) ?? "—",
    next: { meal: slot.meal, date: slot.date, listId: list?.id ?? null, state: list === undefined ? "preview" : stateOf(list) },
    rows: people.map((p) => {
      const o = orders.find((x) => x.admissionId === p.admissionId);
      const line = lines.find((x) => x.admissionId === p.admissionId);
      return {
        admissionId: p.admissionId, bedCode: p.bedCode, patient: patientOf(who, p.admissionId), order: o === undefined ? null : orderView(o, clinical),
        // Review item 15: every live NPO (now or ahead), each its own row to lift.
        npos: npos.filter((x) => x.patientId === p.patientId).map((x) => npoView(x, now, clinical)), allergies: allergies.get(p.patientId) ?? [], consultOpen: consultSet.has(p.admissionId),
        nextLine: line === undefined ? null : lineView(line, who, allergies),
      };
    }),
  };
}

export async function consultQueue(db: Db, reader: Actor, now: Date = new Date()): Promise<DietConsultView[]> {
  const open = await db.select().from(dietConsults).where(eq(dietConsults.state, "open")).orderBy(asc(dietConsults.requestedAt)).limit(200);
  if (open.length === 0) return [];
  const census = new Map((await placedCensus(db)).map((p) => [p.admissionId, p] as const));
  const who = await identities(db, reader, open.map((c) => ({ id: c.admissionId, patientId: c.patientId })));
  const orders = await db.select().from(dietOrders).where(and(inArray(dietOrders.admissionId, open.map((c) => c.admissionId)), isNull(dietOrders.endedAt)));
  return open.map((c) => {
    const place = census.get(c.admissionId);
    const o = orders.find((x) => x.admissionId === c.admissionId);
    const pat = patientOf(who, c.admissionId);
    return {
      id: c.id, admissionId: c.admissionId, patient: pat, bedCode: place?.bedCode ?? null, wardName: place?.wardName ?? null, reason: c.reason,
      requestedAt: c.requestedAt.toISOString(), waitMinutes: Math.max(0, Math.floor((now.getTime() - c.requestedAt.getTime()) / 60_000)),
      order: o === undefined ? null : orderView(o),
    };
  });
}

export async function dietWards(db: Db): Promise<DietWard[]> {
  return db.select({ id: resources.id, code: resources.code, name: resources.name }).from(resources)
    .where(and(inArray(resources.kind, ["ward", "hall"]), ne(resources.status, "retired"))).orderBy(asc(resources.name));
}

