/**
 * ═══ #618 / DECISION 0053 — THE CRK FORMULARY: A MODEL DRAFTS, PHARMACOLOGY SIGNS ═══
 *
 * The hospital buys no drug database. A model drafts a short entry per generic from public sources the
 * hospital may legally use; a named Pharmacology reviewer edits and SIGNS it; a high-alert medicine takes a
 * SECOND signature from a different reviewer. The entry lives on the existing `formulary_monographs` row
 * (`crk`), so the store's gate holds unchanged: no reader sees anything that is not `reviewed`
 * (`getMonograph`, `renalDoseFor`), and nothing reaches a prescribing or safety check before a signature.
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
import { and, asc, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { assertNoIdentifiers, maskQuestion } from "../../kernel/copilot/mask";
import { formularyGenerics, formularyMonographs, formularyMonographSignatures } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import { monographCrkSaved, monographSigned } from "./events";
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
const STATEMENT_MAX = 600;
const SOURCE_TEXT_MAX = 24_000;

/* A strength or a per-weight figure: "500 mg", "10 mg/kg", "0.5 ml", "2 g", "5 mcg", "100 units". */
const DOSE_SHAPE = /\d\s*(?:mg|mcg|µg|g|gm|ml|mL|iu|IU|units?)\b|mg\s*\/\s*kg|\/\s*kg\b/i;

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
 * are DROPPED (the model is not a person who can fix them); a dose-shaped statement is dropped.
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
      if (text === "" || !refs.has(source) || DOSE_SHAPE.test(text) || text.length > STATEMENT_MAX) { dropped += 1; continue; }
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

export type DraftResult = { monographId: string; statements: number; dropped: number; usage: { inputTokens: number; outputTokens: number } | null };

/**
 * Ask the model for a draft and store it as the entry's DRAFT (any signature is cleared: changed text is
 * unsigned text). `client` null ⇒ `model_not_configured`, before anything is read or written.
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
  const monographId = await withTx(db, (tx) => writeCrk(tx, actor, generic.id, entry, { model: model.id, usage }));
  return { monographId, statements, dropped, usage };
}

/** A person's save of the entry (no model). Same rules for the shape; the draft is unsigned again. */
export async function saveCrkEntry(tx: Tx, actor: Actor, genericSctid: string, entry: CrkEntry): Promise<{ monographId: string }> {
  const generic = (await tx.select({ id: formularyGenerics.id }).from(formularyGenerics).where(eq(formularyGenerics.sctid, genericSctid)))[0];
  if (generic === undefined) throw new FormularyError("unknown_generic", `no generic with SNOMED CT id ${genericSctid}`);
  return { monographId: await writeCrk(tx, actor, generic.id, validateCrkEntry(entry), { model: null, usage: null }) };
}

const UNSIGNED = {
  status: "draft", reviewedBy: null, reviewedAt: null, reviewerDesignation: null,
  firstSignedBy: null, firstSignedAt: null, firstSignerDesignation: null,
  secondReviewedBy: null, secondReviewedAt: null, secondReviewerDesignation: null, reviewDueOn: null,
} as const;

async function writeCrk(
  tx: Tx, actor: Actor, genericId: string, entry: CrkEntry,
  drafted: { model: string | null; usage: { inputTokens: number; outputTokens: number } | null },
): Promise<string> {
  const held = (await tx.select({ id: formularyMonographs.id }).from(formularyMonographs)
    .where(eq(formularyMonographs.genericId, genericId)).for("update"))[0];
  const monographId = held?.id ?? newId();
  const draftCols = drafted.model === null
    ? {}
    : { draftedModel: drafted.model, draftedAt: new Date(), draftUsage: drafted.usage };
  if (held === undefined) {
    await tx.insert(formularyMonographs).values({
      id: monographId, genericId, sourceVersion: "crk", crk: entry, ...draftCols, createdBy: actor.id, updatedBy: actor.id,
    });
  } else {
    await tx.update(formularyMonographs).set({ crk: entry, ...draftCols, ...UNSIGNED, updatedBy: actor.id, updatedAt: new Date() })
      .where(eq(formularyMonographs.id, monographId));
  }
  await appendEvent(tx, monographCrkSaved.make({
    payload: {
      monographId, genericId, draftedModel: drafted.model,
      statements: Object.values(entry.fields).reduce((n, l) => n + l.length, 0),
      inputTokens: drafted.usage?.inputTokens ?? null, outputTokens: drafted.usage?.outputTokens ?? null,
    },
    actor, correlationId: monographId,
  }));
  return monographId;
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

function dueOn(from: Date): string {
  const d = new Date(from.getTime() + 5.5 * 3600_000);
  d.setUTCMonth(d.getUTCMonth() + CRK_REREVIEW_MONTHS);
  return d.toISOString().slice(0, 10);
}

export type SignResult = { status: "reviewed" | "awaiting_second"; version: number };

/**
 * A Pharmacology reviewer's SIGNATURE. Edits may come with it (the plan: the reviewer "edits and signs"),
 * and an edit is always a FIRST signature: changed text restarts a high-alert entry's pair.
 *
 *   - not high-alert: one signature makes it reviewed;
 *   - high-alert: the first signature waits; the SECOND must be another person and carries no edit.
 *
 * Every signature is kept with the text as signed (`formulary_monograph_signatures`).
 */
export async function signCrkEntry(
  tx: Tx, actor: Actor, monographId: string,
  input: { designation: string; crk?: CrkEntry; highAlert?: boolean },
  now: Date = new Date(),
): Promise<SignResult> {
  if (actor.type !== "user") throw new FormularyError("attester_not_user", "only a person signs a formulary entry");
  const designation = input.designation.trim();
  if (designation === "") throw new FormularyError("invalid_crk", "a signature needs the reviewer's designation");
  const row = (await tx.select().from(formularyMonographs).where(eq(formularyMonographs.id, monographId)).for("update"))[0];
  if (row === undefined) throw new FormularyError("unknown_monograph", `no monograph ${monographId}`);
  if (row.status === "reviewed") throw new FormularyError("monograph_already_reviewed", "this entry is already signed; an edit makes it a draft again");
  const edited = input.crk === undefined ? null : validateCrkEntry(input.crk);
  const entry = edited ?? row.crk;
  if (entry === null) throw new FormularyError("monograph_needs_signature", "this monograph has no CRK entry to sign");
  const flagged = row.highAlert || input.highAlert === true;
  const highAlert = await isHighAlert(tx, row.genericId, flagged);
  const pendingFirst = edited === null ? row.firstSignedBy : null;

  let kind: "sole" | "first" | "second";
  if (!highAlert) kind = "sole";
  else if (pendingFirst === null) kind = "first";
  else {
    if (pendingFirst === actor.id) throw new FormularyError("monograph_same_actor", "a high-alert entry needs a second signature from a different reviewer");
    kind = "second";
  }

  const version = kind === "first" ? row.version : row.version + 1;
  if (kind === "first") {
    await tx.update(formularyMonographs).set({
      crk: entry, highAlert: flagged,
      firstSignedBy: actor.id, firstSignedAt: now, firstSignerDesignation: designation,
      ...(edited === null ? {} : { updatedBy: actor.id, updatedAt: now }),
    }).where(eq(formularyMonographs.id, monographId));
  } else if (kind === "sole") {
    await tx.update(formularyMonographs).set({
      crk: entry, highAlert: flagged, status: "reviewed", reviewedBy: actor.id, reviewedAt: now, reviewerDesignation: designation,
      reviewDueOn: dueOn(now), version,
      ...(edited === null ? {} : { updatedBy: actor.id, updatedAt: now }),
    }).where(eq(formularyMonographs.id, monographId));
  } else {
    await tx.update(formularyMonographs).set({
      status: "reviewed", reviewedBy: row.firstSignedBy, reviewedAt: row.firstSignedAt, reviewerDesignation: row.firstSignerDesignation,
      secondReviewedBy: actor.id, secondReviewedAt: now, secondReviewerDesignation: designation,
      firstSignedBy: null, firstSignedAt: null, firstSignerDesignation: null,
      reviewDueOn: dueOn(now), version,
    }).where(eq(formularyMonographs.id, monographId));
  }
  await tx.insert(formularyMonographSignatures).values({
    id: newId(), monographId, version, kind, signedBy: actor.id, designation, signedAt: now, crk: entry,
  });
  await appendEvent(tx, monographSigned.make({
    payload: { monographId, genericId: row.genericId, kind, version, designation, highAlert },
    actor, correlationId: monographId,
  }));
  return { status: kind === "first" ? "awaiting_second" : "reviewed", version };
}

export type CrkWorklist = {
  counts: { none: number; draft: number; awaitingSecond: number; signed: number; dueForReview: number };
  /** What the model has cost so far (#618: measured on the first 20 drafts), over entries it drafted. */
  drafting: { drafted: number; inputTokens: number; outputTokens: number };
  items: { monographId: string; genericSctid: string; name: string; state: "draft" | "awaiting_second" | "due"; draftedModel: string | null; updatedAt: Date }[];
};

/** The reviewers' worklist: what waits for a signature, what waits for a second, what is due again. */
export async function crkWorklist(db: Db, today: string, limit = 50): Promise<CrkWorklist> {
  const [c] = (await db.execute(sql`
    select
      count(*) filter (where status = 'draft' and first_signed_by is null)::int as draft,
      count(*) filter (where status = 'draft' and first_signed_by is not null)::int as "awaitingSecond",
      count(*) filter (where status = 'reviewed')::int as signed,
      count(*) filter (where status = 'reviewed' and review_due_on <= ${today})::int as "dueForReview",
      count(*) filter (where drafted_model is not null)::int as drafted,
      coalesce(sum((draft_usage->>'inputTokens')::int), 0)::int as "inputTokens",
      coalesce(sum((draft_usage->>'outputTokens')::int), 0)::int as "outputTokens"
    from formulary_monographs where crk is not null
  `)).rows as { draft: number; awaitingSecond: number; signed: number; dueForReview: number; drafted: number; inputTokens: number; outputTokens: number }[];
  const [n] = (await db.execute(sql`
    select count(*)::int as none from formulary_generics g
     where exists (select 1 from formulary_medicines m join items i on i.formulary_medicine_id = m.id where m.generic_sctid = g.sctid)
       and not exists (select 1 from formulary_monographs fm where fm.generic_id = g.id and fm.crk is not null)
  `)).rows as { none: number }[];
  const rows = await db.select({
    monographId: formularyMonographs.id, genericSctid: formularyGenerics.sctid, name: formularyGenerics.name,
    status: formularyMonographs.status, firstSignedBy: formularyMonographs.firstSignedBy, reviewDueOn: formularyMonographs.reviewDueOn,
    draftedModel: formularyMonographs.draftedModel, updatedAt: formularyMonographs.updatedAt,
  }).from(formularyMonographs)
    .innerJoin(formularyGenerics, eq(formularyGenerics.id, formularyMonographs.genericId))
    .where(and(sql`${formularyMonographs.crk} is not null`, sql`(${formularyMonographs.status} = 'draft' or ${formularyMonographs.reviewDueOn} <= ${today})`))
    .orderBy(asc(formularyMonographs.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return {
    counts: { none: n?.none ?? 0, draft: c?.draft ?? 0, awaitingSecond: c?.awaitingSecond ?? 0, signed: c?.signed ?? 0, dueForReview: c?.dueForReview ?? 0 },
    drafting: { drafted: c?.drafted ?? 0, inputTokens: c?.inputTokens ?? 0, outputTokens: c?.outputTokens ?? 0 },
    items: rows.map((r) => ({
      monographId: r.monographId, genericSctid: r.genericSctid, name: r.name,
      state: r.status === "reviewed" ? "due" : r.firstSignedBy !== null ? "awaiting_second" : "draft",
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
