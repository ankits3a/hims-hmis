import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { ActPicker, PhoneDock, PhoneShell, useCopilotToggles } from "../components/doctor-desk/phone";
import { fmtIst } from "../lib/format";
import { deskErrorText, fetchNow } from "../lib/doctor-desk-api";
import type { WireAttentionRow, WireNow } from "../lib/doctor-desk-api";
import { fetchMyDuties, raiseRosterFlag } from "../lib/roster-api";
import type { WireMyDuties } from "../../../../packages/contracts/src/roster-board";
import { dutyWhatKey } from "../../../../packages/contracts/src/roster-board";
import { patientName, signalText, spanText, whenText } from "./doctor-desk-tower";

/**
 * ═══ DD-1.5 — THE SR PHONE "NOW" (`Main.dc.html`), its OPD and roster parts ═══
 *
 * ON TAKE strip and the week from the PUBLISHED roster (`GET /roster/my-duties`), with "Wrong? Tell the
 * desk" raising the roster's own flag; NOW = my criticals, each with "What did you do?" (D3); TODAY =
 * reports to open and visits to finish. ABSENT until DD-IPD, never drawn empty: NEXT ward round, the
 * NEWS2 card, FLOW · beds and money, the Beds tab. No money anywhere (decision 0058).
 */
type T = (k: string, o?: Record<string, unknown>) => string;

export function DoctorDeskNow(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const q = useQuery({ queryKey: ["doctor-desk", "now"], queryFn: fetchNow, refetchInterval: 60_000 });
  const duties = useQuery({ queryKey: ["roster", "my-duties"], queryFn: () => fetchMyDuties(), retry: false });
  const toggles = useCopilotToggles();
  const now = q.data;
  const sub = now === undefined ? null : subLine(now, t);
  return (
    <PhoneShell
      testId="doctor-desk-now" title={now?.you.name ?? ""} sub={sub} clock={now === undefined ? "" : clockLine(now.at, i18n.language)} tab="now"
      dock={<PhoneDock id="ask-now" placeholder={t("doctorDesk.now.askPlaceholder")} toggles={toggles} />}
    >
      {q.isPending && <p className="ddp-dim">{t("doctorDesk.loading")}</p>}
      {q.isError && <p role="alert" className="dd-alert">{deskErrorText(q.error, t)}</p>}
      {duties.data !== undefined && <TakeStrip md={duties.data} />}
      {now !== undefined && <Waiting now={now} lang={i18n.language} />}
    </PhoneShell>
  );
}

export function subLine(v: Pick<WireNow, "you" | "unit">, t: T): string | null {
  const parts = [
    v.you.grade === null ? null : t(`doctorDesk.gradeLong.${v.you.grade}`, { defaultValue: t(`doctorDesk.grade.${v.you.grade}`, { defaultValue: v.you.grade }) }),
    v.unit?.departmentName ?? null, v.unit?.short ?? null,
  ].filter((x): x is string => x !== null && x !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}

/** "Fri 18 Sep · 08:18" — IST. */
export function clockLine(iso: string, lang: string): string {
  const day = new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso)).replace(",", "");
  return `${day} · ${fmtIst(iso)}`;
}

function TakeStrip({ md }: { md: WireMyDuties }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const flag = useMutation({
    mutationFn: () => raiseRosterFlag({ departmentId: null, userId: null, at: new Date().toISOString(), note: note.trim() }),
    onSuccess: () => { setSent(true); setOpen(false); },
  });
  const wd = (d: string): string => new Intl.DateTimeFormat(i18n.language.startsWith("hi") ? "hi-IN" : "en-GB", { timeZone: "Asia/Kolkata", weekday: "short" }).format(new Date(`${d}T12:00:00+05:30`)).toUpperCase();
  return (
    <section className="ddp-card" data-testid="ddp-take">
      {md.onTake !== null && (
        <div className="ddp-head" style={{ justifyContent: "flex-start" }}>
          <span className="ddp-tag">{t("doctorDesk.now.onTake")}</span>
          <span style={{ fontSize: 13, fontWeight: 500 }} data-testid="ddp-take-line">{t("doctorDesk.now.admitsTill", { unit: md.onTake.name, at: whenText(md.onTake.endsAt, md.at.slice(0, 10), i18n.language) })}</span>
        </div>
      )}
      <div className="ddp-week" data-testid="ddp-week">
        {md.days.map((d) => {
          const mine = md.duties.filter((x) => x.istDate === d && x.kind !== "off");
          const first = mine[0];
          const what = first === undefined ? t("doctorDesk.now.off") : (() => { const w = dutyWhatKey(first); return w.fallback === undefined ? t(w.key) : t(w.key, { defaultValue: t(w.fallback) }); })();
          return (
            <div key={d} className={`ddp-day${first !== undefined ? " ddp-day-on" : ""}`}>
              <span className="ddp-day-d">{wd(d)}</span>
              <span className="ddp-day-w">{what}</span>
            </div>
          );
        })}
      </div>
      <div className="ddp-dim" style={{ fontSize: 12 }}>
        {t("doctorDesk.now.fromRoster")}{" "}
        {sent ? <span className="ddp-amber" data-testid="ddp-flag-sent">{t("doctorDesk.now.flagSent")}</span>
          : <button type="button" className="dd-linkbtn" data-testid="ddp-wrong" onClick={() => setOpen((o) => !o)}>{t("doctorDesk.now.wrong")}</button>}
      </div>
      {open && (
        <div className="ddp-act-other">
          <label className="ddp-sr" htmlFor="ddp-flag-note">{t("doctorDesk.now.wrongLabel")}</label>
          <input id="ddp-flag-note" className="ddp-input" maxLength={200} value={note} placeholder={t("doctorDesk.now.wrongLabel")} data-testid="ddp-flag-note" onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="ddp-btn ddp-btn-ink" disabled={note.trim() === "" || flag.isPending} data-testid="ddp-flag-send" onClick={() => flag.mutate()}>{t("doctorDesk.now.send")}</button>
        </div>
      )}
    </section>
  );
}

function Waiting({ now, lang }: { now: WireNow; lang: string }): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  const go = (e: React.MouseEvent, to: string): void => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to }); };
  return (
    <>
      <div className="ddp-head">
        <h2 className="ddp-h2">{t("doctorDesk.now.waiting")}</h2>
        <span className="ddp-mono" data-testid="ddp-counts">{t("doctorDesk.now.counts", { now: now.now.length, today: now.today.length })}</span>
      </div>
      <div className="ddp-eyebrow">{t("doctorDesk.now.nowWord")}</div>
      {now.now.length === 0 && <div className="ddp-card ddp-empty" data-testid="ddp-now-empty">{t("doctorDesk.now.nowEmpty")}</div>}
      {now.now.map((r) => <Critical key={r.key} r={r} istDate={now.istDate} lang={lang} />)}
      <div className="ddp-eyebrow">{t("doctorDesk.now.todayWord")}</div>
      <div className="ddp-list" data-testid="ddp-today">
        {now.today.length === 0 && <div className="ddp-empty">{t("doctorDesk.now.todayEmpty")}</div>}
        {now.today.map((r) => (
          <div key={r.key} className="ddp-li" data-testid={`ddp-today-${r.key}`}>
            <div className="ddp-li-main">
              <span className="ddp-li-t">{patientName(r.patient, t)}</span>
              <span className="ddp-li-s">{signalText(r, t)}</span>
              <span className="ddp-li-s">{t(`doctorDesk.source.${r.source.module}`)} · {whenText(r.at, now.istDate, lang)}</span>
            </div>
            <a href={r.href} className="ddp-btn ddp-btn-acc" style={{ display: "inline-flex", alignItems: "center" }} onClick={(e) => go(e, r.href)}>{t(`doctorDesk.verb.${r.kind}`)}</a>
          </div>
        ))}
      </div>
    </>
  );
}

function Critical({ r, istDate, lang }: { r: WireAttentionRow; istDate: string; lang: string }): React.ReactElement {
  const { t } = useTranslation();
  const age = Math.max(0, Math.round((Date.now() - Date.parse(r.at)) / 60_000));
  return (
    <section className={`ddp-crit${r.acked === true ? " ddp-crit-acked" : ""}`} data-testid={`ddp-crit-${r.key}`} data-acked={r.acked === true ? "yes" : "no"}>
      <div className="ddp-crit-top">
        <span className="ddp-crit-who">{patientName(r.patient, t)}</span>
        <span className="ddp-mono">{r.patient.uhid ?? ""}</span>
      </div>
      <div className="ddp-crit-v">{signalText(r, t)}</div>
      <div className="ddp-li-s">
        {t(`doctorDesk.source.${r.source.module}`)} · {whenText(r.at, istDate, lang)} · {spanText(age, t)}
        {r.goneHome && <> · <span className="ddp-amber">{t("doctorDesk.now.goneHome")}</span></>}
      </div>
      {r.acked === true && <div className="ddp-amber" data-testid={`ddp-acked-${r.key}`}>{t("doctorDesk.now.ackedNoAct")}</div>}
      {r.kind === "lab_critical" ? <ActPicker rowKey={r.key} /> : <div className="ddp-dim">{t("doctorDesk.now.imagingAck")}</div>}
    </section>
  );
}
