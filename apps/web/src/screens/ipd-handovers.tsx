import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdHandoverCard, IpdHandoverList, IpdRefusalBody, IpdShiftHandoverCard, IpdShiftHandoverList } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { refusalOf } from "../lib/ipd-beds-api";
import { acceptShiftHandover, getShiftHandovers } from "../lib/ipd-nursing-api";
import { acceptHandover, cancelTransfer, getHandovers } from "../lib/ipd-transfer-api";
import "./ipd-transfer.css";

/**
 * E3.1 (#729) — "WAITING FOR YOU": the receiving ward's handover list (spec §4.4, §4.9 D handover). Every transfer
 * waiting for acceptance, oldest first: who, from which bed to which, why, the sending nurse's SBAR, and the clocks
 * in words ("Sent 12 min ago", "Escalates in 18 min" / "Escalated 4 min ago" with an icon). Accept is the act that
 * moves the patient (the origin bed is released only then); Decline sends it back. A nurse never accepts a
 * transfer they sent. One column on a phone (390 px, 48 px targets); a grid at 1366 and 1920.
 * Refreshes every 15 s and after every act; the clocks tick every 30 s from the server's numbers.
 */

const POLL_MS = 15_000;
const TICK_MS = 30_000;

type T = (k: string, o?: Record<string, unknown>) => string;

/** A span of minutes in words: "just now", "12 min", "1 h 5 min". */
export function spanWords(ms: number, t: T): string {
  const min = Math.floor(Math.abs(ms) / 60_000);
  if (min < 1) return t("ipdTransfer.dur.justNow");
  if (min < 60) return t("ipdTransfer.dur.min", { n: min });
  return t("ipdTransfer.dur.hourMin", { h: Math.floor(min / 60), m: min % 60 });
}

export function IpdHandovers(): React.ReactElement {
  const { t } = useTranslation();
  const [list, setList] = useState<IpdHandoverList | null>(null);
  const [error, setError] = useState<"forbidden" | "failed" | null>(null);
  const [ward, setWard] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    getHandovers().then(
      (l) => { setList(l); setError(null); setNow(Date.now()); },
      (e: unknown) => setError(e instanceof ApiError && e.status === 403 ? "forbidden" : "failed"),
    );
  }, []);
  useEffect(() => { load(); const id = setInterval(load, POLL_MS); return () => clearInterval(id); }, [load]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), TICK_MS); return () => clearInterval(id); }, []);

  const cards = (list?.handovers ?? []).filter((h) => ward === null || h.toBed.wardId === ward);
  return (
    <main className="ipdh" data-testid="ipd-handovers">
      <header className="ipdh-head">
        <h1>{t("ipdTransfer.handovers.title")}</h1>
        {list !== null ? <span className="count">{t("ipdTransfer.handovers.count", { count: cards.length })}</span> : null}
      </header>
      {error === "forbidden" ? <div className="ipdh-empty" role="alert">{t("ipdTransfer.handovers.forbidden")}</div> : null}
      {error === "failed" ? <div className="ipdh-refusal" role="alert">{t("ipdTransfer.handovers.loadFailed")}</div> : null}
      {list === null && error === null ? <div className="ipdh-empty">{t("ipdTransfer.handovers.loading")}</div> : null}
      {list !== null && list.wards.length > 1 ? (
        <nav className="ipdh-chips" aria-label={t("ipdTransfer.handovers.wards")}>
          <button type="button" className="ipdh-chip" aria-pressed={ward === null} onClick={() => setWard(null)}>
            {t("ipdTransfer.handovers.allWards", { count: list.handovers.length })}
          </button>
          {list.wards.map((w) => (
            <button key={w.id} type="button" className="ipdh-chip" aria-pressed={ward === w.id} onClick={() => setWard(w.id)}>
              {w.name} · {w.count}
            </button>
          ))}
        </nav>
      ) : null}
      {list !== null && cards.length === 0 ? <div className="ipdh-empty" data-testid="ipd-handovers-empty">{t("ipdTransfer.handovers.empty")}</div> : null}
      <div className="ipdh-list">
        {cards.map((h) => <HandoverCard key={h.transferId} h={h} now={now} onDone={load} />)}
      </div>
      <ShiftHandovers />
    </main>
  );
}

function HandoverCard({ h, now, onDone }: { h: IpdHandoverCard; now: number; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const run = (p: Promise<unknown>, word: string): void => {
    setBusy(true); setRefusal(null); setFailed(false);
    p.then(
      () => { setBusy(false); setDone(word); onDone(); },
      (e: unknown) => { setBusy(false); const r = refusalOf(e); if (r) setRefusal(r); else setFailed(true); },
    );
  };

  const sent = now - new Date(h.startedAt).getTime();
  const esc = h.escalatesAt === null ? null : new Date(h.escalatesAt).getTime() - now;
  const late = h.escalated || (esc !== null && esc <= 0);
  const reasonWord = t(`ipdTransfer.reason.${h.reason}`);
  return (
    <article className={`ipdh-card${late ? " late" : ""}`} data-testid={`ipd-handover-${h.transferId}`}>
      <div className="ipdh-who">
        <b>{h.patient.name ?? h.patient.initials}</b>
        <span>{h.patient.ageSex}</span>
        <span className="mono">{t("ipdTransfer.handovers.uhid", { uhid: h.patient.uhid })}</span>
        {h.admissionNo !== null ? <span className="mono">{h.admissionNo}</span> : null}
      </div>
      <div className="ipdh-move">
        <span><span className="bed">{h.fromBed.code}</span>{h.fromBed.wardName ? <span className="dim"> · {h.fromBed.wardName}</span> : null}</span>
        <span className="arrow" aria-label={t("ipdTransfer.handovers.to")}>→</span>
        <span><span className="bed">{h.toBed.code}</span>{h.toBed.wardName ? <span className="dim"> · {h.toBed.wardName}</span> : null}</span>
        <span className="dim">· {t(`ipdBeds.class.${h.toBed.class}`)}</span>
      </div>
      <div className="ipdh-meta">
        <span>{reasonWord}</span>
        <span>{t("ipdTransfer.handovers.sent", { span: spanWords(sent, t as T), name: h.startedBy.name })}</span>
        {esc === null ? null : late ? (
          <span className="ipdh-clock late" role="status">⚠ {t("ipdTransfer.handovers.escalated", { span: spanWords(esc, t as T) })}</span>
        ) : (
          <span className="ipdh-clock">⏱ {t("ipdTransfer.handovers.escalatesIn", { span: spanWords(esc, t as T) })}</span>
        )}
      </div>
      <dl className="ipdh-sbar">
        {(["situation", "background", "assessment", "recommendation"] as const).map((k) => (
          <div key={k}><dt>{t(`ipdTransfer.sbar.${k}`)}</dt><dd>{h.sbar[k]}</dd></div>
        ))}
      </dl>
      {done !== null ? <span className="ipdh-ok" role="status">✓ {done}</span> : (
        <div className="ipdh-acts">
          {h.sentByViewer ? <span className="dim">{t("ipdTransfer.handovers.youSent")}</span> : (
            <button type="button" className="ipdh-btn pri" disabled={busy} onClick={() => run(acceptHandover(h.transferId), t("ipdTransfer.handovers.accepted", { bed: h.toBed.code }))}>
              {t("ipdTransfer.handovers.accept")}
            </button>
          )}
          <button type="button" className="ipdh-btn" disabled={busy}
            onClick={() => run(cancelTransfer(h.transferId, h.sentByViewer ? "plan_changed" : "receiving_ward_declined"), t("ipdTransfer.handovers.declined"))}>
            {h.sentByViewer ? t("ipdTransfer.panel.cancelTransfer") : t("ipdTransfer.handovers.decline")}
          </button>
        </div>
      )}
      {refusal !== null ? <div className="ipdh-refusal" role="alert">{refusal.bedRule ? <b>{refusal.bedRule}: </b> : null}{refusal.rule}</div> : null}
      {failed ? <div className="ipdh-refusal" role="alert">{t("ipdTransfer.panel.actFailed")}</div> : null}
    </article>
  );
}

/**
 * E4.1 (#733) — THE SHIFT HANDOVER, on the same "Waiting for you" page (not a second handover screen): the patients the
 * outgoing nurse handed over with an SBAR, each accepted by the incoming nurse — never by the nurse who gave it. Shown
 * to holders of `ipd.handover.shift`; the server re-checks. Polls with the page.
 */
function ShiftHandovers(): React.ReactElement | null {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = can("ipd.handover.shift");
  const [list, setList] = useState<IpdShiftHandoverList | null>(null);
  const load = useCallback(() => { getShiftHandovers().then(setList, () => setList(null)); }, []);
  useEffect(() => {
    if (!allowed) return undefined;
    load(); const id = setInterval(load, POLL_MS); return () => clearInterval(id);
  }, [allowed, load]);
  if (!allowed) return null;
  const items = list?.handovers ?? [];
  return (
    <section className="ipdh-shift" aria-label={t("ipdNursing.handover.shiftTitle")} data-testid="ipd-shift-handovers">
      <h2>{t("ipdNursing.handover.shiftTitle")}</h2>
      {list !== null && items.length === 0 ? <div className="ipdh-empty">{t("ipdNursing.handover.noneWaiting")}</div> : null}
      <div className="ipdh-list">{items.map((h) => <ShiftCard key={h.handoverId} h={h} onDone={load} />)}</div>
    </section>
  );
}

function ShiftCard({ h, onDone }: { h: IpdShiftHandoverCard; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const [done, setDone] = useState(false);
  const accept = (): void => {
    setBusy(true); setRefusal(null);
    acceptShiftHandover(h.handoverId).then(() => { setBusy(false); setDone(true); onDone(); }, (e: unknown) => { setBusy(false); setRefusal(refusalOf(e)); });
  };
  return (
    <article className="ipdh-card" data-testid={`ipd-shift-handover-${h.handoverId}`}>
      <div className="ipdh-who">
        <b>{h.identity.name}</b><span>{h.identity.ageSex}</span>
        {h.identity.uhid ? <span className="mono">UHID {h.identity.uhid}</span> : null}
        {h.bedCode !== null ? <span className="bed mono">{h.bedCode}</span> : null}
      </div>
      <div className="ipdh-meta">
        <span>{t(`ipdNursing.shift.${h.shift}`)}</span>
        <span>{t("ipdNursing.handover.from", { name: h.givenBy.name, time: fmtIst(h.givenAt) })}</span>
      </div>
      <dl className="ipdh-sbar">
        {(["situation", "background", "assessment", "recommendation"] as const).map((k) => (
          <div key={k}><dt>{t(`ipdTransfer.sbar.${k}`)}</dt><dd>{h.sbar[k]}</dd></div>
        ))}
      </dl>
      {done ? <span className="ipdh-ok" role="status">✓ {t("ipdNursing.handover.accepted")}</span> : h.givenByViewer
        ? <span className="dim">{t("ipdNursing.handover.youGave")}</span>
        : <div className="ipdh-acts"><button type="button" className="ipdh-btn pri" disabled={busy} onClick={accept}>{t("ipdNursing.handover.accept")}</button></div>}
      {refusal !== null ? <div className="ipdh-refusal" role="alert">{refusal.rule}</div> : null}
    </article>
  );
}
