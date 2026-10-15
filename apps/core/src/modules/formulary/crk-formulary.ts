/**
 * ═══ #618 / DECISION 0053 — THE CRK FORMULARY: A MODEL DRAFTS, PHARMACOLOGY SIGNS ═══
 *
 * The hospital buys no drug database. A model drafts a short entry per generic from public sources the
 * hospital may legally use; a named Pharmacology reviewer edits and SIGNS it; a high-alert medicine takes a
 * SECOND signature from a different reviewer. The entry is its own row (`formulary_crk_entries`) with its
 * own state, apart from the pharmacy's monograph: a CRK act never publishes or withdraws the pharmacy's
 * sections or renal bands, and a pharmacy act never touches the CRK entry. The LIVE (signed) text and a
 * PENDING draft are separate columns, so the last signed version stays read until the next is signed.
 *
 * THE MODEL ONLY DRAFTS, and its draft is held to three rules before it is stored:
 *   1. every statement names one of the sources it was given — a statement citing anything else is dropped;
 *   2. a field with no sourced statement stays EMPTY (the screen says "no source");
 *   3. no dose: a statement carrying a strength or a per-kilogram figure is dropped. Dosing is the
 *      prescriber's and the label's, never a model's arithmetic.
 *
 * The request goes through the kernel's `InferenceClient` (`complete()`), with the source texts masked by
 * the copilot's masker and the whole prompt checked by `assertNoIdentifiers`: the inputs are public texts,
 * and that check is what keeps them so. No model configured is a supported way to run: drafting answers
 * `model_not_configured`, and a reviewer writes the entry by hand and signs it the same way.
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { IST_UTC_OFFSET_MINUTES } from "../../kernel/approvals/cumulative";
import { appendEvent } from "../../kernel/events/append";
import { assertNoIdentifiers, maskQuestion } from "../../kernel/copilot/mask";
import { formularyCrkEntries, formularyCrkSignatures, formularyGenerics, formularyMedicines } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import { crkDraftSaved, crkSigned } from "./events";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import type { Db, Tx } from "../../kernel/db/client";
import type { CrkEntry, CrkSource, CrkStatement } from "../../kernel/db/schema";
import type { InferenceClient } from "../../kernel/inference/types";

/** The plan's fields (§11c item 2), in the order the screen shows them. */
export const CRK_FIELDS = [
  "uses", "howToTake", "commonSideEffects", "seriousSideEffects", "warnings", "pregnancyBreastfeeding",
  "children", "elderlyKidneyLiver", "interactions", "storage", "patientAdviceEn", "patientAdviceHi",
] as const;
export type CrkField = (typeof CRK_FIELDS)[number];

/** Sources the hospital may use (decision 0053, plan §11a). NFI only once the IPC permits; nothing scraped. */
export const CRK_SOURCE_KINDS = ["openfda", "nhs", "ema", "medsafe", "livertox", "lactmed", "pubchem", "cdsco", "nfi"] as const;

export const CRK_REREVIEW_MONTHS = 12;
/** #884 — a signed entry may be renewed from this many days before its due date (and any time after it). */
export const CRK_RENEWAL_WINDOW_DAYS = 30;
const STATEMENT_MAX = 600;
const SOURCE_TEXT_MAX = 24_000;

/*
 * A dose, in any of its shapes: a strength or per-weight figure ("500 mg", "10 mg/kg", "0.5 ml", "100 units"),
 * a COUNT without a unit ("2 tablets", "1 tab twice", "two capsules", "1 puff"), a sig ("1-0-1"), or a
 * schedule ("every 8 hours", "3 times a day", "twice daily").
 */
const NUMBER = String.raw`(?:\d+(?:\.\d+)?|½|half|one|two|three|four|five|six)`;
const DOSE_SHAPE = new RegExp([
  String.raw`\d\s*(?:mg|mcg|µg|g|gm|ml|mL|iu|IU|units?)\b`, String.raw`mg\s*\/\s*kg`, String.raw`\/\s*kg\b`,
  String.raw`\b${NUMBER}\s*(?:tablets?|tabs?|capsules?|caps?|pills?|drops?|puffs?|sprays?|sachets?|teaspoons?|tsp|tablespoons?|spoons?|spoonfuls?|ampoules?|vials?|doses?|injections?|patch(?:es)?|suppositor(?:y|ies))\b`,
  String.raw`\b\d\s*-\s*\d\s*-\s*\d\b`,
  String.raw`\bevery\s+${NUMBER}\s*(?:to\s+${NUMBER}\s*)?(?:hours?|hrs?|h)\b`,
  String.raw`\b${NUMBER}\s*times?\s+(?:a|per|each|every)\s+(?:day|week)\b`,
  String.raw`\b(?:once|twice|thrice)\s+(?:a\s+|per\s+)?(?:day|daily|weekly)\b`,
].join("|"), "i");
/** A masking placeholder (`<<P1>>`) echoed back: the masked text, never a fact about the medicine. */
const PLACEHOLDER_ECHO = /<<\s*P\d+\s*>>/i;

export type DraftSourceInput = CrkSource & { text: string };

/** Shape check of an entry, whoever wrote it. Refuses rather than repairs: a person can fix what they typed. */
export function validateCrkEntry(entry: CrkEntry): CrkEntry {
  const refs = new Set<string>();
  for (const s of entry.sources) {
    if (s.ref.trim() === "" || refs.has(s.ref)) throw new FormularyError("invalid_crk", `source ref "${s.ref}" is empty or repeated`);
    if (!(CRK_SOURCE_KINDS as readonly string[]).includes(s.kind)) throw new FormularyError("invalid_crk", `source kind "${s.kind}" is not one the hospital may use`);
    refs.add(s.ref);
  }
  const fields: Record<string, CrkStatement[]> = {};
  for (const [field, statements] of Object.entries(entry.fields)) {
    if (!(CRK_FIELDS as readonly string[]).includes(field)) throw new FormularyError("invalid_crk", `unknown field "${field}"`);
    const kept = statements.filter((st) => st.text.trim() !== "");
    for (const st of kept) {
      if (!refs.has(st.source)) throw new FormularyError("invalid_crk", `a statement in "${field}" cites "${st.source}", which is not one of this entry's sources`);
      if (st.text.length > STATEMENT_MAX) throw new FormularyError("invalid_crk", `a statement in "${field}" is longer than ${String(STATEMENT_MAX)} characters`);
    }
    if (kept.length > 0) fields[field] = kept.map((st) => ({ text: st.text.trim(), source: st.source }));
  }
  return { sources: entry.sources, fields, combinationNote: entry.combinationNote?.trim() === "" ? null : entry.combinationNote ?? null };
}

/**
 * What the model returned, held to the three rules. Unknown fields and statements citing unknown sources
 * are DROPPED (the model is not a person who can fix them); so is a dose-shaped statement, and one that
 * echoes a masking placeholder (`<<P1>>`).
 */
export function sanitiseModelDraft(raw: unknown, sources: readonly CrkSource[]): { fields: Record<string, CrkStatement[]>; dropped: number } {
  const refs = new Set(sources.map((s) => s.ref));
  const fields: Record<string, CrkStatement[]> = {};
  let dropped = 0;
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const body = typeof obj.fields === "object" && obj.fields !== null ? (obj.fields as Record<string, unknown>) : obj;
  for (const field of CRK_FIELDS) {
    const list = body[field];
    if (!Array.isArray(list)) continue;
    const kept: CrkStatement[] = [];
    for (const item of list) {
      const st = item as { text?: unknown; source?: unknown };
      const text = typeof st.text === "string" ? st.text.trim() : "";
      const source = typeof st.source === "string" ? st.source : "";
      if (text === "" || !refs.has(source) || DOSE_SHAPE.test(text) || PLACEHOLDER_ECHO.test(text) || text.length > STATEMENT_MAX) { dropped += 1; continue; }
      kept.push({ text, source });
    }
    if (kept.length > 0) fields[field] = kept;
  }
  return { fields, dropped };
}

const SYSTEM_PROMPT = [
  "You draft one medicine's entry for a hospital formulary that a pharmacology professor will check and sign.",
  "Use ONLY the source texts given. Every statement must name the ref of the source it came from.",
  "If the sources do not say something, leave that field out. Never guess.",
  "Never state a dose, a strength or a per-kilogram figure.",
  "Write short plain sentences a nurse or patient can read on a phone. patientAdviceHi is in Hindi (Devanagari).",
  `Answer with JSON only: {"fields": {"<field>": [{"text": "...", "source": "<ref>"}]}}. Fields: ${CRK_FIELDS.join(", ")}.`,
].join("\n");

export type DraftResult = { entryId: string; statements: number; dropped: number; usage: { inputTokens: number; outputTokens: number } | null };

/**
 * Ask the model for a draft and store it as the entry's PENDING version; the live signed version, if any,
 * stays live. `client` null ⇒ `model_not_configured`, before anything is read or written.
 */
export async function draftCrkEntry(
  db: Db,
  actor: Actor,
  input: { genericSctid: string; sources: DraftSourceInput[]; combinationNote?: string | null },
  model: { client: InferenceClient | null; id: string | null },
): Promise<DraftResult> {
  if (model.client === null || model.id === null) throw new FormularyError("model_not_configured", "no drafting model is configured; write the entry by hand and sign it");
  const generic = (await db.select({ id: formularyGenerics.id, name: formularyGenerics.name })
    .from(formularyGenerics).where(eq(formularyGenerics.sctid, input.genericSctid)))[0];
  if (generic === undefined) throw new FormularyError("unknown_generic", `no generic with SNOMED CT id ${input.genericSctid}`);
  const sources: CrkSource[] = input.sources.map((s) => ({ ref: s.ref, kind: s.kind, title: s.title, url: s.url, asOf: s.asOf }));
  validateCrkEntry({ sources, fields: {}, combinationNote: null });

  const user = [
    `Medicine: ${generic.name}`,
    ...input.sources.map((s) => `--- source ref=${s.ref} (${s.kind}: ${s.title}) ---\n${maskQuestion(s.text.slice(0, SOURCE_TEXT_MAX)).masked}`),
  ].join("\n\n");
  assertNoIdentifiers(user);

  let text: string;
  let usage: DraftResult["usage"] = null;
  try {
    const res = await model.client.complete({ system: SYSTEM_PROMPT, user, maxTokens: 4000 });
    text = res.text;
    usage = res.usage ?? null;
  } catch (e) {
    throw new FormularyError("draft_failed", `the drafting model gave no answer (${e instanceof Error ? e.message : String(e)}); nothing was written`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new FormularyError("draft_failed", "the drafting model's answer was not JSON; nothing was written");
  }
  const { fields, dropped } = sanitiseModelDraft(raw, sources);
  const entry: CrkEntry = { sources, fields, combinationNote: input.combinationNote ?? null };
  const statements = Object.values(fields).reduce((n, l) => n + l.length, 0);
  const entryId = await withTx(db, (tx) => writeDraft(tx, actor, generic.id, entry, { model: model.id, usage }));
  return { entryId, statements, dropped, usage };
}

/** A person's save of the entry (no model): the PENDING version. The live signed version stays live. */
export async function saveCrkEntry(tx: Tx, actor: Actor, genericSctid: string, entry: CrkEntry): Promise<{ entryId: string }> {
  const generic = (await tx.select({ id: formularyGenerics.id }).from(formularyGenerics).where(eq(formularyGenerics.sctid, genericSctid)))[0];
  if (generic === undefined) throw new FormularyError("unknown_generic", `no generic with SNOMED CT id ${genericSctid}`);
  return { entryId: await writeDraft(tx, actor, generic.id, validateCrkEntry(entry), { model: null, usage: null }) };
}

/** A pending first signature belongs to the text it signed: a new draft clears it. */
const NO_FIRST = { firstSignedBy: null, firstSignedAt: null, firstSignerDesignation: null } as const;

async function writeDraft(
  tx: Tx, actor: Actor, genericId: string, entry: CrkEntry,
  drafted: { model: string | null; usage: { inputTokens: number; outputTokens: number } | null },
): Promise<string> {
  const held = (await tx.select({ id: formularyCrkEntries.id }).from(formularyCrkEntries)
    .where(eq(formularyCrkEntries.genericId, genericId)).for("update"))[0];
  const entryId = held?.id ?? newId();
  const now = new Date();
  const draftCols = {
    draftCrk: entry, draftedModel: drafted.model, draftedAt: drafted.model === null ? null : now, draftUsage: drafted.usage,
  };
  const spend = drafted.model === null ? {} : {
    modelDrafts: sql`${formularyCrkEntries.modelDrafts} + 1`,
    modelInputTokens: sql`${formularyCrkEntries.modelInputTokens} + ${drafted.usage?.inputTokens ?? 0}`,
    modelOutputTokens: sql`${formularyCrkEntries.modelOutputTokens} + ${drafted.usage?.outputTokens ?? 0}`,
  };
  if (held === undefined) {
    await tx.insert(formularyCrkEntries).values({
      id: entryId, genericId, ...draftCols,
      modelDrafts: drafted.model === null ? 0 : 1,
      modelInputTokens: drafted.usage?.inputTokens ?? 0, modelOutputTokens: drafted.usage?.outputTokens ?? 0,
      createdBy: actor.id, updatedBy: actor.id,
    });
  } else {
    await tx.update(formularyCrkEntries).set({ ...draftCols, ...spend, ...NO_FIRST, updatedBy: actor.id, updatedAt: now })
      .where(eq(formularyCrkEntries.id, entryId));
  }
  await appendEvent(tx, crkDraftSaved.make({
    payload: {
      entryId, genericId, draftedModel: drafted.model,
      statements: Object.values(entry.fields).reduce((n, l) => n + l.length, 0),
      inputTokens: drafted.usage?.inputTokens ?? null, outputTokens: drafted.usage?.outputTokens ?? null,
    },
    actor, correlationId: entryId,
  }));
  return entryId;
}

/** High-alert: the reviewer's flag on the entry, or any stocked item of this generic flagged high-alert. */
async function isHighAlert(tx: Tx, genericId: string, flagged: boolean): Promise<boolean> {
  if (flagged) return true;
  const rows = (await tx.execute(sql`
    select 1 from items i
      join formulary_medicines m on m.id = i.formulary_medicine_id
      join formulary_generics g on g.sctid = m.generic_sctid
     where g.id = ${genericId} and i.high_alert = true
     limit 1
  `)).rows;
  return rows.length > 0;
}

/** The hospital's clock (IST, no DST), derived from the kernel's one constant (`test/ist-clock-parity.test.ts`). */
const IST_OFFSET_MS = IST_UTC_OFFSET_MINUTES * 60_000;

/** The IST calendar date of an instant. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** #884 — past its due date. Still SHOWN (hiding it would hide safety text); labelled "review overdue". */
export function isOverdue(reviewDueOn: string | null, today: string): boolean {
  return reviewDueOn !== null && reviewDueOn < today;
}

function dueOn(from: Date): string {
  const d = new Date(from.getTime() + IST_OFFSET_MS);
  d.setUTCMonth(d.getUTCMonth() + CRK_REREVIEW_MONTHS);
  return d.toISOString().slice(0, 10);
}

export type SignResult = { status: "reviewed" | "awaiting_second"; version: number; renewal: boolean };
type SignKind = "sole" | "first" | "second" | "renewal" | "renewal_first" | "renewal_second";

/**
 * A Pharmacology reviewer's SIGNATURE on a CRK entry.
 *
 * WITH A PENDING VERSION (a draft, or edits sent with this signature, which become the draft): signing it
 * makes it live — one signature, or for a high-alert medicine two from different people. Edits always
 * restart a pair. Until then the last signed version stays live.
 *
 * WITHOUT ONE (#884): the 12-month RENEWAL of the unchanged live text, open from
 * `CRK_RENEWAL_WINDOW_DAYS` before its due date and any time after. The live text stays read throughout;
 * the due date moves 12 months from the renewal. High-alert takes two different signers again.
 *
 * The high-alert flag is the reviewer's (`highAlert` sent here sets or clears it) or any stocked item's.
 * When the entry is no longer high-alert, a waiting first signature is stale and is cleared: this
 * signature alone decides. Every signature is kept with the text it signed and is an audited event.
 */
export async function signCrkEntry(
  tx: Tx, actor: Actor, entryId: string,
  input: { designation: string; crk?: CrkEntry; highAlert?: boolean },
  now: Date = new Date(),
): Promise<SignResult> {
  if (actor.type !== "user") throw new FormularyError("attester_not_user", "only a person signs a formulary entry");
  const designation = input.designation.trim();
  if (designation === "") throw new FormularyError("invalid_crk", "a signature needs the reviewer's designation");
  let row = (await tx.select().from(formularyCrkEntries).where(eq(formularyCrkEntries.id, entryId)).for("update"))[0];
  if (row === undefined) throw new FormularyError("unknown_crk_entry", `no CRK entry ${entryId}`);
  if (input.crk !== undefined) {
    /* Edits sent with a signature are a new pending version: written first, so the pair restarts on them. */
    const edited = validateCrkEntry(input.crk);
    await tx.update(formularyCrkEntries).set({ draftCrk: edited, draftedModel: null, draftedAt: null, draftUsage: null, ...NO_FIRST, updatedBy: actor.id, updatedAt: now })
      .where(eq(formularyCrkEntries.id, entryId));
    row = { ...row, draftCrk: edited, draftedModel: null, draftedAt: null, draftUsage: null, ...NO_FIRST };
  }
  const renewal = row.draftCrk === null;
  const text = row.draftCrk ?? row.signedCrk;
  if (text === null) throw new FormularyError("crk_nothing_to_sign", "this entry has no text to sign");
  if (renewal && row.reviewDueOn !== null && istDate(now) < addDays(row.reviewDueOn, -CRK_RENEWAL_WINDOW_DAYS)) {
    throw new FormularyError("monograph_already_reviewed", `this entry is signed until ${row.reviewDueOn}; renewal opens ${String(CRK_RENEWAL_WINDOW_DAYS)} days before, and an edit is saved as a new version`);
  }
  const flagged = input.highAlert ?? row.highAlert;
  const highAlert = await isHighAlert(tx, row.genericId, flagged);
  const pendingFirst = row.firstSignedBy;

  let kind: SignKind;
  /* Not (or no longer) high-alert: this signature alone decides, and the publish below clears a stale first. */
  if (!highAlert) kind = renewal ? "renewal" : "sole";
  else if (pendingFirst === null) kind = renewal ? "renewal_first" : "first";
  else {
    if (pendingFirst === actor.id) throw new FormularyError("monograph_same_actor", "a high-alert entry needs a second signature from a different reviewer");
    kind = renewal ? "renewal_second" : "second";
  }
  const waits = kind === "first" || kind === "renewal_first";
  const version = waits ? row.version : row.version + 1;

  if (waits) {
    await tx.update(formularyCrkEntries).set({
      highAlert: flagged, firstSignedBy: actor.id, firstSignedAt: now, firstSignerDesignation: designation,
    }).where(eq(formularyCrkEntries.id, entryId));
  } else {
    const pair = kind === "second" || kind === "renewal_second";
    await tx.update(formularyCrkEntries).set({
      highAlert: flagged, signedCrk: text, version, reviewDueOn: dueOn(now),
      ...(pair
        ? {
          reviewedBy: row.firstSignedBy, reviewedAt: row.firstSignedAt, reviewerDesignation: row.firstSignerDesignation,
          secondReviewedBy: actor.id, secondReviewedAt: now, secondReviewerDesignation: designation,
        }
        : {
          reviewedBy: actor.id, reviewedAt: now, reviewerDesignation: designation,
          secondReviewedBy: null, secondReviewedAt: null, secondReviewerDesignation: null,
        }),
      /* The pending version is now live; the waiting first signature is spent (or stale). */
      draftCrk: null, draftedModel: null, draftedAt: null, draftUsage: null, ...NO_FIRST,
    }).where(eq(formularyCrkEntries.id, entryId));
  }
  await tx.insert(formularyCrkSignatures).values({
    id: newId(), entryId, version, kind, signedBy: actor.id, designation, signedAt: now, crk: text,
  });
  await appendEvent(tx, crkSigned.make({
    payload: { entryId, genericId: row.genericId, kind, version, designation, highAlert, renewal },
    actor, correlationId: entryId,
  }));
  return { status: waits ? "awaiting_second" : "reviewed", version, renewal };
}

/** The reviewer's view of one entry: the live version, the pending one, and who signed what. */
export type CrkReviewRow = typeof formularyCrkEntries.$inferSelect;

export async function crkEntryForReview(db: Db | Tx, genericSctid: string): Promise<CrkReviewRow | undefined> {
  return (await db.select({ e: formularyCrkEntries }).from(formularyCrkEntries)
    .innerJoin(formularyGenerics, eq(formularyGenerics.id, formularyCrkEntries.genericId))
    .where(eq(formularyGenerics.sctid, genericSctid)))[0]?.e;
}

export type CrkState = "draft" | "pending" | "awaiting_second" | "due" | "overdue";
export type CrkWorklist = {
  /**
   * `draft`: never signed, waiting. `pending`: a new version waits while the last signed one stays live.
   * `awaitingSecond`: a high-alert first signature (a version or a renewal) waits for its second.
   * `dueForReview`: live, renewal window open, not yet past due. `overdue`: past its due date (still shown).
   */
  counts: { none: number; draft: number; pending: number; awaitingSecond: number; signed: number; dueForReview: number; overdue: number };
  /** What the model has cost so far (#618: measured on the first 20 drafts), over every model draft. */
  drafting: { drafted: number; inputTokens: number; outputTokens: number };
  items: { entryId: string; genericSctid: string; name: string; state: CrkState; draftedModel: string | null; updatedAt: Date }[];
};

/** The reviewers' worklist: what waits for a signature, what waits for a second, what is due again. */
export async function crkWorklist(db: Db, today: string, limit = 50): Promise<CrkWorklist> {
  const windowEnd = addDays(today, CRK_RENEWAL_WINDOW_DAYS);
  const [c] = (await db.execute(sql`
    select
      count(*) filter (where draft_crk is not null and signed_crk is null and first_signed_by is null)::int as draft,
      count(*) filter (where draft_crk is not null and signed_crk is not null and first_signed_by is null)::int as pending,
      count(*) filter (where first_signed_by is not null)::int as "awaitingSecond",
      count(*) filter (where signed_crk is not null)::int as signed,
      count(*) filter (where signed_crk is not null and draft_crk is null and first_signed_by is null and review_due_on >= ${today} and review_due_on <= ${windowEnd})::int as "dueForReview",
      count(*) filter (where signed_crk is not null and draft_crk is null and first_signed_by is null and review_due_on < ${today})::int as overdue,
      coalesce(sum(model_drafts), 0)::int as drafted,
      coalesce(sum(model_input_tokens), 0)::int as "inputTokens",
      coalesce(sum(model_output_tokens), 0)::int as "outputTokens"
    from formulary_crk_entries
  `)).rows as { draft: number; pending: number; awaitingSecond: number; signed: number; dueForReview: number; overdue: number; drafted: number; inputTokens: number; outputTokens: number }[];
  const [n] = (await db.execute(sql`
    select count(*)::int as none from formulary_generics g
     where exists (select 1 from formulary_medicines m join items i on i.formulary_medicine_id = m.id where m.generic_sctid = g.sctid)
       and not exists (select 1 from formulary_crk_entries e where e.generic_id = g.id)
  `)).rows as { none: number }[];
  const rows = await db.select({
    entryId: formularyCrkEntries.id, genericSctid: formularyGenerics.sctid, name: formularyGenerics.name,
    draftCrk: formularyCrkEntries.draftCrk, signedCrk: formularyCrkEntries.signedCrk,
    firstSignedBy: formularyCrkEntries.firstSignedBy, reviewDueOn: formularyCrkEntries.reviewDueOn,
    draftedModel: formularyCrkEntries.draftedModel, updatedAt: formularyCrkEntries.updatedAt,
  }).from(formularyCrkEntries)
    .innerJoin(formularyGenerics, eq(formularyGenerics.id, formularyCrkEntries.genericId))
    .where(sql`(${formularyCrkEntries.draftCrk} is not null or ${formularyCrkEntries.firstSignedBy} is not null or ${formularyCrkEntries.reviewDueOn} <= ${windowEnd})`)
    .orderBy(asc(formularyCrkEntries.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return {
    counts: {
      none: n?.none ?? 0, draft: c?.draft ?? 0, pending: c?.pending ?? 0, awaitingSecond: c?.awaitingSecond ?? 0,
      signed: c?.signed ?? 0, dueForReview: c?.dueForReview ?? 0, overdue: c?.overdue ?? 0,
    },
    drafting: { drafted: c?.drafted ?? 0, inputTokens: c?.inputTokens ?? 0, outputTokens: c?.outputTokens ?? 0 },
    items: rows.map((r) => ({
      entryId: r.entryId, genericSctid: r.genericSctid, name: r.name,
      state: r.firstSignedBy !== null ? "awaiting_second"
        : r.draftCrk !== null ? (r.signedCrk === null ? "draft" : "pending")
          : isOverdue(r.reviewDueOn, today) ? "overdue" : "due",
      draftedModel: r.draftedModel, updatedAt: r.updatedAt,
    })),
  };
}

/** The label every reader shows (decision 0053), in these words. */
export function crkLabel(name: string, on: string): string {
  return `CRK Medical College formulary · reviewed by ${name}, ${on}`;
}

/** The signers' names for the label. */
export async function crkSigners(db: Db | Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = (await db.execute(sql`select id, full_name as name from users where id = any(${sql`array[${sql.join(wanted.map((w) => sql`${w}`), sql`, `)}]::text[]`})`)).rows as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * What every READER gets: the LIVE (signed) version of a generic's entry with its label, or nothing. A pending
 * draft, a waiting first signature and the drafting cost never leave by this door. Past its due date the
 * entry is still returned, `overdue` (#884): hiding it would hide safety text.
 */
export type SignedCrk = {
  genericSctid: string; name: string; crk: CrkEntry; highAlert: boolean; version: number;
  label: string; signedOn: string; designation: string | null; secondSigner: string | null;
  reviewDueOn: string | null; overdue: boolean;
};

async function signedRows(db: Db | Tx, where: ReturnType<typeof and>, today: string): Promise<(SignedCrk & { medicineId: string | null })[]> {
  const rows = await db.select({
    medicineId: formularyMedicines.id, genericSctid: formularyGenerics.sctid, name: formularyGenerics.name,
    crk: formularyCrkEntries.signedCrk, highAlert: formularyCrkEntries.highAlert, version: formularyCrkEntries.version,
    reviewedBy: formularyCrkEntries.reviewedBy, reviewedAt: formularyCrkEntries.reviewedAt,
    designation: formularyCrkEntries.reviewerDesignation, secondReviewedBy: formularyCrkEntries.secondReviewedBy,
    reviewDueOn: formularyCrkEntries.reviewDueOn,
  }).from(formularyCrkEntries)
    .innerJoin(formularyGenerics, eq(formularyGenerics.id, formularyCrkEntries.genericId))
    .leftJoin(formularyMedicines, eq(formularyMedicines.genericSctid, formularyGenerics.sctid))
    .where(and(isNotNull(formularyCrkEntries.signedCrk), where));
  const names = await crkSigners(db, rows.flatMap((r) => [r.reviewedBy, r.secondReviewedBy].filter((x): x is string => x !== null)));
  return rows.flatMap((r) => {
    if (r.crk === null || r.reviewedBy === null || r.reviewedAt === null) return [];
    const on = istDate(r.reviewedAt);
    return [{
      medicineId: r.medicineId, genericSctid: r.genericSctid, name: r.name, crk: r.crk, highAlert: r.highAlert, version: r.version,
      label: crkLabel(names.get(r.reviewedBy) ?? r.reviewedBy, on), signedOn: on, designation: r.designation,
      secondSigner: r.secondReviewedBy === null ? null : names.get(r.secondReviewedBy) ?? r.secondReviewedBy,
      reviewDueOn: r.reviewDueOn, overdue: isOverdue(r.reviewDueOn, today),
    }];
  });
}

/** The live entry of one generic, for any reader. */
export async function signedCrkForGeneric(db: Db | Tx, genericSctid: string, today: string = istDate(new Date())): Promise<SignedCrk | undefined> {
  const [row] = await signedRows(db, eq(formularyGenerics.sctid, genericSctid), today);
  if (row === undefined) return undefined;
  const { medicineId, ...entry } = row;
  void medicineId;
  return entry;
}

/** The live entries of the medicines on a doctor's screen, by medicine id. Unsigned ones are simply absent. */
export async function signedCrkForMedicines(db: Db | Tx, medicineIds: readonly string[], today: string = istDate(new Date())): Promise<(SignedCrk & { medicineId: string })[]> {
  const ids = [...new Set(medicineIds)];
  if (ids.length === 0) return [];
  return (await signedRows(db, inArray(formularyMedicines.id, ids), today))
    .flatMap((r) => (r.medicineId === null ? [] : [{ ...r, medicineId: r.medicineId }]));
}
