import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { ipdAdmissions, ipdBedProposals, resources } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { needOf } from "./admission-core";
import { IpdBedAttributesSchema, IpdWardAttributesSchema } from "./bed-attributes";
import { ageInYears, checkBedRules } from "./bed-rules";
import { bedHoldsAndBlocks, roomGendersFor } from "./beds";
import type { Actor, IpdBedFlowProposal, IpdBedFlowReason, IpdBedNeed } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";
import type { IpdBedAttributes } from "./bed-attributes";
import type { BedFlowWithdrawReason } from "./bed-flow-log";
import type { BedRulePatient } from "./bed-rules";

/**
 * E5.2 (#739) — BED FLOW T0: RULES, NO MODEL (spec SPEC-ipd-core §4.8, §4.9 A "Waiting for a bed"; plan E5.2).
 *
 * For each admission waiting for a bed (state `requested`, no bed held), the best free bed that passes EVERY bed rule —
 * asked of `checkBedRules`, the one function `reserve_bed`, `assign_bed` and `admit` ask, with the twin room's gender
 * read the way those acts read it (`roomGendersFor`, sharing `roomGender`'s holder rule). A bed that fails any rule is
 * never proposed. The act re-checks everything under lock, so a proposal can never place a patient by itself.
 *
 * WHICH BED (DECIDED, deterministic): requested class first, then a bed in a ward of the admitting department, then the
 * bed free longest (its last move into `available`), then the bed code. Requests are served oldest first and a bed goes
 * to one request only. An open proposal that is still valid is KEPT (it does not jump while the bed manager looks at it).
 *
 * WHAT IS NEVER PROPOSED (DECIDED): an overflow bed (the duty manager's own act), a bed being cleaned, a held or blocked
 * bed — the proposal is the same for every viewer.
 *
 * ONE READ, BATCHED (review #767): one query per fact (waiting, open proposals, free beds, holds and blocks, the
 * candidates' wards, each candidate's LATEST status row through the `(resource_id, seq)` index), the withdrawals as one
 * update per reason, the new proposals as one insert. An open proposal is unique per admission AND per bed: a concurrent
 * read that loses the insert shows no proposal for that request this time.
 *
 * REASONS are static codes stored with the proposal (`IPD_BED_FLOW_REASONS`); how long the bed has been free is
 * computed at read time (`freeMinutes`), never stored.
 *
 * WITHDRAWAL is computed on read: the open proposal ends `withdrawn` when its bed is taken, blocked or no longer
 * rule-valid, when an older request now has it, or when the admission left the waiting list (cancelled → by
 * `cancel_admission` itself; placed → `settleBedProposalIn` in the act). Proposals are remembered in
 * `ipd_bed_proposals` only so acceptance and override can be counted (`goals/bed-flow-queries.ts`).
 *
 * CONFIRM is the existing `reserve_bed` intent on the proposed bed (DECIDED): a waiting request is not yet admitted, and
 * `assign_bed` refuses one (`admission_wrong_state`, placement happens at `admit`); the hold is what puts the bed in the
 * patient's name until the desk admits onto it.
 */

/** A waiting request is hot after this many minutes (the spec's budget: request → bed median ≤ 30 min). */
export const BED_FLOW_HOT_WAIT_MINUTES = 30;
const WAITING_LIMIT = 100;

type BedRow = typeof resources.$inferSelect;
type ProposalRow = typeof ipdBedProposals.$inferSelect;
type Candidate = {
  row: BedRow; attrs: IpdBedAttributes; wardName: string | null; wardDepartment: string | null;
  roomGender: "male" | "female" | "unknown" | null; freeSince: Date | null;
};
export type BedFlowEntry = { admission: AdmissionRow; proposal: IpdBedFlowProposal | null };

/**
 * Each resource's LATEST status-history instant, one indexed probe per id (`resource_status_history_resource_seq_idx`
 * on `(resource_id, seq)`), never a scan of the whole history. Shared with the cleaning card.
 */
export async function latestStatusAt(db: Db, ids: readonly string[]): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map();
  const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const rows = (await db.execute(sql`
    select b.id, h.at from unnest(array[${list}]::text[]) as b(id)
    cross join lateral (select at from resource_status_history where resource_id = b.id order by seq desc limit 1) h`)).rows as { id: string; at: Date | string }[];
  return new Map(rows.map((r) => [r.id, new Date(r.at)] as const));
}

const GENDER_REASON: Record<string, IpdBedFlowReason> = {
  male: "gender_male_bay", female: "gender_female_bay", any: "gender_any", paediatric: "gender_paediatric",
};

/** The short rules a bed passed for this need, and why it was chosen — static codes. */
function reasonsFor(c: Candidate, need: IpdBedNeed, department: string | null): IpdBedFlowReason[] {
  const out: IpdBedFlowReason[] = ["class_requested"];
  if (c.attrs.genderRule === "any" && (c.roomGender === "male" || c.roomGender === "female")) out.push(c.roomGender === "male" ? "room_shared_male" : "room_shared_female");
  else out.push(GENDER_REASON[c.attrs.genderRule] ?? "gender_any");
  if (need.isolation !== "none") out.push(`isolation_${need.isolation}`);
  if (need.icu) out.push("icu_bed");
  if (sameDepartment(c, department)) out.push("own_department");
  return out;
}

function sameDepartment(c: Candidate, department: string | null): boolean {
  return department !== null && c.wardDepartment !== null && c.wardDepartment.toUpperCase() === department.toUpperCase();
}

/** The fixed tie-break: requested class, own department's ward, free longest, code. */
function better(need: IpdBedNeed, department: string | null): (a: Candidate, b: Candidate) => number {
  const exact = (c: Candidate): number => (c.attrs.class === need.requestedClass ? 0 : 1);
  const own = (c: Candidate): number => (sameDepartment(c, department) ? 0 : 1);
  const since = (c: Candidate): number => c.freeSince?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return (a, b) => exact(a) - exact(b) || own(a) - own(b) || since(a) - since(b) || a.row.code.localeCompare(b.row.code, "en", { numeric: true });
}

/** Free (kernel `available`, no occupant), not held, not blocked, non-overflow beds with valid attributes. */
async function candidates(db: Db, at: Date): Promise<Candidate[]> {
  const free = await db.select().from(resources)
    .where(and(eq(resources.kind, "bed"), eq(resources.status, "available"), isNull(resources.occupantRef)))
    .orderBy(asc(resources.code));
  const { held, blocked } = await bedHoldsAndBlocks(db, at);
  const usable: { row: BedRow; attrs: IpdBedAttributes }[] = [];
  for (const row of free) {
    if (held.has(row.id) || blocked.has(row.id)) continue;
    const parsed = IpdBedAttributesSchema.safeParse(row.attributes);
    if (!parsed.success || parsed.data.overflow) continue;
    usable.push({ row, attrs: parsed.data });
  }
  if (usable.length === 0) return [];
  // Only the candidates' parents, then the parents of those that are rooms.
  const parentIds = [...new Set(usable.flatMap((u) => (u.row.parentId === null ? [] : [u.row.parentId])))];
  const places = new Map<string, BedRow>();
  if (parentIds.length > 0) for (const p of await db.select().from(resources).where(inArray(resources.id, parentIds))) places.set(p.id, p);
  const upper = [...new Set([...places.values()].flatMap((p) => (p.kind === "room" && p.parentId !== null ? [p.parentId] : [])))];
  if (upper.length > 0) for (const p of await db.select().from(resources).where(inArray(resources.id, upper))) places.set(p.id, p);
  const genders = await roomGendersFor(db, usable.map((u) => u.row));
  const since = await latestStatusAt(db, usable.map((u) => u.row.id));
  return usable.map(({ row, attrs }) => {
    let ward = row.parentId === null ? undefined : places.get(row.parentId);
    if (ward?.kind === "room") ward = ward.parentId === null ? undefined : places.get(ward.parentId);
    const wa = ward === undefined ? null : IpdWardAttributesSchema.safeParse(ward.attributes);
    return {
      row, attrs, wardName: ward?.name ?? null, wardDepartment: wa?.success === true ? wa.data.department : null,
      roomGender: genders.get(row.id) ?? null, freeSince: since.get(row.id) ?? null,
    };
  });
}

function valid(c: Candidate, patient: BedRulePatient, need: IpdBedNeed): boolean {
  return checkBedRules({ code: c.row.code, attributes: c.attrs }, patient, need, undefined, { roomGender: c.roomGender, mayUseOverflow: false }) === null;
}

/** Why open proposals' beds left the pool, for many beds at once (the bed's own state first, then the rules). */
async function staleReasons(db: Db, bedIds: readonly string[], at: Date): Promise<Map<string, BedFlowWithdrawReason>> {
  const out = new Map<string, BedFlowWithdrawReason>();
  if (bedIds.length === 0) return out;
  const rows = new Map((await db.select().from(resources).where(inArray(resources.id, [...bedIds]))).map((r) => [r.id, r] as const));
  const { held, blocked } = await bedHoldsAndBlocks(db, at);
  for (const id of bedIds) {
    const row = rows.get(id);
    out.set(id, row === undefined || row.status === "retired" ? "bed_not_valid"
      : row.status === "blocked" || blocked.has(id) ? "bed_blocked"
        : row.status !== "available" || row.occupantRef !== null || held.has(id) ? "bed_taken" : "bed_not_valid");
  }
  return out;
}

/** Ends these open rows `withdrawn`, one update per reason; a row another read already ended is left alone. */
async function withdrawRows(db: Db, rows: readonly { id: string; reason: BedFlowWithdrawReason }[], at: Date): Promise<void> {
  const byReason = new Map<BedFlowWithdrawReason, string[]>();
  for (const r of rows) byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r.id]);
  for (const [reason, ids] of byReason) {
    await db.update(ipdBedProposals).set({ endedAt: at, outcome: "withdrawn", withdrawReason: reason })
      .where(and(inArray(ipdBedProposals.id, ids), isNull(ipdBedProposals.endedAt)));
  }
}

/**
 * THE READ: every waiting request (oldest first) with its proposal or null. Remembers what it shows (one open row per
 * admission and per bed) and withdraws what went stale. `reader` only aliases names elsewhere; the proposal is
 * viewer-independent. Call it ONCE per request.
 */
export async function readBedFlow(db: Db, reader: Actor, at: Date = new Date()): Promise<BedFlowEntry[]> {
  const waiting = await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.state, "requested"))
    .orderBy(asc(ipdAdmissions.requestedAt), asc(ipdAdmissions.id)).limit(WAITING_LIMIT);
  const open = await db.select().from(ipdBedProposals).where(isNull(ipdBedProposals.endedAt));
  const waitingIds = new Set(waiting.map((a) => a.id));
  const withdraw: { id: string; reason: BedFlowWithdrawReason }[] = [];

  // An open proposal whose admission is no longer waiting: the act that moved it should have settled it; say so.
  const gone = open.filter((p) => !waitingIds.has(p.admissionId));
  if (gone.length > 0) {
    const states = new Map((await db.select({ id: ipdAdmissions.id, state: ipdAdmissions.state }).from(ipdAdmissions)
      .where(inArray(ipdAdmissions.id, gone.map((p) => p.admissionId)))).map((a) => [a.id, a.state] as const));
    for (const p of gone) {
      const state = states.get(p.admissionId);
      if (state === "requested") continue; // beyond the read's limit, not gone
      withdraw.push({ id: p.id, reason: state === "cancelled" ? "admission_cancelled" : "admission_left_waiting" });
    }
  }
  if (waiting.length === 0) { await withdrawRows(db, withdraw, at); return []; }

  const openBy = new Map(open.filter((p) => waitingIds.has(p.admissionId)).map((p) => [p.admissionId, p] as const));
  const pool = await candidates(db, at);
  const byId = new Map(pool.map((c) => [c.row.id, c] as const));
  const people = new Map((await getPatientSummaries(db, reader, waiting.map((a) => a.patientId))).map((p) => [p.requestedId, p] as const));
  const claimed = new Set<string>();
  const inserts: (typeof ipdBedProposals.$inferInsert)[] = [];
  const staleBeds: { id: string; bedId: string }[] = [];

  for (const a of waiting) {
    const p = people.get(a.patientId);
    const need = needOf(a);
    const patient: BedRulePatient | null = p === undefined ? null : {
      gender: p.administrativeGender === "male" || p.administrativeGender === "female" || p.administrativeGender === "other" ? p.administrativeGender : "unknown",
      ageYears: ageInYears(p.dob, at),
    };
    const fits = (c: Candidate): boolean => patient !== null && !claimed.has(c.row.id) && valid(c, patient, need);
    const current = openBy.get(a.id);
    let chosen: Candidate | undefined;
    if (current !== undefined) {
      const c = byId.get(current.bedId);
      if (c !== undefined && fits(c)) chosen = c;
      else if (c !== undefined) withdraw.push({ id: current.id, reason: claimed.has(c.row.id) ? "bed_given_to_earlier_request" : "bed_not_valid" });
      else staleBeds.push({ id: current.id, bedId: current.bedId });
    }
    if (chosen === undefined) {
      chosen = pool.filter(fits).sort(better(need, a.department))[0];
      if (chosen !== undefined) {
        inserts.push({
          id: newId(), admissionId: a.id, patientId: a.patientId, bedId: chosen.row.id, bedCode: chosen.row.code,
          reasons: reasonsFor(chosen, need, a.department), proposedAt: at,
        });
      }
    }
    if (chosen !== undefined) claimed.add(chosen.row.id);
  }

  const reasons = await staleReasons(db, staleBeds.map((s) => s.bedId), at);
  for (const s of staleBeds) withdraw.push({ id: s.id, reason: reasons.get(s.bedId) ?? "bed_not_valid" });
  await withdrawRows(db, withdraw, at);
  // One insert; a conflict (a concurrent read holds that admission or that bed) leaves no row of ours — no proposal.
  if (inserts.length > 0) await db.insert(ipdBedProposals).values(inserts).onConflictDoNothing();

  const live = new Map<string, ProposalRow>((await db.select().from(ipdBedProposals)
    .where(and(inArray(ipdBedProposals.admissionId, [...waitingIds]), isNull(ipdBedProposals.endedAt)))).map((r) => [r.admissionId, r] as const));
  return waiting.map((a) => {
    const row = live.get(a.id);
    if (row === undefined) return { admission: a, proposal: null };
    const c = byId.get(row.bedId);
    return {
      admission: a,
      proposal: {
        proposalId: row.id, admissionId: a.id, patientId: a.patientId, need: needOf(a), bedId: row.bedId, bedCode: row.bedCode,
        wardName: c?.wardName ?? null, class: c?.attrs.class ?? needOf(a).requestedClass, reasons: row.reasons as IpdBedFlowReason[],
        department: a.department, freeMinutes: c?.freeSince == null ? null : Math.max(0, Math.floor((at.getTime() - c.freeSince.getTime()) / 60_000)),
        proposedAt: row.proposedAt.toISOString(),
      },
    };
  });
}
