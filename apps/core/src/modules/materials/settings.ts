import { eq } from "drizzle-orm";
import { z } from "zod";
import { materialsSettings } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { MaterialsError } from "./errors";
import { storeSettingsChanged } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ OWNER RULING 2026-09-30 — THE STORES' SETTINGS, AND THE TWO-PERSON GRN RULE IS ONE ═══
 *
 * The owner, the pharmacy's first live morning: *"the system should recommend to enforce two different
 * people later via settings screen but currently admin login can do both."* So the rule that the person
 * who captured a goods receipt may not also run its QC and post it is a SETTING:
 *
 *   · OFF by default — no row in `materials_settings` reads as off, which is today's behaviour: capture
 *     (`materials.grn.capture`) and QC/post (`materials.grn.qc`) are separate permissions and one person
 *     may hold both.
 *   · ON — `runGateQc` and `postGrn` refuse the capturer with `grn_same_person` (`grn.ts`), whichever
 *     door they come through: the GRN screen, the opening-stock script, a controlled-cabinet receipt.
 *
 * WHO MAY CHANGE IT: a holder of `materials.stores.manage` (the materials head, and the owner's admin
 * role) — the permission that already decides the shape of the stores. Reused, not minted. Every change
 * appends `store_settings.changed` with the old and new value, in the same transaction as the write.
 */
export type MaterialsSettings = {
  grnQcNeedsSecondPerson: boolean;
  /** Who last changed a setting, and when — null while no one ever has (every setting at its default). */
  updatedBy: string | null;
  updatedAt: string | null;
};

export async function loadMaterialsSettings(db: Db | Tx): Promise<MaterialsSettings> {
  const row = (await db.select().from(materialsSettings).where(eq(materialsSettings.id, "main")))[0];
  if (row === undefined) return { grnQcNeedsSecondPerson: false, updatedBy: null, updatedAt: null };
  return { grnQcNeedsSecondPerson: row.grnQcNeedsSecondPerson, updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() };
}

export const materialsSettingsPatchSchema = z.object({ grnQcNeedsSecondPerson: z.boolean() }).strict();
export type MaterialsSettingsPatch = z.infer<typeof materialsSettingsPatchSchema>;

/**
 * Writes the setting and audits the change. Saving the value it already has writes nothing and emits
 * nothing — a no-op is not a change, and an audit row for it would be noise an auditor must read past.
 * The ROW is locked for the read, so two heads saving at once record two ordered changes, never one lost.
 */
export async function updateMaterialsSettings(
  tx: Tx, actor: Actor, rawPatch: unknown, now: Date,
): Promise<MaterialsSettings> {
  if (actor.type !== "user") {
    throw new MaterialsError("permission_denied", "only a person changes a stores setting");
  }
  const patch = materialsSettingsPatchSchema.parse(rawPatch);
  const current = (await tx.select().from(materialsSettings).where(eq(materialsSettings.id, "main")).for("update"))[0];
  const from = current?.grnQcNeedsSecondPerson ?? false;
  if (from === patch.grnQcNeedsSecondPerson) return loadMaterialsSettings(tx);

  await tx.insert(materialsSettings)
    .values({ id: "main", grnQcNeedsSecondPerson: patch.grnQcNeedsSecondPerson, updatedBy: actor.id, updatedAt: now })
    .onConflictDoUpdate({
      target: materialsSettings.id,
      set: { grnQcNeedsSecondPerson: patch.grnQcNeedsSecondPerson, updatedBy: actor.id, updatedAt: now },
    });
  await appendEvent(tx, storeSettingsChanged.make({
    actor, occurredAt: now, correlationId: "materials_settings:main",
    payload: { setting: "grn_qc_needs_second_person", from, to: patch.grnQcNeedsSecondPerson },
  }));
  return loadMaterialsSettings(tx);
}
