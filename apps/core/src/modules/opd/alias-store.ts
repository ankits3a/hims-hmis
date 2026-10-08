import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import { cdsAliases } from "../../kernel/db/schema";
import { chooserFor, openAiDecisionsClient } from "../../kernel/inference/openai-decisions";
import { openAiKeyFromFile } from "../../kernel/inference/openai-speech";
import { aliasCandidatePool } from "../formulary";
import type { AliasDeps, AliasProposal } from "./alias-pipeline";
import { lasaPairs } from "./consult-guards";

/**
 * ═══ THE ALIAS PIPELINE'S EDGES: ITS SETTINGS, ITS CATALOGUE READ, ITS ONE TABLE (decision 0051) ═══
 *
 * `alias-pipeline.ts` is pure and is handed everything; this file is where the real things are
 * bound. NOTHING IN THE PRODUCT CALLS EITHER FUNCTION YET — no route, screen, job or search. The
 * evaluation (`scripts/eval-aliases.ts`) is the only caller, and it never writes.
 */

/**
 * The pipeline's dependencies from the server's settings. With `ALIAS_PIPELINE_ENABLED` false — the
 * default — NO MODEL CLIENT IS BUILT: a caller cannot reach a provider by forgetting to ask the
 * switch, because there is nothing to call.
 *
 * The chooser is `chooserFor`, the same door triage and the copilot use, in `ALIAS_CHOOSER_ORDER`
 * (default: triage's chain, with triage's TypeSafe endpoint and key). The reviewer is the OpenAI
 * Decisions client — the one provider with `predicate()`.
 */
export function aliasDepsFrom(db: Db, config: AppConfig): AliasDeps {
  const { enabled, chooserLine, reviewerLine, chooserOrder } = config.aliases;
  return {
    enabled,
    candidates: (words, numbers) => aliasCandidatePool(db, words, numbers),
    lasa: () => lasaPairs(db),
    chooser: !enabled ? null : chooserFor({
      order: chooserOrder, typesafe: config.triageChoice, decisions: config.decisions, openaiKeyFile: config.openaiKeyFile, minConfidence: chooserLine,
    }),
    reviewer: !enabled ? null : openAiDecisionsClient(config.decisions, () => openAiKeyFromFile(config.openaiKeyFile)),
    chooserLine,
    reviewerLine,
  };
}

/**
 * One row per term. A run that was switched off writes nothing. A row that is LIVE ('suggestion',
 * 'trusted') or that somebody took back ('undone', 'demoted') is never overwritten here: the
 * owner's undo must not be re-learned by the next run, and taking a live alias back is the
 * re-audit's act, which is not built in this slice. Only a 'proposed' row is retried.
 */
export async function saveAliasProposal(db: Db, proposal: AliasProposal, now: Date): Promise<"off" | "saved" | "kept"> {
  if (proposal.outcome === "off") return "off";
  const values = {
    medicineId: proposal.medicineId, state: proposal.state,
    chooserName: proposal.chooser?.model ?? null, chooserConfidence: proposal.chooser?.confidence ?? null,
    reviewerName: proposal.reviewer?.model ?? null, reviewerAnswer: proposal.reviewer?.answer ?? null,
    reviewerProbability: proposal.reviewer?.probability ?? null, reasonCode: proposal.reviewer?.reasonCode ?? null,
    ruleResult: proposal.ruleResult, refusal: proposal.refusal, lasaGuard: proposal.lasaGuard, updatedAt: now, auditedAt: now,
  };
  return db.transaction(async (tx) => {
    const key = and(eq(cdsAliases.kind, "medicine"), eq(cdsAliases.term, proposal.term));
    const [had] = await tx.select({ id: cdsAliases.id, state: cdsAliases.state }).from(cdsAliases).where(key).for("update");
    if (had === undefined) {
      await tx.insert(cdsAliases).values({ id: newId(), kind: "medicine", term: proposal.term, createdAt: now, ...values }).onConflictDoNothing();
      return "saved";
    }
    if (had.state !== "proposed") return "kept";
    await tx.update(cdsAliases).set(values).where(eq(cdsAliases.id, had.id));
    return "saved";
  });
}
