import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { IPD_CLEANING_OVERDUE_MINUTES } from "@hmis/contracts";
import {
  ipdAdmissions, ipdBedStays, ipdDischargeConfirmations, ipdDischargeSummaries, ipdDischarges, ipdFinalBills, ipdGatePasses,
  patients, resources,
} from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { IpdBedAttributesSchema } from "./bed-attributes";
import { BED_FLOW_HOT_WAIT_MINUTES, latestStatusAt, readBedFlow } from "./bed-flow";
import { pendingDepartments } from "./discharge";
import type { Actor, IpdDischargeDepartment } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DeskCard, DeskProviderCtx, DeskRow } from "../../kernel/desk/types";

/**
 * E5.1 (#738) — IPD's NOW CARDS (spec SPEC-ipd-core "Now cards"; plan E5.1 "each card type has a provider and
 * permission; stable patients make no card"). Each card type is its own desk provider in `manifest.ts`, gated by its own
 * permission:
 *
 *   ipd.bed_proposal       `ipd.beds.manage`   a waiting request with a Bed Flow proposal (`bed-flow.ts`)
 *   ipd.discharge_blocked  `ipd.discharge.view` a fit-for-discharge stay stuck at a NAMED step past the threshold
 *   ipd.deposit_low        `ipd.billdesk.view` the deposit ladder's live rungs — MONEY: no doctor or nurse role holds
 *                                               the permission (decision 0058; `bill-desk.ts` `depositLowCard`)
 *   ipd.cleaning_overdue   `ipd.beds.clean`    a bed in cleaning longer than 60 minutes (the kernel's status history)
 *
 * A card exists only while something is wrong: a stable patient (in a bed, not waiting, not stuck, no live rung) makes
 * no row and an empty card is not sent. RANKING is deterministic rules today (`rankNowRows`): severity, then the
 * longest wait, then the row id. Patient rows carry the name (alias for a restricted patient), UHID and bed; a sealed
 * patient shows by alias or "Sealed patient", without UHID or any bed text (bill desk review 2; review #767). The money
 * card `deposit_low` keeps the admission number and never a name (DECIDED, review #767: read over a shoulder).
 *
 * Owed to M4 (no source data in this stack; no stub returns fake rows): `due_dose`, `overdue_vitals`, `new_order`,
 * `ews_rising`, `handover_pending`, `assessment_due` — see MAP.md.
 */

/** Review 2 (E2.3) — what a sealed (sensitive-context) patient is called on a desk surface when no alias is recorded. */
export const SEALED_LABEL = "Sealed patient";
/** DECIDED (E5.1): a discharge step "now" for longer than this is stuck (the 3-hour target's first third). */
export const IPD_DISCHARGE_STEP_STUCK_MINUTES = 60;

export type NowRow = DeskRow & { waitMinutes: number };
/** `sealed`: a sensitive-context patient — alias or label only; no UHID, no bed, and no bed text anywhere on the row. */
export type Identity = { name: string; uhid: string; bedCode: string | null; sealed: boolean };

const SEVERITY_RANK: Record<string, number> = { hot: 0, warn: 1 };

/** Severity first, then the longest wait, then the id — the same order every time. */
export function rankNowRows(rows: readonly NowRow[]): DeskRow[] {
  return [...rows]
    .sort((a, b) => (SEVERITY_RANK[a.severity ?? ""] ?? 2) - (SEVERITY_RANK[b.severity ?? ""] ?? 2) || b.waitMinutes - a.waitMinutes || a.id.localeCompare(b.id))
    .map((r) => {
      const row: DeskRow & { waitMinutes?: number } = { ...r };
      delete row.waitMinutes;
      return row;
    });
}

const minutesSince = (from: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));

/** "UHID · bed · detail", skipping what is empty. */
export function nowSubtitle(id: Identity, detail: string): string {
  return [id.uhid, id.bedCode ?? "", detail].filter((s) => s !== "").join(" · ");
}

/** Name (alias when restricted), UHID and current bed per admission, as `reader` may see them. */
export async function nowIdentities(db: Db, reader: Actor, admissions: readonly { id: string; patientId: string }[]): Promise<Map<string, Identity>> {
  const out = new Map<string, Identity>();
  if (admissions.length === 0) return out;
  const patientIds = [...new Set(admissions.map((a) => a.patientId))];
  const people = new Map((await getPatientSummaries(db, reader, patientIds)).map((p) => [p.requestedId, p] as const));
  const sealed = new Map((await db.select({ id: patients.id, alias: patients.alias }).from(patients)
    .where(and(inArray(patients.id, patientIds), eq(patients.sensitiveContext, true)))).map((p) => [p.id, p.alias] as const));
  const stays = await db.select({ admissionId: ipdBedStays.admissionId, code: resources.code }).from(ipdBedStays)
    .innerJoin(resources, eq(resources.id, ipdBedStays.bedId))
    .where(and(inArray(ipdBedStays.admissionId, admissions.map((a) => a.id)), isNull(ipdBedStays.endedAt)));
  const bedOf = new Map(stays.map((s) => [s.admissionId, s.code] as const));
  for (const a of admissions) {
    if (sealed.has(a.patientId)) {
      out.set(a.id, { name: sealed.get(a.patientId)?.trim() || SEALED_LABEL, uhid: "", bedCode: null, sealed: true });
      continue;
    }
    const p = people.get(a.patientId);
    out.set(a.id, { name: (p?.restricted === true ? p.alias : p?.name) ?? "—", uhid: p?.uhid ?? "", bedCode: bedOf.get(a.id) ?? null, sealed: false });
  }
  return out;
}

// ─────────────────────────────────────────── bed_proposal ───────────────────────────────────────────

export async function bedProposalCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const flow = (await readBedFlow(ctx.db, ctx.reader, ctx.now)).filter((e) => e.proposal !== null);
  if (flow.length === 0) return [];
  const who = await nowIdentities(ctx.db, ctx.reader, flow.map((e) => e.admission));
  const rows: NowRow[] = flow.map(({ admission: a, proposal }) => {
    const wait = minutesSince(a.requestedAt, ctx.now);
    const id = who.get(a.id)!;
    return {
      // Review #767: a sealed patient's row names no bed (not even the proposed one).
      id: a.id, badge: "!", title: id.name,
      subtitle: nowSubtitle({ ...id, bedCode: null }, id.sealed ? `waiting ${String(wait)} min` : `Bed ${proposal!.bedCode} · waiting ${String(wait)} min`),
      action: "Confirm", href: "/ipd/beds", severity: wait >= BED_FLOW_HOT_WAIT_MINUTES ? "hot" : "warn", waitMinutes: wait,
    };
  });
  return [{ key: "ipd.bed_proposal", band: "now", titleKey: "desk.ipdBedProposal.title", rows: rankNowRows(rows).slice(0, 5) }];
}

// ─────────────────────────────────────────── discharge_blocked ───────────────────────────────────────────

const DEPT_WORDS: Record<IpdDischargeDepartment, string> = {
  pharmacy: "Pharmacy", lab: "Lab", radiology: "Radiology", ot: "OT", ward: "Ward nursing", dietary: "Dietary", cssd: "CSSD",
  blood_bank: "Blood bank", billing: "Billing",
};

export type StuckStep = { step: "departments" | "summary" | "bill" | "gate_pass" | "exit"; words: string; since: Date };

/**
 * The step a stay in the discharge cascade is waiting on, named, and since when (pure). Departments and the summary
 * both start at the fit declaration; the bill waits on the last department; the gate pass on the bill, the summary and
 * the departments; the exit on the gate pass.
 */
export function stuckStepOf(args: {
  state: string; declaredAt: Date;
  confirmations: Parameters<typeof pendingDepartments>[0];
  summarySignedAt: Date | null; billSettledAt: Date | null; passIssuedAt: Date | null;
}): StuckStep | null {
  const pending = pendingDepartments(args.confirmations);
  const last = args.confirmations.reduce<Date>((m, c) => (c.confirmedAt !== null && c.confirmedAt > m ? c.confirmedAt : m), args.declaredAt);
  if (args.state === "discharging") {
    return args.passIssuedAt === null ? null : { step: "exit", words: "Gate scan", since: args.passIssuedAt };
  }
  if (pending.length > 0) return { step: "departments", words: `Waiting: ${pending.map((d) => DEPT_WORDS[d]).join(", ")}`, since: args.declaredAt };
  if (args.summarySignedAt === null) return { step: "summary", words: "Summary not signed", since: args.declaredAt };
  if (args.billSettledAt === null) return { step: "bill", words: "Final bill not settled", since: last };
  const ready = [last, args.summarySignedAt, args.billSettledAt].reduce((m, d) => (d > m ? d : m));
  return { step: "gate_pass", words: "Gate pass not issued", since: ready };
}

export async function dischargeBlockedCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const { db, now } = ctx;
  const cascade = await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.state, ["fit_declared", "discharging"]));
  if (cascade.length === 0) return [];
  const ids = cascade.map((a) => a.id);
  const discharges = new Map<string, typeof ipdDischarges.$inferSelect>();
  for (const d of await db.select().from(ipdDischarges).where(and(inArray(ipdDischarges.admissionId, ids), eq(ipdDischarges.status, "active")))
    .orderBy(desc(ipdDischarges.declaredAt))) if (!discharges.has(d.admissionId)) discharges.set(d.admissionId, d);
  const dIds = [...discharges.values()].map((d) => d.id);
  const confirmations = dIds.length === 0 ? [] : await db.select().from(ipdDischargeConfirmations).where(inArray(ipdDischargeConfirmations.dischargeId, dIds));
  const summaries = new Map((await db.select().from(ipdDischargeSummaries).where(inArray(ipdDischargeSummaries.admissionId, ids))).map((s) => [s.admissionId, s] as const));
  const bills = new Map((await db.select().from(ipdFinalBills).where(inArray(ipdFinalBills.admissionId, ids))).map((b) => [b.admissionId, b] as const));
  const passes = new Map((await db.select().from(ipdGatePasses).where(and(inArray(ipdGatePasses.admissionId, ids), eq(ipdGatePasses.status, "issued"))))
    .map((p) => [p.admissionId, p] as const));

  const stuck: { a: (typeof cascade)[number]; s: StuckStep; target: Date }[] = [];
  for (const a of cascade) {
    const d = discharges.get(a.id);
    if (d === undefined) continue;
    const summary = summaries.get(a.id);
    const s = stuckStepOf({
      state: a.state, declaredAt: d.declaredAt,
      confirmations: confirmations.filter((c) => c.dischargeId === d.id),
      summarySignedAt: summary?.status === "signed" ? summary.signedAt : null,
      billSettledAt: bills.get(a.id)?.settledAt ?? null, passIssuedAt: passes.get(a.id)?.issuedAt ?? null,
    });
    if (s === null || minutesSince(s.since, now) <= IPD_DISCHARGE_STEP_STUCK_MINUTES) continue;
    stuck.push({ a, s, target: d.targetAt });
  }
  if (stuck.length === 0) return [];
  const who = await nowIdentities(db, ctx.reader, stuck.map((x) => x.a));
  const rows: NowRow[] = stuck.map(({ a, s, target }) => {
    const wait = minutesSince(s.since, now);
    return {
      id: a.id, badge: "!", title: who.get(a.id)!.name, subtitle: nowSubtitle(who.get(a.id)!, `${s.words} · ${String(wait)} min`),
      action: "Open", href: `/ipd/discharge?admission=${a.id}`, severity: now.getTime() > target.getTime() ? "hot" : "warn", waitMinutes: wait,
    };
  });
  return [{ key: "ipd.discharge_blocked", band: "now", titleKey: "desk.ipdDischargeBlocked.title", rows: rankNowRows(rows).slice(0, 5) }];
}

// ─────────────────────────────────────────── cleaning_overdue ───────────────────────────────────────────

/** A bed in kernel `cleaning` longer than `IPD_CLEANING_OVERDUE_MINUTES`, from when it entered the status (hot past twice that). */
export async function cleaningOverdueCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const { db, now } = ctx;
  const cleaning = (await db.select().from(resources).where(and(eq(resources.kind, "bed"), eq(resources.status, "cleaning"))))
    .filter((b) => IpdBedAttributesSchema.safeParse(b.attributes).success);
  if (cleaning.length === 0) return [];
  const entered = await latestStatusAt(db, cleaning.map((b) => b.id));
  const parentIds = [...new Set(cleaning.flatMap((b) => (b.parentId === null ? [] : [b.parentId])))];
  const places = new Map((parentIds.length === 0 ? [] : await db.select().from(resources).where(inArray(resources.id, parentIds))).map((p) => [p.id, p] as const));
  const upper = [...new Set([...places.values()].flatMap((p) => (p.kind === "room" && p.parentId !== null ? [p.parentId] : [])))];
  if (upper.length > 0) for (const p of await db.select().from(resources).where(inArray(resources.id, upper))) places.set(p.id, p);
  const rows: NowRow[] = [];
  for (const b of cleaning) {
    const since = entered.get(b.id);
    if (since === undefined) continue;
    const wait = minutesSince(since, now);
    if (wait <= IPD_CLEANING_OVERDUE_MINUTES) continue;
    let ward = b.parentId === null ? undefined : places.get(b.parentId);
    if (ward?.kind === "room") ward = ward.parentId === null ? undefined : places.get(ward.parentId);
    rows.push({
      id: b.id, badge: "!", title: b.code, subtitle: [ward?.name ?? "", `cleaning ${String(wait)} min`].filter((s) => s !== "").join(" · "),
      action: "Open", href: "/ipd/beds", severity: wait > 2 * IPD_CLEANING_OVERDUE_MINUTES ? "hot" : "warn", waitMinutes: wait,
    });
  }
  if (rows.length === 0) return [];
  return [{ key: "ipd.cleaning_overdue", band: "now", titleKey: "desk.ipdCleaningOverdue.title", rows: rankNowRows(rows).slice(0, 5) }];
}
