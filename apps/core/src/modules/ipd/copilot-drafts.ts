import { and, desc, eq, inArray } from "drizzle-orm";
import { ipdCopilotDrafts } from "../../kernel/db/schema";
import type { IpdDraftProvenance } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * E5.3 (#740), E5.4 (#741) — reads of `ipd_copilot_drafts` (what a drafter showed, with its provenance). A signing act
 * (give a shift handover, save a discharge summary) names a draft by id; the signed copy keeps that id, and its reader
 * shows the draft's source, model id, prompt version and build time beside the person who signed.
 */
export type DraftRow = typeof ipdCopilotDrafts.$inferSelect;

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

export function provenanceOfDraft(row: Pick<DraftRow, "id" | "source" | "modelId" | "promptVersion" | "builtAt">): IpdDraftProvenance {
  return { draftId: row.id, source: row.source as "template" | "model", modelId: row.modelId, promptVersion: row.promptVersion, builtAt: row.builtAt.toISOString() };
}

export async function draftProvenances(db: Db | Tx, draftIds: readonly string[]): Promise<Map<string, IpdDraftProvenance>> {
  if (draftIds.length === 0) return new Map();
  const rows = await db.select().from(ipdCopilotDrafts).where(inArray(ipdCopilotDrafts.id, [...new Set(draftIds)]));
  return new Map(rows.map((r) => [r.id, provenanceOfDraft(r)] as const));
}

