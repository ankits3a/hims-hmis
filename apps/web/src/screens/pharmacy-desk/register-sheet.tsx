import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { duplicateCandidates, registerPatient } from "../../lib/patients-api";
import { pharmacyErrorText } from "../../lib/pharmacy-api";
import type { WirePatientHit, WireRegisterBody } from "../../lib/patients-api";
import "./paper-rx.css";

/**
 * ═══ 2026-09-30 (owner) — NOBODY FOUND → REGISTER AT THE COUNTER → PAPER PRESCRIPTION ═══
 *
 * *"let the patient buy medicine on physical prescription too."* The desk searched and found nobody:
 * the person is simply not registered here. This compact sheet takes what an Indian pharmacy counter
 * takes — name, mobile, age or date of birth, sex — prefilled with what was typed (digits → mobile,
 * anything else → name), and registers through the registration desk's own route (`POST /patients`,
 * `patients.register`, which the pharmacy role holds for the P19 walk-in counter). The server's rules
 * stand as they are: age or DOB is required, and a close match (same mobile — FD-34's family link —
 * or a near name) is shown first; the pharmacist picks that person or confirms someone new.
 * Then the paper-prescription sheet opens on the person.
 */
export type RegisteredPerson = { id: string; uhid: string; label: string };

type Sex = WireRegisterBody["sex"];

export function prefillFrom(typed: string): { name: string; phone: string } {
  const t = typed.trim();
  const digits = t.replace(/[\s+-]/g, "");
  if (/^\d{6,13}$/.test(digits)) return { name: "", phone: digits.slice(-10) };
  return { name: t, phone: "" };
}

export function RegisterSheet({ typed, onClose, onDone }: {
  typed: string;
  onClose: () => void;
  onDone: (p: RegisteredPerson) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const pre = prefillFrom(typed);
  const [name, setName] = useState(pre.name);
  const [phone, setPhone] = useState(pre.phone);
  const [age, setAge] = useState("");
  const [dob, setDob] = useState("");
  const [sex, setSex] = useState<Sex | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<WirePatientHit[] | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const phoneOk = phone === "" || /^[6-9]\d{9}$/.test(phone);
  const ageOk = /^\d{1,3}$/.test(age) && Number(age) <= 120;
  const canSave = !busy && name.trim() !== "" && sex !== "" && phoneOk && (ageOk || dob !== "");

  const save = async (acknowledged: boolean): Promise<void> => {
    if (!canSave) return;
    setBusy(true); setError(null);
    try {
      const body: WireRegisterBody = {
        name: name.trim(), sex: sex as Sex,
        ...(phone === "" ? {} : { phone }),
        ...(dob !== "" ? { dob } : { ageYears: Number(age) }),
        ...(acknowledged ? { acknowledgedDuplicates: true } : {}),
      };
      const { patient } = await registerPatient(body);
      onDone({ id: patient.id, uhid: patient.uhid, label: patient.name });
    } catch (e) {
      const dupes = duplicateCandidates(e);
      if (dupes !== null) { setMatches(dupes); return; }
      setError(pharmacyErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ovl" role="dialog" aria-modal="true" aria-label={t("pharmacyDesk.register.title")} onClick={onClose}>
      <div
        className="box paper-rx"
        data-testid="desk-register-sheet"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(false); } }}
      >
        <div className="paper-rx-head">
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, flexGrow: 1 }}>{t("pharmacyDesk.register.title")}</h2>
          <button type="button" className="pill" onClick={onClose}>{t("pharmacyDesk.close")} <span className="kb">Esc</span></button>
        </div>
        <div className="paper-rx-body">
          <p style={{ margin: "0 0 14px 0", fontSize: 12.5, color: "var(--dim)" }}>{t("pharmacyDesk.register.sub")}</p>
          <div className="paper-rx-grid">
            <label className="paper-rx-field">
              <span className="tag">{t("pharmacyDesk.register.name")}</span>
              <input className="in" autoFocus={pre.name === ""} value={name} onChange={(e) => setName(e.target.value)} data-testid="register-name" />
            </label>
            <label className="paper-rx-field">
              <span className="tag">{t("pharmacyDesk.register.mobile")}</span>
              <input className="in" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} data-testid="register-mobile" />
              {!phoneOk ? <span style={{ fontSize: 11.5, color: "var(--red)" }}>{t("pharmacyDesk.register.mobileBad")}</span> : null}
            </label>
            <label className="paper-rx-field">
              <span className="tag">{t("pharmacyDesk.register.age")}</span>
              <input className="in" inputMode="numeric" autoFocus={pre.name !== ""} value={age} disabled={dob !== ""}
                onChange={(e) => setAge(e.target.value.replace(/\D/g, "").slice(0, 3))} data-testid="register-age" />
            </label>
            <label className="paper-rx-field">
              <span className="tag">{t("pharmacyDesk.register.dob")}</span>
              <input className="in" type="date" value={dob} onChange={(e) => setDob(e.target.value)} data-testid="register-dob" />
            </label>
          </div>
          <div role="radiogroup" aria-label={t("pharmacyDesk.register.sex")} style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
            <span className="tag" style={{ marginRight: 4 }}>{t("pharmacyDesk.register.sex")}</span>
            {(["female", "male", "other"] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={sex === s} className={sex === s ? "pri" : "sec"} onClick={() => setSex(s)}>
                {t(`pharmacyDesk.register.sex_${s}`)}
              </button>
            ))}
          </div>

          {matches !== null ? (
            <div className="box" style={{ marginTop: 16 }} data-testid="register-matches">
              <div style={{ padding: "12px 14px", fontSize: 12.5 }}>{t("pharmacyDesk.register.matches", { count: matches.length })}</div>
              {matches.map((m) => (
                <button key={m.id} type="button" className="drow" style={{ width: "100%", textAlign: "left" }}
                  onClick={() => onDone({ id: m.id, uhid: m.uhid, label: m.name })}>
                  <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 500 }}>{m.name}</span>
                  <span className="mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>{m.uhid}{m.phone === null ? "" : ` · ${m.phone}`}</span>
                </button>
              ))}
              <div style={{ padding: "10px 14px" }}>
                <button type="button" className="sec" disabled={!canSave} onClick={() => void save(true)} data-testid="register-anyway">
                  {t("pharmacyDesk.register.anyway")}
                </button>
              </div>
            </div>
          ) : null}
          {error !== null ? <p role="alert" style={{ margin: "12px 0 0 0", fontSize: 12.5, color: "var(--red)" }}>{error}</p> : null}
        </div>
        <div className="paper-rx-foot">
          <button type="button" className="sec" style={{ marginLeft: "auto" }} onClick={onClose}>{t("pharmacyDesk.paperRx.cancel")}</button>
          <button type="button" className="pri" disabled={!canSave} onClick={() => void save(false)} data-testid="register-save">
            {busy ? t("pharmacyDesk.paperRx.saving") : t("pharmacyDesk.register.save")} <span className="kb" style={{ borderColor: "rgba(255,255,255,.35)", background: "rgba(255,255,255,.12)", color: "#d6ece1" }}>Ctrl ⏎</span>
          </button>
        </div>
      </div>
    </div>
  );
}
