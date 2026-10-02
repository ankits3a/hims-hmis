import { eq } from "drizzle-orm";
import { z } from "zod";
import { hasPermission } from "../../kernel/auth/permissions";
import { pharmacySettings } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { PharmacyError } from "./errors";
import { pharmacySettingsChanged } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ OWNER RULING 2026-10-02 — QUICK DESK MODE, A SETTING ═══
 *
 * The owner, on staging: *"add a toggle for admin to enable a quick desk mode for pharmacy desk screen
 * where the pharmacist/counter staff who is allowed to bill can find the patient, chooses the doctor /
 * department unit from the filter and directly add medicine and bill the patient. No prescription
 * upload warning … no 'Only a pharmacist with a current state council registration on file may do
 * this' blocker, no 'See the slip' or 'Confirmed against the slip' button to click."*
 *
 *   · OFF by default — no row in `pharmacy_settings` reads as off, which is the desk as it was.
 *   · ON — exactly three checks stand down, and nothing else:
 *       1. the photo of a Schedule H/H1 paper prescription (`paper-rx.ts`, `prescription_required`);
 *       2. the state-council registration of the acting person at verify and at a scheduled hand-over
 *          (`pharmacist_not_registered`). The PERMISSIONS stay: `pharmacy.dispense.place` to verify,
 *          `pharmacy.dispense.scheduled` to hand a Schedule H/H1 line over;
 *       3. the slip cross-confirm before the bill (`bill.ts`, `slip_not_confirmed`).
 *
 * WHAT STAYS, ON OR OFF: Schedule X and narcotic lines are refused at the paper door; an allergy, a
 * severe interaction, a hard duplicate and a drug-disease hit refuse; the H1 register is written at
 * hand-over (its pharmacist number is blank when the person has none on file); the prescriber is named.
 *
 * WHO MAY CHANGE IT: a holder of `pharmacy.licences.manage` (the owner's admin role, the medical
 * superintendent, the pharmacist in charge) — the grant over the pharmacy's legal standing. Reused, not
 * minted. Every change appends `pharmacy_settings.changed` in the same transaction as the write.
 */
export type PharmacySettings = {
  quickDesk: boolean;
  /** Who last changed a setting, and when — null while no one ever has. */
  updatedBy: string | null;
  updatedAt: string | null;
};

const MANAGE = "pharmacy.licences.manage";

export async function loadPharmacySettings(db: Db | Tx): Promise<PharmacySettings> {
  const row = (await db.select().from(pharmacySettings).where(eq(pharmacySettings.id, "main")))[0];
  if (row === undefined) return { quickDesk: false, updatedBy: null, updatedAt: null };
  return { quickDesk: row.quickDesk, updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() };
}

/** The one question the three checks ask. */
export async function quickDeskOn(db: Db | Tx): Promise<boolean> {
  return (await loadPharmacySettings(db)).quickDesk;
}

export const pharmacySettingsPatchSchema = z.object({ quickDesk: z.boolean() }).strict();

/**
 * Writes the setting and audits the change. Saving the value it already has writes nothing and emits
 * nothing. The row is locked for the read, so two people saving at once record two ordered changes.
 */
export async function updatePharmacySettings(tx: Tx, actor: Actor, rawPatch: unknown, now: Date): Promise<PharmacySettings> {
  if (actor.type !== "user" || !(await hasPermission(tx, actor.id, MANAGE, "hospital"))) {
    throw new PharmacyError("permission_denied", `changing a pharmacy desk setting needs ${MANAGE}`);
  }
  const patch = pharmacySettingsPatchSchema.parse(rawPatch);
  const current = (await tx.select().from(pharmacySettings).where(eq(pharmacySettings.id, "main")).for("update"))[0];
  const from = current?.quickDesk ?? false;
  if (from === patch.quickDesk) return loadPharmacySettings(tx);

  await tx.insert(pharmacySettings)
    .values({ id: "main", quickDesk: patch.quickDesk, updatedBy: actor.id, updatedAt: now })
    .onConflictDoUpdate({ target: pharmacySettings.id, set: { quickDesk: patch.quickDesk, updatedBy: actor.id, updatedAt: now } });
  await appendEvent(tx, pharmacySettingsChanged.make({
    actor, occurredAt: now, correlationId: "pharmacy_settings:main",
    payload: { setting: "quick_desk", from, to: patch.quickDesk },
  }));
  return loadPharmacySettings(tx);
}
