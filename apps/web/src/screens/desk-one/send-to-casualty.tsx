import { useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import { useAuth } from "../../lib/auth";
import { preAlertApi } from "../../lib/er-api";

/**
 * ER lane 2 (#809, seam E9) — the OPD brake's way forward. When the red flag refuses to book, a desk that may register ER
 * arrivals sends the patient to Casualty in one tap: an "Expected from OPD" card on the ER board and desk, naming the
 * patient, the rule that fired and the complaint as typed. The red flag fires before any visit is opened, so there is no
 * OPD visit to close (DECIDED). Without the ER grant the line stays as it was: escalate now.
 */
export function SendToCasualty({ patientId, complaint, reasonKey }: { patientId: string; complaint: string; reasonKey: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [state, setState] = useState<"idle" | "busy" | "sent" | "failed">("idle");
  if (!can("er.arrival.register")) return null;
  if (state === "sent") return <span className="d1-casualty-sent" role="status" data-testid="send-to-casualty-sent">{t("erDesk.casualty.sent")}</span>;
  const send = async (): Promise<void> => {
    setState("busy");
    try {
      await preAlertApi({
        mode: "opd_red_flag", etaMinutes: 5, count: 1, patientId, redFlagKey: reasonKey,
        ...(complaint.trim() !== "" ? { complaint: complaint.trim().slice(0, 500) } : {}),
      });
      setState("sent");
    } catch {
      setState("failed");
    }
  };
  return (
    <span className="d1-casualty">
      <button type="button" className="pri" disabled={state === "busy"} onClick={() => void send()} data-testid="send-to-casualty">{t("erDesk.casualty.send")}</button>
      {state === "failed" ? <span role="alert"> {t("erDesk.failed")}</span> : null}
    </span>
  );
}
