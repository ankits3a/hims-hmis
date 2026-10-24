import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { ErMlcClock, ErMlcDesk, ErMlcDetail, ErMlcRow, ErRefusalBody } from "@hmis/contracts";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { useRealtime } from "../lib/realtime";
import {
  ER_BOARD_TOPIC, ER_EVIDENCE_KINDS, ER_MLC_CATEGORIES, erRefusalOf, fetchMlc, fetchMlcDesk, mlcAddendumApi, mlcBelongingsApi,
  mlcCountersignApi, mlcEvidenceApi, mlcIntimationApi,
} from "../lib/er-api";
import "../styles/paper-pine.css";
import "./er.css";

/**
 * ER lane 4 (#811) — THE MLC DESK (spec SPEC-emergency §5 E: "owed intimations and countersigns with clocks; prints").
 *
 * Left: every medico-legal case with something owed, the oldest due first — the police intimation's 1-hour clock and the
 * faculty countersign's 24-hour clock, each in words ("due in 40 min", "overdue 25 min", "done"); below, the last week's
 * cases with nothing owed. Right: one case — the original as opened (never edited), the addenda, the intimation (or its
 * form), the countersign, the belongings and the evidence chain, each link signed by two staff. "Print" prints the case
 * (the MLC copy) from the record. No money anywhere (0058); the MLC never gates care.
 */
type T = (k: string, o?: Record<string, unknown>) => string;
type Act = (work: () => Promise<string | null>) => Promise<void>;

/** An unidentified patient's alias in the reader's language (`Unknown-0412` → `अज्ञात-0412`). */
function labelIn(label: string, lang: string): string {
  return lang.startsWith("hi") ? label.replace(/^Unknown-/, "अज्ञात-") : label;
}

function clockWords(t: T, c: ErMlcClock, now: number): { text: string; late: boolean } {
  if (c.metAt !== null) return { text: c.breached ? t("erMlc.clock.doneLate", { time: fmtIst(c.metAt) }) : t("erMlc.clock.done", { time: fmtIst(c.metAt) }), late: false };
  const min = Math.round((new Date(c.dueAt).getTime() - now) / 60_000);
  if (min >= 0) return { text: min >= 120 ? t("erMlc.clock.dueHours", { hours: Math.floor(min / 60) }) : t("erMlc.clock.dueIn", { minutes: min }), late: false };
  const over = -min;
  return { text: over >= 120 ? t("erMlc.clock.overdueHours", { hours: Math.floor(over / 60) }) : t("erMlc.clock.overdue", { minutes: over }), late: true };
}

function Refusal({ r, t }: { r: ErRefusalBody | string; t: T }): React.ReactElement {
  if (typeof r === "string") return <div className="erd-refusal" role="alert"><b>{r}</b></div>;
  return (
    <div className="erd-refusal" role="alert" data-testid="er-mlc-refusal">
      <b>{t(`er.refusal.${r.code}.rule`, { defaultValue: r.rule })}</b>
      <span className="dim">{t(`er.refusal.${r.code}.fix`, { defaultValue: r.fix })}</span>
    </div>
  );
}

function Row({ r, t, now, on, pick, lang }: { r: ErMlcRow; t: T; now: number; on: boolean; pick: () => void; lang: string }): React.ReactElement {
  const i = clockWords(t, r.intimation, now);
  const c = clockWords(t, r.countersign, now);
  return (
    <button type="button" className={`ert-row erm-row${on ? " on" : ""}`} onClick={pick} aria-pressed={on} data-testid="er-mlc-row">
      <span className="ert-row-main">
        <b>{labelIn(r.patientLabel, lang)}</b>
        <span className="dim"><span className="mono">{r.mlcNo}</span> · <span className="mono">{r.episodeNo}</span> · {t(`erMlc.category.${r.category}`)}</span>
        <span className="erb-chips">
          <span className={`erb-clock${i.late ? " late" : ""}`} data-testid="er-mlc-intimation">{t("erMlc.intimation")}: {i.text}</span>
          <span className={`erb-clock${c.late ? " late" : ""}`} data-testid="er-mlc-countersign">{t("erMlc.countersign")}: {c.text}</span>
          {r.late ? <span className="erb-chip name_alert">{t("erMlc.late")}</span> : null}
          {r.pocso ? <span className="erb-chip critical">POCSO</span> : null}
          {r.openedByRule ? <span className="erb-chip">{t("erMlc.byRule")}</span> : null}
        </span>
      </span>
    </button>
  );
}

export function ErMlc(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const search = useSearch({ strict: false }) as { mlc?: string };
  const navigate = useNavigate();
  const picked = typeof search.mlc === "string" && search.mlc !== "" ? search.mlc : null;
  const [desk, setDesk] = useState<ErMlcDesk | null>(null);
  const [mlc, setMlc] = useState<ErMlcDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ErRefusalBody | string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    fetchMlcDesk().then((d) => { setDesk(d); setNow(new Date(d.serverNow).getTime()); }, () => setDesk(null));
    if (picked !== null) fetchMlc(picked).then(setMlc, () => setMlc(null)); else setMlc(null);
  }, [picked]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const id = setInterval(() => setNow((n) => n + 30_000), 30_000); return () => clearInterval(id); }, []);
  useRealtime([ER_BOARD_TOPIC], () => load());
  // On a phone the case sits under the list: bring it into view when one is picked.
  const caseId = mlc?.mlcId ?? null;
  useEffect(() => {
    if (caseId !== null && window.innerWidth <= 760) document.querySelector("[data-testid='er-mlc-case']")?.scrollIntoView({ block: "start" });
  }, [caseId]);

  const pick = (id: string) => { setRefusal(null); setNote(null); void navigate({ to: "/er/mlc", search: { mlc: id } as never }); };
  const act: Act = async (work) => {
    setBusy(true); setRefusal(null); setNote(null);
    try { const said = await work(); if (said !== null) setNote(said); load(); }
    catch (e) { setRefusal(erRefusalOf(e) ?? t("erDesk.failed")); } finally { setBusy(false); }
  };

  return (
    <div className="erx erd erm" data-testid="er-mlc">
      <header className="erb-head">
        <div className="erb-title"><h1>{t("erMlc.title")}</h1><span>{fmtIst(new Date(now).toISOString())}</span></div>
        <div className="erb-tools">
          <Link to="/er/board" className="erx-btn">{t("erDesk.board")}</Link>
          <Link to="/" className="erx-btn">{t("erBoard.home")}</Link>
        </div>
      </header>
      <div className="erd-cols">
        <section className="erd-list erm-list" aria-label={t("erMlc.owed")}>
          <h2>{t("erMlc.owed")} <span className="erb-badge">{desk?.owed.length ?? 0}</span></h2>
          {desk === null ? <div className="erb-empty">{t("erTriage.loading")}</div>
            : desk.owed.length === 0 ? <div className="erb-empty" data-testid="er-mlc-none-owed">{t("erMlc.noneOwed")}</div>
              : desk.owed.map((r) => <Row key={r.mlcId} r={r} t={t} now={now} on={r.mlcId === picked} pick={() => pick(r.mlcId)} lang={i18n.language} />)}
          {desk !== null && desk.recent.length > 0 ? (
            <>
              <h2>{t("erMlc.recent")}</h2>
              {desk.recent.map((r) => <Row key={r.mlcId} r={r} t={t} now={now} on={r.mlcId === picked} pick={() => pick(r.mlcId)} lang={i18n.language} />)}
            </>
          ) : null}
        </section>
        <section className="erd-new erm-case" aria-label={t("erMlc.case")} data-testid="er-mlc-case">
          {refusal !== null ? <Refusal r={refusal} t={t} /> : null}
          {note !== null ? <div className="erd-note" role="status">{note}</div> : null}
          {mlc === null ? <div className="erb-empty">{t("erMlc.pick")}</div>
            : <Case m={mlc} t={t} now={now} busy={busy} act={act} canSign={can("er.mlc")} lang={i18n.language} />}
        </section>
      </div>
    </div>
  );
}

function Case({ m, t, now, busy, act, canSign, lang }: { m: ErMlcDetail; t: T; now: number; busy: boolean; act: Act; canSign: boolean; lang: string }): React.ReactElement {
  const i = clockWords(t, m.intimation, now);
  const c = clockWords(t, m.countersign, now);
  return (
    <div className="erm-detail">
      <div className="erd-ep-top">
        <div className="erd-ep-name"><b>{labelIn(m.patientLabel, lang)}</b><span className="mono">{m.uhid}</span></div>
        <button type="button" className="erx-btn sm" onClick={() => window.print()} data-testid="er-mlc-print">{t("erMlc.print")}</button>
      </div>
      <div className="erb-meta">
        <span className="mono">{m.mlcNo}</span><span className="mono">{m.episodeNo}</span>
        <span>{t(`erMlc.category.${m.category}`)}{m.category !== m.originalCategory ? ` (${t("erMlc.openedAs", { cat: t(`erMlc.category.${m.originalCategory}`) })})` : ""}</span>
        <span>{t("erMlc.openedBy", { name: m.openedBy.name, time: fmtIst(m.openedAt) })}</span>
        {m.late ? <span className="erb-chip name_alert">{t("erMlc.late")}</span> : null}
      </div>
      {m.mortuaryEntryId !== null ? <p className="erd-hint" data-testid="er-mlc-mortuary">{t("erMlc.mortuary")}</p> : null}

      <h2>{t("erMlc.original")}</h2>
      {m.informant !== null ? (
        <article className="erd-ep"><div className="erd-ep-top"><b>{m.informant.name}</b><span className="erd-state">{m.informant.relation}</span></div>
          <p className="erp-text">“{m.informant.words}”</p></article>
      ) : <div className="erb-empty">{t("erMlc.noInformant")}</div>}
      {m.injuries.length > 0 ? <div className="erb-chips">{m.injuries.map((x, n) => <span key={n} className="erb-chip">{x.site} · {t(`erMlc.injury.${x.kind}`)}{x.sizeCm !== undefined ? ` · ${x.sizeCm} cm` : ""}</span>)}</div> : null}

      {m.addenda.length > 0 ? <h2>{t("erMlc.addenda")}</h2> : null}
      {m.addenda.map((a) => (
        <article key={a.addendumId} className="erd-ep" data-testid="er-mlc-addendum">
          <div className="erd-ep-top"><b>{a.by.name}</b><span className="erd-state">{fmtIst(a.at)}</span></div>
          <p className="erp-text">{a.text}</p>
          <div className="erb-chips">
            {a.category !== null ? <span className="erb-chip">{t(`erMlc.category.${a.category}`)}</span> : null}
            {a.examinationRefused ? <span className="erb-chip name_alert">{t("erMlc.refusedExam")}</span> : null}
            {a.injuries.map((x, n) => <span key={n} className="erb-chip">{x.site} · {t(`erMlc.injury.${x.kind}`)}</span>)}
          </div>
        </article>
      ))}

      <h2>{t("erMlc.intimation")} <span className={`erb-clock${i.late ? " late" : ""}`}>{i.text}</span></h2>
      {m.intimationRecord !== null ? (
        <article className="erd-ep" data-testid="er-mlc-intimation-record">
          <div className="erd-ep-top"><b>{m.intimationRecord.station}</b><span className="erd-state">{t(`erMlc.mode.${m.intimationRecord.mode}`)} · {fmtIst(m.intimationRecord.intimatedAt)}</span></div>
          <div className="erb-meta"><span>{m.intimationRecord.receiverName}{m.intimationRecord.receiverRank !== null ? ` (${m.intimationRecord.receiverRank})` : ""}</span>
            {m.intimationRecord.gdEntryNo !== null ? <span>GD {m.intimationRecord.gdEntryNo}</span> : null}
            <span className="dim">{t("erMlc.recordedBy", { name: m.intimationRecord.recordedBy.name })}</span></div>
        </article>
      ) : canSign ? <IntimationForm t={t} busy={busy} onSave={(body) => act(async () => {
        const r = await mlcIntimationApi({ mlcId: m.mlcId, ...body });
        return r.withinTarget ? t("erMlc.intimated") : t("erMlc.intimatedLate");
      })} /> : null}

      <h2>{t("erMlc.countersign")} <span className={`erb-clock${c.late ? " late" : ""}`}>{c.text}</span></h2>
      {m.countersignedBy !== null ? <p className="erp-text">{t("erMlc.countersignedBy", { name: m.countersignedBy.name })}</p>
        : canSign ? <button type="button" className="erx-btn pri" disabled={busy} data-testid="er-mlc-countersign-btn"
          onClick={() => void act(async () => { await mlcCountersignApi(m.mlcId); return t("erMlc.countersigned"); })}>{t("erMlc.countersignNow")}</button> : null}

      <h2>{t("erMlc.custody")}</h2>
      {m.custody.length === 0 ? <div className="erb-empty">{t("erMlc.noCustody")}</div> : m.custody.map((l) => (
        <article key={l.custodyId} className="erd-ep" data-testid="er-mlc-link">
          <div className="erd-ep-top">
            <b>#{l.link} · {l.kind === "belongings" ? t("erMlc.belongings") : `${t(`erMlc.evidence.${l.evidenceKind ?? "other"}`)} · ${t(`erMlc.action.${l.action}`)}`}</b>
            <span className="erd-state">{fmtIst(l.at)}</span></div>
          {l.items !== null ? <p className="erp-text">{l.items.map((x) => `${x.description} × ${String(x.qty)}`).join(", ")}{l.keptIn !== null ? ` — ${t(`erMlc.keptIn.${l.keptIn.kind}`)}: ${l.keptIn.ref}` : ""}</p> : null}
          {l.sealNo !== null ? <p className="erp-text"><span className="mono">{l.sealNo}</span>{l.description !== null ? ` · ${l.description}` : ""}{l.receiver !== null ? ` → ${l.receiver.name} (${l.receiver.rank}, ${l.receiver.station})` : ""}</p> : null}
          <div className="erb-meta dim"><span>{t("erMlc.signedBy", { a: l.recordedBy.name, b: l.witnessedBy.name })}</span></div>
        </article>
      ))}
      {canSign ? <CustodyForms t={t} busy={busy} act={act} mlcId={m.mlcId} /> : null}
      {canSign ? <AddendumForm t={t} busy={busy} onSave={(body) => act(async () => { await mlcAddendumApi({ mlcId: m.mlcId, ...body }); return t("erMlc.addendumSaved"); })} /> : null}
    </div>
  );
}

function IntimationForm({ t, busy, onSave }: { t: T; busy: boolean; onSave: (body: Record<string, unknown>) => Promise<void> }): React.ReactElement {
  const [mode, setMode] = useState<"written" | "phone_then_written" | "police_present">("written");
  const [station, setStation] = useState("");
  const [receiver, setReceiver] = useState("");
  const [rank, setRank] = useState("");
  const [gd, setGd] = useState("");
  return (
    <div className="erd-form erm-form" data-testid="er-mlc-intimation-form">
      <div className="erd-opts">{(["written", "phone_then_written", "police_present"] as const).map((x) => (
        <button key={x} type="button" className={`erd-opt sm${mode === x ? " on" : ""}`} aria-pressed={mode === x} onClick={() => setMode(x)}>{t(`erMlc.mode.${x}`)}</button>
      ))}</div>
      <label className="erd-field"><span>{t("erMlc.station")}</span><input value={station} onChange={(e) => setStation(e.target.value)} /></label>
      <div className="erd-pair">
        <label className="erd-field"><span>{t("erMlc.receiver")}</span><input value={receiver} onChange={(e) => setReceiver(e.target.value)} /></label>
        <label className="erd-field"><span>{t("erMlc.rank")}</span><input value={rank} onChange={(e) => setRank(e.target.value)} /></label>
      </div>
      <label className="erd-field"><span>{t("erMlc.gd")}</span><input value={gd} onChange={(e) => setGd(e.target.value)} /></label>
      <button type="button" className="erx-btn pri" disabled={busy || station.trim() === "" || receiver.trim() === ""} data-testid="er-mlc-intimate"
        onClick={() => void onSave({
          mode, station: station.trim(), receiverName: receiver.trim(),
          ...(rank.trim() !== "" ? { receiverRank: rank.trim() } : {}), ...(gd.trim() !== "" ? { gdEntryNo: gd.trim() } : {}),
        })}>{t("erMlc.intimate")}</button>
    </div>
  );
}

function SecondPerson({ t, user, pin, setUser, setPin }: { t: T; user: string; pin: string; setUser: (v: string) => void; setPin: (v: string) => void }): React.ReactElement {
  return (
    <div className="erd-pair">
      <label className="erd-field"><span>{t("erPatient.med.secondUser")}</span><input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" /></label>
      <label className="erd-field"><span>{t("erPatient.med.secondPin")}</span><input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} type="password" inputMode="numeric" autoComplete="off" /></label>
    </div>
  );
}

function CustodyForms({ t, busy, act, mlcId }: { t: T; busy: boolean; act: Act; mlcId: string }): React.ReactElement {
  const [tab, setTab] = useState<"belongings" | "evidence">("belongings");
  const [user, setUser] = useState("");
  const [pin, setPin] = useState("");
  const [items, setItems] = useState("");
  const [keptKind, setKeptKind] = useState<"locker" | "relative" | "police">("locker");
  const [keptRef, setKeptRef] = useState("");
  const [kind, setKind] = useState<string>("clothes");
  const [desc, setDesc] = useState("");
  const [seal, setSeal] = useState("");
  const [action, setAction] = useState<"collected" | "stored" | "handed_over">("collected");
  const [officer, setOfficer] = useState("");
  const [rank, setRank] = useState("");
  const [station, setStation] = useState("");
  const second = { username: user.trim(), pin };
  const okSecond = user.trim() !== "" && pin.length >= 4;
  const lines = items.split("\n").map((x) => x.trim()).filter((x) => x !== "");
  return (
    <div className="erd-form erm-form" data-testid="er-mlc-custody-form">
      <div className="erd-tabs erm-tabs">
        {(["belongings", "evidence"] as const).map((x) => <button key={x} type="button" className={`erd-tab${tab === x ? " on" : ""}`} aria-pressed={tab === x} onClick={() => setTab(x)}>{t(x === "belongings" ? "erMlc.belongings" : "erMlc.evidenceTab")}</button>)}
      </div>
      {tab === "belongings" ? (
        <>
          <label className="erd-field"><span>{t("erMlc.items")}</span><textarea rows={3} value={items} onChange={(e) => setItems(e.target.value)} placeholder={t("erMlc.itemsHint")} /></label>
          <div className="erd-pair">
            <label className="erd-field"><span>{t("erMlc.keptInLabel")}</span>
              <select value={keptKind} onChange={(e) => setKeptKind(e.target.value as "locker")}>{(["locker", "relative", "police"] as const).map((k) => <option key={k} value={k}>{t(`erMlc.keptIn.${k}`)}</option>)}</select></label>
            <label className="erd-field"><span>{t("erMlc.keptRef")}</span><input value={keptRef} onChange={(e) => setKeptRef(e.target.value)} /></label>
          </div>
        </>
      ) : (
        <>
          <div className="erd-pair">
            <label className="erd-field"><span>{t("erMlc.evidenceKind")}</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>{ER_EVIDENCE_KINDS.map((k) => <option key={k} value={k}>{t(`erMlc.evidence.${k}`)}</option>)}</select></label>
            <label className="erd-field"><span>{t("erMlc.seal")}</span><input value={seal} onChange={(e) => setSeal(e.target.value)} /></label>
          </div>
          <label className="erd-field"><span>{t("erMlc.description")}</span><input value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
          <div className="erd-opts">{(["collected", "stored", "handed_over"] as const).map((x) => (
            <button key={x} type="button" className={`erd-opt sm${action === x ? " on" : ""}`} aria-pressed={action === x} onClick={() => setAction(x)}>{t(`erMlc.action.${x}`)}</button>
          ))}</div>
          {action === "handed_over" ? (
            <div className="erd-pair">
              <label className="erd-field"><span>{t("erMlc.receiver")}</span><input value={officer} onChange={(e) => setOfficer(e.target.value)} /></label>
              <label className="erd-field"><span>{t("erMlc.rank")}</span><input value={rank} onChange={(e) => setRank(e.target.value)} /></label>
              <label className="erd-field"><span>{t("erMlc.station")}</span><input value={station} onChange={(e) => setStation(e.target.value)} /></label>
            </div>
          ) : null}
        </>
      )}
      <SecondPerson t={t} user={user} pin={pin} setUser={setUser} setPin={setPin} />
      {tab === "belongings" ? (
        <button type="button" className="erx-btn pri" disabled={busy || !okSecond || lines.length === 0 || keptRef.trim() === ""} data-testid="er-mlc-belongings-save"
          onClick={() => void act(async () => {
            await mlcBelongingsApi({ mlcId, items: lines.map((d) => ({ description: d, qty: 1 })), keptIn: { kind: keptKind, ref: keptRef.trim() }, secondPerson: second });
            setItems(""); setPin("");
            return t("erMlc.belongingsSaved");
          })}>{t("erMlc.saveBelongings")}</button>
      ) : (
        <button type="button" className="erx-btn pri" disabled={busy || !okSecond || seal.trim() === "" || desc.trim() === "" || (action === "handed_over" && (officer.trim() === "" || rank.trim() === "" || station.trim() === ""))}
          data-testid="er-mlc-evidence-save"
          onClick={() => void act(async () => {
            const r = await mlcEvidenceApi({
              mlcId, kind, description: desc.trim(), sealNo: seal.trim(), action, secondPerson: second,
              ...(action === "handed_over" ? { receiver: { name: officer.trim(), rank: rank.trim(), station: station.trim() } } : {}),
            });
            setPin("");
            return t("erMlc.linkSaved", { link: r.link });
          })}>{t("erMlc.saveEvidence")}</button>
      )}
    </div>
  );
}

function AddendumForm({ t, busy, onSave }: { t: T; busy: boolean; onSave: (body: Record<string, unknown>) => Promise<void> }): React.ReactElement {
  const [text, setText] = useState("");
  const [category, setCategory] = useState("");
  const [refused, setRefused] = useState(false);
  return (
    <details className="erd-newpatient erm-form" data-testid="er-mlc-addendum-form">
      <summary>{t("erMlc.addAddendum")}</summary>
      <label className="erd-field"><span>{t("erMlc.addendumText")}</span><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <label className="erd-field"><span>{t("erMlc.changeCategory")}</span>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t("erMlc.keepCategory")}</option>
          {ER_MLC_CATEGORIES.map((c) => <option key={c} value={c}>{t(`erMlc.category.${c}`)}</option>)}
        </select></label>
      <label className="erd-check"><input type="checkbox" checked={refused} onChange={(e) => setRefused(e.target.checked)} />{t("erMlc.refusedExam")}</label>
      <button type="button" className="erx-btn pri" disabled={busy || text.trim() === ""} data-testid="er-mlc-addendum-save"
        onClick={() => void onSave({ text: text.trim(), ...(category !== "" ? { category } : {}), ...(refused ? { examinationRefused: true } : {}) }).then(() => setText(""))}>{t("erMlc.saveAddendum")}</button>
    </details>
  );
}
