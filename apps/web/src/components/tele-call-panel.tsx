import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { slotClock } from "../lib/appointment-view";
import { opdErrorMessage } from "../lib/opd-api";
import { TeleGlyph } from "./tele-mark";

/**
 * ═══ TELE-CALL ON THE DOCTOR'S CONSULT (owner 2026-10-09) ═══
 *
 * The doctor rings from their own mobile. `Call patient` asks the server for the number — the one
 * place it is handed over — and shows it to dial; then one of two answers. Complete and Issue stay
 * locked until `Spoke to patient` (the server's rule; this panel mirrors it).
 *
 * NOTHING HERE SPEAKS OF MONEY, and nothing may: a tele-call is in the doctor's line only because it
 * may be consulted. The desk-only test reads this file with the other doctor-facing sources.
 */
export type TeleBits = { consultMode?: string | null; teleOutcome?: string | null; teleOutcomeAt?: string | null; teleNoAnswerCount?: number | null };
export const teleLockedOf = (e: TeleBits | null | undefined): boolean => e?.consultMode === "tele" && e.teleOutcome !== "spoke";

export function TeleCallPanel({ encounterId, encounter, slotAt, onSpoke, onLeft }: {
  encounterId: string; encounter: TeleBits; slotAt: string | null | undefined;
  /** 'Spoke' was recorded: the caller re-reads the visit. */
  onSpoke: () => void;
  /** 'No answer': the visit has left the consultation (back to the line, or to the desk). */
  onLeft: (line: string) => void;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (encounter.consultMode !== "tele") return null;
  const spoke = encounter.teleOutcome === "spoke";

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await work(); } catch (e) { setError(opdErrorMessage(e)); } finally { setBusy(false); }
  };
  const call = (): Promise<void> => run(async () => {
    const r = await api<{ telePhone: string | null }>("POST", `/opd/visits/${encodeURIComponent(encounterId)}/tele/call`);
    setPhone(r.telePhone ?? "");
  });
  const answer = (outcome: "spoke" | "no_answer"): Promise<void> => run(async () => {
    const r = await api<{ outcome: string; final: boolean }>("POST", `/opd/visits/${encodeURIComponent(encounterId)}/tele/outcome`, { outcome });
    if (r.outcome === "spoke") onSpoke();
    else onLeft(t(r.final ? "teleCall.toDesk" : "teleCall.backInLine"));
  });

  return (
    <div
      data-testid="tele-panel" role="group" aria-label={t("opdAppt.tele")}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, boxShadow: "inset 0 0 0 2px var(--blue)", background: "var(--card)" }}
    >
      <span data-testid="tele-card" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--blue)", fontWeight: 700, fontSize: 13 }}>
        <TeleGlyph size={16} /> {t("opdAppt.tele")}
        {slotAt != null && <span className="mo" data-testid="tele-slot">{slotClock(slotAt)}</span>}
      </span>
      {spoke ? (
        <span data-testid="tele-spoke" style={{ color: "var(--green)", fontWeight: 700, fontSize: 13 }}>
          {t("teleCall.spokeAt", { time: encounter.teleOutcomeAt == null ? "" : slotClock(encounter.teleOutcomeAt) })}
        </span>
      ) : (
        <>
          {(encounter.teleNoAnswerCount ?? 0) > 0 && <span data-testid="tele-tried" style={{ fontSize: 12, fontWeight: 600, color: "var(--gold)" }}>{t("teleCall.triedOnce")}</span>}
          <button type="button" className="sec" data-testid="tele-call" disabled={busy} onClick={() => { void call(); }}>{t("teleCall.call")}</button>
          {phone !== null && <span data-testid="tele-number" className="mo" style={{ fontSize: 15, fontWeight: 700 }}>{phone === "" ? "—" : t("teleCall.dial", { phone })}</span>}
          <span style={{ flexGrow: 1 }} />
          <button type="button" className="sec" data-testid="tele-no-answer" disabled={busy} onClick={() => { void answer("no_answer"); }}>{t("teleCall.noAnswer")}</button>
          <button type="button" className="sec grn" data-testid="tele-spoke-go" disabled={busy} onClick={() => { void answer("spoke"); }}>{t("teleCall.spoke")}</button>
        </>
      )}
      {error !== null && <p role="alert" style={{ flexBasis: "100%", margin: 0, fontSize: 12.5, color: "var(--red)" }}>{error}</p>}
    </div>
  );
}
