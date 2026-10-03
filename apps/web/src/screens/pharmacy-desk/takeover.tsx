import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { pharmacyErrorText, takeOverDispense } from "../../lib/pharmacy-api";

/**
 * Owner 2026-10-03 — a colleague claimed this ticket and left the desk. Take it over with a reason
 * (`POST /pharmacy/dispenses/:id/take-over`); the lines, picks and bill stay, only the holder changes.
 */
const CHIPS = ["left", "shift", "asked"] as const;

export function TakeOver({ dispenseId, holder }: { dispenseId: string; holder: string }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return <button className="pri" style={{ marginTop: 16 }} data-testid="desk-take-over" onClick={() => setOpen(true)}>{t("pharmacyDesk.takeOver.button", { name: holder })}</button>;
  }
  const submit = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const d = await takeOverDispense(dispenseId, reason.trim());
      qc.setQueryData(["pharmacy", "dispense", dispenseId], d);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "queue"] });
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="desk-take-over-form" style={{ marginTop: 16, display: "grid", gap: 8, maxWidth: 520 }}>
      <label className="tag" htmlFor="take-over-reason">{t("pharmacyDesk.takeOver.why", { name: holder })}</label>
      <input id="take-over-reason" className="in" data-testid="take-over-reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ height: 34, fontSize: 13 }} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {CHIPS.map((c) => {
          const text = t(`pharmacyDesk.takeOver.chip.${c}`);
          return (
            <button key={c} type="button" data-testid={`take-over-chip-${c}`} onClick={() => setReason(text)}
              style={{ height: 26, padding: "0 10px", borderRadius: 13, fontSize: 11.5, border: "1px solid var(--line)", background: "var(--card)", color: "var(--dim)" }}>
              {text}
            </button>
          );
        })}
      </div>
      {error !== null ? <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--red)" }}>{error}</p> : null}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="pri" data-testid="take-over-submit" disabled={busy || reason.trim().length < 3} onClick={() => void submit()}>{t("pharmacyDesk.takeOver.submit")}</button>
        <button className="sec" onClick={() => setOpen(false)}>{t("pharmacyDesk.takeOver.cancel")}</button>
      </div>
    </div>
  );
}
