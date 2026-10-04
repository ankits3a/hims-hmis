import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { api } from "../../lib/api";
import { materialsErrorText } from "../../lib/materials-api";
import { PRICE_FIELDS, guessColumns, parseDelimited, readXlsx } from "../../lib/sheet-read";
import type { Grid, PriceField } from "../../lib/sheet-read";
import { OfficeHead, fieldCls } from "./office-page";

/**
 * ═══ IMPORT A VENDOR'S PRICE LIST (owner 2026-10-04) ═══
 *
 * 1. Choose the vendor's file (CSV or Excel), or paste rows copied from Excel.
 * 2. Say which column is which (guessed from the headings).
 * 3. Match: each row against the national catalogue — the best brand, other candidates, and whether the
 *    item master already has it. Nothing is written yet.
 * 4. Review: pick another match, fix the pack, GST, HSN and MRP, untick what you will not stock.
 * 5. Create the ticked rows as items (`createStockDrug`, the + New drug call) and read what became of each.
 */
const PACK_TYPES = ["tablet_strip", "capsule_strip", "bottle", "vial", "ampoule", "tube", "pouch", "sachet", "box", "other"] as const;
type PackType = (typeof PACK_TYPES)[number];
type Candidate = { medicineId: string; name: string; form: string; strength: string | null; salts: string[]; schedule: string | null; score: number };
type Matched = {
  line: number; brand: string; manufacturer: string; composition: string; pack: string;
  best: Candidate | null; alternatives: Candidate[]; existing: { itemId: string; code: string; name: string } | null;
  packType: PackType; packSize: number; gstRateBps: number; hsnCode: string; mrpPerPackPaise: number | null;
};
type Draft = Matched & { pick: string; on: boolean; mrp: string; cold: boolean };
type Result = { line: number; ok: true; itemId: string; code: string; name: string } | { line: number; ok: false; code: string; message: string };

const toRupees = (p: number | null): string => (p === null ? "" : (p / 100).toFixed(2));
const toPaise = (s: string): number | null => { const n = Number(s.replace(/,/g, "")); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null; };

export function PriceListImport(): React.ReactElement {
  const { t } = useTranslation();
  const P = (k: string, o?: Record<string, unknown>): string => t(`pharmacyOffice.priceList.${k}`, o);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [cols, setCols] = useState<Partial<Record<PriceField, number>>>({});
  const [paste, setPaste] = useState("");
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = (g: Grid): void => {
    if (g.length < 2) { setError(P("tooShort")); return; }
    setGrid(g); setCols(guessColumns(g[0]!)); setRows(null); setResults(null); setError(null);
  };
  const onFile = async (f: File | undefined): Promise<void> => {
    if (f === undefined) return;
    try {
      take(/\.xlsx$/i.test(f.name) ? await readXlsx(new Uint8Array(await f.arrayBuffer())) : parseDelimited(await f.text()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const match = async (): Promise<void> => {
    if (grid === null || cols.brand === undefined) return;
    setBusy(true); setError(null);
    try {
      const cell = (r: string[], f: PriceField): string | undefined => (cols[f] === undefined ? undefined : r[cols[f]!] ?? "");
      const body = grid.slice(1).map((r) => ({
        brand: cell(r, "brand") ?? "", manufacturer: cell(r, "manufacturer"), composition: cell(r, "composition"),
        pack: cell(r, "pack"), mrp: cell(r, "mrp"), gst: cell(r, "gst"), hsn: cell(r, "hsn"),
      })).filter((r) => r.brand.trim() !== "");
      const res = await api<{ rows: Matched[] }>("POST", "/pharmacy/opening-stock/price-list/match", { rows: body });
      setRows(res.rows.map((m) => ({ ...m, pick: m.best?.medicineId ?? "", on: m.best !== null && m.existing === null && m.mrpPerPackPaise !== null, mrp: toRupees(m.mrpPerPackPaise), cold: false })));
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const set = (line: number, patch: Partial<Draft>): void => setRows((rs) => (rs ?? []).map((r) => (r.line === line ? { ...r, ...patch } : r)));
  const ready = (r: Draft): boolean => r.pick !== "" && toPaise(r.mrp) !== null && /^\d{4,8}$/.test(r.hsnCode);
  const chosen = (rows ?? []).filter((r) => r.on && r.existing === null);
  const blocked = chosen.filter((r) => !ready(r));

  const create = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const res = await api<{ results: Result[] }>("POST", "/pharmacy/opening-stock/price-list/import", { rows: chosen.map((r) => ({
        line: r.line, medicineId: r.pick, brand: r.brand, packType: r.packType, packSize: r.packSize, gstRateBps: r.gstRateBps,
        hsnCode: r.hsnCode, mrpPerPackPaise: toPaise(r.mrp)!, storage: r.cold ? "cold_2_8" : "ambient",
      })) });
      setResults(res.results);
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const resultOf = (line: number): Result | undefined => results?.find((x) => x.line === line);
  return (
    <div className="space-y-4" data-testid="price-list">
      <OfficeHead title={P("title")} lead={P("lead")} />
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <section className="rounded border p-3 space-y-2">
        <h3 className="text-sm font-semibold">{P("step1")}</h3>
        <input type="file" accept=".csv,.xlsx,.txt" data-testid="price-file" onChange={(e) => void onFile(e.target.files?.[0])} />
        <p className="m-0 text-xs text-muted-foreground">{P("orPaste")}</p>
        <textarea className={`${fieldCls} w-full`} rows={4} data-testid="price-paste" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={P("pastePlaceholder")} />
        <Button type="button" variant="outline" data-testid="price-paste-read" disabled={paste.trim() === ""} onClick={() => take(parseDelimited(paste))}>{P("readPaste")}</Button>
        <p className="m-0 text-xs text-muted-foreground">{P("pdfNote")}</p>
      </section>

      {grid !== null && (
        <section className="rounded border p-3 space-y-2" data-testid="price-columns">
          <h3 className="text-sm font-semibold">{P("step2", { count: grid.length - 1 })}</h3>
          <div className="flex flex-wrap gap-3">
            {PRICE_FIELDS.map((f) => (
              <label key={f} className="flex flex-col gap-1 text-xs">{P(`field.${f}`)}
                <select className={fieldCls} data-testid={`price-col-${f}`} value={cols[f] ?? ""} onChange={(e) => setCols({ ...cols, [f]: e.target.value === "" ? undefined : Number(e.target.value) })}>
                  <option value="">{P("noColumn")}</option>
                  {grid[0]!.map((h, i) => <option key={`${h}-${String(i)}`} value={i}>{h === "" ? P("column", { n: i + 1 }) : h}</option>)}
                </select>
              </label>
            ))}
          </div>
          <Button type="button" data-testid="price-match" disabled={busy || cols.brand === undefined} onClick={() => void match()}>{busy ? P("working") : P("match")}</Button>
        </section>
      )}

      {rows !== null && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{P("step3")}</h3>
          <p className="m-0 text-sm" data-testid="price-summary">
            {P("summary", { total: rows.length, matched: rows.filter((r) => r.best !== null).length, existing: rows.filter((r) => r.existing !== null).length, chosen: chosen.length })}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs [&_td]:px-1.5 [&_td]:py-1 [&_th]:px-1.5 [&_th]:text-left" data-testid="price-rows">
              <thead><tr className="text-muted-foreground">
                <th>✓</th><th>{P("col.vendor")}</th><th>{P("col.match")}</th><th>{P("col.pack")}</th><th>GST</th><th>HSN</th><th>{P("col.mrp")}</th><th>{P("col.cold")}</th><th>{P("col.result")}</th>
              </tr></thead>
              <tbody>{rows.map((r) => {
                const cands = [...(r.best === null ? [] : [r.best]), ...r.alternatives];
                const res = resultOf(r.line);
                return (
                  <tr key={r.line} className="border-t align-top" data-testid={`price-row-${String(r.line)}`}>
                    <td><input type="checkbox" aria-label={P("include", { brand: r.brand })} checked={r.on && r.existing === null} disabled={r.existing !== null || results !== null} onChange={(e) => set(r.line, { on: e.target.checked })} /></td>
                    <td><b>{r.brand}</b><div className="text-muted-foreground">{[r.manufacturer, r.composition, r.pack].filter((x) => x !== "").join(" · ")}</div></td>
                    <td>
                      {r.existing !== null ? <span className="pill on" data-testid={`price-existing-${String(r.line)}`}>{P("already", { code: r.existing.code })}</span> : (
                        <select className={fieldCls} value={r.pick} data-testid={`price-pick-${String(r.line)}`} onChange={(e) => set(r.line, { pick: e.target.value })}>
                          <option value="">{cands.length === 0 ? P("noMatch") : P("pickNone")}</option>
                          {cands.map((c) => <option key={c.medicineId} value={c.medicineId}>{`${c.name}${c.strength === null ? "" : ` · ${c.strength}`} · ${c.salts.join(" + ")}${c.schedule === null ? "" : ` · Sch ${c.schedule}`}`}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      <select className={fieldCls} value={r.packType} onChange={(e) => set(r.line, { packType: e.target.value as PackType })}>
                        {PACK_TYPES.map((p) => <option key={p} value={p}>{P(`packType.${p}`)}</option>)}
                      </select>
                      <input className={`${fieldCls} w-14`} inputMode="numeric" aria-label={P("packSize", { brand: r.brand })} value={String(r.packSize)}
                        onChange={(e) => set(r.line, { packSize: Math.max(1, Math.min(1000, Number(e.target.value.replace(/\D/g, "")) || 1)) })} />
                    </td>
                    <td>
                      <select className={fieldCls} value={r.gstRateBps} onChange={(e) => set(r.line, { gstRateBps: Number(e.target.value) })}>
                        {[0, 500, 1800].map((g) => <option key={g} value={g}>{g / 100}%</option>)}
                      </select>
                    </td>
                    <td><input className={`${fieldCls} w-20`} value={r.hsnCode} aria-label={P("hsn", { brand: r.brand })} onChange={(e) => set(r.line, { hsnCode: e.target.value.replace(/\D/g, "").slice(0, 8) })} /></td>
                    <td><input className={`${fieldCls} w-20 ${r.on && r.existing === null && toPaise(r.mrp) === null ? "border-red-500" : ""}`} inputMode="decimal" aria-label={P("mrp", { brand: r.brand })} data-testid={`price-mrp-${String(r.line)}`} value={r.mrp} onChange={(e) => set(r.line, { mrp: e.target.value })} /></td>
                    <td><input type="checkbox" aria-label={P("cold", { brand: r.brand })} checked={r.cold} onChange={(e) => set(r.line, { cold: e.target.checked })} /></td>
                    <td data-testid={`price-result-${String(r.line)}`}>
                      {res === undefined ? null : res.ok ? <span className="text-green-700">{P("made", { code: res.code })}</span> : <span className="text-red-600">{res.message}</span>}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          {blocked.length > 0 && <p className="m-0 text-xs text-red-600" data-testid="price-blocked">{P("blocked", { count: blocked.length })}</p>}
          {results === null ? (
            <Button type="button" data-testid="price-create" disabled={busy || chosen.length === 0 || blocked.length > 0} onClick={() => void create()}>
              {busy ? P("working") : P("create", { count: chosen.length })}
            </Button>
          ) : (
            <p className="m-0 text-sm font-medium" data-testid="price-done">{P("done", { made: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length })}</p>
          )}
        </section>
      )}
    </div>
  );
}
