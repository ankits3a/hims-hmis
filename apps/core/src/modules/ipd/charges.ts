import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { ipdRateServiceCode, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissions, ipdBedStays, ipdChargeExceptions, ipdChargeLines, opdDoctors } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { TariffError, loadPricingContext, priceInvoiceLines, resolveActiveTariffVersion } from "../tariff";
import { admissionAdvisoryLock, provenanceOf, readAdmission, requireIpdPermission } from "./admission-core";
import { ipdChargeableDays, rentClassOf } from "./charge-days";
import { applyClassChanges, classChangesOf } from "./class-change";
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
  const stays = rows.map((r) => ({
    id: r.id, bedId: r.bedId, bedClass: r.bedClass as IpdBedClass, billedClass: r.billedClass as IpdBedClass,
    startedAt: r.startedAt, endedAt: r.endedAt,
  }));
  // E3.1 (#729): a consented class change in place splits its stay at the next noon (class-change.ts).
  return applyClassChanges(stays, await classChangesOf(db, admissionId));
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
  visitSeq?: number;
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
    gstRateBps: p.gst.rateBps, gstExempt: p.gst.exempt, source: f.source, consultantUserId: f.consultantUserId ?? null, visitSeq: f.visitSeq ?? null,
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

/** The IST day an ended admission's posting is complete through: its discharge day (posted or free). */
function lastDayOf(a: AdmissionRow, upToIstDate: string): string {
  const ended = dischargedAtOf(a);
  if (ended === null) return upToIstDate;
  const d = istDayString(ended);
  return d < upToIstDate ? d : upToIstDate;
}

/**
 * Posts every chargeable day of one admission up to `upToIstDate` (inclusive) that is not yet posted: room, nursing
 * and (when priced) RMO, each with its own service date. Idempotent — the nightly unique index makes a rerun post
 * nothing, and `ipd.charge.rent_posted` goes out once per night with the room line. The admission and its stays are
 * RE-READ under the admission's advisory lock before the days are computed (review #756 item 4), so a bed act that
 * commits meanwhile is either wholly before or wholly after this post. A null tariff pin is resolved once and
 * PERSISTED in the same transaction (item 6) — never re-resolved per night. The final bill (E3.2) calls it with the
 * discharge day.
 */
export async function postAdmissionCharges(
  db: Db, admissionId: string, opts: { upToIstDate: string; now: Date; cache?: PricingCache },
): Promise<AdmissionPostResult> {
  const result: AdmissionPostResult = { posted: 0, rentDays: [], exceptions: 0 };
  const cache = opts.cache ?? new Map<string, PricingContext>();
  // A read outside the lock only to load the pricing context (the loader takes Db, not Tx); re-checked under the lock.
  const pre = await readAdmission(db, admissionId);
  if (pre.admittedAt === null) return result;
  const preVersion = await lockedVersion(db, pre);
  if (preVersion !== null) await pricingFor(db, cache, preVersion, opts.now);
  const actor = IPD_NIGHTLY_ACTOR;
  await withTx(db, async (tx) => {
    await admissionAdvisoryLock(tx, admissionId);
    let a = await readAdmission(tx, admissionId);
    const admittedAt = a.admittedAt;
    if (admittedAt === null) return;
    const versionId = await lockedVersion(tx as unknown as Db, a);
    if (a.tariffVersionId === null && versionId !== null) {
      await tx.update(ipdAdmissions).set({ tariffVersionId: versionId }).where(eq(ipdAdmissions.id, a.id));
      a = { ...a, tariffVersionId: versionId };
    }
    const ctx = versionId === null ? null : await pricingFor(tx as unknown as Db, cache, versionId, opts.now);
    const stays = await staysOf(tx, a.id);
    const days = ipdChargeableDays(stays, admittedAt, dischargedAtOf(a), opts.upToIstDate);
    const done = new Set((await tx.select({ d: ipdChargeLines.serviceDate, c: ipdChargeLines.component }).from(ipdChargeLines)
      .where(and(eq(ipdChargeLines.admissionId, a.id), eq(ipdChargeLines.source, "ipd.nightly")))).map((r) => `${r.d}:${r.c}`));
    const todo = days.flatMap((d) => IPD_DAILY_COMPONENTS.filter((c) => !done.has(`${d.date}:${c}`)).map((c) => ({ ...d, component: c })));
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
    const through = lastDayOf(a, opts.upToIstDate);
    if (a.chargesPostedThrough === null || a.chargesPostedThrough < through) {
      await tx.update(ipdAdmissions).set({ chargesPostedThrough: through }).where(eq(ipdAdmissions.id, a.id));
    }
    // A clean run clears an earlier posting failure.
    await tx.update(ipdChargeExceptions).set({ resolvedAt: opts.now })
      .where(and(eq(ipdChargeExceptions.key, failureKey(a.id)), isNull(ipdChargeExceptions.resolvedAt)));
  });
  return result;
}

export type NightlyResult = { admissions: number; posted: number; exceptions: number; failed: number; quarantined: number };

/** Consecutive failures after which the job stops trying an admission until a person resolves it. */
export const IPD_QUARANTINE_AFTER = 3;
const failureKey = (admissionId: string): string => `${admissionId}:posting_failed`;

/**
 * A DOMAIN failure belongs to one admission (bad data, a tariff the engine refuses, a constraint) and is quarantined;
 * anything else — the database unreachable, a timeout, a deadlock — is INFRASTRUCTURE and fails the run so the scheduler
 * retries. Postgres classes 22 (data) and 23 (integrity) are domain; every other SQLSTATE is infrastructure.
 */
function domainErrorCode(e: unknown): string | null {
  if (e instanceof IpdError || e instanceof IpdRefusal || e instanceof TariffError) return e.code;
  if (e instanceof ZodError) return "invalid_data";
  const code = (e as { cause?: { code?: unknown } }).cause?.code ?? (e as { code?: unknown }).code;
  if (typeof code === "string" && /^(22|23)[0-9A-Z]{3}$/.test(code)) return `sql_${code}`;
  return null;
}

async function recordPostingFailure(db: Db, admissionId: string, errorCode: string, at: Date): Promise<void> {
  const key = failureKey(admissionId);
  await db.insert(ipdChargeExceptions).values({
    id: newId(), key, admissionId, reason: "posting_failed", errorCode, failCount: 1, firstSeenAt: at, lastSeenAt: at,
  }).onConflictDoUpdate({
    target: ipdChargeExceptions.key,
    set: {
      lastSeenAt: at, errorCode,
      failCount: sql`case when ${ipdChargeExceptions.resolvedAt} is null then ${ipdChargeExceptions.failCount} + 1 else 1 end`,
      firstSeenAt: sql`case when ${ipdChargeExceptions.resolvedAt} is null then ${ipdChargeExceptions.firstSeenAt} else ${at} end`,
      resolvedAt: null, resolvedLineId: null,
    },
  });
}

/**
 * THE NIGHTLY JOB (`kernel/worker/jobs.ts`, daily 00:05 IST; safe at any hour). Posts all chargeable days up to
 * YESTERDAY (IST, from `now`) not yet posted — so a night the server missed is caught up with its own service dates.
 *
 * Selection (review #756 item 3): every admission still in a bed, plus every ENDED one whose posting is not complete
 * (`charges_posted_through` short of the discharge day) or that has an open exception — never an age window.
 * Quarantine (item 2): a domain failure is recorded as a `posting_failed` exception with its error code; after
 * `IPD_QUARANTINE_AFTER` consecutive failures the admission is skipped until a person resolves the row
 * (`retryAdmissionCharges`). Only an infrastructure error fails the run.
 */
export async function postNightlyIpdCharges(db: Db, now: Date): Promise<NightlyResult> {
  const yesterday = istDayString(new Date(now.getTime() - 24 * 3_600_000));
  const openException = sql`exists (select 1 from ipd_charge_exceptions x where x.admission_id = "ipd_admissions"."id" and x.resolved_at is null)`;
  const quarantined = sql`exists (select 1 from ipd_charge_exceptions q where q.admission_id = "ipd_admissions"."id" and q.reason = 'posting_failed'
    and q.resolved_at is null and q.fail_count >= ${IPD_QUARANTINE_AFTER})`;
  const rows = await db.select({ id: ipdAdmissions.id, skip: sql<boolean>`${quarantined}` }).from(ipdAdmissions).where(and(
    isNotNull(ipdAdmissions.admittedAt),
    or(
      inArray(ipdAdmissions.state, ["admitted", "transferring", "fit_declared", "discharging"]),
      and(
        inArray(ipdAdmissions.state, [...IPD_ENDED_STATES]),
        or(
          isNull(ipdAdmissions.chargesPostedThrough),
          sql`${ipdAdmissions.chargesPostedThrough} < (${ipdAdmissions.endedAt} at time zone 'Asia/Kolkata')::date`,
          openException,
        ),
      ),
    ),
  )).orderBy(asc(ipdAdmissions.admittedAt));
  const out: NightlyResult = { admissions: rows.length, posted: 0, exceptions: 0, failed: 0, quarantined: 0 };
  const cache: PricingCache = new Map();
  for (let i = 0; i < rows.length; i += IPD_NIGHTLY_BATCH) {
    for (const row of rows.slice(i, i + IPD_NIGHTLY_BATCH)) {
      if (row.skip) { out.quarantined += 1; continue; }
      try {
        const r = await postAdmissionCharges(db, row.id, { upToIstDate: yesterday, now, cache });
        out.posted += r.posted;
        out.exceptions += r.exceptions;
      } catch (e) {
        const code = domainErrorCode(e);
        if (code === null) throw e; // infrastructure: the scheduler records sweep.failed and retries
        out.failed += 1;
        await recordPostingFailure(db, row.id, code, now);
      }
    }
  }
  return out;
}

/**
 * Lifts a quarantined admission (the bill desk, once the cause is fixed): resolves its `posting_failed` row and posts
 * now. Needs `ipd.charges.reverse` (the billing manager) until the bill desk (E2.3) declares its own string.
 */
export async function retryAdmissionCharges(
  db: Db, actor: Actor, admissionId: string, opts: { now?: Date } = {},
): Promise<AdmissionPostResult> {
  await requireIpdPermission(db, actor, IPD_CHARGES_REVERSE);
  const now = opts.now ?? new Date();
  await db.update(ipdChargeExceptions).set({ resolvedAt: now })
    .where(and(eq(ipdChargeExceptions.key, failureKey(admissionId)), isNull(ipdChargeExceptions.resolvedAt)));
  return postAdmissionCharges(db, admissionId, { upToIstDate: istDayString(new Date(now.getTime() - 24 * 3_600_000)), now });
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
  // Review #756 item 7: a REVERSED visit does not count — the day can be charged again (next `visit_seq`).
  const earlier = (await tx.select({ id: ipdChargeLines.id }).from(ipdChargeLines).where(and(
    eq(ipdChargeLines.admissionId, a.id), eq(ipdChargeLines.serviceDate, date), eq(ipdChargeLines.source, "ipd.visit"),
    eq(ipdChargeLines.consultantUserId, input.consultantUserId),
  ))).map((l) => l.id);
  const reversed = new Set(earlier.length === 0 ? [] : (await tx.select({ of: ipdChargeLines.reversalOf }).from(ipdChargeLines)
    .where(inArray(ipdChargeLines.reversalOf, earlier))).map((r) => r.of));
  if (earlier.some((id) => !reversed.has(id))) return record("repeat", null);
  const visitSeq = earlier.length;

  const stays = await staysOf(tx, a.id);
  const held = stays.find((s) => s.startedAt.getTime() <= at.getTime() && (s.endedAt === null || s.endedAt.getTime() > at.getTime()))
    ?? stays.filter((s) => s.startedAt.getTime() <= at.getTime()).at(-1);
  const billedClass: IpdBedClass = (held === undefined ? null : rentClassOf(held.billedClass)) ?? "general";
  const cross = input.consultantUserId !== a.consultantId && input.consultantUserId !== a.coveringFor;

  // The pricing loader reads only; inside the caller's transaction it sees what the transaction sees.
  const db = tx as unknown as Db;
  const versionId = await lockedVersion(db, a);
  if (a.tariffVersionId === null && versionId !== null) {
    await tx.update(ipdAdmissions).set({ tariffVersionId: versionId }).where(eq(ipdAdmissions.id, a.id)); // item 6: pin once
  }
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
    source: "ipd.visit", consultantUserId: input.consultantUserId, visitSeq, actor, at,
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
  try {
    return await withTx(db, async (tx) => {
    await admissionAdvisoryLock(tx, line.admissionId);
    const done = (await tx.select({ id: ipdChargeLines.id }).from(ipdChargeLines).where(eq(ipdChargeLines.reversalOf, line.id)))[0];
    if (done !== undefined) throw new IpdError("charge_line_already_reversed", "this line is already reversed", { reversalLineId: done.id });
    const id = newId();
    // The advisory lock serialises reversals; the unique index is the backstop, answered in the same words.
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
  } catch (e) {
    const c = (e as { cause?: { code?: string; constraint?: string } }).cause ?? (e as { code?: string; constraint?: string });
    if (c.code === "23505" && c.constraint === "ipd_charge_lines_reversal_ux") {
      throw new IpdError("charge_line_already_reversed", "this line is already reversed", { chargeLineId: line.id });
    }
    throw e;
  }
}

