import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { BMW_LIMIT_HOURS, ageHours, bmwClockLevel, fetchBmwBoard, kg } from "../lib/bmw-api";
import { useServerNow } from "./my-tasks";
import type { BmwBagCard, BmwCategory, BmwClockLevel, BmwDisputeCard, BmwWardGeneration } from "@hmis/contracts";
import "./bmw.css";

/**
 * ═══ E1.7 BIO-MEDICAL WASTE (issue #724) — THE BMW SUPERVISOR'S BOARD (16:9) ═══
 *
 * Every bag still on the premises, oldest first, with its 48-hour clock in words ("38 h · warning") beside a
 * coloured edge — the word carries the meaning, the colour repeats it. Beside it: today's generation by ward,
 * the open weight disputes and the next pickup. Designed for 1920 × 1080, tested at 1366 × 768, and it never
 * scrolls the page: a column with more rows than fit says "+N more".
 */
type T = (k: string, o?: Record<string, unknown>) => string;
const ROW_PX = 46;
const CHROME_PX = 44 + 34;

function useRowsThatFit(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState(() => Math.max(3, Math.floor(((typeof window === "undefined" ? 900 : window.innerHeight) - 300) / ROW_PX)));
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (h > 0) setRows(Math.max(2, Math.floor((h - CHROME_PX) / ROW_PX)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, rows];
}

export const categoryWord = (c: BmwCategory, t: T): string => t(`bmw.category.${c}`);

/** The clock in words — never colour alone. */
export function clockWords(generatedAt: string, nowMs: number, t: T): { level: BmwClockLevel; text: string } {
  const level = bmwClockLevel(generatedAt, new Date(nowMs));
  const h = ageHours(generatedAt, nowMs);
  if (level === "alert") return { level, text: t("bmw.clock.alert", { count: h, limit: BMW_LIMIT_HOURS }) };
  if (level === "warning") return { level, text: t("bmw.clock.warning", { count: h }) };
  return { level, text: t("bmw.clock.ok", { count: h }) };
}

export function Swatch({ c }: { c: BmwCategory }): React.ReactElement {
  return <span className={`bw-sw ${c}`} aria-hidden="true" />;
}

export function BmwBoard(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language as string | undefined) ?? "en";
  const q = useQuery({ queryKey: ["bmw", "board"], queryFn: fetchBmwBoard, refetchInterval: 30_000 });
  const now = useServerNow(q.data?.serverNow, 30_000);
  const [listRef, rows] = useRowsThatFit();
  const board = q.data;
  const fmt = (iso: string, withDay: boolean): string => new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false, ...(withDay ? { day: "numeric", month: "short" } : {}),
  }).format(new Date(iso));
  const clock = fmt(new Date(now).toISOString(), false);
  const onSite = board?.onSite ?? [];
  const shown = onSite.length > rows ? onSite.slice(0, rows) : onSite;
  const warning = onSite.filter((b) => bmwClockLevel(b.generatedAt, new Date(now)) === "warning").length;
  const alert = onSite.filter((b) => bmwClockLevel(b.generatedAt, new Date(now)) === "alert").length;

  return (
    <PaperScreen testId="bmw-board" style={{ height: "var(--pp-h)" }}>
      <div className="bw-board">
        <div className="bw-head">
          <h1>{t("bmw.board.title")}</h1>
          {board !== undefined && (
            <div className="bw-sum">
              <span className="bw-count" data-testid="bmw-onsite"><b>{board.counts.onSite}</b>{t("bmw.board.onSite")}</span>
              <span className={warning > 0 ? "bw-count warn" : "bw-count"} data-testid="bmw-warning"><b>{warning}</b>{t("bmw.board.warning")}</span>
              <span className={alert > 0 ? "bw-count alert" : "bw-count"} data-testid="bmw-alert"><b>{alert}</b>{t("bmw.board.alert", { limit: BMW_LIMIT_HOURS })}</span>
              <span className="bw-count" data-testid="bmw-today"><b>{board.counts.generatedToday}</b>{t("bmw.board.todayBags", { kg: kg(board.counts.gramsToday) })}</span>
            </div>
          )}
          {q.isError && <span className="pill rd">{t("bmw.offline")}</span>}
          <span className="bw-now" data-testid="bmw-clock">{clock}</span>
        </div>
        <div className="bw-main">
          <section className="box bw-col" ref={listRef} data-testid="bmw-onsite-list">
            <header><b>{t("bmw.board.onSiteTitle")}</b><span className="pill">{t("bmw.board.oldestFirst")}</span></header>
            <div className="bw-rows">
              {board !== undefined && onSite.length === 0 && <div className="bw-empty" data-testid="bmw-none">{t("bmw.board.none")}</div>}
              {shown.map((b) => <BagRow key={b.id} b={b} now={now} />)}
              {shown.length < onSite.length && <div className="bw-more" data-testid="bmw-more">{t("bmw.board.more", { count: onSite.length - shown.length })}</div>}
            </div>
          </section>
          <section className="box bw-col" data-testid="bmw-today-list">
            <header><b>{t("bmw.board.todayTitle")}</b><span className="pill">{kg(board?.counts.gramsToday ?? 0)}</span></header>
            <div className="bw-rows">
              {board !== undefined && board.today.length === 0 && <div className="bw-empty">{t("bmw.board.noneToday")}</div>}
              {(board?.today ?? []).slice(0, rows).map((w) => <WardRow key={w.placeResourceId} w={w} />)}
            </div>
          </section>
          <div className="bw-side">
            <section className="box bw-pickup" data-testid="bmw-pickup">
              <header><b>{t("bmw.board.nextPickup")}</b></header>
              <div className="bw-big">{board === undefined ? "—" : fmt(board.nextPickupAt, true)}</div>
              <div className="bw-sub">
                {board?.lastManifest == null ? t("bmw.board.noManifest")
                  : t("bmw.board.lastManifest", { no: board.lastManifest.manifestNo, at: fmt(board.lastManifest.handedOverAt, true), bags: board.lastManifest.bags })}
              </div>
            </section>
            <section className="box bw-disputes" data-testid="bmw-disputes">
              <header><b>{t("bmw.board.disputes")}</b><span className={(board?.disputes.length ?? 0) > 0 ? "pill rd" : "pill"}>{board?.disputes.length ?? 0}</span></header>
              {board !== undefined && board.disputes.length === 0 && <div className="bw-empty">{t("bmw.board.noDisputes")}</div>}
              {(board?.disputes ?? []).slice(0, 6).map((d) => <DisputeRow key={d.id} d={d} />)}
            </section>
          </div>
        </div>
      </div>
    </PaperScreen>
  );
}

const STATE_WORD = (b: BmwBagCard, t: T): string => t(`bmw.state.${b.state}`);

function BagRow({ b, now }: { b: BmwBagCard; now: number }): React.ReactElement {
  const { t } = useTranslation();
  const c = clockWords(b.generatedAt, now, t);
  return (
    <div className={`bw-row ${c.level}`} data-testid={`bag-${b.barcode}`}>
      <span className="bar" />
      <span style={{ minWidth: 0 }}>
        <div className="t1"><Swatch c={b.category} />{categoryWord(b.category, t)}{b.cytotoxic ? ` · ${t("bmw.cytotoxic")}` : ""} · {b.placeName}</div>
        <div className="t2"><span className="mono">{b.barcode}</span> · {STATE_WORD(b, t)} · {kg(b.centralWeightGrams ?? b.deptWeightGrams)}{b.centralGap ? ` · ${t("bmw.board.weightGap")}` : ""}</div>
      </span>
      <span className={`r bw-clock ${c.level}`} data-testid="bag-clock">{c.text}</span>
    </div>
  );
}

function WardRow({ w }: { w: BmwWardGeneration }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="bw-ward" data-testid={`ward-${w.placeResourceId}`}>
      <span className="n">{w.placeName}</span>
      <span className="c">{t("bmw.board.bags", { count: w.bags })} · {kg(w.grams)}</span>
      <span className="s">
        {(Object.entries(w.byCategory) as [BmwCategory, number][]).filter(([, n]) => n > 0).map(([c, n]) => (
          <span key={c} className="bw-chip"><Swatch c={c} />{categoryWord(c, t)} {n}</span>
        ))}
      </span>
    </div>
  );
}

function DisputeRow({ d }: { d: BmwDisputeCard }): React.ReactElement {
  const { t } = useTranslation();
  const pct = (Math.abs(d.gapBasisPoints) / 100).toFixed(1);
  return (
    <div className="bw-ward" data-testid={`dispute-${d.id}`}>
      <span className="n"><Swatch c={d.category} />{categoryWord(d.category, t)} · {d.manifestNo}</span>
      <span className="c bw-clock alert">{t(d.gapBasisPoints >= 0 ? "bmw.board.gapHeavy" : "bmw.board.gapLight", { pct })}</span>
      <span className="s">{t("bmw.board.weights", { ours: kg(d.deptGrams), theirs: kg(d.cbwtfGrams) })}</span>
    </div>
  );
}
