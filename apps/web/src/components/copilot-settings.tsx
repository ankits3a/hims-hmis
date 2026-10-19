import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { opdErrorMessage } from "../lib/opd-api";

/**
 * #619 — DECISION 0006's two per-doctor copilot toggles, as the doctor sets them (stored on the server,
 * `GET/PUT /opd/consult/copilot-settings`, so every device gives the same answer). Both OFF by default.
 * Each switch says in one line what off and on mean; the line that the doctor always confirms and
 * submits is not a setting and is stated, not offered.
 */
type Settings = { proactive: boolean; draftProse: boolean };
const KEY = ["opd", "consult", "copilot-settings"] as const;

export function CopilotSettings(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api<Settings>("GET", "/opd/consult/copilot-settings") });
  const save = useMutation({
    mutationFn: (change: Partial<Settings>) => api<Settings>("PUT", "/opd/consult/copilot-settings", change),
    onSuccess: (kept) => { qc.setQueryData(KEY, kept); },
  });
  const row = (key: keyof Settings): React.ReactElement => {
    const on = q.data?.[key] === true;
    return (
      <div data-testid={`copilot-setting-${key}`} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderTop: "1px solid var(--line2)" }}>
        <button
          type="button" role="switch" aria-checked={on} aria-label={t(`copilotSettings.${key}.label`)}
          disabled={q.data === undefined || save.isPending}
          onClick={() => { save.mutate({ [key]: !on }); }}
          style={{ flexShrink: 0, width: 36, height: 20, borderRadius: 10, border: "1px solid var(--line)", padding: 2, background: on ? "var(--green)" : "var(--paper, #f3f5f2)", display: "flex", justifyContent: on ? "flex-end" : "flex-start", cursor: "pointer" }}
        >
          <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: 7, background: on ? "#fff" : "var(--dim)" }} />
        </button>
        <span style={{ fontSize: 12, lineHeight: "16px" }}>
          <b style={{ display: "block" }}>{t(`copilotSettings.${key}.label`)}</b>
          <span style={{ color: "var(--dim)" }}>{t(`copilotSettings.${key}.${on ? "on" : "off"}`)}</span>
        </span>
      </div>
    );
  };
  return (
    <div data-testid="copilot-settings" style={{ padding: "4px 0" }}>
      {q.error !== null ? <p role="alert" style={{ color: "var(--red)", fontSize: 12 }}>{opdErrorMessage(q.error)}</p> : (
        <>
          {row("proactive")}
          {row("draftProse")}
          {save.error !== null && <p role="alert" style={{ color: "var(--red)", fontSize: 12, margin: "4px 0" }}>{opdErrorMessage(save.error)}</p>}
          <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--dim)" }}>{t("copilotSettings.always")}</p>
        </>
      )}
    </div>
  );
}
