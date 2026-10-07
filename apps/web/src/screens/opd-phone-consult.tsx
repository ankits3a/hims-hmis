import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { opdErrorMessage } from "../lib/opd-api";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import {
  DeskTBody, DeskTD, DeskTH, DeskTHead, DeskTR, DeskTable,
} from "../components/desk-fields";

/**
 * ═══ THE DOCTOR'S PHONE CONSULT — THE TWO WEB SURFACES IT NEEDS (decisions 0048 and 0049) ═══
 *
 *   · `/opd/sets` (`OpdSets`, a doctor): every set this doctor can see, WRITTEN OUT IN FULL — a set
 *     is built on the phone from a real visit's lines; here its author offers it to the department
 *     as a hospital starter, and the department's unit head reads every line and signs it. Nothing
 *     is shown to the other doctors until that signature (the server's rule; an edit un-signs).
 *   · the "Phone consult" tab of OPD masters (`PhoneConsultAdmin`, the owner): the two switches —
 *     voice, and suggestions — the model and the day's cap; minutes a day; per doctor per week how
 *     much of the heard text they changed; what became of suggestions; the words that matched
 *     nothing; and the look-alike medicine pairs awaiting a pharmacist's review.
 *
 * WHAT THE PANEL SAYS ABOUT NAMES IS THE OWNER'S OWN WORDING (0049): no name is sent as data; a name
 * the doctor speaks travels in the audio. It is never written as "no name leaves".
 */

type WireSetLine = { drug: string; dose: string; route: string; frequency: string; durationDays: number | null; instructions: string | null; medicineId?: string | null };
export type WireRxSet = {
  id: string; scope: "doctor" | "department"; name: string; departmentId: string | null; departmentName: string | null;
  body: { lines: WireSetLine[]; tests: { serviceId: string; code: string; name: string }[]; advice: string | null; reviewDays: number | null };
  mine: boolean; signed: boolean; signedByName: string | null; signedAt: string | null; maySign: boolean;
};
type WireSets = { items: WireRxSet[]; headOf: string[]; departmentId: string | null };

function Refusal({ message }: { message: string | null }): React.ReactElement | null {
  if (message === null) return null;
  return <p role="alert" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{message}</p>;
}
const lineText = (l: WireSetLine, days: (n: number) => string): string =>
  [l.drug, l.dose, l.frequency, l.durationDays === null ? null : days(l.durationDays), l.instructions].filter((x): x is string => x !== null && x.trim() !== "").join(" · ");

function SetCard({ set, departmentId, onChanged }: { set: WireRxSet; departmentId: string | null; onChanged: () => Promise<void> }): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (run: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError(null);
    try { await run(); await onChanged(); } catch (e) { setError(opdErrorMessage(e)); } finally { setBusy(false); }
  };
  const days = (n: number): string => t("opdSets.days", { count: n });
  return (
    <article data-testid={`set-${set.id}`} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px", display: "grid", gap: 8, background: "var(--paper)" }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <strong style={{ fontSize: 14.5 }}>{set.name}</strong>
        <span className="tag">{set.scope === "doctor" ? t("opdSets.yours") : t("opdSets.starter", { department: set.departmentName ?? "" })}</span>
        {set.scope === "department" && (
          <span data-testid={`set-state-${set.id}`} style={{ fontSize: 12, fontWeight: 600, color: set.signed ? "var(--green)" : "var(--amber, #8a5a10)" }}>
            {set.signed ? t("opdSets.signedBy", { name: set.signedByName ?? "" }) : t("opdSets.unsigned")}
          </span>
        )}
      </header>
      {/* Every line, in full: a signature is on what is read here, not on a name. */}
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: "grid", gap: 3 }}>
        {set.body.lines.map((l, i) => <li key={`${String(i)}-${l.drug}`}>{lineText(l, days)}</li>)}
      </ol>
      {set.body.tests.length > 0 && <p style={{ margin: 0, fontSize: 12.5 }}><span className="tag">{t("opdSets.tests")}</span> {set.body.tests.map((x) => x.name).join(", ")}</p>}
      {(set.body.advice ?? "") !== "" && <p style={{ margin: 0, fontSize: 12.5 }}><span className="tag">{t("opdSets.advice")}</span> {set.body.advice}</p>}
      {set.body.reviewDays !== null && <p style={{ margin: 0, fontSize: 12.5 }}><span className="tag">{t("opdSets.review")}</span> {days(set.body.reviewDays)}</p>}
      <Refusal message={error} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {set.scope === "doctor" && set.mine && departmentId !== null && (
          <button type="button" className="sec" disabled={busy} data-testid={`set-offer-${set.id}`}
            onClick={() => { void act(() => api("POST", "/opd/rx-sets", { scope: "department", departmentId, name: set.name, body: set.body })); }}>
            {t("opdSets.offer")}
          </button>
        )}
        {set.scope === "department" && !set.signed && set.maySign && (
          <button type="button" className="pri" disabled={busy} data-testid={`set-sign-${set.id}`} onClick={() => { void act(() => api("POST", `/opd/rx-sets/${set.id}/sign`)); }}>
            {t("opdSets.sign")}
          </button>
        )}
        {(set.mine || set.maySign) && (
          <button type="button" className="sec" disabled={busy} data-testid={`set-retire-${set.id}`} onClick={() => { void act(() => api("DELETE", `/opd/rx-sets/${set.id}`)); }}>
            {t("opdSets.retire")}
          </button>
        )}
      </div>
    </article>
  );
}

export function OpdSets(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const sets = useQuery({ queryKey: ["opd", "rx-sets"], queryFn: () => api<WireSets>("GET", "/opd/rx-sets") });
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ["opd", "rx-sets"] });
  const items = sets.data?.items ?? [];
  const mine = items.filter((s) => s.scope === "doctor");
  const starters = items.filter((s) => s.scope === "department");
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 12, alignItems: "start" } as const;
  return (
    <PaperScreen testId="opd-sets" style={{ padding: "18px 22px", gap: 14 }}>
      <ScreenTitle title={t("opdSets.title")} route="/opd/sets" subtitle={t("opdSets.subtitle")} />
      {sets.isError && <Refusal message={opdErrorMessage(sets.error)} />}
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)", maxWidth: 760 }}>{t("opdSets.rules")}</p>
      <h2 className="tag" style={{ margin: 0 }}>{t("opdSets.starterHead")}</h2>
      {starters.length === 0 && sets.data !== undefined && <p data-testid="sets-no-starters" style={{ margin: 0, fontSize: 13, color: "var(--dim)" }}>{t("opdSets.noStarters")}</p>}
      <div style={grid}>{starters.map((s) => <SetCard key={s.id} set={s} departmentId={sets.data?.departmentId ?? null} onChanged={refresh} />)}</div>
      <h2 className="tag" style={{ margin: 0 }}>{t("opdSets.mineHead")}</h2>
      {mine.length === 0 && sets.data !== undefined && <p data-testid="sets-none-mine" style={{ margin: 0, fontSize: 13, color: "var(--dim)" }}>{t("opdSets.noneMine")}</p>}
      <div style={grid}>{mine.map((s) => <SetCard key={s.id} set={s} departmentId={sets.data?.departmentId ?? null} onChanged={refresh} />)}</div>
    </PaperScreen>
  );
}

// ——— the owner's panel ———

type WireVoiceStatus = {
  enabled: boolean; suggestionsEnabled: boolean; model: string; dailyMinutesCap: number; configured: boolean; maxSeconds: number; usedSecondsToday: number;
  why: "not_configured" | "switched_off" | "cap_reached" | null;
};
type WireMeter = {
  status: WireVoiceStatus;
  days: { day: string; minutes: number; notes: number }[];
  doctors: { userId: string; name: string; weekStart: string; notes: number; minutes: number; changedShare: number | null }[];
  signals: {
    suggestions: { source: string; accepted: number; dismissed: number; manual: number }[];
    misses: { kind: string; term: string; times: number; lastAt: string }[];
  };
};
type WireLasa = { id: string; nameA: string; nameB: string; active: boolean; reviewed: boolean; reviewedAt: string | null };
const MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"] as const;

function Switch({ id, on, label, hint, onChange }: { id: string; on: boolean; label: string; hint: string; onChange: (next: boolean) => void }): React.ReactElement {
  return (
    <label htmlFor={id} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13.5, cursor: "pointer" }}>
      <input id={id} data-testid={id} type="checkbox" checked={on} onChange={(e) => { onChange(e.target.checked); }} style={{ width: 18, height: 18, marginTop: 2 }} />
      <span><strong>{label}</strong><br /><span style={{ fontSize: 12, color: "var(--dim)" }}>{hint}</span></span>
    </label>
  );
}

export function PhoneConsultAdmin(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const meter = useQuery({ queryKey: ["opd", "voice-meter"], queryFn: () => api<WireMeter>("GET", "/opd/consult/voice/meter") });
  const lasa = useQuery({ queryKey: ["opd", "lasa"], queryFn: () => api<{ items: WireLasa[] }>("GET", "/opd/consult/lasa") });
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [pair, setPair] = useState({ a: "", b: "" });
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["opd", "voice-meter"] });
    await queryClient.invalidateQueries({ queryKey: ["opd", "lasa"] });
  };
  const send = async (run: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try { await run(); await refresh(); } catch (e) { setError(opdErrorMessage(e)); }
  };
  const set = (patch: Record<string, unknown>): Promise<void> => send(() => api("PUT", "/opd/consult/voice/settings", patch));
  const s = meter.data?.status;
  const capText = cap ?? (s === undefined ? "" : String(s.dailyMinutesCap));
  const capNumber = Number(capText);
  const section = { display: "grid", gap: 10, alignContent: "start" } as const;

  return (
    <div data-testid="phone-consult-admin" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 26, alignItems: "start" }}>
      <section style={section}>
        <h2 className="tag" style={{ margin: 0 }}>{t("phoneConsult.voiceHead")}</h2>
        {meter.isError && <Refusal message={opdErrorMessage(meter.error)} />}
        {s !== undefined && (
          <>
            <p data-testid="voice-state" style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: s.why === null ? "var(--green)" : "var(--red)" }}>
              {s.why === null ? t("phoneConsult.state.on") : t(`phoneConsult.state.${s.why}`)}
            </p>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("phoneConsult.usedToday", { used: Math.round(s.usedSecondsToday / 6) / 10, cap: s.dailyMinutesCap })}</p>
            {/* The owner's wording, decision 0049. Not "no name leaves". */}
            <p data-testid="voice-honest" style={{ margin: 0, fontSize: 12.5, borderLeft: "3px solid var(--line)", paddingLeft: 10 }}>{t("phoneConsult.honest")}</p>
            <Switch id="voice-enabled" on={s.enabled} label={t("phoneConsult.voiceSwitch")} hint={t("phoneConsult.voiceSwitchHint")} onChange={(next) => { void set({ enabled: next }); }} />
            <Switch id="suggestions-enabled" on={s.suggestionsEnabled} label={t("phoneConsult.suggestSwitch")} hint={t("phoneConsult.suggestSwitchHint")} onChange={(next) => { void set({ suggestionsEnabled: next }); }} />
            <label htmlFor="voice-model" style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
              {t("phoneConsult.model")}
              <select id="voice-model" data-testid="voice-model" value={s.model} onChange={(e) => { void set({ model: e.target.value }); }} style={{ height: 34, maxWidth: 280 }}>
                {MODELS.map((m) => <option key={m} value={m}>{t(`phoneConsult.models.${m}`)}</option>)}
              </select>
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <label htmlFor="voice-cap" style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
                {t("phoneConsult.cap")}
                <input id="voice-cap" data-testid="voice-cap" inputMode="numeric" value={capText} onChange={(e) => { setCap(e.target.value.replace(/[^0-9]/g, "").slice(0, 4)); }} style={{ height: 34, width: 110 }} />
              </label>
              <button type="button" className="sec" data-testid="voice-cap-save" disabled={cap === null || capText === "" || !Number.isInteger(capNumber) || capNumber > 6000}
                onClick={() => { void set({ dailyMinutesCap: capNumber }).then(() => { setCap(null); }); }}>{t("phoneConsult.capSave")}</button>
            </div>
          </>
        )}
        <Refusal message={error} />
        <h2 className="tag" style={{ margin: "8px 0 0" }}>{t("phoneConsult.daysHead")}</h2>
        {(meter.data?.days.length ?? 0) === 0 ? <p data-testid="voice-no-use" style={{ margin: 0, fontSize: 13, color: "var(--dim)" }}>{t("phoneConsult.noUse")}</p> : (
          <DeskTable>
            <DeskTHead><DeskTR><DeskTH>{t("phoneConsult.day")}</DeskTH><DeskTH>{t("phoneConsult.notes")}</DeskTH><DeskTH>{t("phoneConsult.minutes")}</DeskTH></DeskTR></DeskTHead>
            <DeskTBody>{meter.data?.days.map((d) => <DeskTR key={d.day}><DeskTD className="mo">{d.day}</DeskTD><DeskTD className="mo">{d.notes}</DeskTD><DeskTD className="mo">{d.minutes}</DeskTD></DeskTR>)}</DeskTBody>
          </DeskTable>
        )}
      </section>

      <section style={section}>
        <h2 className="tag" style={{ margin: 0 }}>{t("phoneConsult.doctorsHead")}</h2>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("phoneConsult.doctorsHint")}</p>
        {(meter.data?.doctors.length ?? 0) > 0 && (
          <DeskTable>
            <DeskTHead><DeskTR><DeskTH>{t("phoneConsult.week")}</DeskTH><DeskTH>{t("phoneConsult.doctor")}</DeskTH><DeskTH>{t("phoneConsult.notes")}</DeskTH><DeskTH>{t("phoneConsult.minutes")}</DeskTH><DeskTH>{t("phoneConsult.changed")}</DeskTH></DeskTR></DeskTHead>
            <DeskTBody>
              {meter.data?.doctors.map((d) => (
                <DeskTR key={`${d.userId}-${d.weekStart}`}>
                  <DeskTD className="mo">{d.weekStart}</DeskTD><DeskTD>{d.name}</DeskTD><DeskTD className="mo">{d.notes}</DeskTD><DeskTD className="mo">{d.minutes}</DeskTD>
                  <DeskTD className="mo">{d.changedShare === null ? "—" : `${String(Math.round(d.changedShare * 100))}%`}</DeskTD>
                </DeskTR>
              ))}
            </DeskTBody>
          </DeskTable>
        )}
        <h2 className="tag" style={{ margin: "8px 0 0" }}>{t("phoneConsult.suggestHead")}</h2>
        {(meter.data?.signals.suggestions.length ?? 0) === 0 ? <p style={{ margin: 0, fontSize: 13, color: "var(--dim)" }}>{t("phoneConsult.noSignals")}</p> : (
          <DeskTable>
            <DeskTHead><DeskTR><DeskTH>{t("phoneConsult.source")}</DeskTH><DeskTH>{t("phoneConsult.accepted")}</DeskTH><DeskTH>{t("phoneConsult.dismissed")}</DeskTH><DeskTH>{t("phoneConsult.manual")}</DeskTH></DeskTR></DeskTHead>
            <DeskTBody>{meter.data?.signals.suggestions.map((r) => <DeskTR key={r.source}><DeskTD>{t(`phoneConsult.sources.${r.source}`, { defaultValue: r.source })}</DeskTD><DeskTD className="mo">{r.accepted}</DeskTD><DeskTD className="mo">{r.dismissed}</DeskTD><DeskTD className="mo">{r.manual}</DeskTD></DeskTR>)}</DeskTBody>
          </DeskTable>
        )}
        <h2 className="tag" style={{ margin: "8px 0 0" }}>{t("phoneConsult.missHead")}</h2>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("phoneConsult.missHint")}</p>
        {(meter.data?.signals.misses.length ?? 0) > 0 && (
          <DeskTable>
            <DeskTHead><DeskTR><DeskTH>{t("phoneConsult.term")}</DeskTH><DeskTH>{t("phoneConsult.kind")}</DeskTH><DeskTH>{t("phoneConsult.times")}</DeskTH></DeskTR></DeskTHead>
            <DeskTBody>{meter.data?.signals.misses.map((m) => <DeskTR key={`${m.kind}-${m.term}`}><DeskTD>{m.term}</DeskTD><DeskTD>{t(`phoneConsult.kinds.${m.kind}`, { defaultValue: m.kind })}</DeskTD><DeskTD className="mo">{m.times}</DeskTD></DeskTR>)}</DeskTBody>
          </DeskTable>
        )}
      </section>

      <section style={section}>
        <h2 className="tag" style={{ margin: 0 }}>{t("phoneConsult.lasaHead")}</h2>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("phoneConsult.lasaHint")}</p>
        <DeskTable>
          <DeskTHead><DeskTR><DeskTH>{t("phoneConsult.pair")}</DeskTH><DeskTH>{t("phoneConsult.review")}</DeskTH><DeskTH>{t("opd.labels.actions")}</DeskTH></DeskTR></DeskTHead>
          <DeskTBody>
            {(lasa.data?.items ?? []).map((p) => (
              <DeskTR key={p.id}>
                <DeskTD style={{ opacity: p.active ? 1 : 0.5 }}>{p.nameA} / {p.nameB}</DeskTD>
                <DeskTD>{!p.active ? t("phoneConsult.lasaOff") : p.reviewed ? t("phoneConsult.lasaReviewed") : t("phoneConsult.lasaUnreviewed")}</DeskTD>
                <DeskTD>
                  <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {p.active && !p.reviewed && <button type="button" className="sec" data-testid={`lasa-confirm-${p.id}`} style={{ padding: "0 9px", height: 25, fontSize: 11 }} onClick={() => { void send(() => api("PUT", `/opd/consult/lasa/${p.id}`, { active: true })); }}>{t("phoneConsult.lasaConfirm")}</button>}
                    <button type="button" className="sec" data-testid={`lasa-toggle-${p.id}`} style={{ padding: "0 9px", height: 25, fontSize: 11 }} onClick={() => { void send(() => api("PUT", `/opd/consult/lasa/${p.id}`, { active: !p.active })); }}>{p.active ? t("opd.actions.deactivate") : t("opd.actions.activate")}</button>
                  </span>
                </DeskTD>
              </DeskTR>
            ))}
          </DeskTBody>
        </DeskTable>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label htmlFor="lasa-a" style={{ display: "grid", gap: 4, fontSize: 12.5 }}>{t("phoneConsult.lasaName")}<input id="lasa-a" data-testid="lasa-a" value={pair.a} maxLength={60} onChange={(e) => { setPair((x) => ({ ...x, a: e.target.value })); }} style={{ height: 34, width: 150 }} /></label>
          <label htmlFor="lasa-b" style={{ display: "grid", gap: 4, fontSize: 12.5 }}>{t("phoneConsult.lasaOther")}<input id="lasa-b" data-testid="lasa-b" value={pair.b} maxLength={60} onChange={(e) => { setPair((x) => ({ ...x, b: e.target.value })); }} style={{ height: 34, width: 150 }} /></label>
          <button type="button" className="sec" data-testid="lasa-add" disabled={pair.a.trim().length < 3 || pair.b.trim().length < 3}
            onClick={() => { void send(() => api("POST", "/opd/consult/lasa", { nameA: pair.a.trim(), nameB: pair.b.trim() })).then(() => { setPair({ a: "", b: "" }); }); }}>{t("phoneConsult.lasaAdd")}</button>
        </div>
      </section>
    </div>
  );
}
