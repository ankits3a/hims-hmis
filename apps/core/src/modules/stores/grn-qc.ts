import { asc, desc, eq, inArray } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { grnLines, grns, items, vendors } from "../../kernel/db/schema";
import { assertNotPoApprover, postGrn, purchaseOrderOfGrn, runGateQc } from "../materials";
import { STORES_GRN_QC, holds, recordAct } from "./access";
import { StoresError } from "./errors";
import type { WireStoresGrnForQc } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S5a (#1115, decision 14) — NON-DRUG GRN QC WITHOUT A PHARMACIST.
 *
 * `materials.grn.qc` is held by the materials head and pharmacy only, so a pharmacist signed QC on a delivery of chairs.
 * `stores.grn.qc` (the materials head and biomedical at hospital scope) signs QC — and posts — a GRN whose every line is a
 * Stores item (`track_mode` set, not a drug), through materials' own `runGateQc` / `postGrn` in the caller's
 * transaction: DD8's nine rules, the 2 % price check at capture and the PO approver / receiver pair all run unchanged.
 * A GRN carrying any pharmacy line is refused (`not_stores_line`): drug QC stays `materials.grn.qc`'s, and its routes
 * are untouched. DECIDED: the department nominee (`department_head` at department scope) signs when S5b ties a GRN to
 * its purchase request; until then the grant is asked at hospital scope.
 */

async function requireStoresGrn(db: Db, actor: Actor, grnId: string): Promise<void> {
  if (!(await holds(db, actor, STORES_GRN_QC))) throw new StoresError("not_permitted", "non-drug QC is the materials head's and biomedical's", { permission: STORES_GRN_QC });
  const lines = await db.select({ itemId: grnLines.itemId, trackMode: items.trackMode, klass: items.class }).from(grnLines)
    .innerJoin(items, eq(items.id, grnLines.itemId)).where(eq(grnLines.grnId, grnId));
  if (lines.length === 0) throw new StoresError("unknown_grn", `GRN ${grnId} not found`, { grnId });
  const foreign = lines.find((l) => l.trackMode === null || l.klass === "drug");
  if (foreign !== undefined) throw new StoresError("not_stores_line", "a pharmacy line's QC is the pharmacist's", { itemId: foreign.itemId });
}

export async function signStoresQc(db: Db, actor: Actor, grnId: string, now: Date = new Date()): Promise<{ status: string; verdicts: { grnLineId: string; verdict: string; rule?: string }[] }> {
  await requireStoresGrn(db, actor, grnId);
  return withTx(db, async (tx) => {
    const r = await runGateQc(tx, actor, grnId);
    await recordAct(tx, actor, now, {
      act: "grn_qc", refId: grnId, after: r.status, lines: r.verdicts.map((v) => ({ grnLineId: v.grnLineId, verdict: v.verdict, rule: v.rule ?? null })),
    });
    return r;
  });
}

export async function postStoresGrn(db: Db, actor: Actor, grnId: string, now: Date = new Date()): Promise<{ status: string; ledgerEntryIds: string[] }> {
  await requireStoresGrn(db, actor, grnId);
  const poId = await purchaseOrderOfGrn(db, grnId);
  if (poId !== null) await assertNotPoApprover(db, actor, poId);
  return withTx(db, async (tx) => {
    const r = await postGrn(tx, actor, grnId, now);
    await recordAct(tx, actor, now, { act: "grn_post", refId: grnId, after: r.status });
    return r;
  });
}

/** Deliveries of Stores items waiting for QC or for the post, oldest first. */
export async function storesGrnsForQc(db: Db, actor: Actor): Promise<WireStoresGrnForQc[]> {
  if (!(await holds(db, actor, STORES_GRN_QC))) throw new StoresError("not_permitted", "non-drug QC is the materials head's and biomedical's", { permission: STORES_GRN_QC });
  const heads = await db.select({ g: grns, vendor: vendors.legalName, trade: vendors.tradeName }).from(grns).innerJoin(vendors, eq(vendors.id, grns.vendorId))
    .where(inArray(grns.status, ["gate_qc", "accepted", "partially_accepted"])).orderBy(asc(grns.createdAt)).limit(200);
  if (heads.length === 0) return [];
  const lines = await db.select({ l: grnLines, name: items.name, baseUom: items.baseUom, trackMode: items.trackMode, klass: items.class })
    .from(grnLines).innerJoin(items, eq(items.id, grnLines.itemId)).where(inArray(grnLines.grnId, heads.map((h) => h.g.id)))
    .orderBy(desc(grnLines.id));
  return heads.flatMap(({ g, vendor, trade }) => {
    const mine = lines.filter((x) => x.l.grnId === g.id);
    if (mine.length === 0 || mine.some((x) => x.trackMode === null || x.klass === "drug")) return [];
    return [{
      id: g.id, grnNo: g.grnNo, status: g.status, vendorName: trade ?? vendor, challanNo: g.challanNo, capturedAt: g.createdAt.toISOString(),
      lines: mine.map((x) => ({
        itemId: x.l.itemId, itemName: x.name, qtyBase: x.l.qtyBase, baseUom: x.baseUom, unitCostPaise: x.l.unitCostPaise, priceFlag: x.l.priceReasonCode !== null,
      })),
    }];
  });
}
