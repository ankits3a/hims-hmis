import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { fetchTransportBoard } from "../lib/transport-api";
import { clockOf, useServerNow } from "./my-tasks";
import type { BoardWorker, TransportBoardRow } from "@hmis/contracts";
import "./tasks.css";
import "./transport.css";

/**
 * ═══ E1.6 TRANSPORT (issue #723) — THE TRANSPORT SUPERVISOR'S BOARD (16:9, 1920 × 1080, no vertical scroll) ═══
 *
 * Every open move and run in one list: late first, then the moves WAITING FOR AN ESCORT (said in words, never by
 * colour alone), then by due time. Each row: the clock in words, what, from → to, how (mode, oxygen, monitor,
 * isolation), the escort state, the porter by initials, the stage. No patient's name — it is a wall. Rows that do
 * not fit say "+N more"; the porters on duty and their load are on the right.
 */
const ROW_PX = 48;
const LIST_CHROME_PX = 40 + 36;

function useRowsThatFit(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const fromWindow = (): number => Math.max(3, Math.floor(((typeof window === "undefined" ? 900 : window.innerHeight) - 300) / ROW_PX));
  const [rows, setRows] = useState(fromWindow);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (h > 0) setRows(Math.max(2, Math.floor((h - LIST_CHROME_PX) / ROW_PX)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, rows];
}

export function TransportBoard(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language as string | undefined) ?? "en";
  const q = useQuery({ queryKey: ["transport", "board"], queryFn: fetchTransportBoard, refetchInterval: 15_000 });
  const now = useServerNow(q.data?.serverNow);
  const [listRef, fit] = useRowsThatFit();
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(now));
  const board = q.data;
  const rows = board?.rows ?? [];
  const late = board === undefined ? 0 : Math.max(board.counts.late, rows.filter((r) => Date.parse(r.dueAt) <= now).length);
  const shown = rows.length > fit ? rows.slice(0, fit) : rows;

  return (
    <PaperScreen testId="transport-board" style={{ height: "var(--pp-h)" }}>
      <div className="tk-board">
        <div className="tk-head">
          <h1>{t("transport.board.title")}</h1>
          {board !== undefined && (
            <div className="tk-sum">
              <span className="tk-count" data-testid="tb-open"><b>{board.counts.open}</b>{t("tasks.board.open")}</span>
              <span className={late > 0 ? "tk-count late" : "tk-count"} data-testid="tb-late"><b>{late}</b>{t("tasks.board.late")}</span>
              <span className={board.counts.waitingEscort > 0 ? "tk-count late" : "tk-count"} data-testid="tb-escort">
                <b>{board.counts.waitingEscort}</b>{t("transport.board.waitingEscort")}
              </span>
              <span className="tk-count" data-testid="tb-pool"><b>{board.counts.pool}</b>{t("transport.board.waitingPorter")}</span>
            </div>
          )}
          {q.isError && <span className="pill rd">{t("tasks.offline")}</span>}
          <a href="/transport/request" className="tk-check" data-testid="tb-request">{t("transport.board.request")}</a>
          <span className="tk-now" data-testid="board-clock">{clock}</span>
        </div>
        <div className="tk-main">
          <section className="box trb-list" ref={listRef} data-testid="tb-list">
            <header className="trb-row trb-hd">
              <span>{t("transport.board.colClock")}</span><span>{t("transport.board.colWhat")}</span>
              <span>{t("transport.board.colRoute")}</span><span>{t("transport.board.colHow")}</span>
              <span>{t("transport.board.colEscort")}</span><span>{t("transport.board.colPorter")}</span>
            </header>
            {board !== undefined && rows.length === 0 && <div className="tk-empty" data-testid="tb-none">{t("transport.board.none")}</div>}
            {shown.map((r) => <Row key={r.taskId} r={r} now={now} lang={lang} />)}
            {shown.length < rows.length && <div className="tk-more" data-testid="tb-more">{t("tasks.board.more", { count: rows.length - shown.length })}</div>}
          </section>
          <div className="tk-side"><Porters workers={board?.workers ?? []} /></div>
        </div>
      </div>
    </PaperScreen>
  );
}

function Row({ r, now, lang }: { r: TransportBoardRow; now: number; lang: string }): React.ReactElement {
  const { t } = useTranslation();
  const clock = clockOf(r.dueAt, now, t, lang);
  const how = [
    r.mode === null ? null : t(`transport.mode.${r.mode}`),
    r.oxygen ? t("transport.o2.short") : null,
    r.monitor ? t("transport.monitor") : null,
    r.isolation === "none" ? null : t(`transport.isolation.${r.isolation}`),
  ].filter((s): s is string => s !== null).join(" · ");
  return (
    <div className={`trb-row ${clock.tone}`} data-testid={`tb-row-${r.taskId}`}>
      <span className={`tk-clock ${clock.tone}`} data-testid="tb-clock">{clock.text}</span>
      <span className="trb-what">
        {r.priority !== "routine" && <b className={r.priority === "stat" ? "tk-clock late" : "tk-clock soon"}>{t(`tasks.priority.${r.priority}`)} · </b>}
        {t(`tasks.kind.${r.kind}`)}
      </span>
      <span className="trb-route">{r.fromName ?? "—"} → {r.toName ?? "—"}</span>
      <span className="trb-how">{how === "" ? "—" : how}</span>
      <span className={r.escortState === "waiting" ? "trb-esc wait" : "trb-esc"} data-testid="tb-escort-state">
        {r.escortState === "waiting" ? t("transport.escort.waiting") : r.escortState === "with_escort" ? t("transport.escort.withShort") : "—"}
      </span>
      <span className="trb-porter">{r.porterInitials ?? t("transport.board.noPorter")} · {t(`tasks.state.${r.state}`)}</span>
    </div>
  );
}

function Porters({ workers }: { workers: BoardWorker[] }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="box tk-workers" data-testid="tb-porters">
      <header>{t("transport.board.porters")}</header>
      {workers.length === 0 && <div className="tk-more">{t("tasks.board.noWorkers")}</div>}
      {workers.map((w) => (
        <div key={w.userId} className="tk-worker">
          <span className="n">{w.name}</span>
          <span className="c">{t("tasks.board.load", { count: w.open })}</span>
          <span className="s">
            <span>{w.onDuty ? t("tasks.board.onDuty") : t("tasks.board.offDuty")}</span>
            {w.inProgress > 0 && <span>· {t("tasks.board.busy", { count: w.inProgress })}</span>}
          </span>
        </div>
      ))}
    </section>
  );
}
