import { desc, eq, inArray } from "drizzle-orm";
import {
  erConsents, erDoses, erMedReturns, erEpisodes, erMedIssues, erNotes, erProcedures, erSpecialtyCalls, items, orderItems, orders, services, users,
} from "../../kernel/db/schema";
import { openCriticalsForEncounters } from "../lab";
import { availableQtyByItem, findStoreByCode } from "../materials";
import { listAllergies } from "../patients";
import { bandPerson } from "./bands";
import { ER_SATELLITE_STORE_CODE } from "./care";
import { requireErPermission } from "./core";
import { ErRefusal } from "./errors";
import { ER_CARE } from "./names";
import type { Actor, ErCareView, ErItemOption } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ER lane 3 (#810) — the ER patient screen's reads: one episode's care (notes, orders, the medication record, procedures,
 * consent, calls, open criticals) and the ER store's items. Reads only. NO MONEY (decision 0058): no charge line, no
 * price, no paid word is read here — the contract test walks every key.
 */
export async function readErCare(db: Db, actor: Actor, episodeId: string): Promise<ErCareView> {
  await requireErPermission(db, actor, ER_CARE);
  const e = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, episodeId)))[0];
  if (e === undefined) throw new ErRefusal("episode_not_found");
  const [notes, ords, meds, procs, consents, calls] = await Promise.all([
    db.select().from(erNotes).where(eq(erNotes.episodeId, e.id)).orderBy(desc(erNotes.recordedAt)),
    db.select({ id: orders.id, kind: orders.kind, priority: orders.priority, placedAt: orders.placedAt, name: services.name })
      .from(orders).innerJoin(orderItems, eq(orderItems.orderId, orders.id)).innerJoin(services, eq(services.id, orderItems.serviceId))
      .where(eq(orders.encounterNo, e.episodeNo)).orderBy(desc(orders.placedAt)),
    db.select().from(erMedIssues).where(eq(erMedIssues.episodeId, e.id)).orderBy(desc(erMedIssues.issuedAt)),
    db.select().from(erProcedures).where(eq(erProcedures.episodeId, e.id)).orderBy(desc(erProcedures.performedAt)),
    db.select().from(erConsents).where(eq(erConsents.episodeId, e.id)).orderBy(desc(erConsents.recordedAt)),
    db.select().from(erSpecialtyCalls).where(eq(erSpecialtyCalls.episodeId, e.id)).orderBy(desc(erSpecialtyCalls.calledAt)),
  ]);
  const doses = meds.length === 0 ? [] : await db.select().from(erDoses).where(inArray(erDoses.issueId, meds.map((m) => m.id)));
  const returns = new Map((meds.length === 0 ? [] : await db.select({ issueId: erMedReturns.issueId, kind: erMedReturns.kind }).from(erMedReturns)
    .where(inArray(erMedReturns.issueId, meds.map((m) => m.id)))).map((r) => [r.issueId, r.kind as "returned" | "wasted"] as const));
  const doseOf = new Map(doses.map((d) => [d.issueId, d] as const));
  const people = [...new Set([
    ...notes.flatMap((n) => [n.authorId, ...(n.cosignedBy === null ? [] : [n.cosignedBy])]),
    ...meds.map((m) => m.orderedBy), ...doses.map((d) => d.recordedBy), ...procs.map((p) => p.performedBy),
  ])];
  const names = new Map(people.length === 0 ? [] : (await db.select({ id: users.id, n: users.fullName }).from(users)
    .where(inArray(users.id, people))).map((u) => [u.id, u.n] as const));
  const who = (id: string): string => names.get(id) ?? id;
  const byOrder = new Map<string, { kind: string; priority: string | null; at: Date; tests: string[] }>();
  for (const o of ords) {
    const x = byOrder.get(o.id) ?? { kind: o.kind, priority: o.priority, at: o.placedAt, tests: [] };
    x.tests.push(o.name);
    byOrder.set(o.id, x);
  }
  const p = await bandPerson(db, e.patientId);
  const live = p.unidentified ? [] : (await listAllergies(db, p.id)).filter((a) => a.status === "active");
  const allergyWords = p.unidentified ? ["Allergy: unknown"] : live.length === 0 ? ["Allergy: none recorded"]
    : live.map((a) => `Allergy: ${a.substance}${a.severity === null ? "" : ` (${a.severity})`}`);
  const criticals = await openCriticalsForEncounters(db, [e.episodeNo]);
  return {
    episodeId: e.id, stabilisedAt: e.stabilisedAt?.toISOString() ?? null, allergyWords,
    notes: notes.map((n) => ({
      noteId: n.id, kind: n.kind, text: n.addendum === null ? n.text : `${n.text}\n— ${n.addendum}`, author: who(n.authorId),
      at: n.recordedAt.toISOString(), status: n.status as "signed" | "draft", cosignedBy: n.cosignedBy === null ? null : who(n.cosignedBy),
    })),
    orders: [...byOrder].map(([orderId, o]) => ({ orderId, kind: o.kind, priority: o.priority, tests: o.tests, at: o.at.toISOString() })),
    meds: meds.map((m) => {
      const d = doseOf.get(m.id);
      return {
        issueId: m.id, name: m.name, doseWords: m.doseWords, route: m.route, units: m.units, highAlert: m.highAlert, own: m.itemId === null,
        orderedBy: who(m.orderedBy), verbalPending: m.verbal && m.verbalSignedAt === null, at: m.issuedAt.toISOString(),
        dose: d === undefined ? null : { outcome: d.outcome as "given" | "held" | "refused", at: d.recordedAt.toISOString(), by: who(d.recordedBy), reason: d.reason },
        returned: returns.get(m.id) ?? null,
      };
    }),
    procedures: procs.map((x) => ({ procedureId: x.id, name: x.name, by: who(x.performedBy), at: x.performedAt.toISOString() })),
    consents: consents.map((c) => ({ consentId: c.id, kind: c.kind, about: c.about, signedBy: c.signedBy, at: c.recordedAt.toISOString() })),
    calls: calls.map((c) => ({
      callId: c.id, departmentCode: c.departmentCode, urgency: c.urgency, reason: c.reason, calledAt: c.calledAt.toISOString(),
      answeredAt: c.answeredAt?.toISOString() ?? null, seenAt: c.seenAt?.toISOString() ?? null, callees: c.callees.map((x) => x.name),
    })),
    criticals: criticals.map((c) => ({ callId: c.callId, analyte: c.analyteCode, value: c.value, unit: c.unit, openedAt: c.openedAt.toISOString() })),
  };
}

/** The ER store's items in stock (crash cart, emergency drugs), filtered by name. No price (a clinical screen). */
export async function listErItems(db: Db, actor: Actor, q: string): Promise<ErItemOption[]> {
  await requireErPermission(db, actor, ER_CARE);
  const store = await findStoreByCode(db, ER_SATELLITE_STORE_CODE);
  if (store === undefined) return [];
  const all = await db.select({ id: items.id, name: items.name, highAlert: items.highAlert, lasa: items.lasa }).from(items);
  const wanted = q.trim().toLowerCase();
  const pick = all.filter((i) => wanted === "" || i.name.toLowerCase().includes(wanted)).slice(0, 200);
  const qty = await availableQtyByItem(db, store.id, pick.map((i) => i.id));
  return pick.filter((i) => (qty.get(i.id) ?? 0) > 0).slice(0, 30)
    .map((i) => ({ itemId: i.id, name: i.name, highAlert: i.highAlert, lasa: i.lasa, onHand: qty.get(i.id) ?? 0 }));
}

