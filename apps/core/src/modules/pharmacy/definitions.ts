import { withTx } from "../../kernel/db/client";
import { activateDefinition, createDraft, getActiveDefinition } from "../../kernel/workflow/definitions";
import { PHARMACY_DISPENSE_DEFINITION_JSON, PHARMACY_DISPENSE_DEF_KEY } from "./workflow-def";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

const DRAFTER: Actor = { type: "system", id: "pharmacy-definition-drafter" };

export const PHARMACY_DEFINITIONS = [PHARMACY_DISPENSE_DEFINITION_JSON] as const;
export const PHARMACY_DEF_KEYS = [PHARMACY_DISPENSE_DEF_KEY] as const;

export type ActivatePharmacyDefinitionsReport = { activated: string[]; alreadyActive: string[] };

/** The `activateLabDefinitions` shape: draft-then-activate once, idempotent, for the seed and the tests. */
export async function activatePharmacyDefinitions(db: Db, activator: Actor): Promise<ActivatePharmacyDefinitionsReport> {
  const report: ActivatePharmacyDefinitionsReport = { activated: [], alreadyActive: [] };
  for (const def of PHARMACY_DEFINITIONS) {
    const active = await withTx(db, (tx: Tx) => getActiveDefinition(tx, def.key));
    if (active) {
      report.alreadyActive.push(def.key);
      continue;
    }
    const draft = await createDraft(db, DRAFTER, def);
    await activateDefinition(db, activator, draft.definitionId);
    report.activated.push(def.key);
  }
  return report;
}
