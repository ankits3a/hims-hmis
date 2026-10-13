import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { useAuth } from "../lib/auth";
import { buildListsApi, dietRefusal, dispatchListApi, fetchKitchenBoard, istClock, markPrintedApi } from "../lib/diet-api";
import { todayIst } from "../lib/opd-api";
import { useServerNow } from "./my-tasks";
import type { DietCode, DietKitchenBoardView, DietLineView, DietListView, DietMeal } from "@hmis/contracts";
import "./diet.css";

/**
 * ═══ E4.4 DIET (issue #736) — THE KITCHEN BOARD (16:9) ═══
 *
 * One meal at a time (the next one by default; the four rounds switch it). One card per ward: the list's state in a
 * word, trays / NPO / late / withdrawn, and the diets as chips. A ward not yet built is a live PREVIEW (Build now);
 * a built list prints (the A4 sheet and one label slip per tray) and only a PRINTED list is dispatched. Designed for
 * 1920 × 1080, tested at 1366 × 768: the page never scrolls; cards that do not fit say "+N more". No money anywhere.
 */
const MEALS: readonly DietMeal[] = ["breakfast", "lunch", "evening", "dinner"];
const CARD_W = 300;
const CARD_H = 196;
const GAP = 12;

function useCardsThatFit(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [n, setN] = useState(8);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const cols = Math.max(1, Math.floor((el.clientWidth + GAP) / (CARD_W + GAP)));
      const rows = Math.max(1, Math.floor((el.clientHeight + GAP) / (CARD_H + GAP)));
      if (el.clientHeight > 0) setN(cols * rows);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, n];
}

/** The meal's IST date as "11 Mar". */
function dayWord(date: string, lang: string): string {
  return new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
}

export function DietKitchen(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language as string | undefined) ?? "en";
  const [pick, setPick] = useState<{ meal: DietMeal; date: string } | null>(null);
  const q = useQuery({
    queryKey: ["diet", "kitchen", pick?.meal ?? "next", pick?.date ?? ""],
    queryFn: () => fetchKitchenBoard(pick?.meal, pick?.date),
    refetchInterval: 30_000,
  });
  const now = useServerNow(q.data?.serverNow, 30_000);
  const [gridRef, fit] = useCardsThatFit();
  const [printing, setPrinting] = useState<{ l: DietListView; n: number } | null>(null);
  // Review item 17: a list is marked printed only when the kitchen says the paper came out ("Printed OK?").
  const [confirming, setConfirming] = useState<DietListView | null>(null);
  const qc = useQueryClient();
  const confirm = useMutation({
    mutationFn: (id: string) => markPrintedApi(id),
    onSuccess: () => { setConfirming(null); void qc.invalidateQueries({ queryKey: ["diet"] }); },
  });
  const board = q.data;
  const lists = board?.lists ?? [];
  const shown = lists.length > fit ? lists.slice(0, Math.max(1, fit - 1)) : lists;
  const totals = lists.reduce((a, l) => ({ trays: a.trays + l.counts.trays, npo: a.npo + l.counts.npo }), { trays: 0, npo: 0 });

  return (
    <PaperScreen testId="diet-kitchen" style={{ height: "var(--pp-h)" }}>
      <div className="dk-board" data-print={printing === null ? undefined : ""}>
        <div className="dk-head">
          <h1>{t("diet.kitchen.title")}</h1>
          {board !== undefined && (
            <>
              <span className="dk-meal" data-testid="dk-meal">{t(`diet.meal.${board.meal}`)} · {dayWord(board.date, lang)}</span>
              <span className="dk-count"><b data-testid="dk-trays">{totals.trays}</b>{t("diet.kitchen.trays")}</span>
              <span className={totals.npo > 0 ? "dk-count npo" : "dk-count"}><b data-testid="dk-npo">{totals.npo}</b>{t("diet.kitchen.npo")}</span>
              <span className="dk-clock">{t("diet.kitchen.cutoff", { at: istClock(board.cutoffAt) })}</span>
              <span className="dk-clock">{t("diet.kitchen.serve", { at: istClock(board.serveAt) })}</span>
            </>
          )}
          {q.isError && <span className="pill rd">{t("diet.offline")}</span>}
          <div className="dk-meals" role="group" aria-label={t("diet.kitchen.mealSwitch")}>
            {MEALS.map((m) => (
              <button key={m} type="button" className={board?.meal === m ? "dk-tab on" : "dk-tab"} data-testid={`dk-tab-${m}`}
                onClick={() => setPick({ meal: m, date: board?.date ?? todayIst(new Date(now)) })}>
                {t(`diet.meal.${m}`)}
              </button>
            ))}
          </div>
          {confirming !== null && (
            <span className="dk-confirm" data-testid="dk-confirm">
              {t("diet.kitchen.printedOk", { ward: confirming.wardName })}
              <button type="button" className="dk-btn" disabled={confirm.isPending || confirming.id === null}
                onClick={() => { if (confirming.id !== null) confirm.mutate(confirming.id); }} data-testid="dk-confirm-yes">{t("diet.kitchen.printedYes")}</button>
              <button type="button" className="dk-btn ghost" onClick={() => setConfirming(null)} data-testid="dk-confirm-no">{t("diet.kitchen.printedNo")}</button>
            </span>
          )}
          <span className="dk-now">{istClock(new Date(now).toISOString())}</span>
        </div>
        <div className="dk-grid" ref={gridRef} data-testid="dk-grid">
          {board !== undefined && lists.length === 0 && <div className="dk-empty">{t("diet.kitchen.noWards")}</div>}
          {shown.map((l) => <WardCard key={l.wardId} l={l} board={board!} onPrint={() => setPrinting((p) => ({ l, n: (p?.n ?? 0) + 1 }))} />)}
          {shown.length < lists.length && <div className="dk-more" data-testid="dk-more">{t("diet.kitchen.more", { count: lists.length - shown.length })}</div>}
        </div>
        {printing !== null && board !== undefined && <PrintSheet key={printing.n} l={printing.l} board={board} onPrinted={() => setConfirming(printing.l)} />}
      </div>
    </PaperScreen>
  );
}

function WardCard({ l, board, onPrint }: { l: DietListView; board: DietKitchenBoardView; onPrint: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const onErr = (e: unknown): void => setErr(t(`diet.refusal.${dietRefusal(e) ?? "failed"}`, { defaultValue: t("diet.refusal.failed") }));
  const done = (): void => { setErr(null); void qc.invalidateQueries({ queryKey: ["diet"] }); };
  const build = useMutation({ mutationFn: () => buildListsApi(board.meal, board.date), onSuccess: done, onError: onErr });
  const dispatch = useMutation({ mutationFn: () => dispatchListApi(l.id!), onSuccess: done, onError: onErr });
  const kitchen = can("diet.kitchen");
  const chips = (Object.entries(l.counts.byDiet) as [DietCode, number][]).sort((a, b) => b[1] - a[1]);
  return (
    <section className={`box dk-card ${l.state}`} data-testid={`dk-ward-${l.wardId}`}>
      <header>
        <b>{l.wardName}</b>
        <span className={`dk-state ${l.state}`} data-testid="dk-state">{t(`diet.listState.${l.state}`)}</span>
        {l.changedSincePrint && <span className="dk-changed" data-testid="dk-changed">{t("diet.kitchen.changed")}</span>}
      </header>
      <div className="dk-nums">
        <span><b data-testid="dk-card-trays">{l.counts.trays}</b>{t("diet.kitchen.trays")}</span>
        <span className={l.counts.npo > 0 ? "npo" : ""}><b data-testid="dk-card-npo">{l.counts.npo}</b>{t("diet.kitchen.npo")}</span>
        <span className={l.counts.late > 0 ? "late" : ""}><b>{l.counts.late}</b>{t("diet.kitchen.late")}</span>
        <span><b>{l.counts.withdrawn}</b>{t("diet.kitchen.withdrawn")}</span>
      </div>
      <div className="dk-chips">
        {chips.length === 0 ? <span className="dk-dim">{t("diet.kitchen.noTrays")}</span>
          : chips.map(([code, n]) => <span key={code} className="dk-chip">{t(`diet.code.${code}`)} {n}</span>)}
      </div>
      <div className="dk-acts">
        {kitchen && l.state === "preview" && (
          <button type="button" className="dk-btn" disabled={build.isPending} onClick={() => build.mutate()} data-testid="dk-build">{t("diet.kitchen.build")}</button>
        )}
        {kitchen && l.id !== null && (
          <button type="button" className={l.changedSincePrint ? "dk-btn" : "dk-btn ghost"} onClick={onPrint} data-testid="dk-print">
            {t(l.changedSincePrint ? "diet.kitchen.reprint" : "diet.kitchen.print")}
          </button>
        )}
        {kitchen && l.state === "printed" && !l.changedSincePrint && (
          <button type="button" className="dk-btn" disabled={dispatch.isPending} onClick={() => dispatch.mutate()} data-testid="dk-dispatch">{t("diet.kitchen.dispatch")}</button>
        )}
        {err !== null && <span className="dk-err">{err}</span>}
      </div>
    </section>
  );
}

const PREF_SHORT: Record<string, string> = { veg: "V", non_veg: "NV", jain: "J" };

/** The A4 list and the tray labels for one ward. Printing it marks the list printed (the first print is kept). */
/** The sheet stays mounted after printing (hidden on screen); a new Print tap remounts it (`key`) and prints again. */
function PrintSheet({ l, board, onPrinted }: { l: DietListView; board: DietKitchenBoardView; onPrinted: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const printed = useRef(onPrinted);
  useEffect(() => {
    const id = setTimeout(() => { window.print(); printed.current(); }, 50);
    return () => clearTimeout(id);
  }, [l.id]);
  // A REPRINT after a change carries only the changed lines, highlighted (the first print carries them all).
  const since = l.lastPrintedAt === null ? null : Date.parse(l.lastPrintedAt);
  const changed = (x: DietLineView): boolean => since !== null && x.changedAt !== null && Date.parse(x.changedAt) > since;
  const reprint = l.changedSincePrint && since !== null;
  const rows = reprint ? l.lines.filter(changed) : l.lines;
  const trays = rows.filter((x) => x.state === "active");
  const meal = t(`diet.meal.${board.meal}`);
  return (
    <section className="dk-print" data-testid="dk-print-sheet">
      <div className="dk-a4">
        <h1>{t("diet.print.title", { ward: l.wardName, meal, date: board.date })}{reprint ? ` — ${t("diet.print.changesOnly")}` : ""}</h1>
        <p className="dk-sub">{t("diet.print.serve", { at: istClock(l.serveAt), count: trays.length })}</p>
        <table>
          <thead>
            <tr>
              <th>{t("diet.print.bed")}</th><th>{t("diet.print.patient")}</th><th>{t("diet.print.uhid")}</th><th>{t("diet.print.diet")}</th>
              <th>{t("diet.print.pref")}</th><th>{t("diet.print.tube")}</th><th>{t("diet.print.allergies")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => <PrintRow key={x.id} x={x} chg={changed(x)} />)}
          </tbody>
        </table>
      </div>
      <div className="dk-labels">
        {trays.map((x) => (
          <div key={x.id} className={changed(x) ? "dk-label chg" : "dk-label"} data-testid={`dk-label-${x.admissionId}`}>
            <div className="l1"><b>{x.bedCode ?? "—"}</b> · {l.wardName}</div>
            <div className="l2" data-testid="dk-label-name">{x.patient.name}</div>
            <div className="l3" data-testid="dk-label-uhid">{x.patient.sealed ? "" : x.patient.uhid}</div>
            <div className="l4">{meal} · <b>{t(`diet.code.${x.code}`)}</b> · {PREF_SHORT[x.preference] ?? x.preference}{x.tube === null ? "" : ` · ${x.tube}`}</div>
            {x.allergies.length > 0 && <div className="l5">{x.allergies.join(", ")}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

function PrintRow({ x, chg }: { x: DietLineView; chg: boolean }): React.ReactElement {
  const { t } = useTranslation();
  if (x.state === "withdrawn") {
    return (
      <tr className={chg ? "out chg" : "out"}>
        <td>{x.bedCode ?? "—"}</td><td>{x.patient.name}</td><td>{x.patient.sealed ? "" : x.patient.uhid}</td>
        <td colSpan={4}>{x.withdrawnReason === "npo" ? t("diet.print.npoNoTray") : t(`diet.withdrawn.${x.withdrawnReason ?? "npo"}`)}</td>
      </tr>
    );
  }
  return (
    <tr className={chg ? "chg" : undefined}>
      <td>{x.bedCode ?? "—"}</td><td>{x.patient.name}</td><td>{x.patient.sealed ? "" : x.patient.uhid}</td>
      <td>{t(`diet.code.${x.code}`)}{x.late ? ` (${t("diet.kitchen.late")})` : ""}</td>
      <td>{t(`diet.pref.${x.preference}`)}</td><td>{x.tube ?? ""}</td><td className="alg">{x.allergies.join(", ")}</td>
    </tr>
  );
}
