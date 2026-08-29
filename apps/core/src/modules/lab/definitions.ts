import { withTx } from "../../kernel/db/client";
import { activateDefinition, createDraft, getActiveDefinition } from "../../kernel/workflow/definitions";
import {
  LAB_ITEM_DEFINITION_JSON, LAB_ITEM_DEF_KEY, LAB_SPECIMEN_DEFINITION_JSON, LAB_SPECIMEN_DEF_KEY,
} from "./workflow-def";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 17a T4 — DRAFT AND ACTIVATE THE TWO LAB DEFINITIONS.
 *
 * `startInstance` throws `no_active_definition` for a key with no ACTIVE row, so `deskOrder` cannot
 * place a single item until this has run. That is deliberate and it is the shipped house behaviour:
 * a hospital that has not adopted the lab's state machine has not opened its lab.
 *
 * ═══ CLASS C, WHICH MEANS ZERO APPROVALS — AND THAT IS A RULING, NOT A SHORTCUT ═══
 *
 * `CHANGE_CLASS_POLICY.C` is `requiredRoles: []`. The OPD visit is Class A (owner + medical
 * superintendent two-key) because it is a PATIENT-JOURNEY flow: changing it changes what happens to
 * a person. These two are departmental operating flows — the order in which a tube is drawn,
 * centrifuged and read — and D-15 puts routine master data at C with sampled audit. **The clinical
 * safety in this module is not in the stage list**: it is in the range book, the critical bands and
 * the reflex rules, and `lab.catalogue.manage` gates all three at `pathologist`.
 *
 * ═══ IDEMPOTENT, AND THE HALF THAT WOULD GO UNNOTICED ═══
 *
 * A second call is a no-op because an ACTIVE row already exists. Without that guard the second call
 * would not error — it would mint a second `workflow_definitions` VERSION, which is not a failure,
 * just a lie about how many times the flow changed (`approval-types.ts`'s own reasoning, and its
 * test proves the same claim by execution).
 *
 * `activator` must be a `user` actor: `activateDefinition` refuses anything else. The DRAFTER is a
 * system identity distinct from it, which is all `assertNotSodPair` compares.
 */
const DRAFTER: Actor = { type: "system", id: "lab-definition-drafter" };

export const LAB_DEFINITIONS = [LAB_ITEM_DEFINITION_JSON, LAB_SPECIMEN_DEFINITION_JSON] as const;
export const LAB_DEF_KEYS = [LAB_ITEM_DEF_KEY, LAB_SPECIMEN_DEF_KEY] as const;

export type ActivateLabDefinitionsReport = { activated: string[]; alreadyActive: string[] };

export async function activateLabDefinitions(
  db: Db,
  activator: Actor,
): Promise<ActivateLabDefinitionsReport> {
  const report: ActivateLabDefinitionsReport = { activated: [], alreadyActive: [] };
  for (const def of LAB_DEFINITIONS) {
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
