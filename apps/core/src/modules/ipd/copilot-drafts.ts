import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { ipdCopilotDrafts, ipdNursingNotes, ipdOrders, ipdRounds, orderItems, users } from "../../kernel/db/schema";
import { buildFactSet, factsHash } from "./copilot-facts";
import { proceduresDone } from "../ot";
import { IpdError } from "./errors";
import type { IpdDraftProvenance } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * E5.3 (#740), E5.4 (#741) — reads of `ipd_copilot_drafts` and the checks a SIGNING act makes on the draft it names.
 *
 * WHAT A ROW KEEPS (review of 1f7cc591, retention): never the record's free text. A row holds the draft's provenance,
 * the fingerprint of the records it was built from, the ids of those records, and — only when a model wrote one — the
 * model's own sentence, which was checked to carry no name and was written from masked notes. The structured lines are
 * rendered again from the records whenever they are shown. So the table holds nothing the patient-record retention
 * sweep would have to find (the kernel has no table registry to add it to — `kernel/retention/sweep.ts`).
 *
 * A signing act (give a shift handover, save or sign a discharge summary) names a draft by id. The signed copy keeps
 * that id and names BOTH people: who asked for the draft (`built_by`) and who signed (the record's own signer) — they
 * may differ (a draft built for the outgoing nurse's shift).
 */
export type DraftRow = typeof ipdCopilotDrafts.$inferSelect;

/** How long a model that failed is left alone for the same records (DECIDED): no page open re-asks a down model. */
export const MODEL_COOLDOWN_MS = 5 * 60_000;
const OUTAGE_REASONS: ReadonlySet<string> = new Set(["model_down", "over_budget", "no_text", "identifier_leak"]);

/** May a model be asked again for these records? Not when a row answers them already, nor inside an outage's cooldown. */
export function mayAskAgain(row: DraftRow | undefined, hash: string, now: Date): boolean {
  if (row === undefined || row.factsHash !== hash) return true;
  if (row.fallbackReason !== null && OUTAGE_REASONS.has(row.fallbackReason)) return now.getTime() - row.builtAt.getTime() >= MODEL_COOLDOWN_MS;
  return false;
}

export async function latestDraft(db: Db | Tx, admissionId: string, kind: DraftRow["kind"], scopeKey: string): Promise<DraftRow | undefined> {
  return (await db.select().from(ipdCopilotDrafts)
    .where(and(eq(ipdCopilotDrafts.admissionId, admissionId), eq(ipdCopilotDrafts.kind, kind), eq(ipdCopilotDrafts.scopeKey, scopeKey)))
    .orderBy(desc(ipdCopilotDrafts.builtAt), desc(ipdCopilotDrafts.id)).limit(1))[0];
}

/** A draft of this admission and kind by id — what a signing act names. */
export async function draftForSigning(db: Db | Tx, draftId: string, admissionId: string, kind: "sbar" | "discharge"): Promise<DraftRow | undefined> {
  const row = (await db.select().from(ipdCopilotDrafts).where(eq(ipdCopilotDrafts.id, draftId)))[0];
  return row !== undefined && row.admissionId === admissionId && row.kind === kind ? row : undefined;
}

export async function draftProvenances(db: Db | Tx, draftIds: readonly string[], edited: ReadonlyMap<string, boolean | null> = new Map()): Promise<Map<string, IpdDraftProvenance>> {
  if (draftIds.length === 0) return new Map();
  const rows = await db.select().from(ipdCopilotDrafts).where(inArray(ipdCopilotDrafts.id, [...new Set(draftIds)]));
  const names = new Map((await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.builtBy))])))
    .map((u) => [u.id, u.name] as const));
  return new Map(rows.map((r) => [r.id, {
    draftId: r.id, source: r.source as "template" | "model", modelId: r.modelId, promptVersion: r.promptVersion, builtAt: r.builtAt.toISOString(),
    builtBy: { id: r.builtBy, name: names.get(r.builtBy) ?? r.builtBy }, edited: edited.get(r.id) ?? null,
  }] as const));
}

/** The four SBAR texts as one fingerprint (whitespace and case do not count as an edit). */
export function sbarTextHash(sbar: { situation: string; background: string; assessment: string; recommendation: string }): string {
  const flat = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update([sbar.situation, sbar.background, sbar.assessment, sbar.recommendation].map(flat).join("\u0001")).digest("hex").slice(0, 32);
}

/**
 * THE GIVE'S CHECK ON ITS DRAFT (review of 1f7cc591): the draft must be this admission's SBAR draft, and the shift's
 * records must be what they were when it was built — a new vitals set, dose, note or order since then refuses the give
 * (`shift_handover_draft_stale`: build again and read it). Answers whether the nurse changed the draft's words.
 */
export async function checkSbarDraftForGive(
  db: Db | Tx, draftId: string, a: { id: string; patientId: string }, sbar: { situation: string; background: string; assessment: string; recommendation: string }, now: Date,
): Promise<{ edited: boolean }> {
  const row = await draftForSigning(db, draftId, a.id, "sbar");
  if (row === undefined) throw new IpdError("shift_handover_draft_not_found", "No SBAR draft of this patient has that id.");
  const kept = row.content as { windowStart?: string; textHash?: string };
  const since = new Date(kept.windowStart ?? row.builtAt.toISOString());
  const current = factsHash((await buildFactSet(db as Db, a, { since, until: now })).facts);
  if (current !== row.factsHash) {
    throw new IpdError("shift_handover_draft_stale", "The records changed after this draft was built. Build the draft again and check it.", { draftId, builtAt: row.builtAt.toISOString() });
  }
  return { edited: kept.textHash !== sbarTextHash(sbar) };
}

/**
 * #794 — the discharge fingerprint is VERSIONED: the version is the hash's prefix. v1 (no prefix, 32 hex) left the
 * theatre's cases out, so a procedure recorded after the draft never made it stale. v2 adds them. A draft or a summary
 * stamped under v1 is compared with the v1 algorithm (`dischargeRecordsUnchanged`), so nothing stamped before the
 * deploy turns stale by the change of algorithm alone; its next save stamps v2.
 */
export const DISCHARGE_RECORDS_HASH_VERSION = "v2";

/** The admission fields the fingerprint reads (the stay's window and the day-care case it was converted from). */
export type RecordsAdmission = { id: string; patientId: string; admittedAt: Date | null; endedAt: Date | null; source: string; sourceRef: string | null };

/** The upper bound of a live stay's window for the theatre read: no incision is recorded in the future. */
const OPEN_STAY_UNTIL = new Date("9999-12-31T23:59:59Z");

const digest = (canon: unknown): string => createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 32);

/** The v1 parts: every order of the stay with its status, the signed rounds, the nursing notes, the lab / imaging items. */
async function recordsCanonV1(db: Db | Tx, admissionId: string): Promise<unknown[]> {
  const orders = await db.select({ id: ipdOrders.id, status: ipdOrders.status, dep: ipdOrders.departmentOrderId }).from(ipdOrders)
    .where(eq(ipdOrders.admissionId, admissionId)).orderBy(ipdOrders.id);
  const rounds = await db.select({ id: ipdRounds.id }).from(ipdRounds).where(and(eq(ipdRounds.admissionId, admissionId), eq(ipdRounds.status, "signed"))).orderBy(ipdRounds.id);
  const notes = await db.select({ id: ipdNursingNotes.id }).from(ipdNursingNotes).where(eq(ipdNursingNotes.admissionId, admissionId)).orderBy(ipdNursingNotes.id);
  const placed = orders.flatMap((o) => (o.dep === null ? [] : [o.dep]));
  const items = placed.length === 0 ? [] : await db.select({ id: orderItems.id, at: orderItems.completedAt }).from(orderItems)
    .where(and(inArray(orderItems.orderId, placed), isNull(orderItems.cancelledAt))).orderBy(orderItems.id);
  return [orders.map((o) => [o.id, o.status]), rounds.map((r) => r.id), notes.map((n) => n.id), items.map((i) => [i.id, i.at !== null])];
}

/** The theatre's cases of the stay — the same read as the drafter's `procedures` (`proceduresDone`), in the same window. */
export function dischargeProcedureWindow(a: RecordsAdmission, now: Date): Parameters<typeof proceduresDone>[1] | null {
  if (a.admittedAt === null) return null;
  return { patientId: a.patientId, from: a.admittedAt, until: a.endedAt ?? now, linkedRef: a.source === "ot_daycare_conversion" ? a.sourceRef : null };
}

/**
 * The fingerprint of what a discharge summary is drafted from (current version, `v2:` + 32 hex): every order of the stay
 * with its status, the signed rounds, the nursing notes, the lab / imaging items with whether they are reported, and the
 * theatre's cases (`proceduresDone`: case, procedure code after any conversion, incision). A summary started from a
 * draft is checked against it when it is saved and again when it is signed.
 */
export async function dischargeRecordsHash(db: Db | Tx, a: RecordsAdmission): Promise<string> {
  const window = dischargeProcedureWindow(a, OPEN_STAY_UNTIL);
  const procs = window === null ? [] : await proceduresDone(db, window);
  const canon = [...await recordsCanonV1(db, a.id), procs.map((p) => [p.caseId, p.procedureCode, p.incisionAt.toISOString()])];
  return `${DISCHARGE_RECORDS_HASH_VERSION}:${digest(canon)}`;
}

/** The v1 fingerprint (no prefix, no theatre cases) — only to compare a draft or a summary stamped before #794. */
export async function dischargeRecordsHashV1(db: Db | Tx, admissionId: string): Promise<string> {
  return digest(await recordsCanonV1(db, admissionId));
}

/** Are the stay's records still what `stored` was stamped from? Compared under the version `stored` carries. */
export async function dischargeRecordsUnchanged(db: Db | Tx, a: RecordsAdmission, stored: string | null | undefined): Promise<boolean> {
  if (typeof stored !== "string" || stored === "") return false;
  if (stored.startsWith(`${DISCHARGE_RECORDS_HASH_VERSION}:`)) return stored === await dischargeRecordsHash(db, a);
  if (stored.includes(":")) return false;
  // Review of #794: v1 never saw the theatre, so it cannot say a case was not recorded since — a stay with any case
  // (in the window the fingerprint reads) refuses a v1 stamp; the doctor builds the draft again or saves again (v2).
  const window = dischargeProcedureWindow(a, OPEN_STAY_UNTIL);
  if (window !== null && (await proceduresDone(db, window)).length > 0) return false;
  return stored === await dischargeRecordsHashV1(db, a.id);
}
