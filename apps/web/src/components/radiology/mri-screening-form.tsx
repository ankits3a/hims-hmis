import { useState } from "react";
import { useTranslation } from "react-i18next";
import { istInputToIso, isoToIstInput } from "./desk-time";
import type { WirePrepStudy } from "../../lib/radiology-api";

/**
 * PLAN 18-S RS5 T4 — **THE MRI SAFETY SCREENING FORM.** The standard questionnaire an Indian MRI
 * suite runs before Zone III (ACR's four-zone model): the devices that STOP a scanner, the rest
 * recorded, the zone, the MR-conditional card, the metal-detector sweep and two signatures.
 *
 * What it sends is `gates.ts`'s `mri_safety` evidence. The server decides: any of pacemaker / ICD,
 * cochlear implant, aneurysm clip, metal fragment, neurostimulator or drug pump, or metal in the eye
 * keeps the gate OPEN — an MR-conditional device is the radiologist's override with a reason, never
 * a satisfied screen — and this form says so before it is sent.
 *
 * **No card upload.** There is no document-store route in this repository to put an image in, so
 * the card's device, model, serial and conditions are recorded as fields instead (DECIDED; the
 * scan of the card waits for a document store).
 */

type YesNo = "no" | "yes";
const HARD = ["pacemaker", "cochlear", "clips", "neurostimulator", "metalFb", "orbitMetal"] as const;
const SOFT = ["welderOrMetalWork", "prosthesis", "tattoos", "claustrophobia"] as const;
type Hard = (typeof HARD)[number];
type Soft = (typeof SOFT)[number];

const input = "w-full rounded border px-2 py-1 text-sm";

export function MriScreeningForm({ ctx, onSubmit, busy, onAsk }: {
  ctx: WirePrepStudy; onSubmit: (evidence: Record<string, unknown>) => void; busy: boolean;
  /**
   * A positive screen cannot satisfy the gate, and the server would store nothing — so instead of
   * sending it, the form hands the bay a note for "Ask the radiologist", carrying what was found.
   */
  onAsk?: (note: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<Record<Hard | Soft, YesNo | "">>(() =>
    Object.fromEntries([...HARD, ...SOFT].map((k) => [k, ""])) as Record<Hard | Soft, YesNo | "">);
  const [implants, setImplants] = useState("");
  const [pregnancy, setPregnancy] = useState<"" | "no" | "yes" | "unsure" | "na">(ctx.patient.sex === "female" ? "" : "na");
  const [surgery, setSurgery] = useState("");
  const [weight, setWeight] = useState(ctx.weight === null ? "" : String(ctx.weight.kg));
  const [zone, setZone] = useState<"" | "I" | "II" | "III" | "IV">("");
  const [card, setCard] = useState({ device: "", model: "", serial: "", conditions: "" });
  const [sweep, setSweep] = useState(false);
  const [signer, setSigner] = useState<"patient" | "guardian">("patient");
  const [signerName, setSignerName] = useState(ctx.patient.name);
  const [tech, setTech] = useState("");
  const [signedAt, setSignedAt] = useState(isoToIstInput(new Date().toISOString()));

  const unanswered = [...HARD, ...SOFT].filter((k) => answers[k] === "");
  const positive = HARD.filter((k) => answers[k] === "yes");
  const cardGiven = card.device.trim() !== "" && card.model.trim() !== "";
  const ready = unanswered.length === 0 && pregnancy !== "" && zone !== "" && sweep
    && signerName.trim() !== "" && tech.trim() !== "";

  const row = (k: Hard | Soft, hard: boolean) => (
    <div key={k} className="flex items-center justify-between gap-2 border-b py-1 text-sm last:border-b-0" data-q={k}>
      <span className="min-w-0">{t(`radiology.bay.mri.q.${k}`)}{hard ? <b className="ml-1 text-red-700">*</b> : null}</span>
      <span className="flex shrink-0 gap-1" role="radiogroup" aria-label={t(`radiology.bay.mri.q.${k}`)}>
        {(["no", "yes"] as const).map((v) => (
          <label key={v} className={`cursor-pointer rounded border px-2 py-0.5 text-xs ${answers[k] === v ? (v === "yes" ? "border-red-600 bg-red-50 font-semibold" : "border-green-700 bg-green-50 font-semibold") : ""}`}>
            <input type="radio" className="sr-only" name={`mri-${k}`} checked={answers[k] === v}
              onChange={() => { setAnswers((a) => ({ ...a, [k]: v })); }} />
            {t(`radiology.bay.mri.${v}`)}
          </label>
        ))}
      </span>
    </div>
  );

  return (
    <form className="space-y-3" data-testid="mri-screening" onSubmit={(e) => {
      e.preventDefault();
      const yes = (k: Hard | Soft) => answers[k] === "yes";
      onSubmit({
        pacemaker: yes("pacemaker"), cochlear: yes("cochlear"), clips: yes("clips"), metalFb: yes("metalFb"),
        neurostimulator: yes("neurostimulator"), orbitMetal: yes("orbitMetal"),
        welderOrMetalWork: yes("welderOrMetalWork"), prosthesis: yes("prosthesis"), tattoos: yes("tattoos"),
        claustrophobia: yes("claustrophobia"),
        implants: implants.split(",").map((s) => s.trim()).filter((s) => s !== "").slice(0, 20),
        pregnancy,
        ...(surgery.trim() === "" ? {} : { priorSurgery: surgery.trim() }),
        ...(weight.trim() === "" || !(Number(weight) > 0) ? {} : { weightKg: Number(weight) }),
        zone,
        ...(cardGiven ? {
          conditionalCard: {
            device: card.device.trim(), model: card.model.trim(),
            ...(card.serial.trim() === "" ? {} : { serial: card.serial.trim() }),
            ...(card.conditions.trim() === "" ? {} : { conditions: card.conditions.trim() }),
          },
        } : {}),
        metalSweep: sweep,
        signatures: { signer, signerName: signerName.trim(), technologistName: tech.trim(), signedAt: istInputToIso(signedAt) },
      });
    }}>
      <fieldset className="rounded border p-2">
        <legend className="px-1 text-xs font-semibold">{t("radiology.bay.mri.stops")}</legend>
        {HARD.map((k) => row(k, true))}
      </fieldset>
      <fieldset className="rounded border p-2">
        <legend className="px-1 text-xs font-semibold">{t("radiology.bay.mri.recorded")}</legend>
        {SOFT.map((k) => row(k, false))}
        <div className="grid gap-2 pt-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium">{t("radiology.bay.mri.implants")}
            <input className={input} value={implants} onChange={(e) => { setImplants(e.target.value); }} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">{t("radiology.bay.mri.surgery")}
            <input className={input} value={surgery} onChange={(e) => { setSurgery(e.target.value); }} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">{t("radiology.bay.mri.pregnancy")}
            <select className={input} value={pregnancy} onChange={(e) => { setPregnancy(e.target.value as typeof pregnancy); }}>
              <option value="">—</option>
              {(["no", "yes", "unsure", "na"] as const).map((v) => <option key={v} value={v}>{t(`radiology.bay.mri.preg.${v}`)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">{t("radiology.bay.mri.weight")}
            <input className={input} inputMode="decimal" value={weight} onChange={(e) => { setWeight(e.target.value); }} />
          </label>
        </div>
      </fieldset>

      {positive.length > 0 && (
        <div role="note" className="rounded border border-red-300 bg-red-50 p-2 text-xs" data-testid="mri-positive">
          <p className="m-0">{t("radiology.bay.mri.positive", { list: positive.map((k) => t(`radiology.bay.mri.q.${k}`)).join(", ") })}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(["device", "model", "serial", "conditions"] as const).map((f) => (
              <label key={f} className="flex flex-col gap-1 font-medium">{t(`radiology.bay.mri.card.${f}`)}
                <input className={input} value={card[f]} onChange={(e) => { setCard((c) => ({ ...c, [f]: e.target.value })); }} />
              </label>
            ))}
          </div>
          <p className="m-0 mt-1 text-muted-foreground">{t("radiology.bay.mri.cardNote")}</p>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium">{t("radiology.bay.mri.zone")}
          <select className={input} value={zone} onChange={(e) => { setZone(e.target.value as typeof zone); }} data-testid="mri-zone">
            <option value="">—</option>
            {(["I", "II", "III", "IV"] as const).map((z) => <option key={z} value={z}>{t(`radiology.bay.mri.zones.${z}`)}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 self-end text-sm">
          <input type="checkbox" checked={sweep} onChange={(e) => { setSweep(e.target.checked); }} data-testid="mri-sweep" />
          {t("radiology.bay.mri.sweep")}
        </label>
      </div>

      <fieldset className="grid gap-2 rounded border p-2 sm:grid-cols-2">
        <legend className="px-1 text-xs font-semibold">{t("radiology.bay.mri.signatures")}</legend>
        <label className="flex flex-col gap-1 text-xs font-medium">{t("radiology.bay.mri.signer")}
          <select className={input} value={signer} onChange={(e) => { setSigner(e.target.value as "patient" | "guardian"); }}>
            <option value="patient">{t("radiology.bay.consent.patient")}</option>
            <option value="guardian">{t("radiology.bay.consent.guardian")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">{t("radiology.bay.mri.signerName")}
          <input className={input} value={signerName} onChange={(e) => { setSignerName(e.target.value); }} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">{t("radiology.bay.mri.technologist")}
          <input className={input} value={tech} onChange={(e) => { setTech(e.target.value); }} data-testid="mri-tech" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">{t("radiology.bay.mri.signedAt")}
          <input className={input} type="datetime-local" value={signedAt} onChange={(e) => { setSignedAt(e.target.value); }} />
        </label>
      </fieldset>

      {!ready && <p className="m-0 text-xs text-muted-foreground">{t("radiology.bay.mri.incomplete", { count: unanswered.length })}</p>}
      {positive.length === 0
        ? (
          <button type="submit" disabled={busy || !ready} data-testid="gate-submit"
            className="rounded bg-green-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
            {t("radiology.bay.mri.submit")}
          </button>
        )
        : onAsk !== undefined && (
          <button type="button" disabled={busy || !ready} data-testid="mri-ask"
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            onClick={() => {
              const found = positive.map((k) => t(`radiology.bay.mri.q.${k}`, { lng: "en" })).join(", ");
              const cardText = cardGiven ? ` Card: ${card.device} ${card.model}${card.serial === "" ? "" : ` #${card.serial}`}${card.conditions === "" ? "" : ` (${card.conditions})`}.` : " No MR-conditional card.";
              onAsk(`MRI screening positive: ${found}.${cardText} Zone ${zone}; sweep done; signed by ${signerName.trim()} and ${tech.trim()}.`.slice(0, 400));
            }}>
            {t("radiology.bay.mri.askPositive")}
          </button>
        )}
    </form>
  );
}
