import { desc } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { storesPayingSettings } from "../../kernel/db/schema";
import { recordAct } from "./access";
import { ex, holdsRole, peopleNamed } from "./buying-common";
import { StoresError } from "./errors";
import type { Exec } from "./buying-common";
import type { Actor, WirePayingSettings } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S6a (#1116, decision 13; ruling 0101) — THE PAYING DESK'S SWITCHES. Every switch that could move a pharmacy
 * number is OFF at merge: `holds_cover_pharmacy` (pharmacy-only bills get no hold), `msme_rule` `as_today` (S6b: the Act's
 * clock, `msme.ts`, only when `act`) and `tds_goods` (S6b: the TDS table's purchase-of-goods row reaches pharmacy's
 * suppliers only when on). `msme_traders_on_clock` is the CA's line (default on, the cautious side). Versioned rows,
 * newest wins; no row = the defaults. The owner switches, by a recorded yes that names the dry run it followed
 * (`dryRunAt`, at most a day old when a switch goes ON: `holdsDryRun`, `msmeDryRun`, `tdsDryRun`). One act per change.
 */
export const PAYING_DEFAULTS: WirePayingSettings = {
  version: 0, holdsCoverPharmacy: false, msmeRule: "as_today", outOfPatternMultipleBps: 20_000, firstBillLimitPaise: 10_000_000,
  tdsGoods: false, msmeTradersOnClock: true, setAt: null, setBy: null,
};
const DRY_RUN_FRESH_MS = 24 * 60 * 60_000;

export async function payingSettings(db: Exec): Promise<WirePayingSettings> {
  const [row] = await ex(db).select().from(storesPayingSettings).orderBy(desc(storesPayingSettings.version)).limit(1);
  if (row === undefined) return { ...PAYING_DEFAULTS };
  const person = await peopleNamed(db, [row.setBy]);
  return {
    version: row.version, holdsCoverPharmacy: row.holdsCoverPharmacy, msmeRule: row.msmeRule as WirePayingSettings["msmeRule"],
    outOfPatternMultipleBps: row.outOfPatternMultipleBps, firstBillLimitPaise: row.firstBillLimitPaise,
    tdsGoods: row.tdsGoods, msmeTradersOnClock: row.msmeTradersOnClock, setAt: row.setAt.toISOString(), setBy: person(row.setBy),
  };
}

export type PayingSwitches = { holdsCoverPharmacy?: boolean; msmeRule?: "as_today" | "act"; tdsGoods?: boolean; msmeTradersOnClock?: boolean; dryRunAt: string };

export async function setPayingSettings(db: Db, actor: Actor, input: PayingSwitches, now: Date = new Date()): Promise<WirePayingSettings> {
  if (!(await holdsRole(db, actor, "owner"))) throw new StoresError("not_permitted", "the paying switches are the owner's");
  const dry = new Date(input.dryRunAt);
  await withTx(db, async (tx) => {
    const before = await payingSettings(tx);
    const next = {
      holdsCoverPharmacy: input.holdsCoverPharmacy ?? before.holdsCoverPharmacy, msmeRule: input.msmeRule ?? before.msmeRule,
      tdsGoods: input.tdsGoods ?? before.tdsGoods ?? false, msmeTradersOnClock: input.msmeTradersOnClock ?? before.msmeTradersOnClock ?? true,
    };
    // A switch that moves a pharmacy number toward "on" needs its dry run, at most a day old.
    const goingOn = (next.holdsCoverPharmacy && !before.holdsCoverPharmacy) || (next.msmeRule === "act" && before.msmeRule !== "act")
      || (next.tdsGoods && !before.tdsGoods) || (!next.msmeTradersOnClock && before.msmeTradersOnClock);
    if (Number.isNaN(dry.getTime()) || dry > now || (goingOn && now.getTime() - dry.getTime() > DRY_RUN_FRESH_MS)) {
      throw new StoresError("state_changed", "see what changes first: the dry run is at most a day old");
    }
    const id = newId();
    await tx.insert(storesPayingSettings).values({
      id, version: before.version + 1, ...next,
      outOfPatternMultipleBps: before.outOfPatternMultipleBps, firstBillLimitPaise: before.firstBillLimitPaise, dryRunAt: dry, setBy: actor.id, setAt: now,
    });
    await recordAct(tx, actor, now, {
      act: "paying_settings", refId: id, reason: `after the dry run of ${dry.toISOString()}`,
      before: { holdsCoverPharmacy: before.holdsCoverPharmacy, msmeRule: before.msmeRule, tdsGoods: before.tdsGoods, msmeTradersOnClock: before.msmeTradersOnClock, version: before.version },
      after: { ...next, version: before.version + 1, dryRunAt: dry.toISOString() },
    });
  });
  return payingSettings(db);
}
