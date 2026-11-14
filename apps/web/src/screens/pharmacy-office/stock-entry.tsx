import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { fetchMaterialsSettings } from "../../lib/materials-api";
import { registerSaleItem } from "../../lib/pharmacy-api";
import {
  PACK_TYPES, captureInvoiceRows, captureStockRows, checkInvoiceRows, checkStockRows, fetchInvoiceStores, fetchReceivableOrders, fetchStockSuppliers,
  paiseOf, searchStockItems, stockErrorText, unitCostPaise,
} from "../../lib/stock-entry-api";
import { Button } from "@/components/ui/button";
import { ItemEditPanel } from "../materials-item-edit";
import { OpeningStockSheet } from "../materials-grn-opening";
import { NewDrugSheet } from "./new-drug-sheet";
import { Sheet } from "./sheet";
import { PriceCheckNote, priceAnswered } from "./price-check-note";
import { InvoiceHeaderForm } from "./stock-entry-invoice";
import { RecountPanel } from "./stock-entry-recount";
import type { ControlFile } from "./stock-entry-recount";
import type { WireOpeningCapture, WireOpeningCheck } from "../../lib/materials-api";
import type {
  PackType, PriceReasonCode, WireGridRow, WireInvoiceCapture, WireInvoiceCheck, WireInvoiceHeader, WireInvoiceRow, WirePriceCheck, WireStockCheck,
  WireStockItem,
} from "../../lib/stock-entry-api";
import "./stock-entry.css";

/**
 * ═══ STOCK ENTRY ON SCREEN (2026-09-29) — THE OFFICE'S STOCK → OPENING STOCK SHEET ═══
 *
 * The owner enters the real shelf here, one row per batch, the way a pharmacist copies it off the carton:
 * brand · pack · batch · expiry · boxes · per box · packs · free · MRP · rate · discount · rack · supplier. The CSV upload is
 * still here, folded under "Upload a sheet instead".
 *
 * ═══ ONE JUDGEMENT — THE SERVER'S ═══
 *
 * Every edit is sent (after a pause) to `POST /pharmacy/opening-stock/check`, the same planner the CSV goes
 * through (`planOpeningRows`), and each row shows the server's reasons under it before anything is captured.
 * The only arithmetic here is the live cost per unit and margin, for the eye; the server's figure is captured.
 *
 * ═══ CAPTURE IS NOT RECEIVE ═══
 *
 * Capture books goods receipts (GRNs). Nothing is sellable until each is checked (QC) and posted in the GRN
 * worklist — the screen says so before and after, and links there. Whether that must be a SECOND person is the
 * hospital's setting (`grnQcNeedsSecondPerson`, off by default, ruling 0019): the copy says so only when it is on
 * (walk 2026-11-13 — it claimed a second person while the same login could capture, QC and post).
 *
 * ═══ THE SALE PRICE IS THE MRP ═══
 *
 * No sale price and no counter discount are set here: those are an open money ruling. The trade discount
 * lowers the COST only.
 *
 * The rows are a DRAFT in this browser (localStorage) until captured, so a reload loses nothing.
 *
 * ═══ #1047 — TWO MODES, ONE GRID; AND THE RECOUNT'S CONTROL FILE ═══
 *
 * **Opening stock** is the batch-wise recount (a row with no rate is valued at the 0093 estimate, flagged).
 * **Supplier invoice** receives a delivery off its invoice: a header (the supplier, the invoice number and date,
 * an optional purchase order, the store, and whether the rate column includes GST) over the same rows, judged by
 * `POST /pharmacy/opening-stock/invoice/check` and captured as ONE GRN by `…/invoice/capture`; rack and supplier
 * are the opening count's columns and are hidden. In opening mode a control file (CSV: item, quantity in base
 * units) can be loaded; the grid then shows, per medicine, entered against control (`stock-entry-recount.tsx`) —
 * the file never leaves the browser.
 */
export const DRAFT_KEY = "hmis.pharmacy.stockEntry.draft.v1";
const GRN_WORKLIST = { view: "stock", page: "grn" } as const;

export type GridRow = {
  key: string; item: WireStockItem | null; query: string;
  packType: PackType; packSize: string; batch: string; expiry: string; packs: string; freePacks: string;
  /** #1033: sealed boxes and packs in one box; `packs` is then the loose ones. */
  boxes: string; perBox: string;
  mrp: string; rate: string; discount: string; rack: string; supplier: string;
  /** #1061 — the answer to an amber price (invoice mode): a reason code, and the words for "other". */
  priceReason: string; priceReasonText: string;
};

let seq = 0;
const newKey = (): string => { seq += 1; return `r${String(Date.now())}-${String(seq)}`; };
export const blankRow = (): GridRow => ({
  key: newKey(), item: null, query: "", packType: "tablet_strip", packSize: "", batch: "", expiry: "", packs: "", freePacks: "", boxes: "", perBox: "",
  mrp: "", rate: "", discount: "", rack: "", supplier: "", priceReason: "", priceReasonText: "",
});
/**
 * Walk 2026-11-13 — a brand just picked is not yet a row anybody has typed: its refusals ("the batch number is
 * missing", …) wait until something of the row's own is typed. Capture still waits for the server's judgement.
 */
const untouched = (r: GridRow): boolean =>
  [r.batch, r.expiry, r.boxes, r.perBox, r.packs, r.freePacks, r.rate, r.discount].every((v) => v.trim() === "");
const isBlank = (r: GridRow): boolean =>
  r.item === null && [r.query, r.packSize, r.batch, r.expiry, r.boxes, r.perBox, r.packs, r.freePacks, r.mrp, r.rate, r.discount, r.rack, r.supplier].every((v) => v.trim() === "");
/** Always exactly one blank row at the end — the next batch is typed into it. */
function withTail(rows: GridRow[]): GridRow[] {
  const body = [...rows];
  while (body.length > 1 && isBlank(body[body.length - 1]!) && isBlank(body[body.length - 2]!)) body.pop();
  return body.length === 0 || !isBlank(body[body.length - 1]!) ? [...body, blankRow()] : body;
}

function loadDraft(): GridRow[] {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (raw === null) return [blankRow()];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [blankRow()];
    return withTail(parsed.filter((r): r is GridRow => typeof r === "object" && r !== null && "packType" in r).map((r) => ({ ...blankRow(), ...r, key: newKey() })));
  } catch {
    return [blankRow()];
  }
}
function saveDraft(rows: GridRow[]): void {
  try {
    const kept = rows.filter((r) => !isBlank(r));
    if (kept.length === 0) window.localStorage.removeItem(DRAFT_KEY);
    else window.localStorage.setItem(DRAFT_KEY, JSON.stringify(kept));
  } catch { /* private window or storage off: the draft is a convenience, the grid still works */ }
}

/** The pack type an existing item's pack suggests — a strip of capsules is a capsule strip. */
function packTypeFor(item: WireStockItem, uom: string): PackType {
  const u = uom.toLowerCase();
  if (u.startsWith("strip")) return item.baseUom.toLowerCase().startsWith("cap") ? "capsule_strip" : "tablet_strip";
  const hit = PACK_TYPES.find((p) => u.startsWith(p));
  if (hit !== undefined) return hit;
  const base = PACK_TYPES.find((p) => item.baseUom.toLowerCase().startsWith(p));
  return base ?? "other";
}

/** A picked item fills what the master already knows: its biggest pack, its MRP on file, its rack. */
function fromItem(row: GridRow, item: WireStockItem): GridRow {
  const pack = [...item.packs].sort((a, b) => b.multiplier - a.multiplier)[0] ?? { uom: item.baseUom, multiplier: 1 };
  const mrpPack = item.mrpUom === null ? undefined : item.packs.find((p) => p.uom === item.mrpUom);
  const mrp = item.mrpPaise !== null && mrpPack?.multiplier === pack.multiplier ? (item.mrpPaise / 100).toFixed(2) : row.mrp;
  return {
    ...row, item, query: item.name, packSize: String(pack.multiplier), packType: packTypeFor(item, pack.uom),
    mrp, rack: row.rack === "" ? item.rack ?? "" : row.rack,
  };
}

export type EntryMode = "opening" | "invoice";
/**
 * Walk 2026-11-13 — the rate basis switch fell back to "without GST" after every capture, so the next invoice from a
 * supplier who prints rates with GST was costed wrong unless somebody noticed. The last choice is kept for the rest
 * of the browser session (this viewer's own convenience; the server is still told on every check and capture).
 */
export const RATE_BASIS_KEY = "hmis.pharmacy.stockEntry.rateIncludesGst";
function lastRateBasis(): boolean {
  try { return window.sessionStorage.getItem(RATE_BASIS_KEY) === "true"; } catch { return false; }
}
function keepRateBasis(withGst: boolean): void {
  try { window.sessionStorage.setItem(RATE_BASIS_KEY, String(withGst)); } catch { /* storage off: kept until the grid closes */ }
}
const blankHeader = (rateIncludesGst = false): WireInvoiceHeader => ({
  vendorId: null, invoiceNo: "", invoiceDate: "", purchaseOrderId: null, storeResourceId: null, rateIncludesGst,
});
/** The invoice's row: the opening row without the opening count's own columns (rack, supplier). */
function toInvoiceWire(r: GridRow): WireInvoiceRow {
  return {
    itemId: r.item!.itemId, batch: r.batch.trim(), expiry: r.expiry.trim(), mrpPerPack: r.mrp.trim(), packSize: r.packSize.trim(), packs: r.packs.trim(),
    freePacks: r.freePacks.trim(), ratePerPack: r.rate.trim(), discountPct: r.discount.trim(), packType: r.packType,
    boxes: r.boxes.trim(), packsPerBox: r.perBox.trim(),
  };
}

function toWire(r: GridRow): WireGridRow {
  return {
    itemId: r.item!.itemId, batch: r.batch.trim(), expiry: r.expiry.trim(), mrpPerPack: r.mrp.trim(), packSize: r.packSize.trim(), packs: r.packs.trim(),
    freePacks: r.freePacks.trim(), ratePerPack: r.rate.trim(), discountPct: r.discount.trim(), packType: r.packType, rack: r.rack.trim(), supplier: r.supplier.trim(),
    boxes: r.boxes.trim(), packsPerBox: r.perBox.trim(),
  };
}

/** What a pack and a unit are called on the row's total, by pack type. */
const PACK_WORDS = { pack: "pack", unit: "unit" };
const UNIT_WORDS: Partial<Record<PackType, { pack: string; unit: string }>> = {
  tablet_strip: { pack: "strip", unit: "tablet" }, capsule_strip: { pack: "strip", unit: "capsule" },
};
const wholeCell = (v: string): number | null => (v.trim() === "" ? 0 : /^\d+$/.test(v.trim()) ? Number(v.trim()) : null);
/**
 * #1033 — the row's total before the server sees it: boxes × per box + loose packs, and the units in them.
 * Null until there is something to count or while a cell is not a whole number; the server judges the rest.
 */
export function rowCount(r: Pick<GridRow, "boxes" | "perBox" | "packs" | "packSize">): { packs: number; units: number } | null {
  const boxes = wholeCell(r.boxes), perBox = wholeCell(r.perBox), loose = wholeCell(r.packs), size = wholeCell(r.packSize);
  if (boxes === null || perBox === null || loose === null || size === null || size < 1) return null;
  if (boxes > 0 && perBox < 1) return null;
  const packs = boxes * perBox + loose;
  return packs > 0 ? { packs, units: packs * size } : null;
}

const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

/**
 * The live figure on a row: cost of one unit after the discount, and the margin against the MRP. `gstRateBps`
 * (#1047, invoice mode with "rate with GST"): the rate is divided by 1 + the GST rate first, rounded down —
 * `rateWithoutGstPaise` on the server; the server's figure is the one captured.
 */
export function rowEconomics(r: Pick<GridRow, "mrp" | "rate" | "discount" | "packSize">, gstRateBps: number | null = null): { cost: number; marginPct: number | null } | null {
  const size = Number(r.packSize);
  const typed = r.rate.trim() === "" ? 0 : paiseOf(r.rate);
  const rate = typed === null || gstRateBps === null ? typed : Math.floor((typed * 10_000) / (10_000 + gstRateBps));
  const disc = r.discount.trim() === "" ? 0 : paiseOf(r.discount);
  if (!Number.isInteger(size) || size < 1 || rate === null || disc === null || disc >= 10_000) return null;
  const cost = unitCostPaise(rate, disc, size);
  const mrp = paiseOf(r.mrp);
  if (mrp === null || mrp <= 0) return { cost, marginPct: null };
  return { cost, marginPct: Math.round(((mrp - cost * size) / mrp) * 1000) / 10 };
}

export function StockEntryView(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [rows, setRowsRaw] = useState<GridRow[]>(loadDraft);
  const setRows = useCallback((f: (rs: GridRow[]) => GridRow[]): void => setRowsRaw((rs) => withTail(f(rs))), []);
  useEffect(() => { saveDraft(rows); }, [rows]);
  const suppliers = useQuery({ queryKey: ["pharmacy", "stock-entry", "suppliers"], queryFn: fetchStockSuppliers });
  const [mode, setMode] = useState<EntryMode>("opening");
  const [header, setHeader] = useState<WireInvoiceHeader>(() => blankHeader(lastRateBasis()));
  const [control, setControl] = useState<ControlFile | null>(null);
  const invoice = mode === "invoice";
  const stores = useQuery({ queryKey: ["pharmacy", "stock-entry", "invoice-stores"], queryFn: fetchInvoiceStores, enabled: invoice });
  const orders = useQuery({
    queryKey: ["pharmacy", "stock-entry", "orders", header.vendorId], queryFn: () => fetchReceivableOrders(header.vendorId!),
    enabled: invoice && header.vendorId !== null, retry: false,
  });
  // One store is the store: picked for the person.
  useEffect(() => {
    const only = stores.data?.length === 1 ? stores.data[0]!.id : null;
    if (invoice && only !== null && header.storeResourceId === null) setHeader((h) => ({ ...h, storeResourceId: only }));
  }, [invoice, stores.data, header.storeResourceId]);

  const [check, setCheck] = useState<{ sent: string; data: WireStockCheck } | null>(null);
  const [invCheck, setInvCheck] = useState<{ sent: string; data: WireInvoiceCheck } | null>(null);
  const [invResult, setInvResult] = useState<WireInvoiceCapture | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WireOpeningCapture | null>(null);
  const [busy, setBusy] = useState(false);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (focusTimer.current !== null) clearTimeout(focusTimer.current); }, []);
  const [newDrug, setNewDrug] = useState<{ rowKey: string; name: string } | null>(null);
  const [editing, setEditing] = useState<{ rowKey: string; item: WireStockItem } | null>(null);
  const [upload, setUpload] = useState(false);
  const mayCreate = can("materials.items.manage");
  const mayPutOnSale = can("pharmacy.sale_items.manage");
  // The two-person GRN setting (0019): the copy claims a second person only when the hospital has turned it on.
  const settings = useQuery({
    queryKey: ["materials", "settings"], queryFn: fetchMaterialsSettings, enabled: can("materials.stock.read"), retry: false,
  });
  const secondPerson = settings.data?.grnQcNeedsSecondPerson === true;
  const afterCapture = t(secondPerson ? "stockEntry.afterCapture" : "stockEntry.afterCaptureSelf");

  const update = (key: string, patch: Partial<GridRow>): void => {
    setResult(null); setInvResult(null);
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const remove = (key: string): void => setRows((rs) => rs.filter((r) => r.key !== key));

  // What the server judges: every row with a picked brand. A row with text but no brand is this screen's to say.
  const entered = rows.filter((r) => !isBlank(r));
  const sendable = entered.filter((r) => r.item !== null);
  const payload = useMemo(() => sendable.map(toWire), [sendable]);
  const payloadKey = JSON.stringify(payload);
  const invoicePayload = useMemo(() => sendable.map(toInvoiceWire), [sendable]);
  const invoiceKey = JSON.stringify([header, invoicePayload]);
  const unpicked = entered.filter((r) => r.item === null);

  // The server's judgement, after a pause in typing. Stale answers are dropped by comparing what was sent.
  useEffect(() => {
    if (invoice) return;
    if (payload.length === 0) { setCheck(null); setCheckError(null); return; }
    const sent = payloadKey;
    const id = setTimeout(() => {
      checkStockRows(payload)
        .then((data) => { setCheck((c) => (JSON.stringify(payload) === sent ? { sent, data } : c)); setCheckError(null); })
        .catch((e: unknown) => setCheckError(stockErrorText(e, t)));
    }, 600);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `payloadKey` is the payload's identity
  }, [payloadKey, invoice]);
  // #1047 — the invoice mode's judgement: the header and the rows together.
  useEffect(() => {
    if (!invoice) return;
    if (invoicePayload.length === 0) { setInvCheck(null); setCheckError(null); return; }
    const sent = invoiceKey;
    const id = setTimeout(() => {
      checkInvoiceRows(header, invoicePayload)
        .then((data) => { setInvCheck((c) => (JSON.stringify([header, invoicePayload]) === sent ? { sent, data } : c)); setCheckError(null); })
        .catch((e: unknown) => setCheckError(stockErrorText(e, t)));
    }, 600);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `invoiceKey` is the header and payload's identity
  }, [invoiceKey, invoice]);

  const fresh = !invoice && check !== null && check.sent === payloadKey ? check.data : null;
  const invFresh = invoice && invCheck !== null && invCheck.sent === invoiceKey ? invCheck.data : null;
  const judged = invoice ? invFresh : fresh;
  const reasonsFor = (key: string): string[] => {
    const i = sendable.findIndex((r) => r.key === key);
    if (i < 0 || judged === null) return [];
    return judged.rows.find((x) => x.line === i + 1)?.reasons ?? [];
  };
  const judgedRow = (key: string): WireOpeningCheck["rows"][number] | undefined => {
    const i = sendable.findIndex((r) => r.key === key);
    return i < 0 || judged === null ? undefined : judged.rows.find((x) => x.line === i + 1);
  };
  const lacking = judged?.authority.filter((a) => !a.held && a.why !== "racks") ?? [];
  // #1061 — an amber price waits for its reason (the server refuses the capture without one).
  const priceOf = (key: string): WirePriceCheck | null => {
    const i = sendable.findIndex((r) => r.key === key);
    return i < 0 || invFresh === null ? null : invFresh.rows.find((x) => x.line === i + 1)?.priceCheck ?? null;
  };
  const unansweredPrices = invoice ? sendable.filter((r) => priceOf(r.key)?.status === "amber" && !priceAnswered(r.priceReason, r.priceReasonText)) : [];
  const canCapture = invoice
    ? invFresh !== null && invFresh.refusals === 0 && invFresh.headerReasons.length === 0 && lacking.length === 0 && unpicked.length === 0 && !busy
      && unansweredPrices.length === 0
    : fresh !== null && fresh.refusals === 0 && lacking.length === 0 && unpicked.length === 0 && !busy && fresh.grns.some((g) => g.state === "new");

  const capture = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      if (invoice) {
        // #1061 — the reasons travel with the capture only; the check is judged without them.
        setInvResult(await captureInvoiceRows(header, sendable.map((r) => ({
          ...toInvoiceWire(r),
          ...(r.priceReason === "" ? {} : { priceReason: r.priceReason as PriceReasonCode, priceReasonText: r.priceReasonText.trim() }),
        }))));
        setRowsRaw([blankRow()]);
        setInvCheck(null);
        // The store and the rate basis stay for the next invoice; the rest is this invoice's own.
        setHeader((h) => ({ ...blankHeader(h.rateIncludesGst), storeResourceId: h.storeResourceId }));
        await qc.invalidateQueries({ queryKey: ["materials"] });
        await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
        return;
      }
      const done = await captureStockRows(payload);
      setResult(done);
      setRowsRaw([blankRow()]);
      setCheck(null);
      await qc.invalidateQueries({ queryKey: ["materials"] });
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
    } catch (e) {
      setError(stockErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const pick = (key: string, item: WireStockItem): void => {
    setRows((rs) => rs.map((r) => (r.key === key ? fromItem(r, item) : r)));
    // The brand is chosen: the batch is next. The timer is cleared if the grid closes first.
    if (focusTimer.current !== null) clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => document.querySelector<HTMLInputElement>(`[data-row="${key}"] [data-col="batch"]`)?.focus(), 0);
  };
  const putOnSale = async (key: string, item: WireStockItem): Promise<void> => {
    setError(null);
    try {
      await registerSaleItem(item.itemId);
      pick(key, { ...item, onSale: true });
    } catch (e) {
      setError(stockErrorText(e, t));
    }
  };

  /** Closing the item's sheet reads it again (GST, a new pack) and keeps the row's own cells. */
  const closeEdit = (): void => {
    if (editing === null) return;
    const { rowKey, item } = editing;
    setEditing(null);
    void searchStockItems(item.code).then((hits) => {
      const fresher = hits.find((h) => h.itemId === item.itemId);
      if (fresher !== undefined) setRows((rs) => rs.map((x) => (x.key === rowKey ? { ...x, item: fresher } : x)));
    }).catch(() => undefined);
  };

  /* Enter walks the row like Tab does; past the last cell it lands on the next row's brand. */
  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Enter" || e.defaultPrevented || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement;
    if (el.dataset.cell === undefined) return;
    const cells = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-cell]"));
    const next = cells[cells.indexOf(el) + 1];
    if (next === undefined) return;
    e.preventDefault();
    next.focus();
  };

  const units = judged?.units ?? 0;
  return (
    <div className="space-y-4 se" data-testid="stock-entry">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold" id="opening-stock-entry-title">{t(invoice ? "stockEntry.invoice.heading" : "stockEntry.title")}</h1>
          <p className="text-sm text-muted-foreground">{t(invoice ? "stockEntry.invoice.lead" : "stockEntry.lead")}</p>
        </div>
        {mayCreate && (
          <Button type="button" variant="outline" data-testid="se-new-drug" onClick={() => setNewDrug({ rowKey: rows[rows.length - 1]!.key, name: "" })}>
            {t("stockEntry.newDrug")}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("stockEntry.mode.label")} data-testid="se-mode">
        {(["opening", "invoice"] as const).map((m) => (
          <Button key={m} type="button" variant={mode === m ? "default" : "outline"} aria-pressed={mode === m} data-testid={`se-mode-${m}`}
            onClick={() => { setMode(m); setResult(null); setInvResult(null); setError(null); setCheckError(null); }}>
            {t(`stockEntry.mode.${m}`)}
          </Button>
        ))}
      </div>

      {invoice && (
        <InvoiceHeaderForm
          header={header}
          onChange={(p) => { setInvResult(null); if (p.rateIncludesGst !== undefined) keepRateBasis(p.rateIncludesGst); setHeader((h) => ({ ...h, ...p })); }}
          suppliers={suppliers.data ?? []} stores={stores.data ?? []} orders={orders.isError ? null : orders.data ?? []}
          reasons={invFresh?.headerReasons ?? []}
          unusedCreditPaise={invFresh?.unusedCreditPaise ?? 0}
        />
      )}

      <div className="se-notes">
        <p data-testid="se-two-person">
          {t(secondPerson ? "stockEntry.twoPerson" : "stockEntry.twoPersonOff")}{" "}
          <Link to="/pharmacy/office" search={GRN_WORKLIST} className="underline">{t("stockEntry.worklistLink")}</Link>
        </p>
        <p className="text-muted-foreground" data-testid="se-mrp-note">{t("stockEntry.mrpNote")}</p>
      </div>

      {error !== null && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {checkError !== null && <p role="alert" className="text-sm text-red-700">{checkError}</p>}

      {invResult !== null && (
        <div role="status" className="se-result" data-testid="se-invoice-result">
          <p className="font-semibold">{t("stockEntry.invoice.captured", { grnNo: invResult.grnNo, count: invResult.lines })}</p>
          <p className="mt-2 text-sm">
            {afterCapture}{" "}
            <Link to="/pharmacy/office" search={GRN_WORKLIST} className="font-semibold underline">{t("stockEntry.worklistLink")}</Link>
          </p>
        </div>
      )}

      {result !== null && (
        <div role="status" className="se-result" data-testid="se-result">
          <p className="font-semibold">{t("stockEntry.captured", { count: result.captured.length })}</p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {result.captured.map((g) => (
              <li key={g.grnId}>
                <span className="font-mono">{g.grnNo}</span>{" · "}
                {t(g.near ? "materialsGrn.opening.capturedNear" : "materialsGrn.opening.capturedLine", { count: g.lines })}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm">
            {afterCapture}{" "}
            <Link to="/pharmacy/office" search={GRN_WORKLIST} className="font-semibold underline" data-testid="se-worklist">{t("stockEntry.worklistLink")}</Link>
          </p>
        </div>
      )}

      <div className="se-grid" onKeyDown={onGridKey} data-testid="se-grid">
        <table>
          <colgroup>
            <col className="c-brand" /><col className="c-pack" /><col className="c-n" /><col className="c-batch" /><col className="c-exp" />
            <col className="c-n" /><col className="c-n" /><col className="c-n" /><col className="c-n" /><col className="c-money" /><col className="c-money" /><col className="c-n" />
            <col className="c-cost" /><col className="c-gst" /><col className="c-rack" /><col className="c-sup" /><col className="c-x" />
          </colgroup>
          <thead>
            <tr>
              <th>{t("stockEntry.col.brand")}</th><th>{t("stockEntry.col.packType")}</th><th>{t("stockEntry.col.packSize")}</th>
              <th>{t("stockEntry.col.batch")}</th><th>{t("stockEntry.col.expiry")}</th><th>{t("stockEntry.col.boxes")}</th><th>{t("stockEntry.col.perBox")}</th><th>{t("stockEntry.col.packs")}</th>
              <th>{t("stockEntry.col.free")}</th><th>{t("stockEntry.col.mrp")}</th><th>{t("stockEntry.col.rate")}</th>
              <th>{t("stockEntry.col.discount")}</th><th>{t("stockEntry.col.cost")}</th><th>{t("stockEntry.col.gst")}</th>
              {!invoice && <><th>{t("stockEntry.col.rack")}</th><th>{t("stockEntry.col.supplier")}</th></>}
              <th><span className="sr-only">{t("stockEntry.remove")}</span></th>
            </tr>
          </thead>
          {rows.map((r, i) => (
            <RowView
              key={r.key} row={r} index={i} last={i === rows.length - 1}
              reasons={r.item === null ? (isBlank({ ...r, query: "" }) ? [] : [t("stockEntry.pickBrand")]) : untouched(r) ? [] : reasonsFor(r.key)}
              near={judgedRow(r.key)?.near === true && r.item !== null}
              estimate={!invoice && judgedRow(r.key)?.estimatedCost === true ? judgedRow(r.key)!.costPerBasePaise : null}
              mode={mode} rateIncludesGst={invoice && header.rateIncludesGst}
              priceCheck={invoice && r.item !== null ? priceOf(r.key) : null}
              mayCreate={mayCreate} mayPutOnSale={mayPutOnSale}
              onChange={(p) => update(r.key, p)} onRemove={() => remove(r.key)} onPick={(item) => pick(r.key, item)}
              onPutOnSale={(item) => void putOnSale(r.key, item)}
              onNewDrug={(name) => setNewDrug({ rowKey: r.key, name })}
              onEdit={(item) => setEditing({ rowKey: r.key, item })}
            />
          ))}
        </table>
        <datalist id="se-suppliers">
          {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.name}>{s.code}</option>)}
        </datalist>
      </div>

      <div className="se-foot">
        <p className="text-sm" role="status" data-testid="se-summary">
          {sendable.length === 0
            ? t("stockEntry.empty")
            : judged === null
              ? t("stockEntry.checking")
              : t("stockEntry.summary", {
                rows: t("stockEntry.rows", { count: sendable.length }), refused: judged.refusals + unpicked.length, units: t("stockEntry.n.unit", { count: units }),
              })}
          {invFresh !== null && invFresh.costPaise > 0 && <span data-testid="se-invoice-cost">{" · "}{t("stockEntry.invoice.cost", { amount: rupees(invFresh.costPaise) })}</span>}
        </p>
        {/* Said in words — who to ask — never as a permission key (walk 2026-11-13). */}
        {lacking.map((a) => <p key={a.why} className="text-sm text-red-700">{t(`stockEntry.needs_${a.why}`)}</p>)}
        {fresh !== null && (fresh.estimated ?? 0) > 0 && (
          <p className="text-sm text-amber-800" data-testid="se-estimated">{t("stockEntry.estimated", { count: fresh.estimated ?? 0 })}</p>
        )}
        {fresh !== null && fresh.zeroCost > 0 && <p className="text-sm text-amber-800">{t("materialsGrn.opening.zeroCost", { count: fresh.zeroCost })}</p>}
        {fresh !== null && fresh.authority.some((a) => a.why === "racks" && !a.held) && <p className="text-sm text-amber-800">{t("materialsGrn.opening.racksLeft", { count: fresh.racks })}</p>}
        {fresh?.grns.filter((g) => g.state !== "new").map((g) => (
          <p key={g.challanNo} className="text-sm">{t(`materialsGrn.opening.state_${g.state}`, { challan: g.challanNo, grnNo: g.grnNo ?? "" })}</p>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={!canCapture} data-testid="se-capture" onClick={() => void capture()}>
            {t(invoice ? "stockEntry.invoice.capture" : "stockEntry.capture")}
          </Button>
          <span className="text-xs text-muted-foreground">{t("stockEntry.captureHint")}</span>
          {entered.length > 0 && (
            <button type="button" className="ml-auto text-xs text-muted-foreground underline" data-testid="se-clear"
              onClick={() => { if (window.confirm(t("stockEntry.clearConfirm"))) { setRowsRaw([blankRow()]); setCheck(null); } }}>
              {t("stockEntry.clear")}
            </button>
          )}
        </div>
      </div>

      {!invoice && (
        <RecountPanel rows={sendable} control={control} onLoad={setControl} onClear={() => setControl(null)} />
      )}

      {!invoice && <details className="se-upload" open={upload} onToggle={(e) => setUpload((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer text-sm font-medium" data-testid="se-upload">{t("stockEntry.upload")}</summary>
        {upload && <div className="mt-3"><OpeningStockSheet onOpenGrn={() => void navigate({ to: "/pharmacy/office", search: GRN_WORKLIST })} /></div>}
      </details>}

      {newDrug !== null && (
        <Sheet title={t("stockEntry.newDrugTitle")} testId="se-new-drug-sheet" onClose={() => setNewDrug(null)}>
          <NewDrugSheet
            initialName={newDrug.name}
            onDone={(item) => { const key = newDrug.rowKey; setNewDrug(null); void qc.invalidateQueries({ queryKey: ["pharmacy", "stock-entry"] }); pick(key, item); }}
          />
        </Sheet>
      )}
      {editing !== null && (
        <Sheet title={t("stockEntry.editTitle", { name: editing.item.name })} testId="se-edit-sheet" onClose={closeEdit}>
          <ItemEditPanel itemId={editing.item.itemId} onClose={closeEdit} />
        </Sheet>
      )}
    </div>
  );
}

function RowView({ row, index, last, reasons, near, estimate, mode, rateIncludesGst, priceCheck, mayCreate, mayPutOnSale, onChange, onRemove, onPick, onPutOnSale, onNewDrug, onEdit }: {
  row: GridRow; index: number; last: boolean; reasons: string[]; near: boolean; mayCreate: boolean; mayPutOnSale: boolean;
  /** #1061 — the invoice mode's price check of this row, or null. */
  priceCheck: WirePriceCheck | null;
  /** #1047 / 0093 — the server's estimated cost per unit for a row with no rate (opening mode), or null. */
  estimate: number | null; mode: EntryMode; rateIncludesGst: boolean;
  onChange: (p: Partial<GridRow>) => void; onRemove: () => void; onPick: (item: WireStockItem) => void;
  onPutOnSale: (item: WireStockItem) => void; onNewDrug: (name: string) => void; onEdit: (item: WireStockItem) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  // With GST in the rate (invoice mode), the live figure divides it out first, as the server does.
  const gstForCost = rateIncludesGst ? row.item?.gstRateBps ?? null : null;
  const econ = rowEconomics(row, gstForCost);
  const count = rowCount(row);
  const words = UNIT_WORDS[row.packType] ?? PACK_WORDS;
  const total = count === null ? null : t("stockEntry.total", {
    packs: t(`stockEntry.n.${words.pack}`, { count: count.packs }), units: t(`stockEntry.n.${words.unit}`, { count: count.units }),
  });
  const cell = (col: string): { "data-cell": string; "data-col": string } => ({ "data-cell": `${String(index)}:${col}`, "data-col": col });
  const input = (col: keyof GridRow, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}): React.ReactElement => (
    <input
      {...cell(col)} aria-label={`${label} · ${t("stockEntry.rowN", { n: index + 1 })}`} className="se-in"
      value={row[col] as string} onChange={(e) => onChange({ [col]: e.target.value } as Partial<GridRow>)} {...extra}
    />
  );
  const gst = row.item?.gstRateBps;
  return (
    <tbody data-row={row.key} className={reasons.length > 0 ? "se-bad" : ""} data-testid={`se-row-${String(index)}`}>
      <tr>
        <td data-label={t("stockEntry.col.brand")} className="se-brand">
          <BrandField
            row={row} index={index} mayCreate={mayCreate} mayPutOnSale={mayPutOnSale}
            onQuery={(q) => onChange({ query: q, item: null })} onPick={onPick} onPutOnSale={onPutOnSale} onNewDrug={onNewDrug}
          />
          {row.item !== null && (
            <span className="se-meta">
              {[row.item.strength, row.item.form, row.item.schedule === null ? null : t("stockEntry.schedule", { s: row.item.schedule })].filter((x) => x !== null).join(" · ")}
              {" "}
              <button type="button" className="underline" data-testid={`se-edit-${String(index)}`} onClick={() => onEdit(row.item!)}>{t("stockEntry.editItem")}</button>
            </span>
          )}
        </td>
        <td data-label={t("stockEntry.col.packType")}>
          <select {...cell("packType")} aria-label={`${t("stockEntry.col.packType")} · ${t("stockEntry.rowN", { n: index + 1 })}`} className="se-in"
            value={row.packType} onChange={(e) => onChange({ packType: e.target.value as PackType })}>
            {PACK_TYPES.map((p) => <option key={p} value={p}>{t(`stockEntry.pack.${p}`)}</option>)}
          </select>
        </td>
        <td data-label={t("stockEntry.col.packSize")}>{input("packSize", t("stockEntry.col.packSize"), { inputMode: "numeric", placeholder: "10" })}</td>
        <td data-label={t("stockEntry.col.batch")}>{input("batch", t("stockEntry.col.batch"), { autoCapitalize: "characters" })}</td>
        <td data-label={t("stockEntry.col.expiry")}>{input("expiry", t("stockEntry.col.expiry"), { placeholder: "MM/YY", inputMode: "numeric" })}</td>
        <td data-label={t("stockEntry.col.boxes")}>{input("boxes", t("stockEntry.col.boxes"), { inputMode: "numeric", placeholder: "0" })}</td>
        <td data-label={t("stockEntry.col.perBox")}>{input("perBox", t("stockEntry.col.perBox"), { inputMode: "numeric" })}</td>
        <td data-label={t("stockEntry.col.packs")}>
          {input("packs", t("stockEntry.col.packs"), { inputMode: "numeric" })}
          {total !== null && <span className="se-total" data-testid={`se-total-${String(index)}`}>{total}</span>}
        </td>
        <td data-label={t("stockEntry.col.free")}>{input("freePacks", t("stockEntry.col.free"), { inputMode: "numeric", placeholder: "0" })}</td>
        <td data-label={t("stockEntry.col.mrp")}>{input("mrp", t("stockEntry.col.mrp"), { inputMode: "decimal", placeholder: "0.00" })}</td>
        <td data-label={t("stockEntry.col.rate")}>{input("rate", t("stockEntry.col.rate"), { inputMode: "decimal", placeholder: "0.00" })}</td>
        <td data-label={t("stockEntry.col.discount")}>{input("discount", t("stockEntry.col.discount"), { inputMode: "decimal", placeholder: "0" })}</td>
        <td data-label={t("stockEntry.col.cost")} className="se-cost" data-testid={`se-cost-${String(index)}`}>
          {estimate !== null && row.rate.trim() === "" ? (
            <span className="text-amber-800" data-testid={`se-estimate-${String(index)}`}>{t("stockEntry.perUnitEstimated", { amount: rupees(estimate) })}</span>
          ) : econ === null || row.rate.trim() === "" ? <span className="text-muted-foreground">—</span> : (
            <>
              <b>{t("stockEntry.perUnit", { amount: rupees(econ.cost) })}</b>
              {econ.marginPct !== null && <span className={econ.marginPct < 0 ? "text-red-700" : "text-muted-foreground"}>{t("stockEntry.margin", { pct: econ.marginPct })}</span>}
            </>
          )}
        </td>
        <td data-label={t("stockEntry.col.gst")} className="se-gst">{gst === undefined || gst === null ? "—" : gst === 0 ? t("stockEntry.nil") : `${String(gst / 100)}%`}</td>
        {mode === "opening" && (
          <>
            <td data-label={t("stockEntry.col.rack")}>{input("rack", t("stockEntry.col.rack"))}</td>
            <td data-label={t("stockEntry.col.supplier")} className="se-sup">{input("supplier", t("stockEntry.col.supplier"), { list: "se-suppliers", placeholder: t("stockEntry.openingStock") })}</td>
          </>
        )}
        <td className="se-x">
          {!last && <button type="button" aria-label={t("stockEntry.removeRow", { n: index + 1 })} data-testid={`se-remove-${String(index)}`} onClick={onRemove}>×</button>}
        </td>
      </tr>
      {(reasons.length > 0 || near) && (
        <tr className="se-why">
          <td colSpan={mode === "opening" ? 15 : 13}>
            {reasons.length > 0
              ? <span className="text-red-700" data-testid={`se-reasons-${String(index)}`}>{reasons.join(" · ")}</span>
              : <span className="text-amber-800">{t("stockEntry.near")}</span>}
          </td>
        </tr>
      )}
      {priceCheck !== null && reasons.length === 0 && (priceCheck.status === "amber" || priceCheck.status === "first") && (
        <tr className="se-why">
          <td colSpan={mode === "opening" ? 15 : 13}>
            <PriceCheckNote
              check={priceCheck} index={index} reason={row.priceReason} reasonText={row.priceReasonText}
              onReason={(p) => onChange({ ...(p.priceReason === undefined ? {} : { priceReason: p.priceReason }), ...(p.priceReasonText === undefined ? {} : { priceReasonText: p.priceReasonText }) })}
            />
          </td>
        </tr>
      )}
    </tbody>
  );
}

/**
 * The brand: type, and the item master answers (brand · strength · form · pack). ↑/↓ and Enter pick; the last
 * choice is always "+ New drug" for a brand the hospital has never stocked; an item not sold yet can be put on sale.
 */
function BrandField({ row, index, mayCreate, mayPutOnSale, onQuery, onPick, onPutOnSale, onNewDrug }: {
  row: GridRow; index: number; mayCreate: boolean; mayPutOnSale: boolean; onQuery: (q: string) => void;
  onPick: (item: WireStockItem) => void; onPutOnSale: (item: WireStockItem) => void; onNewDrug: (name: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [ask, setAsk] = useState("");
  const q = row.query.trim();
  useEffect(() => { const id = setTimeout(() => setAsk(q), 200); return () => clearTimeout(id); }, [q]);
  const hits = useQuery({
    queryKey: ["pharmacy", "stock-entry", "items", ask], queryFn: () => searchStockItems(ask),
    enabled: open && row.item === null && ask.length >= 2, staleTime: 30_000,
  });
  const list = hits.data ?? [];
  const choices = list.length + 1; // the last is "+ New drug"
  const blur = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A blur timer still pending when the grid closes must not fire into a torn-down page.
  useEffect(() => () => { if (blur.current !== null) clearTimeout(blur.current); }, []);
  const choose = (i: number): void => {
    setOpen(false);
    if (i < list.length) {
      const it = list[i]!;
      if (it.onSale) onPick(it);
      else if (mayPutOnSale) onPutOnSale(it);
    } else if (mayCreate) onNewDrug(q);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!open || row.item !== null || q.length < 2) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(choices - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(active); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };
  const listId = `se-brand-list-${row.key}`;
  const show = open && row.item === null && q.length >= 2;
  return (
    <div className="se-combo">
      <input
        data-cell={`${String(index)}:brand`} data-col="brand" className={`se-in ${row.item !== null ? "se-picked" : ""}`}
        role="combobox" aria-expanded={show} aria-controls={listId} aria-autocomplete="list"
        aria-label={`${t("stockEntry.col.brand")} · ${t("stockEntry.rowN", { n: index + 1 })}`} placeholder={t("stockEntry.brandPlaceholder")}
        value={row.query}
        onChange={(e) => { onQuery(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => { if (blur.current !== null) clearTimeout(blur.current); setOpen(true); }}
        onBlur={() => { blur.current = setTimeout(() => setOpen(false), 150); }}
        onKeyDown={onKey}
      />
      {show && (
        <ul id={listId} role="listbox" className="se-list" data-testid={`se-brand-list-${String(index)}`}>
          {hits.isFetching && list.length === 0 && <li className="se-opt se-dim">{t("stockEntry.searching")}</li>}
          {list.map((it, i) => (
            <li
              key={it.itemId} role="option" aria-selected={i === active} className={`se-opt ${i === active ? "on" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); choose(i); }}
            >
              <span className="se-opt-name">{it.name}</span>
              <span className="se-opt-meta">
                {[it.strength, it.form, packLabel(it, t)].filter((x) => x !== null && x !== "").join(" · ")}
                {!it.onSale && <em className="se-offsale">{mayPutOnSale ? t("stockEntry.notOnSalePut") : t("stockEntry.notOnSale")}</em>}
              </span>
            </li>
          ))}
          <li
            role="option" aria-selected={active === list.length} className={`se-opt se-new ${active === list.length ? "on" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); choose(list.length); }} data-testid={`se-brand-new-${String(index)}`}
          >
            {mayCreate ? t("stockEntry.newDrugNamed", { name: q }) : t("stockEntry.newDrugAsk")}
          </li>
        </ul>
      )}
    </div>
  );
}

function packLabel(it: WireStockItem, t: (k: string, o?: Record<string, unknown>) => string): string {
  const big = [...it.packs].sort((a, b) => b.multiplier - a.multiplier)[0];
  if (big === undefined || big.multiplier === 1) return it.baseUom;
  return t("stockEntry.packOf", { uom: big.uom, n: big.multiplier, base: it.baseUom });
}
