import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { IPD_INTENTS, newId } from "@hmis/contracts";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissions, ipdEmarNarcoticRegister, ipdNarcoticCountResolutions, ipdNarcoticCounts, ipdOrders } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { holdsPermission, onceIpd, provenanceOf, requireIpdPermission } from "./admission-core";
import { userNames } from "./admissions";
import { IPD_EMAR_NURSE_ROLES, confirmSecondNursePin } from "./emar";
import { narcoticCountMismatch, narcoticCountResolved, narcoticCounted } from "./emar-events";
import { IpdRefusal } from "./errors";
import { balanceKey, r3, wardNarcoticBalances } from "./narcotic-ledger";
import { activeHolders, nursingFallback, shiftOf } from "./nursing";
import { pickWard, wardsWithBeds } from "./nursing-read";
import { IPD_EMAR_GIVE, IPD_EMAR_ISSUE, IPD_EMAR_VIEW } from "./permissions";
import { identitiesOf, placesOf } from "./rounds-read";
import type { Actor, IpdIntentName, IpdNarcoticException, IpdNarcoticLine, IpdNarcoticWard } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * 2026-10-14 — THE WARD NARCOTIC REGISTER (NDPS Act; NABH MOM): the ward's running balance of each controlled drug (the
 * ledger, `narcotic-ledger.ts`), the shift-change count by two nurses and its exceptions.
 *
 * COUNT (`recordNarcoticCount`): the counting nurse (`ipd.emar.give`) sends every drug's counted quantity; the second nurse
 * confirms with THEIR username + PIN at the same phone (the eMAR's second-check throttle, `confirmSecondNursePin`), must hold
 * a nursing role and is never the counting nurse. Every drug the register expects on the ward (expected ≠ 0) must be in the
 * count (`narcotic_count_incomplete`). One row per drug, append-only. A row whose count differs from the register is an
 * EXCEPTION: the nursing supervisor chain (`nursingFallback`) and every active `pharmacy` role holder get a notice, and the
 * event `ipd.narcotic.count_mismatch` is appended. The ward's advisory lock serialises two counts of one ward.
 *
 * RESOLVE (`resolveNarcoticException`): a nursing supervisor / superintendent or a pharmacist (`ipd.emar.issue`) closes an
 * exception with what was found; the counted quantity becomes the agreed opening balance from that count on. Once per
 * count (unique index). Append-only. No money anywhere (decision 0058).
 */
type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
export type NarcoticOpts = { now?: Date };

/** A count this long before a shift began is that shift's handover count (`countDue`). */
export const NARCOTIC_HANDOVER_GRACE_MS = 30 * 60_000;

/** Who closes a count exception besides a pharmacist (DECIDED: the ward's nursing line above the nurse). */
export const IPD_NARCOTIC_RESOLVER_ROLES = ["nursing_supervisor", "nursing_superintendent"];

async function mayResolve(db: Db | Tx, actor: Actor): Promise<boolean> {
  if (actor.type === "system") return false;
  if (await actorHoldsAnyRole(db as Tx, actor.id, IPD_NARCOTIC_RESOLVER_ROLES)) return true;
  return holdsPermission(db as Db, actor, IPD_EMAR_ISSUE);
}

async function wardRow(exec: Db | Tx, wardId: string): Promise<{ id: string; code: string; name: string } | null> {
  const { wards } = await wardsWithBeds(exec as Db);
  return wards.find((w) => w.id === wardId) ?? null;
}

/** Medicine names for drugs a count names but the register has not seen (the order's name, else the id). */
async function medicineNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: ipdOrders.medicineId, name: ipdOrders.medicineName }).from(ipdOrders).where(inArray(ipdOrders.medicineId, [...ids]));
  return new Map(rows.filter((r) => r.id !== null && r.name !== null).map((r) => [r.id!, r.name!] as const));
}

export async function recordNarcoticCount(db: Db, actor: Actor, raw: unknown, opts: NarcoticOpts = {}): Promise<Output<"record_narcotic_count">> {
  const input: Input<"record_narcotic_count"> = IPD_INTENTS.record_narcotic_count.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_GIVE);
  const at = opts.now ?? new Date();
  // The second nurse's PIN is a secret: it is never stored, not even inside the idempotency store's body hash (like
  // `secondCheck`, which keeps no PIN either). A replay of the same key answers the first result.
  const hashed = { ...input, secondNurse: { username: input.secondNurse.username } };
  return onceIpd(db, actor, "record_narcotic_count", input.idempotencyKey, hashed, async () => {
    const ward = await wardRow(db, input.wardId);
    if (ward === null) throw new IpdRefusal("ward_not_found");
    const witnessId = await confirmSecondNursePin(db, actor, input.secondNurse.username, input.secondNurse.pin, at);
    return withTx(db, async (tx) => {
      if (!(await actorHoldsAnyRole(tx, witnessId, IPD_EMAR_NURSE_ROLES))) throw new IpdRefusal("second_nurse_not_nurse");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ipd.narcotic.ward:${ward.id}`}))`);
      const seen = new Set<string>();
      for (const l of input.lines) {
        const k = balanceKey(l.medicineId, l.unit);
        if (seen.has(k)) throw new IpdRefusal("narcotic_count_incomplete", "A drug is counted twice", { duplicate: { medicineId: l.medicineId, unit: l.unit } });
        seen.add(k);
      }
      const balances = await wardNarcoticBalances(tx, ward.id, { cut: at });
      const byKey = new Map(balances.map((b) => [balanceKey(b.medicineId, b.unit), b] as const));
      const missing = balances.filter((b) => b.expected !== 0 && !seen.has(balanceKey(b.medicineId, b.unit)));
      if (missing.length > 0) {
        throw new IpdRefusal("narcotic_count_incomplete", undefined, { missing: missing.map((b) => ({ medicineId: b.medicineId, name: b.name, unit: b.unit })) });
      }
      const unknown = input.lines.filter((l) => !byKey.has(balanceKey(l.medicineId, l.unit))).map((l) => l.medicineId);
      const names = await medicineNames(tx, unknown);
      const roundId = newId();
      const shift = shiftOf(at).key;
      const out: Output<"record_narcotic_count">["lines"] = [];
      const mismatched: { countId: string; name: string; unit: string; expected: number; counted: number; variance: number; medicineId: string }[] = [];
      for (const l of input.lines) {
        const b = byKey.get(balanceKey(l.medicineId, l.unit));
        const expected = b?.expected ?? 0;
        const counted = r3(l.counted);
        const variance = r3(counted - expected);
        const countId = newId();
        const name = b?.name ?? names.get(l.medicineId) ?? l.medicineId;
        await tx.insert(ipdNarcoticCounts).values({
          id: countId, roundId, wardId: ward.id, medicineId: l.medicineId, medicineName: name, unit: l.unit, expectedQty: expected, countedQty: counted,
          variance, shift, countedBy: actor.id, witnessId, at,
        });
        out.push({ countId, medicineId: l.medicineId, unit: l.unit, expected, counted, variance });
        if (variance !== 0) mismatched.push({ countId, name, unit: l.unit, expected, counted, variance, medicineId: l.medicineId });
      }
      if (mismatched.length > 0) {
        const told = [...new Set([...(await nursingFallback(tx)), ...(await activeHolders(tx, "pharmacy"))])].filter((u) => u !== actor.id && u !== witnessId);
        for (const m of mismatched) {
          for (const userId of told) {
            await raiseNoticeIn(tx, {
              userId, kind: "ipd.narcotic.count_mismatch", title: "Narcotic count mismatch",
              body: `${ward.name} · ${m.name}: register ${String(m.expected)}, counted ${String(m.counted)} ${m.unit}`,
              refType: "ipd_narcotic_count", refId: m.countId, sourceKey: `ipd.narcotic.count_mismatch:${m.countId}`, at,
            });
          }
          await appendEvent(tx, narcoticCountMismatch.make({
            payload: {
              countId: m.countId, roundId, wardId: ward.id, medicineId: m.medicineId, expected: m.expected, counted: m.counted, variance: m.variance,
              provenance: provenanceOf(actor),
            },
            actor, correlationId: ward.id, occurredAt: at,
          }));
        }
      }
      await appendEvent(tx, narcoticCounted.make({
        payload: { roundId, wardId: ward.id, drugs: input.lines.length, mismatches: mismatched.length, shift, provenance: provenanceOf(actor) },
        actor, correlationId: ward.id, occurredAt: at,
      }));
      return { roundId, mismatches: mismatched.length, lines: out };
    });
  }, at);
}

export async function resolveNarcoticException(db: Db, actor: Actor, raw: unknown, opts: NarcoticOpts = {}): Promise<Output<"resolve_narcotic_exception">> {
  const input: Input<"resolve_narcotic_exception"> = IPD_INTENTS.resolve_narcotic_exception.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_VIEW);
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "resolve_narcotic_exception", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    if (!(await mayResolve(tx, actor))) throw new IpdRefusal("not_narcotic_resolver");
    const c = (await tx.select().from(ipdNarcoticCounts).where(eq(ipdNarcoticCounts.id, input.countId)))[0];
    if (c === undefined) throw new IpdRefusal("narcotic_count_not_found");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ipd.narcotic.ward:${c.wardId}`}))`);
    if (r3(c.variance) === 0) throw new IpdRefusal("narcotic_count_matched");
    // Review 2026-10-14: segregation of duties — neither nurse of the count closes its own discrepancy (a supervisor who
    // counted is a counting nurse here).
    if (c.countedBy === actor.id || c.witnessId === actor.id) {
      throw new IpdRefusal("not_narcotic_resolver", "A nurse of the count cannot close its discrepancy", { ownCount: true });
    }
    const had = (await tx.select({ id: ipdNarcoticCountResolutions.id }).from(ipdNarcoticCountResolutions).where(eq(ipdNarcoticCountResolutions.countId, c.id)))[0];
    if (had !== undefined) throw new IpdRefusal("narcotic_count_resolved");
    await tx.insert(ipdNarcoticCountResolutions).values({ id: newId(), countId: c.id, resolvedBy: actor.id, note: input.note, at });
    await appendEvent(tx, narcoticCountResolved.make({
      payload: { countId: c.id, wardId: c.wardId, provenance: provenanceOf(actor) },
      actor, correlationId: c.wardId, occurredAt: at,
    }));
    return { countId: c.id, resolvedAt: at.toISOString() };
  }), at);
}

/** The ward narcotic register screen: balances, the open and recent exceptions, the newest register lines. */
export async function readNarcoticWard(db: Db, actor: Actor, opts: { wardId?: string; now?: Date } = {}): Promise<IpdNarcoticWard> {
  await requireIpdPermission(db, actor, IPD_EMAR_VIEW);
  const at = opts.now ?? new Date();
  const shift = shiftOf(at);
  const { wards } = await wardsWithBeds(db);
  const ward = pickWard(wards, opts.wardId);
  const canResolve = await mayResolve(db, actor);
  if (ward === null) return { asOf: at.toISOString(), ward: null, wards, shift: shift.key, countDue: false, canResolve, drugs: [], exceptions: [], lines: [] };
  const balances = await wardNarcoticBalances(db, ward.id);
  const counts = await db.select().from(ipdNarcoticCounts).where(eq(ipdNarcoticCounts.wardId, ward.id)).orderBy(desc(ipdNarcoticCounts.at));
  const resolutions = counts.length === 0 ? [] : await db.select().from(ipdNarcoticCountResolutions)
    .where(inArray(ipdNarcoticCountResolutions.countId, counts.map((c) => c.id)));
  const resolvedBy = new Map(resolutions.map((r) => [r.countId, r] as const));
  const regRows = await db.select({
    id: ipdEmarNarcoticRegister.id, kind: ipdEmarNarcoticRegister.kind, qty: ipdEmarNarcoticRegister.qty, unit: ipdEmarNarcoticRegister.unit,
    at: ipdEmarNarcoticRegister.at, actorId: ipdEmarNarcoticRegister.actorId, witnessId: ipdEmarNarcoticRegister.witnessId,
    admissionId: ipdEmarNarcoticRegister.admissionId, medicineName: ipdOrders.medicineName,
  }).from(ipdEmarNarcoticRegister).innerJoin(ipdOrders, eq(ipdOrders.id, ipdEmarNarcoticRegister.orderId))
    .where(eq(ipdEmarNarcoticRegister.wardId, ward.id))
    .orderBy(desc(sql`coalesce(${ipdEmarNarcoticRegister.recordedAt}, ${ipdEmarNarcoticRegister.at})`), desc(ipdEmarNarcoticRegister.id)).limit(100);
  // Exceptions: every open one, and the resolved ones of the last 7 days.
  const recent = new Date(at.getTime() - 7 * 86_400_000);
  const exc = counts.filter((c) => r3(c.variance) !== 0 && (!resolvedBy.has(c.id) || c.at.getTime() >= recent.getTime())).slice(0, 50);
  const lastCount = new Map<string, (typeof counts)[number]>();
  for (const c of counts) { const k = balanceKey(c.medicineId, c.unit); if (!lastCount.has(k)) lastCount.set(k, c); }
  const names = await userNames(db, [
    ...counts.flatMap((c) => [c.countedBy, c.witnessId]), ...resolutions.map((r) => r.resolvedBy),
    ...regRows.flatMap((r) => [r.actorId, r.witnessId]).filter((x): x is string => x !== null),
  ]);
  const nameOf = (id: string | null): string => (id === null ? "—" : names.get(id) ?? "—");
  const admissionIds = [...new Set(regRows.map((r) => r.admissionId))];
  const admissions = admissionIds.length === 0 ? [] : await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, admissionIds));
  const ids = await identitiesOf(db, actor, admissions, at);
  const places = await placesOf(db, admissionIds);
  const lines: IpdNarcoticLine[] = regRows.map((r) => {
    const who = ids.get(r.admissionId);
    return {
      entryId: r.id, at: r.at.toISOString(), kind: r.kind as IpdNarcoticLine["kind"], medicineName: r.medicineName ?? "—", qty: r.qty, unit: r.unit,
      patient: who?.name ?? "—", bedCode: who?.sealed === true ? null : places.get(r.admissionId)?.bedCode ?? null,
      byName: nameOf(r.actorId), witnessName: r.witnessId === null ? null : nameOf(r.witnessId),
    };
  });
  const exceptions: IpdNarcoticException[] = exc.map((c) => {
    const res = resolvedBy.get(c.id);
    return {
      countId: c.id, at: c.at.toISOString(), medicineName: c.medicineName, unit: c.unit, expected: c.expectedQty, counted: c.countedQty, variance: c.variance,
      byName: nameOf(c.countedBy), witnessName: nameOf(c.witnessId),
      resolution: res === undefined ? null : { at: res.at.toISOString(), byName: nameOf(res.resolvedBy), note: res.note },
    };
  });
  // DECIDED (review 2026-10-14): the handover count is done by the outgoing and incoming nurse together, often just
  // before the hour — a count in the last NARCOTIC_HANDOVER_GRACE_MS before this shift began stands for this shift.
  const countedThisShift = (await db.select({ id: ipdNarcoticCounts.id }).from(ipdNarcoticCounts)
    .where(and(eq(ipdNarcoticCounts.wardId, ward.id), gte(ipdNarcoticCounts.at, new Date(shift.startsAt.getTime() - NARCOTIC_HANDOVER_GRACE_MS)))).limit(1)).length > 0;
  const live = balances.filter((b) => b.expected !== 0 || b.received + b.given + b.wasted + b.returned + b.transferredIn + b.transferredOut !== 0
    || exc.some((c) => c.medicineId === b.medicineId && c.unit === b.unit && !resolvedBy.has(c.id)));
  return {
    asOf: at.toISOString(), ward, wards, shift: shift.key, countDue: live.length > 0 && !countedThisShift, canResolve,
    drugs: live.map((b) => {
      const lc = lastCount.get(balanceKey(b.medicineId, b.unit));
      return {
        medicineId: b.medicineId, name: b.name, unit: b.unit, opening: b.opening, openingAt: b.openingAt?.toISOString() ?? null,
        received: b.received, given: b.given, wasted: b.wasted, returned: b.returned, transferredIn: b.transferredIn, transferredOut: b.transferredOut,
        expected: b.expected,
        lastCount: lc === undefined ? null : { at: lc.at.toISOString(), counted: lc.countedQty, variance: lc.variance, byName: nameOf(lc.countedBy), witnessName: nameOf(lc.witnessId) },
      };
    }),
    exceptions, lines,
  };
}
