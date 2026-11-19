import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { newId, storesTaxTableBody } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  grnLines, itemCategories, items, resources, stockBatches, stockLedger, storesTaxTableSigns, storesTaxTables, storesTdsCertificates, supplierBillLines,
  supplierBills, vendors,
} from "../../kernel/db/schema";
import { financialYearOf, registerBillTaxHooks, writeBillLineTds } from "../materials";
import { STORES_TAX_MANAGE, holds, recordAct } from "./access";
import { clean, ex, peopleNamed } from "./buying-common";
import { StoresError } from "./errors";
import { requirePayingReader } from "./holds";
import { msmeDueDate } from "./msme";
import { payingSettings } from "./paying-settings";
import type { Exec } from "./buying-common";
import type {
  Actor, WireBillTaxProposal, WireGstCredit, WireGstCreditRule, WireTaxTable, WireTaxTables, WireTdsDryRun, WireTdsNature, WireTdsRule,
} from "@hmis/contracts";
import type { BillBookingTax } from "../materials";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S6b (#1116, decisions 4–5; ruling 0101 Q2) — TAX ON THE BILL, as RULES A CA SIGNS. HMIS states the rules the
 * hospital's chartered accountant has signed and applies them; it gives no tax advice, and with no signed table it
 * proposes nothing.
 *
 * GST credit (decision 4): every Stores or service line carries one mark — `eligible`, `not_available` (the default:
 * ruling 0101 Q2, a hospital's healthcare is exempt) or `shared` — and reverse charge yes/no. They are proposed from the
 * newest SIGNED `gst_credit` table (category, own or top, and supplier type: registered or not), else the default, and
 * the accounts officer confirms them when the bill is entered (materials `BillLineInput.gstCredit`). A Stores line left
 * unmarked takes the proposal when the bill is booked. A pharmacy line is never marked (materials refuses one).
 *
 * TDS (decision 5): only from the newest SIGNED `tds` table. A line's nature is the row whose categories include the
 * line's category (own or top), else "goods". A row applies when its own switch is on — and, for "goods", when the owner
 * has also switched "TDS on goods" on after `tdsDryRun` (decision 13), because that row reaches pharmacy's suppliers.
 * The threshold is the row's: this bill's value of that nature, the supplier's in the calendar month, or in the
 * financial year (booked bills, this one included) above the amount. Rate: a valid lower-deduction certificate's, else
 * the PAN-missing rate, else by payee type (the PAN's fourth letter P or H = individual or HUF). The base is the line's
 * value before GST. The TDS is proposed on the entered bill, changed only with a reason (`setBillTds`), and written
 * when the bill is booked (materials `book`): the payable is the total less TDS. With no signed table, or for a bill
 * with no Stores line that no switched-on row reaches, nothing is written and the bill books exactly as before.
 */
const DEFAULT_CREDIT: WireGstCredit = "not_available";
const PAYABLE_OR_PAID = ["accepted", "part_paid", "paid"];
const ENTERED = ["draft", "matched", "held_for_match"];

type TableRow = typeof storesTaxTables.$inferSelect;
type Signed = { id: string; version: number; rules: unknown[] };

/* ─────────────────────────────── the tables ─────────────────────────────── */

async function requireTaxManage(db: Exec, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_TAX_MANAGE))) throw new StoresError("not_permitted", "the tax tables are kept by the accounts officer", { permission: STORES_TAX_MANAGE });
}

/** The newest SIGNED version of a kind, or null (the shipped state: nothing computes). */
export async function signedTaxTable(db: Exec, kind: "tds" | "gst_credit"): Promise<Signed | null> {
  const [row] = await ex(db).select({ t: storesTaxTables }).from(storesTaxTables)
    .innerJoin(storesTaxTableSigns, eq(storesTaxTableSigns.tableId, storesTaxTables.id))
    .where(eq(storesTaxTables.kind, kind)).orderBy(desc(storesTaxTables.version)).limit(1);
  return row === undefined ? null : { id: row.t.id, version: row.t.version, rules: row.t.rules as unknown[] };
}

async function tableViews(db: Exec, rows: readonly TableRow[]): Promise<WireTaxTable[]> {
  if (rows.length === 0) return [];
  const signs = await ex(db).select().from(storesTaxTableSigns).where(inArray(storesTaxTableSigns.tableId, rows.map((r) => r.id)));
  const person = await peopleNamed(db, [...rows.map((r) => r.createdBy), ...signs.map((s) => s.signedBy)]);
  return rows.map((r) => {
    const s = signs.find((x) => x.tableId === r.id);
    return {
      id: r.id, kind: r.kind as WireTaxTable["kind"], version: r.version, rules: r.rules as WireTaxTable["rules"], documentRef: r.documentRef,
      createdBy: person(r.createdBy), createdAt: r.createdAt.toISOString(),
      signed: s === undefined ? null : { by: person(s.signedBy), at: s.signedAt.toISOString(), documentRef: s.documentRef },
    };
  });
}

/** The tables in force and the drafts waiting for the CA's signature. */
export async function taxTables(db: Db, actor: Actor): Promise<WireTaxTables> {
  await requirePayingReader(db, actor);
  const rows = await db.select().from(storesTaxTables).orderBy(desc(storesTaxTables.version)).limit(40);
  const views = await tableViews(db, rows);
  const inForce = (k: string): WireTaxTable | null => views.find((v) => v.kind === k && v.signed !== null) ?? null;
  return { tds: inForce("tds"), gstCredit: inForce("gst_credit"), drafts: views.filter((v) => v.signed === null), canManage: await holds(db, actor, STORES_TAX_MANAGE) };
}

/** A new version of a table, as the CA filled it (it counts only once signed). One row per nature in a TDS table. */
export async function saveTaxTable(
  db: Db, actor: Actor, input: { kind: "tds"; rules: WireTdsRule[]; documentRef: string } | { kind: "gst_credit"; rules: WireGstCreditRule[]; documentRef: string },
  now: Date = new Date(),
): Promise<WireTaxTable> {
  await requireTaxManage(db, actor);
  const parsed = storesTaxTableBody.safeParse(input);
  if (!parsed.success) throw new StoresError("bad_tax_table", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300));
  const t = parsed.data;
  if (t.kind === "tds" && new Set(t.rules.map((r) => r.nature)).size !== t.rules.length) throw new StoresError("bad_tax_table", "one row per nature of payment");
  const id = await withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-tax-table:${t.kind}`}))`);
    const [last] = await tx.select({ v: storesTaxTables.version }).from(storesTaxTables).where(eq(storesTaxTables.kind, t.kind)).orderBy(desc(storesTaxTables.version)).limit(1);
    const row = { id: newId(), kind: t.kind, version: (last?.v ?? 0) + 1, rules: t.rules, documentRef: t.documentRef, createdBy: actor.id, createdAt: now };
    await tx.insert(storesTaxTables).values(row);
    await recordAct(tx, actor, now, { act: "tax_table_save", refId: row.id, after: { kind: row.kind, version: row.version, rows: t.rules.length, documentRef: row.documentRef } });
    return row.id;
  });
  return (await tableViews(db, await db.select().from(storesTaxTables).where(eq(storesTaxTables.id, id))))[0]!;
}

/** The CA's signature, recorded by the accounts officer with the signed document: from now on this version is in force. */
export async function signTaxTable(db: Db, actor: Actor, tableId: string, input: { documentRef: string }, now: Date = new Date()): Promise<WireTaxTable> {
  await requireTaxManage(db, actor);
  const doc = clean(input.documentRef);
  if (doc === null) throw new StoresError("reason_required", "attach the CA's signed document");
  await withTx(db, async (tx) => {
    const [t] = await tx.select().from(storesTaxTables).where(eq(storesTaxTables.id, tableId));
    if (t === undefined) throw new StoresError("unknown_tax_table", `tax table ${tableId} not found`);
    const [s] = await tx.select({ id: storesTaxTableSigns.id }).from(storesTaxTableSigns).where(eq(storesTaxTableSigns.tableId, tableId));
    if (s !== undefined) throw new StoresError("tax_table_signed", `version ${String(t.version)} is already signed`);
    const before = await signedTaxTable(tx, t.kind as "tds" | "gst_credit");
    await tx.insert(storesTaxTableSigns).values({ id: newId(), tableId, documentRef: doc.slice(0, 300), signedBy: actor.id, signedAt: now });
    await recordAct(tx, actor, now, {
      act: "tax_table_sign", refId: tableId, reason: doc.slice(0, 300),
      before: before === null ? null : { version: before.version }, after: { kind: t.kind, version: t.version },
    });
  });
  return (await tableViews(db, await db.select().from(storesTaxTables).where(eq(storesTaxTables.id, tableId))))[0]!;
}

/** A supplier's lower or nil deduction certificate (rate and validity), with its document. */
export async function addTdsCertificate(
  db: Db, actor: Actor, input: { vendorId: string; number: string; rateBps: number; validFrom: string; validTo: string; documentRef: string }, now: Date = new Date(),
): Promise<{ id: string }> {
  await requireTaxManage(db, actor);
  const no = clean(input.number);
  const doc = clean(input.documentRef);
  if (no === null || doc === null || !Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 10_000 || input.validFrom > input.validTo) {
    throw new StoresError("bad_tax_table", "a certificate needs its number, a rate of 0–100 %, its dates in order and the document");
  }
  const [v] = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, input.vendorId));
  if (v === undefined) throw new StoresError("unknown_vendor", `supplier ${input.vendorId} not found`);
  const id = newId();
  await withTx(db, async (tx) => {
    await tx.insert(storesTdsCertificates).values({
      id, vendorId: input.vendorId, number: no.slice(0, 64), rateBps: input.rateBps, validFrom: input.validFrom, validTo: input.validTo,
      documentRef: doc.slice(0, 300), createdBy: actor.id, createdAt: now,
    });
    await recordAct(tx, actor, now, { act: "tds_certificate", refId: id, after: { vendorId: input.vendorId, rateBps: input.rateBps, validFrom: input.validFrom, validTo: input.validTo } });
  });
  return { id };
}

/* ─────────────────────────────── a bill's lines, as the rules read them ─────────────────────────────── */

export type TaxLine = {
  lineId: string; billId: string; itemId: string; itemName: string; storesLine: boolean; catCode: string | null; topCode: string | null;
  grnId: string | null; sesId: string | null; taxablePaise: number; gstRateBps: number; billGstPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
  gstCredit: WireGstCredit | null; reverseCharge: boolean; tdsPaise: number | null; tdsNature: string | null; tdsReason: string | null;
};

/** Every line of these bills with its category (own and top) and whether it is a Stores or service line. */
export async function taxLinesOf(db: Exec, billIds: readonly string[]): Promise<TaxLine[]> {
  if (billIds.length === 0) return [];
  const rows = await ex(db).select({ l: supplierBillLines, name: items.name, klass: items.class, trackMode: items.trackMode, catCode: itemCategories.code, catParent: itemCategories.parentId })
    .from(supplierBillLines).innerJoin(items, eq(items.id, supplierBillLines.itemId)).leftJoin(itemCategories, eq(itemCategories.id, items.categoryId))
    .where(inArray(supplierBillLines.billId, [...billIds])).orderBy(asc(supplierBillLines.billId), asc(items.name), asc(supplierBillLines.id));
  const parents = [...new Set(rows.map((r) => r.catParent).filter((x): x is string => x !== null))];
  const tops = new Map(parents.length === 0 ? [] : (await ex(db).select({ id: itemCategories.id, code: itemCategories.code }).from(itemCategories).where(inArray(itemCategories.id, parents))).map((c) => [c.id, c.code] as const));
  return rows.map(({ l, name, klass, trackMode, catCode, catParent }) => ({
    lineId: l.id, billId: l.billId, itemId: l.itemId, itemName: name, storesLine: l.sesId !== null || (trackMode !== null && klass !== "drug"),
    catCode, topCode: catParent === null ? catCode : tops.get(catParent) ?? catCode, grnId: l.grnId, sesId: l.sesId,
    taxablePaise: l.taxablePaise, gstRateBps: l.gstRateBps, billGstPaise: l.cgstPaise + l.sgstPaise + l.igstPaise, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, igstPaise: l.igstPaise,
    gstCredit: l.gstCredit as WireGstCredit | null, reverseCharge: l.reverseCharge === true, tdsPaise: l.tdsPaise, tdsNature: l.tdsNature, tdsReason: l.tdsReason,
  }));
}

/* ─────────────────────────────── GST credit ─────────────────────────────── */

/** The mark proposed for a Stores line: the signed table's row for its category (own before top; a named supplier type before "any"), else not available. */
export function proposeCredit(rules: readonly WireGstCreditRule[] | null, line: Pick<TaxLine, "catCode" | "topCode">, registered: boolean): { credit: WireGstCredit; reverseCharge: boolean } {
  const type = registered ? "registered" : "unregistered";
  const rank = (r: WireGstCreditRule): number => (r.categoryCode === line.catCode ? 0 : 2) + (r.supplier === type ? 0 : 1);
  const hit = (rules ?? []).filter((r) => (r.categoryCode === line.catCode || r.categoryCode === line.topCode) && (r.supplier === "any" || r.supplier === type))
    .sort((a, b) => rank(a) - rank(b))[0];
  return hit === undefined ? { credit: DEFAULT_CREDIT, reverseCharge: false } : { credit: hit.credit, reverseCharge: hit.reverseCharge };
}

/* ─────────────────────────────── TDS ─────────────────────────────── */

type TdsLine = { lineId: string; nature: WireTdsNature; section: string; rateBps: number; basePaise: number; paise: number; why: NonNullable<WireBillTaxProposal["lines"][number]["tds"]>["why"]; ref: string };
type TdsResult = { checked: boolean; tdsPaise: number | null; lines: Map<string, TdsLine> };

export const natureOf = (rules: readonly WireTdsRule[], line: Pick<TaxLine, "storesLine" | "catCode" | "topCode">): WireTdsNature => {
  if (!line.storesLine) return "goods";
  const hit = rules.find((r) => r.nature !== "goods" && r.categoryCodes.some((c) => c === line.catCode || c === line.topCode));
  return hit?.nature ?? "goods";
};

/** The payee type from the PAN's fourth letter: P (individual) or H (HUF) = "individual", any other = "other". */
const payeeOf = (pan: string | null): "individual" | "other" | null => {
  const p = (pan ?? "").trim().toUpperCase();
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(p)) return null;
  return p[3] === "P" || p[3] === "H" ? "individual" : "other";
};

const monthWindow = (day: string): [string, string] => {
  const [y, m] = day.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${day.slice(0, 7)}-01`, `${day.slice(0, 7)}-${String(last).padStart(2, "0")}`];
};
const fyWindow = (day: string): [string, string] => {
  const start = Number(financialYearOf(day).slice(0, 4));
  return [`${String(start)}-04-01`, `${String(start + 1)}-03-31`];
};

/** The supplier's value of `nature` on booked bills (this one left out) with a bill date in [from, to]. */
async function priorBase(db: Exec, rules: readonly WireTdsRule[], vendorId: string, exceptBillId: string, nature: WireTdsNature, from: string, to: string): Promise<number> {
  const bills = await ex(db).select({ id: supplierBills.id }).from(supplierBills)
    .where(and(eq(supplierBills.vendorId, vendorId), ne(supplierBills.id, exceptBillId), inArray(supplierBills.status, PAYABLE_OR_PAID), gte(supplierBills.billDate, from), lte(supplierBills.billDate, to)));
  const lines = await taxLinesOf(db, bills.map((b) => b.id));
  return lines.filter((l) => natureOf(rules, l) === nature).reduce((s, l) => s + l.taxablePaise, 0);
}

/**
 * The TDS the signed table gives a bill (writes nothing). `goodsOn` says whether the owner has switched the goods row
 * on (the dry run asks "as if on"). A line a person changed (`tds_reason`) keeps its figure.
 */
export async function tdsFor(db: Exec, billId: string, opts: { goodsOn: boolean }): Promise<TdsResult> {
  const none: TdsResult = { checked: false, tdsPaise: null, lines: new Map() };
  const table = await signedTaxTable(db, "tds");
  if (table === null) return none;
  const rules = table.rules as WireTdsRule[];
  const [b] = await ex(db).select({ b: supplierBills, v: vendors }).from(supplierBills).innerJoin(vendors, eq(vendors.id, supplierBills.vendorId)).where(eq(supplierBills.id, billId));
  if (b === undefined) return none;
  const lines = await taxLinesOf(db, [billId]);
  const active = (r: WireTdsRule | undefined): r is WireTdsRule => r !== undefined && r.on && (r.nature !== "goods" || opts.goodsOn);
  const storesBill = lines.some((l) => l.storesLine);
  const reached = lines.some((l) => active(rules.find((r) => r.nature === natureOf(rules, l))));
  if (!storesBill && !reached) return none;
  const [cert] = await ex(db).select().from(storesTdsCertificates)
    .where(and(eq(storesTdsCertificates.vendorId, b.b.vendorId), lte(storesTdsCertificates.validFrom, b.b.billDate), gte(storesTdsCertificates.validTo, b.b.billDate)))
    .orderBy(desc(storesTdsCertificates.createdAt)).limit(1);
  const payee = payeeOf(b.v.pan);
  const out = new Map<string, TdsLine>();
  const natures = [...new Set(lines.map((l) => natureOf(rules, l)))];
  for (const nature of natures) {
    const mine = lines.filter((l) => natureOf(rules, l) === nature);
    const rule = rules.find((r) => r.nature === nature);
    const base = mine.reduce((s, l) => s + l.taxablePaise, 0);
    let over = false;
    if (active(rule)) {
      if (rule.threshold.kind === "bill") over = base > rule.threshold.paise;
      else {
        const [from, to] = rule.threshold.kind === "month" ? monthWindow(b.b.billDate) : fyWindow(b.b.billDate);
        over = (await priorBase(db, rules, b.b.vendorId, billId, nature, from, to)) + base > rule.threshold.paise;
      }
    }
    const rate = !active(rule) ? 0 : cert !== undefined ? cert.rateBps : payee === null ? rule.panMissingRateBps : rule.rateBps[payee];
    const why: TdsLine["why"] = !active(rule) ? "row_off" : !over ? "under_threshold" : cert !== undefined ? "certificate" : payee === null ? "pan_missing" : "rate";
    for (const l of mine) {
      const computed = active(rule) && over ? Math.round((l.taxablePaise * rate) / 10_000) : 0;
      out.set(l.lineId, {
        lineId: l.lineId, nature, section: rule?.section ?? "", rateBps: rate, basePaise: l.taxablePaise,
        paise: l.tdsReason !== null && l.tdsPaise !== null ? l.tdsPaise : computed, why, ref: `${table.id}:v${String(table.version)}:${nature}`,
      });
    }
  }
  return { checked: true, tdsPaise: [...out.values()].reduce((s, l) => s + l.paise, 0), lines: out };
}

/* ─────────────────────────────── reads and acts ─────────────────────────────── */

async function billOrRefuse(db: Exec, billId: string): Promise<{ b: typeof supplierBills.$inferSelect; v: typeof vendors.$inferSelect }> {
  const [row] = await ex(db).select({ b: supplierBills, v: vendors }).from(supplierBills).innerJoin(vendors, eq(vendors.id, supplierBills.vendorId)).where(eq(supplierBills.id, billId));
  if (row === undefined) throw new StoresError("unknown_bill", `bill ${billId} not found`);
  return row;
}

/** What HMIS proposes for a bill's lines: the marks (as entered, else the table's or the default) and the TDS. */
export async function billTaxProposal(db: Db, actor: Actor, billId: string, now: Date = new Date()): Promise<WireBillTaxProposal> {
  void now;
  await requirePayingReader(db, actor);
  const { b, v } = await billOrRefuse(db, billId);
  const lines = await taxLinesOf(db, [billId]);
  const credit = await signedTaxTable(db, "gst_credit");
  const booked = !ENTERED.includes(b.status);
  const tds = booked ? null : await tdsFor(db, billId, { goodsOn: (await payingSettings(db)).tdsGoods === true });
  const wire = lines.map((l) => {
    const p = l.storesLine ? proposeCredit(credit?.rules as WireGstCreditRule[] | null, l, v.gstin !== null) : null;
    const t = booked
      ? (l.tdsPaise === null ? null : { nature: (l.tdsNature ?? "goods") as WireTdsNature, section: "", rateBps: 0, basePaise: l.taxablePaise, paise: l.tdsPaise, why: "rate" as const })
      : (() => { const x = tds!.lines.get(l.lineId); return x === undefined ? null : { nature: x.nature, section: x.section, rateBps: x.rateBps, basePaise: x.basePaise, paise: x.paise, why: x.why }; })();
    return {
      lineId: l.lineId, itemId: l.itemId, itemName: l.itemName, storesLine: l.storesLine, taxablePaise: l.taxablePaise,
      gstCredit: l.storesLine ? (l.gstCredit ?? p!.credit) : null, reverseCharge: l.reverseCharge, tds: t,
    };
  });
  const tdsChecked = booked ? b.tdsPaise !== null : tds!.checked;
  return {
    billId, billNo: b.billNo, tdsChecked, tdsPaise: booked ? b.tdsPaise : tds!.tdsPaise, irn: b.irn,
    irnNeeded: v.einvoiceApplicable === true && b.irn === null && wire.some((l) => l.gstCredit === "eligible" || l.gstCredit === "shared"),
    lines: wire,
  };
}

/** The accounts officer changes a proposed TDS, with a reason; booking keeps it. */
export async function setBillTds(db: Db, actor: Actor, billId: string, input: { lines: { lineId: string; tdsPaise: number }[]; reason: string }, now: Date = new Date()): Promise<WireBillTaxProposal> {
  if (!(await holds(db, actor, "materials.bills.manage"))) throw new StoresError("not_permitted", "the TDS is changed by whoever books the bill", { permission: "materials.bills.manage" });
  const why = clean(input.reason);
  if (why === null) throw new StoresError("reason_required", "say why the TDS differs from the table's");
  const before = await tdsFor(db, billId, { goodsOn: (await payingSettings(db)).tdsGoods === true });
  if (!before.checked) throw new StoresError("state_changed", "TDS not checked: no signed table reaches this bill");
  const { b } = await billOrRefuse(db, billId);
  if (!ENTERED.includes(b.status)) throw new StoresError("bill_booked", `bill ${b.billNo} is booked; its TDS stands`);
  await withTx(db, async (tx) => {
    await writeBillLineTds(tx, billId, input.lines, why);
    await recordAct(tx, actor, now, {
      act: "tds_change", refId: billId, reason: why.slice(0, 300),
      before: input.lines.map((l) => ({ lineId: l.lineId, tdsPaise: before.lines.get(l.lineId)?.paise ?? null })),
      after: input.lines.map((l) => ({ lineId: l.lineId, tdsPaise: l.tdsPaise })),
    });
  });
  return billTaxProposal(db, actor, billId, now);
}

/**
 * The goods row's dry run (writes nothing): every entered bill the purchase-of-goods row would deduct from were the
 * owner to switch it on — pharmacy's included (one book) — with the TDS it would take.
 */
export async function tdsDryRun(db: Db, actor: Actor, now: Date = new Date()): Promise<WireTdsDryRun> {
  await requirePayingReader(db, actor);
  const entered = await db.select({ id: supplierBills.id, billNo: supplierBills.billNo, legal: vendors.legalName, trade: vendors.tradeName }).from(supplierBills)
    .innerJoin(vendors, eq(vendors.id, supplierBills.vendorId)).where(inArray(supplierBills.status, ENTERED)).orderBy(asc(supplierBills.billNo)).limit(500);
  const out: WireTdsDryRun["bills"] = [];
  for (const e of entered) {
    const r = await tdsFor(db, e.id, { goodsOn: true });
    const goods = [...r.lines.values()].filter((l) => l.nature === "goods" && l.paise > 0);
    if (goods.length === 0) continue;
    out.push({ billId: e.id, billNo: e.billNo, vendorName: e.trade ?? e.legal, basePaise: goods.reduce((s, l) => s + l.basePaise, 0), tdsPaise: goods.reduce((s, l) => s + l.paise, 0) });
  }
  return { at: now.toISOString(), bills: out };
}

/* ─────────────────────────────── "GST not credited", a derived figure ─────────────────────────────── */

const IST = "Asia/Kolkata";

/**
 * Decision 4: a department's "GST not credited / बिना क्रेडिट GST" on an IST day — the charge (`departmentChargeOn`'s rows)
 * × the GST rate of the line it was bought on, where that line's mark is `not_available` (before the bill is booked,
 * the category's default). Derived on read; nothing is written to the ledger and the charge itself is unchanged.
 */
export async function gstNotCreditedOn(db: Db, departmentCode: string, day: string): Promise<{ paise: number; rows: number }> {
  const rows = await db.select({
    sign: sql<number>`case when ${resources.attributes}->>'kind' = 'shelf' then 1 else -1 end`, qty: stockLedger.qtyDelta, cost: stockBatches.landedCostPaise,
    grnId: grnLines.grnId, itemId: stockBatches.itemId, itemGst: items.gstRateBps, catCode: itemCategories.code, catParent: itemCategories.parentId,
  }).from(stockLedger).innerJoin(stockBatches, eq(stockBatches.id, stockLedger.batchId)).innerJoin(resources, eq(resources.id, stockLedger.resourceId))
    .innerJoin(items, eq(items.id, stockBatches.itemId)).leftJoin(itemCategories, eq(itemCategories.id, items.categoryId))
    .leftJoin(grnLines, eq(grnLines.id, stockBatches.grnLineId))
    .where(and(
      eq(stockLedger.costCenter, departmentCode), eq(stockLedger.reason, "receive"), sql`${stockLedger.qtyDelta} > 0`,
      sql`(${stockLedger.occurredAt} at time zone ${IST})::date = ${day}::date`,
      sql`not exists (select 1 from stores_asset_units u where u.batch_id = ${stockLedger.batchId})`,
    ));
  if (rows.length === 0) return { paise: 0, rows: 0 };
  const grnIds = [...new Set(rows.map((r) => r.grnId).filter((x): x is string => x !== null))];
  const billed = grnIds.length === 0 ? [] : await db.select({ grnId: supplierBillLines.grnId, itemId: supplierBillLines.itemId, credit: supplierBillLines.gstCredit, rate: supplierBillLines.gstRateBps })
    .from(supplierBillLines).innerJoin(supplierBills, eq(supplierBills.id, supplierBillLines.billId))
    .where(and(inArray(supplierBillLines.grnId, grnIds), inArray(supplierBills.status, PAYABLE_OR_PAID)));
  const parents = [...new Set(rows.map((r) => r.catParent).filter((x): x is string => x !== null))];
  const tops = new Map(parents.length === 0 ? [] : (await db.select({ id: itemCategories.id, code: itemCategories.code }).from(itemCategories).where(inArray(itemCategories.id, parents))).map((c) => [c.id, c.code] as const));
  const table = await signedTaxTable(db, "gst_credit");
  let paise = 0;
  for (const r of rows) {
    const bill = billed.find((x) => x.grnId === r.grnId && x.itemId === r.itemId);
    const credit = bill?.credit ?? proposeCredit(table?.rules as WireGstCreditRule[] | null, { catCode: r.catCode, topCode: r.catParent === null ? r.catCode : tops.get(r.catParent) ?? r.catCode }, true).credit;
    if (credit !== "not_available") continue;
    paise += Math.round((r.sign * r.qty * r.cost * (bill?.rate ?? r.itemGst ?? 0)) / 10_000);
  }
  return { paise, rows: rows.length };
}

/* ─────────────────────────────── the booking hook ─────────────────────────────── */

/** Booking (materials `book`, in its transaction): fill a Stores line's unconfirmed mark, write the TDS. Null = as before. */
async function onBooking(tx: Tx, _actor: Actor, billId: string): Promise<BillBookingTax | null> {
  const lines = await taxLinesOf(tx, [billId]);
  const settings = await payingSettings(tx);
  const tds = await tdsFor(tx, billId, { goodsOn: settings.tdsGoods === true });
  const stores = lines.some((l) => l.storesLine);
  if (!stores && !tds.checked) return null;
  const [v] = await tx.select({ gstin: vendors.gstin }).from(vendors).innerJoin(supplierBills, eq(supplierBills.vendorId, vendors.id)).where(eq(supplierBills.id, billId));
  const credit = await signedTaxTable(tx, "gst_credit");
  return {
    lines: lines.map((l) => {
      const t = tds.lines.get(l.lineId);
      return {
        lineId: l.lineId,
        ...(l.storesLine && l.gstCredit === null ? { gstCredit: proposeCredit(credit?.rules as WireGstCreditRule[] | null, l, v?.gstin !== null && v?.gstin !== undefined).credit } : {}),
        tdsPaise: tds.checked ? (t?.paise ?? 0) : null, tdsNature: tds.checked ? (t?.nature ?? null) : null, tdsRef: tds.checked ? (t?.ref ?? null) : null,
      };
    }),
    tdsPaise: tds.tdsPaise,
  };
}

registerBillTaxHooks({ onBooking, dueDate: msmeDueDate });
