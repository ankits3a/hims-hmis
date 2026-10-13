import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { useAuth } from "../lib/auth";
import { decideCondemnApi, fetchLinenBoard, linenRefusal } from "../lib/linen-api";
import { useServerNow } from "./my-tasks";
import type { LinenBatchCard, LinenCondemnCard, LinenItem, LinenVarianceRow, LinenWardState } from "@hmis/contracts";
import "./linen.css";

/**
 * ═══ E2.4 LINEN (issue #728) — THE LINEN SUPERVISOR'S BOARD (16:9) ═══
 *
 * Wards below par first, each in words ("Short 42 pieces") beside a coloured edge — the word carries the meaning, the
 * colour repeats it. Beside them: laundry out and in today, the batches at the laundry with an infected batch named in
 * words, short deliveries, the week's top five losses, and condemn requests waiting for a second person. Designed for
 * 1920 × 1080, tested at 1366 × 768; it never scrolls the page: a column with more rows than fit says "+N more".
 */
type T = (k: string, o?: Record<string, unknown>) => string;
const ROW_PX = 52;
const CHROME_PX = 44;

function useRowsThatFit(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState(() => Math.max(3, Math.floor(((typeof window === "undefined" ? 900 : window.innerHeight) - 260) / ROW_PX)));
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

/** The item's name in the reader's language, falling back to the catalogue's English name. */
export function itemName(code: string, items: readonly LinenItem[], t: T): string {
  return t(`linen.item.${code}`, { defaultValue: items.find((i) => i.code === code)?.name ?? code });
}

export function LinenBoard(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language as string | undefined) ?? "en";
  const q = useQuery({ queryKey: ["linen", "board"], queryFn: fetchLinenBoard, refetchInterval: 30_000 });
  const now = useServerNow(q.data?.serverNow, 30_000);
  const [listRef, rows] = useRowsThatFit();
  const board = q.data;
  const items = board?.items ?? [];
  const fmt = (iso: string, withDay: boolean): string => new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false, ...(withDay ? { day: "numeric", month: "short" } : {}),
  }).format(new Date(iso));
  const wards = board?.wards ?? [];
  const shown = wards.length > rows ? wards.slice(0, Math.max(1, rows - 1)) : wards;
  const today = board?.laundryToday;

  return (
    <PaperScreen testId="linen-board" style={{ height: "var(--pp-h)" }}>
      <div className="ln-board">
        <div className="ln-head">
          <h1>{t("linen.board.title")}</h1>
          {board !== undefined && (
            <div className="ln-sum">
              <span className={board.counts.belowPar > 0 ? "ln-count alert" : "ln-count"} data-testid="linen-below">
                <b>{board.counts.belowPar}</b>{t("linen.board.belowParOf", { count: board.counts.wards })}
              </span>
              <span className="ln-count" data-testid="linen-out"><b>{today?.outPieces ?? 0}</b>{t("linen.board.outToday")}</span>
              <span className="ln-count" data-testid="linen-in"><b>{today?.inPieces ?? 0}</b>{t("linen.board.inToday")}</span>
              <span className={(today?.infectedOutPieces ?? 0) > 0 ? "ln-count inf" : "ln-count"} data-testid="linen-infected">
                <b>{today?.infectedOutPieces ?? 0}</b>{t("linen.board.infectedToday")}
              </span>
            </div>
          )}
          {q.isError && <span className="pill rd">{t("linen.offline")}</span>}
          <span className="ln-now" data-testid="linen-clock">{fmt(new Date(now).toISOString(), false)}</span>
        </div>
        <div className="ln-main">
          <section className="box ln-col" ref={listRef} data-testid="linen-wards">
            <header><b>{t("linen.board.wardsTitle")}</b><span className="pill">{t("linen.board.belowFirst")}</span></header>
            <div className="ln-rows">
              {board !== undefined && wards.length === 0 && <div className="ln-empty">{t("linen.board.noWards")}</div>}
              {shown.map((w) => <WardRow key={w.wardId} w={w} items={items} />)}
              {shown.length < wards.length && <div className="ln-more" data-testid="linen-more">{t("linen.board.more", { count: wards.length - shown.length })}</div>}
            </div>
          </section>
          <section className="box ln-col" data-testid="linen-laundry">
            <header><b>{t("linen.board.laundryTitle")}</b><span className="pill">{t("linen.board.batches", { count: board?.inTransit.length ?? 0 })}</span></header>
            <div className="ln-rows">
              {board !== undefined && board.inTransit.length === 0 && <div className="ln-empty">{t("linen.board.noneAtLaundry")}</div>}
              {(board?.inTransit ?? []).slice(0, Math.max(2, rows - 4)).map((b) => <BatchRow key={b.id} b={b} at={fmt(b.sentAt, true)} />)}
              {(board?.shorts.length ?? 0) > 0 && <div className="ln-sub-h">{t("linen.board.shortsTitle")}</div>}
              {(board?.shorts ?? []).slice(0, 3).map((s) => (
                <div key={s.id} className="ln-line short" data-testid={`short-${s.id}`}>
                  <span className="n">{s.batchNo} · {itemName(s.itemCode, items, t)}</span>
                  <span className="c">{t("linen.board.shortBy", { count: s.short, sent: s.sent, got: s.received })}</span>
                </div>
              ))}
            </div>
          </section>
          <div className="ln-side">
            <section className="box ln-loss" data-testid="linen-variance">
              <header><b>{t("linen.board.lossTitle")}</b><span className="pill">{t("linen.board.lastSevenDays")}</span></header>
              {board !== undefined && board.variance.top.length === 0 && <div className="ln-empty">{t("linen.board.noLoss")}</div>}
              {(board?.variance.top ?? []).map((v) => <LossRow key={`${v.wardId}-${v.itemCode}`} v={v} items={items} />)}
            </section>
            <section className="box ln-condemn" data-testid="linen-condemn">
              <header><b>{t("linen.board.condemnTitle")}</b><span className={(board?.condemnPending.length ?? 0) > 0 ? "pill gd" : "pill"}>{board?.condemnPending.length ?? 0}</span></header>
              {board !== undefined && board.condemnPending.length === 0 && <div className="ln-empty">{t("linen.board.noCondemn")}</div>}
              {(board?.condemnPending ?? []).slice(0, 4).map((c) => <CondemnRow key={c.id} c={c} items={items} />)}
            </section>
          </div>
        </div>
      </div>
    </PaperScreen>
  );
}

function WardRow({ w, items }: { w: LinenWardState; items: readonly LinenItem[] }): React.ReactElement {
  const { t } = useTranslation();
  const short = w.items.filter((i) => i.short > 0).sort((a, b) => b.short - a.short);
  return (
    <div className={`ln-row ${w.belowPar ? "below" : "ok"}`} data-testid={`ward-${w.wardId}`}>
      <span className="bar" />
      <span style={{ minWidth: 0 }}>
        <div className="t1">{w.wardName}{w.floorName === null ? "" : ` · ${w.floorName}`} · {t("linen.board.beds", { count: w.beds })}</div>
        <div className="t2">
          {short.length === 0 ? t("linen.board.allAtPar")
            : short.slice(0, 4).map((i) => `${itemName(i.itemCode, items, t)} ${i.onHand}/${i.par}`).join(" · ")}
        </div>
      </span>
      <span className={`r ln-state ${w.belowPar ? "below" : "ok"}`} data-testid="ward-state">
        {w.belowPar ? t("linen.board.short", { count: w.shortPieces }) : t("linen.board.atPar")}
      </span>
    </div>
  );
}

function BatchRow({ b, at }: { b: LinenBatchCard; at: string }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className={`ln-line ${b.infected ? "inf" : ""}`} data-testid={`batch-${b.batchNo}`}>
      <span className="n">
        {b.infected && <span className="ln-tag inf" data-testid="batch-infected">{t("linen.board.infectedBatch")}</span>}
        <span className="mono">{b.batchNo}</span>
      </span>
      <span className="c">{t("linen.board.pieces", { count: b.piecesSent })}</span>
      <span className="s">{t("linen.board.sentAt", { at })}{b.vendorName === null ? "" : ` · ${b.vendorName}`}</span>
    </div>
  );
}

function LossRow({ v, items }: { v: LinenVarianceRow; items: readonly LinenItem[] }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="ln-line" data-testid={`loss-${v.wardId}-${v.itemCode}`}>
      <span className="n">{v.wardName} · {itemName(v.itemCode, items, t)}</span>
      <span className="c ln-state below">{t("linen.board.missing", { count: v.missing })}</span>
      <span className="s">{t("linen.board.lossSum", { opening: v.opening, issued: v.issued, returned: v.returned, counted: v.counted })}</span>
    </div>
  );
}

function CondemnRow({ c, items }: { c: LinenCondemnCard; items: readonly LinenItem[] }): React.ReactElement {
  const { t } = useTranslation();
  const { can, actor } = useAuth();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (verb: "approve" | "reject") => decideCondemnApi(c.id, verb),
    onSuccess: () => { setErr(null); void qc.invalidateQueries({ queryKey: ["linen"] }); },
    onError: (e) => setErr(t(`linen.refusal.${linenRefusal(e) ?? "failed"}`, { defaultValue: t("linen.refusal.failed") })),
  });
  const mine = actor?.id === c.requestedBy;
  return (
    <div className="ln-line" data-testid={`condemn-${c.id}`}>
      <span className="n">{c.qty} × {itemName(c.itemCode, items, t)} · {c.wardName ?? t("linen.store")}</span>
      <span className="c">{c.reason}</span>
      <span className="s">
        {t("linen.board.askedBy", { name: c.requestedByName })}
        {can("linen.manage") && !mine && (
          <>
            <button type="button" className="ln-mini ok" disabled={decide.isPending} onClick={() => decide.mutate("approve")} data-testid="condemn-approve">{t("linen.board.approve")}</button>
            <button type="button" className="ln-mini" disabled={decide.isPending} onClick={() => decide.mutate("reject")}>{t("linen.board.reject")}</button>
          </>
        )}
        {mine && <span className="ln-dim"> · {t("linen.board.needsOther")}</span>}
        {err !== null && <span className="ln-err"> · {err}</span>}
      </span>
    </div>
  );
}
