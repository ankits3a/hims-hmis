import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { MaintenanceBoardFloor, MaintenanceTicketView } from "@hmis/contracts";
import { PaperScreen } from "../components/paper-screen";
import { useAuth } from "../lib/auth";
import { ageWords, confirmTicketApi, dispatchTicketApi, fetchMaintenanceBoard, maintenanceRefusal } from "../lib/maintenance-api";
import { useServerNow } from "./my-tasks";
import { RaiseTicketSheet } from "./maintenance-raise";
import "./tasks.css";
import "./maintenance.css";

/**
 * ═══ E1.5 MAINTENANCE (issue #722) — THE MAINTENANCE SUPERVISOR'S BOARD (16:9, 1920 × 1080, no vertical scroll) ═══
 *
 * Open repair tickets by floor, CRITICAL FIRST then the oldest, each with its age in words ("3 h 20 min") and who
 * holds it; a ticket whose task was cancelled on the task board says "Not dispatched" with a Dispatch button. On the
 * right: repairs fixed and waiting for the nurse (Confirm, for a nurse or `ipd.beds.clean` holder — the server
 * refuses the technician who did it), the beds held out of service by a repair, and items flagged "Replace?"
 * (three faults in 30 days). A floor with more rows than fit says "+N more". No patient appears anywhere.
 */
const ROW_PX = 55;
/** A floor's heading and its "+N more" line: what the rows cannot use inside a column. */
const FLOOR_CHROME_PX = 44 + 36;

/** How many ticket rows fit in a floor column, measured from the column area (the task board's way). */
function useRowsThatFit(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const guess = (): number => Math.max(3, Math.floor(((typeof window === "undefined" ? 900 : window.innerHeight) - 330) / ROW_PX));
  const [rows, setRows] = useState(guess);
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

type T = (k: string, o?: Record<string, unknown>) => string;

function stateWords(v: Pick<MaintenanceTicketView, "state" | "assigneeName" | "taskId">, t: T): string {
  if (v.state === "open" && v.taskId === null) return t("maintenance.state.undispatched");
  if (v.state === "assigned" || v.state === "in_progress") {
    return t(`maintenance.state.${v.state}`, { who: v.assigneeName ?? t("maintenance.someone") });
  }
  return t(`maintenance.state.${v.state}`);
}

export function MaintenanceBoard(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["maintenance", "board"], queryFn: fetchMaintenanceBoard, refetchInterval: 15_000 });
  const now = useServerNow(q.data?.serverNow);
  const [raising, setRaising] = useState(false);
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const board = q.data;
  const [floorsRef, rows] = useRowsThatFit();
  // The side column holds three lists; on a 768-line screen each shows fewer rows (never a page scroll).
  const sideRows = rows >= 9 ? 6 : 3;
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(now));
  const mayConfirm = can("maintenance.confirm") || can("ipd.beds.clean");
  const mayManage = can("maintenance.manage");

  const act = (id: string, p: Promise<unknown>, okKey: string): void => {
    setBusy(id); setNote(null);
    p.then(() => { setBusy(null); setNote({ id, text: t(okKey) }); void q.refetch(); }, (e: unknown) => {
      setBusy(null);
      const r = maintenanceRefusal(e);
      setNote({ id, text: r === null ? t("maintenance.failed") : `${t(`maintenance.refusal.${r.code}`, { defaultValue: r.message })} ${r.fix}`.trim() });
    });
  };

  return (
    <PaperScreen testId="maintenance-board" style={{ height: "var(--pp-h)" }}>
      <div className="tk-board">
        <div className="tk-head">
          <h1>{t("maintenance.title")}</h1>
          {board !== undefined && (
            <div className="tk-sum">
              <span className="tk-count" data-testid="mt-open"><b>{board.counts.open}</b>{t("maintenance.count.open")}</span>
              <span className={board.counts.critical > 0 ? "tk-count late" : "tk-count"} data-testid="mt-critical"><b>{board.counts.critical}</b>{t("maintenance.count.critical")}</span>
              <span className={board.counts.late > 0 ? "tk-count late" : "tk-count"} data-testid="mt-late"><b>{board.counts.late}</b>{t("maintenance.count.late")}</span>
              <span className="tk-count" data-testid="mt-confirm"><b>{board.counts.toConfirm}</b>{t("maintenance.count.toConfirm")}</span>
              <span className="tk-count" data-testid="mt-beds"><b>{board.counts.blockedBeds}</b>{t("maintenance.count.blockedBeds")}</span>
              {board.counts.notShown > 0 && <span className="tk-count late"><b>{board.counts.notShown}</b>{t("maintenance.count.notShown")}</span>}
            </div>
          )}
          {q.isError && <span className="pill rd">{t("maintenance.offline")}</span>}
          {can("maintenance.raise") && (
            <button type="button" className="mt-btn pri" onClick={() => setRaising(true)} data-testid="mt-report">{t("maintenance.report")}</button>
          )}
          <span className="tk-now">{clock}</span>
        </div>
        <div className="tk-main">
          <div className="tk-floors" ref={floorsRef}>
            {board !== undefined && board.floors.length === 0 && (
              <div className="box tk-floor"><div className="tk-empty" data-testid="mt-none">{t("maintenance.none")}</div></div>
            )}
            {(board?.floors ?? []).map((f) => (
              <Floor key={f.floorName ?? "-"} f={f} t={t} rows={rows} mayManage={mayManage} busy={busy} note={note}
                onDispatch={(v) => act(v.id, dispatchTicketApi(v.id), "maintenance.dispatched")} />
            ))}
          </div>
          <div className="tk-side">
            <section className="box mt-side-list" data-testid="mt-to-confirm">
              <header>{t("maintenance.side.toConfirm", { count: board?.toConfirm.length ?? 0 })}</header>
              {(board?.toConfirm ?? []).length === 0 && <div className="tk-more">{t("maintenance.side.noneToConfirm")}</div>}
              {(board?.toConfirm ?? []).slice(0, sideRows >= 6 ? 4 : 2).map((v) => (
                <div key={v.id} className="tk-worker" data-testid={`mt-confirm-${v.number}`}>
                  <span className="n">#{v.number} · {v.placeCode} · {t(`maintenance.item.${v.itemKind}`)}</span>
                  {mayConfirm ? (
                    <button type="button" className="mt-btn" disabled={busy === v.id}
                      onClick={() => act(v.id, confirmTicketApi(v.id), "maintenance.confirmed")}>{t("maintenance.confirm")}</button>
                  ) : <span className="c" />}
                  <span className="s">{t("maintenance.state.fixed")}{v.fixedAt !== null ? ` · ${ageWords(Math.max(0, Math.floor((now - Date.parse(v.fixedAt)) / 60_000)), t)}` : ""}</span>
                  {note?.id === v.id ? <span className="s" role="status">{note.text}</span> : null}
                </div>
              ))}
              {(board?.toConfirm.length ?? 0) > (sideRows >= 6 ? 4 : 2) && (
                <div className="tk-more">{t("tasks.board.more", { count: board!.toConfirm.length - (sideRows >= 6 ? 4 : 2) })}</div>
              )}
            </section>
            <section className="box mt-side-list grow" data-testid="mt-blocked-beds">
              <header>{t("maintenance.side.blockedBeds", { count: board?.blockedBeds.length ?? 0 })}</header>
              {(board?.blockedBeds ?? []).length === 0 && <div className="tk-more">{t("maintenance.side.noBeds")}</div>}
              {(board?.blockedBeds ?? []).slice(0, sideRows).map((b) => (
                <div key={b.bedId} className="tk-worker">
                  <span className="n mono">{b.bedCode}</span>
                  <span className="c">#{b.ticketNumber}</span>
                  <span className="s">{b.onRelease ? t("maintenance.onRelease") : t("maintenance.blocked")} · {t(`maintenance.bedState.${b.state}`)}</span>
                </div>
              ))}
              {(board?.blockedBeds.length ?? 0) > sideRows && <div className="tk-more">{t("tasks.board.more", { count: board!.blockedBeds.length - sideRows })}</div>}
            </section>
            <section className="box mt-side-list" data-testid="mt-replace">
              <header>{t("maintenance.side.replace", { count: board?.replacement.length ?? 0 })}</header>
              {(board?.replacement ?? []).length === 0 && <div className="tk-more">{t("maintenance.side.noReplace")}</div>}
              {(board?.replacement ?? []).slice(0, sideRows >= 6 ? 4 : 1).map((r) => (
                <div key={r.ticketNumber} className="tk-worker">
                  <span className="n">{t(`maintenance.item.${r.itemKind}`)}{r.itemTag ? ` ${r.itemTag}` : ""} · {r.placeName}</span>
                  <span className="c mt-crit">{t("maintenance.replace.short")}</span>
                  <span className="s">{t("maintenance.replace.why")} · #{r.ticketNumber}</span>
                </div>
              ))}
            </section>
          </div>
        </div>
      </div>
      {raising ? <RaiseTicketSheet onClose={() => { setRaising(false); void q.refetch(); }} /> : null}
    </PaperScreen>
  );
}

function Floor(p: {
  f: MaintenanceBoardFloor; t: T; rows: number; mayManage: boolean; busy: string | null; note: { id: string; text: string } | null;
  onDispatch: (v: MaintenanceTicketView) => void;
}): React.ReactElement {
  const { f, t } = p;
  const critical = f.tickets.filter((v) => v.urgency === "critical").length;
  const shown = f.tickets.length > p.rows ? f.tickets.slice(0, p.rows) : f.tickets;
  return (
    <section className="box tk-floor" data-testid={`mt-floor-${f.floorName ?? "none"}`}>
      <header>
        <b>{f.floorName ?? t("maintenance.noFloor")}</b>
        <span className={critical > 0 ? "pill rd" : "pill"}>
          {critical > 0 ? t("maintenance.floorCritical", { count: critical, open: f.tickets.length }) : t("maintenance.floorOpen", { count: f.tickets.length })}
        </span>
      </header>
      <div className="tk-rows">
        {shown.map((v) => (
          <div key={v.id} className={`tk-row ${v.late || v.urgency === "critical" ? "late" : v.urgency === "urgent" ? "soon" : ""}`} data-testid={`mt-row-${v.number}`}>
            <span className="bar" />
            <span style={{ minWidth: 0 }}>
              <div className="t1">#{v.number} · {v.placeCode} · {t(`maintenance.item.${v.itemKind}`)}{v.replacementFlag ? <b className="mt-crit"> · {t("maintenance.replace.short")}</b> : null}</div>
              <div className="t2">
                {v.urgency !== "routine" && <b className={v.urgency === "critical" ? "mt-crit" : "mt-urg"}>{t(`maintenance.urgency.${v.urgency}`)} · </b>}
                {v.late && <b className="mt-crit">{t("maintenance.late")} · </b>}
                {v.bedBlockId !== null ? `${v.blockOnRelease ? t("maintenance.onRelease") : t("maintenance.blocked")} · ` : ""}
                {stateWords(v, t)}
                {p.note?.id === v.id ? ` · ${p.note.text}` : ""}
              </div>
            </span>
            {p.mayManage && v.state === "open" && v.taskId === null ? (
              <button type="button" className="mt-btn" disabled={p.busy === v.id} onClick={() => p.onDispatch(v)}>{t("maintenance.dispatch")}</button>
            ) : (
              <span className={`r tk-clock ${v.late ? "late" : "ok"}`} data-testid="mt-age">{ageWords(v.ageMinutes, t)}</span>
            )}
          </div>
        ))}
        {shown.length < f.tickets.length && <div className="tk-more">{t("tasks.board.more", { count: f.tickets.length - shown.length })}</div>}
      </div>
    </section>
  );
}
