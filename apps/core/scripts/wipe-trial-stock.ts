import { and, eq, sql } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { stockLedger } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import { balances, getBatch, getGrn, listGrns, listVendors, postMovements, suspendVendor } from "../src/modules/materials";
import { TRIAL_BATCH_PREFIX, TRIAL_VENDOR_CODE } from "./load-trial-stock";
import { argValue, hasFlag, resolvePerson } from "./pharmacy-shelf-common";
import type { Person } from "./pharmacy-shelf-common";
import type { Db } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/wipe-trial-stock.ts --as <materials_head> [--apply]`
 *
 * ═══ TAKING THE TRIAL STOCK OFF THE SHELF — THE WAY THE LEDGER ALLOWS ═══
 *
 * `stock_ledger` is APPEND-ONLY (ledger.ts, property 1: there is no update or delete path anywhere, by
 * design) and `stock_balances` moves only beside a ledger row. So nothing TRIAL-STOCK wrote is deleted.
 * Instead, for every TRIAL batch (every batch a `TRIAL-STOCK` GRN posted), wherever it now sits, the
 * remaining on-hand quantity is WRITTEN OFF by one `adjust` movement through `postMovements` — the
 * ledger's only writer, under its ordered lock and its no-negative rule — tagged
 * `ref_type = "trial_stock_removed"`, `ref_id = <the TRIAL vendor>`, so every one is findable. Then the
 * vendor is SUSPENDED, so no further GRN can be captured from it (`assertVendorPurchasable`).
 *
 * What stays, on purpose: the vendor, its GRNs, the batches and every ledger row — the history of what
 * was trialled. What was SOLD during the trial stays sold: those invoices are real documents, and this
 * script neither credits nor refunds them; it counts the units that left and says so.
 *
 * ═══ WHY NOT THE COUNT → APPROVAL PATH ═══
 *
 * `requestCountAdjustment` → medical-superintendent approval → `postAdjustments` is the second-key path
 * for a write-off of the HOSPITAL's stock found short at a count. Trial stock is not the hospital's: it
 * was received from a vendor that is not a supplier, for no money, to rehearse a ticket, and the owner
 * ruled (2026-09-22) that it comes off before the real opening stock goes on. There is no count and no
 * variance for that path to book. The movement is still the ledger's own, attributed to the named
 * materials head, who must hold `materials.counts.manage` (the permission every write-off is booked
 * under) and `materials.vendors.manage` (the suspension).
 *
 * ═══ IT REFUSES RATHER THAN GUESS ═══
 *
 * A trial batch with units RESERVED (a pick in progress) or FROZEN (a recall) refuses the whole wipe:
 * finish or cancel that dispense first. Dry run by default; one transaction; a rerun finds nothing.
 */

export const TRIAL_WIPE_REF_TYPE = "trial_stock_removed";

export type WipeLine = { resourceId: string; batchId: string; batchNo: string; onHand: number; reserved: number; frozen: number };
export type WipePlan = {
  vendorId: string | null; vendorStatus: string | null; grns: number; batches: number;
  receivedUnits: number; onHandUnits: number; wipedUnits: number; leftUnits: number; lines: WipeLine[]; blocked: WipeLine[];
};

export async function planWipe(db: Db): Promise<WipePlan> {
  const vendor = (await listVendors(db, { search: TRIAL_VENDOR_CODE })).find((v) => v.code === TRIAL_VENDOR_CODE);
  const plan: WipePlan = { vendorId: vendor?.id ?? null, vendorStatus: vendor?.status ?? null, grns: 0, batches: 0, receivedUnits: 0, onHandUnits: 0, wipedUnits: 0, leftUnits: 0, lines: [], blocked: [] };
  if (vendor === undefined) return plan;
  const batchIds = new Set<string>();
  for (const g of await listGrns(db, { vendorId: vendor.id })) {
    plan.grns += 1;
    for (const l of (await getGrn(db, g.id))?.lines ?? []) {
      if (l.batchId === null) continue;
      batchIds.add(l.batchId);
      plan.receivedUnits += l.qtyAcceptedBase ?? 0;
    }
  }
  for (const batchId of [...batchIds].sort()) {
    const batch = await getBatch(db, batchId);
    /* Belt and braces: a batch this vendor's GRN posted is trial stock whatever it is called, but one
       whose number does not say TRIAL- means somebody received real stock against the trial vendor —
       that is a person's mistake to look at, not a line to write off silently. */
    if (batch === undefined || !batch.batchNo.startsWith(TRIAL_BATCH_PREFIX)) {
      throw new Error(`batch ${batch?.batchNo ?? batchId} came in on a ${TRIAL_VENDOR_CODE} GRN but is not numbered ${TRIAL_BATCH_PREFIX}… — look at it before wiping; nothing was written`);
    }
    plan.batches += 1;
    for (const b of await balances(db, { batchId })) {
      plan.onHandUnits += b.qtyOnHand;
      if (b.qtyOnHand <= 0) continue;
      const line: WipeLine = { resourceId: b.resourceId, batchId, batchNo: batch.batchNo, onHand: b.qtyOnHand, reserved: b.qtyReserved, frozen: b.qtyFrozen };
      if (b.qtyReserved > 0 || b.qtyFrozen > 0) plan.blocked.push(line); else plan.lines.push(line);
    }
  }
  const [wiped] = await db.select({ n: sql<string>`coalesce(-sum(${stockLedger.qtyDelta}), 0)` }).from(stockLedger)
    .where(and(eq(stockLedger.refType, TRIAL_WIPE_REF_TYPE), eq(stockLedger.refId, vendor.id)));
  plan.wipedUnits = Number(wiped?.n ?? 0);
  plan.leftUnits = plan.receivedUnits - plan.onHandUnits - plan.wipedUnits;
  return plan;
}

export async function applyWipe(db: Db, head: Person, plan: WipePlan, now: Date = new Date()): Promise<{ writtenOff: number; units: number; vendorSuspended: boolean }> {
  if (plan.blocked.length > 0) throw new Error(`refusing: ${String(plan.blocked.length)} trial batch location(s) hold reserved or frozen units`);
  if (plan.vendorId === null) return { writtenOff: 0, units: 0, vendorSuspended: false };
  const vendorId = plan.vendorId;
  return withTx(db, async (tx) => {
    const moved = await postMovements(tx, head, plan.lines.map((l) => ({
      resourceId: l.resourceId, batchId: l.batchId, qtyDelta: -l.onHand, reason: "adjust" as const,
      refType: TRIAL_WIPE_REF_TYPE, refId: vendorId, occurredAt: now,
    })));
    if (moved.some((m) => m.balanceAfter !== 0)) throw new Error("a trial balance did not reach zero — nothing was written");
    let vendorSuspended = false;
    if (plan.vendorStatus === "active" || plan.vendorStatus === "draft") {
      await suspendVendor(tx, head, vendorId, "trial stock removed");
      vendorSuspended = true;
    }
    return { writtenOff: moved.length, units: plan.lines.reduce((n, l) => n + l.onHand, 0), vendorSuspended };
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const url = requireEnv("DATABASE_URL");
  const { db, pool } = createDb(url);
  try {
    const head = await resolvePerson(db, argValue(argv, "--as"), "materials.counts.manage", "--as");
    await resolvePerson(db, argValue(argv, "--as"), "materials.vendors.manage", "--as");
    const plan = await planWipe(db);
    const dbName = new URL(url).pathname.replace(/^\//, "");
    if (plan.vendorId === null) { process.stdout.write(`no ${TRIAL_VENDOR_CODE} vendor in "${dbName}" — there is no trial stock to wipe.\n`); return; }
    process.stdout.write(
      `WIPE TRIAL STOCK in "${dbName}" · vendor ${TRIAL_VENDOR_CODE} (${plan.vendorStatus ?? "?"})\n` +
      `  ${String(plan.grns)} GRNs · ${String(plan.batches)} TRIAL batches · ${String(plan.receivedUnits)} units received\n` +
      `  ${String(plan.onHandUnits)} units still on a shelf → written off in ${String(plan.lines.length)} movement(s), ref_type ${TRIAL_WIPE_REF_TYPE}\n` +
      `  ${String(plan.wipedUnits)} units written off by an earlier wipe\n` +
      `  ${String(plan.leftUnits)} units already left the shelf (dispensed, sold or moved on) — those bills stand; this does not credit them\n`,
    );
    for (const b of plan.blocked) process.stdout.write(`  BLOCKED ${b.batchNo}: ${String(b.reserved)} reserved, ${String(b.frozen)} frozen — finish or cancel that dispense / recall first\n`);
    if (plan.blocked.length > 0) { process.stdout.write("\nNOTHING WAS WRITTEN.\n"); process.exitCode = 1; return; }
    if (!hasFlag(argv, "--apply")) { process.stdout.write("\nDRY RUN — nothing written. Re-run with --apply.\n"); return; }
    const done = await applyWipe(db, head, plan);
    process.stdout.write(`\nAPPLIED in one transaction as ${head.username}: ${String(done.units)} units written off in ${String(done.writtenOff)} movement(s); vendor ${done.vendorSuspended ? "SUSPENDED" : "already not active"}.\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
