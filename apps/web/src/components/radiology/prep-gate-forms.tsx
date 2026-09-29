import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { istInputToIso, isoToIstInput } from "./desk-time";
import { MriScreeningForm } from "./mri-screening-form";
import type { WirePrepGate, WirePrepStudy } from "../../lib/radiology-api";

/**
 * PLAN 18-S RS5 T3 — **EVERY PREP GATE AS A FORM.** The study console used to take gate evidence as
 * raw JSON typed into a textarea; each kind now has the form its evidence actually is, and builds
 * the exact shape `gates.ts` parses for that kind (the RS5 spike, answer (b)).
 *
 * NOTHING HERE DECIDES A GATE. The forms collect what the server compares — the UHID said is
 * compared with the master, the creatinine's eGFR is recomputed, the consent is checked against the
 * study type and the guardian's authority — and every refusal comes back in the server's own words.
 * The one thing the form does before sending is refuse to send an empty required field.
 */

export type GateContext = WirePrepStudy;

const input = "w-full rounded border px-2 py-1 text-sm";
const label = "flex flex-col gap-1 text-xs font-medium";

function Field({ text, children }: { text: string; children: React.ReactNode }): React.ReactElement {
  return <label className={label}><span>{text}</span>{children}</label>;
}

function Submit({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: React.ReactNode }): React.ReactElement {
  return (
    <button type="submit" disabled={busy || disabled === true} data-testid="gate-submit"
      className="rounded bg-green-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
      {children}
    </button>
  );
}

const nowIstInput = (): string => isoToIstInput(new Date().toISOString());

/* ── identity — two identifiers, the second compared with the patient master ── */
function IdentityForm({ ctx, onSubmit, busy }: FormProps): React.ReactElement {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"uhid" | "wristband" | "dob">("uhid");
  const [value, setValue] = useState("");
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); onSubmit({ secondIdentifier: kind, value: value.trim() }); }}>
      <p className="m-0 text-xs text-muted-foreground">{t("radiology.bay.identity.first", { name: ctx.patient.name })}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field text={t("radiology.bay.identity.second")}>
          <select className={input} value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setValue(""); }}>
            <option value="uhid">{t("radiology.bay.identity.uhid")}</option>
            <option value="wristband">{t("radiology.bay.identity.wristband")}</option>
            <option value="dob">{t("radiology.bay.identity.dob")}</option>
          </select>
        </Field>
        <Field text={t("radiology.bay.identity.value")}>
          <input className={input} type={kind === "dob" ? "date" : "text"} value={value} data-testid="identity-value"
            onChange={(e) => { setValue(e.target.value); }} />
        </Field>
      </div>
      <p className="m-0 text-xs text-muted-foreground">{t("radiology.bay.identity.hint")}</p>
      <Submit busy={busy} disabled={value.trim() === ""}>{t("radiology.bay.record")}</Submit>
    </form>
  );
}

/* ── pregnancy — declared, LMP, a urine test at the bay ── */
function PregnancyForm({ ctx, onSubmit, busy }: FormProps): React.ReactElement {
  const { t } = useTranslation();
  const [declared, setDeclared] = useState(false);
  const [lmp, setLmp] = useState(ctx.lmpDate?.slice(0, 10) ?? "");
  const [upt, setUpt] = useState<"" | "negative" | "positive">("");
  const [uptAt, setUptAt] = useState(nowIstInput());
  const positive = upt === "positive";
  return (
    <form className="space-y-2" onSubmit={(e) => {
      e.preventDefault();
      const ev: Record<string, unknown> = { declared };
      if (lmp !== "") ev.lmpDate = lmp;
      if (upt === "negative") {
        const at = istInputToIso(uptAt);
        ev.hcgResultRef = `bay-urine-hcg:negative:${at}`;
        ev.hcgResultAt = at;
      }
      onSubmit(ev);
    }}>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={declared} onChange={(e) => { setDeclared(e.target.checked); }} data-testid="preg-declared" />
        {t("radiology.bay.pregnancy.declared")}
      </label>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field text={t("radiology.bay.pregnancy.lmp")}>
          <input className={input} type="date" value={lmp} onChange={(e) => { setLmp(e.target.value); }} />
        </Field>
        <Field text={t("radiology.bay.pregnancy.upt")}>
          <select className={input} value={upt} onChange={(e) => { setUpt(e.target.value as typeof upt); }} data-testid="preg-upt">
            <option value="">{t("radiology.bay.pregnancy.uptNone")}</option>
            <option value="negative">{t("radiology.bay.pregnancy.uptNegative")}</option>
            <option value="positive">{t("radiology.bay.pregnancy.uptPositive")}</option>
          </select>
        </Field>
        {upt !== "" && (
          <Field text={t("radiology.bay.pregnancy.uptAt")}>
            <input className={input} type="datetime-local" value={uptAt} onChange={(e) => { setUptAt(e.target.value); }} />
          </Field>
        )}
      </div>
      {positive
        ? <p role="note" className="m-0 rounded border border-amber-300 bg-amber-50 p-2 text-xs">{t("radiology.bay.pregnancy.positive")}</p>
        : <p className="m-0 text-xs text-muted-foreground">{t("radiology.bay.pregnancy.hint")}</p>}
      <Submit busy={busy} disabled={positive || !declared}>{t("radiology.bay.record")}</Submit>
    </form>
  );
}

/* ── contrast consent — bilingual, witnessed; the shape is `ot`'s consentSchema ── */
export const CONTRAST_CONSENT_TEMPLATE = "rad-contrast-v1";

function ConsentForm({ ctx, onSubmit, busy }: FormProps): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [language, setLanguage] = useState<"hi" | "en">("hi");
  const [signer, setSigner] = useState<"patient" | "guardian">("patient");
  const [guardianId, setGuardianId] = useState("");
  const [thumb, setThumb] = useState(false);
  const [witness, setWitness] = useState("");
  const [interpreter, setInterpreter] = useState("");
  const [signedAt, setSignedAt] = useState(nowIstInput());
  const withAuthority = ctx.guardians.filter((g) => g.consents);
  const en = i18n.getFixedT("en");
  const hi = i18n.getFixedT("hi");
  const side = ctx.study.laterality === "na" ? null : ctx.study.laterality;
  return (
    <form className="space-y-2" onSubmit={(e) => {
      e.preventDefault();
      onSubmit({
        procedureCode: ctx.study.studyTypeCode, templateVersion: CONTRAST_CONSENT_TEMPLATE, language, signer,
        ...(signer === "guardian" ? { guardianId } : {}),
        ...(interpreter.trim() === "" ? {} : { interpreter: interpreter.trim() }),
        witness: witness.trim(), thumbImpression: thumb, laterality: side, conversionCovered: false,
        signedAt: istInputToIso(signedAt),
      });
    }}>
      <div className="grid gap-2 rounded border bg-muted/30 p-2 text-xs sm:grid-cols-2" data-testid="consent-text">
        <p className="m-0" lang="en">{en("radiology.bay.consent.text", { study: ctx.study.studyTypeName })}</p>
        <p className="m-0" lang="hi">{hi("radiology.bay.consent.text", { study: ctx.study.studyTypeName })}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field text={t("radiology.bay.consent.language")}>
          <select className={input} value={language} onChange={(e) => { setLanguage(e.target.value as "hi" | "en"); }}>
            <option value="hi">हिंदी</option>
            <option value="en">English</option>
          </select>
        </Field>
        <Field text={t("radiology.bay.consent.signer")}>
          <select className={input} value={signer} onChange={(e) => { setSigner(e.target.value as "patient" | "guardian"); }}>
            <option value="patient">{t("radiology.bay.consent.patient")}</option>
            <option value="guardian" disabled={withAuthority.length === 0}>{t("radiology.bay.consent.guardian")}</option>
          </select>
        </Field>
        {signer === "guardian" && (
          <Field text={t("radiology.bay.consent.whichGuardian")}>
            <select className={input} value={guardianId} onChange={(e) => { setGuardianId(e.target.value); }}>
              <option value="">—</option>
              {withAuthority.map((g) => <option key={g.guardianId} value={g.guardianId}>{g.name} · {g.relationship}</option>)}
            </select>
          </Field>
        )}
        <Field text={t("radiology.bay.consent.witness")}>
          <input className={input} value={witness} onChange={(e) => { setWitness(e.target.value); }} data-testid="consent-witness" />
        </Field>
        <Field text={t("radiology.bay.consent.interpreter")}>
          <input className={input} value={interpreter} onChange={(e) => { setInterpreter(e.target.value); }} />
        </Field>
        <Field text={t("radiology.bay.consent.signedAt")}>
          <input className={input} type="datetime-local" value={signedAt} onChange={(e) => { setSignedAt(e.target.value); }} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={thumb} onChange={(e) => { setThumb(e.target.checked); }} />
        {t("radiology.bay.consent.thumb")}
      </label>
      <Submit busy={busy} disabled={witness.trim() === "" || (signer === "guardian" && guardianId === "")}>
        {t("radiology.bay.consent.record")}
      </Submit>
    </form>
  );
}

/* ── kidney — the lab's signed creatinine by pointer, or an outside paper report ── */
function KidneyForm({ ctx, onSubmit, busy }: FormProps): React.ReactElement {
  const { t } = useTranslation();
  const k = ctx.kidney;
  const [useLab, setUseLab] = useState(k.creatinine !== null);
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState<"mgdl" | "umol">("mgdl");
  const [sampled, setSampled] = useState(nowIstInput().slice(0, 10));
  const [ckd, setCkd] = useState(false);
  const [hydration, setHydration] = useState(false);
  const band = useLab && k.egfr?.computed === true ? k.egfr.band : null;
  const umol = value === "" ? null : unit === "mgdl" ? Number(value) * 88.42 : Number(value);
  return (
    <form className="space-y-2" onSubmit={(e) => {
      e.preventDefault();
      if (useLab && k.creatinine !== null) {
        onSubmit({
          labResultId: k.creatinine.resultId, creatinineUmolL: k.creatinine.umolL,
          sampledAt: k.creatinine.sampledAt, source: "internal", ckdFlagged: ckd, ivHydration: hydration,
        });
      } else {
        onSubmit({
          creatinineUmolL: Math.round((umol ?? 0) * 100) / 100, sampledAt: istInputToIso(`${sampled}T09:00`),
          source: "external", ckdFlagged: ckd, ivHydration: hydration,
        });
      }
    }}>
      {k.creatinine !== null && (
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" checked={useLab} onChange={() => { setUseLab(true); }} name="crea-source" />
          <span data-testid="kidney-lab">
            {t("radiology.bay.kidney.lab", {
              value: k.creatinine.reported.value, unit: k.creatinine.reported.unit ?? "",
              date: k.creatinine.sampledAt.slice(0, 10),
            })}
            {k.egfr?.computed === true
              ? <b> · eGFR {k.egfr.egfr}</b>
              : <span> · {t("radiology.bay.kidney.noEgfr")}</span>}
          </span>
        </label>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="radio" checked={!useLab} onChange={() => { setUseLab(false); }} name="crea-source" />
        <span>{t("radiology.bay.kidney.outside")}</span>
      </label>
      {!useLab && (
        <div className="grid gap-2 sm:grid-cols-3">
          <Field text={t("radiology.bay.kidney.value")}>
            <input className={input} inputMode="decimal" value={value} onChange={(e) => { setValue(e.target.value); }} data-testid="kidney-value" />
          </Field>
          <Field text={t("radiology.bay.kidney.unit")}>
            <select className={input} value={unit} onChange={(e) => { setUnit(e.target.value as "mgdl" | "umol"); }}>
              <option value="mgdl">mg/dL</option>
              <option value="umol">µmol/L</option>
            </select>
          </Field>
          <Field text={t("radiology.bay.kidney.sampled")}>
            <input className={input} type="date" value={sampled} onChange={(e) => { setSampled(e.target.value); }} />
          </Field>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={ckd} onChange={(e) => { setCkd(e.target.checked); }} />
        {t("radiology.bay.kidney.ckd")}
      </label>
      {band === "hold" && <p role="note" className="m-0 rounded border border-red-300 bg-red-50 p-2 text-xs">{t("radiology.bay.kidney.hold")}</p>}
      <label className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs">
        <input type="checkbox" checked={hydration} onChange={(e) => { setHydration(e.target.checked); }} data-testid="kidney-hydration" />
        <span>
          <b>{t("radiology.bay.kidney.hydrationLabel")}</b> {k.hydrationInstruction}.{" "}
          {band === "hydrate" ? t("radiology.bay.kidney.hydrationNeeded") : t("radiology.bay.kidney.hydrationIfNeeded")}
        </span>
      </label>
      {(k.egfr?.computed === true && k.egfr.metforminHold) && (
        <p className="m-0 text-xs" data-testid="kidney-metformin">{k.metforminNote}.</p>
      )}
      <Submit busy={busy} disabled={!useLab && (umol === null || !(umol > 0))}>{t("radiology.bay.record")}</Submit>
    </form>
  );
}

/* ── prior contrast reaction — the allergy list is the server's read; premedication is recorded ── */
function ReactionGateForm({ ctx, onSubmit, busy }: FormProps): React.ReactElement {
  const { t } = useTranslation();
  const hits = ctx.allergies.filter((a) => a.contrast);
  const radiologists = ctx.staff.filter((s) => s.roles.includes("radiologist"));
  const [rows, setRows] = useState([{ drug: "", dose: "", at: nowIstInput() }]);
  const [radiologistId, setRadiologistId] = useState("");
  const [reason, setReason] = useState("");
  if (hits.length === 0) {
    return (
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); onSubmit({}); }}>
        <p className="m-0 text-sm">{t("radiology.bay.reaction.none", { count: ctx.allergies.length })}</p>
        <Submit busy={busy}>{t("radiology.bay.reaction.confirmNone")}</Submit>
      </form>
    );
  }
  const filled = rows.filter((r) => r.drug.trim() !== "" && r.dose.trim() !== "");
  return (
    <form className="space-y-2" onSubmit={(e) => {
      e.preventDefault();
      onSubmit({
        radiologistId, reason: reason.trim(),
        ...(filled.length === 0 ? {} : { premedication: filled.map((r) => ({ drug: r.drug.trim(), dose: r.dose.trim(), givenAt: istInputToIso(r.at) })) }),
      });
    }}>
      <p role="note" className="m-0 rounded border border-red-300 bg-red-50 p-2 text-xs">
        {t("radiology.bay.reaction.found", { list: hits.map((h) => h.substance).join(", ") })}
      </p>
      <p className="m-0 text-xs font-medium">{t("radiology.bay.reaction.premed")}</p>
      {rows.map((r, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-3">
          <input className={input} placeholder={t("radiology.bay.reaction.drug")} value={r.drug} aria-label={t("radiology.bay.reaction.drug")}
            onChange={(e) => { setRows((p) => p.map((x, j) => j === i ? { ...x, drug: e.target.value } : x)); }} />
          <input className={input} placeholder={t("radiology.bay.reaction.dose")} value={r.dose} aria-label={t("radiology.bay.reaction.dose")}
            onChange={(e) => { setRows((p) => p.map((x, j) => j === i ? { ...x, dose: e.target.value } : x)); }} />
          <input className={input} type="datetime-local" value={r.at} aria-label={t("radiology.bay.reaction.at")}
            onChange={(e) => { setRows((p) => p.map((x, j) => j === i ? { ...x, at: e.target.value } : x)); }} />
        </div>
      ))}
      <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => { setRows((p) => [...p, { drug: "", dose: "", at: nowIstInput() }]); }}>
        {t("radiology.bay.reaction.addDose")}
      </button>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field text={t("radiology.bay.reaction.radiologist")}>
          <select className={input} value={radiologistId} onChange={(e) => { setRadiologistId(e.target.value); }}>
            <option value="">—</option>
            {radiologists.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field text={t("radiology.bay.reaction.reason")}>
          <input className={input} value={reason} onChange={(e) => { setReason(e.target.value); }} />
        </Field>
      </div>
      <Submit busy={busy} disabled={radiologistId === "" || reason.trim() === ""}>{t("radiology.bay.record")}</Submit>
    </form>
  );
}

/* ── Form F — the register is the evidence; the bay only checks it ── */
function FormFForm({ ctx, onSubmit, busy }: FormProps): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); onSubmit({}); }}>
      <p className="m-0 text-xs text-muted-foreground">{t("radiology.bay.formF.hint")}</p>
      <div className="flex flex-wrap gap-2">
        <Submit busy={busy}>{t("radiology.bay.formF.check")}</Submit>
        <button type="button" className="rounded border px-3 py-1.5 text-sm underline"
          onClick={() => { void navigate({ to: "/pcpndt/form-f/$studyId", params: { studyId: ctx.study.studyId } }); }}>
          {t("radiology.study.openFormF")}
        </button>
      </div>
    </form>
  );
}

/* ── chaperone — a named member of staff who was in the room ── */
function ChaperoneForm({ ctx, onSubmit, busy, actorId }: FormProps): React.ReactElement {
  const { t } = useTranslation();
  const [who, setWho] = useState("");
  const people = ctx.staff.filter((s) => s.id !== actorId);
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); onSubmit({ chaperoneUserId: who }); }}>
      <Field text={t("radiology.bay.chaperone.who")}>
        <select className={input} value={who} onChange={(e) => { setWho(e.target.value); }} data-testid="chaperone-who">
          <option value="">—</option>
          {people.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <p className="m-0 text-xs text-muted-foreground">{t("radiology.bay.chaperone.hint")}</p>
      <Submit busy={busy} disabled={who === ""}>{t("radiology.bay.record")}</Submit>
    </form>
  );
}

/* ── side — what the patient says, recorded as said ── */
function SideForm({ onSubmit, busy }: FormProps): React.ReactElement {
  const { t } = useTranslation();
  const [side, setSide] = useState("");
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); onSubmit({ patientStated: side }); }}>
      <Field text={t("radiology.bay.side.said")}>
        <select className={input} value={side} onChange={(e) => { setSide(e.target.value); }}>
          <option value="">—</option>
          {["left", "right", "bilateral"].map((s) => <option key={s} value={s}>{t(`radiology.bay.side.${s}`)}</option>)}
        </select>
      </Field>
      <Submit busy={busy} disabled={side === ""}>{t("radiology.bay.record")}</Submit>
    </form>
  );
}

/* ── MLC — ruled out, or registered with its number ── */
function MlcForm({ onSubmit, busy }: FormProps): React.ReactElement {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"registered" | "ruled_out">("registered");
  const [no, setNo] = useState("");
  return (
    <form className="space-y-2" onSubmit={(e) => {
      e.preventDefault();
      onSubmit(status === "registered" ? { status, mlcNo: no.trim() } : { status });
    }}>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field text={t("radiology.bay.mlc.status")}>
          <select className={input} value={status} onChange={(e) => { setStatus(e.target.value as typeof status); }}>
            <option value="registered">{t("radiology.bay.mlc.registered")}</option>
            <option value="ruled_out">{t("radiology.bay.mlc.ruledOut")}</option>
          </select>
        </Field>
        {status === "registered" && (
          <Field text={t("radiology.bay.mlc.number")}>
            <input className={input} value={no} onChange={(e) => { setNo(e.target.value); }} data-testid="mlc-number" />
          </Field>
        )}
      </div>
      <Submit busy={busy} disabled={status === "registered" && no.trim() === ""}>{t("radiology.bay.record")}</Submit>
    </form>
  );
}

type FormProps = {
  ctx: GateContext;
  onSubmit: (evidence: Record<string, unknown>) => void;
  busy: boolean;
  actorId: string | null;
  /** The MRI form's "ask the radiologist" hand-off for a positive screen. */
  onAsk?: (note: string) => void;
};

const FORMS: Record<string, (p: FormProps) => React.ReactElement> = {
  identity_two_factor: IdentityForm,
  pregnancy_screen: PregnancyForm,
  contrast_consent: ConsentForm,
  renal_function: KidneyForm,
  prior_contrast_reaction: ReactionGateForm,
  mri_safety: (p) => <MriScreeningForm ctx={p.ctx} onSubmit={p.onSubmit} busy={p.busy} {...(p.onAsk === undefined ? {} : { onAsk: p.onAsk })} />,
  form_f: FormFForm,
  chaperone_present: ChaperoneForm,
  laterality_confirm: SideForm,
  mlc_check: MlcForm,
};

/** The form for one open gate. An unknown kind renders nothing rather than a JSON box. */
export function GateEvidenceForm({ gate, ctx, onSubmit, busy, actorId, onAsk }: {
  gate: WirePrepGate; ctx: GateContext; onSubmit: (evidence: Record<string, unknown>) => void;
  busy: boolean; actorId: string | null; onAsk?: (note: string) => void;
}): React.ReactElement | null {
  const Form = FORMS[gate.kind];
  if (Form === undefined) return null;
  return <Form ctx={ctx} onSubmit={onSubmit} busy={busy} actorId={actorId} {...(onAsk === undefined ? {} : { onAsk })} />;
}
