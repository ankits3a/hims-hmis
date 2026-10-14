import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdOrderView, IpdRoundPatient, IpdRoundView, IpdRoundsList, IpdRoundsRow, IpdConsultantChoice } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { useDebounced } from "../lib/format";
import {
  DOSE_UNITS, DRUG_ROUTES, FREQUENCIES, cancelOrder, closeConsult, cosignRound, getConsultants, getRoundPatient, getRoundsList, placeDrugOrder,
  placeTestOrder, refusalCode, refusalDetail, requestConsult, searchMedicines, signRound, stopOrder,
} from "../lib/ipd-rounds-api";
import type { DrugRoute, WireMedicineHit } from "../lib/ipd-rounds-api";
import { TestPicker } from "../components/test-picker";
import type { WireOrderableTest } from "../lib/ordering-api";
import { AllergyFlags } from "./ipd-emar-flags";
import "./ipd-rounds.css";

/*
 * E4.2 (#734) — ROUNDS, the doctor's phone or tablet and the ward desktop (spec §4.9 E).
 *
 *   /ipd/rounds                 my inpatients — own, unit, covering and consulted — sorted by need (not yet seen today
 *                               first, then day-one admissions); a boarded patient carries the ward it lies on.
 *   /ipd/rounds/$admissionId    the patient: one identity header, sign the round (S/O/A/P, bedside or remote), the plan
 *                               bar ("Fit for discharge today / tomorrow"), active orders, consults, the co-sign queue.
 *
 * NO MONEY ANYWHERE (decision 0058): nothing here shows a fee, a charge or whether a visit was charged. Refusals are worded
 * by their CODE (`ipdRounds.refused.<code>`), never the server's English. 1920 × 1080 / 1366 × 768 desktop, 390 px phone.
 */

const when = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(iso));

function Identity({ p, bed, ward, boarded, t }: {
  p: IpdRoundsRow["patient"]; bed: string | null; ward: string | null; boarded: boolean; t: (k: string, o?: Record<string, unknown>) => string;
}): React.ReactElement {
  const ageSex = [p.ageYears === null ? null : `${String(p.ageYears)}y`, p.sex === null ? null : p.sex.charAt(0).toUpperCase()].filter(Boolean).join(" ");
  return (
    <div className="ipdr-id">
      <b className="name">{p.sealed && p.name === "" ? t("ipdRounds.sealed") : p.name}</b>
      {ageSex !== "" ? <span className="dim">{ageSex}</span> : null}
      {p.uhid !== "" ? <span className="mono dim">{p.uhid}</span> : null}
      {bed !== null ? <span className="bed mono">{bed}</span> : null}
      {boarded && ward !== null ? <span className="chip boarded" title={t("ipdRounds.boardedHint")}>{t("ipdRounds.boardedOn", { ward })}</span> : null}
    </div>
  );
}

function useLoad<T>(fn: () => Promise<T>): { data: T | null; error: "forbidden" | "failed" | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<"forbidden" | "failed" | null>(null);
  const reload = useCallback(() => {
    fn().then((d) => { setData(d); setError(null); }, (e: unknown) => setError(e instanceof ApiError && e.status === 403 ? "forbidden" : "failed"));
  }, [fn]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, reload };
}

// ═══════════════════════════════════════ the list ═══════════════════════════════════════

export function IpdRounds(): React.ReactElement {
  const { t } = useTranslation();
  const { data, error, reload } = useLoad<IpdRoundsList>(getRoundsList);
  useEffect(() => { const id = setInterval(reload, 60_000); return () => clearInterval(id); }, [reload]);
  const pending = data?.rows.filter((r) => r.roundToday === "none" || r.roundToday === "draft").length ?? 0;
  return (
    <main className="ipdr" data-testid="ipd-rounds">
      <header className="ipdr-head">
        <h1>{t("ipdRounds.title")}</h1>
        {data !== null ? <span className="dim">{t("ipdRounds.counts", { total: data.rows.length, pending })}</span> : null}
      </header>
      {error === "forbidden" ? <div className="ipdr-empty" role="alert">{t("ipdRounds.forbidden")}</div> : null}
      {error === "failed" ? <div className="ipdr-empty warn" role="alert">{t("ipdRounds.failed")}</div> : null}
      {data === null && error === null ? <div className="ipdr-empty">{t("ipdRounds.loading")}</div> : null}
      {data !== null && data.cosignQueue.length > 0 ? (
        <section className="ipdr-cosign" aria-label={t("ipdRounds.cosignQueue")}>
          <h2>{t("ipdRounds.cosignQueue")} <span className="count">{data.cosignQueue.length}</span></h2>
          <ul>
            {data.cosignQueue.map((q) => (
              <li key={q.roundId}>
                <Link to="/ipd/rounds/$admissionId" params={{ admissionId: q.admissionId }} className="row-link">
                  <b>{q.patient.name}</b> <span className="mono dim">{q.bedCode ?? ""}</span>
                  <span className="dim">{t("ipdRounds.draftBy", { name: q.authorName, time: when(q.seenAt) })}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data !== null && data.rows.length === 0 && error === null ? <div className="ipdr-empty">{t("ipdRounds.empty")}</div> : null}
      <ul className="ipdr-list" aria-label={t("ipdRounds.title")}>
        {data?.rows.map((r) => (
          <li key={r.admissionId} className={`ipdr-card seen-${r.roundToday}`}>
            <Link to="/ipd/rounds/$admissionId" params={{ admissionId: r.admissionId }} className="row-link" data-testid="ipd-rounds-row">
              <Identity p={r.patient} bed={r.bedCode} ward={r.wardName ?? r.wardCode} boarded={r.boarded} t={t} />
              <div className="meta">
                <span className={`chip seen ${r.roundToday}`}>{t(`ipdRounds.today.${r.roundToday}`)}</span>
                <span className="chip">{t("ipdRounds.day", { n: r.dayOfStay })}</span>
                {r.why !== "own" ? <span className="chip why">{t(`ipdRounds.why.${r.why}`, { name: r.consultantName })}</span> : null}
                {r.fitWhen !== null ? <span className="chip fit">{t(`ipdRounds.fit.${r.fitWhen}`)}</span> : null}
                {r.activeOrders > 0 ? <span className="dim">{t("ipdRounds.activeOrders", { count: r.activeOrders })}</span> : null}
                {!r.boarded && r.wardName !== null ? <span className="dim ward">{r.wardName}</span> : null}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

// ═══════════════════════════════════════ the patient ═══════════════════════════════════════

export function IpdRoundPatientRoute(): React.ReactElement {
  const { admissionId } = useParams({ strict: false }) as { admissionId?: string };
  return <IpdRoundPatientScreen admissionId={admissionId ?? ""} />;
}

export function IpdRoundPatientScreen({ admissionId }: { admissionId: string }): React.ReactElement {
  const { t } = useTranslation();
  const load = useCallback(() => getRoundPatient(admissionId), [admissionId]);
  const { data: p, error, reload } = useLoad<IpdRoundPatient>(load);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (work: () => Promise<unknown>, after?: () => void, onError?: (e: unknown) => void): void => {
    setBusy(true); setRefused(null);
    work().then(() => { setBusy(false); after?.(); reload(); }, (e: unknown) => { setBusy(false); setRefused(refusalCode(e) ?? "failed"); onError?.(e); });
  };
  if (error !== null) return <main className="ipdr"><div className="ipdr-empty warn" role="alert">{t(error === "forbidden" ? "ipdRounds.forbidden" : "ipdRounds.failed")}</div></main>;
  if (p === null) return <main className="ipdr"><div className="ipdr-empty">{t("ipdRounds.loading")}</div></main>;
  const drafts = p.rounds.filter((r) => r.status === "awaiting_cosign");
  return (
    <main className="ipdr ipdr-patient" data-testid="ipd-round-patient">
      <nav className="ipdr-back"><Link to="/ipd/rounds">← {t("ipdRounds.title")}</Link></nav>
      <header className="ipdr-header">
        <Identity p={p.patient} bed={p.bedCode} ward={p.wardName} boarded={p.boarded} t={t} />
        <div className="meta">
          {p.admissionNo !== null ? <span className="mono">{p.admissionNo}</span> : null}
          <span className="chip">{t("ipdRounds.day", { n: p.dayOfStay })}</span>
          <span className="dim">{t("ipdRounds.under", { name: p.consultantName })}</span>
          {p.coveringName !== null ? <span className="chip why">{t("ipdRounds.coveredBy", { name: p.coveringName })}</span> : null}
          {p.fitWhen !== null ? <span className="chip fit">{t(`ipdRounds.fit.${p.fitWhen}`)}</span> : null}
          {p.boarded ? null : p.wardName !== null ? <span className="dim">{p.wardName}</span> : null}
        </div>
        <div className="alerts">{p.alerts.map((a) => <span key={a} className="chip alert">{a}</span>)}</div>
        {p.provisionalDiagnosis !== null ? <p className="dx"><span className="dim">{t("ipdRounds.dx")}</span> {p.provisionalDiagnosis}</p> : null}
      </header>
      {refused !== null ? <div className="ipdr-refused" role="alert">{t(`ipdRounds.refused.${refused}`, { defaultValue: t("ipdRounds.refused.failed") })}</div> : null}
      {/* E4.3 (#735): an allergy recorded after an order — the doctor decides here (stop / continue with a reason). */}
      <AllergyFlags admissionId={admissionId} onDecided={reload} />
      <div className="ipdr-cols">
        <div className="col main">
          {p.can.sign ? <SignRound p={p} busy={busy} act={act} /> : <div className="ipdr-empty small">{t("ipdRounds.notOnTeam")}</div>}
          {drafts.length > 0 ? (
            <section className="ipdr-panel" aria-label={t("ipdRounds.cosignQueue")}>
              <h2>{t("ipdRounds.cosignQueue")}</h2>
              {drafts.map((r) => (
                <RoundCard key={r.roundId} r={r}>
                  {p.can.cosign ? <button type="button" className="primary" disabled={busy} onClick={() => act(() => cosignRound(r.roundId))}>{t("ipdRounds.cosign")}</button> : null}
                </RoundCard>
              ))}
            </section>
          ) : null}
          <section className="ipdr-panel" aria-label={t("ipdRounds.history")}>
            <h2>{t("ipdRounds.history")}</h2>
            {p.rounds.filter((r) => r.status === "signed").length === 0 ? <p className="dim">{t("ipdRounds.noRounds")}</p> : null}
            {p.rounds.filter((r) => r.status === "signed").map((r) => <RoundCard key={r.roundId} r={r} />)}
          </section>
        </div>
        <div className="col side">
          <section className="ipdr-panel" aria-label={t("ipdRounds.vitals")}>
            <h2>{t("ipdRounds.vitals")}</h2>
            <p className="dim">{t("ipdRounds.vitalsPending")}</p>
          </section>
          <Orders p={p} busy={busy} act={act} />
          <Consults p={p} busy={busy} act={act} />
        </div>
      </div>
    </main>
  );
}

type Act = (work: () => Promise<unknown>, after?: () => void, onError?: (e: unknown) => void) => void;

function RoundCard({ r, children }: { r: IpdRoundView; children?: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const parts = (["subjective", "objective", "assessment", "plan"] as const).filter((k) => (r.soap[k] ?? "") !== "");
  return (
    <article className={`ipdr-round ${r.status}`}>
      <div className="top">
        <b>{r.authorName}</b>
        <span className="chip">{t(`ipdRounds.kind.${r.authorKind}`)}</span>
        <span className="chip">{t(`ipdRounds.mode.${r.mode}`)}</span>
        <span className="chip src" title={t("ipdRounds.sourceHint")}>{t(`ipdRounds.source.${r.source}`)}</span>
        <span className="mono dim when">{when(r.seenAt)}</span>
      </div>
      <dl>{parts.map((k) => <div key={k}><dt>{t(`ipdRounds.soap.${k}`).charAt(0)}</dt><dd>{r.soap[k]}</dd></div>)}</dl>
      {r.status === "awaiting_cosign" ? <span className="draft">{t("ipdRounds.draft")}</span> : null}
      {r.cosignedByName !== null ? <span className="dim small">{t("ipdRounds.cosignedBy", { name: r.cosignedByName })}</span> : null}
      {children}
    </article>
  );
}

function SignRound({ p, busy, act }: { p: IpdRoundPatient; busy: boolean; act: Act }): React.ReactElement {
  const { t } = useTranslation();
  const [soap, setSoap] = useState({ subjective: "", objective: "", assessment: "", plan: "" });
  const [mode, setMode] = useState<"bedside" | "remote_review">("bedside");
  const [fit, setFit] = useState<"today" | "tomorrow" | null>(null);
  const empty = Object.values(soap).every((v) => v.trim() === "");
  const submit = (): void => {
    const s = Object.fromEntries(Object.entries(soap).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
    act(() => signRound({
      admissionId: p.admissionId, seenAt: new Date().toISOString(), mode, soap: s,
      ...(fit !== null ? { fit: { when: fit, disposition: "home" } } : {}),
    }), () => { setSoap({ subjective: "", objective: "", assessment: "", plan: "" }); setFit(null); });
  };
  return (
    <section className="ipdr-panel ipdr-sign" aria-label={t("ipdRounds.signTitle")}>
      <h2>{t("ipdRounds.signTitle")}</h2>
      <div className="seg" role="group" aria-label={t("ipdRounds.modeLabel")}>
        {(["bedside", "remote_review"] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{t(`ipdRounds.mode.${m}`)}</button>
        ))}
      </div>
      {mode === "remote_review" ? <p className="dim small">{t("ipdRounds.remoteHint")}</p> : null}
      <div className="soap">
        {(["subjective", "objective", "assessment", "plan"] as const).map((k) => (
          <label key={k}>
            <span>{t(`ipdRounds.soap.${k}`)}</span>
            <textarea rows={2} value={soap[k]} onChange={(e) => setSoap({ ...soap, [k]: e.target.value })} aria-label={t(`ipdRounds.soap.${k}`)} />
          </label>
        ))}
      </div>
      {p.can.declareFit ? (
        <div className="plan-bar" role="group" aria-label={t("ipdRounds.fitLabel")}>
          <span className="dim">{t("ipdRounds.fitLabel")}</span>
          {(["today", "tomorrow"] as const).map((w) => (
            <button key={w} type="button" aria-pressed={fit === w} className={fit === w ? "on" : ""} onClick={() => setFit(fit === w ? null : w)}>
              {t(`ipdRounds.fitButton.${w}`)}
            </button>
          ))}
        </div>
      ) : null}
      <button type="button" className="primary big" disabled={busy || empty} onClick={submit} data-testid="ipd-round-sign">
        {fit !== null ? t("ipdRounds.signAndFit") : t("ipdRounds.sign")}
      </button>
    </section>
  );
}

function OrderRow({ o, can, busy, act }: { o: IpdOrderView; can: boolean; busy: boolean; act: Act }): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState<"stop" | "cancel" | null>(null);
  const canCancel = o.status === "active" && o.issuedAt === null;
  return (
    <li className={`ipdr-order ${o.status}`}>
      <div className="top">
        <span className={`chip kind ${o.kind}`}>{t(`ipdRounds.orderKind.${o.kind}`)}</span>
        <b className="title">{o.title}</b>
        {o.drug?.antibiotic ? <span className="chip abx">{t("ipdRounds.antibiotic")}</span> : null}
      </div>
      <div className="sub dim">
        {o.drug !== null ? <span>{o.drug.stopAt !== null ? t("ipdRounds.until", { time: when(o.drug.stopAt) }) : t("ipdRounds.forDays", { count: o.drug.durationDays ?? 0 })}</span> : null}
        <span>{t(`ipdRounds.orderStatus.${o.status}`)}</span>
        {o.verification !== null && o.status === "active" ? <span>{t(`ipdRounds.verification.${o.verification}`)}</span> : null}
        {o.returnOwed ? <span className="warn">{t("ipdRounds.returnOwed")}</span> : null}
        <span>{o.orderedByName}</span>
      </div>
      {can && o.status === "active" && o.kind === "drug" ? (
        open === null ? (
          <div className="acts">
            <button type="button" onClick={() => setOpen("stop")}>{t("ipdRounds.stop")}</button>
            {canCancel ? <button type="button" onClick={() => setOpen("cancel")}>{t("ipdRounds.cancelOrder")}</button> : null}
          </div>
        ) : (
          <div className="acts">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("ipdRounds.reason")} aria-label={t("ipdRounds.reason")} />
            <button type="button" className="primary" disabled={busy || reason.trim() === ""}
              onClick={() => act(() => (open === "stop" ? stopOrder(o.orderId, reason.trim()) : cancelOrder(o.orderId, reason.trim())), () => setOpen(null))}>
              {open === "stop" ? t("ipdRounds.stop") : t("ipdRounds.cancelOrder")}
            </button>
            <button type="button" onClick={() => setOpen(null)}>{t("ipdRounds.back")}</button>
          </div>
        )
      ) : null}
    </li>
  );
}

function Orders({ p, busy, act }: { p: IpdRoundPatient; busy: boolean; act: Act }): React.ReactElement {
  const { t } = useTranslation();
  const [adding, setAdding] = useState<"drug" | "tests" | null>(null);
  const active = p.orders.filter((o) => o.status === "active");
  const ended = p.orders.filter((o) => o.status !== "active").slice(0, 5);
  return (
    <section className="ipdr-panel" aria-label={t("ipdRounds.orders")}>
      <h2>{t("ipdRounds.orders")} <span className="count">{active.length}</span></h2>
      {p.can.order ? (
        <div className="seg add" role="group">
          <button type="button" aria-pressed={adding === "drug"} className={adding === "drug" ? "on" : ""} onClick={() => setAdding(adding === "drug" ? null : "drug")}>{t("ipdRounds.addDrug")}</button>
          <button type="button" aria-pressed={adding === "tests"} className={adding === "tests" ? "on" : ""} onClick={() => setAdding(adding === "tests" ? null : "tests")}>{t("ipdRounds.addTests")}</button>
        </div>
      ) : null}
      {adding === "drug" ? <DrugForm admissionId={p.admissionId} busy={busy} act={act} done={() => setAdding(null)} /> : null}
      {adding === "tests" ? <TestsForm admissionId={p.admissionId} busy={busy} act={act} done={() => setAdding(null)} /> : null}
      {active.length === 0 ? <p className="dim">{t("ipdRounds.noOrders")}</p> : null}
      <ul className="ipdr-orders">{active.map((o) => <OrderRow key={o.orderId} o={o} can={p.can.order} busy={busy} act={act} />)}</ul>
      {ended.length > 0 ? (
        <details className="ended"><summary>{t("ipdRounds.endedOrders", { count: ended.length })}</summary>
          <ul className="ipdr-orders">{ended.map((o) => <OrderRow key={o.orderId} o={o} can={false} busy={busy} act={act} />)}</ul>
        </details>
      ) : null}
    </section>
  );
}

function DrugForm({ admissionId, busy, act, done }: { admissionId: string; busy: boolean; act: Act; done: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const found = useQuery({ queryKey: ["ipd-rounds", "medicines", term], queryFn: () => searchMedicines(term), enabled: term.length >= 2 });
  const [med, setMed] = useState<WireMedicineHit | null>(null);
  const [dose, setDose] = useState("");
  const [unit, setUnit] = useState("mg");
  const [route, setRoute] = useState<DrugRoute>("oral");
  const [freq, setFreq] = useState<string>("BD");
  const [days, setDays] = useState("5");
  const [stop, setStop] = useState("");
  const [abx, setAbx] = useState(false);
  const [weight, setWeight] = useState("");
  const [gap, setGap] = useState("6");
  const [max24, setMax24] = useState("4");
  const [override, setOverride] = useState("");
  const [longWhy, setLongWhy] = useState("");
  const [allergy, setAllergy] = useState<string | null>(null);
  const value = Number(dose);
  const sos = freq === "SOS";
  const ok = med !== null && value > 0 && (stop !== "" || (!abx && Number(days) > 0)) && (!sos || (Number(gap) > 0 && Number(max24) > 0));
  const submit = (): void => {
    if (med === null) return;
    act(() => placeDrugOrder(admissionId, {
      itemId: med.id, dose: { value, unit }, route, frequency: freq, startAt: new Date().toISOString(), antibiotic: abx,
      ...(stop !== "" ? { stopAt: new Date(`${stop}T23:59:00+05:30`).toISOString() } : { durationDays: Number(days) }),
      ...(sos ? { prn: { minIntervalMinutes: Number(gap) * 60, max24h: Number(max24) } } : {}),
      ...(Number(weight) > 0 ? { weightKg: Number(weight) } : {}),
      ...(override.trim() !== "" ? { allergyOverrideReason: override.trim() } : {}),
      ...(longWhy.trim() !== "" ? { longCourseReason: longWhy.trim() } : {}),
    }), done, (e) => {
      // CPOE: an allergy conflict names the substances; the doctor may order through it only with a reason.
      if (refusalCode(e) === "allergy_conflict") setAllergy(((refusalDetail(e)?.substances as string[] | undefined) ?? []).join(", "));
    });
  };
  return (
    <div className="ipdr-form" data-testid="ipd-drug-form">
      {med === null ? (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ipdRounds.drugSearch")} aria-label={t("ipdRounds.drugSearch")} />
          <ul className="hits">
            {(found.data ?? []).map((m) => (
              <li key={m.id}><button type="button" onClick={() => setMed(m)}><b>{m.name}</b> <span className="dim">{[m.strength, m.form].filter(Boolean).join(" · ")}</span></button></li>
            ))}
          </ul>
        </>
      ) : (
        <div className="picked"><b>{med.name}</b> <span className="dim">{med.strength ?? ""}</span> <button type="button" onClick={() => setMed(null)}>{t("ipdRounds.change")}</button></div>
      )}
      <div className="grid">
        <label><span>{t("ipdRounds.dose")}</span><input inputMode="decimal" value={dose} onChange={(e) => setDose(e.target.value)} /></label>
        <label><span>{t("ipdRounds.unit")}</span>
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>{DOSE_UNITS.map((u) => <option key={u}>{u}</option>)}</select>
        </label>
        <label><span>{t("ipdRounds.route")}</span>
          <select value={route} onChange={(e) => setRoute(e.target.value as DrugRoute)}>{DRUG_ROUTES.map((r) => <option key={r} value={r}>{t(`ipdRounds.routes.${r}`)}</option>)}</select>
        </label>
        <label><span>{t("ipdRounds.frequency")}</span>
          <select value={freq} onChange={(e) => setFreq(e.target.value)}>{FREQUENCIES.map((f) => <option key={f}>{f}</option>)}</select>
        </label>
        <label><span>{t("ipdRounds.days")}</span><input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} disabled={stop !== ""} /></label>
        <label><span>{t("ipdRounds.stopDate")}</span><input type="date" value={stop} onChange={(e) => setStop(e.target.value)} /></label>
        <label><span>{t("ipdRounds.weight")}</span><input inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} /></label>
        {sos ? <label><span>{t("ipdRounds.prnGap")}</span><input inputMode="numeric" value={gap} onChange={(e) => setGap(e.target.value)} /></label> : null}
        {sos ? <label><span>{t("ipdRounds.prnMax")}</span><input inputMode="numeric" value={max24} onChange={(e) => setMax24(e.target.value)} /></label> : null}
      </div>
      <label className="check"><input type="checkbox" checked={abx} onChange={(e) => setAbx(e.target.checked)} /> {t("ipdRounds.antibiotic")}</label>
      {abx && stop === "" ? <p className="warn small">{t("ipdRounds.refused.antibiotic_stop_date_required")}</p> : null}
      {abx ? <input value={longWhy} onChange={(e) => setLongWhy(e.target.value)} placeholder={t("ipdRounds.longCourse")} aria-label={t("ipdRounds.longCourse")} /> : null}
      {allergy ? (
        <div className="allergy-hit" role="alert">
          <b>{t("ipdRounds.allergyHit", { substances: allergy })}</b>
          <input value={override} onChange={(e) => setOverride(e.target.value)} placeholder={t("ipdRounds.overrideReason")} aria-label={t("ipdRounds.overrideReason")} />
        </div>
      ) : null}
      <button type="button" className="primary" disabled={busy || !ok} onClick={submit}>{t("ipdRounds.placeOrder")}</button>
    </div>
  );
}

function TestsForm({ admissionId, busy, act, done }: { admissionId: string; busy: boolean; act: Act; done: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<WireOrderableTest[]>([]);
  const [why, setWhy] = useState("");
  const send = (): void => {
    const groups = (["lab", "imaging"] as const).map((d) => [d, picked.filter((p) => p.department === d).map((p) => p.serviceId)] as const).filter(([, ids]) => ids.length > 0);
    act(async () => { for (const [d, ids] of groups) await placeTestOrder(admissionId, d, ids, why.trim()); }, done);
  };
  const orderable = picked.filter((p) => p.department === "lab" || p.department === "imaging");
  return (
    <div className="ipdr-form" data-testid="ipd-tests-form">
      <TestPicker picked={picked.map((p) => p.serviceId)} onPick={(x) => setPicked([...picked, x])} />
      <ul className="picked-tests">
        {picked.map((x) => (
          <li key={x.serviceId}>
            <span className={`chip kind ${x.department}`}>{t(`testPicker.dept.${x.department}`, { defaultValue: x.department })}</span> {x.name}
            {x.department === "outside" ? <span className="dim small"> · {t("ipdRounds.outside")}</span> : null}
            <button type="button" onClick={() => setPicked(picked.filter((p) => p.serviceId !== x.serviceId))} aria-label={t("ipdRounds.remove")}>×</button>
          </li>
        ))}
      </ul>
      <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder={t("ipdRounds.indication")} aria-label={t("ipdRounds.indication")} />
      <button type="button" className="primary" disabled={busy || orderable.length === 0 || why.trim() === ""} onClick={send}>{t("ipdRounds.placeOrder")}</button>
    </div>
  );
}

function Consults({ p, busy, act }: { p: IpdRoundPatient; busy: boolean; act: Act }): React.ReactElement {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [who, setWho] = useState("");
  const [question, setQuestion] = useState("");
  const [urgent, setUrgent] = useState(false);
  const { data: choices } = useQuery<IpdConsultantChoice[]>({ queryKey: ["ipd-rounds", "consultants"], queryFn: getConsultants, enabled: asking });
  const open = p.consults.filter((c) => c.status === "open");
  return (
    <section className="ipdr-panel" aria-label={t("ipdRounds.consults")}>
      <h2>{t("ipdRounds.consults")} <span className="count">{open.length}</span></h2>
      {open.map((c) => (
        <div key={c.consultId} className="ipdr-consult">
          <b>{c.consultantName}</b> {c.urgency === "urgent" ? <span className="chip alert">{t("ipdRounds.urgent")}</span> : null}
          <q>{c.question}</q>
          <span className="dim small">{t("ipdRounds.askedBy", { name: c.requestedByName, time: when(c.requestedAt) })}</span>
          {p.can.sign ? <button type="button" disabled={busy} onClick={() => act(() => closeConsult(c.consultId))}>{t("ipdRounds.closeConsult")}</button> : null}
        </div>
      ))}
      {p.can.sign && !asking ? <button type="button" onClick={() => setAsking(true)}>{t("ipdRounds.askColleague")}</button> : null}
      {asking ? (
        <div className="ipdr-form">
          <select value={who} onChange={(e) => setWho(e.target.value)} aria-label={t("ipdRounds.consultant")}>
            <option value="">{t("ipdRounds.consultant")}</option>
            {(choices ?? []).map((c) => <option key={c.userId} value={c.userId}>{c.name}{c.department !== null ? ` · ${c.department}` : ""}</option>)}
          </select>
          <textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t("ipdRounds.question")} aria-label={t("ipdRounds.question")} />
          <label className="check"><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> {t("ipdRounds.urgent")}</label>
          <div className="acts">
            <button type="button" className="primary" disabled={busy || who === "" || question.trim() === ""}
              onClick={() => act(() => requestConsult({ admissionId: p.admissionId, consultantId: who, question: question.trim(), urgency: urgent ? "urgent" : "routine" }), () => { setAsking(false); setQuestion(""); })}>
              {t("ipdRounds.sendConsult")}
            </button>
            <button type="button" onClick={() => setAsking(false)}>{t("ipdRounds.back")}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
