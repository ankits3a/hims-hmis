import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { IPD_BED_CLASS_INFO, newId } from "@hmis/contracts";
import { ipdAdmissions, ipdBedBlocks, ipdBedProposals, ipdBedReservations, resourceStatusHistory, resources } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { needOf } from "./admission-core";
import { IpdBedAttributesSchema, IpdWardAttributesSchema } from "./bed-attributes";
import { withdrawBedProposalIn } from "./bed-flow-log";
import { ageInYears, checkBedRules } from "./bed-rules";
import { roomGendersFor } from "./beds";
import type { Actor, IpdBedFlowProposal, IpdBedNeed } from "@hmis/contracts";
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
type Candidate = {
  row: BedRow; attrs: IpdBedAttributes; wardName: string | null; wardDepartment: string | null;
  roomGender: "male" | "female" | "unknown" | null; freeSince: Date | null;
};
export type BedFlowEntry = { admission: AdmissionRow; proposal: IpdBedFlowProposal | null };

const GENDER_WORDS: Record<string, string> = { male: "Male bay", female: "Female bay", any: "Any gender", paediatric: "Paediatric bed" };

function durationWords(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} min`;
  const h = Math.floor(minutes / 60);
  return h < 48 ? `${String(h)} h ${String(minutes % 60)} min` : `${String(Math.floor(h / 24))} days`;
}

/** The short rules a bed passed for this need, and why it was chosen, in words. */
function reasonsFor(c: Candidate, need: IpdBedNeed, department: string | null, at: Date): string[] {
  const out = [`${IPD_BED_CLASS_INFO[c.attrs.class].label} bed — as requested`];
  if (c.attrs.genderRule === "any" && c.roomGender !== null) out.push(`Shared room is ${c.roomGender}`);
  else out.push(GENDER_WORDS[c.attrs.genderRule] ?? c.attrs.genderRule);
  if (need.isolation !== "none") out.push(`Isolation: ${c.attrs.isolation}${need.isolation === "airborne" ? ", negative pressure" : ""}`);
  if (need.icu) out.push("ICU bed");
  if (sameDepartment(c, department)) out.push(`${department!.toUpperCase()} ward`);
  if (c.freeSince !== null) out.push(`Free ${durationWords(Math.max(0, Math.floor((at.getTime() - c.freeSince.getTime()) / 60_000)))}`);
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

/** Free, unheld, unblocked, non-overflow beds with valid attributes, with their ward, room gender and free-since. */
async function candidates(db: Db): Promise<Candidate[]> {
  const free = await db.select().from(resources)
    .where(and(eq(resources.kind, "bed"), eq(resources.status, "available"), isNull(resources.occupantRef)))
    .orderBy(asc(resources.code));
  const held = new Set((await db.select({ bedId: ipdBedReservations.bedId }).from(ipdBedReservations)
    .where(eq(ipdBedReservations.status, "active"))).map((r) => r.bedId));
  const blocked = new Set((await db.select({ bedId: ipdBedBlocks.bedId }).from(ipdBedBlocks)
    .where(inArray(ipdBedBlocks.status, ["pending_release", "active"]))).map((r) => r.bedId));
  const usable: { row: BedRow; attrs: IpdBedAttributes }[] = [];
  for (const row of free) {
    if (held.has(row.id) || blocked.has(row.id)) continue;
    const parsed = IpdBedAttributesSchema.safeParse(row.attributes);
    if (!parsed.success || parsed.data.overflow) continue;
    usable.push({ row, attrs: parsed.data });
  }
  if (usable.length === 0) return [];
  const places = new Map((await db.select().from(resources).where(inArray(resources.kind, ["ward", "hall", "room"]))).map((r) => [r.id, r] as const));
  const genders = await roomGendersFor(db, usable.map((u) => u.row));
  const since = new Map<string, Date>();
  for (const h of await db.selectDistinctOn([resourceStatusHistory.resourceId], { id: resourceStatusHistory.resourceId, at: resourceStatusHistory.at })
    .from(resourceStatusHistory).where(inArray(resourceStatusHistory.resourceId, usable.map((u) => u.row.id)))
    .orderBy(resourceStatusHistory.resourceId, desc(resourceStatusHistory.seq))) since.set(h.id, h.at);
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

/** Why an open proposal's bed is no longer its proposal (the bed's own state first, then the rules). */
async function staleReason(db: Db, bedId: string): Promise<BedFlowWithdrawReason> {
  const row = (await db.select().from(resources).where(eq(resources.id, bedId)))[0];
  if (row === undefined || row.status === "retired") return "bed_not_valid";
  if (row.status === "blocked") return "bed_blocked";
  const block = (await db.select({ id: ipdBedBlocks.id }).from(ipdBedBlocks)
    .where(and(eq(ipdBedBlocks.bedId, bedId), inArray(ipdBedBlocks.status, ["pending_release", "active"]))))[0];
  if (block !== undefined) return "bed_blocked";
  if (row.status !== "available" || row.occupantRef !== null) return "bed_taken";
  const hold = (await db.select({ id: ipdBedReservations.id }).from(ipdBedReservations)
    .where(and(eq(ipdBedReservations.bedId, bedId), eq(ipdBedReservations.status, "active"))))[0];
  return hold !== undefined ? "bed_taken" : "bed_not_valid";
}

/**
 * THE READ: every waiting request (oldest first) with its proposal or null. Remembers what it shows (one open row per
 * admission) and withdraws what went stale. `reader` only aliases names elsewhere; the proposal is viewer-independent.
 */
export async function readBedFlow(db: Db, reader: Actor, at: Date = new Date()): Promise<BedFlowEntry[]> {
  const waiting = await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.state, "requested"))
    .orderBy(asc(ipdAdmissions.requestedAt), asc(ipdAdmissions.id)).limit(WAITING_LIMIT);
  const open = await db.select().from(ipdBedProposals).where(isNull(ipdBedProposals.endedAt));
  const waitingIds = new Set(waiting.map((a) => a.id));
  // An open proposal whose admission is no longer waiting: the act that moved it should have settled it; say so.
  for (const p of open) {
    if (waitingIds.has(p.admissionId)) continue;
    const a = (await db.select({ state: ipdAdmissions.state }).from(ipdAdmissions).where(eq(ipdAdmissions.id, p.admissionId)))[0];
    if (a?.state === "requested") continue; // beyond the read's limit, not gone
    await withdrawBedProposalIn(db, p.admissionId, a?.state === "cancelled" ? "admission_cancelled" : "admission_left_waiting", at);
  }
  if (waiting.length === 0) return [];

  const openBy = new Map(open.filter((p) => waitingIds.has(p.admissionId)).map((p) => [p.admissionId, p] as const));
  const pool = await candidates(db);
  const byId = new Map(pool.map((c) => [c.row.id, c] as const));
  const people = new Map((await getPatientSummaries(db, reader, waiting.map((a) => a.patientId))).map((p) => [p.requestedId, p] as const));
  const claimed = new Set<string>();
  const out: BedFlowEntry[] = [];

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
      if (c !== undefined && fits(c)) {
        chosen = c;
      } else {
        const reason: BedFlowWithdrawReason = c !== undefined && claimed.has(c.row.id) ? "bed_given_to_earlier_request"
          : c !== undefined ? "bed_not_valid" : await staleReason(db, current.bedId);
        await withdrawBedProposalIn(db, a.id, reason, at);
      }
    }
    chosen ??= pool.filter(fits).sort(better(need, a.department))[0];
    if (chosen === undefined) { out.push({ admission: a, proposal: null }); continue; }
    claimed.add(chosen.row.id);

    let row = current !== undefined && current.bedId === chosen.row.id ? current : undefined;
    if (row === undefined) {
      await db.insert(ipdBedProposals).values({
        id: newId(), admissionId: a.id, patientId: a.patientId, bedId: chosen.row.id, bedCode: chosen.row.code,
        reasons: reasonsFor(chosen, need, a.department, at), proposedAt: at,
      }).onConflictDoNothing();
      // A concurrent read may have recorded its own first: the open row is the proposal either way.
      row = (await db.select().from(ipdBedProposals).where(and(eq(ipdBedProposals.admissionId, a.id), isNull(ipdBedProposals.endedAt))))[0];
      if (row === undefined) { out.push({ admission: a, proposal: null }); continue; }
    }
    const shown = row.bedId === chosen.row.id ? chosen : byId.get(row.bedId) ?? chosen;
    out.push({
      admission: a,
      proposal: {
        proposalId: row.id, admissionId: a.id, patientId: a.patientId, need, bedId: row.bedId, bedCode: row.bedCode,
        wardName: shown.wardName, class: shown.attrs.class, reasons: row.reasons, proposedAt: row.proposedAt.toISOString(),
      },
    });
  }
  return out;
}
