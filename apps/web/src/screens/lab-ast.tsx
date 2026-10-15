import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AST_PANELS, antibioticsFor, astName, fillPanel,
} from "../../../../packages/contracts/src/lab-ast";
import type { AstBlock, AstDraftRow, AstPanelId, AstRow } from "../../../../packages/contracts/src/lab-ast";

/**
 * OWNER 2026-10-12 — THE ANTIBIOTIC SENSITIVITY TABLE of a culture (spec
 * `SPEC-lab-ast-table-2026-10-12.md`): the Quick Bench's editor and the on-screen preview (the
 * printed table is `packages/contracts/src/lab-report-html.ts`'s). The panels, names and row rules are `packages/contracts/src/lab-ast.ts`, shared with
 * the server and the phone.
 */

const SEG = ["S", "I", "R"] as const;

export function AstEditor({ testCode, testName, rows, onChange }: {
  testCode: string; testName: string; rows: AstDraftRow[]; onChange: (rows: AstDraftRow[]) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const qq = q.trim().toLowerCase();
  const offered = useMemo(() => {
    if (qq === "") return [];
    const have = new Set(rows.map((r) => r.antibiotic.toLowerCase()));
    return antibioticsFor(testCode)
      .filter((c) => !have.has(c.toLowerCase()) && (c.toLowerCase().includes(qq) || astName(c).toLowerCase().includes(qq)))
      .slice(0, 8);
  }, [qq, rows, testCode]);

  function add(antibiotic: string): void {
    const name = antibiotic.trim().slice(0, 60);
    if (name === "" || rows.some((r) => r.antibiotic.toLowerCase() === name.toLowerCase())) { setQ(""); return; }
    onChange([...rows, { antibiotic: name, result: "", mic: null }]);
    setQ("");
  }
  const set = (i: number, patch: Partial<AstDraftRow>): void => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <section className="rounded border p-3" aria-label={`${t("lab.ast.title")} — ${testName}`} data-testid={`ast-${testCode}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("lab.ast.title")} <span className="font-normal text-muted-foreground">· {testName}</span></h3>
        <select aria-label={t("lab.ast.panel")} value="" className="rounded border bg-background px-2 py-1 text-sm"
          onChange={(e) => { if (e.target.value !== "") onChange(fillPanel(rows, e.target.value as AstPanelId, testCode)); }}>
          <option value="">{t("lab.ast.pickPanel")}</option>
          {AST_PANELS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      {rows.length === 0 && <p className="mb-2 text-sm text-muted-foreground">{t("lab.ast.empty")}</p>}
      <ul className="divide-y">
        {rows.map((r, i) => (
          <li key={r.antibiotic} className="flex flex-wrap items-center gap-2 py-1" data-testid={`ast-row-${r.antibiotic}`}>
            <span className="min-w-0 flex-1 text-sm">
              {astName(r.antibiotic)}
              {astName(r.antibiotic) !== r.antibiotic && <span className="ml-1 text-xs text-muted-foreground">{r.antibiotic}</span>}
            </span>
            <span role="group" aria-label={astName(r.antibiotic)} className="inline-flex overflow-hidden rounded border">
              {SEG.map((x) => (
                <button key={x} type="button" aria-pressed={r.result === x} title={t(`lab.ast.${x}`)}
                  aria-label={`${astName(r.antibiotic)} ${t(`lab.ast.${x}`)}`}
                  onClick={() => set(i, { result: r.result === x ? "" : x })}
                  className={`w-9 py-1 text-sm font-semibold ${r.result === x ? (x === "R" ? "bg-red-700 text-white" : x === "I" ? "bg-amber-600 text-white" : "bg-green-700 text-white") : "bg-background hover:bg-muted"}`}>
                  {x}
                </button>
              ))}
            </span>
            <input aria-label={`${astName(r.antibiotic)} ${t("lab.ast.mic")}`} placeholder={t("lab.ast.mic")} inputMode="decimal"
              value={r.mic ?? ""} onChange={(e) => set(i, { mic: e.target.value === "" ? null : e.target.value })}
              className="w-20 rounded border bg-background px-2 py-1 text-sm" />
            <button type="button" aria-label={t("lab.ast.remove", { name: astName(r.antibiotic) })}
              onClick={() => onChange(rows.filter((_, j) => j !== i))} className="px-1 text-muted-foreground hover:text-foreground">×</button>
          </li>
        ))}
      </ul>
      <div className="relative mt-2">
        <input aria-label={t("lab.ast.add")} value={q} placeholder={`${t("lab.ast.add")} — ${t("lab.ast.addHint")}`} autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(offered[0] ?? q); } }}
          className="w-full rounded border bg-background px-3 py-1.5 text-sm" />
        {qq !== "" && (
          <div className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded border bg-background shadow">
            {offered.map((c) => (
              <button key={c} type="button" onClick={() => add(c)} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted">
                {astName(c)}<span className="ml-2 text-xs text-muted-foreground">{c}</span>
              </button>
            ))}
            <button type="button" onClick={() => add(q)} className="block w-full px-3 py-1.5 text-left text-sm italic hover:bg-muted">
              {t("lab.ast.addFree", { name: q.trim() })}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** The preview's table (Quick Reports, the profile, the lab's saved reports). */
export function AstPreview({ block, title }: { block: AstBlock; title: string }): React.ReactElement {
  const { t } = useTranslation();
  const withMic = block.rows.some((r) => r.mic !== null);
  return (
    <div data-testid={`ast-preview-${block.serviceId}`}>
      <div className="tag" style={{ marginBottom: 6 }}>{t("lab.ast.title")} · {title}</div>
      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ color: "var(--dim)", textAlign: "left", fontSize: 11.5 }}>
            <th style={{ padding: "3px 4px" }}>{t("lab.ast.antibiotic")}</th>
            <th style={{ padding: "3px 4px" }}>{t("lab.ast.result")}</th>
            {withMic && <th style={{ padding: "3px 4px" }}>{t("lab.ast.micUnit")}</th>}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((r: AstRow) => (
            <tr key={r.antibiotic} style={{ borderTop: "1px solid var(--line)", fontWeight: r.result === "R" ? 700 : undefined, color: r.result === "R" ? "var(--red)" : undefined }}>
              <td style={{ padding: "4px" }}>{astName(r.antibiotic)}</td>
              <td style={{ padding: "4px" }}>{t(`lab.ast.${r.result}`)} ({r.result})</td>
              {withMic && <td className="mo" style={{ padding: "4px" }}>{r.mic ?? ""}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* The PRINTED table (`astPrintHtml`) lives with the printed report's template, `packages/contracts/src/lab-report-html.ts`, shared with the phone. */
