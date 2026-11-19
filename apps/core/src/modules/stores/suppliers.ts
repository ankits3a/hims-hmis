import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { itemCategories, storesVendorCategoryApprovals, vendors } from "../../kernel/db/schema";
import { NON_SUPPLIER_VENDOR_CODES, getVendor, hasValidDocument, updateVendor } from "../materials";
import { STORES_BUYING_MANAGE, STORES_MASTERS, holds, recordAct } from "./access";
import { StoresError } from "./errors";
import type { WireStoresSupplier, WireSupplierKyc } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5a (#1115, decision 12) — SUPPLIER KYC, TWO LEVELS, READ FROM ROWS (one supplier list with pharmacy).
 *
 *   · Can quote: PAN, GSTIN (or a declared unregistered status with its reason), not suspended or blacklisted. Enough
 *     to be invited to an RFQ, so a new supplier can compete the same week.
 *   · KYC complete: the above, plus the GST certificate or PAN document on file, a bank account (owner-approved,
 *     materials `requestBankChange`) past its cooling-off, the supplier approved for the category by the materials
 *     head, and for an MSME the Udyam certificate with its class and activity (maker, service or trader).
 *
 * The level is never stored; `missing` names what is short, in a fixed order, for the screen's "KYC incomplete: …".
 * The checks sit HERE, in Stores' intents (S5b's award and Stores PO): pharmacy's PO path is unchanged, and a pharmacy
 * order to a "can quote" supplier is made exactly as before (D7). The new vendor fields are nullable and additive.
 */
export const KYC_MISSING_ORDER = ["pan", "gstin", "status", "document", "bank", "cooling_off", "category", "udyam", "msme_class", "msme_activity"] as const;

export async function supplierKyc(db: Db | Tx, vendorId: string, now: Date, opts: { categoryId?: string | null } = {}): Promise<WireSupplierKyc> {
  const v = await getVendor(db, vendorId);
  if (v === undefined) throw new StoresError("unknown_vendor", `supplier ${vendorId} not found`, { vendorId });
  const quote: string[] = [];
  if ((v.pan ?? "").trim() === "") quote.push("pan");
  if ((v.gstin ?? "").trim() === "" && (v.gstUnregisteredReason ?? "").trim() === "") quote.push("gstin");
  if (v.status === "suspended" || v.status === "blacklisted") quote.push("status");

  const more: string[] = [];
  const day = istDayString(now);
  if (!(await hasValidDocument(db, vendorId, "gst_certificate", day)) && !(await hasValidDocument(db, vendorId, "pan", day))) more.push("document");
  if (v.bank === null) more.push("bank");
  else if (v.firstPaymentAllowedAt === null || v.firstPaymentAllowedAt.getTime() > now.getTime()) more.push("cooling_off");
  if (!(await approvedForCategory(db, vendorId, opts.categoryId ?? null))) more.push("category");
  const msme = (v.msmeUdyamNo ?? "").trim() !== "" || (v.msmeClass ?? "").trim() !== "";
  if (msme) {
    if (!(await hasValidDocument(db, vendorId, "udyam", day))) more.push("udyam");
    if ((v.msmeClass ?? "").trim() === "") more.push("msme_class");
    if ((v.msmeActivity ?? "").trim() === "") more.push("msme_activity");
  }
  const missing = [...quote, ...more];
  return { level: quote.length > 0 ? "none" : more.length > 0 ? "can_quote" : "complete", missing };
}

/** Approved for the category, or for its top category; with no category named, for any. */
async function approvedForCategory(db: Db | Tx, vendorId: string, categoryId: string | null): Promise<boolean> {
  const rows = await (db as Db).select({ c: storesVendorCategoryApprovals.categoryId }).from(storesVendorCategoryApprovals)
    .where(eq(storesVendorCategoryApprovals.vendorId, vendorId));
  if (categoryId === null) return rows.length > 0;
  const approved = new Set(rows.map((r) => r.c));
  if (approved.has(categoryId)) return true;
  const [c] = await (db as Db).select({ parentId: itemCategories.parentId }).from(itemCategories).where(eq(itemCategories.id, categoryId));
  return c?.parentId != null && approved.has(c.parentId);
}

/** The Stores fields of a supplier (MSME activity, e-invoice declaration, the unregistered declaration, Udyam): the buyer's. */
export async function setSupplierFields(
  db: Db, actor: Actor, vendorId: string,
  patch: { msmeActivity?: "maker" | "service" | "trader" | null; einvoiceApplicable?: boolean | null; gstUnregisteredReason?: string | null; msmeUdyamNo?: string | null; msmeClass?: string | null },
  now: Date = new Date(),
): Promise<WireSupplierKyc> {
  if (!(await holds(db, actor, STORES_BUYING_MANAGE))) throw new StoresError("not_permitted", "supplier fields are the buyer's", { permission: STORES_BUYING_MANAGE });
  if (patch.msmeActivity != null && !["maker", "service", "trader"].includes(patch.msmeActivity)) throw new StoresError("bad_quantity", "activity is maker, service or trader");
  if ((await getVendor(db, vendorId)) === undefined) throw new StoresError("unknown_vendor", `supplier ${vendorId} not found`, { vendorId });
  const next: Parameters<typeof updateVendor>[3] = {};
  if (patch.msmeActivity !== undefined) next.msmeActivity = patch.msmeActivity;
  if (patch.einvoiceApplicable !== undefined) next.einvoiceApplicable = patch.einvoiceApplicable;
  if (patch.gstUnregisteredReason !== undefined) next.gstUnregisteredReason = patch.gstUnregisteredReason?.trim() || null;
  if (patch.msmeUdyamNo !== undefined) next.msmeUdyamNo = patch.msmeUdyamNo?.trim() || null;
  if (patch.msmeClass !== undefined) next.msmeClass = patch.msmeClass;
  await withTx(db, async (tx) => {
    await updateVendor(tx, actor, vendorId, next);
    await recordAct(tx, actor, now, { act: "supplier_fields", refId: vendorId, after: next });
  });
  return supplierKyc(db, vendorId, now);
}

/** The materials head approves a supplier for a category (once; a second approval is a no-op). */
export async function approveSupplierCategory(db: Db, actor: Actor, vendorId: string, categoryId: string, now: Date = new Date()): Promise<void> {
  if (!(await holds(db, actor, STORES_MASTERS))) throw new StoresError("not_permitted", "category approval is the materials head's", { permission: STORES_MASTERS });
  if ((await getVendor(db, vendorId)) === undefined) throw new StoresError("unknown_vendor", `supplier ${vendorId} not found`, { vendorId });
  const [c] = await db.select({ id: itemCategories.id }).from(itemCategories).where(eq(itemCategories.id, categoryId));
  if (c === undefined) throw new StoresError("unknown_category", `category ${categoryId} not found`, { categoryId });
  await withTx(db, async (tx) => {
    const inserted = await tx.insert(storesVendorCategoryApprovals).values({ id: newId(), vendorId, categoryId, approvedBy: actor.id, at: now })
      .onConflictDoNothing().returning({ id: storesVendorCategoryApprovals.id });
    if (inserted.length > 0) await recordAct(tx, actor, now, { act: "approve_supplier_category", refId: vendorId, after: { categoryId } });
  });
}

/** The supplier list with each one's KYC level, for the buyer and the materials head. */
export async function storesSuppliers(db: Db, actor: Actor, now: Date = new Date()): Promise<WireStoresSupplier[]> {
  if (!(await holds(db, actor, STORES_BUYING_MANAGE)) && !(await holds(db, actor, STORES_MASTERS))) {
    throw new StoresError("not_permitted", "the supplier list is the buyer's", { permission: STORES_BUYING_MANAGE });
  }
  const rows = await db.select({ id: vendors.id, code: vendors.code, legal: vendors.legalName, trade: vendors.tradeName, status: vendors.status,
    msmeClass: vendors.msmeClass, msmeActivity: vendors.msmeActivity, einvoice: vendors.einvoiceApplicable })
    .from(vendors).where(and(notInArray(sql`upper(${vendors.code})`, [...NON_SUPPLIER_VENDOR_CODES]), inArray(vendors.status, ["draft", "active", "suspended"])))
    .orderBy(asc(vendors.legalName)).limit(200);
  const cats = rows.length === 0 ? [] : await db.select({ vendorId: storesVendorCategoryApprovals.vendorId, id: itemCategories.id, name: itemCategories.name })
    .from(storesVendorCategoryApprovals).innerJoin(itemCategories, eq(itemCategories.id, storesVendorCategoryApprovals.categoryId))
    .where(inArray(storesVendorCategoryApprovals.vendorId, rows.map((r) => r.id)));
  const out: WireStoresSupplier[] = [];
  for (const r of rows) {
    out.push({
      id: r.id, code: r.code, name: r.trade ?? r.legal, status: r.status, kyc: await supplierKyc(db, r.id, now), msmeClass: r.msmeClass,
      msmeActivity: r.msmeActivity, einvoiceApplicable: r.einvoice, categories: cats.filter((c) => c.vendorId === r.id).map((c) => ({ id: c.id, name: c.name })),
    });
  }
  return out;
}
