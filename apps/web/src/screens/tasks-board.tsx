import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { fetchTaskBoard } from "../lib/tasks-api";
import { clockOf, kindLabel, useServerNow } from "./my-tasks";
import type { BoardFloor, BoardWorker, TaskBoardView, TaskCard } from "@hmis/contracts";
import "./tasks.css";

/**
 * ═══ E0.1 TASK ENGINE (issue #713) — THE SUPERVISOR'S TASK BOARD (16:9) ═══
 *
 * Open work by floor, the latest first, each with a live clock in words ("12 min late") beside a coloured
 * edge — the word carries the meaning, the colour only repeats it; floors with the most late work lead. On the right, every worker on duty
 * and their load. Designed for 1920 × 1080, tested down to 1366 × 768, and it never scrolls the page:
 * a floor with more rows than fit says "+N more" instead.
 */
const ROW_PX = 52;
/** A floor's heading and its "+N more" line: what the rows cannot use inside a column. */
const FLOOR_CHROME_PX = 44 + 36;

/**
 * How many rows fit in a floor column, MEASURED from the column area itself (a ResizeObserver), so the
 * board never grows a scrollbar whatever the shell above it measures. Before the first measure (and in
 * jsdom, which lays nothing out) it guesses from the window.
 */
function useRowsThatFit(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const fromWindow = (): number => Math.max(3, Math.floor(((typeof window === "undefined" ? 900 : window.innerHeight) - 330) / ROW_PX));
  const [rows, setRows] = useState(fromWindow);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (h > 0) setRows(Math.max(2, Math.floor((h - FLOOR_CHROME_PX) / ROW_PX)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, rows];
}

/**
 * An owning module's board is this board over its own kinds (E1.4 housekeeping): its own title and fetch, a flag in
 * words on some rows (a terminal clean), and Check buttons on the cards waiting for a check.
 */
export type TasksBoardProps = {
  titleKey?: string;
  queryKey?: readonly unknown[];
  fetchBoard?: () => Promise<TaskBoardView>;
  testId?: string;
  rowFlag?: (c: TaskCard) => string | null;
  /** Resolves with null when checked, or with the refusal's words. Absent: the to-check list is read-only. */
  onVerify?: (c: TaskCard) => Promise<string | null>;
};

export function TasksBoard(p: TasksBoardProps = {}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language as string | undefined) ?? "en";
  const q = useQuery({ queryKey: p.queryKey ?? ["tasks", "board"], queryFn: p.fetchBoard ?? fetchTaskBoard, refetchInterval: 15_000 });
  const [verifyNote, setVerifyNote] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const check = (c: TaskCard): void => {
    if (p.onVerify === undefined) return;
    setBusy(c.id); setVerifyNote(null);
    void p.onVerify(c).then((refused) => {
      setBusy(null);
      setVerifyNote({ id: c.id, text: refused ?? t("housekeeping.checked") });
      void q.refetch();
    });
  };
  const now = useServerNow(q.data?.serverNow);
  const [floorsRef, rows] = useRowsThatFit();
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(now));
  const board = q.data;
  // The database's count (every open task, not only the rows sent), raised by rows that fell late since it was taken.
  const late = board === undefined ? 0
    : Math.max(board.counts.late, board.floors.reduce((n, f) => n + f.tasks.filter((c) => Date.parse(c.dueAt) <= now).length, 0));

  return (
    <PaperScreen testId={p.testId ?? "tasks-board"} style={{ height: "var(--pp-h)" }}>
      <div className="tk-board">
        <div className="tk-head">
          <h1>{t(p.titleKey ?? "tasks.board.title")}</h1>
          {board !== undefined && (
            <div className="tk-sum">
              <span className="tk-count" data-testid="board-open"><b>{board.counts.open}</b>{t("tasks.board.open")}</span>
              <span className={late > 0 ? "tk-count late" : "tk-count"} data-testid="board-late"><b>{late}</b>{t("tasks.board.late")}</span>
              <span className="tk-count" data-testid="board-pool"><b>{board.counts.pool}</b>{t("tasks.board.pool")}</span>
              {board.counts.notShown > 0 && (
                <span className="tk-count late" data-testid="board-not-shown"><b>{board.counts.notShown}</b>{t("tasks.board.notShown")}</span>
              )}
            </div>
          )}
          {q.isError && <span className="pill rd">{t("tasks.offline")}</span>}
          <span className="tk-now" data-testid="board-clock">{clock}</span>
        </div>
        <div className="tk-main">
          <div className="tk-floors" ref={floorsRef}>
            {board !== undefined && board.floors.length === 0 && (
              <div className="box tk-floor"><div className="tk-empty" data-testid="board-none">{t("tasks.board.none")}</div></div>
            )}
            {(board?.floors ?? []).map((f) => <Floor key={f.floorName ?? "-"} f={f} now={now} lang={lang} rows={rows} flag={p.rowFlag} />)}
          </div>
          <div className="tk-side">
            <Workers workers={board?.workers ?? []} />
            {(board?.toVerify.length ?? 0) > 0 && (
              <section className="box tk-verify" data-testid="board-verify">
                <header>{t("tasks.board.toVerify", { count: board!.toVerify.length })}</header>
                {board!.toVerify.slice(0, p.onVerify === undefined ? 4 : 6).map((c) => (
                  <div key={c.id} className="tk-worker" data-testid={`verify-${c.id}`}>
                    <span className="n">{c.placeCode ?? c.placeName ?? ""} · {kindLabel(c, t)}</span>
                    {p.onVerify !== undefined ? (
                      <button type="button" className="tk-check" disabled={busy === c.id} onClick={() => check(c)}>{t("housekeeping.check")}</button>
                    ) : <span className="c">{c.placeCode ?? ""}</span>}
                    {p.rowFlag?.(c) ? <span className="s"><b className="tk-clock late">{p.rowFlag(c)}</b></span> : null}
                    {verifyNote?.id === c.id ? <span className="s" role="status">{verifyNote.text}</span> : null}
                  </div>
                ))}
              </section>
            )}
          </div>
        </div>
      </div>
    </PaperScreen>
  );
}

function Floor({ f, now, lang, rows, flag }: { f: BoardFloor; now: number; lang: string; rows: number; flag?: (c: TaskCard) => string | null }): React.ReactElement {
  const { t } = useTranslation();
  const lateHere = f.tasks.filter((c) => Date.parse(c.dueAt) <= now).length;
  const shown = f.tasks.length > rows ? f.tasks.slice(0, rows) : f.tasks;
  return (
    <section className="box tk-floor" data-testid={`floor-${f.floorName ?? "none"}`}>
      <header>
        <b>{f.floorName ?? t("tasks.board.noFloor")}</b>
        <span className={lateHere > 0 ? "pill rd" : "pill"}>
          {lateHere > 0 ? t("tasks.board.floorLate", { count: lateHere, open: f.tasks.length }) : t("tasks.board.floorOpen", { count: f.tasks.length })}
        </span>
      </header>
      <div className="tk-rows">
        {shown.map((c) => <Row key={c.id} c={c} now={now} lang={lang} flag={flag?.(c) ?? null} />)}
        {shown.length < f.tasks.length && (
          <div className="tk-more" data-testid="floor-more">{t("tasks.board.more", { count: f.tasks.length - shown.length })}</div>
        )}
      </div>
    </section>
  );
}

function Row({ c, now, lang, flag }: { c: TaskCard; now: number; lang: string; flag: string | null }): React.ReactElement {
  const { t } = useTranslation();
  const clock = clockOf(c.dueAt, now, t, lang);
  const who = c.assigneeName ?? t("tasks.board.unassigned");
  return (
    <div className={`tk-row ${clock.tone}`} data-testid={`row-${c.id}`}>
      <span className="bar" />
      <span style={{ minWidth: 0 }}>
        <div className="t1">{c.placeName ?? t("tasks.noPlace")}</div>
        <div className="t2">
          {flag !== null && <b className="tk-clock late" data-testid="row-flag">{flag} · </b>}
          {c.priority !== "routine" && <b className={c.priority === "stat" ? "tk-clock late" : "tk-clock soon"}>{t(`tasks.priority.${c.priority}`)} · </b>}
          {kindLabel(c, t)} · {who} · {t(`tasks.state.${c.state}`)}
        </div>
      </span>
      <span className={`r tk-clock ${clock.tone}`} data-testid="row-clock">{clock.text}</span>
    </div>
  );
}

function Workers({ workers }: { workers: BoardWorker[] }): React.ReactElement {
  const { t } = useTranslation();
  const max = Math.max(1, ...workers.map((w) => w.open));
  return (
    <section className="box tk-workers" data-testid="board-workers">
      <header>{t("tasks.board.workers")}</header>
      {workers.length === 0 && <div className="tk-more">{t("tasks.board.noWorkers")}</div>}
      {workers.map((w) => (
        <div key={w.userId} className="tk-worker" data-testid={`worker-${w.userId}`}>
          <span className="n">{w.name}</span>
          <span className="c">{t("tasks.board.load", { count: w.open })}</span>
          <span className="s">
            <span className="tk-load"><i style={{ width: `${Math.round((w.open / max) * 100)}%` }} /></span>
            <span>{w.onDuty ? t("tasks.board.onDuty") : t("tasks.board.offDuty")}</span>
            {w.inProgress > 0 && <span>· {t("tasks.board.busy", { count: w.inProgress })}</span>}
          </span>
        </div>
      ))}
    </section>
  );
}
