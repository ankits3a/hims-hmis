import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { api } from "../../lib/api";
import { materialsErrorText } from "../../lib/materials-api";
import { PRICE_FIELDS, findHeaderRow, guessColumns, parseDelimited, readXlsx, sampleCsv } from "../../lib/sheet-read";
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

  const [skipped, setSkipped] = useState(0);
  const take = (raw: Grid): void => {
    // A title or address above the headings is skipped: the heading row is found, not assumed.
    const h = findHeaderRow(raw);
    const g = raw.slice(h);
    if (g.length < 2) { setError(P("tooShort")); return; }
    setSkipped(h); setGrid(g); setCols(guessColumns(g[0]!)); setRows(null); setResults(null); setError(null);
  };
  const downloadSample = (): void => {
    const url = URL.createObjectURL(new Blob(["\uFEFF" + sampleCsv()], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = "price-list-sample.csv";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
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

      {/* Owner 2026-10-04 — the directions live on this screen, with a sample file to fill in. */}
      <section className="rounded border bg-muted/30 p-3 text-sm space-y-2" data-testid="price-howto">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="m-0 text-sm font-semibold">{P("howTitle")}</h3>
          <Button type="button" variant="outline" size="sm" data-testid="price-sample" onClick={downloadSample}>{P("sample")}</Button>
        </div>
        <ol className="m-0 list-decimal space-y-1 pl-5">
          {(["how1", "how2", "how3", "how4", "how5"] as const).map((k) => <li key={k}>{P(k)}</li>)}
        </ol>
        <table className="w-full text-xs [&_td]:px-1.5 [&_td]:py-0.5 [&_th]:px-1.5 [&_th]:text-left">
          <thead><tr className="text-muted-foreground"><th>{P("colHeading")}</th><th>{P("colNeeded")}</th><th>{P("colExample")}</th><th>{P("colIfMissing")}</th></tr></thead>
          <tbody>{PRICE_FIELDS.map((f) => (
            <tr key={f} className="border-t">
              <td className="font-medium">{P(`field.${f}`)}</td>
              <td>{f === "brand" ? P("needed") : f === "mrp" || f === "pack" ? P("recommended") : P("optional")}</td>
              <td className="font-mono">{P(`example.${f}`)}</td>
              <td className="text-muted-foreground">{P(`ifMissing.${f}`)}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>

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
          <ul className="m-0 space-y-0.5 pl-0 text-xs" data-testid="price-column-check">
            {skipped > 0 && <li className="list-none text-muted-foreground">{P("skipped", { count: skipped })}</li>}
            {PRICE_FIELDS.map((f) => {
              const found = cols[f] !== undefined;
              return (
                <li key={f} className={`list-none ${found ? "text-green-700" : f === "brand" ? "text-red-600 font-medium" : "text-amber-700"}`} data-testid={`price-check-col-${f}`}>
                  {found ? `✓ ${P(`field.${f}`)} ← “${grid[0]![cols[f]!] ?? ""}”` : `${f === "brand" ? "✗" : "!"} ${P(`field.${f}`)}: ${P(`ifMissing.${f}`)}`}
                </li>
              );
            })}
          </ul>
          <Button type="button" data-testid="price-match" disabled={busy || cols.brand === undefined} onClick={() => void match()}>{busy ? P("matching", { count: grid.length - 1, seconds: Math.max(5, Math.ceil((grid.length - 1) * 0.3)) }) : P("match")}</Button>
        </section>
      )}

      {rows !== null && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{P("step3")}</h3>
          <ul className="m-0 space-y-0.5 pl-5 text-xs list-disc" data-testid="price-guidance">
            {rows.some((r) => r.best === null && r.existing === null) && <li>{P("guideNoMatch", { count: rows.filter((r) => r.best === null && r.existing === null).length })}</li>}
            {rows.some((r) => r.existing === null && r.best !== null && r.best.score < 85) && <li>{P("guideCheck", { count: rows.filter((r) => r.existing === null && r.best !== null && r.best.score < 85).length })}</li>}
            {rows.some((r) => r.existing === null && r.best !== null && toPaise(r.mrp) === null) && <li>{P("guideMrp", { count: rows.filter((r) => r.existing === null && r.best !== null && toPaise(r.mrp) === null).length })}</li>}
            {rows.some((r) => r.existing !== null) && <li>{P("guideExisting", { count: rows.filter((r) => r.existing !== null).length })}</li>}
            <li>{P("guidePack")}</li>
          </ul>
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
                          {cands.map((c) => <option key={c.medicineId} value={c.medicineId}>{[c.name, c.salts.join(" + "), c.schedule === null ? "" : `Sch ${c.schedule}`].filter((x) => x !== "").join(" · ")}</option>)}
                        </select>
                      )}
                      {/* A match the score is unsure of is said so, so the reviewer reads it first. */}
                      {r.existing === null && r.pick !== "" && (cands.find((c) => c.medicineId === r.pick)?.score ?? 0) < 85
                        ? <span className="pill gd" data-testid={`price-check-${String(r.line)}`}>{P("check")}</span> : null}
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
