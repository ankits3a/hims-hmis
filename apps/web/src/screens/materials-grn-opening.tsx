import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { captureOpeningStock, checkOpeningStock } from "../lib/materials-api";
import { pharmacyErrorText } from "../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
import type { WireOpeningCapture, WireOpeningCheck } from "../lib/materials-api";

/**
 * GAP CLOSURE A1 (2026-09-28) — **THE OPENING-STOCK SHEET, FROM A SCREEN.**
 *
 * The owner's audit found the real shelf could only be loaded by an engineer running
 * `scripts/import-opening-stock.ts`. This is the same planner behind a file picker:
 *
 *   pick the CSV → **Check** (every row judged, nothing written) → **Capture** (one GRN per supplier).
 *
 * ═══ CAPTURE IS NOT RECEIVE ═══
 *
 * The captured GRNs appear in the list below at "awaiting QC". The pharmacist opens each one, runs QC
 * and posts it — the same two-person gate as any delivery. Nothing is on the shelf until then, and the
 * result says so in as many words.
 *
 * Capture stays disabled while any row is refused (the sheet is received whole or not at all) or while
 * the sheet needs a pack size or the OPENING STOCK vendor that the uploader may not create. The server
 * judges the sheet again on Capture; this screen's Check is advice, never authority.
 */
const TEMPLATE = [
  "brand,batch,expiry,mrp_per_pack,pack_size,packs,rack,supplier_name,purchase_rate_per_pack",
  "Dolo 650,DOBS4521,08/2027,33.60,15,12,A1,,24.00",
].join("\n");

export function OpeningStockSheet({ onOpenGrn }: { onOpenGrn: (grnId: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [content, setContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [check, setCheck] = useState<WireOpeningCheck | null>(null);
  const [result, setResult] = useState<WireOpeningCapture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (file: File | undefined): void => {
    setCheck(null); setResult(null); setError(null);
    if (file === undefined) { setContent(null); setFileName(""); return; }
    setFileName(file.name);
    // FileReader, not `file.text()`: the GSTR-2B upload's precedent, and what jsdom implements.
    const reader = new FileReader();
    reader.onload = () => { setContent(typeof reader.result === "string" ? reader.result : null); };
    reader.readAsText(file);
  };

  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(pharmacyErrorText(e, t)); } finally { setBusy(false); }
  };

  const lacking = check?.authority.filter((a) => !a.held && a.why !== "racks") ?? [];
  const racksLeft = check?.authority.some((a) => a.why === "racks" && !a.held) === true;
  const canCapture = check !== null && check.refusals === 0 && lacking.length === 0 && check.grns.some((g) => g.state === "new");

  return (
    <section className="space-y-3 rounded border p-4" aria-labelledby="opening-stock-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="opening-stock-title" className="font-medium">{t("materialsGrn.opening.title")}</h2>
        <a
          className="text-sm underline"
          download="opening-stock-template.csv"
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`}
        >
          {t("materialsGrn.opening.template")}
        </a>
      </div>
      <p className="text-sm text-muted-foreground">{t("materialsGrn.opening.explain")}</p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex flex-col gap-1 text-sm">
          {t("materialsGrn.opening.file")}
          <input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        <Button
          variant="secondary" disabled={content === null || busy}
          onClick={() => void act(async () => { setResult(null); setCheck(await checkOpeningStock(content!)); })}
        >
          {t("materialsGrn.opening.check")}
        </Button>
        <Button
          disabled={!canCapture || busy}
          onClick={() => void act(async () => {
            const done = await captureOpeningStock(content!);
            setResult(done);
            setCheck(await checkOpeningStock(content!));
            await qc.invalidateQueries({ queryKey: ["materials"] });
          })}
        >
          {t("materialsGrn.opening.capture")}
        </Button>
      </div>

      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {check !== null && (
        <div className="space-y-2 text-sm">
          <p role="status">
            {t("materialsGrn.opening.summary", {
              file: fileName, rows: check.rows.length, refused: check.refusals, units: check.units,
            })}
          </p>
          {check.refusals > 0 && <p className="text-red-600">{t("materialsGrn.opening.refusedWhole")}</p>}
          {lacking.map((a) => (
            <p key={a.why} className="text-red-600">{t(`materialsGrn.opening.needs_${a.why}`, { permission: a.permission })}</p>
          ))}
          {racksLeft && <p className="text-amber-700">{t("materialsGrn.opening.racksLeft", { count: check.racks })}</p>}
          {check.zeroCost > 0 && <p className="text-amber-700">{t("materialsGrn.opening.zeroCost", { count: check.zeroCost })}</p>}
          {check.grns.filter((g) => g.state !== "new").map((g) => (
            <p key={g.challanNo}>{t(`materialsGrn.opening.state_${g.state}`, { challan: g.challanNo, grnNo: g.grnNo ?? "" })}</p>
          ))}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-xs [&_td]:px-1 [&_td]:py-0.5 [&_th]:px-1">
              <thead>
                <tr className="text-left">
                  <th>{t("materialsGrn.opening.line")}</th>
                  <th>{t("materialsGrn.item")}</th>
                  <th>{t("materialsGrn.batchNo")}</th>
                  <th>{t("materialsGrn.expiry")}</th>
                  <th>{t("materialsGrn.opening.packs")}</th>
                  <th>{t("materialsGrn.verdict")}</th>
                </tr>
              </thead>
              <tbody>
                {check.rows.map((r) => (
                  <tr key={r.line} className="border-t align-top">
                    <td>{r.line}</td>
                    <td>{r.itemName ?? r.brand}</td>
                    <td>{r.batch}</td>
                    <td>{r.expiryDate}</td>
                    <td>{r.packs} × {r.packSize}{r.newUom ? ` · ${t("materialsGrn.opening.newPack")}` : ""}</td>
                    <td>
                      {r.reasons.length > 0
                        ? <span className="text-red-600">{r.reasons.join(" · ")}</span>
                        : r.near
                          ? <span className="text-amber-700">{t("materialsGrn.rule_near_expiry")}</span>
                          : <span className="text-green-700">{t("materialsGrn.opening.ok")}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result !== null && (
        <div role="status" className="space-y-1 text-sm">
          <p className="font-medium">
            {t("materialsGrn.opening.captured", { count: result.captured.length })}
          </p>
          <ul>
            {result.captured.map((g) => (
              <li key={g.grnId}>
                <button className="underline" onClick={() => onOpenGrn(g.grnId)}>{g.grnNo}</button>
                {" · "}{t(g.near ? "materialsGrn.opening.capturedNear" : "materialsGrn.opening.capturedLine", { lines: g.lines })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
