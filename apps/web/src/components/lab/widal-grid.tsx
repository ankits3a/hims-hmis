import { useTranslation } from "react-i18next";
import { parseTitre, WIDAL_DILUTIONS } from "../../../../../packages/contracts/src/lab-titre";

/**
 * #1036 (owner 2026-11-06) — THE WIDAL TITRE GRID, for the manual slide test: each antigen against 1:20 … 1:320,
 * the way the lab's old software laid it out (1:640 is left out: "we hardly use 1:640").
 *
 * The technologist ticks each dilution that shows agglutination; the HIGHEST ticked dilution is the antigen's
 * titre, and no tick is "Negative". The grid keeps no state of its own: agglutination is monotonic, so the titre
 * IS the grid — a saved report reopens with every dilution up to its titre ticked. Ticking a dilution sets the
 * titre there; unticking one sets it to the dilution below (or Negative). The titre box above stays typeable.
 */
export type WidalGridRow = { code: string; nameEn: string; value: string };

export function WidalGrid({ rows, onChange }: {
  rows: readonly WidalGridRow[];
  onChange: (code: string, value: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const toggle = (row: WidalGridRow, dilution: number, ticked: boolean): void => {
    if (!ticked) { onChange(row.code, `1:${dilution}`); return; }
    const below = WIDAL_DILUTIONS.filter((d) => d < dilution);
    onChange(row.code, below.length === 0 ? "Negative" : `1:${below[below.length - 1]!}`);
  };
  return (
    <section className="rounded border p-3" aria-label={t("lab.quick.widalGrid")} data-testid="widal-grid">
      <h3 className="mb-1 text-sm font-semibold">{t("lab.quick.widalGrid")}</h3>
      <p className="mb-2 text-xs text-muted-foreground">{t("lab.quick.widalGridHint")}</p>
      <div className="overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="py-1 pr-3 text-left font-normal">{t("lab.quick.colParameter")}</th>
              {WIDAL_DILUTIONS.map((d) => <th key={d} className="px-2 py-1 font-normal tabular-nums">1:{d}</th>)}
              <th className="px-2 py-1 text-left font-normal">{t("lab.quick.colResult")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const parsed = parseTitre(row.value);
              const titre = parsed.ok ? parsed.dilution : 0;
              return (
                <tr key={row.code} className="border-t">
                  <td className="py-1 pr-3">{row.nameEn}</td>
                  {WIDAL_DILUTIONS.map((d) => {
                    const ticked = d <= titre;
                    return (
                      <td key={d} className="px-2 py-1 text-center">
                        <input type="checkbox" className="h-5 w-5" aria-label={`${row.nameEn} 1:${d}`} checked={ticked}
                          onChange={() => toggle(row, d, ticked)} />
                      </td>
                    );
                  })}
                  <td className="px-2 py-1 font-medium tabular-nums">{row.value === "" ? "—" : row.value}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
