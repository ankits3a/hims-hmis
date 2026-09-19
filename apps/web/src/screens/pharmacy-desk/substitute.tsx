import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchAlternatives, pharmacyErrorText } from "../../lib/pharmacy-api";
import type { WireAlternative, WireDispenseLine } from "../../lib/pharmacy-api";

function choosable(a: WireAlternative): boolean {
  return a.available > 0 && a.check.verdict !== "blocked";
}

/**
 * ═══ PD-5 — GIVE SOMETHING ELSE FOR THIS LINE (PD-D11, E14, E16) ═══
 *
 * Only a generic equivalent can stand in — same salts, strength, form and route — and the list is
 * the server's `alternativesFor`, the SAME predicate `verify` enforces, so what is offered here is
 * what the check will accept. It is the shelf's list: in stock at this counter, Schedule X never
 * offered (E17).
 *
 * CONSENT IS A CONTROL (PD-D11). `verify` refuses a substitution without `patientConsent`, so the
 * sheet carries a real tick beside the sentence the pharmacist must actually say, and the choice
 * cannot be put on the ticket without it.
 *
 * PD-7 C3 — EACH ONE ALREADY PUT TO THIS PATIENT'S CHECK. The server runs the four books on every
 * equivalent with the line swapped to it and judges them with `refusalsOf`, the function verify
 * refuses with, so a BLOCKED row here is exactly one the check would refuse — it cannot be chosen,
 * and it says which book stopped it. A row the books could read only in part says so, never
 * "clear" (PD-D13). The books run again at the check (E14); nothing here replaces that.
 */
export type Substitute = { medicineId: string; brandName: string; available: number };

export function SubstituteSheet({
  dispenseId, line, onChoose, onClose,
}: {
  dispenseId: string;
  line: WireDispenseLine;
  onChoose: (sub: Substitute) => void;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<WireAlternative | null>(null);
  const [consent, setConsent] = useState(false);
  const alts = useQuery({
    queryKey: ["pharmacy", "alternatives", dispenseId, line.lineIdx],
    queryFn: () => fetchAlternatives(dispenseId, line.lineIdx),
    enabled: !line.rxLine.noSubstitution,
    retry: false,
  });

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

  const given = line.dispensedMedicine;
  return (
    <div className="ovl" role="dialog" aria-modal="true" aria-label={t("pharmacyDesk.sub.title", { drug: line.rxLine.drug })} onClick={onClose}>
      <div className="box" style={{ width: 640, maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 70px rgba(19,36,32,.35)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: "15px 18px", borderBottom: "1px solid var(--line2)" }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t("pharmacyDesk.sub.title", { drug: line.rxLine.drug })}</h2>
          <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "var(--dim)" }}>{t("pharmacyDesk.sub.rule")}</p>
        </div>

        <div style={{ overflowY: "auto" }} data-testid="sub-list">
          {line.rxLine.noSubstitution ? (
            <p role="status" style={{ margin: 0, padding: "14px 18px", fontSize: 12.5, color: "var(--gold)" }}>{t("pharmacyDesk.sub.noSubstitution")}</p>
          ) : alts.isPending ? (
            <p style={{ margin: 0, padding: "14px 18px", fontSize: 12.5, color: "var(--dim)" }}>{t("pharmacyDesk.sub.loading")}</p>
          ) : alts.error !== null ? (
            <p role="alert" style={{ margin: 0, padding: "14px 18px", fontSize: 12.5, color: "var(--red)" }}>{pharmacyErrorText(alts.error, t)}</p>
          ) : alts.data.length === 0 ? (
            <p role="status" style={{ margin: 0, padding: "14px 18px", fontSize: 12.5, color: "var(--dim)" }}>{t("pharmacyDesk.sub.none", { drug: given?.brandName ?? line.rxLine.drug })}</p>
          ) : (
            alts.data.map((a) => (
              <label key={a.medicineId} className="drow" style={{ padding: "11px 18px", cursor: choosable(a) ? "pointer" : "not-allowed", opacity: choosable(a) ? 1 : 0.55 }}>
                <input
                  type="radio"
                  name="sub"
                  disabled={!choosable(a)}
                  checked={chosen?.medicineId === a.medicineId}
                  onChange={() => setChosen(a)}
                  style={{ accentColor: "#0e6b4e" }}
                />
                <span style={{ flexGrow: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 500 }}>{a.brandName}</span>
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--dim)" }}>{t("pharmacyDesk.sub.same")}</span>
                  <span style={{ display: "block", fontSize: 11.5, marginTop: 2, color: a.check.verdict === "blocked" ? "var(--red)" : a.check.verdict === "not_checked" ? "var(--gold)" : "var(--green)" }}>
                    {a.check.verdict === "blocked"
                      ? t("pharmacyDesk.sub.check.blocked", { why: a.check.blocks.map((b) => `${t(`pharmacyDesk.sub.book.${b.book}`)} ${b.about}`).join("; ") })
                      : t(`pharmacyDesk.sub.check.${a.check.verdict}`)}
                  </span>
                </span>
                <span className="mo" style={{ fontSize: 12, color: a.available > 0 ? "var(--dim)" : "var(--red)" }}>{t("pharmacyDesk.sub.onShelf", { n: a.available })}</span>
              </label>
            ))
          )}
        </div>

        <div style={{ padding: "13px 18px", borderTop: "1px solid var(--line2)", background: "var(--wash)" }}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: "pointer" }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ width: 17, height: 17, accentColor: "#0e6b4e", marginTop: 1 }} />
            <span style={{ fontSize: 12, lineHeight: "17px" }}>
              {t("pharmacyDesk.sub.consent")} <span style={{ color: "var(--dim)" }}>{t("pharmacyDesk.sub.consentWhy")}</span>
            </span>
          </label>
          <p style={{ margin: "8px 0 0 0", fontSize: 11, color: "var(--dim)", lineHeight: "16px" }}>{t("pharmacyDesk.sub.checkedAtVerify")}</p>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              className="pri"
              style={{ flexGrow: 1 }}
              disabled={chosen === null || !consent}
              onClick={() => { if (chosen !== null) onChoose({ medicineId: chosen.medicineId, brandName: chosen.brandName, available: chosen.available }); }}
            >
              {chosen === null ? t("pharmacyDesk.sub.put") : t("pharmacyDesk.sub.putNamed", { brand: chosen.brandName })}
            </button>
            <button className="sec" onClick={onClose}>{t("pharmacyDesk.sub.cancel")} <span className="kb">Esc</span></button>
          </div>
        </div>
      </div>
    </div>
  );
}
