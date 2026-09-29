import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { useAuth } from "../../lib/auth";
import { radiologyErrorCode, radiologyErrorText, recordContrast, recordContrastReaction } from "../../lib/radiology-api";
import { istDay, istInputToIso, isoToIstInput } from "./desk-time";
import { Refusal } from "./imaging-counter";
import type { WirePrepStudy } from "../../lib/radiology-api";

/**
 * PLAN 18-S RS5 T5 — **THE CONTRAST RECORD AND THE REACTION** — the first web callers of
 * `POST /radiology/studies/:id/contrast` and `POST /radiology/studies/contrast-reactions`.
 *
 * The server holds every rule: an administration is recordable only once the patient is on the
 * table (`in_acquisition` onwards), an expired vial is refused (`vial_expired`), the consent gate
 * must be closed and a documented contrast allergy needs the radiologist's override; a SEVERE
 * reaction needs the treatment and the managing clinician. The panel refuses an expired vial before
 * sending (the label is in front of the nurse), suggests a volume from the weight, and — after a
 * reaction — says in plain words that the allergy list now carries it, because that allergy is what
 * the NEXT study's prior-reaction gate reads.
 *
 * **Rate, injector and the extravasation check have no column** (the administration row carries
 * agent, volume, route, site, batch, expiry, given-by and given-at). DECIDED: they are written into
 * the site line ("R antecubital 20G · 3 mL per sec · power injector · no extravasation"), inside its 120
 * characters, until a migration gives them columns.
 */

/** Common agents; the name is the record, so the concentration is in it. `gad` decides the mL/kg. */
export const CONTRAST_AGENTS: readonly { name: string; kind: "iodinated" | "gad10" | "gad05" }[] = [
  { name: "Iohexol 350 (Omnipaque)", kind: "iodinated" },
  { name: "Iopamidol 370 (Isovue)", kind: "iodinated" },
  { name: "Iodixanol 320 (Visipaque)", kind: "iodinated" },
  { name: "Iopromide 370 (Ultravist)", kind: "iodinated" },
  { name: "Gadobutrol 1.0 M (Gadovist)", kind: "gad10" },
  { name: "Gadoterate 0.5 M (Dotarem)", kind: "gad05" },
];

/**
 * The weight-based suggestion, and it is only a suggestion: iodinated 1 mL/kg up to 100 mL (CT);
 * gadobutrol 0.1 mL/kg; a 0.5 M gadolinium agent 0.2 mL/kg (both 0.1 mmol/kg).
 */
export function suggestedVolumeMl(agent: string, weightKg: number | null): number | null {
  if (weightKg === null || !(weightKg > 0)) return null;
  const kind = CONTRAST_AGENTS.find((a) => a.name === agent)?.kind;
  if (kind === "iodinated") return Math.min(100, Math.round(weightKg));
  if (kind === "gad10") return Math.round(weightKg * 0.1 * 10) / 10;
  if (kind === "gad05") return Math.round(weightKg * 0.2 * 10) / 10;
  return null;
}

const RECORDABLE = ["in_acquisition", "acquired", "reported", "published"];
const input = "w-full rounded border px-2 py-1 text-sm";
const fieldCls = "flex flex-col gap-1 text-xs font-medium";

export function ContrastPanel({ view, onChanged }: { view: WirePrepStudy; onChanged: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const { actor, can } = useAuth();
  const me = actor?.id ?? "";
  const staff = view.staff;
  const canRecord = can("radiology.contrast.record");
  const onTable = RECORDABLE.includes(view.study.status);
  const weightKg = view.weight?.kg ?? null;

  const [agent, setAgent] = useState(CONTRAST_AGENTS[0]!.name);
  const [otherAgent, setOtherAgent] = useState("");
  const [batch, setBatch] = useState("");
  const [expiry, setExpiry] = useState("");
  const [volume, setVolume] = useState("");
  const [route, setRoute] = useState("intravenous");
  const [site, setSite] = useState("");
  const [rate, setRate] = useState("");
  const [injector, setInjector] = useState<"power" | "hand">("power");
  const [extravasation, setExtravasation] = useState(false);
  const [givenBy, setGivenBy] = useState(me);
  const [givenAt, setGivenAt] = useState(isoToIstInput(new Date().toISOString()));
  const [error, setError] = useState<{ code: string | null; message: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const agentName = agent === "__other" ? otherAgent.trim() : agent;
  const suggestion = suggestedVolumeMl(agent, weightKg);
  const expired = expiry !== "" && expiry < istDay(Date.now());

  const give = useMutation({
    mutationFn: () => {
      const extras = [
        rate.trim() === "" ? null : `${rate.trim()} mL per sec`,
        t(`radiology.bay.contrast.injector.${injector}`, { lng: "en" }),
        extravasation ? "extravasation checked: none" : null,
      ].filter((x): x is string => x !== null).join(" · ");
      const siteLine = [site.trim(), extras].filter((x) => x !== "").join(" · ").slice(0, 120);
      return recordContrast(view.study.studyId, {
        agent: agentName, volumeMl: Number(volume), route, site: siteLine === "" ? null : siteLine,
        vialBatchNo: batch.trim() === "" ? null : batch.trim(), vialExpiry: expiry === "" ? null : expiry,
        givenBy, givenAt: istInputToIso(givenAt),
      });
    },
    onSuccess: () => { setError(null); setDone(t("radiology.bay.contrast.recorded")); onChanged(); },
    onError: (e) => { setDone(null); setError({ code: radiologyErrorCode(e), message: radiologyErrorText(e) }); },
  });

  const administrations = view.contrast.administrations;
  return (
    <section className="space-y-3" id="contrast" data-testid="contrast-panel">
      <h3 className="m-0 text-sm font-semibold">{t("radiology.bay.contrast.title")}</h3>
      {administrations.length > 0 && (
        <ul className="m-0 list-none space-y-1 p-0 text-sm" data-testid="contrast-given">
          {administrations.map((a) => (
            <li key={a.id} className="rounded border bg-card p-2">
              <b>{a.agent}</b> · {String(a.volumeMl)} mL · {a.route}{a.site === null ? "" : ` · ${a.site}`}
              <span className="block text-xs text-muted-foreground">
                {a.vialBatchNo === null ? "" : `${t("radiology.bay.contrast.batch")} ${a.vialBatchNo} · `}
                {isoToIstInput(a.givenAt).replace("T", " ")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!onTable
        ? <p className="m-0 text-xs text-muted-foreground" data-testid="contrast-not-yet">{t("radiology.bay.contrast.notYet")}</p>
        : !canRecord
        ? <p className="m-0 text-xs text-muted-foreground">{t("radiology.bay.contrast.noPermission")}</p>
        : (
          <form className="space-y-2 rounded border p-2" data-testid="contrast-form" onSubmit={(e) => {
            e.preventDefault();
            if (expired) { setError({ code: "vial_expired", message: t("radiology.bay.contrast.expired", { date: expiry }) }); return; }
            give.mutate();
          }}>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className={fieldCls}>{t("radiology.bay.contrast.agent")}
                <select className={input} value={agent} onChange={(e) => { setAgent(e.target.value); }}>
                  {CONTRAST_AGENTS.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                  <option value="__other">{t("radiology.bay.contrast.other")}</option>
                </select>
              </label>
              {agent === "__other" && (
                <label className={fieldCls}>{t("radiology.bay.contrast.otherName")}
                  <input className={input} value={otherAgent} onChange={(e) => { setOtherAgent(e.target.value); }} />
                </label>
              )}
              <label className={fieldCls}>{t("radiology.bay.contrast.batch")}
                <input className={input} value={batch} onChange={(e) => { setBatch(e.target.value); }} />
              </label>
              <label className={fieldCls}>{t("radiology.bay.contrast.expiry")}
                <input className={input} type="date" value={expiry} onChange={(e) => { setExpiry(e.target.value); }} data-testid="contrast-expiry" />
              </label>
              <label className={fieldCls}>
                {t("radiology.bay.contrast.volume")}
                <input className={input} inputMode="decimal" value={volume} onChange={(e) => { setVolume(e.target.value); }} data-testid="contrast-volume" />
                <span className="font-normal text-muted-foreground" data-testid="contrast-suggestion">
                  {suggestion === null
                    ? t("radiology.bay.contrast.noSuggestion")
                    : t("radiology.bay.contrast.suggestion", { ml: suggestion, kg: weightKg })}
                </span>
              </label>
              <label className={fieldCls}>{t("radiology.bay.contrast.route")}
                <select className={input} value={route} onChange={(e) => { setRoute(e.target.value); }}>
                  {["intravenous", "intraarterial", "oral", "rectal", "intraarticular", "intrathecal", "intravesical", "intracavitary"]
                    .map((r) => <option key={r} value={r}>{t(`radiology.bay.contrast.routes.${r}`)}</option>)}
                </select>
              </label>
              <label className={fieldCls}>{t("radiology.bay.contrast.site")}
                <input className={input} value={site} placeholder={t("radiology.bay.contrast.sitePlaceholder")} onChange={(e) => { setSite(e.target.value); }} />
              </label>
              <label className={fieldCls}>{t("radiology.bay.contrast.rate")}
                <input className={input} inputMode="decimal" value={rate} onChange={(e) => { setRate(e.target.value); }} />
              </label>
              <label className={fieldCls}>{t("radiology.bay.contrast.injectorLabel")}
                <select className={input} value={injector} onChange={(e) => { setInjector(e.target.value as "power" | "hand"); }}>
                  <option value="power">{t("radiology.bay.contrast.injector.power")}</option>
                  <option value="hand">{t("radiology.bay.contrast.injector.hand")}</option>
                </select>
              </label>
              <label className={fieldCls}>{t("radiology.bay.contrast.givenBy")}
                <select className={input} value={givenBy} onChange={(e) => { setGivenBy(e.target.value); }}>
                  {!staff.some((s) => s.id === me) && me !== "" && <option value={me}>{t("radiology.bay.contrast.me")}</option>}
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className={fieldCls}>{t("radiology.bay.contrast.givenAt")}
                <input className={input} type="datetime-local" value={givenAt} onChange={(e) => { setGivenAt(e.target.value); }} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={extravasation} onChange={(e) => { setExtravasation(e.target.checked); }} data-testid="contrast-extravasation" />
              {t("radiology.bay.contrast.extravasation")}
            </label>
            {expired && <p role="note" className="m-0 text-xs text-red-700">{t("radiology.bay.contrast.expired", { date: expiry })}</p>}
            <button type="submit" disabled={give.isPending || agentName === "" || !(Number(volume) > 0) || givenBy === "" || expired}
              className="rounded bg-green-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50" data-testid="contrast-submit">
              {t("radiology.bay.contrast.record")}
            </button>
          </form>
        )}
      {error !== null && <Refusal code={error.code} message={error.message} />}
      {done !== null && <p role="status" className="m-0 text-xs text-green-800">{done}</p>}
      {administrations.length > 0 && canRecord && <ReactionForm view={view} onChanged={onChanged} />}
      {view.contrast.reactions.length > 0 && (
        <ul className="m-0 list-none space-y-1 p-0 text-sm" data-testid="contrast-reactions">
          {view.contrast.reactions.map((r) => (
            <li key={r.id} className="rounded border border-red-300 bg-red-50 p-2">
              <b>{t(`radiology.bay.reaction.severity.${r.severity}`)}</b> · {t(`radiology.bay.reaction.onset.${r.onset}`)} · {r.manifestation}
              {r.outcome === null ? "" : ` · ${t(`radiology.bay.reaction.outcome.${r.outcome}`)}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const MANIFESTATIONS = ["urticaria", "nausea", "vomiting", "bronchospasm", "hypotension", "laryngealOedema", "vasovagal", "extravasation"] as const;

function ReactionForm({ view, onChanged }: { view: WirePrepStudy; onChanged: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const { actor } = useAuth();
  const admins = view.contrast.administrations;
  const [administrationId, setAdministrationId] = useState(admins[admins.length - 1]?.id ?? "");
  const [severity, setSeverity] = useState<"mild" | "moderate" | "severe">("mild");
  const [onset, setOnset] = useState<"immediate" | "delayed">("immediate");
  const [signs, setSigns] = useState<string[]>([]);
  const [manifestation, setManifestation] = useState("");
  const [treatment, setTreatment] = useState("");
  const [clinician, setClinician] = useState("");
  const [outcome, setOutcome] = useState<"" | "recovered" | "recovering" | "admitted" | "referred" | "died">("");
  const [observedBy, setObservedBy] = useState(actor?.id ?? "");
  const [observedAt, setObservedAt] = useState(isoToIstInput(new Date().toISOString()));
  const [error, setError] = useState<{ code: string | null; message: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const agent = admins.find((a) => a.id === administrationId)?.agent ?? "";
  const text = [...signs.map((s) => t(`radiology.bay.reaction.signs.${s}`, { lng: "en" })), manifestation.trim()].filter((x) => x !== "").join("; ");
  const severe = severity === "severe";

  const save = useMutation({
    mutationFn: () => recordContrastReaction({
      administrationId, severity, onset, manifestation: text,
      treatmentGiven: treatment.trim() === "" ? null : treatment.trim(),
      managingClinicianId: clinician === "" ? null : clinician,
      outcome: outcome === "" ? null : outcome,
      observedBy, observedAt: istInputToIso(observedAt),
    }),
    onSuccess: () => { setError(null); setDone(t("radiology.bay.reaction.recorded", { agent })); onChanged(); },
    onError: (e) => { setDone(null); setError({ code: radiologyErrorCode(e), message: radiologyErrorText(e) }); },
  });

  return (
    <form className="space-y-2 rounded border border-red-200 p-2" data-testid="reaction-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h4 className="m-0 text-sm font-semibold">{t("radiology.bay.reaction.title")}</h4>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className={fieldCls}>{t("radiology.bay.reaction.dose")}
          <select className={input} value={administrationId} onChange={(e) => { setAdministrationId(e.target.value); }}>
            {admins.map((a) => <option key={a.id} value={a.id}>{a.agent} · {String(a.volumeMl)} mL</option>)}
          </select>
        </label>
        <label className={fieldCls}>{t("radiology.bay.reaction.severityLabel")}
          <select className={input} value={severity} onChange={(e) => { setSeverity(e.target.value as typeof severity); }} data-testid="reaction-severity">
            {(["mild", "moderate", "severe"] as const).map((s) => <option key={s} value={s}>{t(`radiology.bay.reaction.severity.${s}`)}</option>)}
          </select>
        </label>
        <label className={fieldCls}>{t("radiology.bay.reaction.onsetLabel")}
          <select className={input} value={onset} onChange={(e) => { setOnset(e.target.value as typeof onset); }}>
            {(["immediate", "delayed"] as const).map((s) => <option key={s} value={s}>{t(`radiology.bay.reaction.onset.${s}`)}</option>)}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={t("radiology.bay.reaction.manifestation")}>
        {MANIFESTATIONS.map((m) => (
          <button key={m} type="button" aria-pressed={signs.includes(m)}
            className={`rounded border px-2 py-0.5 text-xs ${signs.includes(m) ? "border-red-600 bg-red-50 font-semibold" : ""}`}
            onClick={() => { setSigns((p) => p.includes(m) ? p.filter((x) => x !== m) : [...p, m]); }}>
            {t(`radiology.bay.reaction.signs.${m}`)}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className={fieldCls}>{t("radiology.bay.reaction.manifestation")}
          <input className={input} value={manifestation} onChange={(e) => { setManifestation(e.target.value); }} data-testid="reaction-text" />
        </label>
        <label className={fieldCls}>{t("radiology.bay.reaction.treatment")}{severe ? " *" : ""}
          <input className={input} value={treatment} onChange={(e) => { setTreatment(e.target.value); }} />
        </label>
        <label className={fieldCls}>{t("radiology.bay.reaction.clinician")}{severe ? " *" : ""}
          <select className={input} value={clinician} onChange={(e) => { setClinician(e.target.value); }}>
            <option value="">—</option>
            {view.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className={fieldCls}>{t("radiology.bay.reaction.outcomeLabel")}
          <select className={input} value={outcome} onChange={(e) => { setOutcome(e.target.value as typeof outcome); }}>
            <option value="">{t("radiology.bay.reaction.outcomeOpen")}</option>
            {(["recovered", "recovering", "admitted", "referred", "died"] as const).map((o) => <option key={o} value={o}>{t(`radiology.bay.reaction.outcome.${o}`)}</option>)}
          </select>
        </label>
        <label className={fieldCls}>{t("radiology.bay.reaction.observedBy")}
          <select className={input} value={observedBy} onChange={(e) => { setObservedBy(e.target.value); }}>
            {!view.staff.some((s) => s.id === actor?.id) && actor !== null && <option value={actor.id}>{t("radiology.bay.contrast.me")}</option>}
            {view.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className={fieldCls}>{t("radiology.bay.reaction.observedAt")}
          <input className={input} type="datetime-local" value={observedAt} onChange={(e) => { setObservedAt(e.target.value); }} />
        </label>
      </div>
      <p className="m-0 text-xs text-muted-foreground">{t("radiology.bay.reaction.writesAllergy", { agent })}</p>
      <button type="submit" disabled={save.isPending || text === "" || administrationId === "" || (severe && (treatment.trim() === "" || clinician === ""))}
        className="rounded bg-red-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50" data-testid="reaction-submit">
        {t("radiology.bay.reaction.record")}
      </button>
      {error !== null && <Refusal code={error.code} message={error.message} />}
      {done !== null && <p role="status" className="m-0 text-xs text-green-800" data-testid="reaction-done">{done}</p>}
    </form>
  );
}
