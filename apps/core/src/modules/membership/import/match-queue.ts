import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import {
  counterparties, coveredMembers, entitlementCounters, entitlementMovements, holderBookImports, invoices,
  lapsedRestoreChecks, membershipInstances, membershipPlans, opdDepartments, opdEncounters, patientMatchQueue,
  patients, users,
} from "../../../kernel/db/schema";
import { normalizeForSearch } from "../../../kernel/search/normalize";
import { appendEvent } from "../../../kernel/events/append";
import { withTx } from "../../../kernel/db/client";
import { resolvePatientId, visiblePatientIds } from "../../patients";
import { MembershipError } from "../errors";
import { instrumentHolderLinked } from "../events";
import type { Db, Tx } from "../../../kernel/db/client";

/**
 * PLAN 09 T5 — THE RECONCILE QUEUE: the one place a human decides what the importer refused to
 * guess.
 *
 * ═══ A FUZZY MATCH NEVER AUTO-LINKS, WHATEVER THE SCORE (E3) ═══
 *
 * The importer can see that "Sunanda Phatak" in a partner's drop is one edit away from a
 * "Sunandaa Phatak" this hospital already registered. It may not act on that. A wrong link is a
 * clinical record attached to the wrong person: it is invisible to the person it happened to, it
 * survives every later correction because nothing downstream doubts it, and there is no score at
 * which the consequence stops being that. So the candidates are SCORED and STORED, the instance
 * lands with a null patient, and `resolved_patient_id` is only ever written by a person.
 *
 * The queue carries three producers this phase — a fuzzy name match, O-5's cap overflow, and
 * DD9/C5's lapsed restore — and one it does not: DD11's `merge_duplicate` has no detector in
 * Plan 09, because detecting it means watching a merge execute and no task in this phase names a
 * file under `modules/patients/`. It is in the schema's own reason list and stays unowned.
 *
 * ═══ THE CANDIDATES ARE GATED WHEN THEY ARE READ, NOT WHEN THEY ARE WRITTEN ═══
 *
 * 11h's close ruled that a patient id is not a capability. The importer is a batch job and stores
 * every candidate it found; the READER runs them through `visiblePatientIds` — the patients
 * module's single gate, never re-implemented here — so a reconciler without
 * `patients.confidential.read` never learns that a confidential patient resembles this holder.
 * That is the `search-providers.ts` shape, for the same reason: one gate, in the module that owns
 * the rule.
 */

/** The four reasons the schema's own column comment lists. `merge_duplicate` has no producer yet. */
export const MATCH_QUEUE_REASONS = ["fuzzy_match", "merge_duplicate", "cap_overflow", "lapsed_restore"] as const;
export type MatchQueueReason = (typeof MATCH_QUEUE_REASONS)[number];

export type MatchCandidate = {
  patientId: string;
  /** 0..1. `similarity()`'s own number, never rounded into a band — a human sees what was measured. */
  score: number;
  /** What matched, in words. A score with no explanation is a number a desk cannot act on. */
  why: string;
};

/**
 * THE THRESHOLD IS `patients/search.ts`'s, DUPLICATED WITH ITS REASON WRITTEN DOWN.
 *
 * `patientFuzzyCondition` is private to the patients module and the module-isolation rule means it
 * cannot be imported — the same wall that already put three copies of the IST clock in this
 * repository, each with a header saying so. Copying the CONSTANT and the `%`-plus-`similarity`
 * shape keeps this lane and the palette agreeing about who resembles whom; re-deriving a threshold
 * here would have made the reconcile queue and the search box disagree about the same two names.
 *
 * `%` is what `patients_name_trgm_idx` can serve; the explicit `similarity()` pins OUR threshold so
 * the behaviour does not move with the server's `pg_trgm.similarity_threshold` GUC.
 */
export const MATCH_TRIGRAM_THRESHOLD = 0.3;

/** How many candidates one holder is worth showing. More than a handful is a listing, not a match. */
const MAX_CANDIDATES = 5;

/**
 * Who in this hospital resembles this holder?
 *
 * NAME ONLY, AND DELIBERATELY NOT PHONE. An Indian family shares one mobile number: father,
 * mother, two children and a grandparent on the same handset is the ordinary case, not the edge
 * one. A phone lane here would file a queue row for every member of every family in the drop and
 * bury the real matches under them — which is the same failure as auto-linking, arriving as noise
 * instead of as a wrong link.
 */
export async function findPatientCandidates(db: Db | Tx, holderName: string): Promise<MatchCandidate[]> {
  const folded = normalizeForSearch(holderName);
  if (folded.length < 2) return [];
  const rows = await db
    .select({
      id: patients.id,
      name: patients.name,
      score: sql<number>`similarity(lower(${patients.name}), ${folded})`,
    })
    .from(patients)
    .where(
      and(
        eq(patients.status, "active"),
        sql`lower(${patients.name}) % ${folded}`,
        sql`similarity(lower(${patients.name}), ${folded}) > ${MATCH_TRIGRAM_THRESHOLD}`,
      ),
    )
    .orderBy(desc(sql`similarity(lower(${patients.name}), ${folded})`), asc(patients.id))
    .limit(MAX_CANDIDATES);
  /**
   * PLAN 09 CLOSE, INDEPENDENT REVIEW MINOR 3 — THE STORED REASON CARRIES NO PATIENT NAME.
   *
   * It used to read `… resembles registered patient "<their name>"`. That denormalised the
   * confidential fact ITSELF into another module's table. The READER is gated correctly —
   * `listMatchQueue` calls `visiblePatientIds` once per page and filters before it joins names —
   * so there was no API leak. But 11h's ruling that "a patient id is not a capability" was about
   * IDS: an id is opaque and useless without a permitted route, and a NAME is neither. Any future
   * reader of this column that forgets the gate would leak the name rather than an opaque id, and
   * this lane is one of the two that ship UNFLAGGED.
   *
   * The name was also redundant: `listMatchQueue` re-reads names from `patients` through its own
   * gated `byId` map, so the queue screen renders exactly what it rendered before.
   *
   * The HOLDER's name stays — it comes from the partner's own file, not from a patient record.
   */
  return rows.map((r) => ({
    patientId: r.id,
    score: Number(r.score),
    why: `holder name "${holderName}" resembles a registered patient (trigram ${Number(r.score).toFixed(2)})`,
  }));
}

export type EnqueueInput = {
  instanceId: string;
  memberId?: string | null;
  reason: MatchQueueReason;
  candidates: MatchCandidate[];
  note?: string;
};

/** Writes inside the caller's transaction: a queue row for a drop that rolled back would be a lie. */
export async function enqueueMatches(tx: Tx, rows: readonly EnqueueInput[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const values = rows.map((r) => ({
    id: newId(),
    instanceId: r.instanceId,
    memberId: r.memberId ?? null,
    reason: r.reason,
    candidates: r.candidates,
    state: "open",
    note: r.note ?? null,
  }));
  await tx.insert(patientMatchQueue).values(values);
  return values.map((v) => v.id);
}

/**
 * ═══ UX-AUDIT 2026-09-28 · BOARD — THE CARD BESIDE EACH PATIENT, FIELD BY FIELD ═══
 *
 * The owner-approved reconcile board (`docs/design/2026-09-28-ux-audit/card-reconcile.html`) lays
 * the holder beside each look-alike patient — name, age/DOB, sex, mobile — each marked agrees /
 * differs / not on the card, with an "n of 4" count and a strength in WORDS (owner, 28-Sep-2026:
 * Strong / Possible / Weak, never a decimal). The band is computed HERE, not in the browser, so the
 * screen and the resolve refusal below can never disagree about which link is weak.
 *
 * WHAT THE CARD CARRIES: the holder book's column map has name and phone and no DOB or sex (the owner
 * ruled partners are merely ASKED for them; no code). So `dob` and `sex` are `not_on_card` on every
 * row today, and — by the board's own rule — no match reaches Strong until a partner sends a DOB.
 * The comparison takes them anyway, so the day a column map carries them nothing here changes.
 *
 * THE MOBILE IS NEVER SENT WHOLE. It is compared here and leaves as `98••• ••127` (the board's mask);
 * a shared family phone is the ordinary case, which is why a mobile alone can never make a match
 * Strong.
 */
export type FieldMark = "agrees" | "differs" | "not_on_card" | "not_on_record";
export type MatchStrength = "strong" | "possible" | "weak";
export type CandidateComparison = {
  name: FieldMark; dob: FieldMark; sex: FieldMark; mobile: FieldMark;
  /** How many of the four agree — the board's "n of 4". */
  agrees: number;
  strength: MatchStrength;
};

/** The similarity at or above which two names "agree" — close, not merely resembling (0.3 files the row). */
export const NAME_CLOSE_THRESHOLD = 0.5;

function nameTokens(name: string): string[] {
  return normalizeForSearch(name).split(" ").filter((w) => w.length > 0);
}

/** One name's words all present in the other's — "Suresh Yadav" inside "Suresh Kumar Yadav". */
function namesNest(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const [short, long] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return short.length >= 2 && short.every((w) => long.has(w));
}

function lastTen(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function isoDay(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** The board's mask: the first two and the last three digits, `98••• ••127`. Null when there is none. */
export function maskMobile(phone: string | null | undefined): string | null {
  const ten = lastTen(phone);
  if (ten === null) return null;
  return `${ten.slice(0, 2)}\u2022\u2022\u2022 \u2022\u2022${ten.slice(7)}`;
}

export type HolderFacts = { name: string; dob: Date | string | null; sex: string | null; phone: string | null };
export type PatientFacts = { name: string; dob: Date | string | null; sex: string | null; phone: string | null };

/**
 * The comparison and the band. Weak = the name is only loose, or a sex / DOB the card DOES carry
 * differs. Strong = name, DOB and mobile all agree. Everything else is Possible. The band never
 * pre-selects anything; it decides only whether a link needs a stated proof (see `resolveMatch`).
 */
export function compareCandidate(holder: HolderFacts, patient: PatientFacts, score: number): CandidateComparison {
  const name: FieldMark =
    normalizeForSearch(holder.name) === normalizeForSearch(patient.name)
      || namesNest(holder.name, patient.name) || score >= NAME_CLOSE_THRESHOLD
      ? "agrees" : "differs";
  const hDob = isoDay(holder.dob);
  const pDob = isoDay(patient.dob);
  const dob: FieldMark = hDob === null ? "not_on_card" : pDob === null ? "not_on_record" : hDob === pDob ? "agrees" : "differs";
  const hSex = holder.sex === null || holder.sex === "" || holder.sex === "unknown" ? null : holder.sex.toLowerCase();
  const pSex = patient.sex === null || patient.sex === "" || patient.sex === "unknown" ? null : patient.sex.toLowerCase();
  const sex: FieldMark = hSex === null ? "not_on_card" : pSex === null ? "not_on_record" : hSex === pSex ? "agrees" : "differs";
  const hPh = lastTen(holder.phone);
  const pPh = lastTen(patient.phone);
  const mobile: FieldMark = hPh === null ? "not_on_card" : pPh === null ? "not_on_record" : hPh === pPh ? "agrees" : "differs";
  const agrees = [name, dob, sex, mobile].filter((m) => m === "agrees").length;
  const strength: MatchStrength =
    name === "differs" || dob === "differs" || sex === "differs"
      ? "weak"
      : name === "agrees" && dob === "agrees" && mobile === "agrees" ? "strong" : "possible";
  return { name, dob, sex, mobile, agrees, strength };
}

export type MatchQueueCandidate = MatchCandidate & {
  patientName: string;
  uhid: string;
  /** UX-AUDIT 2026-09-28 · BOARD — the patient's side of the comparison. */
  dob: string | null;
  dobEstimated: boolean;
  sex: string | null;
  mobileMasked: string | null;
  district: string | null;
  lastVisit: { on: string; department: string | null } | null;
  comparison: CandidateComparison;
};

export type MatchQueueItem = {
  id: string;
  instanceId: string;
  memberId: string | null;
  reason: string;
  state: string;
  cardCode: string;
  holderName: string;
  planTitle: string;
  /** Already gated: a candidate this caller may not see is not in this array and was not counted. */
  candidates: MatchQueueCandidate[];
  note: string | null;
  at: Date;
  /** UX-AUDIT 2026-09-28 · BOARD — the card's side: who, how to reach them (masked), when valid. */
  holder: {
    /** The person this row is about: the covered member when there is one, else the holder. */
    subjectName: string;
    relation: string | null;
    mobileMasked: string | null;
    dob: string | null;
    sex: string | null;
    validFrom: Date;
    validTo: Date;
    partnerName: string | null;
    cameIn: { fileName: string; on: Date } | null;
    familyCap: number;
    members: { memberNo: number; name: string; relation: string | null; honoured: boolean }[];
  };
  dismissReason: string | null;
};

/** DD9/C5 — a restore against a counter whose own validity had lapsed. A FLAG, never a queue row. */
export type LapsedRestoreItem = {
  movementId: string;
  instanceId: string;
  cardCode: string;
  holderName: string;
  benefitKey: string;
  invoiceId: string | null;
  at: Date;
  /** UX-AUDIT 2026-09-28 · BOARD — the restore in words: the benefit's title, the bill, the dates, who. */
  benefitTitle: string;
  invoiceNo: string | null;
  cardEndedOn: Date;
  givenBackBy: string;
  givenBackReason: string | null;
};

/** UX-AUDIT 2026-09-28 · BOARD — the four answers to "None of these…". */
export const DISMISS_REASONS = ["different_people", "not_registered", "partner_file_wrong", "other"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

function parseCandidates(raw: unknown): MatchCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: MatchCandidate[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { patientId, score, why } = entry as { patientId?: unknown; score?: unknown; why?: unknown };
    if (typeof patientId !== "string" || patientId === "") continue;
    out.push({
      patientId,
      score: typeof score === "number" ? score : 0,
      why: typeof why === "string" ? why : "",
    });
  }
  return out;
}

/**
 * The open worklist, oldest first — a reconcile queue is worked in arrival order, and `seq` is the
 * only column that can say what that was (§3.26: a ULID cannot).
 */
export async function listMatchQueue(
  db: Db,
  actor: Actor,
  opts: { state?: "open" | "resolved" | "dismissed"; limit?: number } = {},
): Promise<MatchQueueItem[]> {
  const cap = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      id: patientMatchQueue.id,
      instanceId: patientMatchQueue.instanceId,
      memberId: patientMatchQueue.memberId,
      reason: patientMatchQueue.reason,
      state: patientMatchQueue.state,
      candidates: patientMatchQueue.candidates,
      note: patientMatchQueue.note,
      dismissReason: patientMatchQueue.dismissReason,
      at: patientMatchQueue.at,
      cardCode: membershipInstances.cardCode,
      holderName: membershipInstances.holderName,
      planTitle: membershipPlans.title,
    })
    .from(patientMatchQueue)
    .innerJoin(membershipInstances, eq(membershipInstances.id, patientMatchQueue.instanceId))
    .innerJoin(membershipPlans, eq(membershipPlans.id, membershipInstances.planId))
    .where(eq(patientMatchQueue.state, opts.state ?? "open"))
    .orderBy(asc(patientMatchQueue.seq))
    .limit(cap);

  const parsed = rows.map((r) => ({ row: r, candidates: parseCandidates(r.candidates) }));
  const allIds = [...new Set(parsed.flatMap((p) => p.candidates.map((c) => c.patientId)))];
  // ONE gate call for the whole page, and it is the patients module's own.
  const visibleIds = await visiblePatientIds(db, actor, allIds);
  const visible = new Set(visibleIds);
  // UX-AUDIT 2026-09-28 · BOARD — only VISIBLE ids are read at all: a hidden patient's DOB, phone
  // and district are never fetched, so no later edit to the mapping below can leak them.
  const byId = await patientFactsById(db, visibleIds);
  const subjects = await holderSubjects(db, parsed.map((p) => p.row));

  return parsed.map(({ row, candidates }) => {
    const subject = subjects.get(row.id)!;
    return {
      id: row.id,
      instanceId: row.instanceId,
      memberId: row.memberId,
      reason: row.reason,
      state: row.state,
      cardCode: row.cardCode,
      holderName: row.holderName,
      planTitle: row.planTitle,
      candidates: candidates
        .filter((c) => visible.has(c.patientId) && byId.has(c.patientId))
        .map((c) => {
          const p = byId.get(c.patientId)!;
          return {
            ...c,
            patientName: p.name,
            uhid: p.uhid,
            dob: isoDay(p.dob),
            dobEstimated: p.dobEstimated,
            sex: p.sex,
            mobileMasked: maskMobile(p.phone),
            district: p.district,
            lastVisit: p.lastVisit,
            comparison: compareCandidate(subject.facts, p, c.score),
          };
        }),
      note: row.note,
      at: row.at,
      holder: subject.wire,
      dismissReason: row.dismissReason,
    };
  });
}

type PatientRowFacts = PatientFacts & {
  uhid: string; dobEstimated: boolean; district: string | null;
  lastVisit: { on: string; department: string | null } | null;
};

/**
 * The patient side, for ids the gate has ALREADY passed. Reads `patients` the way this file always
 * has (the kernel schema, behind `visiblePatientIds`), plus each patient's latest OPD visit.
 */
async function patientFactsById(db: Db | Tx, ids: string[]): Promise<Map<string, PatientRowFacts>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: patients.id, name: patients.name, uhid: patients.uhid, dob: patients.dob,
      dobEstimated: patients.dobEstimated, sex: patients.administrativeGender, phone: patients.phone,
      district: patients.district,
    })
    .from(patients)
    .where(inArray(patients.id, ids));
  const visits = await db
    .selectDistinctOn([opdEncounters.patientId], {
      patientId: opdEncounters.patientId, on: opdEncounters.serviceDate, department: opdDepartments.name,
    })
    .from(opdEncounters)
    .leftJoin(opdDepartments, eq(opdDepartments.id, opdEncounters.departmentId))
    .where(inArray(opdEncounters.patientId, ids))
    .orderBy(opdEncounters.patientId, desc(opdEncounters.serviceDate), desc(opdEncounters.id));
  const lastVisit = new Map(visits.map((v) => [v.patientId, { on: v.on, department: v.department }] as const));
  return new Map(rows.map((r) => [r.id, { ...r, lastVisit: lastVisit.get(r.id) ?? null }] as const));
}

type SubjectRow = { id: string; instanceId: string; memberId: string | null };
type Subject = { facts: HolderFacts; wire: MatchQueueItem["holder"] };

/** The card's side of each row: the holder, or the covered member the row is about. */
async function holderSubjects(db: Db | Tx, rows: readonly SubjectRow[]): Promise<Map<string, Subject>> {
  const out = new Map<string, Subject>();
  if (rows.length === 0) return out;
  const instanceIds = [...new Set(rows.map((r) => r.instanceId))];
  const instances = await db
    .select({
      id: membershipInstances.id, holderName: membershipInstances.holderName, holderPhone: membershipInstances.holderPhone,
      validFrom: membershipInstances.validFrom, validTo: membershipInstances.validTo,
      partnerName: counterparties.name, fileName: holderBookImports.fileName, importedOn: holderBookImports.startedAt,
      familyCap: membershipPlans.familyCap,
    })
    .from(membershipInstances)
    .innerJoin(membershipPlans, eq(membershipPlans.id, membershipInstances.planId))
    .leftJoin(counterparties, eq(counterparties.id, membershipInstances.counterpartyId))
    .leftJoin(holderBookImports, eq(holderBookImports.id, membershipInstances.importId))
    .where(inArray(membershipInstances.id, instanceIds));
  const members = await db
    .select({
      id: coveredMembers.id, instanceId: coveredMembers.instanceId, memberNo: coveredMembers.memberNo,
      name: coveredMembers.name, relation: coveredMembers.relation, phone: coveredMembers.phone,
      honoured: coveredMembers.honoured,
    })
    .from(coveredMembers)
    .where(inArray(coveredMembers.instanceId, instanceIds))
    .orderBy(asc(coveredMembers.memberNo));
  const instanceById = new Map(instances.map((i) => [i.id, i] as const));
  const memberById = new Map(members.map((m) => [m.id, m] as const));
  for (const row of rows) {
    const inst = instanceById.get(row.instanceId);
    if (inst === undefined) continue;
    const member = row.memberId === null ? undefined : memberById.get(row.memberId);
    const name = member?.name ?? inst.holderName;
    const phone = member?.phone ?? inst.holderPhone;
    out.set(row.id, {
      // The holder book carries no DOB or sex (owner, 28-Sep-2026: partners are ASKED, no code).
      facts: { name, dob: null, sex: null, phone },
      wire: {
        subjectName: name,
        relation: member?.relation ?? null,
        mobileMasked: maskMobile(phone),
        dob: null,
        sex: null,
        validFrom: inst.validFrom,
        validTo: inst.validTo,
        partnerName: inst.partnerName,
        cameIn: inst.fileName === null || inst.importedOn === null ? null : { fileName: inst.fileName, on: inst.importedOn },
        familyCap: inst.familyCap,
        members: members
          .filter((m) => m.instanceId === row.instanceId)
          .map((m) => ({ memberNo: m.memberNo, name: m.name, relation: m.relation, honoured: m.honoured })),
      },
    });
  }
  return out;
}

/**
 * DD9/C5 — the lapsed restores, read from the FLAG rather than from a queue row.
 *
 * T4 writes `entitlement_movements.lapsed_restore = true` and no queue row, because DD9's own
 * words are *"the flag is what the reconcile queue shows"*. Nothing else in the repository surfaces
 * it, so this reader is what makes that sentence true. It is a READ of another lane's append-only
 * log and writes nothing.
 */
export async function listLapsedRestores(db: Db, limit = 50): Promise<LapsedRestoreItem[]> {
  const cap = Math.min(Math.max(limit, 1), 200);
  const rows = await db
    .select({
      movementId: entitlementMovements.id,
      instanceId: entitlementCounters.instanceId,
      benefitKey: entitlementCounters.benefitKey,
      invoiceId: entitlementMovements.invoiceId,
      at: entitlementMovements.at,
      cardCode: membershipInstances.cardCode,
      holderName: membershipInstances.holderName,
      // UX-AUDIT 2026-09-28 · BOARD — words and dates, not a key.
      planBenefits: membershipPlans.benefits,
      invoiceNo: invoices.invoiceNo,
      cardEndedOn: membershipInstances.validTo,
      actorId: entitlementMovements.actorId,
      actorName: users.fullName,
      givenBackReason: entitlementMovements.reason,
    })
    .from(entitlementMovements)
    .innerJoin(entitlementCounters, eq(entitlementCounters.id, entitlementMovements.counterId))
    .innerJoin(membershipInstances, eq(membershipInstances.id, entitlementCounters.instanceId))
    .innerJoin(membershipPlans, eq(membershipPlans.id, membershipInstances.planId))
    .leftJoin(invoices, eq(invoices.id, entitlementMovements.invoiceId))
    .leftJoin(users, eq(users.id, entitlementMovements.actorId))
    // A restore somebody has marked checked has left the queue; its row stays, append-only.
    .leftJoin(lapsedRestoreChecks, eq(lapsedRestoreChecks.movementId, entitlementMovements.id))
    .where(and(eq(entitlementMovements.lapsedRestore, true), isNull(lapsedRestoreChecks.movementId)))
    .orderBy(desc(entitlementMovements.seq))
    .limit(cap);
  return rows.map(({ planBenefits, actorId, actorName, ...r }) => ({
    ...r,
    benefitTitle: benefitTitle(planBenefits, r.benefitKey),
    givenBackBy: actorName ?? actorId,
  }));
}

/**
 * The plan's own title for a counter's key — "Free OPD consultation", never "consult-visits". Read
 * leniently: a plan whose terms do not name this key shows the key with its punctuation softened,
 * because a lapsed restore that cannot be named must still be shown.
 */
function benefitTitle(raw: unknown, key: string): string {
  if (Array.isArray(raw)) {
    for (const term of raw) {
      if (typeof term !== "object" || term === null) continue;
      const { benefitKey, title } = term as { benefitKey?: unknown; title?: unknown };
      if (benefitKey === key && typeof title === "string" && title.trim() !== "") return title;
    }
  }
  return key.replace(/[-_]+/g, " ");
}

/**
 * ═══ UX-AUDIT 2026-09-28 · BOARD — "MARK CHECKED" ═══
 *
 * Until now nothing on any screen could clear a lapsed flag; the list only grew. This writes one row
 * naming who looked (the flag itself is on an append-only log and is never touched), and refuses a
 * movement that is not a flagged restore — a check against an ordinary restore would be a lie about
 * what was looked at.
 *
 * THE OWNER'S RULING (28-Sep-2026, money): a benefit given back to a card that has ENDED is usable
 * only once the card is renewed. The restore logic is `entitlements.ts`'s `restoreEntitlements`: the
 * unit lands on the ENDED counter, and `consumeEntitlements` refuses any counter outside its validity
 * (`counter_lapsed`), so the unit cannot be used while the card stays ended. There is no renewal path
 * in the repository yet (no writer extends a counter or carries a unit to a new instance); carrying
 * the unit onto a renewed card is owed to whoever builds renewal. Marking checked changes neither.
 */
export async function markLapsedRestoreChecked(
  db: Db,
  actor: Actor,
  input: { movementId: string },
  now: Date = new Date(),
): Promise<{ movementId: string; checkedAt: Date }> {
  const found = await db
    .select({ id: entitlementMovements.id, lapsed: entitlementMovements.lapsedRestore, kind: entitlementMovements.kind })
    .from(entitlementMovements)
    .where(eq(entitlementMovements.id, input.movementId));
  const movement = found[0];
  if (movement === undefined || !movement.lapsed || movement.kind !== "restore") {
    throw new MembershipError("lapsed_restore_unknown", `no lapsed restore ${input.movementId}`);
  }
  const written = await db
    .insert(lapsedRestoreChecks)
    .values({ movementId: input.movementId, checkedBy: actor.id, checkedAt: now })
    .onConflictDoNothing({ target: lapsedRestoreChecks.movementId })
    .returning({ movementId: lapsedRestoreChecks.movementId });
  if (written.length === 0) {
    throw new MembershipError("match_already_resolved", `lapsed restore ${input.movementId} was already checked`);
  }
  return { movementId: input.movementId, checkedAt: now };
}

/**
 * The stored reason, narrowed to the event's own enum. A row whose reason is not one of the four is
 * impossible today (the schema comment lists exactly these) — but the event schema would THROW on
 * it at append time and take the human's decision down with it, so an unrecognised word is carried
 * as the one that says least rather than as a crash inside somebody's click.
 */
function queueReason(raw: string): MatchQueueReason {
  return (MATCH_QUEUE_REASONS as readonly string[]).includes(raw) ? (raw as MatchQueueReason) : "fuzzy_match";
}

export type ResolveMatchInput = {
  queueItemId: string;
  patientId: string;
  note?: string;
  /** UX-AUDIT 2026-09-28 · BOARD — the clerk's tick that a WEAK link is permanent and carries their name. */
  confirmWeak?: boolean;
};

/**
 * A HUMAN LINKS THE HOLDER. This is the only writer of `membership_instances.patient_id` outside
 * the grace-honor path, and it refuses any patient the queue row did not offer.
 *
 * ═══ THE PATIENT ID IS RESOLVED THROUGH THE MERGE CHAIN (DD11) ═══
 *
 * Merge never rewrites another module's rows, so a candidate recorded before a merge names the
 * LOSER. Linking to a merged-away record would put the card on a patient who is no longer anybody
 * — invisible at the counter, exactly the outcome DD11 exists to prevent — so the decision is
 * recorded against the id the human chose and the LINK is written to the survivor.
 */
export async function resolveMatch(
  db: Db,
  actor: Actor,
  input: ResolveMatchInput,
  now: Date = new Date(),
): Promise<{ queueItemId: string; instanceId: string; patientId: string }> {
  const rows = await db
    .select({
      id: patientMatchQueue.id,
      instanceId: patientMatchQueue.instanceId,
      memberId: patientMatchQueue.memberId,
      reason: patientMatchQueue.reason,
      state: patientMatchQueue.state,
      candidates: patientMatchQueue.candidates,
    })
    .from(patientMatchQueue)
    .where(eq(patientMatchQueue.id, input.queueItemId));
  const item = rows[0];
  if (item === undefined) {
    throw new MembershipError("match_candidate_unknown", `no reconcile queue item ${input.queueItemId}`);
  }
  if (item.state !== "open") {
    throw new MembershipError("match_already_resolved", `queue item ${input.queueItemId} is already ${item.state}`);
  }
  const offered = parseCandidates(item.candidates).map((c) => c.patientId);
  if (!offered.includes(input.patientId)) {
    throw new MembershipError(
      "match_candidate_unknown",
      "that patient was not among this item's candidates",
      { offered },
    );
  }
  const visible = await visiblePatientIds(db, actor, [input.patientId]);
  if (visible.length === 0) {
    throw new MembershipError("match_candidate_unknown", "that patient is not visible to you");
  }
  /*
   * UX-AUDIT 2026-09-28 · BOARD — A WEAK LINK NEEDS A STATED PROOF AND A CONFIRM (owner, 28-Sep).
   * The band is recomputed here from the same comparison the screen was shown; the client's own
   * check is a convenience, this is the rule. The proof is the `note` the resolve always took, so it
   * is saved with the link on the queue row.
   */
  const choice = parseCandidates(item.candidates).find((c) => c.patientId === input.patientId)!;
  const subject = (await holderSubjects(db, [item])).get(item.id);
  const facts = (await patientFactsById(db, [input.patientId])).get(input.patientId);
  if (subject !== undefined && facts !== undefined
    && compareCandidate(subject.facts, facts, choice.score).strength === "weak"
    && ((input.note ?? "").trim() === "" || input.confirmWeak !== true)) {
    throw new MembershipError(
      "match_weak_needs_proof",
      "this is a weak match: say how you know it is the same person, and confirm the link carries your name",
    );
  }
  const resolved = await resolvePatientId(db, input.patientId);
  if (resolved === null) {
    // `visiblePatientIds` just answered for this id, so the row exists; `resolvePatientId` returns
    // null only for an id it cannot follow at all. Refusing beats writing a link nobody can read.
    throw new MembershipError("match_candidate_unknown", "that patient could not be resolved through the merge chain");
  }
  const survivor: string = resolved;

  await withTx(db, async (tx) => {
    // Single-winner conditional UPDATE (`sessions.ts`'s `beginClose` shape): two reconcilers
    // deciding the same item at once cannot both write, and the loser's own read said `open`.
    const claimed = await tx
      .update(patientMatchQueue)
      .set({
        state: "resolved",
        resolvedPatientId: survivor,
        resolvedBy: actor.id,
        resolvedAt: now,
        note: input.note ?? null,
      })
      .where(and(eq(patientMatchQueue.id, input.queueItemId), eq(patientMatchQueue.state, "open")))
      .returning({ id: patientMatchQueue.id });
    if (claimed.length === 0) {
      throw new MembershipError("match_already_resolved", `queue item ${input.queueItemId} was decided by somebody else`);
    }
    if (item.memberId === null) {
      await tx
        .update(membershipInstances)
        .set({ patientId: survivor })
        .where(eq(membershipInstances.id, item.instanceId));
    } else {
      await tx.update(coveredMembers).set({ patientId: survivor }).where(eq(coveredMembers.id, item.memberId));
    }
    await appendEvent(
      tx,
      instrumentHolderLinked.make({
        actor,
        occurredAt: now,
        patientId: survivor,
        payload: {
          queueItemId: input.queueItemId,
          instanceId: item.instanceId,
          patientId: survivor,
          reason: queueReason(item.reason),
        },
      }),
    );
  });
  return { queueItemId: input.queueItemId, instanceId: item.instanceId, patientId: survivor };
}

/**
 * Nothing to link — the resemblance was a coincidence, or the partner's row is simply wrong.
 *
 * UX-AUDIT 2026-09-28 · BOARD — "None of these…" asks WHY, as a code (`DISMISS_REASONS`) beside a
 * line of text. A preset reason stands alone; "other", or no code at all (the pre-board call), still
 * needs the words, because the next person to meet this holder has to know what was decided.
 */
export async function dismissMatch(
  db: Db,
  actor: Actor,
  input: { queueItemId: string; note?: string; reason?: DismissReason },
  now: Date = new Date(),
): Promise<{ queueItemId: string }> {
  const note = (input.note ?? "").trim();
  if (note === "" && (input.reason === undefined || input.reason === "other")) {
    throw new MembershipError("match_dismiss_needs_reason", "say why nobody here is the card holder");
  }
  const claimed = await db
    .update(patientMatchQueue)
    .set({
      state: "dismissed", resolvedBy: actor.id, resolvedAt: now,
      note: note === "" ? null : note, dismissReason: input.reason ?? null,
    })
    .where(and(eq(patientMatchQueue.id, input.queueItemId), eq(patientMatchQueue.state, "open")))
    .returning({ id: patientMatchQueue.id });
  if (claimed.length === 0) {
    throw new MembershipError("match_already_resolved", `queue item ${input.queueItemId} is not open`);
  }
  return { queueItemId: input.queueItemId };
}
