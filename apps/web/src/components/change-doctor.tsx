import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  changeVisitDoctor, fetchChangeDepartmentOptions, fetchChangeDoctorOptions, moveDepartmentFromVitals, opdErrorMessage, printMovedTokenSlip,
} from "../lib/opd-api";
import type { VitalsDepartmentMove } from "../lib/opd-api";

const REASONS = ["patientAsked", "doctorUnavailable", "wrongDoctor", "other"] as const;
type Reason = (typeof REASONS)[number];

/**
 * Spec #1025 — change this patient's doctor from the vitals bay: the department's doctors sitting
 * today, the patient's agreement and a reason. The token and the queue place stay as they are.
 *
 * Spec #1031 — with `canMoveDepartment` the sheet gains a Department picker, set to the visit's own.
 * Same department is the change above; another department moves the visit there (a new visit and
 * token, no money, no paper). The new token then stays on the sheet, large, for staff to write on
 * the old slip, until they tap Done.
 */
export function ChangeDoctorAction({ encounterId, onDone, canMoveDepartment = false }: {
  encounterId: string;
  onDone: (doctorName: string, moved?: VitalsDepartmentMove) => void;
  canMoveDepartment?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [departmentId, setDepartmentId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [reason, setReason] = useState<Reason | "">("");
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<VitalsDepartmentMove | null>(null);
  const [printed, setPrinted] = useState(false);

  const deptOptions = useQuery({
    queryKey: ["vitals-bay", "change-department", encounterId, departmentId],
    queryFn: () => fetchChangeDepartmentOptions(encounterId, departmentId === "" ? undefined : departmentId),
    enabled: open && canMoveDepartment,
  });
  const doctorOptions = useQuery({
    queryKey: ["vitals-bay", "change-doctor", encounterId],
    queryFn: () => fetchChangeDoctorOptions(encounterId),
    enabled: open && !canMoveDepartment,
  });
  const current = deptOptions.data?.currentDepartmentId ?? null;
  const chosenDept = departmentId === "" ? current : departmentId;
  const otherDept = canMoveDepartment && chosenDept !== null && current !== null && chosenDept !== current;
  const loaded = canMoveDepartment ? deptOptions : doctorOptions;
  const doctors = (canMoveDepartment ? deptOptions.data?.doctors : doctorOptions.data?.items) ?? [];
  const ready = doctorId !== "" && reason !== "" && consented && !busy;

  const close = (): void => {
    setOpen(false); setDepartmentId(""); setDoctorId(""); setReason(""); setConsented(false); setError(null); setMoved(null); setPrinted(false);
  };
  const confirm = async (): Promise<void> => {
    if (!ready || chosenDept === null && canMoveDepartment) return;
    setBusy(true);
    setError(null);
    const why = t(`changeDoctor.reason.${reason as Reason}`);
    try {
      if (otherDept) {
        setMoved(await moveDepartmentFromVitals(encounterId, { departmentId: chosenDept, doctorId, consented, reason: why }));
      } else {
        await changeVisitDoctor(encounterId, { toDoctorId: doctorId, consented, reason: why });
        const name = doctors.find((d) => d.id === doctorId)?.displayName ?? "";
        close();
        onDone(name);
      }
    } catch (e) {
      setError(opdErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const print = async (): Promise<void> => {
    if (moved === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await printMovedTokenSlip(moved.encounterId);
      setPrinted(true);
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
        {t(canMoveDepartment ? "changeDoctor.actionDept" : "changeDoctor.action")}
      </button>
    );
  }
  const box = { display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 6 } as const;
  if (moved !== null) {
    return (
      <div role="dialog" aria-label={t("changeDoctor.newToken")} data-testid="change-department-done" style={box}>
        <span style={{ fontSize: 12.5 }}>{moved.departmentName} · {moved.doctorName}</span>
        <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("changeDoctor.newToken")}</span>
        <span data-testid="change-department-token" style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.1 }}>{moved.tokenNo ?? "—"}</span>
        <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("changeDoctor.writeOnSlip")}</span>
        {error !== null && <p role="alert" data-testid="change-doctor-error" style={{ margin: 0, fontSize: 12.5, color: "var(--red)" }}>{error}</p>}
        <div style={{ display: "flex", gap: 6 }}>
          {moved.printSlip && (
            <button type="button" className="sec" data-testid="change-department-print" disabled={busy || printed} onClick={() => { void print(); }}>
              {t(printed ? "changeDoctor.printed" : "changeDoctor.print")}
            </button>
          )}
          <button type="button" className="pri" data-testid="change-department-close" onClick={() => { const m = moved; close(); onDone(m.doctorName, m); }}>
            {t("changeDoctor.finish")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div role="dialog" aria-label={t("changeDoctor.title")} data-testid="change-doctor-dialog" style={box}>
      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{t(canMoveDepartment ? "changeDoctor.titleDept" : "changeDoctor.title")}</span>
      <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t(otherDept ? "changeDoctor.hintDept" : "changeDoctor.hint")}</span>
      {canMoveDepartment && (
        <select
          aria-label={t("changeDoctor.department")} data-testid="change-doctor-department" className="in" value={chosenDept ?? ""}
          onChange={(e) => { setDepartmentId(e.target.value); setDoctorId(""); }}
        >
          {(deptOptions.data?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      )}
      {loaded.isSuccess && doctors.length === 0 && (
        <span role="status" data-testid="change-doctor-none" style={{ fontSize: 12.5 }}>{t(otherDept ? "changeDoctor.noneDept" : "changeDoctor.none")}</span>
      )}
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
        <button type="button" className="pri" data-testid="change-doctor-confirm" disabled={!ready} onClick={() => { void confirm(); }}>
          {t(otherDept ? "changeDoctor.confirmDept" : "changeDoctor.confirm")}
        </button>
        <button type="button" className="sec" data-testid="change-doctor-cancel" disabled={busy} onClick={close}>{t("changeDoctor.cancel")}</button>
      </div>
    </div>
  );
}
