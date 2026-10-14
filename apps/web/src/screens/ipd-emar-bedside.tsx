import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdEmarDose, IpdEmarDueItem, IpdEmarOrderLine, IpdEmarPatient, IpdEmarScan, IpdRefusalBody } from "@hmis/contracts";
import { fmtIst } from "../lib/format";
import { refusalOf } from "../lib/ipd-beds-api";
import { getEmarPatient, give, hold, infusion, miss, refuse, reoffer, scan, secondCheck, wastage } from "../lib/ipd-emar-api";
import type { PatientCheck } from "../lib/ipd-emar-api";
import "./ipd-emar.css";

/**
 * E4.3 (#735) — BOARD D2, THE BEDSIDE on the nurse's phone (spec §4.9 D; §4.6; §4.10 edges 6–9, 23). 390 px, one hand,
 * gloves: 48 px targets, the acts in the thumb zone, text that still fits at 130 %.
 *
 * Scan the wristband → the screen pivots to THAT patient (full identity header, a short vibration; never silently keeps the
 * previous patient, edge 7). Scan the drug's label → the five checks (patient, drug, dose, time, route) → Give. High-alert:
 * hold to confirm + a second nurse's username and PIN. LASA: the tall-man name, confirmed. A band that will not scan: an
 * override with its reason (counted). A started give expires after 5 minutes ("Not given — scan again", edge 8).
 *
 * OFFLINE (§0B): doses never queue. Give, Hold, Refuse and Miss are off, with "No network — use paper MAR".
 */

const GIVE_EXPIRES_MS = 5 * 60_000;
const HOLD_MS = 900;
type Started = { scan: IpdEmarScan; at: number };

export function DueDoses({ items, now, onOpen }: { items: IpdEmarDueItem[]; now: number; onOpen: (admissionId: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section aria-label={t("ipdEmar.due.title")}>
      <h2 className="ipdn-h2">{t("ipdEmar.due.title")}</h2>
      {items.length === 0 ? <div className="ipdn-empty">{t("ipdEmar.due.none")}</div> : null}
      <ul className="ipdn-now" data-testid="ipde-due">
        {items.map((d) => {
          const late = d.status === "missed" || new Date(d.dueAt).getTime() < now;
          return (
            <li key={d.doseId} className={`k-dose${late ? " late" : ""}`}>
              <button type="button" className="ipdn-nowbtn" onClick={() => onOpen(d.admissionId)} data-testid={`ipde-due-${d.doseId}`}>
                <span className="bed mono">{d.bedCode ?? "—"}</span>
                <span className="nm">{d.name}</span>
                <span className="what">
                  {d.highAlert ? "⚠ " : ""}{d.title} · {fmtIst(d.dueAt)}{d.status === "missed" ? ` · ${t("ipdEmar.status.missed")}` : late ? ` · ${t("ipdEmar.due.late")}` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The scan box: a hardware scanner types into it and ends with Enter; typing is the fallback. */
export function ScanBox({ label, onCode, testId }: { label: string; onCode: (code: string) => void; testId: string }): React.ReactElement {
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <form className="ipde-scan" onSubmit={(e) => { e.preventDefault(); if (v.trim() !== "") { onCode(v.trim()); setV(""); } }}>
      <label>{label}
        <input ref={ref} value={v} onChange={(e) => setV(e.target.value)} autoComplete="off" inputMode="text" data-testid={testId} />
      </label>
      <button type="submit" className="ipdn-btn pri">↵</button>
    </form>
  );
}

/** A press-and-hold button (gloves: no small checkbox, edge 23). */
function HoldButton({ label, onDone, disabled, testId }: { label: string; onDone: () => void; disabled?: boolean; testId: string }): React.ReactElement {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [held, setHeld] = useState(false);
  const stop = (): void => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; setHeld(false); };
  return (
    <button type="button" className={`ipdn-btn wide ipde-hold${held ? " on" : ""}`} disabled={disabled} data-testid={testId}
      onPointerDown={() => { setHeld(true); timer.current = setTimeout(() => { stop(); onDone(); }, HOLD_MS); }}
      onPointerUp={stop} onPointerLeave={stop}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onDone(); } }}>
      {label}
    </button>
  );
}

function buzz(): void { try { navigator.vibrate?.(80); } catch { /* not a phone */ } }

const CHECK_KEYS = ["patient", "drug", "dose", "time", "route"] as const;

export function Bedside({ admissionId, bandCode, online, onBack, onDone, onPivot }: {
  admissionId: string; bandCode: string | null; online: boolean; onBack: () => void; onDone: (words: string) => void;
  onPivot: (admissionId: string, bandCode: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [mar, setMar] = useState<IpdEmarPatient | null>(null);
  const [started, setStarted] = useState<Started | null>(null);
  const [labelCode, setLabelCode] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState<PatientCheck | null>(null);
  const [lasaOk, setLasaOk] = useState(false);
  const [lateReason, setLateReason] = useState("");
  const [second, setSecond] = useState<{ userId: string; pinProof: string; name: string } | null>(null);
  const [weight, setWeight] = useState("");
  const [npoReason, setNpoReason] = useState("");
  const [npoDoctor, setNpoDoctor] = useState("");
  const [outcome, setOutcome] = useState<{ kind: "hold" | "refuse" | "miss"; dose: IpdEmarDose } | null>(null);
  const load = useCallback(() => getEmarPatient(admissionId).then(setMar, () => setMar(null)), [admissionId]);
  useEffect(() => { void load(); setStarted(null); setSecond(null); setOverride(null); setLasaOk(false); }, [load]);
  useEffect(() => {
    if (started === null) return;
    const id = setTimeout(() => { setStarted(null); setExpired(true); setSecond(null); }, GIVE_EXPIRES_MS);
    return () => clearTimeout(id);
  }, [started]);

  const onBand = (code: string): void => {
    setRefusal(null);
    scan({ wristbandCode: code }).then((s) => { buzz(); onPivot(s.admissionId, code); }, (e: unknown) => setRefusal(refusalOf(e)));
  };
  const onLabel = (code: string): void => {
    setRefusal(null); setExpired(false);
    const body = bandCode !== null ? { wristbandCode: bandCode, labelCode: code } : { admissionId, labelCode: code };
    scan(body).then((s) => {
      if (s.admissionId !== admissionId) { buzz(); onPivot(s.admissionId, bandCode ?? ""); return; }
      buzz(); setStarted({ scan: s, at: Date.now() }); setLabelCode(code); setLasaOk(false); setSecond(null);
    }, (e: unknown) => setRefusal(refusalOf(e)));
  };
  const label = started?.scan.label ?? null;
  const patientCheck: PatientCheck | null = bandCode !== null && bandCode !== "" ? { kind: "scan", wristbandCode: bandCode } : override;
  const weightKg = Number(weight);
  const weightOk = !label?.needs.weight || (weight.trim() !== "" && Number.isFinite(weightKg) && weightKg > 0 && weightKg <= 400);
  const npoOk = label === null || label.needs.npo === "none" || (npoReason.trim() !== "" && (label.needs.npo === "sips" || npoDoctor.trim() !== ""));
  const ready = label !== null && label.checks.every((c) => c.ok || (c.key === "time" && label.needs.lateReason)) && patientCheck !== null
    && (!label.needs.lasaConfirm || lasaOk) && (!label.needs.secondNurse || second !== null) && (!label.needs.lateReason || lateReason.trim() !== "")
    && weightOk && npoOk;
  const missing = label === null ? [] : [
    patientCheck === null ? t("ipdEmar.bedside.scanBand") : null,
    label.needs.secondNurse && second === null ? t("ipdEmar.second.title") : null,
    label.needs.lasaConfirm && !lasaOk ? "LASA" : null,
    label.needs.lateReason && lateReason.trim() === "" ? t("ipdEmar.lateReason") : null,
    !weightOk ? t("ipdEmar.weight") : null,
    !npoOk ? "NPO" : null,
  ].filter((x): x is string => x !== null);
  const doGive = (): void => {
    if (label === null || patientCheck === null || started === null) return;
    if (Date.now() - started.at > GIVE_EXPIRES_MS) { setStarted(null); setExpired(true); return; }
    const dueAt = label.dose?.dueAt ?? new Date().toISOString();
    setBusy(true); setRefusal(null);
    give({
      orderId: label.orderId, doseDueAt: dueAt, patientCheck, labelCode: labelCode ?? "",
      ...(second !== null ? { secondNurse: { userId: second.userId, pinProof: second.pinProof } } : {}),
      ...(label.needs.lasaConfirm ? { lasaConfirmed: true as const } : {}),
      ...(label.needs.lateReason ? { lateReason: lateReason.trim() } : {}),
      ...(label.needs.weight ? { weightKg } : {}),
      ...(label.needs.npo === "sips" ? { npoMeds: { kind: "sips_allowed" as const, reason: npoReason.trim() } } : {}),
      ...(label.needs.npo === "doctor" ? { npoMeds: { kind: "doctor_ok" as const, doctorId: npoDoctor.trim(), readBack: true as const, reason: npoReason.trim() } } : {}),
    }).then((r) => {
      setBusy(false); setStarted(null); setSecond(null); setLateReason("");
      onDone(r.late ? t("ipdEmar.given.late") : t("ipdEmar.given.ok")); void load();
    }, (e: unknown) => { setBusy(false); setRefusal(refusalOf(e)); });
  };

  if (mar === null) return <div className="ipdn-empty">{t("ipdNursing.loading")}</div>;
  const open = mar.doses.filter((d) => d.status === "scheduled" || d.status === "missed");
  const held = mar.doses.filter((d) => d.status === "held" && d.reoffer);
  const byOrder = new Map(mar.orders.map((o) => [o.orderId, o] as const));
  return (
    <section className="ipdn-pane ipde-bedside" aria-label={t("ipdEmar.bedside.title")} data-testid="ipde-bedside">
      <div className="ipdn-idhead" data-testid="ipde-idhead">
        <b className="ipde-name">{mar.identity.name}</b>
        <span className="dim"> {[mar.identity.sex === null ? null : mar.identity.sex.slice(0, 1).toUpperCase(), mar.identity.ageYears === null ? null : String(mar.identity.ageYears)].filter(Boolean).join(" ")}</span>
        <div className="dim">{[mar.bedCode, mar.identity.uhid ? `UHID ${mar.identity.uhid}` : null, mar.admissionNo].filter(Boolean).join(" · ")}</div>
        <div className="ipdn-chiprow">
          {mar.alerts.map((a) => <span key={a} className={`ipdn-tag${a.endsWith("none recorded") ? "" : " c-allergy"}`}>{a.endsWith("none recorded") ? "" : "⚠ "}{a}</span>)}
          {mar.npo ? <span className="ipdn-tag c-allergy">✕ NPO</span> : null}
          {mar.weightKg !== null ? <span className="ipdn-tag">{mar.weightKg} kg</span> : null}
          <span className={`ipdn-tag${bandCode ? "" : " c-allergy"}`}>{bandCode ? `✓ ${t("ipdEmar.bedside.bandScanned")}` : t("ipdEmar.bedside.bandNotScanned")}</span>
        </div>
      </div>
      {!online ? <p className="ipdn-warn ipde-offline" role="alert" data-testid="ipde-offline">⚠ {t("ipdEmar.offline")}</p> : null}
      {expired ? <p className="ipdn-warn" role="alert">{t("ipdEmar.expired")}</p> : null}

      {!bandCode && override === null ? (
        <div className="ipde-step">
          <ScanBox label={t("ipdEmar.bedside.scanBand")} onCode={onBand} testId="ipde-band-input" />
          <OverrideForm onSet={setOverride} />
        </div>
      ) : null}

      {label === null ? (
        <>
          <h2 className="ipdn-h2">{t("ipdEmar.bedside.due")}</h2>
          {open.length === 0 ? <div className="ipdn-empty">{t("ipdEmar.due.none")}</div> : null}
          <ul className="ipdn-cards">
            {open.map((d) => <DoseCard key={d.doseId} d={d} o={byOrder.get(d.orderId)} online={online} onOutcome={(kind) => setOutcome({ kind, dose: d })} />)}
          </ul>
          {mar.orders.filter((o) => o.prn !== null && o.status === "active").map((o) => (
            <div key={o.orderId} className="ipdn-card ipde-prn">
              <b>{o.title}</b> <span className="dim">{o.doseWords}</span>
              <span>{o.prnNextAt === null ? t("ipdEmar.prn.now") : t("ipdEmar.prn.next", { time: fmtIst(o.prnNextAt) })} · {t("ipdEmar.prn.in24h", { n: o.prnGiven24h, max: o.prn!.max24h })}</span>
            </div>
          ))}
          {mar.orders.filter((o) => o.status !== "cancelled" && (o.infusion === "running" || o.infusion === "paused")).map((o) => (
            <InfusionRow key={o.orderId} o={o} online={online} onDone={(w) => { onDone(w); void load(); }} />
          ))}
          {mar.orders.filter((o) => o.narcotic && o.issued).map((o) => (
            <WastageForm key={o.orderId} o={o} online={online} onDone={(w) => { onDone(w); void load(); }} />
          ))}
          {held.length > 0 ? (
            <div className="ipdn-card">
              <span>{t("ipdEmar.heldCount", { count: held.length })}</span>
              <div className="ipdn-acts">
                <button type="button" className="ipdn-btn" disabled={!online || busy} onClick={() => { reoffer(admissionId, "back_on_ward").then((r) => { onDone(t("ipdEmar.reoffered", { count: r.reoffered })); void load(); }, (e: unknown) => setRefusal(refusalOf(e))); }}>{t("ipdEmar.reoffer.back")}</button>
                <button type="button" className="ipdn-btn" disabled={!online || busy} onClick={() => { reoffer(admissionId, "npo_lifted").then((r) => { onDone(t("ipdEmar.reoffered", { count: r.reoffered })); void load(); }, (e: unknown) => setRefusal(refusalOf(e))); }}>{t("ipdEmar.reoffer.npo")}</button>
              </div>
            </div>
          ) : null}
          {outcome !== null ? <OutcomeForm o={outcome} order={byOrder.get(outcome.dose.orderId)} online={online} onCancel={() => setOutcome(null)}
            onDone={(w) => { setOutcome(null); onDone(w); void load(); }} /> : null}
        </>
      ) : (
        <div className="ipde-checks" data-testid="ipde-checks">
          <div className="ipde-drug">
            <b>{label.order.tallMan ?? label.order.title}</b>
            {label.order.highAlert ? <span className="ipdn-tag c-allergy">⚠ {t("ipdEmar.highAlert")}</span> : null}
            {label.order.lasa ? <span className="ipdn-tag c-fall_risk">◆ LASA</span> : null}
          </div>
          <ul className="ipde-five">
            {CHECK_KEYS.map((k) => {
              const c = label.checks.find((x) => x.key === k)!;
              return <li key={k} className={c.ok ? "ok" : "bad"} data-testid={`ipde-check-${k}`}><span aria-hidden>{c.ok ? "✓" : "✕"}</span><b>{t(`ipdEmar.check.${k}`)}</b><span>{c.words}</span></li>;
            })}
          </ul>
          {label.needs.lasaConfirm ? (
            <label className="ipdn-check ipde-lasa">
              <input type="checkbox" checked={lasaOk} onChange={(e) => setLasaOk(e.target.checked)} data-testid="ipde-lasa" /> {t("ipdEmar.lasaConfirm", { name: label.order.tallMan ?? label.order.title })}
            </label>
          ) : null}
          {label.needs.lateReason ? (
            <label className="ipde-field">{t("ipdEmar.lateReason")}<input value={lateReason} onChange={(e) => setLateReason(e.target.value)} data-testid="ipde-late" /></label>
          ) : null}
          {label.needs.weight ? (
            <label className="ipde-field">{t("ipdEmar.weight")}<input value={weight} onChange={(e) => setWeight(e.target.value)} inputMode="decimal" data-testid="ipde-weight" /></label>
          ) : null}
          {label.needs.npo !== "none" ? (
            <div className="ipdn-card ipde-npo" data-testid="ipde-npo">
              <b>✕ NPO · {label.needs.npo === "sips" ? t("ipdEmar.npo.sips") : t("ipdEmar.npo.doctor")}</b>
              {label.needs.npo === "doctor" ? <label className="ipde-field">{t("ipdEmar.npo.doctorId")}<input value={npoDoctor} onChange={(e) => setNpoDoctor(e.target.value)} /></label> : null}
              <label className="ipde-field">{t("ipdEmar.reason")}<input value={npoReason} onChange={(e) => setNpoReason(e.target.value)} data-testid="ipde-npo-reason" /></label>
            </div>
          ) : null}
          {label.needs.secondNurse ? (second === null ? <SecondNurse online={online} target={{ orderId: label.orderId, ...(label.dose !== null && !label.dose.prn ? { doseDueAt: label.dose.dueAt } : {}) }} onProof={setSecond} /> : <p className="ipdn-ok">✓ {t("ipdEmar.second.done", { name: second.name })}</p>) : null}
          {label.order.route === "iv" && patientCheck !== null && labelCode !== null ? (
            <InfusionStart o={label.order} online={online} patientCheck={patientCheck} labelCode={labelCode}
              onDone={(w) => { setStarted(null); setSecond(null); onDone(w); void load(); }} />
          ) : null}
          {!ready && missing.length > 0 ? <p className="ipdn-warn" data-testid="ipde-needs">{t("ipdEmar.needs", { what: missing.join(" · ") })}</p> : null}
          <div className="ipdn-thumb ipde-thumb">
            {label.order.highAlert
              ? <HoldButton label={online ? t("ipdEmar.give.hold") : t("ipdEmar.offlineShort")} onDone={doGive} disabled={!online || !ready || busy} testId="ipde-give" />
              : <button type="button" className="ipdn-btn pri wide" disabled={!online || !ready || busy} onClick={doGive} data-testid="ipde-give">{online ? t("ipdEmar.give.btn") : t("ipdEmar.offlineShort")}</button>}
            <button type="button" className="ipdn-btn wide" onClick={() => setStarted(null)}>{t("ipdNursing.cancel")}</button>
          </div>
        </div>
      )}

      {refusal !== null ? <div className="ipdn-refusal" role="alert" data-testid="ipde-refusal">{refusal.rule} <b>{refusal.fix}</b></div> : null}
      {label === null ? (
        <footer className="ipdn-thumb ipde-thumb">
          <ScanBox label={t("ipdEmar.bedside.scanLabel")} onCode={onLabel} testId="ipde-label-input" />
          <button type="button" className="ipdn-btn wide" onClick={onBack}>{t("ipdNursing.back")}</button>
        </footer>
      ) : null}
    </section>
  );
}

function DoseCard({ d, o, online, onOutcome }: { d: IpdEmarDose; o: IpdEmarOrderLine | undefined; online: boolean; onOutcome: (k: "hold" | "refuse" | "miss") => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <li className={`ipdn-card ipde-dose s-${d.status}`} data-testid={`ipde-dose-${d.doseId}`}>
      <div><b>{o?.tallMan ?? o?.title ?? "—"}</b> {o?.highAlert ? <span className="ipdn-tag c-allergy">⚠ {t("ipdEmar.highAlert")}</span> : null}</div>
      <div className="dim">{o?.doseWords} · {t("ipdEmar.dueAt", { time: fmtIst(d.dueAt) })} ({fmtIst(d.windowStart)}–{fmtIst(d.windowEnd)}){d.status === "missed" ? ` · ${t("ipdEmar.status.missed")}` : ""}</div>
      <div className="ipdn-acts">
        <button type="button" className="ipdn-btn sm" disabled={!online} onClick={() => onOutcome("hold")}>{t("ipdEmar.act.hold")}</button>
        <button type="button" className="ipdn-btn sm" disabled={!online} onClick={() => onOutcome("refuse")}>{t("ipdEmar.act.refuse")}</button>
        <button type="button" className="ipdn-btn sm" disabled={!online || d.status === "missed"} onClick={() => onOutcome("miss")}>{t("ipdEmar.act.miss")}</button>
      </div>
    </li>
  );
}

const REASONS = {
  hold: ["npo", "off_ward", "parameter_out_of_range", "clinical_hold", "doctor_instruction"],
  refuse: ["patient_refused", "vomited", "other"],
  miss: ["no_stock", "patient_away", "omitted", "other"],
} as const;

function OutcomeForm({ o, order, online, onCancel, onDone }: {
  o: { kind: "hold" | "refuse" | "miss"; dose: IpdEmarDose }; order: IpdEmarOrderLine | undefined; online: boolean; onCancel: () => void; onDone: (w: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState<string>(REASONS[o.kind][0]);
  const [note, setNote] = useState("");
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const send = (): void => {
    const fn = o.kind === "hold" ? hold : o.kind === "refuse" ? refuse : miss;
    fn(o.dose.orderId, o.dose.dueAt, reason, note.trim() || undefined).then(() => onDone(t(`ipdEmar.done.${o.kind}`)), (e: unknown) => setRefusal(refusalOf(e)));
  };
  return (
    <form className="ipdn-form ipdn-card" onSubmit={(e) => { e.preventDefault(); send(); }} data-testid="ipde-outcome">
      <b>{t(`ipdEmar.act.${o.kind}`)} · {order?.title}</b>
      <label>{t("ipdEmar.reason")}
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          {REASONS[o.kind].map((r) => <option key={r} value={r}>{t(`ipdEmar.reasons.${r}`)}</option>)}
        </select>
      </label>
      <label>{t("ipdEmar.note")}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal.rule}</div> : null}
      <div className="ipdn-acts">
        <button type="button" className="ipdn-btn" onClick={onCancel}>{t("ipdNursing.cancel")}</button>
        <button type="submit" className="ipdn-btn pri" disabled={!online}>{t("ipdEmar.save")}</button>
      </div>
    </form>
  );
}

function OverrideForm({ onSet }: { onSet: (c: PatientCheck) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<"band_unreadable" | "band_refused" | "no_band_burns" | "scanner_down">("band_unreadable");
  const [note, setNote] = useState("");
  if (!open) return <button type="button" className="ipdn-btn" onClick={() => setOpen(true)} data-testid="ipde-override-open">{t("ipdEmar.override.open")}</button>;
  return (
    <div className="ipdn-form ipdn-card" data-testid="ipde-override">
      <p className="ipdn-warn">{t("ipdEmar.override.counted")}</p>
      <label>{t("ipdEmar.reason")}
        <select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
          {(["band_unreadable", "band_refused", "no_band_burns", "scanner_down"] as const).map((r) => <option key={r} value={r}>{t(`ipdEmar.override.${r}`)}</option>)}
        </select>
      </label>
      <label>{t("ipdEmar.note")}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <button type="button" className="ipdn-btn pri" disabled={note.trim() === ""} onClick={() => onSet({ kind: "override", overrideReason: reason, note: note.trim() })}>{t("ipdEmar.override.use")}</button>
    </div>
  );
}

function SecondNurse({ online, target, onProof, purpose = "high_alert_dose" }: {
  online: boolean; target: { orderId: string; doseDueAt?: string }; onProof: (p: { userId: string; pinProof: string; name: string }) => void;
  purpose?: "high_alert_dose" | "infusion" | "narcotic_wastage";
}): React.ReactElement {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  return (
    <form className="ipdn-form ipdn-card ipde-second" onSubmit={(e) => {
      e.preventDefault(); setRefusal(null);
      secondCheck(purpose, target, username.trim(), pin).then((p) => { setPin(""); onProof(p); }, (er: unknown) => { setPin(""); setRefusal(refusalOf(er)); });
    }} data-testid="ipde-second">
      <b>{t("ipdEmar.second.title")}</b>
      <label>{t("ipdEmar.second.username")}<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></label>
      <label>{t("ipdEmar.second.pin")}<input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" autoComplete="off" /></label>
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal.rule}</div> : null}
      <button type="submit" className="ipdn-btn pri" disabled={!online || username.trim() === "" || pin.length < 4}>{t("ipdEmar.second.check")}</button>
    </form>
  );
}

/**
 * Infusions (§4.6): START and RATE CHANGE (and resume) happen here, after the wristband and the bag's label were scanned —
 * the same scans as a give; a high-alert drug needs its own second-nurse check (purpose "infusion"). Pause and stop are on
 * the patient's list and need no label.
 */
function InfusionStart({ o, online, patientCheck, labelCode, onDone }: {
  o: IpdEmarOrderLine; online: boolean; patientCheck: PatientCheck; labelCode: string; onDone: (w: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [rate, setRate] = useState("");
  const [proof, setProof] = useState<{ userId: string; pinProof: string; name: string } | null>(null);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const event = o.infusion === "running" ? "rate_change" : o.infusion === "paused" ? "resume" : "start";
  const r = Number(rate);
  const rateOk = event === "resume" || (rate.trim() !== "" && Number.isFinite(r) && r >= 0 && r <= 2000);
  if (o.infusion === "stopped") return <p className="dim">{t("ipdEmar.infusion.stopped")}</p>;
  return (
    <div className="ipdn-card ipde-infusion" data-testid="ipde-infusion">
      <b>{t("ipdEmar.infusion.title")} · {t(`ipdEmar.infusion.state.${o.infusion ?? "none"}`)}</b>
      {event !== "resume" ? <label className="ipde-field">{t("ipdEmar.infusion.rate")}<input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" data-testid="ipde-infusion-rate" /></label> : null}
      {o.highAlert ? (proof === null ? <SecondNurse online={online} purpose="infusion" target={{ orderId: o.orderId }} onProof={setProof} /> : <p className="ipdn-ok">✓ {t("ipdEmar.second.done", { name: proof.name })}</p>) : null}
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal.rule}</div> : null}
      <button type="button" className="ipdn-btn pri" disabled={!online || !rateOk || (o.highAlert && proof === null)} data-testid="ipde-infusion-go" onClick={() => {
        setRefusal(null);
        infusion({
          orderId: o.orderId, event, ...(event === "resume" ? {} : { rateMlPerHour: r, patientCheck, labelCode }),
          ...(proof !== null ? { secondNurse: { userId: proof.userId, pinProof: proof.pinProof } } : {}),
        }).then(() => onDone(t(`ipdEmar.infusion.did.${event}`)), (e: unknown) => setRefusal(refusalOf(e)));
      }}>{online ? t(`ipdEmar.infusion.act.${event}`) : t("ipdEmar.offlineShort")}</button>
    </div>
  );
}

function InfusionRow({ o, online, onDone }: { o: IpdEmarOrderLine; online: boolean; onDone: (w: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const send = (event: "pause" | "stop"): void => {
    setRefusal(null);
    infusion({ orderId: o.orderId, event }).then(() => onDone(t(`ipdEmar.infusion.did.${event}`)), (e: unknown) => setRefusal(refusalOf(e)));
  };
  return (
    <div className="ipdn-card ipde-infusion" data-testid={`ipde-infusion-row-${o.orderId}`}>
      <div><b>{o.tallMan ?? o.title}</b> · {t("ipdEmar.infusion.title")} · {t(`ipdEmar.infusion.state.${o.infusion ?? "none"}`)}</div>
      <div className="dim">{t("ipdEmar.infusion.scanToChange")}</div>
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal.rule}</div> : null}
      <div className="ipdn-acts">
        {o.infusion === "running" ? <button type="button" className="ipdn-btn" disabled={!online} onClick={() => send("pause")} data-testid="ipde-infusion-pause">{t("ipdEmar.infusion.act.pause")}</button> : null}
        <button type="button" className="ipdn-btn" disabled={!online} onClick={() => send("stop")} data-testid="ipde-infusion-stop">{t("ipdEmar.infusion.act.stop")}</button>
      </div>
    </div>
  );
}

/** Narcotic wastage: the amount in the issue's BASE unit (0.5 = half an ampoule), a reason, and a second nurse as witness. */
function WastageForm({ o, online, onDone }: { o: IpdEmarOrderLine; online: boolean; onDone: (w: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [witness, setWitness] = useState<{ userId: string; pinProof: string; name: string } | null>(null);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const n = Number(qty);
  const ok = qty.trim() !== "" && Number.isFinite(n) && n > 0 && reason.trim() !== "" && witness !== null;
  if (!open) {
    return <div className="ipdn-card"><div><b>{o.tallMan ?? o.title}</b> <span className="ipdn-tag c-allergy">Ⓝ {t("ipdEmar.narcotic")}</span></div>
      <div className="ipdn-acts"><button type="button" className="ipdn-btn" onClick={() => setOpen(true)} data-testid="ipde-wastage-open">{t("ipdEmar.wastage.open")}</button></div></div>;
  }
  return (
    <div className="ipdn-form ipdn-card" data-testid="ipde-wastage">
      <b>{t("ipdEmar.wastage.title")} · {o.title}</b>
      <label>{t("ipdEmar.wastage.qty")}<input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" data-testid="ipde-wastage-qty" /></label>
      <label>{t("ipdEmar.reason")}<input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="ipde-wastage-reason" /></label>
      {witness === null ? <SecondNurse online={online} purpose="narcotic_wastage" target={{ orderId: o.orderId }} onProof={setWitness} /> : <p className="ipdn-ok">✓ {t("ipdEmar.wastage.witness", { name: witness.name })}</p>}
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal.rule}</div> : null}
      <div className="ipdn-acts">
        <button type="button" className="ipdn-btn" onClick={() => setOpen(false)}>{t("ipdNursing.cancel")}</button>
        <button type="button" className="ipdn-btn pri" disabled={!online || !ok} data-testid="ipde-wastage-save" onClick={() => {
          setRefusal(null);
          wastage(o.orderId, n, reason.trim(), { userId: witness!.userId, pinProof: witness!.pinProof }).then(() => { setOpen(false); onDone(t("ipdEmar.wastage.done")); }, (e: unknown) => { setWitness(null); setRefusal(refusalOf(e)); });
        }}>{t("ipdEmar.save")}</button>
      </div>
    </div>
  );
}
