import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import {
  CODED_CATEGORIES, fleischnerRecommendation, newId, tiradsScore,
} from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { istDayString } from "../../kernel/approvals/cumulative";
import {
  IMAGING_FOLLOWUP_CHANNELS, IMAGING_FOLLOWUP_CLOSE_REASONS, imagingFollowups, imagingReports, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { orderItems, orders } from "../../kernel/db/schema/orders";
import { opdDoctors, opdEncounters } from "../../kernel/db/schema/opd";
import { patients } from "../../kernel/db/schema/patients";
import { services } from "../../kernel/db/schema/tariff";
import { users } from "../../kernel/db/schema/auth";
import { withTx } from "../../kernel/db/client";
import { displayName } from "../patients";
import { RadiologyError } from "./errors";
import { imagingFollowupBooked, imagingFollowupOverdue } from "./events";
import { placeImagingOrder } from "./place";
import { treatingDoctorsOf } from "./closed-loop";
import type { FleischnerInputs, TiradsInputs } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";

/**
 * ═══ PLAN 18-S RS8c T1 — THE FOLLOW-UP TRACKER (plan gap 5, board "Reading room → Follow-ups") ═══
 *
 * *"Every 'recommend follow-up' becomes a row with an owner and a due date. A row closes with a
 * reason — never by being forgotten."* (the board). Four acts and one sweep:
 *
 *   · **opened at the signature** (`openFollowupsAtSignature`, called by `signReport`, `cosignReport`
 *     and `amendReport` inside their transaction) from the SIGNED body: a coded category whose system
 *     carries an imaging interval, or the radiologist's own tick (`body.followup`);
 *   · **notified** — somebody told the treating doctor / the patient (letter, phone, in person);
 *   · **booked** — a NEW imaging order through the existing `placeImagingOrder`, under the treating
 *     doctor, in the caller's transaction (a nested savepoint: the order and the row land together);
 *   · **closed** with one of six reasons and a line; a booked row closes itself `done_here` when the
 *     booked study's report is signed;
 *   · **the sweep** (daily, beside the Unread Watchman) marks a row due before today (IST) once and
 *     emits `imaging.followup_overdue`. RS10's escalation spine is not on main (PR #404), so the event
 *     is the voice for now; RS10's sweep picks it up as a cause after it merges.
 *
 * ═══ WHICH CODED CATEGORIES OPEN A ROW (DECIDED, the published systems' own intervals) ═══
 *
 * The due day is the signed IST day + the interval's EARLIEST bound ("6–12 months" is due at 6):
 *   · BI-RADS 3 → 6 months;
 *   · ACR TI-RADS whose size rule says "follow up" → 1 year (the white paper's first interval; an
 *     "FNA" advice is a procedure for the doctor, not an imaging follow-up, and opens no row);
 *   · LI-RADS LR-3 → 3 months (3–6), LR-4 → 3 months (≤ 3, alongside the multidisciplinary review);
 *   · Lung-RADS 3 → 6 months, 4A → 3 months;
 *   · Fleischner 2017 from its recorded inputs → the first CT interval's earliest month;
 *   · `other` — the radiologist's tick: `body.followup = { text, weeks | months }`.
 */

export type FollowupSource = "birads" | "tirads" | "lirads" | "lungrads" | "fleischner" | "other";

export type FollowupDraft = {
  source: FollowupSource;
  recommendation: string;
  intervalLabel: string;
  /** Calendar months or weeks from the signed day. */
  interval: { months: number } | { weeks: number };
};

/** The radiologist's own tick, as the reading room writes it into the body (a non-string key every reader ignores). */
export type FollowupTick = { text: string; weeks?: number; months?: number };

function entryOf(coded: Record<string, unknown>, system: string): { value: unknown; inputs: unknown } | null {
  const e = coded[system];
  if (e === undefined || e === null) return null;
  if (typeof e === "object" && !Array.isArray(e)) {
    const o = e as { value?: unknown; inputs?: unknown };
    return { value: o.value, inputs: o.inputs };
  }
  return { value: e, inputs: undefined };
}

function labelOf(system: keyof typeof CODED_CATEGORIES, value: string): string {
  return CODED_CATEGORIES[system].find((c) => c.value === value)?.label ?? value;
}

const monthsLabel = (n: number): string => (n === 12 ? "1 year" : `${String(n)} month${n === 1 ? "" : "s"}`);

/**
 * The recommendations a report body carries, as rows-to-be. PURE: the body as signed, nothing else.
 * Throws `evidence_invalid` for a malformed tick (the sign is refused — a follow-up nobody can date is
 * not a follow-up).
 */
export function followupsFromBody(body: unknown): FollowupDraft[] {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const coded = (typeof b.coded === "object" && b.coded !== null ? b.coded : {}) as Record<string, unknown>;
  const out: FollowupDraft[] = [];

  const birads = entryOf(coded, "birads");
  if (birads?.value === "3") {
    out.push({ source: "birads", recommendation: `BI-RADS 3 — ${labelOf("birads", "3")}`, intervalLabel: monthsLabel(6), interval: { months: 6 } });
  }

  const tirads = entryOf(coded, "tirads");
  if (tirads !== null && typeof tirads.inputs === "object" && tirads.inputs !== null) {
    try {
      const r = tiradsScore(tirads.inputs as TiradsInputs);
      if (r.advice === "follow_up") {
        const size = (tirads.inputs as TiradsInputs).sizeCm;
        out.push({
          source: "tirads",
          recommendation: `ACR TI-RADS ${r.level}${size != null ? `, ${String(size)} cm` : ""} — ultrasound follow-up at 1 year`,
          intervalLabel: monthsLabel(12), interval: { months: 12 },
        });
      }
    } catch { /* inputs the calculator cannot read open nothing; the pre-sign check already warned */ }
  }

  const lirads = entryOf(coded, "lirads");
  if (lirads?.value === "LR-3" || lirads?.value === "LR-4") {
    const v = lirads.value as string;
    out.push({
      source: "lirads",
      recommendation: v === "LR-3"
        ? "LI-RADS LR-3 — repeat or alternative imaging in 3–6 months"
        : "LI-RADS LR-4 — multidisciplinary discussion; repeat or alternative imaging within 3 months",
      intervalLabel: monthsLabel(3), interval: { months: 3 },
    });
  }

  const lung = entryOf(coded, "lungrads");
  if (lung?.value === "3" || lung?.value === "4A") {
    const v = lung.value as string;
    const months = v === "3" ? 6 : 3;
    out.push({ source: "lungrads", recommendation: `Lung-RADS ${v} — ${labelOf("lungrads", v)}`, intervalLabel: monthsLabel(months), interval: { months } });
  }

  const fl = entryOf(coded, "fleischner");
  if (fl !== null && typeof fl.inputs === "object" && fl.inputs !== null) {
    try {
      const r = fleischnerRecommendation(fl.inputs as FleischnerInputs);
      if (r.applies && r.firstCtMonths !== null) {
        const months = r.firstCtMonths[0];
        out.push({ source: "fleischner", recommendation: `Fleischner 2017: ${r.recommendation}`, intervalLabel: monthsLabel(months), interval: { months } });
      }
    } catch { /* as TI-RADS */ }
  }

  if (b.followup !== undefined && b.followup !== null) {
    const tick = b.followup as Partial<FollowupTick>;
    const text = typeof tick.text === "string" ? tick.text.trim() : "";
    const weeks = tick.weeks, months = tick.months;
    const okWeeks = typeof weeks === "number" && Number.isInteger(weeks) && weeks >= 1 && weeks <= 104;
    const okMonths = typeof months === "number" && Number.isInteger(months) && months >= 1 && months <= 60;
    if (text.length < 3 || text.length > 300 || okWeeks === okMonths) {
      throw new RadiologyError(
        "evidence_invalid",
        "A follow-up recommendation needs what to do (a few words) and when — a number of weeks or of months, not both.",
        { field: "followup" },
      );
    }
    out.push(okWeeks
      ? { source: "other", recommendation: text, intervalLabel: `${String(weeks)} week${weeks === 1 ? "" : "s"}`, interval: { weeks: weeks! } }
      : { source: "other", recommendation: text, intervalLabel: monthsLabel(months!), interval: { months: months! } });
  }
  return out;
}

/** `YYYY-MM-DD` + an interval, on the calendar (the 31st + 1 month is the last day of the next month). */
export function addInterval(day: string, interval: FollowupDraft["interval"]): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  if ("weeks" in interval) {
    return new Date(Date.UTC(y, m - 1, d + 7 * interval.weeks)).toISOString().slice(0, 10);
  }
  const target = new Date(Date.UTC(y, m - 1 + interval.months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

type StudyRef = { id: string; patientId: string; orderId: string };

/**
 * Called by every path that inserts a hospital-final `signed` version, in its transaction. Opens a
 * row per recommendation the signed body carries (idempotent per version and source), and closes as
 * `done_here` any booked follow-up whose booked order this study belongs to.
 */
export async function openFollowupsAtSignature(
  tx: Tx, actor: Actor, study: StudyRef, signed: { reportId: string; body: unknown }, now: Date,
): Promise<{ opened: number }> {
  const drafts = followupsFromBody(signed.body);
  const signedDay = istDayString(now);
  for (const d of drafts) {
    await tx.insert(imagingFollowups).values({
      id: newId(), studyId: study.id, reportId: signed.reportId, patientId: study.patientId,
      source: d.source, recommendation: d.recommendation, intervalLabel: d.intervalLabel,
      dueOn: addInterval(signedDay, d.interval), createdBy: actor.id, createdAt: now,
    }).onConflictDoNothing({ target: [imagingFollowups.reportId, imagingFollowups.source] });
  }
  await tx.update(imagingFollowups)
    .set({ state: "closed", closedAt: now, closedBy: actor.id, closeReason: "done_here", closeNote: "The booked study was reported." })
    .where(and(eq(imagingFollowups.bookedOrderId, study.orderId), eq(imagingFollowups.state, "booked")));
  return { opened: drafts.length };
}

/**
 * ═══ AN AMENDMENT IS THE REPORT NOW, SO IT DECIDES WHAT IS STILL RECOMMENDED ═══
 *
 * A source the new version still carries keeps its row (its due day and history — the patient was
 * already told about it); a source the new version dropped closes `withdrawn_by_amendment`; a source
 * only the new version carries opens a new row. Booked rows are left alone: an order exists.
 */
export async function reconcileFollowupsAtAmendment(
  tx: Tx, actor: Actor, study: StudyRef, signed: { reportId: string; body: unknown }, now: Date,
): Promise<void> {
  const drafts = followupsFromBody(signed.body);
  const keep = new Set(drafts.map((d) => d.source));
  const live = await (tx as unknown as Db).select({ id: imagingFollowups.id, source: imagingFollowups.source })
    .from(imagingFollowups)
    .where(and(eq(imagingFollowups.studyId, study.id), inArray(imagingFollowups.state, ["open", "notified"])));
  const liveSources = new Set(live.map((r) => r.source));
  const dropped = live.filter((r) => !keep.has(r.source as FollowupSource)).map((r) => r.id);
  if (dropped.length > 0) {
    await tx.update(imagingFollowups)
      .set({ state: "closed", closedAt: now, closedBy: actor.id, closeReason: "withdrawn_by_amendment", closeNote: "The amended report no longer recommends it." })
      .where(inArray(imagingFollowups.id, dropped));
  }
  const signedDay = istDayString(now);
  for (const d of drafts) {
    if (liveSources.has(d.source)) continue;
    await tx.insert(imagingFollowups).values({
      id: newId(), studyId: study.id, reportId: signed.reportId, patientId: study.patientId,
      source: d.source, recommendation: d.recommendation, intervalLabel: d.intervalLabel,
      dueOn: addInterval(signedDay, d.interval), createdBy: actor.id, createdAt: now,
    }).onConflictDoNothing({ target: [imagingFollowups.reportId, imagingFollowups.source] });
  }
}

/* ═══════════════════════════════ the acts ═══════════════════════════════ */

type FollowupRow = typeof imagingFollowups.$inferSelect;

async function loadForUpdate(tx: Tx, followupId: string): Promise<FollowupRow & { accessionNo: string }> {
  const rows = await (tx as unknown as Db)
    .select({ f: imagingFollowups, accessionNo: imagingStudies.accessionNo })
    .from(imagingFollowups)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingFollowups.studyId))
    .where(eq(imagingFollowups.id, followupId))
    .for("update", { of: imagingFollowups });
  const row = rows[0];
  if (!row) throw new RadiologyError("unknown_followup", "That follow-up is not on the list — reload it.", { followupId });
  return { ...row.f, accessionNo: row.accessionNo };
}

function assertStillOpen(f: FollowupRow & { accessionNo: string }): void {
  if (f.state === "closed" || f.state === "booked") {
    throw new RadiologyError(
      "already_resolved",
      f.state === "booked"
        ? `The ${f.accessionNo} follow-up is already booked (${f.bookedOrderNo ?? "an order"}) — the front desk schedules it.`
        : `The ${f.accessionNo} follow-up is already closed.`,
      { followupId: f.id, state: f.state },
    );
  }
}

/** Somebody told the treating doctor or the patient. Nothing is SENT from here (no WhatsApp on main). */
export async function markFollowupNotified(
  tx: Tx, actor: Actor, input: { followupId: string; channel: string; note?: string | null; now?: Date },
): Promise<{ followupId: string; state: "notified" }> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "telling a doctor or a patient is a person's act");
  if (!(IMAGING_FOLLOWUP_CHANNELS as readonly string[]).includes(input.channel)) {
    throw new RadiologyError("evidence_invalid", "Say how they were told: a letter, a phone call or in person.", { channel: input.channel });
  }
  const f = await loadForUpdate(tx, input.followupId);
  assertStillOpen(f);
  const now = input.now ?? new Date();
  await tx.update(imagingFollowups).set({
    state: "notified", notifiedAt: now, notifiedBy: actor.id, notifiedChannel: input.channel,
    notifiedNote: input.note?.trim() ? input.note.trim() : null,
  }).where(eq(imagingFollowups.id, f.id));
  return { followupId: f.id, state: "notified" };
}

export const FOLLOWUP_CLOSE_NOTE_MIN = 4;

/** Close with one of the six reasons and a line. `withdrawn_by_amendment` is the amendment's, not a person's. */
export async function closeFollowup(
  tx: Tx, actor: Actor, input: { followupId: string; reason: string; note: string; now?: Date },
): Promise<{ followupId: string; state: "closed" }> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "closing a follow-up is a person's act");
  const reasons = IMAGING_FOLLOWUP_CLOSE_REASONS.filter((r) => r !== "withdrawn_by_amendment") as readonly string[];
  if (!reasons.includes(input.reason)) {
    throw new RadiologyError(
      "evidence_invalid",
      "Choose why it closes: done here, done elsewhere, the doctor declines, the patient declines, or the patient died. An amendment withdraws a recommendation by itself.",
      { reason: input.reason },
    );
  }
  const note = (input.note ?? "").trim();
  if (note.length < FOLLOWUP_CLOSE_NOTE_MIN) {
    throw new RadiologyError("reason_required", "Write one line on why it closes — who said so, or where it was done.", { min: FOLLOWUP_CLOSE_NOTE_MIN });
  }
  const f = await loadForUpdate(tx, input.followupId);
  if (f.state === "closed") assertStillOpen(f);
  const now = input.now ?? new Date();
  await tx.update(imagingFollowups).set({
    state: "closed", closedAt: now, closedBy: actor.id, closeReason: input.reason, closeNote: note,
  }).where(eq(imagingFollowups.id, f.id));
  return { followupId: f.id, state: "closed" };
}

/**
 * ═══ BOOK IT — A NEW ORDER THROUGH THE EXISTING DOOR, UNDER THE TREATING DOCTOR ═══
 *
 * `placeImagingOrder` does every check an order meets (the visit, the PCPNDT rule, the 24-hour
 * duplicate, the two permissions). It runs INSIDE this transaction (drizzle nests it as a savepoint),
 * after the row is locked, so two clicks book one order and a refused placement books nothing.
 *
 * DECIDED (standard practice): the ordering clinician is the study's treating doctor (the original
 * order's clinician) — the referrer books, radiology does not order on its own authority; the service
 * is the original study's unless the caller names another from the book; the visit is the caller's
 * (the doctor's consult) or the patient's latest OPD visit, and `placeImagingOrder`'s own
 * `encounter_closed` refusal says "open a new visit" when there is none.
 */
export async function bookFollowup(
  db: Db, actor: Actor, decls: readonly OrderKindDecl[],
  input: { followupId: string; encounterNo?: string | null; serviceId?: string | null; now?: Date },
): Promise<{ followupId: string; orderId: string; orderNo: string }> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "booking a follow-up is a person's act");
  const now = input.now ?? new Date();
  return await withTx(db, async (tx) => {
    const f = await loadForUpdate(tx, input.followupId);
    assertStillOpen(f);
    const [origin] = await (tx as unknown as Db)
      .select({
        serviceId: imagingStudies.serviceId, encounterNo: imagingStudies.encounterNo,
        orderingClinicianId: orders.orderingClinicianId,
      })
      .from(imagingStudies)
      .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
      .where(eq(imagingStudies.id, f.studyId));
    const treating = await treatingDoctorsOf(tx, f.studyId);
    const clinician = origin?.orderingClinicianId ?? treating?.userIds[0] ?? (await holdsDoctorSeat(tx, actor) ? actor.id : null);
    if (clinician === null) {
      throw new RadiologyError(
        "not_treating_doctor",
        `The ${f.accessionNo} study was ordered on an outside prescription, so no doctor here can book its follow-up — the patient's own doctor books it, or a doctor here sees the patient first.`,
        { followupId: f.id },
      );
    }
    const encounterNo = input.encounterNo ?? await latestVisitOf(tx, f.patientId) ?? origin?.encounterNo;
    if (encounterNo === undefined || encounterNo === null) {
      throw new RadiologyError("encounter_closed", "The patient has no visit to hang the follow-up on — the front desk opens one.", { followupId: f.id });
    }
    const placed = await placeImagingOrder(tx as unknown as Db, actor, decls, {
      patientId: f.patientId,
      encounterNo,
      serviceDate: istDayString(now),
      orderingClinicianId: clinician,
      priority: "routine",
      /** F28 — the order's stamp reads the same clock as the duplicate window (`place.ts`'s own finding). */
      placedAt: now,
      indication: `Follow-up of ${f.accessionNo}: ${f.recommendation}`.slice(0, 500),
      items: [{ serviceId: input.serviceId ?? origin!.serviceId }],
    }, undefined, now);
    await tx.update(imagingFollowups).set({
      state: "booked", bookedOrderId: placed.orderId, bookedOrderNo: placed.orderNo, bookedAt: now, bookedBy: actor.id,
    }).where(eq(imagingFollowups.id, f.id));
    await appendEvent(tx, imagingFollowupBooked.make({
      actor, patientId: f.patientId,
      payload: { followupId: f.id, studyId: f.studyId, orderId: placed.orderId, source: f.source as FollowupSource },
    }));
    return { followupId: f.id, orderId: placed.orderId, orderNo: placed.orderNo };
  });
}

async function holdsDoctorSeat(tx: Tx, actor: Actor): Promise<boolean> {
  const rows = await (tx as unknown as Db).select({ id: opdDoctors.id }).from(opdDoctors).where(eq(opdDoctors.userId, actor.id));
  return rows.length > 0;
}

/** The patient's most recent OPD visit number (`placeImagingOrder` decides whether it is still open). */
async function latestVisitOf(tx: Tx, patientId: string): Promise<string | null> {
  const rows = await (tx as unknown as Db).select({ visitNo: opdEncounters.visitNo })
    .from(opdEncounters).where(eq(opdEncounters.patientId, patientId))
    .orderBy(desc(opdEncounters.serviceDate), desc(opdEncounters.visitNo)).limit(1);
  return rows[0]?.visitNo ?? null;
}

/* ═══════════════════════════════ the sweep ═══════════════════════════════ */

export const FOLLOWUP_SWEEP_ACTOR: Actor = { type: "system", id: "radiology-followups" };
const SWEEP_LIMIT = 500;

/**
 * Daily (08:00 IST, beside the Unread Watchman): every open or notified row due BEFORE today (IST)
 * that has not been escalated is marked once and gets one `imaging.followup_overdue`. Idempotent by
 * the mark (conditional update); a booked or closed row is never chased.
 */
export async function sweepOverdueFollowups(db: Db, now: Date = new Date()): Promise<{ chased: string[] }> {
  const today = istDayString(now);
  const due = await db.select({
    id: imagingFollowups.id, studyId: imagingFollowups.studyId, patientId: imagingFollowups.patientId,
    dueOn: imagingFollowups.dueOn, source: imagingFollowups.source,
  })
    .from(imagingFollowups)
    .where(and(
      inArray(imagingFollowups.state, ["open", "notified"]),
      isNull(imagingFollowups.overdueAt),
      lt(imagingFollowups.dueOn, today),
    ))
    .orderBy(asc(imagingFollowups.dueOn))
    .limit(SWEEP_LIMIT);
  const chased: string[] = [];
  for (const f of due) {
    const won = await withTx(db, async (tx) => {
      const marked = await tx.update(imagingFollowups).set({ overdueAt: now })
        .where(and(eq(imagingFollowups.id, f.id), isNull(imagingFollowups.overdueAt), inArray(imagingFollowups.state, ["open", "notified"])))
        .returning({ id: imagingFollowups.id });
      if (marked.length === 0) return false;
      const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${f.dueOn}T00:00:00Z`)) / 86_400_000);
      await appendEvent(tx, imagingFollowupOverdue.make({
        actor: FOLLOWUP_SWEEP_ACTOR, patientId: f.patientId,
        payload: { followupId: f.id, studyId: f.studyId, source: f.source as FollowupSource, dueOn: f.dueOn, overdueDays: days },
      }));
      return true;
    });
    if (won) chased.push(f.id);
  }
  return { chased };
}

/* ═══════════════════════════════ the reads ═══════════════════════════════ */

export type FollowupView = {
  followupId: string;
  studyId: string;
  accessionNo: string;
  studyName: string;
  patientId: string;
  patientName: string;
  uhid: string;
  source: string;
  recommendation: string;
  intervalLabel: string;
  dueOn: string;
  /** open · notified · booked · closed, and `overdue` is DERIVED (due before today, not booked/closed). */
  state: string;
  overdue: boolean;
  signedAt: string | null;
  treatingDoctor: string | null;
  notified: { at: string; channel: string; by: string | null; note: string | null } | null;
  booked: { orderNo: string; at: string } | null;
  closed: { at: string; reason: string; note: string | null } | null;
};

/** Closed rows stay on the reading room's list this long. */
export const FOLLOWUP_CLOSED_DAYS = 90;

async function viewRows(db: Db, actor: Actor, where: ReturnType<typeof and>, now: Date, reason: string): Promise<FollowupView[]> {
  const canSeeConfidential = actor.type === "user" && await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
  const rows = await db.select({
    f: imagingFollowups, accessionNo: imagingStudies.accessionNo, studyName: services.name,
    name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential, uhid: patients.uhid,
    signedAt: imagingReports.signedAt, orderingClinicianId: orders.orderingClinicianId,
  })
    .from(imagingFollowups)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingFollowups.studyId))
    .innerJoin(imagingReports, eq(imagingReports.id, imagingFollowups.reportId))
    .innerJoin(services, eq(services.id, imagingStudies.serviceId))
    .innerJoin(patients, eq(patients.id, imagingFollowups.patientId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .where(where)
    .orderBy(asc(imagingFollowups.dueOn))
    .limit(500);
  const userIds = [...new Set(rows.flatMap((r) => [r.orderingClinicianId, r.f.notifiedBy]).filter((x): x is string => x !== null))];
  const names = userIds.length === 0 ? [] : await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, userIds));
  const nameOf = new Map(names.map((n) => [n.id, n.fullName]));
  const today = istDayString(now);
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.f.patientId)) continue;
    seen.add(r.f.patientId);
    await recordPhiAccess(db, { actor, patientId: r.f.patientId, surface: "imaging.report", reason, now });
  }
  return rows.map((r): FollowupView => {
    const f = r.f;
    return {
      followupId: f.id, studyId: f.studyId, accessionNo: r.accessionNo, studyName: r.studyName,
      patientId: f.patientId,
      patientName: displayName({ name: r.name, alias: r.alias, isConfidential: r.isConfidential }, canSeeConfidential),
      uhid: r.uhid, source: f.source, recommendation: f.recommendation, intervalLabel: f.intervalLabel, dueOn: f.dueOn,
      state: f.state,
      overdue: (f.state === "open" || f.state === "notified") && f.dueOn < today,
      signedAt: r.signedAt?.toISOString() ?? null,
      treatingDoctor: r.orderingClinicianId !== null ? nameOf.get(r.orderingClinicianId) ?? null : null,
      notified: f.notifiedAt !== null && f.notifiedChannel !== null
        ? { at: f.notifiedAt.toISOString(), channel: f.notifiedChannel, by: f.notifiedBy !== null ? nameOf.get(f.notifiedBy) ?? null : null, note: f.notifiedNote }
        : null,
      booked: f.bookedOrderNo !== null && f.bookedAt !== null ? { orderNo: f.bookedOrderNo, at: f.bookedAt.toISOString() } : null,
      closed: f.closedAt !== null && f.closeReason !== null ? { at: f.closedAt.toISOString(), reason: f.closeReason, note: f.closeNote } : null,
    };
  });
}

/** Overdue first, then the not-yet-acted, then booked, then closed; soonest due first inside each. */
const RANK = (v: FollowupView): number => (v.overdue ? 0 : v.state === "open" ? 1 : v.state === "notified" ? 2 : v.state === "booked" ? 3 : 4);
function sortViews(v: FollowupView[]): FollowupView[] {
  return v.sort((a, b) => RANK(a) - RANK(b) || a.dueOn.localeCompare(b.dueOn));
}

export type FollowupBoard = {
  rows: FollowupView[];
  tiles: { open: number; overdue: number; notActed: number; closedOnTime90: number | null; recommendedThisMonth: number };
};

/**
 * The reading room's Follow-ups view: every row not closed, and the last 90 days' closed ones.
 * `closedOnTime90` = of the rows DUE in the last 90 days, the share booked or closed on or before
 * their due day (null when none were due).
 */
export async function followupBoard(db: Db, actor: Actor, now: Date = new Date()): Promise<FollowupBoard> {
  const since = new Date(now.getTime() - FOLLOWUP_CLOSED_DAYS * 86_400_000);
  const rows = sortViews(await viewRows(
    db, actor,
    or(ne(imagingFollowups.state, "closed"), gte(imagingFollowups.closedAt, since)),
    now, "the reading room's follow-up list",
  ));
  const today = istDayString(now);
  const from = istDayString(since);
  const month = today.slice(0, 7);
  const dueWindow = rows.filter((r) => r.dueOn >= from && r.dueOn <= today);
  const onTime = dueWindow.filter((r) => {
    const done = r.booked?.at ?? r.closed?.at ?? null;
    return done !== null && istDayString(new Date(done)) <= r.dueOn;
  });
  return {
    rows,
    tiles: {
      open: rows.filter((r) => r.state !== "closed").length,
      overdue: rows.filter((r) => r.overdue).length,
      notActed: rows.filter((r) => r.state === "open").length,
      closedOnTime90: dueWindow.length === 0 ? null : Math.round((onTime.length / dueWindow.length) * 100),
      recommendedThisMonth: rows.filter((r) => r.signedAt !== null && istDayString(new Date(r.signedAt)).slice(0, 7) === month).length,
    },
  };
}

/**
 * RS9's results inbox: the logged-in doctor's patients' follow-ups still to book (open or notified),
 * on studies they treat — the ordering clinician or the visit's doctor (`closed-loop.ts`'s rule).
 */
export async function doctorFollowups(db: Db, actor: Actor, now: Date = new Date()): Promise<FollowupView[]> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "an inbox is a person's");
  const canSeeRestricted = await hasPermission(db, actor.id, "orders.read.restricted", "hospital");
  const mine = await db.select({ id: imagingFollowups.id, restricted: orderItems.restricted, orderingClinicianId: orders.orderingClinicianId })
    .from(imagingFollowups)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingFollowups.studyId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .leftJoin(opdEncounters, eq(opdEncounters.visitNo, imagingStudies.encounterNo))
    .leftJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(and(
      inArray(imagingFollowups.state, ["open", "notified"]),
      or(eq(orders.orderingClinicianId, actor.id), eq(opdDoctors.userId, actor.id)),
    ))
    .limit(200);
  /** A restricted (PCPNDT-class) study: its ordering clinician or a holder of `orders.read.restricted` only (the inbox's rule). */
  const visible = mine.filter((m) => !m.restricted || canSeeRestricted || m.orderingClinicianId === actor.id);
  if (visible.length === 0) return [];
  return sortViews(await viewRows(
    db, actor, inArray(imagingFollowups.id, visible.map((m) => m.id)), now, "the treating doctor's follow-ups to book",
  ));
}
