import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { ErDraft, ErDraftKind, ErEsiProposal, ErSinceArrival, ErWaitingDisplay } from "@hmis/contracts";
import { fmtIst } from "../lib/format";
import { useRealtime } from "../lib/realtime";
import { ER_BOARD_TOPIC, draftApi, fetchEsiProposal, fetchSinceArrival, fetchWaitingDisplay } from "../lib/er-api";
import type { EsiDecision, EsiLevel } from "../lib/er-api";

/**
 * ER lane 9 (#816) — THE ER COPILOT's SURFACES (spec §4.9, T2: it proposes, a person confirms). Each piece is a read:
 *  - `EsiCopilotCard` — the triage proposal (rules) with its reasons. "Use these answers" ticks the four questions; it
 *    never picks the level and never saves: the nurse still taps a level and Triage.
 *  - `SinceArrival` — four to six lines, each with its source chip; the doctor's patient view opens on it.
 *  - `DraftButton` — builds a draft on a tap and hands its fields to the form it belongs to, stamped "Draft".
 *  - `WaitingDisplay` — the waiting-area screen: a token and a stage word, nothing else.
 * No money anywhere (decision 0058).
 */
type T = (k: string, o?: Record<string, unknown>) => string;

export function EsiCopilotCard({ episodeId, onUse, onShown }: {
  episodeId: string; onUse: (d: EsiDecision) => void; onShown: (level: EsiLevel | null) => void;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const [p, setP] = useState<ErEsiProposal | null>(null);
  useEffect(() => {
    let live = true;
    fetchEsiProposal(episodeId).then((x) => { if (live) { setP(x); onShown(Array.isArray(x.reasons) ? x.level as EsiLevel : null); } }, () => { if (live) { setP(null); onShown(null); } });
    return () => { live = false; };
  }, [episodeId, onShown]);
  // A reply without reasons (an older server) shows nothing rather than a broken card.
  if (p === null || !Array.isArray(p.reasons)) return null;
  return (
    <section className="erc-copilot" data-testid="er-triage-copilot" aria-label={t("erCopilot.esi.title")}>
      <header>
        <span className="erc-tag">{t("erCopilot.suggestion")}</span>
        <b>{t("erCopilot.esi.says", { n: p.level, word: t(`er.esi.word.${String(p.level)}`) })}</b>
      </header>
      <ul>{p.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      <p className="dim">{t("erCopilot.esi.yours")}</p>
      <button type="button" className="erx-btn" data-testid="er-triage-copilot-use" onClick={() => onUse(p.decision as EsiDecision)}>{t("erCopilot.esi.use")}</button>
    </section>
  );
}

export function SinceArrival({ episodeId }: { episodeId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const [s, setS] = useState<ErSinceArrival | null>(null);
  const load = useCallback(() => { fetchSinceArrival(episodeId).then(setS, () => setS(null)); }, [episodeId]);
  useEffect(() => { load(); }, [load]);
  useRealtime([ER_BOARD_TOPIC], () => load());
  if (s === null || !Array.isArray(s.lines) || s.lines.length === 0) return null;
  return (
    <section className="erc-since" data-testid="er-patient-since" aria-label={t("erCopilot.since.title")}>
      <h2>{t("erCopilot.since.title")} <span className="dim mono">{fmtIst(s.arrivedAt)}</span></h2>
      <ul>
        {s.lines.map((l) => (
          <li key={l.key} className={l.abnormal ? "abn" : undefined} data-testid="er-patient-since-line">
            <span className={`erc-src src-${l.source}`}>{t(`erCopilot.source.${l.source}`)}</span>
            <span>{l.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DraftButton({ episodeId, kind, onUse }: { episodeId: string; kind: ErDraftKind; onUse: (fields: Record<string, string>) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [d, setD] = useState<ErDraft | null>(null);
  const [failed, setFailed] = useState(false);
  const build = (): void => {
    setBusy(true); setFailed(false);
    draftApi(episodeId, kind).then((x) => { setD(x); onUse(x.fields); }, () => setFailed(true)).finally(() => setBusy(false));
  };
  return (
    <div className="erc-draft" data-testid={`er-draft-${kind}`}>
      <button type="button" className="erx-btn sm" disabled={busy} onClick={build}>{t(`erCopilot.draft.${kind}`)}</button>
      {d !== null ? (
        <span className="erc-draft-note" role="status">
          <span className="erc-tag">{t("erCopilot.draft.label")}</span>
          {d.source === "model" ? t("erCopilot.draft.fromModel") : t(`erCopilot.draft.why.${d.fallback ?? "template_only"}`)}
          {d.unverified.length > 0 ? <span className="erc-unverified"> · {t("erCopilot.draft.unverified", { words: d.unverified.join(", ") })}</span> : null}
        </span>
      ) : null}
      {failed ? <span className="dim">{t("erDesk.failed")}</span> : null}
    </div>
  );
}

export function WaitingDisplay({ t }: { t: T }): React.ReactElement {
  const [d, setD] = useState<ErWaitingDisplay | null>(null);
  const [failed, setFailed] = useState(false);
  const [last, setLast] = useState<Date | null>(null);
  const load = useCallback(() => {
    fetchWaitingDisplay().then((x) => { setD(x); setFailed(false); setLast(new Date()); }, () => setFailed(true));
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 15_000); return () => clearInterval(id); }, [load]);
  return (
    <div className="erx erb wall erc-waiting" data-testid="er-waiting">
      <header className="erb-head">
        <div className="erb-title"><h1>{t("erCopilot.waiting.title")}</h1><span>{t("erCopilot.waiting.titleHi")}</span></div>
        <div className={`erb-live${failed ? " off" : ""}`} role="status">
          {failed ? t("erCopilot.waiting.offline", { time: last === null ? "—" : fmtIst(last.toISOString()) }) : t("erBoard.live", { time: last === null ? "—" : fmtIst(last.toISOString()) })}
        </div>
      </header>
      {d !== null && d.rows.length === 0 ? <div className="erb-empty">{t("erCopilot.waiting.empty")}</div> : null}
      <ol className="erc-tokens">
        {(Array.isArray(d?.rows) ? d.rows : []).map((r) => (
          <li key={r.token} data-testid="er-waiting-row">
            <span className="erc-token mono">{r.token}</span>
            <span className="erc-stage"><b>{t(`erCopilot.stage.${r.stage}`)}</b><span>{r.stageHi}</span></span>
          </li>
        ))}
      </ol>
      <p className="dim erc-waiting-foot">{t("erCopilot.waiting.foot")}</p>
    </div>
  );
}
