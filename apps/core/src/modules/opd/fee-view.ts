import { hasPermission } from "../../kernel/auth/permissions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ WHO IS SHOWN MONEY ON AN OPD READ (OWNER RULING 2026-10-09) ═══
 *
 * Owner: *"make sure that Doctor will not see 'paid' written or marked against any patient name or
 * id. This is a hospital not a clinic."* · *"Doctor's screens must not show money."*
 *
 * `GET /opd/queues` and `GET /opd/visits/:id` are read by the doctor's screens AND by desks whose
 * work is the fee. The split is by PERMISSION, not by screen: a caller sees the fee status, the
 * desk's bypass sentence and the old doctor's override only if they already hold a key whose own
 * work shows or writes them. No new permission — every one of these is an existing grant:
 *
 *   opd.visits.open              the front desk: grants the bypass, polls `counter-state`
 *   billing.invoice.read         cashier, billing manager, owner
 *   billing.dues.patient.read    the front desk's dues line
 *   opd.consult.paper            the slip desk: its paper road records "seen before the fee was settled"
 *   opd.prescription.transcribe  the desk scribe: the same road, the same mark on its screen
 *
 * The `doctor` role holds none of them. A person who is BOTH a doctor and a desk gets the desk's
 * copy of the data; the doctor's SCREENS draw no money whatever the payload carries.
 */
export const FEE_VIEW_PERMISSIONS = [
  "opd.visits.open", "billing.invoice.read", "billing.dues.patient.read", "opd.consult.paper", "opd.prescription.transcribe",
] as const;

export async function seesFees(db: Db, actor: Actor): Promise<boolean> {
  if (actor.type !== "user") return false;
  for (const permission of FEE_VIEW_PERMISSIONS) {
    if (await hasPermission(db, actor.id, permission, "hospital")) return true;
  }
  return false;
}

/** The columns of a visit row that say something about money: the desk's bypass and the retired doctor's override. */
export const ENCOUNTER_MONEY_KEYS = [
  "feeBypassBy", "feeBypassReason", "feeBypassAt", "consultFeeOverrideBy", "consultFeeOverrideReason", "consultFeeOverrideAt",
] as const;
type MoneyKey = (typeof ENCOUNTER_MONEY_KEYS)[number];

/** A visit row as a doctor's screen receives it. Keys are deleted, not nulled — a null would read as "no bypass". */
export function encounterWithoutMoney<T extends object>(encounter: T): Omit<T, MoneyKey> {
  const out = { ...encounter } as Record<string, unknown>;
  for (const k of ENCOUNTER_MONEY_KEYS) delete out[k];
  return out as Omit<T, MoneyKey>;
}
