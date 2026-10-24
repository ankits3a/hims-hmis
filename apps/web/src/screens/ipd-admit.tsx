import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import type React from "react";
import type {
  IpdAdmissionView, IpdAdvice, IpdBandPayload, IpdBedClass, IpdBedProposal, IpdClassQuote, IpdPayerKind, IpdRefusalBody,
} from "@hmis/contracts";
import { useAuth } from "../lib/auth";
import { fmtIst, fmtRupees } from "../lib/format";
import { searchPatients } from "../lib/patients-api";
import type { WirePatientHit } from "../lib/patients-api";
import { getBedBoard, refusalOf, reserveBed } from "../lib/ipd-beds-api";
import {
  admitPatient, askApproval, askEmergencyIcuApproval, backfillDowntime, emergencyAdmit, getAdmission, getBedProposals, getQuotes, listAdmissions,
  listAdvice, listConsultants, planAdmission, printBand, requestAdmission, takeDeposit,
} from "../lib/ipd-admit-api";
import type { BandResult, Consultant, ConsentInput, DepositChoice } from "../lib/ipd-admit-api";
import { code128BBars } from "../components/specimen-label";
import "../styles/paper-pine.css";
import "./ipd-admit.css";
import { dateLocale } from "../lib/date-locale";

/**
 * E1.2 (#719) — ADMIT, THE ONE FLOWING SHEET (spec §4.9 B; design board B, Admit.dc.html).
 *
 * Sections fill top to bottom: patient → advice → payer and class (class cards with the estimate and deposit side by
 * side, from the ACTIVE tariff — a class with no rate says so and offers "Ask billing", never a number) → bed (the
 * top three rule-valid beds with their reasons; picking one holds it for two hours) → consent → deposit or exemption
 * → one button, "Admit and print band". After: the real ticks (admitted, bed occupied, band printed with the allergy
 * in words, deposit receipt). The board's "ward nurse told", "porter task" and "family message" belong to lanes that
 * do not exist yet; the sheet says "comes later" rather than ticking what did not happen.
 *
 * DECIDED against the board:
 * - Consent: tablet signature and OTP need capture integration that is out of scope; the sheet offers the paper
 *   fallback — "paper consent signed" with the witness's name — and shows the other two as "comes later".
 * - The family message card is absent: no message is sent yet, and a preview of an unsent message would mislead.
 * - The emergency lane and the downtime back-fill are two buttons in the header, each opening its own short sheet.
 */

type Mode = "sheet" | "new" | "emergency" | "downtime";
type Refusal = IpdRefusalBody | { message: string; fix?: undefined; rule?: undefined };

const PAYERS: readonly IpdPayerKind[] = ["cash", "insurance_cashless", "insurance_reimbursement", "pmjay", "state_scheme", "corporate"];
const CLASS_CHOICES: readonly IpdBedClass[] = ["general", "semi_private", "private", "deluxe", "suite", "hdu", "icu", "nicu", "picu"];
const ISOLATIONS = ["none", "contact", "droplet", "airborne"] as const;

/** "13 Oct 04:24" in IST — a validity that runs into tomorrow needs its day. */
const dayTimeIst = (iso: string): string =>
  new Intl.DateTimeFormat(dateLocale(undefined, "en-GB"), { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

const refusalText = (e: unknown): Refusal => refusalOf(e) ?? { message: e instanceof Error ? e.message : String(e) };

function StepHead({ n, done, title, aside }: { n: number; done: boolean; title: string; aside?: React.ReactNode }): React.ReactElement {
  return (
    <div className="ipda-step-head">
      <h2><span className={`ipda-num${done ? " done" : ""}`} aria-hidden="true">{done ? "✓" : n}</span>{title}</h2>
      {aside === undefined ? null : <span className="ipda-aside-note">{aside}</span>}
    </div>
  );
}

function RefusalNote({ r }: { r: Refusal | null }): React.ReactElement | null {
  const { t } = useTranslation();
  if (r === null) return null;
  return (
    <div className="ipda-refusal" role="alert">
      <b>{r.rule ?? r.message}</b>
      {"bedRule" in r && r.bedRule ? <span>{r.bedRule}</span> : null}
      {r.fix ? <span className="ipda-fix">{t("ipdAdmit.fix")}: {r.fix}</span> : null}
    </div>
  );
}

/** Find a patient: scan the UHID card into the box, or type a name, UHID or mobile. */
function PatientFind({ onPick }: { onPick: (p: WirePatientHit) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<WirePatientHit[]>([]);
  useEffect(() => {
    if (q.trim().length < 3) { setHits([]); return; }
    const id = setTimeout(() => { searchPatients(q.trim()).then(setHits, () => setHits([])); }, 250);
    return () => clearTimeout(id);
  }, [q]);
  return (
    <div className="ipda-find">
      <input aria-label={t("ipdAdmit.findPatient")} placeholder={t("ipdAdmit.findPatient")} value={q} onChange={(e) => setQ(e.target.value)} />
      {hits.length > 0 ? (
        <ul className="ipda-hits">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" onClick={() => { onPick(h); setQ(""); setHits([]); }}>
                <b>{h.name}</b> <span className="mono">{h.uhid}</span> <span className="dim">{h.administrativeGender}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The free beds on the board right now (the emergency lane and the back-fill pick from these). */
function useFreeBeds(): { id: string; code: string; label: string }[] {
  const [beds, setBeds] = useState<{ id: string; code: string; label: string }[]>([]);
  useEffect(() => {
    getBedBoard(false).then((b) => {
      const out: { id: string; code: string; label: string }[] = [];
      for (const f of b.floors) for (const w of f.wards) for (const bed of w.beds) {
        if (bed.status === "available") out.push({ id: bed.id, code: bed.code, label: `${w.name} · ${bed.code} · ${bed.class}` });
      }
      setBeds(out);
    }, () => setBeds([]));
  }, []);
  return beds;
}

/** The thermal band as it prints: white, identity, alerts in words, Code 128 and QR of the serial. */
export function BandPreview({ band }: { band: IpdBandPayload }): React.ReactElement {
  const { t } = useTranslation();
  const bars = code128BBars(band.barcode);
  return (
    <div className={`ipda-band size-${band.size}`} data-testid="ipd-band" aria-label={t("ipdAdmit.band.title")}>
      <div className="ipda-band-id">
        <b className="ipda-band-name">{band.name}</b>
        <span><span className="mono">{band.uhid}</span> · {band.ageSex}{band.dob ? ` · ${band.dob}` : ""}</span>
        <span>{band.admissionNo} · {band.bedCode ?? "—"} · {band.consultant}</span>
        <span className="ipda-band-alerts">{[...band.allergyWords, ...band.alertWords].join(" · ")}</span>
      </div>
      <svg className="ipda-band-bar" viewBox={`0 0 ${bars.widthModules} 30`} preserveAspectRatio="none" role="img" aria-label={band.barcode}>
        {bars.bars.map((b, i) => <rect key={i} x={b.x} y={0} width={b.width} height={30} fill="#000" />)}
      </svg>
      <QRCodeSVG value={band.qr} size={64} level="M" />
    </div>
  );
}

export function IpdAdmit(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const search = useSearch({ strict: false }) as { admission?: string };
  const [mode, setMode] = useState<Mode>("sheet");
  const [list, setList] = useState<IpdAdmissionView[]>([]);
  const [selId, setSelId] = useState<string | null>(search.admission ?? null);
  const [adm, setAdm] = useState<IpdAdmissionView | null>(null);
  const [quotes, setQuotes] = useState<IpdClassQuote[]>([]);
  const [beds, setBeds] = useState<IpdBedProposal[]>([]);
  const [payer, setPayer] = useState<IpdPayerKind>("cash");
  const [planKind, setPlanKind] = useState<"medical" | "surgical">("medical");
  const [estimateRupees, setEstimateRupees] = useState("");
  const [bedId, setBedId] = useState<string | null>(null);
  const [lang, setLang] = useState<"hi" | "en">("hi");
  const [signedBy, setSignedBy] = useState<ConsentInput["signedBy"]>("patient");
  const [signerName, setSignerName] = useState("");
  const [relation, setRelation] = useState("");
  const [repReason, setRepReason] = useState("");
  const [witness, setWitness] = useState("");
  const [paperSigned, setPaperSigned] = useState(false);
  const [tender, setTender] = useState<"cash" | "upi" | "card">("upi");
  const [tenderRef, setTenderRef] = useState("");
  const [payerName, setPayerName] = useState("");
  const [payerRel, setPayerRel] = useState<"self" | "relative" | "employer" | "other">("self");
  const [receipt, setReceipt] = useState<{ receiptId: string; receiptNo: string; at: string } | null>(null);
  const [band, setBand] = useState<BandResult | null>(null);
  const [error, setError] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadList = useCallback(() => { listAdmissions().then(setList, () => setList([])); }, []);
  useEffect(() => { reloadList(); }, [reloadList]);

  const loadAdmission = useCallback((id: string) => {
    getAdmission(id).then((a) => {
      setAdm(a);
      if (a.payerKind !== null) setPayer(a.payerKind as IpdPayerKind);
      setBedId(a.bed?.id ?? a.reservation?.bedId ?? null);
    }, (e) => setError(refusalText(e)));
    getQuotes(id).then(setQuotes, () => setQuotes([]));
    getBedProposals(id).then(setBeds, () => setBeds([]));
  }, []);
  useEffect(() => {
    if (selId === null) { setAdm(null); return; }
    setReceipt(null); setBand(null); setError(null); setPaperSigned(false); setWitness("");
    loadAdmission(selId);
  }, [selId, loadAdmission]);

  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(refusalText(e)); } finally { setBusy(false); }
  };

  const pickClass = (cls: IpdBedClass): Promise<void> => act(async () => {
    if (adm === null) return;
    const estimatePaise = Math.round(Number(estimateRupees) * 100);
    await planAdmission({
      admissionId: adm.id, payerKind: payer, requestedClass: cls,
      plan: planKind === "surgical" && estimatePaise > 0 ? { kind: "surgical", procedureEstimatePaise: estimatePaise } : { kind: "medical" },
    });
    loadAdmission(adm.id);
  });

  const holdBed = (b: IpdBedProposal): Promise<void> => act(async () => {
    if (adm === null) return;
    if (adm.reservation?.bedId !== b.bedId) {
      await reserveBed({ admissionId: adm.id, bedId: b.bedId, patientId: adm.patient.id, need: { requestedClass: adm.requestedClass, isolation: adm.isolation, icu: adm.icu } });
    }
    setBedId(b.bedId);
    loadAdmission(adm.id);
  });

  const required = adm?.depositRequiredPaise ?? null;
  const exemption: DepositChoice | null = adm === null ? null
    : adm.depositBasis === "scheme_zero" ? { exempt: "scheme" }
    : adm.depositBasis === "emergency_exempt" ? { exempt: "emergency_not_stabilised" }
    : adm.depositBasis === "cashless_non_payables" && required === 0 ? { exempt: "cashless_no_non_payables" }
    : null;
  const paidEnough = adm !== null && required !== null && adm.depositPaidPaise >= required && required > 0;
  const depositDone = exemption !== null || paidEnough;
  const planDone = adm !== null && adm.payerKind !== null && required !== null;
  const consentDone = paperSigned && witness.trim() !== "" && (signedBy === "patient" || (signerName.trim() !== "" && relation.trim() !== ""))
    && (signedBy !== "representative" || repReason.trim() !== "");
  const icuOk = adm === null || !adm.icu || adm.icuApproval?.status === "granted";
  const bedDone = bedId !== null;
  const ready = adm !== null && (adm.state === "requested" || adm.state === "reserved") && planDone && bedDone && consentDone && depositDone && icuOk;
  const latestReceiptId = receipt?.receiptId ?? adm?.deposits.at(-1)?.receiptId ?? null;

  const consentInput = (): ConsentInput => ({
    signedBy, method: "paper", witnessName: witness.trim(), language: lang,
    ...(signedBy === "patient" ? {} : { signerName: signerName.trim(), relation: relation.trim() }),
    ...(signedBy === "representative" ? { representativeReason: repReason.trim() } : {}),
  });

  const doAdmit = (): Promise<void> => act(async () => {
    if (adm === null || bedId === null) return;
    const deposit: DepositChoice = exemption ?? (latestReceiptId !== null ? { receiptId: latestReceiptId } : { receiptId: "" });
    if ("receiptId" in deposit && deposit.receiptId === "") throw new Error(t("ipdAdmit.deposit.takeFirst"));
    await admitPatient({
      admissionId: adm.id, bedId, consent: consentInput(), deposit,
      ...(adm.icu && adm.icuApproval ? { intensivistApprovalId: adm.icuApproval.id } : {}),
    });
    const printed = await printBand(adm.id, "adult", "wrist");
    setBand(printed);
    loadAdmission(adm.id);
    reloadList();
  });

  const selected = adm;
  const quote = quotes.find((q) => q.class === selected?.requestedClass) ?? null;

  return (
    <div className="ipda">
      <header className="ipda-head">
        <div className="ipda-title">
          <h1>{t("ipdAdmit.title")}</h1>
          <span>{t("ipdAdmit.subtitle")}</span>
        </div>
        <div className="ipda-tools">
          <select aria-label={t("ipdAdmit.openRequests")} value={selId ?? ""} onChange={(e) => { setMode("sheet"); setSelId(e.target.value === "" ? null : e.target.value); }}>
            <option value="">{t("ipdAdmit.pickRequest", { n: list.length })}</option>
            {list.map((a) => (
              <option key={a.id} value={a.id}>
                {`${a.patient.name ?? a.patient.uhid} · ${a.patient.uhid} · ${t(`ipdAdmit.state.${a.state}`)}${a.incomplete.length > 0 ? ` · ${t("ipdAdmit.incomplete")}` : ""}`}
              </option>
            ))}
          </select>
          <button type="button" className="ipda-btn" onClick={() => { setMode("new"); setSelId(null); }}>{t("ipdAdmit.newRequest")}</button>
          <button type="button" className="ipda-btn" onClick={() => { setMode("downtime"); setSelId(null); }}>{t("ipdAdmit.downtime.open")}</button>
          <button type="button" className="ipda-btn danger" onClick={() => { setMode("emergency"); setSelId(null); }}>{t("ipdAdmit.emergency.open")}</button>
          <Link to="/ipd/beds" className="ipda-btn quiet">{t("ipdAdmit.toBeds")}</Link>
        </div>
      </header>

      {mode === "new" ? <NewRequest onDone={(id) => { reloadList(); setMode("sheet"); setSelId(id); }} /> : null}
      {mode === "emergency" ? <EmergencyLane onDone={(id) => { reloadList(); setMode("sheet"); setSelId(id); }} /> : null}
      {mode === "downtime" ? <DowntimeBackfill onDone={(id) => { reloadList(); setMode("sheet"); setSelId(id); }} /> : null}

      {mode === "sheet" && selected === null ? (
        <section className="ipda-card ipda-empty">
          <b>{t("ipdAdmit.emptyTitle")}</b>
          <span>{t("ipdAdmit.emptySub")}</span>
        </section>
      ) : null}

      {mode === "sheet" && selected !== null ? (
        <>
          <section aria-label={t("ipdAdmit.patient")} className="ipda-card ipda-patient">
            <div className="ipda-photo" aria-hidden="true">{selected.patient.initials}</div>
            <div className="ipda-who">
              <span className="ipda-name">{selected.patient.name ?? "—"} <span className="dim">· {selected.patient.ageSex}</span></span>
              <span className="dim">{t("ipdAdmit.uhid")} <span className="mono strong">{selected.patient.uhid}</span>
                {selected.admissionNo ? <> · {t("ipdAdmit.ipNo")} <span className="mono strong">{selected.admissionNo}</span></> : null}</span>
              <div className="ipda-chips">
                {selected.patient.allergies.map((a) => <span key={a} className="ipda-chip alert">{a}</span>)}
                {selected.patient.allergies.length === 0 ? <span className="ipda-chip">{t("ipdAdmit.noAllergy")}</span> : null}
                {selected.mlc ? <span className="ipda-chip alert">MLC</span> : null}
                {selected.icu ? <span className="ipda-chip">ICU</span> : null}
                {selected.isolation !== "none" ? <span className="ipda-chip">{t("ipdAdmit.isolation")}: {selected.isolation}</span> : null}
              </div>
            </div>
            <span className="ipda-found">{t(`ipdAdmit.source.${selected.source}`)} · {fmtIst(selected.requestedAt)}</span>
          </section>

          <div className="ipda-cols">
            <div className="ipda-main">
              <section aria-label={t("ipdAdmit.step.advice")} className="ipda-card">
                <StepHead n={1} done title={t("ipdAdmit.step.advice")} aside={t("ipdAdmit.adviceFrom", { name: selected.consultant.name, time: fmtIst(selected.requestedAt) })} />
                <div className="ipda-facts">
                  <div><span>{t("ipdAdmit.diagnosis")}</span><b>{selected.provisionalDiagnosis ?? "—"}</b></div>
                  <div><span>{t("ipdAdmit.consultant")}</span><b>{selected.consultant.name}</b></div>
                  <div><span>{t("ipdAdmit.department")}</span><b>{selected.department ?? "—"}</b></div>
                  {selected.erArrivedAt !== null ? <div data-testid="ipda-er-arrival"><span>{t("ipdAdmit.erArrival")}</span><b className="mono">{dayTimeIst(selected.erArrivedAt)}</b></div> : null}
                  <div><span>{t("ipdAdmit.validUntil")}</span><b className="mono">{dayTimeIst(selected.expiresAt)}</b></div>
                </div>
              </section>

              <section aria-label={t("ipdAdmit.step.payer")} className="ipda-card">
                <StepHead n={2} done={planDone} title={t("ipdAdmit.step.payer")} aside={t("ipdAdmit.payerAside")} />
                <div className="ipda-seg" role="radiogroup" aria-label={t("ipdAdmit.payer")}>
                  {PAYERS.map((p) => (
                    <button key={p} type="button" role="radio" aria-checked={payer === p} onClick={() => setPayer(p)}>{t(`ipdAdmit.payerKind.${p}`)}</button>
                  ))}
                </div>
                <div className="ipda-row">
                  <div className="ipda-seg" role="radiogroup" aria-label={t("ipdAdmit.plan")}>
                    <button type="button" role="radio" aria-checked={planKind === "medical"} onClick={() => setPlanKind("medical")}>{t("ipdAdmit.planMedical")}</button>
                    <button type="button" role="radio" aria-checked={planKind === "surgical"} onClick={() => setPlanKind("surgical")}>{t("ipdAdmit.planSurgical")}</button>
                  </div>
                  {planKind === "surgical" ? (
                    <label className="ipda-inline">{t("ipdAdmit.procedureEstimate")}
                      <input inputMode="numeric" value={estimateRupees} onChange={(e) => setEstimateRupees(e.target.value.replace(/[^0-9]/g, ""))} />
                    </label>
                  ) : null}
                </div>
                {payer === "pmjay" || payer === "state_scheme" ? <p className="ipda-note ok">{t("ipdAdmit.schemeZero")}</p> : null}
                <div className="ipda-classes" role="radiogroup" aria-label={t("ipdAdmit.roomClass")}>
                  {quotes.map((q) => {
                    const on = selected.payerKind !== null && selected.requestedClass === q.class;
                    return (
                      <button key={q.class} type="button" role="radio" aria-checked={on} className={`ipda-class${on ? " on" : ""}`}
                        disabled={busy || selected.state === "admitted"} onClick={() => { void pickClass(q.class); }}>
                        <span className="ipda-class-top"><b>{q.label}</b><span className="dim">{t("ipdAdmit.freeBeds", { n: q.freeBeds })}</span></span>
                        {q.perDay === null ? (
                          <span className="ipda-note warn">{t("ipdAdmit.rateMissing", { what: q.missing.join(", ") })}</span>
                        ) : (
                          <span className="dim">{t("ipdAdmit.roomPerDay")} <span className="mono ink">{fmtRupees(q.perDay.room)}</span> · {t("ipdAdmit.stayEst")} <span className="mono ink">{q.estimatePaise === null ? "—" : fmtRupees(q.estimatePaise)}</span></span>
                        )}
                        <span className="ipda-class-dep">{t("ipdAdmit.depositLabel")} <span className="mono">{q.depositPaise === null ? "—" : fmtRupees(q.depositPaise)}</span></span>
                        {/* E2.2 (#726): the room-rent cap warning before the class is chosen (§4.3, §4.9 B). */}
                        {q.capWarning === null || q.capWarning === undefined ? null : <span className="ipda-note warn" title={t("ipdAdmit.capWarning")}>{q.capWarning.words}</span>}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section aria-label={t("ipdAdmit.step.bed")} className="ipda-card">
                <StepHead n={3} done={bedDone} title={t("ipdAdmit.step.bed")}
                  aside={selected.reservation ? t("ipdAdmit.heldUntil", { time: fmtIst(selected.reservation.expiresAt) }) : selected.bed ? selected.bed.code : undefined} />
                {selected.icu ? (
                  <div className={`ipda-note ${icuOk ? "ok" : "warn"}`}>
                    {icuOk ? t("ipdAdmit.icu.granted") : selected.icuApproval ? t("ipdAdmit.icu.waiting") : t("ipdAdmit.icu.needed")}
                    {!icuOk && selected.icuApproval === null ? (
                      <button type="button" className="ipda-btn sm" disabled={busy} onClick={() => { void act(async () => { await askApproval(selected.id, "icu", t("ipdAdmit.icu.note")); loadAdmission(selected.id); }); }}>
                        {t("ipdAdmit.icu.request")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div className="ipda-flow">
                  <span className="ipda-flow-head"><i aria-hidden="true" />{t("ipdAdmit.flowHead", { n: beds.length, cls: quote?.label ?? selected.requestedClass })}</span>
                  {beds.length === 0 ? <span className="ipda-flow-empty">{t("ipdAdmit.noBeds")}</span> : null}
                  {beds.map((b) => (
                    <button key={b.bedId} type="button" className={`ipda-flow-bed${bedId === b.bedId ? " on" : ""}`} disabled={busy || selected.state === "admitted"} onClick={() => { void holdBed(b); }}>
                      <span><b>{b.wardName ? `${b.wardName} · ${b.code}` : b.code}</b><span className="why">{b.reasons.join(" · ")}</span></span>
                      <span className="tag">{bedId === b.bedId ? t("ipdAdmit.chosen") : t("ipdAdmit.readyNow")}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section aria-label={t("ipdAdmit.step.consent")} className="ipda-card">
                <StepHead n={4} done={consentDone || selected.consent !== null} title={t("ipdAdmit.step.consent")} aside={
                  <span className="ipda-lang" role="group" aria-label={t("ipdAdmit.consentLang")}>
                    <button type="button" aria-pressed={lang === "hi"} onClick={() => setLang("hi")}>हिंदी</button>
                    <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")}>English</button>
                  </span>} />
                <div className="ipda-seg" role="radiogroup" aria-label={t("ipdAdmit.signedBy")}>
                  {(["patient", "guardian", "representative"] as const).map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={signedBy === s} onClick={() => setSignedBy(s)}>{t(`ipdAdmit.signer.${s}`)}</button>
                  ))}
                </div>
                {signedBy !== "patient" ? (
                  <div className="ipda-row">
                    <label className="ipda-inline">{t("ipdAdmit.signerName")}<input value={signerName} onChange={(e) => setSignerName(e.target.value)} /></label>
                    <label className="ipda-inline">{t("ipdAdmit.relation")}<input value={relation} onChange={(e) => setRelation(e.target.value)} /></label>
                  </div>
                ) : null}
                {signedBy === "representative" ? (
                  <label className="ipda-inline wide">{t("ipdAdmit.repReason")}<input value={repReason} onChange={(e) => setRepReason(e.target.value)} /></label>
                ) : null}
                <div className="ipda-row">
                  <label className="ipda-tick"><input type="checkbox" checked={paperSigned} onChange={(e) => setPaperSigned(e.target.checked)} />{t("ipdAdmit.paperSigned")}</label>
                  <label className="ipda-inline">{t("ipdAdmit.witness")}<input value={witness} onChange={(e) => setWitness(e.target.value)} /></label>
                </div>
                <span className="dim small">{t("ipdAdmit.consentLater")}</span>
              </section>

              <section aria-label={t("ipdAdmit.step.deposit")} className="ipda-card">
                <StepHead n={5} done={depositDone} title={t("ipdAdmit.step.deposit")}
                  aside={selected.depositBasis ? t(`ipdAdmit.basis.${selected.depositBasis}`) : undefined} />
                {required === null ? <span className="dim">{t("ipdAdmit.deposit.planFirst")}</span> : exemption !== null ? (
                  <span className="ipda-note ok">{t(`ipdAdmit.exempt.${exemption.exempt}`)}</span>
                ) : (
                  <>
                    <span className="ipda-dep-line">{t("ipdAdmit.deposit.required")} <span className="mono strong">{fmtRupees(required)}</span> · {t("ipdAdmit.deposit.paid")} <span className="mono strong">{fmtRupees(selected.depositPaidPaise)}</span>
                      {selected.deposits.length > 0 ? <> · {t("ipdAdmit.deposit.receipt")} <span className="mono">{selected.deposits.at(-1)!.receiptNo}</span> · {fmtIst(selected.deposits.at(-1)!.takenAt)}</> : null}</span>
                    {!paidEnough ? (
                      <div className="ipda-row">
                        <div className="ipda-seg" role="radiogroup" aria-label={t("ipdAdmit.deposit.tender")}>
                          {(["cash", "upi", "card"] as const).map((m) => (
                            <button key={m} type="button" role="radio" aria-checked={tender === m} onClick={() => setTender(m)}>{t(`ipdAdmit.tender.${m}`)}</button>
                          ))}
                        </div>
                        {tender !== "cash" ? <label className="ipda-inline">{t("ipdAdmit.deposit.ref")}<input value={tenderRef} onChange={(e) => setTenderRef(e.target.value)} /></label> : null}
                        <label className="ipda-inline">{t("ipdAdmit.deposit.payer")}<input value={payerName} onChange={(e) => setPayerName(e.target.value)} placeholder={selected.patient.name ?? ""} /></label>
                        <select aria-label={t("ipdAdmit.relation")} value={payerRel} onChange={(e) => setPayerRel(e.target.value as typeof payerRel)}>
                          {(["self", "relative", "employer", "other"] as const).map((r) => <option key={r} value={r}>{t(`ipdAdmit.payerRel.${r}`)}</option>)}
                        </select>
                        <button type="button" className="ipda-btn" disabled={busy} onClick={() => { void act(async () => {
                          const r = await takeDeposit({
                            admissionId: selected.id, amountPaise: Math.max(0, required - selected.depositPaidPaise), tender,
                            ...(tender === "cash" ? {} : { tenderRef: tenderRef.trim() }),
                            payer: { name: payerName.trim() || (selected.patient.name ?? selected.patient.uhid), relation: payerRel },
                          });
                          setReceipt({ receiptId: r.receiptId, receiptNo: r.receiptNo, at: new Date().toISOString() });
                          loadAdmission(selected.id);
                        }); }}>{t("ipdAdmit.deposit.take", { amount: fmtRupees(Math.max(0, required - selected.depositPaidPaise)) })}</button>
                      </div>
                    ) : null}
                  </>
                )}
              </section>

              <RefusalNote r={error} />

              {selected.state === "admitted" ? (
                <section aria-label={t("ipdAdmit.after.title")} className="ipda-card ipda-done">
                  <b className="ipda-done-head">{t("ipdAdmit.after.admitted", { time: selected.admittedAt ? fmtIst(selected.admittedAt) : "—", bed: selected.bed?.code ?? "—" })}</b>
                  <span><i>✓</i>{t("ipdAdmit.after.ipNo", { no: selected.admissionNo ?? "—" })}</span>
                  <span><i>✓</i>{t("ipdAdmit.after.bed", { bed: selected.bed?.code ?? "—" })}</span>
                  {selected.band || band ? <span><i>✓</i>{t("ipdAdmit.after.band")}</span> : null}
                  {selected.depositPaidPaise > 0 ? <span><i>✓</i>{t("ipdAdmit.after.deposit", { amount: fmtRupees(selected.depositPaidPaise) })}</span> : null}
                  {selected.incomplete.map((k) => <span key={k} className="todo"><i>○</i>{t(`ipdAdmit.todo.${k}`)}</span>)}
                  <span className="later"><i>·</i>{t("ipdAdmit.after.later")}</span>
                  {band ? (
                    <div className="ipda-band-wrap">
                      <BandPreview band={band.band} />
                      <button type="button" className="ipda-btn" onClick={() => { try { window.print(); } catch { /* the desk prints with Ctrl+P */ } }}>{t("ipdAdmit.band.print")}</button>
                    </div>
                  ) : selected.band === null && can("ipd.band.print") ? (
                    <button type="button" className="ipda-btn" disabled={busy} onClick={() => { void act(async () => { setBand(await printBand(selected.id, "adult", "wrist")); loadAdmission(selected.id); }); }}>{t("ipdAdmit.band.print")}</button>
                  ) : null}
                  {/* E1.3 (#720) — the attendant passes come next at the desk. */}
                  {can("passes.issue") ? (
                    <Link className="ipda-btn" to="/ipd/passes" search={{ admission: selected.id }}>{t("nav.ipdPasses")}</Link>
                  ) : null}
                </section>
              ) : (
                <button type="button" className="ipda-admit" disabled={!ready || busy} onClick={() => { void doAdmit(); }}>
                  {t("ipdAdmit.admitAndPrint")}
                </button>
              )}
            </div>

            <aside aria-label={t("ipdAdmit.estimate.title")} className="ipda-side">
              <div className="ipda-card">
                <h2>{t("ipdAdmit.estimate.head", { cls: quote?.label ?? selected.requestedClass, days: 3 })}</h2>
                {quote?.perDay ? (
                  <>
                    <div className="ipda-line"><span>{t("ipdAdmit.estimate.room")}</span><span className="mono">{fmtRupees(quote.perDay.room * 3)}</span></div>
                    <div className="ipda-line"><span>{t("ipdAdmit.estimate.nursing")}</span><span className="mono">{fmtRupees(quote.perDay.nursing * 3)}</span></div>
                    <div className="ipda-line"><span>{t("ipdAdmit.estimate.visit")}</span><span className="mono">{fmtRupees(quote.perDay.visit * 3)}</span></div>
                    <div className="ipda-line total"><span>{t("ipdAdmit.estimate.total")}</span><span className="mono">{quote.estimatePaise === null ? "—" : fmtRupees(quote.estimatePaise)}</span></div>
                    <div className="ipda-line strong"><span>{t("ipdAdmit.depositLabel")}</span><span className="mono">{required === null ? "—" : fmtRupees(required)}</span></div>
                  </>
                ) : <span className="dim">{quote ? t("ipdAdmit.rateMissing", { what: quote.missing.join(", ") }) : t("ipdAdmit.estimate.none")}</span>}
                <span className="dim small">{t("ipdAdmit.estimate.foot")}</span>
              </div>
              <div className="ipda-card">
                <h2>{t("ipdAdmit.checklist")}</h2>
                {([["advice", true], ["payer", planDone], ["bed", bedDone], ["consent", consentDone || selected.consent !== null], ["deposit", depositDone], ...(selected.icu ? [["icu", icuOk] as const] : [])] as const).map(([k, ok]) => (
                  <div key={k} className={`ipda-check${ok ? " ok" : ""}`}><i aria-hidden="true">{ok ? "✓" : "○"}</i>{t(`ipdAdmit.check.${k}`)}<span className="sr">{ok ? t("ipdAdmit.done") : t("ipdAdmit.todoWord")}</span></div>
                ))}
              </div>
            </aside>
          </div>
        </>
      ) : null}
      {band ? <div className="ipda-print-only"><BandPreview band={band.band} /></div> : null}
    </div>
  );
}

// ═══════════════════════════════════════ new request ═══════════════════════════════════════

function NewRequest({ onDone }: { onDone: (admissionId: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [patient, setPatient] = useState<{ id: string; name: string; uhid: string } | null>(null);
  const [advice, setAdvice] = useState<IpdAdvice[]>([]);
  const [consultants, setConsultants] = useState<Consultant[]>([]);
  const [fromAdvice, setFromAdvice] = useState<IpdAdvice | null>(null);
  const [consultantId, setConsultantId] = useState("");
  const [cls, setCls] = useState<IpdBedClass>("general");
  const [isolation, setIsolation] = useState<(typeof ISOLATIONS)[number]>("none");
  const [dx, setDx] = useState("");
  const [mlc, setMlc] = useState(false);
  const [error, setError] = useState<Refusal | null>(null);
  useEffect(() => {
    listAdvice().then(setAdvice, () => setAdvice([]));
    listConsultants().then(setConsultants, () => setConsultants([]));
  }, []);
  const pickAdvice = (a: IpdAdvice): void => {
    setFromAdvice(a); setPatient({ id: a.patientId, name: a.patientName ?? a.uhid, uhid: a.uhid });
    setConsultantId(a.doctorId); if (a.note) setDx(a.note);
  };
  const dept = useMemo(() => consultants.find((c) => c.userId === consultantId)?.department ?? undefined, [consultants, consultantId]);
  return (
    <section aria-label={t("ipdAdmit.newRequest")} className="ipda-card ipda-form">
      <h2>{t("ipdAdmit.newRequest")}</h2>
      {advice.length > 0 ? (
        <div className="ipda-advice">
          <span className="dim">{t("ipdAdmit.fromAdvice")}</span>
          {advice.map((a) => (
            <button key={a.encounterId} type="button" className={`ipda-chipbtn${fromAdvice?.encounterId === a.encounterId ? " on" : ""}`} onClick={() => pickAdvice(a)}>
              {a.patientName ?? a.uhid} · {a.doctorName} · {fmtIst(a.advisedAt)}
            </button>
          ))}
        </div>
      ) : <span className="dim small">{t("ipdAdmit.noAdvice")}</span>}
      {patient === null ? <PatientFind onPick={(p) => setPatient({ id: p.id, name: p.name, uhid: p.uhid })} /> : (
        <span className="ipda-picked">{patient.name} · <span className="mono">{patient.uhid}</span>
          <button type="button" className="ipda-btn sm quiet" onClick={() => { setPatient(null); setFromAdvice(null); }}>{t("ipdAdmit.change")}</button></span>
      )}
      <div className="ipda-grid">
        <label>{t("ipdAdmit.consultant")}
          <select value={consultantId} onChange={(e) => setConsultantId(e.target.value)}>
            <option value="">—</option>
            {consultants.map((c) => <option key={c.userId} value={c.userId}>{c.name}{c.department ? ` · ${c.department}` : ""}</option>)}
          </select>
        </label>
        <label>{t("ipdAdmit.roomClass")}
          <select value={cls} onChange={(e) => setCls(e.target.value as IpdBedClass)}>
            {CLASS_CHOICES.map((c) => <option key={c} value={c}>{t(`ipdBeds.class.${c}`)}</option>)}
          </select>
        </label>
        <label>{t("ipdAdmit.isolation")}
          <select value={isolation} onChange={(e) => setIsolation(e.target.value as typeof isolation)}>
            {ISOLATIONS.map((i) => <option key={i} value={i}>{t(`ipdAdmit.iso.${i}`)}</option>)}
          </select>
        </label>
        <label className="wide">{t("ipdAdmit.diagnosis")}<input value={dx} onChange={(e) => setDx(e.target.value)} /></label>
        <label className="ipda-tick"><input type="checkbox" checked={mlc} onChange={(e) => setMlc(e.target.checked)} />MLC</label>
      </div>
      <RefusalNote r={error} />
      <button type="button" className="ipda-btn pri" disabled={patient === null || consultantId === "" || dx.trim() === ""} onClick={() => {
        if (patient === null) return;
        setError(null);
        requestAdmission({
          patientId: patient.id, source: fromAdvice ? "opd_advice" : "direct", ...(fromAdvice ? { sourceRef: fromAdvice.encounterId } : {}),
          consultantId, requestedClass: cls, isolation, provisionalDiagnosis: dx.trim(), mlc, ...(dept ? { department: dept } : {}),
        }).then((r) => onDone(r.admissionId), (e) => setError(refusalText(e)));
      }}>{t("ipdAdmit.raise")}</button>
    </section>
  );
}

// ═══════════════════════════════════════ the emergency lane ═══════════════════════════════════════

function EmergencyLane({ onDone }: { onDone: (admissionId: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const beds = useFreeBeds();
  const [patient, setPatient] = useState<{ id: string; name: string; uhid: string } | null>(null);
  const [consultants, setConsultants] = useState<Consultant[]>([]);
  const [consultantId, setConsultantId] = useState("");
  const [bed, setBed] = useState("");
  const [mlc, setMlc] = useState(false);
  const [error, setError] = useState<Refusal | null>(null);
  const [icuAsk, setIcuAsk] = useState<{ approvalId: string; admissionId: string } | null>(null);
  useEffect(() => { listConsultants().then(setConsultants, () => setConsultants([])); }, []);
  const needsIcu = error !== null && "code" in error && error.code === "icu_needs_intensivist";
  return (
    <section aria-label={t("ipdAdmit.emergency.title")} className="ipda-card ipda-form ipda-er">
      <h2>{t("ipdAdmit.emergency.title")}</h2>
      <span className="dim small">{t("ipdAdmit.emergency.sub")}</span>
      {patient === null ? <PatientFind onPick={(p) => setPatient({ id: p.id, name: p.name, uhid: p.uhid })} /> : (
        <span className="ipda-picked">{patient.name} · <span className="mono">{patient.uhid}</span>
          <button type="button" className="ipda-btn sm quiet" onClick={() => setPatient(null)}>{t("ipdAdmit.change")}</button></span>
      )}
      <div className="ipda-grid">
        <label>{t("ipdAdmit.bed")}
          <select value={bed} onChange={(e) => setBed(e.target.value)}>
            <option value="">—</option>
            {beds.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </label>
        <label>{t("ipdAdmit.consultant")}
          <select value={consultantId} onChange={(e) => setConsultantId(e.target.value)}>
            <option value="">—</option>
            {consultants.map((c) => <option key={c.userId} value={c.userId}>{c.name}</option>)}
          </select>
        </label>
        <label className="ipda-tick"><input type="checkbox" checked={mlc} onChange={(e) => setMlc(e.target.checked)} />MLC</label>
      </div>
      <RefusalNote r={error} />
      {needsIcu && icuAsk === null && patient !== null ? (
        <button type="button" className="ipda-btn" onClick={() => {
          askEmergencyIcuApproval(patient.id, t("ipdAdmit.icu.note")).then(setIcuAsk, (e) => setError(refusalText(e)));
        }}>{t("ipdAdmit.icu.request")}</button>
      ) : null}
      {icuAsk !== null ? <span className="ipda-note warn">{t("ipdAdmit.icu.waiting")}</span> : null}
      <button type="button" className="ipda-admit danger" disabled={patient === null || bed === "" || consultantId === ""} onClick={() => {
        if (patient === null) return;
        setError(null);
        emergencyAdmit({ patientId: patient.id, bedId: bed, consultantId, isolation: "none", mlc, ...(icuAsk ? { admissionId: icuAsk.admissionId, intensivistApprovalId: icuAsk.approvalId } : {}) })
          .then((r) => onDone(r.admissionId), (e) => setError(refusalText(e)));
      }}>{t("ipdAdmit.emergency.admit")}</button>
    </section>
  );
}

// ═══════════════════════════════════════ downtime back-fill ═══════════════════════════════════════

const localToIso = (v: string): string => new Date(v).toISOString();

function DowntimeBackfill({ onDone }: { onDone: (admissionId: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const beds = useFreeBeds();
  const [patient, setPatient] = useState<{ id: string; name: string; uhid: string } | null>(null);
  const [consultants, setConsultants] = useState<Consultant[]>([]);
  const [f, setF] = useState({ serial: "", bed: "", consultantId: "", cls: "general" as IpdBedClass, dx: "", requestedAt: "", admittedAt: "", witness: "", payer: "cash" as IpdPayerKind });
  const [error, setError] = useState<Refusal | null>(null);
  useEffect(() => { listConsultants().then(setConsultants, () => setConsultants([])); }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const ok = patient !== null && f.serial && f.bed && f.consultantId && f.dx && f.requestedAt && f.admittedAt && f.witness;
  return (
    <section aria-label={t("ipdAdmit.downtime.title")} className="ipda-card ipda-form">
      <h2>{t("ipdAdmit.downtime.title")}</h2>
      <span className="dim small">{t("ipdAdmit.downtime.sub")}</span>
      {patient === null ? <PatientFind onPick={(p) => setPatient({ id: p.id, name: p.name, uhid: p.uhid })} /> : (
        <span className="ipda-picked">{patient.name} · <span className="mono">{patient.uhid}</span>
          <button type="button" className="ipda-btn sm quiet" onClick={() => setPatient(null)}>{t("ipdAdmit.change")}</button></span>
      )}
      <div className="ipda-grid">
        <label>{t("ipdAdmit.downtime.serial")}<input value={f.serial} onChange={set("serial")} /></label>
        <label>{t("ipdAdmit.bed")}<select value={f.bed} onChange={set("bed")}><option value="">—</option>{beds.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</select></label>
        <label>{t("ipdAdmit.roomClass")}<select value={f.cls} onChange={set("cls")}>{CLASS_CHOICES.map((c) => <option key={c} value={c}>{t(`ipdBeds.class.${c}`)}</option>)}</select></label>
        <label>{t("ipdAdmit.consultant")}<select value={f.consultantId} onChange={set("consultantId")}><option value="">—</option>{consultants.map((c) => <option key={c.userId} value={c.userId}>{c.name}</option>)}</select></label>
        <label>{t("ipdAdmit.payer")}<select value={f.payer} onChange={set("payer")}>{PAYERS.map((p) => <option key={p} value={p}>{t(`ipdAdmit.payerKind.${p}`)}</option>)}</select></label>
        <label>{t("ipdAdmit.downtime.requestedAt")}<input type="datetime-local" value={f.requestedAt} onChange={set("requestedAt")} /></label>
        <label>{t("ipdAdmit.downtime.admittedAt")}<input type="datetime-local" value={f.admittedAt} onChange={set("admittedAt")} /></label>
        <label className="wide">{t("ipdAdmit.diagnosis")}<input value={f.dx} onChange={set("dx")} /></label>
        <label>{t("ipdAdmit.witness")}<input value={f.witness} onChange={set("witness")} /></label>
      </div>
      <RefusalNote r={error} />
      <button type="button" className="ipda-btn pri" disabled={!ok} onClick={() => {
        if (patient === null) return;
        setError(null);
        backfillDowntime({
          paperSerial: f.serial.trim(), patientId: patient.id, bedId: f.bed, consultantId: f.consultantId, requestedClass: f.cls,
          isolation: "none", provisionalDiagnosis: f.dx.trim(), mlc: false, payerKind: f.payer,
          requestedAt: localToIso(f.requestedAt), admittedAt: localToIso(f.admittedAt),
          consent: { signedBy: "patient", method: "paper", witnessName: f.witness.trim() },
        }).then((r) => onDone(r.admissionId), (e) => setError(refusalText(e)));
      }}>{t("ipdAdmit.downtime.save")}</button>
    </section>
  );
}
