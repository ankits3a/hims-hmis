import { and, asc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { ipdRateServiceCode, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissions, ipdBedStays, ipdChargeExceptions, ipdChargeLines, opdDoctors } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { loadPricingContext, priceInvoiceLines, resolveActiveTariffVersion } from "../tariff";
import { admissionAdvisoryLock, provenanceOf, readAdmission, requireIpdPermission } from "./admission-core";
import { ipdChargeableDays, rentClassOf } from "./charge-days";
import { chargeException, chargeReversed, rentPosted, visitRecorded } from "./charge-events";
import { IpdError, IpdRefusal } from "./errors";
import { IPD_CHARGES_REVERSE } from "./manifest";
import type { Actor, IpdBedClass, IpdRateComponent } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { PricedLine, PricingContext } from "../tariff";
import type { AdmissionRow } from "./admission-core";
import type { ChargeStay } from "./charge-days";

/**
 * E2.1 (#725) — THE RUNNING BILL (spec SPEC-ipd-core §4.3): the nightly rent/nursing/RMO posting, the consultant
 * visit seam the rounds lane calls, and reversals. Lines live in `ipd_charge_lines` (append-only, see the schema
 * note); the final bill (E3.2) composes one billing invoice from them.
 *
 * MONEY RULES. Every price comes from the tariff engine (`priceInvoiceLines`) on the admission's LOCKED version
 * (`ipd_admissions.tariff_version_id`; a lower regulated price still wins inside the engine). A rate is MISSING when
 * the version has no item for the service, the item is ₹0, or the service is absent or switched off — a required
 * component (room, nursing, visit) then becomes an `ipd_charge_exceptions` row and posts nothing; an optional one
 * (rmo) is skipped silently; `cross_visit` falls back to the `visit` rate. Nothing is ever guessed.
 */

export const IPD_NIGHTLY_ACTOR: Actor = { type: "system", id: "ipd-nightly-charges" };
/** The daily components the nightly job posts, in posting order. `rmo` is optional. */
export const IPD_DAILY_COMPONENTS = ["room", "nursing", "rmo"] as const satisfies readonly IpdRateComponent[];
const OPTIONAL: ReadonlySet<IpdRateComponent> = new Set(["rmo", "cross_visit"]);
/** Admission states after the stay ended: `ended_at` is the discharge instant. */
export const IPD_ENDED_STATES = ["discharged", "lama", "absconded", "deceased", "transferred_out"] as const;
const ENDED: ReadonlySet<string> = new Set(IPD_ENDED_STATES);
/** How far back the job looks for stays that ended since its last run (a catch-up window wider than any outage). */
export const IPD_ENDED_LOOKBACK_DAYS = 31;
/** Admissions per transaction in the nightly job. */
export const IPD_NIGHTLY_BATCH = 100;

type PricingCache = Map<string, PricingContext>;
type Priced = { ok: true; line: PricedLine; code: string } | { ok: false; code: string };

/** Pricing contexts by version, loaded once per run (the engine is pure; the loader reads). */
async function pricingFor(db: Db, cache: PricingCache, versionId: string, at: Date): Promise<PricingContext> {
  const hit = cache.get(versionId);
  if (hit !== undefined) return hit;
  const ctx = await loadPricingContext(db, { at, tariffVersionId: versionId });
  cache.set(versionId, ctx);
  return ctx;
}

/** Prices one class × component on the locked version, or says the rate is missing. Never a fallback number. */
export function priceComponent(ctx: PricingContext, cls: IpdBedClass, component: IpdRateComponent): Priced {
  const code = ipdRateServiceCode(cls, component);
  const svc = Object.values(ctx.services).find((s) => s.code === code);
  if (svc === undefined || !svc.active) return { ok: false, code };
  const price = ctx.tariff.items[svc.id];
  if (price === undefined || price <= 0) return { ok: false, code };
  const [line] = priceInvoiceLines(ctx, [{ lineId: newId(), serviceId: svc.id, qty: 1 }]);
  return { ok: true, line: line!, code };
}

/** The version this admission prices from: its lock, else (admitted before E2.1) the version in force when admitted. */
async function lockedVersion(db: Db, a: AdmissionRow): Promise<string | null> {
  if (a.tariffVersionId !== null) return a.tariffVersionId;
  if (a.admittedAt === null) return null;
  return (await resolveActiveTariffVersion(db, a.admittedAt))?.versionId ?? null;
}

function dischargedAtOf(a: AdmissionRow): Date | null {
  return ENDED.has(a.state) ? a.endedAt : null;
}

async function staysOf(db: Db | Tx, admissionId: string): Promise<(ChargeStay & { id: string; bedId: string })[]> {
  const rows = await db.select().from(ipdBedStays).where(eq(ipdBedStays.admissionId, admissionId)).orderBy(asc(ipdBedStays.startedAt));
  return rows.map((r) => ({
    id: r.id, bedId: r.bedId, bedClass: r.bedClass as IpdBedClass, billedClass: r.billedClass as IpdBedClass,
    startedAt: r.startedAt, endedAt: r.endedAt,
  }));
}

type LineFacts = {
  admission: AdmissionRow;
  serviceDate: string;
  component: IpdRateComponent;
  billedClass: IpdBedClass | null;
  priced: PricedLine;
  code: string;
  versionId: string;
  source: "ipd.nightly" | "ipd.visit";
  consultantUserId?: string;
  actor: Actor;
  at: Date;
};

/** Inserts a priced line unless its idempotency index already holds one. Returns the new id, or null on a repeat. */
async function insertLine(tx: Tx, f: LineFacts): Promise<string | null> {
  const id = newId();
  const p = f.priced;
  const inserted = await tx.insert(ipdChargeLines).values({
    id, admissionId: f.admission.id, patientId: f.admission.patientId, serviceDate: f.serviceDate, component: f.component,
    billedClass: f.billedClass, serviceId: p.serviceId, serviceCode: f.code, serviceName: p.serviceName,
    tariffVersionId: f.versionId, qty: p.qty, unitPaise: p.unitPaise, grossPaise: p.grossPaise, discountPaise: p.discountPaise,
    taxablePaise: p.taxableBasePaise, cgstPaise: p.gst.cgstPaise, sgstPaise: p.gst.sgstPaise, netPaise: p.netPaise,
    gstRateBps: p.gst.rateBps, gstExempt: p.gst.exempt, source: f.source, consultantUserId: f.consultantUserId ?? null,
    postedBy: f.actor.id, postedAt: f.at,
  }).onConflictDoNothing().returning({ id: ipdChargeLines.id });
  if (inserted.length === 0) return null;
  await tx.update(ipdChargeExceptions).set({ resolvedAt: f.at, resolvedLineId: id })
    .where(and(eq(ipdChargeExceptions.key, exceptionKey(f.admission.id, f.serviceDate, f.component, f.consultantUserId)), isNull(ipdChargeExceptions.resolvedAt)));
  return id;
}

function exceptionKey(admissionId: string, date: string, component: IpdRateComponent, consultantUserId?: string): string {
  return [admissionId, date, component, ...(consultantUserId === undefined ? [] : [consultantUserId])].join(":");
}

/** Records (or re-sees) a charge that could not be posted. The event is raised once, when the row is new. */
async function raiseException(
  tx: Tx, actor: Actor, a: AdmissionRow, x: {
    date: string; component: IpdRateComponent; billedClass: IpdBedClass | null; code: string | null;
    reason: "rate_missing" | "tariff_missing"; versionId: string | null; consultantUserId?: string;
  }, at: Date,
): Promise<void> {
  const key = exceptionKey(a.id, x.date, x.component, x.consultantUserId);
  const fresh = await tx.insert(ipdChargeExceptions).values({
    id: newId(), key, admissionId: a.id, serviceDate: x.date, component: x.component, billedClass: x.billedClass,
    serviceCode: x.code, reason: x.reason, tariffVersionId: x.versionId, firstSeenAt: at, lastSeenAt: at,
  }).onConflictDoUpdate({ target: ipdChargeExceptions.key, set: { lastSeenAt: at } })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  if (fresh[0]?.inserted !== true) return;
  await appendEvent(tx, chargeException.make({
    payload: { admissionId: a.id, serviceDate: x.date, component: x.component, reason: x.reason, serviceCode: x.code, provenance: provenanceOf(actor) },
    actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
  }));
}

export type AdmissionPostResult = { posted: number; rentDays: string[]; exceptions: number };

/**
 * Posts every chargeable day of one admission up to `upToIstDate` (inclusive) that is not yet posted: room, nursing
 * and (when priced) RMO, each with its own service date. Idempotent — the nightly unique index makes a rerun post
 * nothing, and `ipd.charge.rent_posted` goes out once per night with the room line. Under the admission's advisory
 * lock, so it serialises with the bed and admission acts. The final bill (E3.2) calls it with the discharge day.
 */
export async function postAdmissionCharges(
  db: Db, admissionId: string, opts: { upToIstDate: string; now: Date; cache?: PricingCache },
): Promise<AdmissionPostResult> {
  const a = await readAdmission(db, admissionId);
  const result: AdmissionPostResult = { posted: 0, rentDays: [], exceptions: 0 };
  if (a.admittedAt === null) return result;
  const stays = await staysOf(db, a.id);
  const days = ipdChargeableDays(stays, a.admittedAt, dischargedAtOf(a), opts.upToIstDate);
  if (days.length === 0) return result;
  const done = new Set((await db.select({ d: ipdChargeLines.serviceDate, c: ipdChargeLines.component }).from(ipdChargeLines)
    .where(and(eq(ipdChargeLines.admissionId, a.id), eq(ipdChargeLines.source, "ipd.nightly")))).map((r) => `${r.d}:${r.c}`));
  const todo = days.flatMap((d) => IPD_DAILY_COMPONENTS.filter((c) => !done.has(`${d.date}:${c}`)).map((c) => ({ ...d, component: c })));
  if (todo.length === 0) return result;

  const versionId = await lockedVersion(db, a);
  const ctx = versionId === null ? null : await pricingFor(db, opts.cache ?? new Map(), versionId, opts.now);
  const actor = IPD_NIGHTLY_ACTOR;
  await withTx(db, async (tx) => {
    await admissionAdvisoryLock(tx, a.id);
    for (const t of todo) {
      if (ctx === null || versionId === null) {
        if (OPTIONAL.has(t.component)) continue;
        await raiseException(tx, actor, a, { date: t.date, component: t.component, billedClass: t.billedClass, code: null, reason: "tariff_missing", versionId: null }, opts.now);
        result.exceptions += 1;
        continue;
      }
      const priced = priceComponent(ctx, t.billedClass, t.component);
      if (!priced.ok) {
        if (OPTIONAL.has(t.component)) continue;
        await raiseException(tx, actor, a, { date: t.date, component: t.component, billedClass: t.billedClass, code: priced.code, reason: "rate_missing", versionId }, opts.now);
        result.exceptions += 1;
        continue;
      }
      const id = await insertLine(tx, {
        admission: a, serviceDate: t.date, component: t.component, billedClass: t.billedClass, priced: priced.line, code: priced.code,
        versionId, source: "ipd.nightly", actor, at: opts.now,
      });
      if (id === null) continue;
      result.posted += 1;
      if (t.component === "room") {
        result.rentDays.push(t.date);
        await appendEvent(tx, rentPosted.make({
          payload: { admissionId: a.id, rentDate: t.date, chargeLineId: id, provenance: provenanceOf(actor) },
          actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: opts.now,
        }));
      }
    }
  });
  return result;
}

export type NightlyResult = { admissions: number; posted: number; exceptions: number; failed: number };

/**
 * THE NIGHTLY JOB (`kernel/worker/jobs.ts`, daily 00:05 IST; safe at any hour). For every admitted admission still
 * in a bed, and every one whose stay ended within the last `IPD_ENDED_LOOKBACK_DAYS`, posts all chargeable days up to
 * YESTERDAY (IST, from `now`) that are not yet posted — so a night the server missed is caught up with its own service
 * dates on the next run. Admissions are taken in batches; one admission's failure does not stop the others, and the
 * run then throws so the scheduler records it (`sweep.failed`) and retries on its next tick.
 */
export async function postNightlyIpdCharges(db: Db, now: Date): Promise<NightlyResult> {
  const yesterday = istDayString(new Date(now.getTime() - 24 * 3_600_000));
  const since = new Date(now.getTime() - IPD_ENDED_LOOKBACK_DAYS * 24 * 3_600_000);
  const ids = (await db.select({ id: ipdAdmissions.id }).from(ipdAdmissions).where(and(
    isNotNull(ipdAdmissions.admittedAt),
    or(
      inArray(ipdAdmissions.state, ["admitted", "transferring", "fit_declared", "discharging"]),
      and(inArray(ipdAdmissions.state, [...IPD_ENDED_STATES]), gte(ipdAdmissions.endedAt, since)),
    ),
  )).orderBy(asc(ipdAdmissions.admittedAt))).map((r) => r.id);
  const out: NightlyResult = { admissions: ids.length, posted: 0, exceptions: 0, failed: 0 };
  const cache: PricingCache = new Map();
  let firstError: unknown;
  for (let i = 0; i < ids.length; i += IPD_NIGHTLY_BATCH) {
    for (const id of ids.slice(i, i + IPD_NIGHTLY_BATCH)) {
      try {
        const r = await postAdmissionCharges(db, id, { upToIstDate: yesterday, now, cache });
        out.posted += r.posted;
        out.exceptions += r.exceptions;
      } catch (e) {
        out.failed += 1;
        firstError ??= e;
      }
    }
  }
  if (firstError !== undefined) {
    throw new IpdError("charges_post_failed", `the nightly IPD charges failed for ${String(out.failed)} admission(s)`, {
      failed: out.failed, first: firstError instanceof Error ? firstError.message : String(firstError),
    });
  }
  return out;
}

// ═══════════════════════════════════════════ the visit seam ═══════════════════════════════════════════

export type ConsultantVisitInput = {
  admissionId: string;
  consultantUserId: string;
  seenAt: Date;
  source: "rounds_tap";
  /** Who tapped (the consultant, normally). Defaults to the consultant as a person. */
  actor?: Actor;
};
export type ConsultantVisitResult = {
  outcome: "charged" | "repeat" | "not_chargeable" | "rate_missing";
  chargeLineId: string | null;
};

/**
 * THE ROUNDS SEAM — a consultant's own "seen" tap posts the visit (spec §4.3: never typed by billing). Called by the
 * rounds lane inside its own transaction. One chargeable visit per consultant per IST day: the first posts, a repeat
 * posts nothing (the tap is still recorded, `ipd.charge.visit_recorded`). A user who is not an active consultant in
 * the doctor master (`opd_doctors` — residents are not on it) is not charged. A consultant who is not the admitting
 * consultant (or the one covering for them) is a cross-consultation: `cross_visit` if priced, else `visit`. The class
 * is the billed class of the bed held at `seenAt` (a bed with no class rates — emergency, day care — bills at
 * `general`, DECIDED). The answer carries no money; the rounds screen must not show the outcome as money (0058).
 */
export async function postConsultantVisit(tx: Tx, input: ConsultantVisitInput): Promise<ConsultantVisitResult> {
  const actor: Actor = input.actor ?? { type: "user", id: input.consultantUserId };
  const at = input.seenAt;
  await admissionAdvisoryLock(tx, input.admissionId);
  const a = await readAdmission(tx, input.admissionId);
  const ended = dischargedAtOf(a);
  if (a.admittedAt === null || at.getTime() < a.admittedAt.getTime() || (ended !== null && at.getTime() > ended.getTime())) {
    throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
  }
  const date = istDayString(at);
  const record = async (outcome: ConsultantVisitResult["outcome"], chargeLineId: string | null): Promise<ConsultantVisitResult> => {
    await appendEvent(tx, visitRecorded.make({
      payload: {
        admissionId: a.id, consultantUserId: input.consultantUserId, seenAt: at.toISOString(), source: input.source, outcome,
        chargeLineId, provenance: provenanceOf(actor),
      },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { outcome, chargeLineId };
  };

  const consultant = (await tx.select({ id: opdDoctors.id }).from(opdDoctors)
    .where(and(eq(opdDoctors.userId, input.consultantUserId), eq(opdDoctors.active, true))))[0];
  if (consultant === undefined) return record("not_chargeable", null);
  const already = (await tx.select({ id: ipdChargeLines.id }).from(ipdChargeLines).where(and(
    eq(ipdChargeLines.admissionId, a.id), eq(ipdChargeLines.serviceDate, date), eq(ipdChargeLines.source, "ipd.visit"),
    eq(ipdChargeLines.consultantUserId, input.consultantUserId),
  )))[0];
  if (already !== undefined) return record("repeat", null);

  const stays = await staysOf(tx, a.id);
  const held = stays.find((s) => s.startedAt.getTime() <= at.getTime() && (s.endedAt === null || s.endedAt.getTime() > at.getTime()))
    ?? stays.filter((s) => s.startedAt.getTime() <= at.getTime()).at(-1);
  const billedClass: IpdBedClass = (held === undefined ? null : rentClassOf(held.billedClass)) ?? "general";
  const cross = input.consultantUserId !== a.consultantId && input.consultantUserId !== a.coveringFor;

  // The pricing loader reads only; inside the caller's transaction it sees what the transaction sees.
  const db = tx as unknown as Db;
  const versionId = await lockedVersion(db, a);
  if (versionId === null) {
    await raiseException(tx, actor, a, { date, component: "visit", billedClass, code: null, reason: "tariff_missing", versionId: null, consultantUserId: input.consultantUserId }, at);
    return record("rate_missing", null);
  }
  const ctx = await pricingFor(db, new Map(), versionId, at);
  let component: IpdRateComponent = cross ? "cross_visit" : "visit";
  let priced = priceComponent(ctx, billedClass, component);
  if (!priced.ok && component === "cross_visit") {
    component = "visit";
    priced = priceComponent(ctx, billedClass, component);
  }
  if (!priced.ok) {
    await raiseException(tx, actor, a, { date, component, billedClass, code: priced.code, reason: "rate_missing", versionId, consultantUserId: input.consultantUserId }, at);
    return record("rate_missing", null);
  }
  const id = await insertLine(tx, {
    admission: a, serviceDate: date, component, billedClass, priced: priced.line, code: priced.code, versionId,
    source: "ipd.visit", consultantUserId: input.consultantUserId, actor, at,
  });
  return id === null ? record("repeat", null) : record("charged", id);
}

// ═══════════════════════════════════════════ reversal ═══════════════════════════════════════════

/**
 * A wrong line is answered by a NEW line (spec §4.3): every amount negated, `reversal_of` naming the original, a
 * reason. Never an edit (a trigger refuses UPDATE/DELETE on the table). One reversal per line; a reversal cannot be
 * reversed. A reversed nightly line is NOT re-posted by the job (its idempotency key is spent): a corrected charge
 * is the bill desk's act (E2.3). Needs `ipd.charges.reverse`.
 */
export async function reverseChargeLine(
  db: Db, actor: Actor, input: { chargeLineId: string; reason: string }, opts: { now?: Date } = {},
): Promise<{ reversalLineId: string }> {
  await requireIpdPermission(db, actor, IPD_CHARGES_REVERSE);
  const reason = input.reason.trim();
  if (reason.length === 0) throw new IpdError("reversal_reason_required", "a reversal names its reason");
  const at = opts.now ?? new Date();
  const line = (await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.id, input.chargeLineId)))[0];
  if (line === undefined) throw new IpdError("charge_line_not_found", "no such charge line", { chargeLineId: input.chargeLineId });
  if (line.reversalOf !== null) throw new IpdError("charge_line_is_reversal", "a reversal line cannot itself be reversed");
  return withTx(db, async (tx) => {
    await admissionAdvisoryLock(tx, line.admissionId);
    const done = (await tx.select({ id: ipdChargeLines.id }).from(ipdChargeLines).where(eq(ipdChargeLines.reversalOf, line.id)))[0];
    if (done !== undefined) throw new IpdError("charge_line_already_reversed", "this line is already reversed", { reversalLineId: done.id });
    const id = newId();
    await tx.insert(ipdChargeLines).values({
      ...line, id, source: "ipd.reversal", reversalOf: line.id, reason,
      unitPaise: -line.unitPaise, grossPaise: -line.grossPaise, discountPaise: -line.discountPaise, taxablePaise: -line.taxablePaise,
      cgstPaise: -line.cgstPaise, sgstPaise: -line.sgstPaise, netPaise: -line.netPaise, postedBy: actor.id, postedAt: at,
    });
    await appendEvent(tx, chargeReversed.make({
      payload: { admissionId: line.admissionId, chargeLineId: line.id, reversalLineId: id, provenance: provenanceOf(actor) },
      actor, correlationId: line.admissionId, patientId: line.patientId, encounterId: line.admissionId, occurredAt: at,
    }));
    return { reversalLineId: id };
  });
}

