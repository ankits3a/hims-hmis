import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { changeVisitDoctor, fetchChangeDoctorOptions, opdErrorMessage } from "../lib/opd-api";

const REASONS = ["patientAsked", "doctorUnavailable", "wrongDoctor", "other"] as const;
type Reason = (typeof REASONS)[number];

/**
 * Spec #1025 — change this patient's doctor from the vitals bay: the department's doctors sitting
 * today, the patient's agreement and a reason. The token and the queue place stay as they are.
 */
export function ChangeDoctorAction({ encounterId, onDone }: { encounterId: string; onDone: (doctorName: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [doctorId, setDoctorId] = useState("");
  const [reason, setReason] = useState<Reason | "">("");
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useQuery({
    queryKey: ["vitals-bay", "change-doctor", encounterId],
    queryFn: () => fetchChangeDoctorOptions(encounterId),
    enabled: open,
  });
  const doctors = options.data?.items ?? [];

  const close = (): void => { setOpen(false); setDoctorId(""); setReason(""); setConsented(false); setError(null); };
  const confirm = async (): Promise<void> => {
    if (doctorId === "" || reason === "" || !consented || busy) return;
    setBusy(true);
    setError(null);
    try {
      await changeVisitDoctor(encounterId, { toDoctorId: doctorId, consented, reason: t(`changeDoctor.reason.${reason}`) });
      const name = doctors.find((d) => d.id === doctorId)?.displayName ?? "";
      close();
      onDone(name);
    } catch (e) {
      setError(opdErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button" data-testid="change-doctor-open" onClick={() => { setOpen(true); }}
        style={{ alignSelf: "flex-start", padding: 0, border: 0, background: "none", cursor: "pointer", font: "inherit", fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}
      >
        {t("changeDoctor.action")}
      </button>
    );
  }
  return (
    <div
      role="dialog" aria-label={t("changeDoctor.title")} data-testid="change-doctor-dialog"
      style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 6 }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{t("changeDoctor.title")}</span>
      <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("changeDoctor.hint")}</span>
      {options.isSuccess && doctors.length === 0 && <span role="status" data-testid="change-doctor-none" style={{ fontSize: 12.5 }}>{t("changeDoctor.none")}</span>}
      <select aria-label={t("changeDoctor.doctor")} data-testid="change-doctor-doctor" className="in" value={doctorId} onChange={(e) => { setDoctorId(e.target.value); }}>
        <option value="">{t("changeDoctor.doctor")}</option>
        {doctors.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
      </select>
      <select aria-label={t("changeDoctor.reasonLabel")} data-testid="change-doctor-reason" className="in" value={reason} onChange={(e) => { setReason(e.target.value as Reason | ""); }}>
        <option value="">{t("changeDoctor.reasonLabel")}</option>
        {REASONS.map((r) => <option key={r} value={r}>{t(`changeDoctor.reason.${r}`)}</option>)}
      </select>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
        <input type="checkbox" data-testid="change-doctor-consent" checked={consented} onChange={(e) => { setConsented(e.target.checked); }} />
        {t("changeDoctor.consent")}
      </label>
      {error !== null && <p role="alert" data-testid="change-doctor-error" style={{ margin: 0, fontSize: 12.5, color: "var(--red)" }}>{error}</p>}
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" className="pri" data-testid="change-doctor-confirm" disabled={doctorId === "" || reason === "" || !consented || busy} onClick={() => { void confirm(); }}>{t("changeDoctor.confirm")}</button>
        <button type="button" className="sec" data-testid="change-doctor-cancel" disabled={busy} onClick={close}>{t("changeDoctor.cancel")}</button>
      </div>
    </div>
  );
}
