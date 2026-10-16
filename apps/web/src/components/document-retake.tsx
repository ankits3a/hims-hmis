import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { opdErrorMessage } from "../lib/opd-api";

/**
 * #659 — THE DOCTOR ASKS THE SLIP DESK FOR A CLEARER PHOTO. `POST /opd/slips/:documentId/retake`
 * existed (UX-AUDIT 2026-09-28 · BOARD) and no screen called it. The request puts the visit back on
 * the slip desk's list as RETAKE until a newer page lands; the page itself stays filed. Only a page
 * filed against a visit can come back to a desk, so a page from outside offers nothing. First ask wins.
 */
export function DocumentRetake({ documentId, encounterId, retakeRequestedAt }: {
  documentId: string; encounterId: string | null; retakeRequestedAt: string | null;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [asked, setAsked] = useState<boolean>(retakeRequestedAt !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (encounterId === null) return null;
  if (asked) return <span data-testid={`retake-asked-${documentId}`} style={{ fontSize: 11.5, color: "var(--gold-ink, #8a5a10)", fontWeight: 600 }}>{t("opdConsult.retake.asked")}</span>;
  const send = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await api("POST", `/opd/slips/${encodeURIComponent(documentId)}/retake`, { reason: reason.trim() === "" ? null : reason.trim() });
      setAsked(true);
    } catch (e) {
      setError(opdErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return <button type="button" className="sec" style={{ height: 24, fontSize: 11 }} onClick={() => { setOpen(true); }}>{t("opdConsult.retake.ask")}</button>;
  }
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 11.5 }}>
        <span>{t("opdConsult.retake.reason")}</span>
        <input className="in" value={reason} maxLength={300} onChange={(e) => { setReason(e.target.value); }} style={{ height: 24, fontSize: 12, width: 200 }} />
      </label>
      <button type="button" className="pri" disabled={busy} style={{ height: 24, fontSize: 11 }} onClick={() => { void send(); }}>{t("opdConsult.retake.send")}</button>
      <button type="button" className="sec" disabled={busy} style={{ height: 24, fontSize: 11 }} onClick={() => { setOpen(false); setReason(""); }}>{t("opdConsult.retake.cancel")}</button>
      {error !== null && <span role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>{error}</span>}
    </span>
  );
}
