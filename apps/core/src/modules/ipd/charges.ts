import { and, asc, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { ipdRateServiceCode, newId } from "@hmis/contracts";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissions, ipdBedStays, ipdChargeExceptions, ipdChargeLines, orderItems } from "../../kernel/db/schema";
import { isConsultant, treatingTeamOf } from "./rounds-team";
import { istMinutesOfInstant } from "../roster";
import { appendEvent } from "../../kernel/events/append";
import { TariffError, loadPricingContext, priceInvoiceLines, resolveActiveTariffVersion } from "../tariff";
import { admissionAdvisoryLock, provenanceOf, readAdmission, requireIpdPermission } from "./admission-core";
import { closedThroughOf, lineIsBilled, liveBills } from "./bill-cover";
import { ipdChargeableDays, rentClassOf } from "./charge-days";
import { applyClassChanges, classChangesOf } from "./class-change";
import { evaluateDepositLadderSafely } from "./deposit-ladder";
import { chargeException, chargeReversed, rentPosted, visitRecorded } from "./charge-events";
import { IpdError, IpdRefusal } from "./errors";
import { IPD_CHARGES_REVERSE } from "./manifest";
import type { Actor, IpdBedClass, IpdChargeComponent, IpdRateComponent } from "@hmis/contracts";
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
 * (rmo) is skipped silently; a missing `cross_visit` rate is an exception (review of 72f10b68 — never the `visit` rate). Nothing is ever guessed.
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

export type PricingCache = Map<string, PricingContext>;
type Priced = { ok: true; line: PricedLine; code: string } | { ok: false; code: string };

/** Pricing contexts by version, loaded once per run (the engine is pure; the loader reads). */
export async function pricingFor(db: Db, cache: PricingCache, versionId: string, at: Date): Promise<PricingContext> {
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
export async function lockedVersion(db: Db, a: AdmissionRow): Promise<string | null> {
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

export type LineFacts = {
  admission: AdmissionRow;
  serviceDate: string;
  component: IpdChargeComponent;
  billedClass: IpdBedClass | null;
  priced: PricedLine;
  code: string;
  versionId: string;
  source: "ipd.nightly" | "ipd.visit" | "ipd.order";
  consultantUserId?: string;
  visitSeq?: number;
  /** #785 — order lines: the department order and the order item; the item is also the exception key's last part. */
  orderId?: string;
  orderItemId?: string;
  actor: Actor;
  at: Date;
};

/** Inserts a priced line unless its idempotency index already holds one. Returns the new id, or null on a repeat. */
export async function insertLine(tx: Tx, f: LineFacts): Promise<string | null> {
  const id = newId();
  const p = f.priced;
  const inserted = await tx.insert(ipdChargeLines).values({
    id, admissionId: f.admission.id, patientId: f.admission.patientId, serviceDate: f.serviceDate, component: f.component,
    billedClass: f.billedClass, serviceId: p.serviceId, serviceCode: f.code, serviceName: p.serviceName,
    tariffVersionId: f.versionId, qty: p.qty, unitPaise: p.unitPaise, grossPaise: p.grossPaise, discountPaise: p.discountPaise,
    taxablePaise: p.taxableBasePaise, cgstPaise: p.gst.cgstPaise, sgstPaise: p.gst.sgstPaise, netPaise: p.netPaise,
    gstRateBps: p.gst.rateBps, gstExempt: p.gst.exempt, source: f.source, consultantUserId: f.consultantUserId ?? null, visitSeq: f.visitSeq ?? null,
    orderId: f.orderId ?? null, orderItemId: f.orderItemId ?? null,
    postedBy: f.actor.id, postedAt: f.at,
  }).onConflictDoNothing().returning({ id: ipdChargeLines.id });
  if (inserted.length === 0) return null;
  await tx.update(ipdChargeExceptions).set({ resolvedAt: f.at, resolvedLineId: id })
    .where(and(eq(ipdChargeExceptions.key, exceptionKey(f.admission.id, f.serviceDate, f.component, f.consultantUserId ?? f.orderItemId)), isNull(ipdChargeExceptions.resolvedAt)));
  return id;
}

/** `<admission>:<date>:<component>[:<consultant | order item>]` — the last part names the visit's consultant or (#785) the order item. */
export function exceptionKey(admissionId: string, date: string, component: IpdChargeComponent, who?: string): string {
  return [admissionId, date, component, ...(who === undefined ? [] : [who])].join(":");
}

/** Records (or re-sees) a charge that could not be posted. The event is raised once, when the row is new. */
export async function raiseException(
  tx: Tx, actor: Actor, a: AdmissionRow, x: {
    date: string; component: IpdChargeComponent; billedClass: IpdBedClass | null; code: string | null;
    reason: "rate_missing" | "tariff_missing" | "visit_backdated" | "order_cancelled_after_bill" | "order_cancelled_after_work";
    versionId: string | null; consultantUserId?: string;
    /** #785 — an order line's exception is keyed by its order item. */
    orderItemId?: string;
  }, at: Date,
): Promise<void> {
  const key = exceptionKey(a.id, x.date, x.component, x.consultantUserId ?? x.orderItemId) + (x.reason === "visit_backdated" ? ":backdated"
    : x.reason === "order_cancelled_after_bill" ? ":cancel_billed" : x.reason === "order_cancelled_after_work" ? ":cancel_after_work" : "");
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
  db: Db, admissionId: string,
  opts: {
    upToIstDate: string; now: Date; cache?: PricingCache;
    /**
     * E3.2 (#730) — the final bill posts as if the patient leaves at this instant (the day rule's discharge-day grace
     * applies to it). Ignored once the stay has really ended (`ended_at` wins). A later real exit after 14:00 is caught
     * by the nightly job (the day is not in the done set) and billed as a supplementary line.
     */
    presumedDischargeAt?: Date;
    /** #763 — the nightly job: a live bill's settlement day and before are left to the exit acts (see the body). */
    nightly?: boolean;
  },
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
    // #763 (review of a0d85914, RED 1): every chargeable day under the day rule (`charge-days.ts`) is posted; the `done`
    // set below is the dedupe, so a component a settled bill already took is never posted twice and an unposted one (the
    // settlement day, once the stay ran past 14:00 on it) lands in the next bill. Only the NIGHTLY run leaves a live bill's
    // settlement day alone: at that midnight the stay's exit time is not known yet (review #762 RED 2, locked) — the exit
    // acts (gate pass, supplementary bill) post it with the real presumed exit.
    const closed = opts.nightly === true ? closedThroughOf(await liveBills(tx, a.id)) : null;
    const days = ipdChargeableDays(stays, admittedAt, dischargedAtOf(a) ?? opts.presumedDischargeAt ?? null, opts.upToIstDate)
      .filter((d) => closed === null || d.date > closed);
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
    result.posted += await retryOrderExceptionsIn(tx, actor, a, opts.now, cache);
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
      // #763 (was review #762 RED 2): a settled bill closes the days up to its settlement day (`postAdmissionCharges`
      // never posts behind it); a patient still in a bed after that day is posted again — the supplementary bill's lines
      // (the bill desk's `settled_not_exited` / `supplementary_owed`).
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
        const r = await postAdmissionCharges(db, row.id, { upToIstDate: yesterday, now, cache, nightly: true });
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

  // Review of 72f10b68 (DECIDED): the CONSULTANT CADRE, not a doctor-master row alone (`rounds-team.ts` `isConsultant`).
  if (!(await isConsultant(tx, input.consultantUserId, at))) return record("not_chargeable", null);
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
  // Review of 72f10b68 ($ DECIDED, owner to confirm): any consultant of the TREATING UNIT (the admitting consultant's roster
  // unit on the day) bills `visit`; only a consultant from a different unit bills `cross_visit`. Coverage is read now.
  const team = await treatingTeamOf(tx, a, at);
  const cross = input.consultantUserId !== a.consultantId && input.consultantUserId !== a.coveringFor && !team.unitMemberIds.has(input.consultantUserId);

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
  // Review of 72f10b68 ($ DECIDED): a missing cross-visit rate is a `rate_missing` exception — never the visit rate.
  const component: IpdRateComponent = cross ? "cross_visit" : "visit";
  const priced = priceComponent(ctx, billedClass, component);
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

/**
 * E4.2 review of 72f10b68 ($ DECIDED): a round entered for a day that is neither today (IST) nor yesterday before 10:00
 * (a night round written up in the morning) is RECORDED but NOT CHARGED: the bill desk gets a `visit_backdated` exception
 * (key `…:backdated`, one per admission, day and consultant) for billing to charge or waive (`resolveBackdatedVisit`).
 */
/** 10:00 IST — a night round may be written up until then and still be the previous day's visit. */
export const NIGHT_ROUND_ENTRY_UNTIL_MINUTES = 10 * 60;

export function visitChargeableAt(seenAt: Date, now: Date): boolean {
  const seenDay = istDayString(seenAt);
  const today = istDayString(now);
  if (seenDay === today) return true;
  const { start } = istDayWindow(now);
  const yesterday = istDayString(new Date(start.getTime() - 1));
  return seenDay === yesterday && istMinutesOfInstant(now) < NIGHT_ROUND_ENTRY_UNTIL_MINUTES;
}

export async function raiseBackdatedVisitIn(tx: Tx, actor: Actor, admissionId: string, consultantUserId: string, seenAt: Date, now: Date): Promise<void> {
  const a = await readAdmission(tx, admissionId);
  await raiseException(tx, actor, a, {
    date: istDayString(seenAt), component: "visit", billedClass: null, code: null, reason: "visit_backdated", versionId: null, consultantUserId,
  }, now);
}

/** Billing's answer to a `visit_backdated` exception: post the visit as of its day (`charge`) or close it (`waive`). */
export async function resolveBackdatedVisit(
  db: Db, actor: Actor, input: { exceptionId: string; decision: "charge" | "waive"; reason: string }, opts: { now?: Date } = {},
): Promise<{ outcome: "charged" | "repeat" | "not_chargeable" | "rate_missing" | "waived" }> {
  await requireIpdPermission(db, actor, IPD_CHARGES_REVERSE);
  const reason = input.reason.trim();
  if (reason === "") throw new IpdError("reversal_reason_required", "charging or waiving a backdated visit needs a reason");
  const now = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const x = (await tx.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.id, input.exceptionId)).for("update"))[0];
    if (x === undefined || x.reason !== "visit_backdated" || x.resolvedAt !== null || x.serviceDate === null) {
      throw new IpdError("charge_line_not_found", "no open backdated visit with this id", { exceptionId: input.exceptionId });
    }
    const consultantUserId = x.key.split(":")[3]!;
    let outcome: "charged" | "repeat" | "not_chargeable" | "rate_missing" | "waived" = "waived";
    let lineId: string | null = null;
    if (input.decision === "charge") {
      const r = await postConsultantVisit(tx, {
        admissionId: x.admissionId, consultantUserId, seenAt: new Date(`${x.serviceDate}T12:00:00+05:30`), source: "rounds_tap", actor,
      });
      outcome = r.outcome;
      lineId = r.chargeLineId;
    }
    await tx.update(ipdChargeExceptions).set({ resolvedAt: now, resolvedLineId: lineId, resolutionNote: `${input.decision}: ${reason}` })
      .where(eq(ipdChargeExceptions.id, x.id));
    return { outcome };
  });
}

// ═══════════════════════════════════════ the order seam (#785) ═══════════════════════════════════════

/**
 * Prices one service (a lab test, a scan) on the locked version, or says the rate is missing. Review of 47cd79f5 (item 10,
 * DECIDED): an EXPLICIT ₹0 item on the version is a price — it posts a ₹0 line; an ABSENT item or a switched-off service is a
 * missing rate. `free` (the imaging fee switch was off at order time, decision 0067) posts a ₹0 line for any known service.
 */
export function priceService(ctx: PricingContext, serviceId: string, opts: { free?: boolean } = {}): Priced {
  const svc = ctx.services[serviceId];
  if (svc === undefined) return { ok: false, code: serviceId };
  if (opts.free === true) return { ok: true, line: zeroLine(svc.id, svc.name), code: svc.code };
  if (!svc.active) return { ok: false, code: svc.code };
  const price = ctx.tariff.items[svc.id];
  if (price === undefined || price < 0) return { ok: false, code: svc.code };
  try {
    const [line] = priceInvoiceLines(ctx, [{ lineId: newId(), serviceId: svc.id, qty: 1 }]);
    return { ok: true, line: line!, code: svc.code };
  } catch (e) {
    // A tariff refusal (no GST row for the category, …) is a rate the bill desk must fix — never a block on the order.
    if (e instanceof TariffError) return { ok: false, code: svc.code };
    throw e;
  }
}

/** A ₹0 line for a free study (no tax, no discount): the scan is on the bill, at nothing. */
function zeroLine(serviceId: string, serviceName: string): PricedLine {
  return {
    lineId: newId(), serviceId, serviceName, qty: 1, unitPaise: 0, grossPaise: 0, discountPaise: 0, taxableBasePaise: 0, netPaise: 0,
    gst: { cgstPaise: 0, sgstPaise: 0, rateBps: 0, exempt: true },
  } as unknown as PricedLine;
}

export type OrderChargeItem = { orderId: string; orderItemId: string; serviceId: string };

/**
 * #785 — ONE ORDER ITEM ON THE RUNNING BILL. Priced from the admission's LOCKED tariff version (the tariff in force for
 * this stay — `lockedVersion`, pinned here if still null, as the visit seam does); one `ipd.order` line per order item
 * (`ipd_charge_lines_order_ux`; a repeat posts nothing). A missing rate (no item, ₹0, the service switched off, a tariff
 * refusal) raises the `rate_missing` exception keyed by the order item and posts nothing; no tariff at all raises
 * `tariff_missing`. Runs on the caller's transaction under the admission's advisory lock. Returns the new line id or null.
 */
export async function postOrderLineIn(
  tx: Tx, actor: Actor, a: AdmissionRow, item: OrderChargeItem & { component: "lab" | "imaging"; serviceDate: string; free?: boolean },
  at: Date, cache: PricingCache = new Map(),
): Promise<string | null> {
  const db = tx as unknown as Db;
  const versionId = await lockedVersion(db, a);
  if (a.tariffVersionId === null && versionId !== null) {
    await tx.update(ipdAdmissions).set({ tariffVersionId: versionId }).where(eq(ipdAdmissions.id, a.id));
  }
  if (versionId === null) {
    await raiseException(tx, actor, a, {
      date: item.serviceDate, component: item.component, billedClass: null, code: null, reason: "tariff_missing", versionId: null, orderItemId: item.orderItemId,
    }, at);
    return null;
  }
  const priced = priceService(await pricingFor(db, cache, versionId, at), item.serviceId, { free: item.free });
  if (!priced.ok) {
    await raiseException(tx, actor, a, {
      date: item.serviceDate, component: item.component, billedClass: null, code: priced.code, reason: "rate_missing", versionId, orderItemId: item.orderItemId,
    }, at);
    return null;
  }
  return insertLine(tx, {
    admission: a, serviceDate: item.serviceDate, component: item.component, billedClass: null, priced: priced.line, code: priced.code,
    versionId, source: "ipd.order", orderId: item.orderId, orderItemId: item.orderItemId, actor, at,
  });
}

/**
 * #785 — the bill desk's Retry (and every nightly run) re-prices an order line whose rate was missing: the open
 * `rate_missing` / `tariff_missing` exceptions of component `lab` / `imaging` name their order item in the key; an item
 * the department has since cancelled is closed instead (nothing to charge). Called inside `postAdmissionCharges`.
 */
async function retryOrderExceptionsIn(tx: Tx, actor: Actor, a: AdmissionRow, at: Date, cache: PricingCache): Promise<number> {
  const open = await tx.select().from(ipdChargeExceptions).where(and(
    eq(ipdChargeExceptions.admissionId, a.id), isNull(ipdChargeExceptions.resolvedAt),
    inArray(ipdChargeExceptions.component, ["lab", "imaging"]), inArray(ipdChargeExceptions.reason, ["rate_missing", "tariff_missing"]),
  ));
  let posted = 0;
  for (const x of open) {
    const orderItemId = x.key.split(":")[3];
    if (orderItemId === undefined || x.serviceDate === null) continue;
    const item = (await tx.select({ orderId: orderItems.orderId, serviceId: orderItems.serviceId, status: orderItems.status })
      .from(orderItems).where(eq(orderItems.id, orderItemId)))[0];
    if (item === undefined) continue;
    if (item.status === "cancelled") {
      await tx.update(ipdChargeExceptions).set({ resolvedAt: at, resolutionNote: "order cancelled" }).where(eq(ipdChargeExceptions.id, x.id));
      continue;
    }
    const id = await postOrderLineIn(tx, actor, a, {
      orderId: item.orderId, orderItemId, serviceId: item.serviceId, component: x.component as "lab" | "imaging", serviceDate: x.serviceDate,
    }, at, cache);
    if (id !== null) posted += 1;
  }
  return posted;
}

/** #785 review — the order-cancel decisions (cancelled after the bill / after the work) close with billing's answer. */
export const ORDER_CANCEL_REASONS = ["order_cancelled_after_bill", "order_cancelled_after_work"] as const;
export async function resolveOrderCancelExceptionsIn(tx: Tx, admissionId: string, orderItemId: string, at: Date, note: string): Promise<number> {
  const done = await tx.update(ipdChargeExceptions).set({ resolvedAt: at, resolutionNote: note }).where(and(
    eq(ipdChargeExceptions.admissionId, admissionId), isNull(ipdChargeExceptions.resolvedAt),
    inArray(ipdChargeExceptions.reason, [...ORDER_CANCEL_REASONS]), like(ipdChargeExceptions.key, `%:${orderItemId}:%`),
  )).returning({ id: ipdChargeExceptions.id });
  return done.length;
}

/**
 * #785 review — billing KEEPS a cancelled order's line (the work was done, or the settled bill stands): the decision closes
 * with a reason and the line is untouched. `ipd.charges.reverse` (the billing manager), like the reversal itself.
 */
export async function keepOrderCharge(
  db: Db, actor: Actor, input: { chargeLineId: string; reason: string }, opts: { now?: Date } = {},
): Promise<{ resolved: number }> {
  await requireIpdPermission(db, actor, IPD_CHARGES_REVERSE);
  const reason = input.reason.trim();
  if (reason.length === 0) throw new IpdError("reversal_reason_required", "keeping a cancelled order's charge names its reason");
  const at = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const line = (await tx.select().from(ipdChargeLines).where(eq(ipdChargeLines.id, input.chargeLineId)))[0];
    if (line === undefined || line.orderItemId === null) throw new IpdError("charge_line_not_found", "no order line with this id", { chargeLineId: input.chargeLineId });
    await admissionAdvisoryLock(tx, line.admissionId);
    const resolved = await resolveOrderCancelExceptionsIn(tx, line.admissionId, line.orderItemId, at, `kept: ${reason}`);
    if (resolved === 0) throw new IpdError("charge_line_not_found", "no open cancelled-order decision for this line", { chargeLineId: line.id });
    return { resolved };
  });
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
  let out: { reversalLineId: string };
  try {
    out = await withTx(db, async (tx) => {
    await admissionAdvisoryLock(tx, line.admissionId);
    const done = (await tx.select({ id: ipdChargeLines.id }).from(ipdChargeLines).where(eq(ipdChargeLines.reversalOf, line.id)))[0];
    if (done !== undefined) throw new IpdError("charge_line_already_reversed", "this line is already reversed", { reversalLineId: done.id });
    // #763: a line a settled bill took is corrected by voiding that bill first — never by a reversal behind the invoice.
    if (await lineIsBilled(tx, line.admissionId, line.id)) throw new IpdError("charge_line_billed", "a settled bill took this line: void the bill first");
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
    // #785 review: billing's reversal of a cancelled order's line answers its bill-desk decision.
    if (line.orderItemId !== null) await resolveOrderCancelExceptionsIn(tx, line.admissionId, line.orderItemId, at, `reversed: ${reason}`);
    return { reversalLineId: id };
    });
  } catch (e) {
    const c = (e as { cause?: { code?: string; constraint?: string } }).cause ?? (e as { code?: string; constraint?: string });
    if (c.code === "23505" && c.constraint === "ipd_charge_lines_reversal_ux") {
      throw new IpdError("charge_line_already_reversed", "this line is already reversed", { chargeLineId: line.id });
    }
    throw e;
  }
  // E2.3 (#727, review 7): a reversal lowers the patient-payable total — the deposit ladder re-checks (caught and logged).
  await evaluateDepositLadderSafely(db, line.admissionId, at, "reversal");
  return out;
}

