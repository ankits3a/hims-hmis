import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtRupees } from "../lib/format";
import { opdErrorMessage } from "../lib/opd-api";
import type { WireAppointment } from "../lib/opd-api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * ═══ TELE-CALL MONEY — A DESK-ONLY COMPONENT (owner 2026-10-09) ═══
 *
 * *"Doctor will not see 'paid' written or marked against any patient name or id."* The words
 * "To pay" and "Paid" live in THIS file and nowhere a doctor's screen imports from —
 * `tele-desk-only.test.ts` reads the doctor-facing sources and fails if one ever does.
 *
 * The desk sees what a tele-call still owes and collects exactly that: one ordinary advance receipt
 * in the cashier's own open drawer (`POST /opd/appointments/:id/advance`). The server decides the
 * amount, the drawer and the reference; a refusal is shown in its words where the button was.
 */
type Mode = "cash" | "upi" | "card";
const newKey = (): string => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function TeleDeskPay({ appointment, compact = false }: { appointment: WireAppointment; compact?: boolean }): React.ReactElement | null {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("cash");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);

  const mark = appointment.teleDesk;
  if (appointment.mode !== "tele" || mark === undefined) return null;
  const size = compact ? 10.5 : 11.5;
  const gone = appointment.status === "cancelled" || appointment.status === "no_show";
  if (mark.covered) {
    const paise = mark.amountPaise ?? 0;
    if (gone && paise > 0) {
      return (
        <span data-testid={`tele-paid-${appointment.id}`} style={{ fontSize: size, color: "var(--dim)", whiteSpace: "nowrap" }}>
          {t("teleDesk.paidRefund", { amount: fmtRupees(paise) })} · <a href="/billing/office" style={{ color: "var(--green)", fontWeight: 600 }}>{t("teleDesk.refundLink")}</a>
        </span>
      );
    }
    return <span data-testid={`tele-paid-${appointment.id}`} className="pill on" style={{ height: 20, whiteSpace: "nowrap" }}>{t("teleDesk.paid")}</span>;
  }
  if (gone || appointment.status === "rescheduled" || mark.amountPaise === null) return null;
  const amountPaise = mark.amountPaise;
  const free = amountPaise === 0;
  const ready = free || mode !== "upi" || ref.trim() !== "";

  const collect = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await api("POST", `/opd/appointments/${encodeURIComponent(appointment.id)}/advance`, free
        ? { amountPaise: 0 }
        : { amountPaise, tenders: [{ mode, amountPaise, ...(mode === "upi" || ref.trim() !== "" ? { refText: ref.trim() } : {}) }] }, key);
      setOpen(false); setKey(newKey()); setRef("");
      await queryClient.invalidateQueries({ queryKey: ["opd", "appointments"] });
    } catch (e) {
      setError(opdErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
      <span data-testid={`tele-topay-${appointment.id}`} style={{ fontSize: size, fontWeight: 700, color: "var(--gold)" }}>
        {free ? t("teleDesk.nothingToPay") : t("teleDesk.toPay", { amount: fmtRupees(amountPaise) })}
      </span>
      {can("billing.receipt.record") && (
        <button type="button" className="sec grn" data-testid={`tele-collect-${appointment.id}`} onClick={() => { setError(null); setOpen(true); }}>
          {t(free ? "teleDesk.confirmFree" : "teleDesk.collect")}
        </button>
      )}
      <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <DialogContent className="pp">
          <DialogHeader><DialogTitle>{t(free ? "teleDesk.freeTitle" : "teleDesk.collectTitle", { amount: fmtRupees(amountPaise) })}</DialogTitle></DialogHeader>
          <div style={{ fontSize: 13.5 }}>
            <span className="block">{appointment.patient?.name ?? appointment.patient?.alias ?? "—"}</span>
            <span className="block mo" style={{ fontSize: 12, color: "var(--dim)" }}>{appointment.patient?.uhid ?? ""}</span>
          </div>
          {!free && (
            <div>
              <span className="tag" id={`tele-how-${appointment.id}`}>{t("teleDesk.paidBy")}</span>
              <div className="seg three" role="radiogroup" aria-labelledby={`tele-how-${appointment.id}`} style={{ marginTop: 6 }}>
                {(["cash", "upi", "card"] as const).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} data-testid={`tele-mode-${m}`} disabled={busy} onClick={() => { setMode(m); }}>
                    {t(`teleDesk.mode.${m}`)}
                  </button>
                ))}
              </div>
              {mode !== "cash" && (
                <div style={{ marginTop: 10 }}>
                  <label className="tag" htmlFor={`tele-ref-${appointment.id}`} style={{ display: "block", marginBottom: 5 }}>{t(mode === "upi" ? "teleDesk.upiRef" : "teleDesk.cardRef")}</label>
                  <input id={`tele-ref-${appointment.id}`} className="in mo" data-testid="tele-ref" autoComplete="off" maxLength={80} value={ref} disabled={busy} onChange={(e) => { setRef(e.target.value); }} />
                </div>
              )}
            </div>
          )}
          {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="sec" disabled={busy} onClick={() => { setOpen(false); }}>{t("opdAppt.cancel")}</button>
            <button type="button" className="pri" data-testid="tele-collect-go" disabled={busy || !ready} onClick={() => { void collect(); }}>
              {free ? t("teleDesk.confirmFree") : t("teleDesk.received", { amount: fmtRupees(amountPaise) })}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </span>
  );
}
