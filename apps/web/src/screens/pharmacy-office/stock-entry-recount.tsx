import { useTranslation } from "react-i18next";
import type { WireStockItem } from "../../lib/stock-entry-api";

/**
 * ═══ #1047 — THE RECOUNT'S CONTROL FILE, CHECKED IN THE BROWSER ═══
 *
 * The opening stock goes in by a batch-wise recount. Where the old system (or a register) says how much of each
 * medicine there should be, that list is loaded here as a CSV — `item` (the item code, or its exact name) and
 * `quantity` (base units: tablets, bottles) — and the grid shows, per medicine, what was entered against it and
 * flags every difference. The file NEVER leaves the browser: nothing is sent, nothing is stored; it is a second
 * pair of eyes on the count, and the count is still what the grid captures.
 *
 * Column names accepted (any case): item | item_code | code | name | brand, and quantity | qty | units.
 */
export type ControlRow = { key: string; qty: number };
export type ControlFile = { name: string; rows: ControlRow[]; errors: string[] };

const ITEM_COLS = ["item", "item_code", "code", "name", "brand"];
const QTY_COLS = ["quantity", "qty", "units"];

/** One CSV line → cells; a quoted cell may hold a comma ("Dolo 650, strip"). */
function cellsOf(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === "\"" && line[i + 1] === "\"") { cur += "\""; i += 1; } else if (ch === "\"") quoted = false; else cur += ch;
    } else if (ch === "\"") quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** The control file's text → its rows (the same medicine twice is added up), and every line it could not read. */
export function readControlFile(name: string, text: string): ControlFile {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = cellsOf(lines[0] ?? "").map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const itemAt = header.findIndex((h) => ITEM_COLS.includes(h));
  const qtyAt = header.findIndex((h) => QTY_COLS.includes(h));
  if (itemAt < 0 || qtyAt < 0) return { name, rows: [], errors: ["header"] };
  const sums = new Map<string, ControlRow>();
  const errors: string[] = [];
  lines.slice(1).forEach((line, i) => {
    if (line.trim() === "") return;
    const cells = cellsOf(line);
    const key = cells[itemAt] ?? "";
    const qty = cells[qtyAt] ?? "";
    if (key === "" || !/^\d+$/.test(qty)) { errors.push(String(i + 2)); return; }
    const k = key.toUpperCase();
    const prev = sums.get(k);
    sums.set(k, { key: prev?.key ?? key, qty: (prev?.qty ?? 0) + Number(qty) });
  });
  return { name, rows: [...sums.values()], errors };
}

/** What the grid needs from a row to count it: the picked item and the count cells as typed. */
export type CountedRow = {
  item: WireStockItem | null; packSize: string; packs: string; freePacks: string; boxes: string; perBox: string;
};

const whole = (v: string): number | null => (v.trim() === "" ? 0 : /^\d+$/.test(v.trim()) ? Number(v.trim()) : null);

/** Base units a row puts on the shelf: (boxes × per box + packs + free packs) × pack size; null while a cell is not a whole number. */
export function rowUnits(r: CountedRow): number | null {
  const size = whole(r.packSize), packs = whole(r.packs), free = whole(r.freePacks), boxes = whole(r.boxes), perBox = whole(r.perBox);
  if (size === null || size < 1 || packs === null || free === null || boxes === null || perBox === null) return null;
  return (boxes * perBox + packs + free) * size;
}

export type RecountRow = { key: string; label: string; entered: number; control: number | null; differs: boolean };

/**
 * Per medicine: entered (every grid row of that item, added up) against the control. A control line names its
 * medicine by code or exact name; a medicine on either side only is a difference too.
 */
export function recountRows(rows: readonly CountedRow[], control: readonly ControlRow[]): RecountRow[] {
  const entered = new Map<string, { item: WireStockItem; units: number }>();
  for (const r of rows) {
    if (r.item === null) continue;
    const units = rowUnits(r) ?? 0;
    const cur = entered.get(r.item.itemId);
    entered.set(r.item.itemId, { item: r.item, units: (cur?.units ?? 0) + units });
  }
  const byKey = new Map<string, { item: WireStockItem; units: number }>();
  for (const e of entered.values()) {
    byKey.set(e.item.code.trim().toUpperCase(), e);
    byKey.set(e.item.name.trim().toUpperCase(), e);
  }
  const out: RecountRow[] = [];
  const seen = new Set<string>();
  for (const c of control) {
    const hit = byKey.get(c.key.trim().toUpperCase());
    if (hit !== undefined) {
      if (seen.has(hit.item.itemId)) {
        const row = out.find((o) => o.key === hit.item.code)!;
        row.control = (row.control ?? 0) + c.qty;
        row.differs = row.entered !== row.control;
        continue;
      }
      seen.add(hit.item.itemId);
      out.push({ key: hit.item.code, label: hit.item.name, entered: hit.units, control: c.qty, differs: hit.units !== c.qty });
    } else {
      out.push({ key: c.key, label: c.key, entered: 0, control: c.qty, differs: c.qty !== 0 });
    }
  }
  for (const e of entered.values()) {
    if (!seen.has(e.item.itemId)) out.push({ key: e.item.code, label: e.item.name, entered: e.units, control: null, differs: true });
  }
  return out.sort((a, b) => Number(b.differs) - Number(a.differs) || a.label.localeCompare(b.label));
}

/** The control file's door and, once loaded, the medicine-by-medicine comparison. */
export function RecountPanel({ rows, control, onLoad, onClear }: {
  rows: readonly CountedRow[]; control: ControlFile | null; onLoad: (f: ControlFile) => void; onClear: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const compared = control === null ? [] : recountRows(rows, control.rows);
  const differing = compared.filter((r) => r.differs).length;
  const pick = (file: File | undefined): void => {
    if (file === undefined) return;
    const reader = new FileReader();
    reader.onload = () => onLoad(readControlFile(file.name, typeof reader.result === "string" ? reader.result : ""));
    reader.readAsText(file);
  };
  return (
    <section className="se-recount space-y-2 rounded border p-3" aria-labelledby="se-recount-title" data-testid="se-recount">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="se-recount-title" className="text-sm font-semibold">{t("stockEntry.recount.title")}</h2>
        <input
          type="file" accept=".csv,text/csv" aria-label={t("stockEntry.recount.file")} data-testid="se-recount-file" className="text-xs"
          onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }}
        />
        {control !== null && (
          <button type="button" className="text-xs underline" data-testid="se-recount-clear" onClick={onClear}>{t("stockEntry.recount.clear")}</button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("stockEntry.recount.hint")}</p>
      {control !== null && control.errors.includes("header") && (
        <p role="alert" className="text-sm text-red-700">{t("stockEntry.recount.badHeader")}</p>
      )}
      {control !== null && !control.errors.includes("header") && (
        <>
          <p className="text-sm" role="status" data-testid="se-recount-summary">
            {t("stockEntry.recount.summary", { name: control.name, count: compared.length, differ: differing })}
            {control.errors.length > 0 && <span className="text-amber-800">{" "}{t("stockEntry.recount.skipped", { lines: control.errors.join(", ") })}</span>}
          </p>
          <div className="se-recount-scroll">
          <table className="se-recount-table text-sm">
            <thead>
              <tr>
                <th className="text-left">{t("stockEntry.recount.medicine")}</th>
                <th className="text-right">{t("stockEntry.recount.entered")}</th>
                <th className="text-right">{t("stockEntry.recount.control")}</th>
                <th className="text-right">{t("stockEntry.recount.difference")}</th>
              </tr>
            </thead>
            <tbody>
              {compared.map((r) => (
                <tr key={r.key} data-testid={`se-recount-${r.key}`} data-differs={r.differs ? "true" : "false"} className={r.differs ? "text-red-700" : ""}>
                  <td>{r.label}{r.differs && <span className="sr-only">{` — ${t("stockEntry.recount.differs")}`}</span>}</td>
                  <td className="text-right">{r.entered}</td>
                  <td className="text-right">{r.control ?? "—"}</td>
                  <td className="text-right">{r.control === null ? t("stockEntry.recount.notInControl") : r.differs ? String(r.entered - r.control) : "✓"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </section>
  );
}
