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
 * number is OFF at merge: `holds_cover_pharmacy` (pharmacy-only bills get no hold) and `msme_rule` `as_today` (S6b wires
 * the Act's clock behind it). Versioned rows, newest wins; no row = the defaults. The owner switches, by a recorded yes
 * that names the dry run it followed (`dryRunAt`, at most a day old when a switch goes on). One act per change.
 */
export const PAYING_DEFAULTS: WirePayingSettings = {
  version: 0, holdsCoverPharmacy: false, msmeRule: "as_today", outOfPatternMultipleBps: 20_000, firstBillLimitPaise: 10_000_000, setAt: null, setBy: null,
};
const DRY_RUN_FRESH_MS = 24 * 60 * 60_000;

export async function payingSettings(db: Exec): Promise<WirePayingSettings> {
  const [row] = await ex(db).select().from(storesPayingSettings).orderBy(desc(storesPayingSettings.version)).limit(1);
  if (row === undefined) return { ...PAYING_DEFAULTS };
  const person = await peopleNamed(db, [row.setBy]);
  return {
    version: row.version, holdsCoverPharmacy: row.holdsCoverPharmacy, msmeRule: row.msmeRule as WirePayingSettings["msmeRule"],
    outOfPatternMultipleBps: row.outOfPatternMultipleBps, firstBillLimitPaise: row.firstBillLimitPaise, setAt: row.setAt.toISOString(), setBy: person(row.setBy),
  };
}

export async function setPayingSettings(db: Db, actor: Actor, input: { holdsCoverPharmacy: boolean; dryRunAt: string }, now: Date = new Date()): Promise<WirePayingSettings> {
  if (!(await holdsRole(db, actor, "owner"))) throw new StoresError("not_permitted", "the paying switches are the owner's");
  const dry = new Date(input.dryRunAt);
  if (Number.isNaN(dry.getTime()) || dry > now || (input.holdsCoverPharmacy && now.getTime() - dry.getTime() > DRY_RUN_FRESH_MS)) {
    throw new StoresError("state_changed", "see what changes first: the dry run is at most a day old");
  }
  await withTx(db, async (tx) => {
    const before = await payingSettings(tx);
    const id = newId();
    await tx.insert(storesPayingSettings).values({
      id, version: before.version + 1, holdsCoverPharmacy: input.holdsCoverPharmacy, msmeRule: before.msmeRule,
      outOfPatternMultipleBps: before.outOfPatternMultipleBps, firstBillLimitPaise: before.firstBillLimitPaise, dryRunAt: dry, setBy: actor.id, setAt: now,
    });
    await recordAct(tx, actor, now, {
      act: "paying_settings", refId: id, reason: `after the dry run of ${dry.toISOString()}`,
      before: { holdsCoverPharmacy: before.holdsCoverPharmacy, msmeRule: before.msmeRule, version: before.version },
      after: { holdsCoverPharmacy: input.holdsCoverPharmacy, msmeRule: before.msmeRule, version: before.version + 1, dryRunAt: dry.toISOString() },
    });
  });
  return payingSettings(db);
}
