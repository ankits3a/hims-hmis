import { desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { grnLines, grns, orgDepartments, resources, storesServiceEntries, storesTallyLedgers, supplierBills } from "../../kernel/db/schema";
import { registerPurchaseSplitSource } from "../materials";
import { holds, recordAct } from "./access";
import { clean, ex } from "./buying-common";
import { StoresError } from "./errors";
import { taxLinesOf } from "./tax-on-bill";
import type { Exec } from "./buying-common";
import type { Actor, WireStoresTallyLedgers } from "@hmis/contracts";
import type { PurchaseSplit, PurchaseSplitEntry } from "../materials";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S6b (#1116, decision 10) — THE ONE TALLY EXPORT, READ PER LINE (registered with materials at import; pharmacy's
 * `tally.ts` asks `purchaseSplitsFor`). A bill with no Stores or service line, no reverse charge and no TDS is left out,
 * and pharmacy writes its voucher exactly as before (a drug-only month's file is byte-identical:
 * `pharmacy/stores-s6b-no-change.test.ts`).
 *
 * A split voucher, line by line:
 *   - a pharmacy line: pharmacy's own purchase and input GST ledgers, as today;
 *   - a Stores line: the purchase ledger of its top category (`purchase:<code>`), or for a TAGGED unit (S4) the fixed-asset
 *     ledger (`asset:<code>`), carrying the line's cost centre (a service line's department; a GRN line's receiving place —
 *     a shelf's department, else the store's code: the `payablesByGroup` rule). Its GST goes to the input ledgers when
 *     the mark is `eligible` or `shared` (the share is the accountant's monthly working), and INTO the purchase or asset
 *     amount when `not_available`;
 *   - reverse charge: the GST the supplier did not bill is credited to `rcm_liability` and debited as the mark says;
 *   - TDS: credited to `tds:<nature>`; the party is credited the total less TDS.
 * Names are the accountant's (`setStoresTallyLedgers`); a key with no name is listed and the export refuses before writing.
 */
const GROUPS = { purchase: "Purchase Accounts", asset: "Fixed Assets", tds: "Duties & Taxes", rcm_liability: "Duties & Taxes" } as const;
const TALLY_EXPORT = "pharmacy.tally.export";

/** The newest name per key. */
async function ledgerNames(db: Exec): Promise<Map<string, string>> {
  const rows = await ex(db).select().from(storesTallyLedgers).orderBy(desc(storesTallyLedgers.setAt), desc(storesTallyLedgers.id));
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.key)) out.set(r.key, r.name);
  return out;
}

const groupOf = (key: string): string => (key.startsWith("asset:") ? GROUPS.asset : key.startsWith("tds:") ? GROUPS.tds : key === "rcm_liability" ? GROUPS.rcm_liability : GROUPS.purchase);
const KEY = /^(purchase:[A-Z0-9_-]{1,40}|asset:[A-Z0-9_-]{1,40}|tds:(contract|professional|rent|commission|goods)|rcm_liability)$/;

/** The accountant names (or renames) Stores ledgers; one row per change, the newest wins. */
export async function setStoresTallyLedgers(db: Db, actor: Actor, names: Record<string, string>, now: Date = new Date()): Promise<WireStoresTallyLedgers> {
  if (!(await holds(db, actor, TALLY_EXPORT))) throw new StoresError("not_permitted", "the Tally ledgers are the accountant's", { permission: TALLY_EXPORT });
  const rows = Object.entries(names).map(([key, name]) => ({ key: key.trim(), name: clean(name)?.replace(/\s+/g, " ") ?? "" }));
  for (const r of rows) if (!KEY.test(r.key) || r.name === "" || r.name.length > 100) throw new StoresError("bad_tax_table", `a ledger name of 1–100 characters for ${r.key}`, { key: r.key });
  await withTx(db, async (tx) => {
    const before = await ledgerNames(tx);
    const changed = rows.filter((r) => before.get(r.key) !== r.name);
    if (changed.length === 0) return;
    await tx.insert(storesTallyLedgers).values(changed.map((r) => ({ id: newId(), key: r.key, name: r.name, setBy: actor.id, setAt: now })));
    await recordAct(tx, actor, now, {
      act: "tally_ledgers", before: Object.fromEntries(changed.map((r) => [r.key, before.get(r.key) ?? null])), after: Object.fromEntries(changed.map((r) => [r.key, r.name])),
    });
  });
  return storesTallyLedgerNames(db, actor);
}

/** The names on file and the keys the open months' Stores bills still need. */
export async function storesTallyLedgerNames(db: Db, actor: Actor): Promise<WireStoresTallyLedgers> {
  if (!(await holds(db, actor, TALLY_EXPORT))) throw new StoresError("not_permitted", "the Tally ledgers are the accountant's", { permission: TALLY_EXPORT });
  const names = await ledgerNames(db);
  const recent = await db.select({ id: supplierBills.id }).from(supplierBills).where(sql`${supplierBills.status} in ('accepted', 'part_paid', 'paid') and ${supplierBills.billDate} >= current_date - 400`);
  const splits = await splitsOf(db, recent.map((r) => r.id));
  return { names: Object.fromEntries(names), needed: [...new Set([...splits.values()].flatMap((s) => s.missing))].sort() };
}

/** CGST/SGST halves (SGST the odd paisa) or IGST whole: materials' split, for the GST a reverse-charge supplier did not bill. */
const halves = (gst: number, interState: boolean): { inputCgst: number; inputSgst: number; inputIgst: number } =>
  (interState ? { inputCgst: 0, inputSgst: 0, inputIgst: gst } : { inputCgst: Math.floor(gst / 2), inputSgst: gst - Math.floor(gst / 2), inputIgst: 0 });
const lineGst = (taxable: number, bps: number): number => Math.round((taxable * bps) / 10_000);

async function splitsOf(db: Exec, billIds: readonly string[]): Promise<Map<string, PurchaseSplit>> {
  const out = new Map<string, PurchaseSplit>();
  if (billIds.length === 0) return out;
  const lines = await taxLinesOf(db, billIds);
  const bills = new Map((await ex(db).select().from(supplierBills).where(inArray(supplierBills.id, [...billIds]))).map((b) => [b.id, b] as const));
  const needs = new Set([...bills.values()].filter((b) => (b.tdsPaise ?? 0) > 0).map((b) => b.id));
  for (const l of lines) if (l.storesLine || l.reverseCharge) needs.add(l.billId);
  if (needs.size === 0) return out;
  const mine = lines.filter((l) => needs.has(l.billId));
  // Where each line was received: its GRN line's place (and whether its batch carries a tagged unit), or its SES's department.
  const grnIds = [...new Set(mine.map((l) => l.grnId).filter((x): x is string => x !== null))];
  const grnRows = grnIds.length === 0 ? [] : await ex(db).select({
    grnId: grnLines.grnId, itemId: grnLines.itemId, code: resources.code, attributes: resources.attributes,
    tagged: sql<boolean>`exists (select 1 from stores_asset_units u where u.batch_id = ${grnLines.batchId})`,
  }).from(grnLines).innerJoin(grns, eq(grns.id, grnLines.grnId)).innerJoin(resources, eq(resources.id, grns.storeResourceId)).where(inArray(grnLines.grnId, grnIds));
  const sesIds = [...new Set(mine.map((l) => l.sesId).filter((x): x is string => x !== null))];
  const sesDept = new Map(sesIds.length === 0 ? [] : (await ex(db).select({ id: storesServiceEntries.id, code: orgDepartments.code }).from(storesServiceEntries)
    .innerJoin(orgDepartments, eq(orgDepartments.id, storesServiceEntries.departmentId)).where(inArray(storesServiceEntries.id, sesIds))).map((r) => [r.id, r.code] as const));
  const names = await ledgerNames(db);

  for (const billId of needs) {
    const b = bills.get(billId);
    if (b === undefined) continue;
    const entries: PurchaseSplitEntry[] = [];
    const missing = new Set<string>();
    const named = (key: string): { ledger: string; group: string } => {
      const n = names.get(key);
      if (n === undefined) missing.add(key);
      return { ledger: n ?? key, group: groupOf(key) };
    };
    const input = (amounts: { inputCgst: number; inputSgst: number; inputIgst: number }): void => {
      for (const std of ["inputCgst", "inputSgst", "inputIgst"] as const) if (amounts[std] !== 0) entries.push({ std, amountPaise: amounts[std], costCentre: null });
    };
    const tdsByNature = new Map<string, number>();
    for (const l of mine.filter((x) => x.billId === billId)) {
      if ((l.tdsPaise ?? 0) > 0) tdsByNature.set(l.tdsNature ?? "goods", (tdsByNature.get(l.tdsNature ?? "goods") ?? 0) + l.tdsPaise!);
      // The line's own GST as billed (0 under reverse charge), split as the bill split it.
      const billed = { inputCgst: l.cgstPaise, inputSgst: l.sgstPaise, inputIgst: l.igstPaise };
      const rcGst = l.reverseCharge ? lineGst(l.taxablePaise, l.gstRateBps) : 0;
      if (!l.storesLine) {
        entries.push({ std: "purchases", amountPaise: l.taxablePaise, costCentre: null });
        input(billed);
        input(halves(rcGst, b.interState));
      } else {
        const g = l.grnId === null ? undefined : grnRows.find((r) => r.grnId === l.grnId && r.itemId === l.itemId);
        const top = l.topCode ?? "OTHER";
        const key = g?.tagged === true ? `asset:${top}` : `purchase:${top}`;
        const attrs = (g?.attributes ?? {}) as { departmentCode?: string };
        const cc = l.sesId !== null ? (sesDept.get(l.sesId) ?? null) : g !== undefined ? (attrs.departmentCode ?? g.code) : null;
        const credit = l.gstCredit ?? "not_available";
        const gst = l.billGstPaise + rcGst;
        if (credit === "not_available") entries.push({ ...named(key), amountPaise: l.taxablePaise + gst, costCentre: cc });
        else {
          entries.push({ ...named(key), amountPaise: l.taxablePaise, costCentre: cc });
          input(billed);
          input(halves(rcGst, b.interState));
        }
      }
      if (rcGst > 0) entries.push({ ...named("rcm_liability"), amountPaise: -rcGst, costCentre: null });
    }
    for (const [nature, paise] of [...tdsByNature].sort(([a], [z]) => a.localeCompare(z))) entries.push({ ...named(`tds:${nature}`), amountPaise: -paise, costCentre: null });
    out.set(billId, { entries, deductedPaise: b.tdsPaise ?? 0, missing: [...missing].sort() });
  }
  return out;
}

registerPurchaseSplitSource((db: Db | Tx, billIds) => splitsOf(db, billIds));
