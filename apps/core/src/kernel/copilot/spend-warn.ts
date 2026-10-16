import { withTx } from "../db/client";
import { raiseNotice } from "../alerts/notices";
import { usersHoldingRole } from "../workflow/roles";
import { istDayString } from "../approvals/cumulative";
import type { Db } from "../db/client";

/**
 * ═══ #583 (E0.5, decision 0064) — AT 80 % OF THE DAY'S CAP, THE OWNER IS TOLD ═══
 *
 * The cap itself is the controller's: at 100 % every ask goes phrasebook-only until midnight IST and
 * the health page says so. This is the warning BEFORE that, so the owner can raise the cap
 * (`COPILOT_DAILY_CAP_INR`) or look at what is spending before the desk loses the model.
 *
 * ONCE PER OWNER PER IST DAY, by construction: the bell row's key is `copilot-spend-near-cap:<IST
 * day>`, and `raiseNotice` writes nothing for a key it already holds. So the check may run on every
 * ask at or past the line — two asks crossing it at once, or every ask between 80 % and 100 %, still
 * make one row — and the next IST day starts fresh.
 *
 * The threshold is a FRACTION of the configured cap, never rupees: the cap and the price table live
 * in config. A cap of zero is a brake switched off, not a brake tripped, and warns nobody. The body
 * says rupees as a share of the cap only; it names no patient, no question and no staff member.
 */
export const COPILOT_SPEND_WARN_KIND = "copilot.spend_near_cap";
export const COPILOT_SPEND_WARN_FRACTION = 0.8;
const OWNER_ROLE = "owner";

/** Warn every owner once per IST day when the day's spend is at or past 80 % of the cap. Returns how many were told now. */
export async function warnOwnersNearCap(
  db: Db,
  input: { spentMicroInr: number; capMicroInr: number; now: Date },
): Promise<number> {
  const { spentMicroInr, capMicroInr, now } = input;
  if (capMicroInr <= 0 || spentMicroInr < capMicroInr * COPILOT_SPEND_WARN_FRACTION) return 0;
  const day = istDayString(now);
  const owners = await withTx(db, (tx) => usersHoldingRole(tx, OWNER_ROLE));
  const pct = Math.floor((spentMicroInr / capMicroInr) * 100);
  let told = 0;
  for (const userId of owners) {
    const won = await raiseNotice(db, {
      userId, kind: COPILOT_SPEND_WARN_KIND, refType: "copilot_spend", refId: day,
      title: `Copilot AI spend has passed ${String(Math.round(COPILOT_SPEND_WARN_FRACTION * 100))}% of today's cap`,
      body: `Estimated spend today is ${String(pct)}% of the daily cap. At 100% the copilot answers from its phrasebook only until midnight IST. See the copilot health page.`,
      sourceKey: `copilot-spend-near-cap:${day}`, at: now,
    });
    if (won) told += 1;
  }
  return told;
}
