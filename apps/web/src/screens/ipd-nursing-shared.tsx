import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdEwsBand, IpdEwsKind, IpdRefusalBody } from "@hmis/contracts";
import { scoreEws } from "../../../../packages/contracts/src/ipd/ews";
import { fmtIst } from "../lib/format";
import { refusalOf } from "../lib/ipd-beds-api";
import { IPD_NURSING_TOPIC, outOfLimits, saveVitals, useVitalsQueue, vitalsBody } from "../lib/ipd-nursing-api";
import type { VitalsResult, VitalsValues } from "../lib/ipd-nursing-api";
import { realtimeClient, useRealtime } from "../lib/realtime";

/**
 * E4.1 (#733) — what the nurse station (board C) and my shift (board D1) share: the live/offline line, night mode,
 * the score badge (kind, number, band WORD and trend arrow — never colour alone), clocks in words, and the one vitals
 * entry form (type the numbers, the score shows at once, the numbers read back large before Save; out of limits asks
 * "Confirm"; "Patient refused" records refused, not missing; offline it queues — vitals only).
 */

export type T = (k: string, o?: Record<string, unknown>) => string;

const HEARTBEAT_MS = 2_000;
const OFFLINE_AFTER_MS = 5_000;

/** Load now, every `pollMs`, on every nursing event, and when the socket comes back; "Offline" inside 5 s. */
export function useLiveLoad(load: () => Promise<unknown>, pollMs = 15_000): { online: boolean; lastUpdate: Date | null } {
  const [failed, setFailed] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [lastPong, setLastPong] = useState(() => Date.now());
  const { replay } = useVitalsQueue();
  const run = useCallback(() => {
    load().then(() => { setFailed(false); setLastUpdate(new Date()); replay(); }, () => setFailed(true));
  }, [load, replay]);
  useEffect(() => { run(); const id = setInterval(run, pollMs); return () => clearInterval(id); }, [run, pollMs]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { connected } = useRealtime([IPD_NURSING_TOPIC], () => {
    if (debounce.current !== null) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { debounce.current = null; run(); }, 300);
  });
  useEffect(() => () => { if (debounce.current !== null) clearTimeout(debounce.current); }, []);
  useEffect(() => {
    const client = realtimeClient();
    const off = client.onPong(() => setLastPong(Date.now()));
    client.ping();
    const id = setInterval(() => { client.ping(); setNow(Date.now()); }, HEARTBEAT_MS);
    return () => { off(); clearInterval(id); };
  }, []);
  const was = useRef(connected);
  useEffect(() => { if (connected && !was.current) run(); was.current = connected; }, [connected, run]);
  // The browser's own online/offline events turn the line at once; a socket that was live and stops answering pings
  // turns it inside 5 s; a failed fetch turns it at the next poll. A screen with no socket at all rides on its fetches.
  const [netUp, setNetUp] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const up = (): void => { setNetUp(true); run(); };
    const down = (): void => setNetUp(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, [run]);
  const socketOk = !connected || now - lastPong < OFFLINE_AFTER_MS;
  return { online: netUp && !failed && lastUpdate !== null && socketOk, lastUpdate };
}

/** The live dot and "Offline · last update 14:02" (§0B), with the queue's count. */
export function LiveLine({ online, lastUpdate }: { online: boolean; lastUpdate: Date | null }): React.ReactElement {
  const { t } = useTranslation();
  const { queued, dropped, clearDropped } = useVitalsQueue();
  return (
    <>
      <span className={`ipdn-live${online ? "" : " off"}`} role="status" data-testid="ipdn-live">
        <i aria-hidden="true" />
        {online ? t("ipdNursing.live") : lastUpdate === null ? t("ipdNursing.offlineNever") : t("ipdNursing.offline", { time: fmtIst(lastUpdate.toISOString()) })}
        {queued > 0 ? <b> · {t("ipdNursing.queued", { count: queued })}</b> : null}
      </span>
      {dropped.length > 0 ? (
        // Review 5: every set that will not be sent is NAMED (time taken, patient) with the one thing to do.
        <div className="ipdn-dropped" role="alert" data-testid="ipdn-dropped">
          <b>{t("ipdNursing.dropped.title")}</b>
          <ul>
            {dropped.map((d) => (
              <li key={d.body.idempotencyKey}>
                {fmtIst(d.body.observedAt)} · {d.body.queueLabel ?? t("ipdNursing.dropped.patient")} — {t(`ipdNursing.dropped.${d.reason}`)}
              </li>
            ))}
          </ul>
          <span>{t("ipdNursing.dropped.paper")}</span>
          <button type="button" className="ipdn-btn sm" onClick={clearDropped}>{t("ipdNursing.dropped.done")}</button>
        </div>
      ) : null}
    </>
  );
}

/** Night mode follows the server's clock (22:00–06:00 IST) until the nurse flips it. Never applies to print (CSS). */
export function useNight(serverNight: boolean | undefined): [boolean, () => void] {
  const [override, setOverride] = useState<boolean | null>(null);
  const night = override ?? serverNight ?? false;
  return [night, () => setOverride(!night)];
}

/** A span of minutes in words: "just now", "12 min", "1 h 5 min". */
export function spanWords(ms: number, t: T): string {
  const min = Math.floor(Math.abs(ms) / 60_000);
  if (min < 1) return t("ipdNursing.dur.justNow");
  if (min < 60) return t("ipdNursing.dur.min", { n: min });
  return t("ipdNursing.dur.hourMin", { h: Math.floor(min / 60), m: min % 60 });
}

/** "Vitals · in 20 min" / "Vitals · overdue 12 min". */
export function dueWords(kind: "vitals" | "assessment" | "ews" | "handover", dueAt: string, now: number, t: T): string {
  const ms = new Date(dueAt).getTime() - now;
  const what = t(`ipdNursing.due.${kind}`);
  return ms < 0 ? `${what} · ${t("ipdNursing.overdueBy", { span: spanWords(ms, t) })}` : `${what} · ${t("ipdNursing.dueIn", { span: spanWords(ms, t) })}`;
}

const TREND_ARROW = { up: "↑", down: "↓", flat: "→" } as const;

export function ScoreBadge({ kind, value, band, trend, complete, big }: {
  kind: IpdEwsKind; value: number; band: IpdEwsBand; trend?: "up" | "down" | "flat" | null; complete?: boolean; big?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span className={`ipdn-score b-${band}${big ? " big" : ""}`} data-testid="ipdn-score">
      <span className="k">{t(`ipdNursing.kind.${kind}`)}</span>
      <b className="v">{value}</b>
      {trend ? <span className="tr" aria-label={t(`ipdNursing.trend.${trend}`)}>{TREND_ARROW[trend]}</span> : null}
      <span className="w">{t(`ipdNursing.band.${band}`)}</span>
      {complete === false ? <span className="inc">{t("ipdNursing.incomplete")}</span> : null}
    </span>
  );
}

/** Whole years from an "M 45" / "F 3y" / "F 8 mo" age-sex string, for the phone's preview score only. */
export function ageFromAgeSex(ageSex: string): number | null {
  const m = /(\d+)\s*(mo|m\b|d\b|w\b)?/i.exec(ageSex.replace(/^[MFO]\s+/i, ""));
  if (m === null) return null;
  return m[2] !== undefined ? 0 : Number(m[1]);
}

type Field = { key: keyof VitalsValues; step: string; unit: string };
const FIELDS: readonly Field[] = [
  { key: "temperatureC", step: "0.1", unit: "°C" },
  { key: "pulse", step: "1", unit: "/min" },
  { key: "respRate", step: "1", unit: "/min" },
  { key: "systolic", step: "1", unit: "mmHg" },
  { key: "diastolic", step: "1", unit: "mmHg" },
  { key: "spo2", step: "1", unit: "%" },
  { key: "painScore", step: "1", unit: "/10" },
];
const AVPU = ["alert", "confused", "voice", "pain", "unresponsive"] as const;

export type VitalsDone = { queued: boolean; result: VitalsResult | null; refused: boolean };

/** The one vitals entry. `online` false disables nothing here: vitals are the one act that queues. */
export function VitalsForm({ admissionId, kind, ageYears, onDone, onCancel, label }: {
  admissionId: string; kind: IpdEwsKind; ageYears: number | null; onDone: (d: VitalsDone) => void; onCancel?: () => void;
  /** Names the patient (alias for a restricted one) if a queued set is later dropped: "record on paper". */
  label?: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [oxygen, setOxygen] = useState<boolean | undefined>(undefined);
  const [avpu, setAvpu] = useState<(typeof AVPU)[number] | undefined>(undefined);
  const [step, setStep] = useState<"enter" | "readback">("enter");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const [failed, setFailed] = useState(false);

  const values: VitalsValues = {};
  for (const f of FIELDS) {
    const s = (raw[f.key] ?? "").trim().replace(",", ".");
    if (s !== "" && Number.isFinite(Number(s))) (values as Record<string, number>)[f.key] = Number(s);
  }
  if (kind === "pews" && (raw.capRefillSec ?? "").trim() !== "") values.capRefillSec = Number(raw.capRefillSec);
  if (oxygen !== undefined) values.onOxygen = oxygen;
  if (avpu !== undefined) values.consciousness = avpu;
  const any = Object.keys(values).length > 0;
  const score = any ? scoreEws(kind, values, ageYears) : null;
  const odd = outOfLimits(values);

  const save = (refused: boolean): void => {
    setBusy(true); setRefusal(null); setFailed(false);
    const body = vitalsBody(admissionId, values, { refused, confirmed: !refused && odd.length > 0 });
    saveVitals(body, label).then(
      (r) => { setBusy(false); onDone({ queued: r.queued, result: r.queued ? null : r.result, refused }); },
      (e: unknown) => { setBusy(false); const rf = refusalOf(e); if (rf) setRefusal(rf); else setFailed(true); },
    );
  };

  const fields = kind === "pews" ? [...FIELDS, { key: "capRefillSec" as const, step: "1", unit: "s" }] : FIELDS;
  return (
    <div className="ipdn-vitals" data-testid="ipdn-vitals-form">
      {step === "enter" ? (
        <>
          <div className="ipdn-preview" aria-live="polite">
            {score !== null ? <ScoreBadge kind={score.kind} value={score.value} band={score.band} complete={score.complete} big /> : <span className="dim">{t("ipdNursing.v.typeToScore")}</span>}
          </div>
          <div className="ipdn-vgrid">
            {fields.map((f) => (
              <label key={f.key} className={`ipdn-vfield${odd.includes(f.key) ? " odd" : ""}`}>
                <span>{t(`ipdNursing.v.${f.key}`)} <i>{f.unit}</i></span>
                <input inputMode="decimal" type="text" value={raw[f.key] ?? ""} aria-label={t(`ipdNursing.v.${f.key}`)}
                  onChange={(e) => setRaw((r) => ({ ...r, [f.key]: e.target.value }))} />
              </label>
            ))}
          </div>
          <div className="ipdn-seg" role="group" aria-label={t("ipdNursing.v.onOxygen")}>
            <button type="button" aria-pressed={oxygen === false} onClick={() => setOxygen(false)}>{t("ipdNursing.v.air")}</button>
            <button type="button" aria-pressed={oxygen === true} onClick={() => setOxygen(true)}>{t("ipdNursing.v.oxygen")}</button>
          </div>
          <div className="ipdn-seg avpu" role="group" aria-label={t("ipdNursing.v.consciousness")}>
            {AVPU.map((a) => (
              <button key={a} type="button" aria-pressed={avpu === a} onClick={() => setAvpu(a)}>{t(`ipdNursing.avpu.${a}`)}</button>
            ))}
          </div>
          <div className="ipdn-acts">
            <button type="button" className="ipdn-btn" disabled={busy} onClick={() => save(true)} data-testid="ipdn-refused">{t("ipdNursing.v.refused")}</button>
            {onCancel ? <button type="button" className="ipdn-btn" onClick={onCancel}>{t("ipdNursing.cancel")}</button> : null}
            <button type="button" className="ipdn-btn pri" disabled={!any || busy} onClick={() => setStep("readback")} data-testid="ipdn-check">{t("ipdNursing.v.check")}</button>
          </div>
        </>
      ) : (
        <>
          <ul className="ipdn-readback" data-testid="ipdn-readback">
            {Object.entries(values).map(([k, v]) => (
              <li key={k} className={odd.includes(k) ? "odd" : ""}>
                <span>{t(`ipdNursing.v.${k}`)}</span>
                <b>{typeof v === "boolean" ? (v ? t("ipdNursing.v.oxygen") : t("ipdNursing.v.air")) : typeof v === "string" ? t(`ipdNursing.avpu.${v}`) : String(v)}</b>
                {odd.includes(k) ? <em>⚠ {t("ipdNursing.v.unusual")}</em> : null}
              </li>
            ))}
          </ul>
          {score !== null ? <div className="ipdn-preview"><ScoreBadge kind={score.kind} value={score.value} band={score.band} complete={score.complete} big /></div> : null}
          {odd.length > 0 ? <p className="ipdn-warn" role="alert">⚠ {t("ipdNursing.v.confirmAsk")}</p> : null}
          <div className="ipdn-acts">
            <button type="button" className="ipdn-btn" disabled={busy} onClick={() => setStep("enter")}>{t("ipdNursing.v.edit")}</button>
            <button type="button" className="ipdn-btn pri" disabled={busy} onClick={() => save(false)} data-testid="ipdn-save">
              {odd.length > 0 ? t("ipdNursing.v.confirmSave") : t("ipdNursing.v.save")}
            </button>
          </div>
        </>
      )}
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal.rule}</div> : null}
      {failed ? <div className="ipdn-refusal" role="alert">{t("ipdNursing.actFailed")}</div> : null}
    </div>
  );
}

/** The few words after a save: "Saved · NEWS2 6", "Queued — will send", "Refused recorded". */
export function savedWords(d: VitalsDone, t: T): string {
  if (d.queued) return t("ipdNursing.v.queued");
  if (d.refused) return t("ipdNursing.v.refusedSaved");
  if (d.result?.doctorReached === false) return t("ipdNursing.noDoctorReached");
  const s = d.result?.score;
  return s ? t("ipdNursing.v.savedScore", { kind: t(`ipdNursing.kind.${s.kind}`), value: s.value }) : t("ipdNursing.v.saved");
}
