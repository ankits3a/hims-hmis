import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import {
  activateVendor, addVendorDocument, availableQtyByItem, captureGrn, findStoreByCode, getGrn, itemsByIds, listGrns, listVendors, postGrn,
  registerVendor, runGateQc, uomsByItems,
} from "../src/modules/materials";
import { OPD_PHARMACY_STORE_CODE, listSaleItems } from "../src/modules/pharmacy";
import { parseBundle } from "./build-pharmacy-starter-list";
import { addDays, argValue, hasFlag, istDay, resolvePerson } from "./pharmacy-shelf-common";
import type { Person } from "./pharmacy-shelf-common";
import type { DpcoRow } from "./build-pharmacy-starter-list";
import type { Db, Tx } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/load-trial-stock.ts --i-understand-trial --as <materials_head> --pharmacist <pharmacist> [--apply]`
 *
 * ═══ TRIAL STOCK — SO A REAL TICKET CAN BE WALKED END TO END BEFORE THE REAL SHELF IS COUNTED ═══
 *
 * Owner ruling 2026-09-22: load realistic TRIAL stock now, walk a real ticket (prescribe → claim →
 * verify → pick → bill → hand over), then — once the pharmacist has counted the real shelf into
 * `import-opening-stock.ts` — remove every trial unit with `wipe-trial-stock.ts`. The owner
 * authorised it on PRODUCTION, which `seed-pharmacy-demo.ts` refuses; this may run there, but only when
 * asked in words (`--i-understand-trial`), and everything it writes says TRIAL on its face:
 *
 *   vendor   code `TRIAL-STOCK`, legal name "TRIAL STOCK — NOT A SUPPLIER", its paper numbered
 *            `TRIAL-NOT-A-…` — never a real GSTIN, PAN or licence number;
 *   GRNs     challan `TRIAL/AGED/nn` and `TRIAL/FRESH/nn`, one pair per ~50 items;
 *   batches  `TRIAL-<item code>-A|B|C`.
 *
 * ═══ WHAT THE SHELF LOOKS LIKE ═══
 *
 * Every active sale item at PHARM-OPD gets two or three batches:
 *   A  expires 60–90 days out, so FEFO has something to pick first and the near-expiry colour shows;
 *   B  6–15 months out;   C  15–24 months out (two items in three).
 * Every seventh item is deliberately SHORT (one pack in A and B, no C), so a short-stock line is walked.
 *
 * Batch A comes in on a challan dated 150 days ago. QC rule 5 (O-2) sends a line whose expiry is under
 * 183 days after its CHALLAN date to a near-expiry approval, correctly; a delivery that arrived five
 * months ago with seven months left is the honest way a shelf acquires a short-dated batch — the
 * `seed-pharmacy-demo.ts` precedent. Nothing here bypasses the gate: every line must PASS QC or nothing
 * is written.
 *
 * ═══ THE PRICES ═══
 *
 * MRP per pack from the CDS bundle's `dpco_jan_aushadhi_index` (estimated branded MRP per unit × pack)
 * where the item names that generic and strength — 7 rows, so it rarely does — else a plausible market
 * MRP for the form, stable per item (a hash of its code). Always divisible by the pack multiplier:
 * `mrpPerBaseUnit` refuses an MRP that is not whole paise per tablet (QC `mrp_unconvertible`). Cost is
 * 70% of MRP per base unit. These are TRIAL prices on TRIAL batches; the counter bills them as it would
 * any batch, which is the point of the walk.
 *
 * ═══ SAFE TO RERUN ═══
 *
 * A challan already on file for the TRIAL vendor is skipped, so a rerun posts nothing twice; items
 * added to the shelf since get a new challan pair. Everything is written in ONE transaction.
 */

export const TRIAL_VENDOR_CODE = "TRIAL-STOCK";
export const TRIAL_VENDOR_NAME = "TRIAL STOCK — NOT A SUPPLIER";
export const TRIAL_BATCH_PREFIX = "TRIAL-";
const CHUNK = 50;
const AGED_DAYS_AGO = 150;

export type TrialLine = { itemId: string; code: string; name: string; batchNo: string; expiryDate: string; uom: string; qtyInUom: number; mrpPaise: number; mrpUom: string; unitCostPaise: number };
export type TrialGrn = { challanNo: string; challanDate: string; challanAt: Date; lines: TrialLine[]; skip: boolean };
export type TrialPlan = { vendorExists: boolean; grns: TrialGrn[]; storeId: string; items: number; shortItems: number };

function h(s: string, mod: number): number {
  return createHash("sha256").update(s).digest().readUInt32BE(0) % mod;
}

/** Rupees-per-base-unit bands by base unit, in paise. A pack's MRP is the base price × the multiplier. */
const BAND: Record<string, [number, number]> = {
  tablet: [150, 1500], capsule: [300, 2000], bottle: [4500, 18000], tube: [4000, 22000], inhaler: [18000, 45000],
  sachet: [2000, 6000], suppository: [1500, 6000], vial: [5000, 30000],
};

export function trialMrpPerBase(code: string, baseUom: string, name: string, dpco: readonly DpcoRow[]): number {
  const lower = name.toLowerCase();
  for (const d of dpco) {
    const strength = /([\d.]+)\s*mg/i.exec(d.strengthAndForm)?.[1];
    const single = !d.genericName.includes("+");
    if (single && strength !== undefined && lower.includes(d.genericName.toLowerCase().replace(/ sr$/, "")) && new RegExp(`\\b${strength} mg\\b`).test(lower)
      && /tablet/.test(d.strengthAndForm.toLowerCase()) === (baseUom === "tablet") && d.brandedMrpInr > 0) {
      return Math.round(d.brandedMrpInr * 100);
    }
  }
  const [lo, hi] = BAND[baseUom] ?? [2000, 10000];
  const step = baseUom === "tablet" || baseUom === "capsule" ? 10 : 500;
  return lo + step * h(code, Math.floor((hi - lo) / step) + 1);
}

export async function planTrialStock(db: Db, now: Date, dpco: readonly DpcoRow[] = []): Promise<TrialPlan> {
  const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  if (store === undefined) throw new Error(`the "${OPD_PHARMACY_STORE_CODE}" store does not exist — run seed:pharmacy first`);
  const sale = (await listSaleItems(db)).filter((s) => s.active && s.itemActive).sort((a, b) => a.code.localeCompare(b.code));
  if (sale.length === 0) throw new Error("no active sale items — load the shelf first (load-pharmacy-shelf.ts)");
  const vendor = (await listVendors(db, { search: TRIAL_VENDOR_CODE })).find((v) => v.code === TRIAL_VENDOR_CODE);
  const onFile = new Set(vendor === undefined ? [] : (await listGrns(db, { vendorId: vendor.id })).map((g) => g.challanNo));
  /* An item that already HAS a trial batch (from an earlier run) is not given another: the challan
     numbers are positional, so a shelf that grew would otherwise re-cut every chunk. */
  const itemRows = await itemsByIds(db, sale.map((s) => s.itemId));
  const uoms = await uomsByItems(db, sale.map((s) => s.itemId));
  const already = await trialBatchedItems(db, vendor?.id);
  const todo = sale.filter((s) => !already.has(s.itemId));
  const agedAt = addDays(now, -AGED_DAYS_AGO);
  const freshAt = addDays(now, -3);
  const grns: TrialGrn[] = [];
  let shortItems = 0;
  let serial = onFile.size / 2;
  for (let i = 0; i < todo.length; i += CHUNK) {
    serial += 1;
    const tag = String(serial).padStart(2, "0");
    const aged: TrialLine[] = []; const fresh: TrialLine[] = [];
    for (const [j, s] of todo.slice(i, i + CHUNK).entries()) {
      const item = itemRows.get(s.itemId);
      if (item === undefined) continue;
      const pack = (uoms.get(s.itemId) ?? []).find((u) => u.toBaseMultiplier > 1);
      const uom = pack?.uom ?? item.baseUom;
      const mult = pack?.toBaseMultiplier ?? 1;
      const perBase = trialMrpPerBase(item.code, item.baseUom, item.name, dpco);
      const mrp = perBase * mult;
      const cost = Math.floor(perBase * 0.7);
      const short = (i + j) % 7 === 3;
      if (short) shortItems += 1;
      const packs = (lo: number, hi: number, salt: string): number => (short ? 1 : lo + h(`${item.code}${salt}`, hi - lo + 1));
      const line = (suffix: string, expiry: Date, qty: number): TrialLine => ({
        itemId: item.id, code: item.code, name: item.name, batchNo: `${TRIAL_BATCH_PREFIX}${item.code}-${suffix}`, expiryDate: istDay(expiry),
        uom, qtyInUom: qty, mrpPaise: mrp, mrpUom: uom, unitCostPaise: cost,
      });
      aged.push(line("A", addDays(now, 60 + h(`${item.code}A`, 31)), packs(2, 5, "A")));
      fresh.push(line("B", addDays(now, 183 + h(`${item.code}B`, 275)), packs(5, 15, "B")));
      if (!short && h(`${item.code}C`, 3) !== 0) fresh.push(line("C", addDays(now, 457 + h(`${item.code}C`, 273)), packs(5, 15, "C")));
    }
    grns.push({ challanNo: `TRIAL/AGED/${tag}`, challanDate: istDay(agedAt), challanAt: agedAt, lines: aged, skip: onFile.has(`TRIAL/AGED/${tag}`) });
    grns.push({ challanNo: `TRIAL/FRESH/${tag}`, challanDate: istDay(freshAt), challanAt: freshAt, lines: fresh, skip: onFile.has(`TRIAL/FRESH/${tag}`) });
  }
  return { vendorExists: vendor !== undefined, grns, storeId: store.id, items: todo.length, shortItems };
}

/** Items that already carry a TRIAL batch from this vendor's GRNs. */
async function trialBatchedItems(db: Db, vendorId: string | undefined): Promise<Set<string>> {
  if (vendorId === undefined) return new Set();
  const out = new Set<string>();
  for (const g of await listGrns(db, { vendorId })) {
    for (const l of (await getGrn(db, g.id))?.lines ?? []) out.add(l.itemId);
  }
  return out;
}

async function ensureTrialVendor(tx: Tx, head: Person, now: Date): Promise<string> {
  const found = (await listVendors(tx, { search: TRIAL_VENDOR_CODE })).find((v) => v.code === TRIAL_VENDOR_CODE);
  if (found !== undefined) return found.id;
  const { vendorId } = await registerVendor(tx, head, {
    code: TRIAL_VENDOR_CODE, legalName: TRIAL_VENDOR_NAME, tradeName: "TRIAL STOCK", gstin: null, pan: null,
    paymentTermsDays: null, classFlags: { drugLicensed: true },
  });
  for (const type of ["gst_certificate", "pan", "drug_licence_20b", "drug_licence_21b"]) {
    await addVendorDocument(tx, head, vendorId, { type, number: `TRIAL-NOT-A-${type.toUpperCase()}`, validFrom: null, validTo: null });
  }
  await activateVendor(tx, head, vendorId, now);
  return vendorId;
}

export async function applyTrialStock(
  db: Db, head: Person, pharmacist: Person, plan: TrialPlan, now: Date = new Date(),
): Promise<{ vendorCreated: boolean; grnsPosted: number; lines: number; units: number }> {
  return withTx(db, async (tx) => {
    const vendorId = await ensureTrialVendor(tx, head, now);
    let grnsPosted = 0; let lines = 0; let units = 0;
    for (const g of plan.grns) {
      if (g.skip || g.lines.length === 0) continue;
      const { grnId } = await captureGrn(tx, head, {
        vendorId, source: "challan", storeResourceId: plan.storeId, challanNo: g.challanNo, challanDate: g.challanDate,
        invoiceNo: null, lines: g.lines.map((l) => ({
          itemId: l.itemId, uom: l.uom, qtyInUom: l.qtyInUom, batchNo: l.batchNo, expiryDate: l.expiryDate,
          mrpPaise: l.mrpPaise, mrpUom: l.mrpUom, unitCostPaise: l.unitCostPaise,
        })), now: g.challanAt, serviceDate: g.challanDate,
      });
      const qc = await runGateQc(tx, pharmacist, grnId);
      const failed = qc.verdicts.filter((v) => v.verdict !== "pass");
      if (failed.length > 0) {
        throw new Error(`${g.challanNo}: QC did not pass ${String(failed.length)} line(s) (${[...new Set(failed.map((f) => f.rule ?? f.verdict))].join(", ")}) — NOTHING was written`);
      }
      const posted = await postGrn(tx, pharmacist, grnId, g.challanAt);
      if (posted.ledgerEntryIds.length !== g.lines.length) throw new Error(`${g.challanNo} posted ${String(posted.ledgerEntryIds.length)} of ${String(g.lines.length)} lines — NOTHING was written`);
      grnsPosted += 1; lines += g.lines.length;
    }
    const itemIds = [...new Set(plan.grns.flatMap((g) => g.lines.map((l) => l.itemId)))];
    units = [...(await availableQtyByItem(tx, plan.storeId, itemIds, now)).values()].reduce((a, b) => a + b, 0);
    return { vendorCreated: !plan.vendorExists, grnsPosted, lines, units };
  });
}

/** The refusal, before a database is even opened: trial stock is written only when asked for in words. */
export function requireTrialConsent(argv: readonly string[]): void {
  if (!hasFlag(argv, "--i-understand-trial")) {
    throw new Error(
      "load-trial-stock REFUSES without --i-understand-trial.\n" +
      `  It writes a vendor "${TRIAL_VENDOR_NAME}" and TRIAL batches of every sale item into ${OPD_PHARMACY_STORE_CODE} —\n` +
      "  stock the counter WILL dispense and bill. The owner authorised it (2026-09-22) so a real ticket can be\n" +
      "  walked; it comes off with wipe-trial-stock.ts before the real opening stock goes on.",
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  requireTrialConsent(argv);
  const url = requireEnv("DATABASE_URL");
  const { db, pool } = createDb(url);
  try {
    const head = await resolvePerson(db, argValue(argv, "--as"), "materials.vendors.manage", "--as");
    const pharmacist = await resolvePerson(db, argValue(argv, "--pharmacist"), "materials.grn.qc", "--pharmacist");
    let dpco: DpcoRow[] = [];
    try { dpco = parseBundle(readFileSync(argValue(argv, "--bundle") ?? "/opt/hmis-context/cds-bundle/cds-bundle.sql", "utf8")).dpco; } catch { /* no bundle: form bands only */ }
    const now = new Date();
    const plan = await planTrialStock(db, now, dpco);
    const dbName = new URL(url).pathname.replace(/^\//, "");
    process.stdout.write(`TRIAL STOCK → database "${dbName}", store ${OPD_PHARMACY_STORE_CODE}\n`);
    process.stdout.write(`  vendor ${TRIAL_VENDOR_CODE} "${TRIAL_VENDOR_NAME}": ${plan.vendorExists ? "on file" : "WILL BE CREATED (documents numbered TRIAL-NOT-A-…)"}\n`);
    for (const g of plan.grns) {
      process.stdout.write(`  GRN ${g.challanNo} dated ${g.challanDate}: ${g.skip ? "already on file — skipped" : `${String(g.lines.length)} lines`}\n`);
      if (g.skip) continue;
      for (const l of g.lines) {
        process.stdout.write(`    ${l.code.padEnd(16)} ${l.batchNo.padEnd(26)} exp ${l.expiryDate}  ${String(l.qtyInUom).padStart(3)} ${l.uom.padEnd(8)} MRP ₹${(l.mrpPaise / 100).toFixed(2)}/${l.mrpUom}  cost ₹${(l.unitCostPaise / 100).toFixed(2)}/unit\n`);
      }
    }
    const lineCount = plan.grns.filter((g) => !g.skip).reduce((n, g) => n + g.lines.length, 0);
    process.stdout.write(`\n  ${String(plan.items)} items · ${String(plan.shortItems)} deliberately short · ${String(plan.grns.filter((g) => !g.skip).length)} GRNs · ${String(lineCount)} batch lines\n`);
    if (!hasFlag(argv, "--apply")) { process.stdout.write("\nDRY RUN — nothing written. Re-run with --apply --i-understand-trial.\n"); return; }
    const done = await applyTrialStock(db, head, pharmacist, plan, now);
    process.stdout.write(`\nAPPLIED in one transaction: vendor ${done.vendorCreated ? "created" : "reused"}, ${String(done.grnsPosted)} GRNs posted, ${String(done.lines)} batch lines, ${String(done.units)} units now sellable.\n  Remove it all with wipe-trial-stock.ts before the opening stock goes on.\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
