import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { AskBar, DoctorDeskFrame } from "../components/doctor-desk/frame";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { fmtIst } from "../lib/format";
import { todayIst } from "../lib/opd-api";
import type { WireDoctor, WireQueueEntryView, WireQueueView } from "../lib/opd-api";
import { deskErrorText, fetchNextCard, fetchOpdDesk } from "../lib/doctor-desk-api";
import type { WireNextCard, WireOpdDesk } from "../lib/doctor-desk-api";
import { patientName, signalText, spanText, whenText } from "./doctor-desk-tower";
import "./doctor-desk.css";

/**
 * ═══ DD-0.8 (#890) — THE OPD DESK (`docs/design/2026-09-18-doctor-desk/OpdDesk.dc.html`) ═══
 *
 * The board the owner approved on 2026-09-18, inside the Doctor Desk frame: YOUR LINE on the left
 * (today's tokens and how long each has waited), the NEXT token card in the middle (why they came in
 * the desk's words, Bay One vitals, allergy, results since you last saw them, your last prescription,
 * your pace and the unit's colleagues), and WAITING ON YOU (OPD only) in the rail.
 *
 * The queue controls are OPD's own routes, unchanged (consult ruling 2026-09-23 §1.1): the session
 * In / Out / Closed, and Call next, which drives the hall display as today. Skip, Start and Park
 * stay on the consult screen, which "Open consultation" opens. "FROM THE WARD" is absent until
 * DD-IPD. No money anywhere (decision 0058): the queue's `feeStatus` is never read here; the board's
 * "no fee" and phone-number elements are not drawn.
 */
type T = (k: string, o?: Record<string, unknown>) => string;
const POLL_MS = 15_000;

const fetchMe = () => api<WireDoctor>("GET", "/opd/me/doctor");
const fetchQueue = (doctorId: string, day: string) => api<WireQueueView | { session: null }>("GET", `/opd/queues?doctorId=${doctorId}&serviceDate=${day}`);

/** Who the NEXT card is about: the token with you or called, else the first in line. */
export function nextOf(view: WireQueueView | null): WireQueueEntryView | null {
  if (view === null) return null;
  return view.inConsult[0] ?? view.current ?? view.ordered[0] ?? null;
}

function rowLine(e: WireQueueEntryView, t: T): string {
  const parts = [t(`doctorDesk.opd.visitType.${e.encounter.visitType}`, { defaultValue: e.encounter.visitType }), t(`doctorDesk.opd.state.${e.status}`, { defaultValue: e.status })];
  if (e.reEntry) parts.push(t("doctorDesk.opd.reEntry"));
  return parts.join(" · ");
}

export function DoctorDeskOpd(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { username } = useAuth();
  const qc = useQueryClient();
  const day = todayIst();
  const me = useQuery({ queryKey: ["opd", "me", "doctor"], queryFn: fetchMe, retry: false });
  const doctorId = me.data?.id ?? "";
  const queue = useQuery({ queryKey: ["opd", "queue", doctorId, day], queryFn: () => fetchQueue(doctorId, day), enabled: doctorId !== "", refetchInterval: POLL_MS });
  const desk = useQuery({ queryKey: ["doctor-desk", "opd"], queryFn: fetchOpdDesk, refetchInterval: 60_000 });
  const view = queue.data !== undefined && queue.data.session !== null ? queue.data : null;
  const next = nextOf(view);
  const card = useQuery({ queryKey: ["doctor-desk", "opd", "next", next?.encounterId ?? ""], queryFn: () => fetchNextCard(next!.encounterId), enabled: next !== null });
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["opd", "queue"] }); void qc.invalidateQueries({ queryKey: ["doctor-desk", "opd"] }); };
  const callNext = useMutation({ mutationFn: () => api("POST", `/opd/queues/${view!.session.id}/call-next`), onSuccess: refresh });
  const setStatus = useMutation({ mutationFn: (status: "in" | "out" | "closed") => api("POST", `/opd/queues/${view!.session.id}/status`, { status }), onSuccess: refresh });
  const d = desk.data;
  const unit = d?.unit ?? null;
  return (
    <DoctorDeskFrame
      active="myOpd" testId="doctor-desk-opd"
      context={unit === null ? t("doctorDesk.contextOwn") : t("doctorDesk.context", { dept: unit.departmentName, unit: unit.short })}
      pill={{ tag: t("doctorDesk.tower.pillOpd"), text: view === null ? t("doctorDesk.opd.noSession") : t(`doctorDesk.opd.session.${view.session.status}`) }}
      who={d === undefined ? undefined : { name: d.you.name || (username ?? ""), role: d.you.grade === null ? null : t(`doctorDesk.grade.${d.you.grade}`, { defaultValue: d.you.grade }) }}
      rail={d === undefined ? undefined : <WaitingOnYou desk={d} lang={i18n.language} />}
      ask={<AskBar id="ask-opd" placeholder={t("doctorDesk.opd.askPlaceholder")} fallback={() => null} terms={() => (view?.ordered ?? []).map((e) => e.patient?.name ?? "").filter((n) => n !== "")} />}
    >
      {me.isError && <p role="alert" className="dd-alert" data-testid="dd-opd-notdoctor">{t("doctorDesk.opd.notDoctor")}</p>}
      {(queue.isError || desk.isError) && <p role="alert" className="dd-alert">{deskErrorText(queue.error ?? desk.error, t)}</p>}
      {(callNext.isError || setStatus.isError) && <p role="alert" className="dd-alert">{deskErrorText(callNext.error ?? setStatus.error, t)}</p>}
      <div className="dd-opd">
        <YourLine view={view} next={next} at={d?.at ?? new Date().toISOString()} />
        <section className="dd-card dd-next" data-testid="dd-next">
          {view === null && <div className="dd-empty">{t("doctorDesk.opd.noSessionLong")}</div>}
          {view !== null && (
            <div className="dd-opd-ctl" data-testid="dd-opd-controls">
              <div className="ddf-seg" role="group" aria-label={t("doctorDesk.opd.sessionLabel")}>
                {(["in", "out", "closed"] as const).map((s) => (
                  <button key={s} type="button" aria-pressed={view.session.status === s} data-testid={`dd-opd-status-${s}`}
                    className={view.session.status === s ? "dd-seg-on" : ""} disabled={setStatus.isPending} onClick={() => setStatus.mutate(s)}>
                    {t(`doctorDesk.opd.session.${s}`)}
                  </button>
                ))}
              </div>
              <span className="ddf-grow" />
              <button type="button" className="ddf-btn ddf-btn-pri" data-testid="dd-opd-call" disabled={callNext.isPending || view.ordered.length === 0 || view.session.status !== "in"} onClick={() => callNext.mutate()}>
                {view.ordered[0] === undefined ? t("doctorDesk.opd.nobody") : t("doctorDesk.opd.call", { token: view.ordered[0].tokenNo })}
              </button>
            </div>
          )}
          {next !== null && <NextCard entry={next} card={card.data} lang={i18n.language} day={day} />}
          {view !== null && next === null && <div className="dd-empty">{t("doctorDesk.opd.lineEmpty")}</div>}
          {d !== undefined && <Pace desk={d} />}
        </section>
      </div>
    </DoctorDeskFrame>
  );
}

function YourLine({ view, next, at }: { view: WireQueueView | null; next: WireQueueEntryView | null; at: string }): React.ReactElement {
  const { t } = useTranslation();
  const rows = view === null ? [] : [...view.inConsult, ...(view.current !== null && !view.inConsult.some((e) => e.id === view.current!.id) ? [view.current] : []), ...view.ordered];
  const c = view?.counts;
  const longest = view === null ? null : view.ordered.reduce<number | null>((m, e) => {
    if (e.eligibleAt === null) return m;
    const w = Math.floor((Date.parse(at) - Date.parse(e.eligibleAt)) / 60_000);
    return m === null || w > m ? w : m;
  }, null);
  return (
    <section className="dd-card dd-line" data-testid="dd-line">
      <div className="dd-card-head"><h2 className="dd-h2">{t("doctorDesk.opd.line")}</h2></div>
      {c !== undefined && (
        <div className="dd-note" data-testid="dd-line-sum">
          {t("doctorDesk.opd.lineSum", { seen: c.done, waiting: c.waiting + c.called + (view?.waitingVitals ?? 0) })}
          {longest !== null && <> · {t("doctorDesk.opd.longest", { span: spanText(Math.max(0, longest), t) })}</>}
        </div>
      )}
      {rows.length === 0 && <div className="dd-empty">{view === null ? t("doctorDesk.opd.noSession") : t("doctorDesk.opd.lineEmpty")}</div>}
      <div className="dd-line-rows">
        {rows.map((e) => {
          const wait = e.eligibleAt === null ? null : Math.max(0, Math.floor((Date.parse(at) - Date.parse(e.eligibleAt)) / 60_000));
          return (
            <div key={e.id} className={`dd-tok${next?.id === e.id ? " dd-tok-next" : ""}`} data-testid={`dd-tok-${String(e.tokenNo)}`}>
              <span className="dd-tok-no">{e.tokenNo}</span>
              <span className="dd-tok-who">
                <span className="dd-tok-name">{e.patient === null ? t("doctorDesk.patientSealed") : (e.patient.restricted ? (e.patient.alias ?? t("doctorDesk.patientSealed")) : (e.patient.name ?? t("doctorDesk.patientSealed")))}</span>
                <span className="dd-tok-line">{rowLine(e, t)}</span>
              </span>
              <span className={`dd-tok-wait${e.danger || e.encounter.dangerFlagged ? " dd-red" : wait !== null && wait >= 30 ? " dd-amber" : ""}`}>
                {e.status === "in_consult" ? t("doctorDesk.opd.withYou") : wait === null ? "" : spanText(wait, t)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function NextCard({ entry, card, lang, day }: { entry: WireQueueEntryView; card: WireNextCard | undefined; lang: string; day: string }): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  const href = `/opd/consult/${entry.encounterId}`;
  const p = card?.patient;
  const who = p === undefined ? "" : patientName(p, t);
  const meta = card === undefined ? "" : [
    p?.ageYears !== null && p?.ageYears !== undefined ? `${String(p.ageYears)}${p.sex === null ? "" : ` ${t(`doctorDesk.opd.sex.${p.sex}`, { defaultValue: "" })}`}` : null,
    card.ordinal === 1 ? t("doctorDesk.opd.firstVisitShort") : t("doctorDesk.opd.visitN", { n: card.ordinal }),
  ].filter((x) => x !== null && x !== "").join(" · ");
  const v = card?.vitals ?? null;
  const vitals: { k: string; v: string; warn: boolean }[] = v === null ? [] : [
    v.sbp !== null && v.dbp !== null ? { k: "BP", v: `${String(v.sbp)}/${String(v.dbp)}`, warn: v.sbp >= 140 || v.dbp >= 90 } : null,
    v.pulse !== null ? { k: t("doctorDesk.opd.v.pulse"), v: String(v.pulse), warn: v.pulse > 100 || v.pulse < 50 } : null,
    v.weightKg !== null ? { k: t("doctorDesk.opd.v.weight"), v: `${String(v.weightKg)} kg`, warn: false } : null,
    v.glucoseMgDl !== null ? { k: t("doctorDesk.opd.v.sugar"), v: String(v.glucoseMgDl), warn: v.glucoseMgDl >= 200 } : null,
    v.spo2 !== null ? { k: "SpO₂", v: String(v.spo2), warn: v.spo2 < 94 } : null,
  ].filter((x): x is { k: string; v: string; warn: boolean } => x !== null);
  return (
    <div className="dd-nc" data-testid="dd-next-card">
      <div className="dd-nc-head">
        <div>
          <span className="dd-nc-tag">{t(entry.status === "in_consult" ? "doctorDesk.opd.withYouTag" : "doctorDesk.opd.nextTag", { token: entry.tokenNo })}</span>
          <h1 className="dd-h1">{who}{meta !== "" && <span className="dd-nc-meta"> · {meta}</span>}</h1>
        </div>
        {card !== undefined && card.allergies.length > 0 && <span className="dd-nc-allergy" data-testid="dd-next-allergy">{t("doctorDesk.opd.allergy", { list: card.allergies.join(", ") })}</span>}
      </div>
      {card === undefined && <div className="ddf-dim">{t("doctorDesk.loading")}</div>}
      {card !== undefined && (
        <>
          <div className="dd-nc-why" data-testid="dd-next-why">
            <div className="dd-cap">{t("doctorDesk.opd.why")}</div>
            {card.complaint === null ? <div className="ddf-dim">{t("doctorDesk.opd.whyNone")}</div> : (
              <>
                <div className="dd-nc-quote">“{card.complaint.text}”</div>
                <div className="dd-note">{t("doctorDesk.opd.whyBy", { by: card.complaint.byName ?? t("doctorDesk.opd.theDesk"), at: card.complaint.at === null ? "" : fmtIst(card.complaint.at) })}</div>
              </>
            )}
          </div>
          {vitals.length > 0 ? (
            <>
              <div className="dd-nc-vitals" data-testid="dd-next-vitals">
                {vitals.map((x) => <div key={x.k} className="dd-nc-vital"><span className="dd-cap">{x.k}</span><span className={`dd-nc-vv${x.warn ? " dd-amber" : ""}`}>{x.v}</span></div>)}
              </div>
              <div className="dd-note">{t(v!.today ? "doctorDesk.opd.vitalsBy" : "doctorDesk.opd.vitalsOld", { at: whenText(v!.recordedAt, day, lang), by: v!.byName ?? "" })}</div>
            </>
          ) : <div className="dd-note">{t("doctorDesk.opd.noVitals")}</div>}
          <div className="dd-nc-two">
            <div className="dd-nc-box" data-testid="dd-next-since">
              <div className="dd-cap">{card.lastSeen === null ? t("doctorDesk.opd.firstVisit") : t("doctorDesk.opd.since", { date: whenText(`${card.lastSeen}T06:30:00.000Z`, day, lang).replace(/ \d\d:\d\d$/, "") })}</div>
              {card.lastSeen !== null && card.since.length === 0 && <div className="ddf-dim">{t("doctorDesk.opd.sinceNone")}</div>}
              {card.since.map((s) => (
                <div key={s.analyte} className="dd-nc-res">
                  <span className={s.flag !== null && s.flag !== "N" ? "dd-amber dd-strong" : "dd-strong"}>{s.previous === null ? `${s.analyte} ${s.value ?? ""}` : `${s.analyte} ${s.previous} → ${s.value ?? ""}`}</span>
                  <span className="dd-note"> · {s.unit ?? ""} · {t("doctorDesk.opd.labOn", { at: whenText(s.at, day, lang).replace(/ \d\d:\d\d$/, "") })}</span>
                </div>
              ))}
            </div>
            <div className="dd-nc-box" data-testid="dd-next-rx">
              <div className="dd-cap">{t("doctorDesk.opd.heIsOn")}</div>
              {card.lastRx === null ? <div className="ddf-dim">{t("doctorDesk.opd.noRx")}</div>
                : card.lastRx.lines.map((l, i) => <div key={i} className="dd-nc-rx">{[l.drug, l.dose, l.frequency].filter((x) => x !== "").join(" · ")}</div>)}
            </div>
          </div>
          <div className="dd-nc-foot">
            <span className="dd-note">{t("doctorDesk.opd.notSuggestion")}</span>
            <a href={href} className="ddf-btn ddf-btn-pri dd-nc-open" data-testid="dd-next-open" onClick={(e) => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to: href }); }}>{t("doctorDesk.opd.open")}</a>
          </div>
        </>
      )}
    </div>
  );
}

function Pace({ desk }: { desk: WireOpdDesk }): React.ReactElement {
  const { t } = useTranslation();
  const p = desk.pace;
  const parts: string[] = [];
  if (p.sinceMinutes !== null) parts.push(t("doctorDesk.opd.paceSeen", { seen: p.seen, span: spanText(p.sinceMinutes, t) }));
  if (p.eachMinutes !== null) parts.push(t("doctorDesk.opd.paceEach", { n: p.eachMinutes }));
  if (p.endsAt !== null) parts.push(t("doctorDesk.opd.paceEnds", { at: fmtIst(p.endsAt) }));
  const busiest = desk.colleagues.reduce<WireOpdDesk["colleagues"][number] | null>((m, c) => (c.waiting > 0 && (m === null || c.waiting > m.waiting) ? c : m), null);
  return (
    <div className="dd-pace" data-testid="dd-pace">
      <span className="dd-pace-tag">{t("doctorDesk.opd.pace")}</span>
      <span>
        {parts.length === 0 ? t("doctorDesk.opd.paceNone") : parts.join(" · ")}
        {busiest !== null && <>{". "}<span data-testid="dd-pace-colleague">{t("doctorDesk.opd.colleague", { name: busiest.name, n: busiest.waiting })}</span></>}
      </span>
    </div>
  );
}

function WaitingOnYou({ desk, lang }: { desk: WireOpdDesk; lang: string }): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  return (
    <section className="dd-card" data-testid="dd-opd-waiting">
      <div className="dd-card-head"><h2 className="dd-h2">{t("doctorDesk.opd.waiting")}</h2></div>
      <div className="dd-note">{t("doctorDesk.opd.waitingSub")}</div>
      {desk.waitingOn.length === 0 && <div className="dd-empty">{t("doctorDesk.opd.waitingNone")}</div>}
      {desk.waitingOn.map((r) => (
        <div key={r.key} className={`dd-wo${r.goneHome ? " dd-wo-gone" : ""}`} data-testid={`dd-wo-${r.key}`}>
          <span className="dd-wo-what">
            <span className="dd-strong">{patientName(r.patient, t)}</span>
            <span className={r.tab === "critical" ? "dd-red" : "dd-amber"}>{signalText(r, t)}</span>
            <span className="dd-note">{r.goneHome ? t("doctorDesk.sub.goneHome", { at: whenText(r.at, desk.istDate, lang) }) : t(`doctorDesk.sub.${r.kind}`, { at: whenText(r.at, desk.istDate, lang), ...r.params })}</span>
          </span>
          <a href={r.href} className="dd-verb" onClick={(e) => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to: r.href }); }}>{t(`doctorDesk.verb.${r.kind}`)}</a>
        </div>
      ))}
    </section>
  );
}
