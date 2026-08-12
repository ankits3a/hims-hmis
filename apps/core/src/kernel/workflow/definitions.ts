import { and, desc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { workflowDefinitions } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { defineWorkflow, parseDefinition } from "./definition";
import type { ChangeClass, WorkflowDefinition } from "./definition";
import { workflowDefinitionUpdated } from "./events";
import type { Db, Tx } from "../db/client";

export type DefinitionRow = typeof workflowDefinitions.$inferSelect;

export async function createDraft(
  db: Db,
  actor: Actor,
  defJson: unknown,
): Promise<{ definitionId: string; defKey: string; version: number }> {
  const def = defineWorkflow(defJson); // throws WorkflowValidationError before any write
  const definitionId = newId();
  const version = await withTx(db, async (tx) => {
    const latest = await tx
      .select({ version: workflowDefinitions.version })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.defKey, def.key))
      .orderBy(desc(workflowDefinitions.version))
      .limit(1);
    const nextVersion = (latest[0]?.version ?? 0) + 1;
    await tx.insert(workflowDefinitions).values({
      id: definitionId,
      defKey: def.key,
      version: nextVersion,
      title: def.title,
      changeClass: def.changeClass,
      definition: def,
      draftedBy: actor.id,
    });
    await appendEvent(
      tx,
      workflowDefinitionUpdated.make({
        actor,
        payload: {
          definitionId,
          defKey: def.key,
          version: nextVersion,
          changeClass: def.changeClass as ChangeClass,
          action: "drafted",
        },
      }),
    );
    return nextVersion;
  });
  return { definitionId, defKey: def.key, version };
}

export async function getActiveDefinition(
  tx: Tx,
  defKey: string,
): Promise<(DefinitionRow & { parsed: WorkflowDefinition }) | null> {
  const rows = await tx
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.defKey, defKey), eq(workflowDefinitions.status, "active")));
  const row = rows[0];
  if (!row) return null;
  return { ...row, parsed: parseDefinition(row.definition) };
}

export async function listDefinitions(db: Db, defKey: string): Promise<DefinitionRow[]> {
  return db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.defKey, defKey))
    .orderBy(desc(workflowDefinitions.version));
}
