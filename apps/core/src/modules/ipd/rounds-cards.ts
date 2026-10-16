import { and, eq, gt, inArray, isNull, max } from "drizzle-orm";
import { ipdEmarAllergyFlags, ipdOrders, ipdRounds, patientAllergies } from "../../kernel/db/schema";
import { nowIdentities, nowSubtitle, rankNowRows } from "./now-cards";
import { myInpatients } from "./rounds-read";
import type { DeskCard, DeskProviderCtx } from "../../kernel/desk/types";
import type { NowRow } from "./now-cards";

/**
 * The DOCTOR's allergy Now card (E5.1 pattern; owner 2026-10-14 "the remaining small items"):
 *
 *   ipd.allergy_flags  `ipd.round.sign`  the doctor's inpatients (the rounds list's own set: own, covering, unit,
 *                                        consulted) with an allergy matter the doctor has not answered:
 *                                        - an open eMAR allergy flag on an ACTIVE drug order with no doctor decision yet
 *                                          (the decision is taken on the round page — stop, or continue with a reason);
 *                                        - an allergy recorded since THIS doctor's last signed or drafted round on the stay
 *                                          (no round yet: since admission).
 *
 * A flag the doctor already decided waits on the pharmacist, not the doctor: no row. A row opens the round page. No drug,
 * allergen or money words on a desk row (read over a shoulder; decision 0058); a sealed patient shows no UHID and no bed
 * (`nowIdentities`). Hot while a flag waits on the doctor (the give is refused until then); a new allergy alone is warn.
 */
const minutesSince = (from: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));

export async function allergyFlagsCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const { db, now } = ctx;
  const { picked } = await myInpatients(db, ctx.actor.id, now);
  if (picked.length === 0) return [];
  const admissions = picked.map((p) => p.a);
  const ids = admissions.map((a) => a.id);

  const flags = await db.select({ admissionId: ipdEmarAllergyFlags.admissionId, orderId: ipdEmarAllergyFlags.orderId, raisedAt: ipdEmarAllergyFlags.raisedAt }).from(ipdEmarAllergyFlags)
    .innerJoin(ipdOrders, eq(ipdOrders.id, ipdEmarAllergyFlags.orderId))
    .where(and(inArray(ipdEmarAllergyFlags.admissionId, ids), isNull(ipdEmarAllergyFlags.resolvedAt), isNull(ipdEmarAllergyFlags.doctorDecision),
      eq(ipdOrders.status, "active")));

  const lastRound = new Map((await db.select({ admissionId: ipdRounds.admissionId, at: max(ipdRounds.createdAt) }).from(ipdRounds)
    .where(and(inArray(ipdRounds.admissionId, ids), eq(ipdRounds.authorId, ctx.actor.id))).groupBy(ipdRounds.admissionId))
    .map((r) => [r.admissionId, r.at] as const));
  const earliest = admissions.reduce<Date>((m, a) => {
    const since = lastRound.get(a.id) ?? a.admittedAt ?? a.requestedAt;
    return since < m ? since : m;
  }, now);
  const allergies = await db.select({ patientId: patientAllergies.patientId, recordedAt: patientAllergies.recordedAt }).from(patientAllergies)
    .where(and(inArray(patientAllergies.patientId, [...new Set(admissions.map((a) => a.patientId))]), eq(patientAllergies.status, "active"),
      gt(patientAllergies.recordedAt, earliest)));

  const subjects: { a: (typeof admissions)[number]; flagged: number; fresh: number; since: Date }[] = [];
  for (const a of admissions) {
    const mine = flags.filter((f) => f.admissionId === a.id);
    // A flag is per (order, allergy): the doctor decides per ORDER, so the row counts orders.
    const orders = new Set(mine.map((f) => f.orderId)).size;
    const after = lastRound.get(a.id) ?? a.admittedAt ?? a.requestedAt;
    const fresh = allergies.filter((x) => x.patientId === a.patientId && x.recordedAt > after && x.recordedAt <= now);
    if (mine.length === 0 && fresh.length === 0) continue;
    const since = [...mine.map((f) => f.raisedAt), ...fresh.map((x) => x.recordedAt)].reduce((m, d) => (d < m ? d : m));
    subjects.push({ a, flagged: orders, fresh: fresh.length, since });
  }
  if (subjects.length === 0) return [];
  const who = await nowIdentities(db, ctx.reader, subjects.map((s) => s.a));
  const rows: NowRow[] = subjects.map(({ a, flagged, fresh, since }) => {
    const words = [
      flagged > 0 ? `${String(flagged)} ${flagged === 1 ? "order" : "orders"} to decide` : null,
      fresh > 0 ? `${String(fresh)} new ${fresh === 1 ? "allergy" : "allergies"}` : null,
    ].filter((x): x is string => x !== null).join(" · ");
    return {
      id: a.id, badge: "!", title: who.get(a.id)!.name, subtitle: nowSubtitle(who.get(a.id)!, words), action: "Review",
      href: `/ipd/rounds/${a.id}`, severity: flagged > 0 ? "hot" : "warn", waitMinutes: minutesSince(since, now),
    };
  });
  return [{ key: "ipd.allergy_flags", band: "now", titleKey: "desk.ipdAllergyFlags.title", rows: rankNowRows(rows).slice(0, 5) }];
}
