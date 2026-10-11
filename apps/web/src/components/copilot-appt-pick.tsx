import { useState } from "react";
import { useTranslation } from "react-i18next";
import { dayWords } from "../lib/use-copilot";
import type { CopilotApptPick } from "@hmis/contracts";
import type { CopilotProposal } from "../lib/copilot-api";

/**
 * ═══ E2.1 — AN APPOINTMENT FROM THE CHAT: PICK THE PATIENT, PICK A TIME, CONFIRM ═══
 * (spec /opt/hmis-context/SPEC-copilot-appt-2026-10-11.md)
 *
 * The ask wrote nothing. Every time on this panel is a signed proposal for ONE patient; nothing is
 * booked until the clerk has seen the confirm card — patient name and UHID, doctor, day and time, in
 * person or tele-call — and pressed Confirm. A patient found by mobile or name is tapped first, even
 * when there is one (owner 2026-10-11: no act on the wrong patient).
 */
export function CopilotApptPicker(
  { pick, proposals, busy, onConfirm, onDismiss }: {
    pick: CopilotApptPick;
    proposals: CopilotProposal[];
    busy: boolean;
    onConfirm: (proposal: CopilotProposal) => void;
    onDismiss: () => void;
  },
): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [row, setRow] = useState<number | null>(pick.pickPatient ? null : 0);
  const [time, setTime] = useState<{ at: string; proposal: number } | null>(null);
  const when = (iso: string): string => {
    const at = new Date(iso);
    const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(at);
    return `${dayWords(at, (i18n.language as string | undefined) ?? "en")} · ${clock}`;
  };
  const chosen = row === null ? null : pick.rows[row] ?? null;
  const mode = (m: "in_person" | "tele"): string => t(m === "tele" ? "copilot.act.tele" : "copilot.act.inPerson");
  const btn: React.CSSProperties = {
    minHeight: 32, padding: "4px 10px", borderRadius: 6, border: "1px solid #24413655", background: "#0c1f1a",
    color: "var(--agent-fg)", fontSize: 12, cursor: "pointer", textAlign: "left",
  };

  return (
    <div data-testid="copilot-appt-pick" style={{ borderTop: "1px solid #24413631", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      {chosen === null ? (
        <>
          <span className="tag" style={{ color: "var(--mint)" }}>{t("copilot.act.pickPatient")}</span>
          {pick.rows.map((r, i) => (
            <button key={`${r.patient.uhid}-${String(i)}`} type="button" data-testid={`copilot-appt-patient-${String(i)}`} style={btn}
              onClick={() => { setRow(i); setTime(null); }}>
              <b>{r.patient.name}</b> · {r.patient.ageSex} · <span className="mo">{r.patient.uhid}</span>
              {r.patient.phoneLast4 === null ? null : <span className="mo"> · ••{r.patient.phoneLast4}</span>}
              {r.from === null ? null : <span style={{ color: "var(--agent-dim)" }}> · {t("copilot.act.from", { when: `${r.fromDoctor ?? ""} ${when(r.from)}`.trim() })}</span>}
            </button>
          ))}
        </>
      ) : time === null ? (
        <>
          <span style={{ fontSize: 12 }}>
            <b>{chosen.patient.name}</b> · <span className="mo">{chosen.patient.uhid}</span> · {chosen.doctor} · {mode(chosen.mode)}
          </span>
          {chosen.noMobile ? <span data-testid="copilot-appt-nomobile" style={{ fontSize: 12, color: "#f0c26a" }}>{t("copilot.act.noMobile")}</span>
            : chosen.times.length === 0 ? <span style={{ fontSize: 12, color: "var(--agent-dim)" }}>{t("copilot.act.noTimes")}</span>
            : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {chosen.times.map((x) => (
                  <button key={x.at} type="button" data-testid={`copilot-appt-time-${String(x.proposal)}`} style={btn} onClick={() => { setTime(x); }}>
                    {when(x.at)}
                  </button>
                ))}
              </div>
            )}
        </>
      ) : (
        <div data-testid="copilot-appt-confirm" style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, borderRadius: 8, border: "1px solid var(--mint)" }}>
          <span className="tag" style={{ color: "var(--mint)" }}>{t(pick.action === "move" ? "copilot.act.move" : "copilot.act.book")}</span>
          <span style={{ fontSize: 13 }}><b>{chosen.patient.name}</b> · <span className="mo">{chosen.patient.uhid}</span> · {chosen.patient.ageSex}</span>
          <span style={{ fontSize: 13 }}>{chosen.doctor} · {when(time.at)} · {mode(chosen.mode)}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="agdo" data-testid="copilot-appt-confirm-go" disabled={busy || proposals[time.proposal] === undefined}
              onClick={() => { const p = proposals[time.proposal]; if (p !== undefined) onConfirm(p); }}>
              {t("copilot.act.confirm")}
            </button>
            <button type="button" className="sec" data-testid="copilot-appt-confirm-cancel" disabled={busy} onClick={() => { setTime(null); }}>
              {t("copilot.act.cancel")}
            </button>
          </div>
        </div>
      )}
      {time === null ? (
        <div style={{ display: "flex", gap: 8 }}>
          {pick.pickPatient && chosen !== null ? (
            <button type="button" className="sec" onClick={() => { setRow(null); }}>{t("copilot.act.pickPatient")}</button>
          ) : null}
          <button type="button" className="sec" data-testid="copilot-appt-dismiss" onClick={onDismiss}>{t("copilot.act.cancel")}</button>
        </div>
      ) : null}
    </div>
  );
}
