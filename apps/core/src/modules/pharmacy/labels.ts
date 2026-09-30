import { and, asc, eq, gt, ilike, inArray, or } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { items, pharmacyShelfLocations, printJobs, stockBalances, stockBatches } from "../../kernel/db/schema";
import { enqueuePrintJob } from "../../kernel/printing/enqueue";
import { esc } from "../../kernel/printing/render";
import { qrSvg } from "../../kernel/printing/qr";
import { relayServes } from "../../kernel/printing/served";
import { listStores, requireStore, uomsByItems } from "../materials";
import { PharmacyError } from "./errors";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import type { Db } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/render";

/**
 * ═══ GAP A6 — RACK AND STRIP LABELS ═══
 *
 * Two stickers off the pharmacy's barcode printer, both 50 × 25 mm (the TSC / Zebra / TVS roll every
 * Indian pharmacy runs; DECIDED in the gap-closure plan):
 *
 *   - a RACK label for the shelf edge: the rack location large, the item's name and code, and a QR
 *     that says which item lives there;
 *   - a STRIP label for a loose strip cut from its box: the item, batch, expiry and MRP per pack
 *     from the books, and a QR the dispensing desk's scan reads as that item, that batch, that pack.
 *     No code or rack line: the QR carries the code, and a long name keeps its strength instead.
 *
 * The QR carries an in-house payload, never a GS1 string we have no GTIN for:
 *
 *     HMIS1|<itemCode>                         rack
 *     HMIS1|<itemCode>|<batchNo>|<packUom>     strip
 *
 * `scan.ts` reads it (`parseInHouseLabel`). A job's params are identifiers and counts only — the
 * renderer reads names, racks, expiries and MRPs at print time, as every document does.
 */

export type LabelKind = "rack" | "strip";
export const LABEL_DOCUMENT = { rack: "pharmacy_rack_label", strip: "pharmacy_strip_label" } as const;
export type LabelDocument = (typeof LABEL_DOCUMENT)[LabelKind];

/** Who sets the rack decides the rack's label: the same permission as `PUT /pharmacy/items/:id/location`. */
export const LABELS_PERMISSION = "pharmacy.sale_items.manage";
/** One request's ceiling. A whole store's shelf is a few hundred labels; a roll is 1,000–2,000. */
export const MAX_LABELS_PER_JOB = 500;
export const MAX_COPIES = 200;

export type LabelLineInput = { itemId: string; batchId?: string | null; packUom?: string | null; copies: number };
export type LabelRequest = { kind: LabelKind; storeResourceId: string; lines: LabelLineInput[] };

const PREFIX = "HMIS1";
/** What the sticker's QR says. `|` never occurs in an item code; a batch number carrying one is refused. */
export function labelPayload(itemCode: string, batch: { batchNo: string; packUom: string } | null): string {
  return batch === null ? `${PREFIX}|${itemCode}` : `${PREFIX}|${itemCode}|${batch.batchNo}|${batch.packUom}`;
}
/** The reverse, for the desk's scan. Null for anything that is not ours, so a GS1 or EAN scan goes its own way. */
export function parseInHouseLabel(raw: string): { itemCode: string; batchNo: string | null; packUom: string | null } | null {
  const parts = raw.trim().split("|");
  if (parts[0] !== PREFIX) return null;
  if (parts.length === 2 && parts[1] !== "") return { itemCode: parts[1]!, batchNo: null, packUom: null };
  if (parts.length === 4 && parts.slice(1).every((p) => p !== "")) return { itemCode: parts[1]!, batchNo: parts[2]!, packUom: parts[3]! };
  return null;
}

// ═══════════════════════════════════ what the screen picks from ═══════════════════════════════════

export type LabelCandidate = {
  itemId: string; code: string; name: string; baseUom: string; rack: string | null;
  packs: { uom: string; toBase: number }[];
  batches: { batchId: string; batchNo: string; expiryDate: string | null; mrpPaise: number | null; mrpUom: string | null; qtyOnHand: number }[];
};

/**
 * The store's items for the labels screen: every item on a rack or with stock in the store, each with
 * its rack, its packs and the batches the store holds. `q` narrows by code or name. No store: the stores only.
 */
export async function labelCandidates(db: Db, storeResourceId: string | null, q: string): Promise<{ stores: { id: string; code: string; name: string }[]; rows: LabelCandidate[] }> {
  const stores = (await listStores(db)).map((s) => ({ id: s.id, code: s.code, name: s.name }));
  if (storeResourceId === null) return { stores, rows: [] };
  await requireStore(db, storeResourceId);
  const racks = await db.select({ itemId: pharmacyShelfLocations.itemId, location: pharmacyShelfLocations.location })
    .from(pharmacyShelfLocations).where(eq(pharmacyShelfLocations.storeResourceId, storeResourceId));
  const held = await db.select({ itemId: stockBalances.itemId, batchId: stockBalances.batchId, qty: stockBalances.qtyOnHand })
    .from(stockBalances).where(and(eq(stockBalances.resourceId, storeResourceId), gt(stockBalances.qtyOnHand, 0)));
  const ids = [...new Set([...racks.map((r) => r.itemId), ...held.map((h) => h.itemId)])];
  if (ids.length === 0) return { stores, rows: [] };
  const needle = q.trim();
  const itemRows = await db.select().from(items)
    .where(needle === "" ? inArray(items.id, ids) : and(inArray(items.id, ids), or(ilike(items.code, `%${needle}%`), ilike(items.name, `%${needle}%`))))
    .orderBy(asc(items.name)).limit(300);
  const shown = itemRows.map((i) => i.id);
  const batchIds = held.filter((h) => shown.includes(h.itemId)).map((h) => h.batchId);
  const batches = batchIds.length === 0 ? [] : await db.select().from(stockBatches).where(inArray(stockBatches.id, batchIds));
  const qtyOf = new Map(held.map((h) => [h.batchId, h.qty]));
  const rackOf = new Map(racks.map((r) => [r.itemId, r.location]));
  const uoms = await uomsByItems(db, shown);
  return {
    stores,
    rows: itemRows.map((i) => ({
      itemId: i.id, code: i.code, name: i.name, baseUom: i.baseUom, rack: rackOf.get(i.id) ?? null,
      packs: (uoms.get(i.id) ?? []).filter((u) => u.toBaseMultiplier > 1).map((u) => ({ uom: u.uom, toBase: u.toBaseMultiplier })).sort((a, b) => a.toBase - b.toBase),
      batches: batches.filter((b) => b.itemId === i.id)
        .map((b) => ({ batchId: b.id, batchNo: b.batchNo, expiryDate: b.expiryDate, mrpPaise: b.mrpPaise, mrpUom: b.mrpUom, qtyOnHand: qtyOf.get(b.id) ?? 0 }))
        .sort((a, b) => (a.expiryDate ?? "9999").localeCompare(b.expiryDate ?? "9999")),
    })),
  };
}

// ═══════════════════════════════════ resolving and drawing ═══════════════════════════════════

type Resolved = { copies: number; itemCode: string; itemName: string; rack: string | null; storeCode: string;
  batch: { batchNo: string; expiryDate: string | null; mrpPaise: number; mrpUom: string; packUom: string } | null };

function invalid(message: string, details: Record<string, unknown> = {}): PharmacyError {
  return new PharmacyError("invalid_label", message, details);
}

/** Every line checked against the books before anything is queued: a label that lies is worse than none. */
async function resolveLines(db: Db, input: LabelRequest): Promise<Resolved[]> {
  if (input.lines.length === 0) throw invalid("pick at least one item to label");
  const total = input.lines.reduce((n, l) => n + l.copies, 0);
  if (input.lines.some((l) => !Number.isInteger(l.copies) || l.copies < 1 || l.copies > MAX_COPIES)) throw invalid(`copies are 1 to ${String(MAX_COPIES)} a line`);
  if (total > MAX_LABELS_PER_JOB) throw invalid(`${String(total)} labels is more than one print of ${String(MAX_LABELS_PER_JOB)} — split it`, { total });
  const store = await requireStore(db, input.storeResourceId);
  const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
  const itemRows = new Map((await db.select().from(items).where(inArray(items.id, itemIds))).map((i) => [i.id, i]));
  const racks = new Map((await db.select().from(pharmacyShelfLocations)
    .where(and(eq(pharmacyShelfLocations.storeResourceId, store.id), inArray(pharmacyShelfLocations.itemId, itemIds)))).map((r) => [r.itemId, r.location]));
  const batchIds = input.lines.map((l) => l.batchId).filter((b): b is string => typeof b === "string");
  const batches = new Map((batchIds.length === 0 ? [] : await db.select().from(stockBatches).where(inArray(stockBatches.id, batchIds))).map((b) => [b.id, b]));
  const uoms = await uomsByItems(db, itemIds);
  return input.lines.map((l) => {
    const item = itemRows.get(l.itemId);
    if (item === undefined) throw new PharmacyError("unknown_item", `item ${l.itemId} is not in the item master`, { itemId: l.itemId });
    const rack = racks.get(item.id) ?? null;
    if (input.kind === "rack") {
      if (rack === null) throw invalid(`${item.name} has no rack in ${store.code} — set its rack first`, { itemId: item.id });
      return { copies: l.copies, itemCode: item.code, itemName: item.name, rack, storeCode: store.code, batch: null };
    }
    const b = l.batchId == null ? undefined : batches.get(l.batchId);
    if (b === undefined || b.itemId !== item.id) throw invalid(`pick a batch of ${item.name} for its strip label`, { itemId: item.id });
    if (b.batchNo.includes("|")) throw invalid(`batch ${b.batchNo} cannot go into a label's code`, { itemId: item.id });
    if (b.mrpPaise === null || b.mrpUom === null) throw invalid(`batch ${b.batchNo} of ${item.name} has no MRP on the books — a loose strip is sold at its MRP`, { itemId: item.id });
    const packs = uoms.get(item.id) ?? [];
    const packUom = l.packUom ?? (packs.filter((u) => u.toBaseMultiplier > 1).sort((x, y) => x.toBaseMultiplier - y.toBaseMultiplier)[0]?.uom ?? item.baseUom);
    if (packUom !== item.baseUom && !packs.some((u) => u.uom === packUom)) throw invalid(`${item.name} has no pack called ${packUom}`, { itemId: item.id });
    return { copies: l.copies, itemCode: item.code, itemName: item.name, rack, storeCode: store.code,
      batch: { batchNo: b.batchNo, expiryDate: b.expiryDate, mrpPaise: b.mrpPaise, mrpUom: b.mrpUom, packUom } };
  });
}

/** 50 × 25 mm, one label a page: the height is explicit, which is what Chromium honours (render.ts). */
const LABEL_CSS = `
  @page { size: 50mm 25mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "DejaVu Sans", Arial, sans-serif; color: #000; }
  .lab { width: 50mm; height: 25mm; padding: 1.2mm 1.5mm; display: flex; gap: 1.5mm; overflow: hidden; page-break-after: always; break-after: page; }
  .lab:last-child { page-break-after: auto; break-after: auto; }
  .qr { width: 18mm; height: 18mm; flex: none; align-self: center; }
  .qr svg { width: 18mm; height: 18mm; display: block; }
  .t { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: .4mm; }
  .t > * { flex: none; }
  .rack { font-size: 12pt; font-weight: 700; line-height: 1.05; word-break: break-all; }
  .rack.m { font-size: 9pt; }
  .rack.s { font-size: 7.5pt; }
  .name { font-size: 7pt; font-weight: 700; line-height: 1.15; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; max-height: 2.35em; overflow: hidden; }
  /* A strip's name keeps three lines: the strength is at its end, and it is the fact a loose strip must not lose. */
  .name.l3 { -webkit-line-clamp: 3; max-height: 3.5em; }
  .bn { font-size: 6pt; }
  /* Batch, expiry and MRP wrap rather than truncate: a sticker that hides its expiry is worse than none. */
  .row { font-size: 6.5pt; line-height: 1.2; word-break: break-all; }
  .exp { font-size: 7pt; font-weight: 700; }
  .ref { font-size: 6pt; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mo { font-family: "DejaVu Sans Mono", monospace; }
`;
const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A rack location is 1–24 characters (its CHECK); the longer it is, the smaller it prints, so it never pushes the rest off. */
const rackSize = (rack: string): string => (rack.length <= 8 ? "rack" : rack.length <= 14 ? "rack m" : "rack s");
/** Expiry the way a pack prints it: MM/YYYY. */
const monthYear = (iso: string | null): string => (iso === null ? "—" : `${iso.slice(5, 7)}/${iso.slice(0, 4)}`);

function drawLabel(r: Resolved): string {
  const qr = `<div class="qr">${qrSvg(labelPayload(r.itemCode, r.batch === null ? null : { batchNo: r.batch.batchNo, packUom: r.batch.packUom }), 76)}</div>`;
  const body = r.batch === null
    ? `<div class="${rackSize(r.rack ?? "")}">${esc(r.rack ?? "")}</div><div class="name">${esc(r.itemName)}</div><div class="ref mo">${esc(r.itemCode)} · ${esc(r.storeCode)}</div>`
    : `<div class="name l3">${esc(r.itemName)}</div>
       <div class="row bn">B <span class="mo">${esc(r.batch.batchNo)}</span></div>
       <div class="row exp">EXP ${esc(monthYear(r.batch.expiryDate))}</div>
       <div class="row">MRP ${esc(rupees(r.batch.mrpPaise))}/${esc(r.batch.mrpUom)}</div>`;
  return `<div class="lab">${qr}<div class="t">${body}</div></div>`;
}

function labelsPage(kind: LabelKind, lines: Resolved[]): RenderedDocument {
  const html = lines.flatMap((r) => Array.from({ length: r.copies }, () => drawLabel(r))).join("");
  const count = lines.reduce((n, r) => n + r.copies, 0);
  const title = `${kind === "rack" ? "Rack" : "Strip"} labels · ${lines[0]?.storeCode ?? ""} · ${String(count)}`;
  return {
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${LABEL_CSS}</style></head><body>${html}</body></html>`,
    title,
    page: { widthMm: 50, heightMm: 25 },
  };
}

/** The renderer the pharmacy module registers for both documents. Null when the params are not a label request. */
export async function renderLabelJob(db: Db, document: LabelDocument, params: Record<string, unknown>): Promise<RenderedDocument | null> {
  const kind: LabelKind = document === LABEL_DOCUMENT.rack ? "rack" : "strip";
  if (typeof params.storeResourceId !== "string" || !Array.isArray(params.lines)) return null;
  const lines = await resolveLines(db, { kind, storeResourceId: params.storeResourceId, lines: params.lines as LabelLineInput[] });
  return labelsPage(kind, lines);
}

export type SendLabelsResult =
  | { via: "relay"; job: { id: string; status: string; createdAt: Date } }
  /** No relay is serving the label printer: the screen prints this itself, through the browser. */
  | { via: "browser"; document: RenderedDocument };

/** Check the request against the books, then queue it for the label printer — or hand it to the browser. */
export async function sendLabels(db: Db, actor: Actor, input: LabelRequest, now: Date): Promise<SendLabelsResult> {
  const lines = await resolveLines(db, input);
  if (!(await relayServes(db, "pharmacy_label", now))) return { via: "browser", document: labelsPage(input.kind, lines) };
  const params = { storeResourceId: input.storeResourceId, lines: input.lines.map((l) => ({ itemId: l.itemId, batchId: l.batchId ?? null, packUom: l.packUom ?? null, copies: l.copies })) };
  // A fresh key each time: a second request is a second roll of stickers, on purpose.
  const id = await withTx(db, (tx) => enqueuePrintJob(tx, {
    document: LABEL_DOCUMENT[input.kind], params, dedupeKey: `${LABEL_DOCUMENT[input.kind]}:${newId()}`,
    requestedBy: actor.type === "user" ? actor.id : null,
  }));
  const [row] = await db.select().from(printJobs).where(eq(printJobs.id, id!));
  return { via: "relay", job: { id: row!.id, status: row!.status, createdAt: row!.createdAt } };
}
