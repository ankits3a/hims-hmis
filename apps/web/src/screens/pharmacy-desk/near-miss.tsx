import { useState } from "react";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../../lib/api";
import { MED_INCIDENT_FACTORS, MED_INCIDENT_STAGES, MED_INCIDENT_TYPES, recordIncident } from "../../lib/incidents-api";
import { pharmacyErrorText } from "../../lib/pharmacy-api";
import type { MedIncidentFactor, MedIncidentStage, MedIncidentType } from "../../lib/incidents-api";

/**
 * ═══ PHARMACY STAGE D2 — "RECORD A NEAR MISS" FROM THE DESK LINE'S ⋯ MENU ═══
 *
 * The line in hand is the context: the dispense and the line's index go to the server, which takes the
 * patient and the item from that line (the pharmacist types neither). What is asked is only what the line
 * cannot say: NCC MERP A or B (a near miss never reached the patient — the line is still at the desk), the
 * stage it started at, what went wrong, what contributed, and what happened. Blame-free: the log shows the
 * role; the reviewer alone is told who.
 */
const selectStyle: React.CSSProperties = { width: "100%", marginTop: 4 };

export function NearMissForm({ dispenseId, lineIdx, drug, onDone, onCancel }: {
  dispenseId: string; lineIdx: number; drug: string; onDone: (no: string) => void; onCancel: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [key] = useState(() => newIdempotencyKey());
  const [category, setCategory] = useState<"A" | "B">("B");
  const [stage, setStage] = useState<MedIncidentStage>("dispensing");
  const [type, setType] = useState<MedIncidentType>("wrong_drug");
  const [factors, setFactors] = useState<MedIncidentFactor[]>([]);
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (f: MedIncidentFactor): void => setFactors((xs) => (xs.includes(f) ? xs.filter((x) => x !== f) : [...xs, f]));

  const save = async (): Promise<void> => {
    if (what.trim() === "" || busy) return;
    setBusy(true); setError(null);
    try {
      const out = await recordIncident({
        kind: "near_miss", category, stage, type, factors, whatHappened: what.trim(), dispenseLine: { dispenseId, lineIdx },
      }, key);
      onDone(out.no);
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="near-miss-form">
      <p style={{ margin: "0 0 10px 0", fontSize: 12, color: "var(--dim)", lineHeight: "17px" }}>{t("pharmacyDesk.nearMiss.lead", { drug, line: lineIdx + 1 })}</p>
      <label className="tag" htmlFor="nm-category">{t("pharmacyDesk.nearMiss.category")}</label>
      <select id="nm-category" className="in" style={selectStyle} data-testid="near-miss-category" value={category} onChange={(e) => setCategory(e.target.value as "A" | "B")}>
        <option value="B">{t("pharmacyOffice.incidents.merp.B")}</option>
        <option value="A">{t("pharmacyOffice.incidents.merp.A")}</option>
      </select>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <label className="tag" style={{ flex: 1 }}>{t("pharmacyOffice.incidents.f.stage")}
          <select className="in" style={selectStyle} data-testid="near-miss-stage" value={stage} onChange={(e) => setStage(e.target.value as MedIncidentStage)}>
            {MED_INCIDENT_STAGES.map((s) => <option key={s} value={s}>{t(`pharmacyOffice.incidents.stage.${s}`)}</option>)}
          </select>
        </label>
        <label className="tag" style={{ flex: 1 }}>{t("pharmacyOffice.incidents.f.type")}
          <select className="in" style={selectStyle} data-testid="near-miss-type" value={type} onChange={(e) => setType(e.target.value as MedIncidentType)}>
            {MED_INCIDENT_TYPES.map((x) => <option key={x} value={x}>{t(`pharmacyOffice.incidents.type.${x}`)}</option>)}
          </select>
        </label>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: "10px 0 0 0" }}>
        <legend className="tag">{t("pharmacyOffice.incidents.f.factors")}</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 4, fontSize: 12.5 }}>
          {MED_INCIDENT_FACTORS.map((f) => (
            <label key={f} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" data-testid={`near-miss-factor-${f}`} checked={factors.includes(f)} onChange={() => toggle(f)} />
              {t(`pharmacyOffice.incidents.factor.${f}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="tag" htmlFor="nm-what" style={{ display: "block", marginTop: 10 }}>{t("pharmacyOffice.incidents.form.what")}</label>
      <textarea id="nm-what" className="in" rows={3} style={{ width: "100%", marginTop: 4 }} data-testid="near-miss-what" value={what} onChange={(e) => setWhat(e.target.value)} />
      {error !== null ? <p role="alert" style={{ margin: "10px 0 0 0", fontSize: 12, color: "var(--red)" }}>{error}</p> : null}
      <p style={{ margin: "10px 0 0 0", fontSize: 11.5, color: "var(--dim)" }}>{t("pharmacyDesk.nearMiss.blameFree")}</p>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button type="button" className="pri" style={{ flexGrow: 1 }} data-testid="near-miss-save" disabled={what.trim() === "" || busy} onClick={() => void save()}>{t("pharmacyDesk.nearMiss.save")}</button>
        <button type="button" className="sec" onClick={onCancel}>{t("pharmacyDesk.rack.cancel")}</button>
      </div>
    </div>
  );
}
