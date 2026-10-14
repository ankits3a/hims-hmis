import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdEmarAllergyFlag, IpdRefusalBody } from "@hmis/contracts";
import { useAuth } from "../lib/auth";
import { refusalOf } from "../lib/ipd-beds-api";
import { decideFlag, getAdmissionFlags } from "../lib/ipd-emar-api";

/**
 * E4.3 (#735) — THE DOCTOR'S ALLERGY-FLAG DECISION on the round page. An allergy recorded after a drug order raised a flag:
 * no dose is given until the doctor decides — STOP the order, or CONTINUE with a reason — and the pharmacist then closes it.
 * Shown only when a flag is open; a decided flag shows the decision ("waiting for pharmacy"). No money (decision 0058).
 */
export function AllergyFlags({ admissionId, onDecided }: { admissionId: string; onDecided?: () => void }): React.ReactElement | null {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [flags, setFlags] = useState<IpdEmarAllergyFlag[]>([]);
  const mayRead = can("ipd.emar.view");
  const load = useCallback(() => { if (mayRead) getAdmissionFlags(admissionId).then((r) => setFlags(r.flags ?? []), () => setFlags([])); }, [admissionId, mayRead]);
  useEffect(() => { load(); }, [load]);
  if (flags.length === 0) return null;
  return (
    <section className="ipdr-panel ipde-flags" aria-label={t("ipdEmar.flags.title")} data-testid="ipde-flags">
      <h2>⚠ {t("ipdEmar.flags.title")}</h2>
      {flags.map((f) => <FlagRow key={f.flagId} f={f} mayDecide={can("ipd.order.place")} onDone={() => { load(); onDecided?.(); }} />)}
    </section>
  );
}

function FlagRow({ f, mayDecide, onDone }: { f: IpdEmarAllergyFlag; mayDecide: boolean; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const decide = (decision: "stop" | "continue"): void => {
    setBusy(true); setRefusal(null);
    decideFlag(f.flagId, decision, reason.trim()).then(() => { setBusy(false); onDone(); }, (e: unknown) => { setBusy(false); setRefusal(refusalOf(e)); });
  };
  return (
    <div className="ipde-flagrow" data-testid={`ipde-flagrow-${f.flagId}`}>
      <p><b>{f.title}</b> · {t("ipdEmar.flags.allergy", { what: f.substances.join(", ") })}</p>
      {f.doctorDecision !== null ? (
        <p className="dim">{t(`ipdEmar.pharmacy.decided.${f.doctorDecision}`, { reason: f.doctorReason ?? "" })} · {t("ipdEmar.flags.withPharmacy")}</p>
      ) : mayDecide ? (
        <>
          <p className="dim">{t("ipdEmar.flags.noDose")}</p>
          <label>{t("ipdEmar.reason")}<input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="ipde-flag-reason" /></label>
          <div className="ipde-flagacts">
            <button type="button" disabled={busy || reason.trim() === ""} onClick={() => decide("stop")} data-testid="ipde-flag-stop">{t("ipdEmar.flags.stop")}</button>
            <button type="button" className="primary" disabled={busy || reason.trim() === ""} onClick={() => decide("continue")} data-testid="ipde-flag-continue">{t("ipdEmar.flags.continue")}</button>
          </div>
        </>
      ) : <p className="dim">{t("ipdEmar.pharmacy.awaitDoctor")}</p>}
      {refusal !== null ? <div className="ipdr-refused" role="alert">{refusal.rule}</div> : null}
    </div>
  );
}
