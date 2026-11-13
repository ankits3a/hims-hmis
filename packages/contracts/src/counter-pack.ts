/**
 * ═══ THE PACK THAT CROSSES THE COUNTER — ONE RULE FOR THE SERVER AND THE DESK (#1047) ═══
 *
 * A quantity is read at the counter as packs + loose units ("1 strip + 5 tablets"). The server's bill rows
 * (`pharmacy/bill-rows.ts` `counterPacks`) took the SMALLEST pack above one unit and the dispense desk
 * (`pharmacy-desk/work.ts` `packOf`) the LARGEST, so an item with a strip and a box read differently on the bill
 * and on the screen. Both now read this:
 *
 *   1. the item's ISSUE pack — a unit flagged `isIssueUom` with more than one base unit in it (the smallest
 *      such, if several are flagged);
 *   2. else the smallest pack above one unit;
 *   3. else none (loose stock).
 *
 * The base unit is always flagged as an issue unit (multiplier 1), so rule 1 never picks it. Pure, no imports:
 * the web reads this file directly.
 */
export type CounterPackUnit = { uom: string; toBaseMultiplier: number; isIssueUom?: boolean | null };

export function counterPackOf<U extends CounterPackUnit>(uoms: readonly U[]): U | null {
  const packs = uoms.filter((u) => u.toBaseMultiplier > 1).sort((a, b) => a.toBaseMultiplier - b.toBaseMultiplier);
  return packs.find((u) => u.isIssueUom === true) ?? packs[0] ?? null;
}
