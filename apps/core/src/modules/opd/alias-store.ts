import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import { cdsAliases } from "../../kernel/db/schema";
import { chooserFor, openAiDecisionsClient } from "../../kernel/inference/openai-decisions";
import { openAiKeyFromFile } from "../../kernel/inference/openai-speech";
import { aliasCandidatePool, medicinesByIds, saltsByIds } from "../formulary";
import type { NicknameLookup } from "../formulary";
import { isControlled, normaliseTerm, readTerm } from "./alias-pipeline";
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
    medicineId: proposal.medicineId, state: proposal.state, termKey: readTerm(proposal.term).digits,
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

/** A medicine as the pipeline's "controlled" rule reads it, from the catalogue as it stands NOW. Null when it is gone or switched off. */
export async function controlledToday(db: Db, medicineId: string): Promise<{ controlled: boolean; moietySet: string } | null> {
  const med = (await medicinesByIds(db, [medicineId])).get(medicineId);
  if (med === undefined || !med.active) return null;
  const salts = await saltsByIds(db, med.salts.map((x) => x.saltId));
  const rows = med.salts.map((x) => salts.get(x.saltId)).filter((x) => x !== undefined);
  return {
    controlled: isControlled({ name: med.brandName, scheduleFlag: med.scheduleFlag, salts: rows.map((r) => r.name.toLowerCase()), ndps: rows.some((r) => r.ndpsClass !== null) }),
    moietySet: [...new Set(med.salts.map((x) => x.saltId))].sort().join("+"),
  };
}

/**
 * ═══ THE ONE READER OF A LIVE NICKNAME — what the prescriber's search asks (decision 0051) ═══
 *
 * Registered with the formulary's search at module init (`opd.module.ts`). It answers null — and
 * touches nothing — while `ALIAS_PIPELINE_ENABLED` is off, so the search is then exactly the
 * catalogue's. Switched on, a typed query is read the way a term is (`readTerm`: "pan forty" and
 * "pan 40" are one key) and matched to a nickname that is 'suggestion' or 'trusted'. A row that is
 * 'proposed', 'demoted' or 'undone' is never returned; nor is one whose medicine has since become
 * controlled (a schedule flag can arrive after the nickname did) or been switched off.
 */
export function nicknameLookupFor(config: Pick<AppConfig, "aliases">): NicknameLookup {
  return async (db, query) => {
    if (!config.aliases.enabled) return null;
    const term = normaliseTerm(query);
    if (term.length < 2 || term.length > 60) return null;
    const [row] = await db.select({ id: cdsAliases.id, medicineId: cdsAliases.medicineId, state: cdsAliases.state, lasaGuard: cdsAliases.lasaGuard })
      .from(cdsAliases)
      .where(and(eq(cdsAliases.kind, "medicine"), eq(cdsAliases.termKey, readTerm(term).digits), inArray(cdsAliases.state, ["suggestion", "trusted"])))
      .limit(1);
    if (row === undefined || row.medicineId === null) return null;
    const today = await controlledToday(db, row.medicineId);
    if (today === null || today.controlled) return null;
    return { medicineId: row.medicineId, mark: { id: row.id, state: row.state === "trusted" ? "trusted" : "suggestion", lasaGuard: row.lasaGuard } };
  };
}
