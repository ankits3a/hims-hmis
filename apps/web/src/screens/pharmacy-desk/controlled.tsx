import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { captureRetainedPrescription, pharmacyErrorText } from "../../lib/pharmacy-api";
import { downscaleToJpeg } from "../slip-capture";
import type { ControlledHandover, WireControlledCheck, WireDispense } from "../../lib/pharmacy-api";

/**
 * ═══ PHARMACY P6 — A CONTROLLED LINE'S HAND-OVER (NDPS narcotic / psychotropic, Schedule X) ═══
 *
 * The counter agent's card (pine, as every agent chip) says what the law asks before the drug leaves the
 * cabinet — the licence, the prescriber's registration number, the patient's address, the quantity
 * against what was prescribed — each ticked or crossed by the SERVER's reading, and then the four things
 * the pharmacist supplies here: the pharmacy's copy of the prescription (photographed, filed on the
 * patient's record), for Schedule X the seller's endorsement on it, who is taking it and the identity they
 * showed, and a second person's username and PIN. Nothing is sent until every one is there; the server
 * asks all of it again (`controlled-dispense.ts`).
 */
export function ControlledStep({
  dispense, onChange,
}: {
  dispense: WireDispense;
  onChange: (value: ControlledHandover | null) => void;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const list = dispense.controlled ?? null;
  const [retained, setRetained] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [endorsed, setEndorsed] = useState(false);
  const [who, setWho] = useState({ name: "", relation: "", idProof: "" });
  const [witness, setWitness] = useState({ username: "", pin: "" });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRetained(null); setEndorsed(false); setWho({ name: "", relation: "", idProof: "" }); setWitness({ username: "", pin: "" }); setError(null);
  }, [dispense.id]);

  const anyX = list?.lines.some((l) => l.scheduleX) ?? false;
  const complete = list !== null && list.blocking.length === 0 && retained !== null && (!anyX || endorsed)
    && who.name.trim() !== "" && who.relation.trim() !== "" && who.idProof.trim() !== "" && witness.username.trim() !== "" && witness.pin !== "";
  useEffect(() => {
    onChange(complete && retained !== null ? {
      witness: { username: witness.username.trim(), pin: witness.pin },
      collectedBy: { name: who.name.trim(), relation: who.relation.trim(), idProof: who.idProof.trim() },
      retainedDocumentId: retained, ...(anyX ? { endorsed } : {}),
    } : null);
  }, [complete, retained, endorsed, who, witness, anyX, onChange]);

  if (list === null) return null;

  const onPhoto = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setError(null); setCapturing(true);
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((done, fail) => { img.onload = () => { done(); }; img.onerror = () => { fail(new Error("decode")); }; img.src = url; });
      const b64 = await downscaleToJpeg(img, img.naturalWidth, img.naturalHeight);
      if (b64 === null) { setError(t("pharmacyDesk.controlled.photoTooLarge")); return; }
      setRetained((await captureRetainedPrescription(dispense.id, { mimeType: "image/jpeg", imageBase64: b64 })).documentId);
    } catch (e) {
      setError(e instanceof Error && e.message === "decode" ? t("pharmacyDesk.controlled.photoUnreadable") : pharmacyErrorText(e, t));
    } finally {
      URL.revokeObjectURL(url);
      setCapturing(false);
    }
  };

  const supplied: Partial<Record<WireControlledCheck["key"], boolean>> = {
    retained_prescription: retained !== null,
    endorsement: endorsed,
    collected_by: who.name.trim() !== "" && who.relation.trim() !== "" && who.idProof.trim() !== "",
    witness: witness.username.trim() !== "" && witness.pin !== "",
  };
  const okOf = (c: WireControlledCheck): boolean => (c.atHandover ? supplied[c.key] === true : c.ok);
  const cls = list.lines.map((l) => (l.scheduleX ? t("pharmacyDesk.controlled.scheduleX") : t(`pharmacyDesk.controlled.${l.ndpsClass ?? "narcotic"}`)));

  return (
    <div data-testid="desk-controlled" style={{ marginTop: 10 }}>
      <div className="agchip" data-testid="desk-controlled-agent" style={{ display: "block" }}>
        <span style={{ display: "block", fontSize: 11, opacity: 0.8 }}>
          {t("pharmacyDesk.controlled.agent", { lines: list.lines.map((l, i) => `${l.drug} (${cls[i] ?? ""})`).join(", ") })}
        </span>
        <ul style={{ margin: "5px 0 0 0", paddingLeft: 0, listStyle: "none" }}>
          {list.checks.map((c, i) => (
            <li key={`${c.key}-${String(i)}`} data-testid={`controlled-check-${c.key}`} data-ok={okOf(c) ? "yes" : "no"} style={{ fontSize: 12, lineHeight: "19px" }}>
              <b style={{ color: okOf(c) ? "var(--mint)" : "#ffb4a8" }}>{okOf(c) ? "✓" : "✗"}</b> {t(`pharmacyDesk.controlled.check.${c.key}`)}
              <span style={{ opacity: 0.75 }}> · {c.detail}</span>
            </li>
          ))}
        </ul>
        {list.blocking.length > 0 ? (
          <span style={{ display: "block", fontSize: 12, marginTop: 5 }} data-testid="desk-controlled-blocked">{t("pharmacyDesk.controlled.blocked")}</span>
        ) : null}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 9 }}>
        <label style={{ gridColumn: "1 / span 2" }}>
          <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.controlled.retained")}</span>
          <input type="file" accept="image/*" capture="environment" data-testid="controlled-photo" disabled={capturing}
            onChange={(e) => void onPhoto(e.target.files?.[0])} style={{ marginTop: 4 }} />
          {retained !== null ? <span data-testid="controlled-photo-kept" style={{ fontSize: 12, color: "var(--pine, #1f6f5c)" }}> {t("pharmacyDesk.controlled.kept")}</span> : null}
        </label>
        {anyX ? (
          <label style={{ gridColumn: "1 / span 2", fontSize: 13 }}>
            <input type="checkbox" data-testid="controlled-endorsed" checked={endorsed} onChange={(e) => setEndorsed(e.target.checked)} />{" "}
            {t("pharmacyDesk.controlled.endorsed")}
          </label>
        ) : null}
        <label>
          <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.controlled.collectedBy")}</span>
          <input className="in" data-testid="controlled-who" value={who.name} onChange={(e) => setWho({ ...who, name: e.target.value })} style={{ height: 36, marginTop: 4 }} />
        </label>
        <label>
          <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.controlled.relation")}</span>
          <input className="in" data-testid="controlled-relation" value={who.relation} placeholder={t("pharmacyDesk.controlled.relationHint")} onChange={(e) => setWho({ ...who, relation: e.target.value })} style={{ height: 36, marginTop: 4 }} />
        </label>
        <label style={{ gridColumn: "1 / span 2" }}>
          <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.controlled.idProof")}</span>
          <input className="in" data-testid="controlled-id" value={who.idProof} placeholder={t("pharmacyDesk.controlled.idProofHint")} onChange={(e) => setWho({ ...who, idProof: e.target.value })} style={{ height: 36, marginTop: 4 }} />
        </label>
        <label>
          <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.controlled.witness")}</span>
          <input className="in mo" data-testid="controlled-witness" autoComplete="off" value={witness.username} onChange={(e) => setWitness({ ...witness, username: e.target.value })} style={{ height: 36, marginTop: 4 }} />
        </label>
        <label>
          <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.controlled.pin")}</span>
          <input className="in mo" type="password" inputMode="numeric" autoComplete="off" data-testid="controlled-pin" value={witness.pin} onChange={(e) => setWitness({ ...witness, pin: e.target.value })} style={{ height: 36, marginTop: 4 }} />
        </label>
      </div>
      {error !== null ? <p role="alert" style={{ margin: "8px 0 0 0", fontSize: 12, color: "var(--red)" }}>{error}</p> : null}
    </div>
  );
}
