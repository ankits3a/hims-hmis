import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useDebounced } from "../../lib/format";
import { fetchPlacements, pharmacyErrorText } from "../../lib/pharmacy-api";
import { searchSeed, sigOf } from "./work";
import type { WireDispenseLine, WireRetailShelfEntry } from "../../lib/pharmacy-api";

/**
 * ═══ PD-5b — CHOOSE WHAT THE DOCTOR'S WORDS ARE (PD-D4) ═══
 *
 * The doctor typed words the catalogue could not place as one product. The pharmacist reads them as
 * a medicine on THIS counter's shelf — the server's search, which never offers Schedule X.
 *
 * NOT A SUBSTITUTION, SO NO CONSENT TICK. Nothing the doctor named is replaced; the sheet says so,
 * rather than asking a question whose answer the server does not record. NOT A LIGHTER GATE either:
 * `verify` judges the chosen medicine as it judges a prescribed one, and the allergy and interaction
 * books re-run on it there — a clash stops it on the line, and the sheet does not claim "clean".
 */
export type Resolution = { medicineId: string; brandName: string; available: number; baseUom: string };

const DEBOUNCE_MS = 250;

export function ResolveSheet({
  dispenseId, line, onChoose, onClose,
}: {
  dispenseId: string;
  line: WireDispenseLine;
  onChoose: (res: Resolution) => void;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState(() => searchSeed(line.rxLine.drug));
  const [chosen, setChosen] = useState<WireRetailShelfEntry | null>(null);
  const typed = useDebounced(q.trim(), DEBOUNCE_MS);
  const shelf = useQuery({
    queryKey: ["pharmacy", "placements", dispenseId, line.lineIdx, typed],
    queryFn: () => fetchPlacements(dispenseId, line.lineIdx, typed),
    enabled: typed !== "",
    retry: false,
  });

  /* A new search is a new list: a choice from the last one must not ride along unseen. */
  useEffect(() => { setChosen(null); }, [typed]);

  /* Esc closes THIS sheet and nothing else: captured before the desk's own Esc would clear the desk. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const note = { margin: 0, padding: "14px 18px", fontSize: 12.5 } as const;
  return (
    <div className="ovl" role="dialog" aria-modal="true" aria-label={t("pharmacyDesk.res.title", { drug: line.rxLine.drug })} onClick={onClose}>
      <div className="box" style={{ width: 640, maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 70px rgba(19,36,32,.35)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: "15px 18px", borderBottom: "1px solid var(--line2)" }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t("pharmacyDesk.res.title", { drug: line.rxLine.drug })}</h2>
          <p className="mo" style={{ margin: "3px 0 0 0", fontSize: 11.5, color: "var(--dim)" }}>{sigOf(line.rxLine)}</p>
          <p style={{ margin: "6px 0 0 0", fontSize: 12, color: "var(--dim)" }}>{t("pharmacyDesk.res.rule")}</p>
          {line.rxLine.noSubstitution ? (
            <p role="status" style={{ margin: "6px 0 0 0", fontSize: 12, color: "var(--gold)" }}>{t("pharmacyDesk.res.noSubstitution")}</p>
          ) : null}
          <label className="tag" htmlFor="resolve-q" style={{ display: "block", marginTop: 11 }}>{t("pharmacyDesk.res.search")}</label>
          <input
            id="resolve-q"
            className="in"
            autoFocus
            style={{ height: 34, marginTop: 4, fontSize: 13 }}
            value={q}
            placeholder={t("pharmacyDesk.res.placeholder")}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div style={{ overflowY: "auto" }} data-testid="res-list">
          {typed === "" ? (
            <p style={{ ...note, color: "var(--dim)" }}>{t("pharmacyDesk.res.prompt")}</p>
          ) : shelf.isPending ? (
            <p style={{ ...note, color: "var(--dim)" }}>{t("pharmacyDesk.res.loading")}</p>
          ) : shelf.error !== null ? (
            <p role="alert" style={{ ...note, color: "var(--red)" }}>{pharmacyErrorText(shelf.error, t)}</p>
          ) : shelf.data.length === 0 ? (
            <p role="status" style={{ ...note, color: "var(--dim)" }}>{t("pharmacyDesk.res.none", { q: typed })}</p>
          ) : (
            shelf.data.map((e) => (
              <label key={e.medicineId} className="drow" style={{ padding: "11px 18px", cursor: e.available > 0 ? "pointer" : "not-allowed", opacity: e.available > 0 ? 1 : 0.5 }}>
                <input
                  type="radio"
                  name="res"
                  disabled={e.available === 0}
                  checked={chosen?.medicineId === e.medicineId}
                  onChange={() => setChosen(e)}
                  style={{ accentColor: "#0e6b4e" }}
                />
                <span style={{ flexGrow: 1, minWidth: 0 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{e.brandName}</span>
                    {e.scheduleFlag === "H1" ? <span className="pill rd">H1</span> : null}
                  </span>
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--dim)" }}>
                    {[e.strengthLabel, e.form, e.itemCode].filter((x) => x !== null && x !== "").join(" · ")}
                  </span>
                </span>
                <span className="mo" style={{ fontSize: 12, color: e.available > 0 ? "var(--dim)" : "var(--red)" }}>{t("pharmacyDesk.sub.onShelf", { n: e.available })}</span>
              </label>
            ))
          )}
        </div>

        <div style={{ padding: "13px 18px", borderTop: "1px solid var(--line2)", background: "var(--wash)" }}>
          <p style={{ margin: 0, fontSize: 11, color: "var(--dim)", lineHeight: "16px" }}>{t("pharmacyDesk.res.checkedAtVerify")}</p>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              className="pri"
              style={{ flexGrow: 1 }}
              disabled={chosen === null}
              onClick={() => { if (chosen !== null) onChoose({ medicineId: chosen.medicineId, brandName: chosen.brandName, available: chosen.available, baseUom: chosen.baseUom }); }}
            >
              {chosen === null ? t("pharmacyDesk.res.put") : t("pharmacyDesk.res.putNamed", { brand: chosen.brandName })}
            </button>
            <button className="sec" onClick={onClose}>{t("pharmacyDesk.res.cancel")} <span className="kb">Esc</span></button>
          </div>
        </div>
      </div>
    </div>
  );
}
