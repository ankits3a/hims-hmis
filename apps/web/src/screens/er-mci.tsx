import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { ErMciBoard, ErMciCount, ErMciPack, ErMciSurgeBed, ErRefusalBody } from "@hmis/contracts";
import { useAuth } from "../lib/auth";
import { dayMonthIst, fmtIst } from "../lib/format";
import { useRealtime } from "../lib/realtime";
import {
  ER_BOARD_TOPIC, ER_MCI_TAGS, declareMciApi, erRefusalOf, fetchMciBoard, fetchMciOverflowBeds, mciArrivalApi, mciTagApi, mintPacksApi,
  standDownMciApi, surgeApi,
} from "../lib/er-api";
import type { ErMciTagName } from "../lib/er-api";
import "../styles/paper-pine.css";
import "./er.css";

/**
 * ER lane 8 (#815) — THE MCI BOARD (spec SPEC-emergency §4.8, §5 G). No Code Yellow running: declare one (the MS or the
 * duty manager), make the pre-made packs, and read the last events' head counts. Running: the counts by tag (colour AND
 * word), packs ready, ER bays and surge bays left, hospital beds free; the desk registers a pack by its number with one
 * optional tag tap; nurses and doctors tag (a Black re-tag asks why); the duty manager opens overflow beds as surge
 * bays; the head count prints for the district authority (counts only); the stand-down returns everyone to ESI.
 * No money on this screen (0058).
 */
type T = (k: string, o?: Record<string, unknown>) => string;
type Act = (work: () => Promise<string | null>) => Promise<void>;

/** "15 Oct 14:02" in IST — a head count and a past event need the day, not only the time. */
function whenIst(iso: string): string {
  const day = new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return `${dayMonthIst(day)} ${fmtIst(iso)}`;
}

function Refusal({ r, t }: { r: ErRefusalBody | string; t: T }): React.ReactElement {
  if (typeof r === "string") return <div className="erd-refusal" role="alert"><b>{r}</b></div>;
  return <div className="erd-refusal" role="alert"><b>{t(`er.refusal.${r.code}.rule`, { defaultValue: r.rule })}</b><span className="dim">{t(`er.refusal.${r.code}.fix`, { defaultValue: r.fix })}</span></div>;
}

function TagChip({ tag, t }: { tag: ErMciTagName | null; t: T }): React.ReactElement {
  return <span className={`ery-tag ${tag ?? "none"}`}>{tag === null ? t("erMci.untagged") : t(`erMci.tag.${tag}`)}</span>;
}

function Count({ c, t }: { c: ErMciCount; t: T }): React.ReactElement {
  return (
    <div className="ery-count" data-testid="er-mci-count">
      <div className="ery-tiles">
        {ER_MCI_TAGS.map((k) => (
          <div key={k} className={`ery-tile ${k}`}><b>{c.byTag[k]}</b><span>{t(`erMci.tag.${k}`)}</span></div>
        ))}
        <div className="ery-tile none"><b>{c.byTag.untagged}</b><span>{t("erMci.untagged")}</span></div>
      </div>
      <p className="erp-text">
        {t("erMci.total", { n: c.total })} · {t("erMci.out.inDepartment", { n: c.byOutcome.inDepartment })} · {t("erMci.out.admitted", { n: c.byOutcome.admitted })} ·{" "}
        {t("erMci.out.discharged", { n: c.byOutcome.discharged })} · {t("erMci.out.referredOut", { n: c.byOutcome.referredOut })} · {t("erMci.out.died", { n: c.byOutcome.died })} ·{" "}
        {t("erMci.out.left", { n: c.byOutcome.left })}
      </p>
      <p className="dim">{t("erMci.asOf", { time: whenIst(c.asOf) })}</p>
    </div>
  );
}

export function ErMciScreen(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [board, setBoard] = useState<ErMciBoard | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ErRefusalBody | string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => { fetchMciBoard().then((b) => { setBoard(b); setFailed(false); }, () => setFailed(true)); }, []);
  useEffect(() => { load(); }, [load]);
  useRealtime([ER_BOARD_TOPIC], () => load());
  const act: Act = async (work) => {
    setBusy(true); setRefusal(null); setNote(null);
    try { const said = await work(); if (said !== null) setNote(said); load(); }
    catch (e) { setRefusal(erRefusalOf(e) ?? t("erDesk.failed")); } finally { setBusy(false); }
  };
  const m = board?.active ?? null;
  return (
    <div className={`erx erd ery${m !== null ? " running" : ""}`} data-testid="er-mci">
      <header className="erb-head">
        <div className="erb-title"><h1>{m === null ? t("erMci.title") : t("erMci.running", { name: m.name })}</h1>
          {m !== null ? <span className="dim">{t("erMci.since", { time: whenIst(m.declaredAt) })}{m.place !== null ? ` · ${m.place}` : ""}</span> : null}</div>
        <div className="erb-tools"><Link to="/er/board" className="erx-btn">{t("erDesk.board")}</Link></div>
      </header>
      {refusal !== null ? <Refusal r={refusal} t={t} /> : null}
      {note !== null ? <div className="erd-note" role="status">{note}</div> : null}
      {board === null ? <div className="erb-empty">{failed ? t("erDesk.failed") : t("erTriage.loading")}</div> : m === null
        ? <Idle board={board} t={t} busy={busy} act={act} />
        : <Running board={board} m={m} t={t} busy={busy} act={act} canRegister={can("er.arrival.register")} />}
    </div>
  );
}

function Idle({ board, t, busy, act }: { board: ErMciBoard; t: T; busy: boolean; act: Act }): React.ReactElement {
  const [name, setName] = useState("");
  const [place, setPlace] = useState("");
  const [count, setCount] = useState("40");
  const [made, setMade] = useState<ErMciPack[]>([]);
  return (
    <div className="erd-cols">
      <section className="erd-list" aria-label={t("erMci.declare")}>
        <div className="erd-form erm-form" data-testid="er-mci-declare">
          <h2>{t("erMci.declare")}</h2>
          <label className="erd-field"><span>{t("erMci.name")}</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("erMci.nameHint")} /></label>
          <label className="erd-field"><span>{t("erMci.place")}</span><input value={place} onChange={(e) => setPlace(e.target.value)} /></label>
          <button type="button" className="erx-btn ery-declare big" disabled={busy || name.trim() === ""} data-testid="er-mci-declare-go"
            onClick={() => void act(async () => { const r = await declareMciApi({ name: name.trim(), ...(place.trim() === "" ? {} : { place: place.trim() }) }); return t("erMci.declared", { n: r.paged }); })}>
            {t("erMci.declareGo")}</button>
          <p className="dim">{t("erMci.declareWho")}</p>
        </div>
        {board.recent.length > 0 ? <><h2>{t("erMci.recent")}</h2>{board.recent.map((c) => (
          <div key={c.mciId} className="erd-form"><b>{c.name}</b><span className="dim">{whenIst(c.declaredAt)} – {c.stoodDownAt === null ? "" : whenIst(c.stoodDownAt)}</span><Count c={c} t={t} /></div>
        ))}</> : null}
      </section>
      <section className="erd-new" aria-label={t("erMci.packs")}>
        <h2>{t("erMci.packs")} <span className="erb-badge" data-testid="er-mci-packs-ready">{board.packsReady}</span></h2>
        <p className="dim">{t("erMci.packsHint")}</p>
        <div className="erd-row">
          <label className="erd-field"><span>{t("erMci.howMany")}</span><input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))} /></label>
          <button type="button" className="erx-btn pri" disabled={busy || Number(count) < 1 || Number(count) > 100} data-testid="er-mci-mint"
            onClick={() => void act(async () => { const r = await mintPacksApi({ count: Number(count) }); setMade(r.packs); return t("erMci.minted", { n: r.packs.length }); })}>
            {t("erMci.mint")}</button>
          {made.length > 0 ? <button type="button" className="erx-btn" onClick={() => window.print()}>{t("erMci.printPacks")}</button> : null}
        </div>
        {made.length > 0 ? (
          <ol className="ery-packs" data-testid="er-mci-made">
            {made.map((p) => <li key={p.packId}><b className="mono">{p.packNo}</b> <span>{p.alias}</span> <span className="dim mono">{p.uhid}</span></li>)}
          </ol>
        ) : null}
      </section>
    </div>
  );
}

function Running({ board, m, t, busy, act, canRegister }: {
  board: ErMciBoard; m: ErMciCount; t: T; busy: boolean; act: Act; canRegister: boolean;
}): React.ReactElement {
  const [pack, setPack] = useState("");
  const [tag, setTag] = useState<ErMciTagName | null>(null);
  const [why, setWhy] = useState<Record<string, string>>({});
  const [beds, setBeds] = useState<ErMciSurgeBed[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [sure, setSure] = useState(false);
  const register = () => act(async () => {
    const r = await mciArrivalApi({ packNo: pack.trim(), ...(tag === null ? {} : { tag }) });
    setPack(""); setTag(null);
    return t("erMci.registered", { alias: r.alias, no: r.episodeNo });
  });
  return (
    <>
      <Count c={m} t={t} />
      <div className="ery-stats" data-testid="er-mci-stats">
        <span>{t("erMci.bays", { free: board.bays.free, total: board.bays.total })}</span>
        <span>{t("erMci.surge", { free: board.surge.free, total: board.surge.total })}</span>
        <span>{t("erMci.beds", { n: board.hospitalBedsFree })}</span>
        <span>{t("erMci.packsLeft", { n: board.packsReady })}</span>
      </div>
      <div className="erd-cols">
        <section className="erd-list" aria-label={t("erMci.patients")}>
          {canRegister ? (
            <div className="erc-call" data-testid="er-mci-register">
              <label className="erd-field"><span>{t("erMci.packNo")}</span>
                <input value={pack} onChange={(e) => setPack(e.target.value)} placeholder="MCI26-001" autoCapitalize="characters"
                  onKeyDown={(e) => { if (e.key === "Enter" && pack.trim().length >= 3 && !busy) void register(); }} /></label>
              <div className="erd-row">
                {ER_MCI_TAGS.map((k) => (
                  <button key={k} type="button" className={`erd-opt sm ery-pick ${k}${tag === k ? " on" : ""}`} aria-pressed={tag === k} onClick={() => setTag(tag === k ? null : k)}>{t(`erMci.tag.${k}`)}</button>
                ))}
                <button type="button" className="erx-btn pri" disabled={busy || pack.trim().length < 3} data-testid="er-mci-register-go" onClick={() => void register()}>{t("erMci.register")}</button>
              </div>
            </div>
          ) : null}
          <h2>{t("erMci.patients")} <span className="erb-badge">{board.patients.length}</span></h2>
          {board.patients.length === 0 ? <div className="erb-empty">{t("erMci.noPatients")}</div> : board.patients.map((p) => (
            <div key={p.episodeId} className="ert-row ery-row" data-testid="er-mci-patient">
              <span className="ert-row-main"><b>{p.label}</b><span className="dim mono">{p.episodeNo}{p.bayCode !== null ? ` · ${p.bayCode}` : ""}{p.esi !== null ? ` · ESI ${String(p.esi)}` : ""}</span></span>
              <TagChip tag={p.tag} t={t} />
              <span className="erd-row">
                {ER_MCI_TAGS.filter((k) => k !== p.tag).map((k) => (
                  <button key={k} type="button" className={`erd-opt sm ery-pick ${k}`} disabled={busy || (p.tag === "black" && (why[p.episodeId] ?? "").trim() === "")}
                    data-testid={`er-mci-tag-${k}`}
                    onClick={() => void act(async () => {
                      const reason = (why[p.episodeId] ?? "").trim();
                      await mciTagApi({ episodeId: p.episodeId, tag: k, ...(reason === "" ? {} : { reason }) });
                      return t("erMci.tagged", { label: p.label, tag: t(`erMci.tag.${k}`) });
                    })}>{t(`erMci.tag.${k}`)}</button>
                ))}
              </span>
              {p.tag === "black" ? (
                <label className="erd-field"><span>{t("erMci.retagWhy")}</span>
                  <input value={why[p.episodeId] ?? ""} onChange={(e) => setWhy({ ...why, [p.episodeId]: e.target.value })} /></label>
              ) : null}
            </div>
          ))}
        </section>
        <section className="erd-new" aria-label={t("erMci.command")}>
          <h2>{t("erMci.surgeTitle")}</h2>
          {beds === null ? (
            <button type="button" className="erx-btn" disabled={busy} data-testid="er-mci-surge-open"
              onClick={() => void fetchMciOverflowBeds().then((b) => { setBeds(b); setPick(new Set()); }, () => setBeds([]))}>{t("erMci.surgePick")}</button>
          ) : beds.length === 0 ? <div className="erb-empty">{t("erMci.noOverflow")}</div> : (
            <>
              <div className="erc-pads">{beds.map((b) => (
                <label key={b.bedId} className={`erd-opt sm${b.approved ? " on" : ""}`}>
                  <input type="checkbox" disabled={b.approved || b.status !== "free"} checked={b.approved || pick.has(b.bedId)}
                    onChange={(e) => { const n = new Set(pick); if (e.target.checked) n.add(b.bedId); else n.delete(b.bedId); setPick(n); }} />
                  {" "}{b.code}{b.ward !== null ? ` · ${b.ward}` : ""}
                </label>
              ))}</div>
              <button type="button" className="erx-btn pri" disabled={busy || pick.size === 0} data-testid="er-mci-surge-go"
                onClick={() => void act(async () => { const r = await surgeApi({ mciId: m.mciId, bedIds: [...pick] }); setBeds(null); return t("erMci.surgeOpened", { n: r.opened.length }); })}>
                {t("erMci.surgeGo", { n: pick.size })}</button>
            </>
          )}
          <h2>{t("erMci.headCount")}</h2>
          <p className="dim">{t("erMci.headCountHint")}</p>
          <button type="button" className="erx-btn" onClick={() => window.print()} data-testid="er-mci-print">{t("erMci.printCount")}</button>
          <h2>{t("erMci.standDown")}</h2>
          {!sure ? <button type="button" className="erx-btn danger" disabled={busy} onClick={() => setSure(true)} data-testid="er-mci-stand-down">{t("erMci.standDown")}</button> : (
            <div className="erd-row">
              <button type="button" className="erx-btn danger" disabled={busy} data-testid="er-mci-stand-down-go"
                onClick={() => void act(async () => { const r = await standDownMciApi({ mciId: m.mciId }); setSure(false); return t("erMci.stoodDown", { n: r.backToEsi }); })}>
                {t("erMci.standDownSure")}</button>
              <button type="button" className="erx-btn" onClick={() => setSure(false)}>{t("erMci.cancel")}</button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
