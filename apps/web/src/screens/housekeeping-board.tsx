import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { TERMINAL_CLEAN_KIND, fetchHkSupervisor, fetchHousekeepingBoard } from "../lib/housekeeping-api";
import { lateMinutes } from "../lib/tasks-api";
import { ConfirmSheet } from "./hk-confirm-sheet";
import { useServerNow } from "./my-tasks";
import { TasksBoard } from "./tasks-board";
import type { HkSupervisorView, TaskCard } from "@hmis/contracts";
import "./housekeeping.css";

/**
 * ═══ E1.4 HOUSEKEEPING (issue #721) — THE HOUSEKEEPING SUPERVISOR'S BOARD (16:9, 1920 × 1080) ═══
 *
 * The task board over housekeeping's kinds only: open cleans by floor, late first, each with its clock in words;
 * a terminal clean says so in words ("Terminal clean", flagged "Supervisor checks"), not by colour alone. Workers and
 * their load on the right.
 * HK-1 (#973, design board "Supervisor · Live board"): the right column leads with "Needs you" (tasks failed twice) and
 * "Missed rounds" (a round not scanned by its due time), and the people on the published rota with their company.
 * Check opens the confirm sheet: the proof, then Pass or Fail with a reason. The board is a wall display: initials only
 * on a missed round or a failed task.
 */
export function HousekeepingBoard(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const flag = (c: TaskCard): string | null => (c.kind === TERMINAL_CLEAN_KIND ? t("housekeeping.terminal") : null);
  const [checking, setChecking] = useState<{ card: TaskCard; done: (r: string | null) => void } | null>(null);
  const onVerify = (c: TaskCard): Promise<string | null> => new Promise((resolve) => setChecking({ card: c, done: resolve }));
  return (
    <>
      <TasksBoard
        titleKey="housekeeping.title" queryKey={["housekeeping", "board"]} fetchBoard={fetchHousekeepingBoard}
        testId="housekeeping-board" rowFlag={flag} onVerify={onVerify} side={<SupervisorPanel />}
      />
      {checking !== null && (
        <ConfirmSheet card={checking.card} onClose={(outcome) => {
          checking.done(outcome);
          setChecking(null);
          void qc.invalidateQueries({ queryKey: ["housekeeping"] });
        }} />
      )}
    </>
  );
}

function SupervisorPanel(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["housekeeping", "supervisor"], queryFn: fetchHkSupervisor, refetchInterval: 30_000 });
  const now = useServerNow(q.data?.serverNow);
  const v: HkSupervisorView | undefined = q.data;
  return (
    <div className="hk-side">
      <section className="hk-box" aria-label={t("housekeeping.board.needsYou")} data-testid="hk-needs-you">
        <h2>{t("housekeeping.board.needsYou")}<span className="n">{v?.needsYou.length ?? 0}</span></h2>
        {(v?.needsYou.length ?? 0) === 0 && <div className="hk-empty">{t("housekeeping.board.nothing")}</div>}
        {v?.needsYou.map((n) => (
          <div key={n.taskId} className="hk-row">
            <div style={{ flex: "1 1 auto" }}>
              <b>{t("housekeeping.board.failedTwice", { place: n.placeName ?? "", count: n.fails })}</b>
              <small>{[n.kind, n.reason, n.assigneeInitials].filter((x) => x !== null && x !== "").join(" · ")}</small>
            </div>
          </div>
        ))}
      </section>
      <section className="hk-box" aria-label={t("housekeeping.board.missed")} data-testid="hk-missed">
        <h2>{t("housekeeping.board.missed")}<span className="n">{v?.missed.length ?? 0}</span></h2>
        {(v?.missed.length ?? 0) === 0 && <div className="hk-empty">{t("housekeeping.board.noMissed")}</div>}
        {v?.missed.map((m) => (
          <div key={m.taskId} className="hk-row">
            <div style={{ flex: "1 1 auto" }}>
              <b>{m.areaName}</b>
              <small>{[m.floorName, m.assigneeInitials].filter((x) => x !== null && x !== "").join(" · ")}</small>
            </div>
            <span className="late">{t("housekeeping.board.minLate", { count: lateMinutes(m.dueAt, now) })}</span>
          </div>
        ))}
      </section>
      {(v?.people.length ?? 0) > 0 && (
        <section className="hk-box" aria-label={t("housekeeping.board.people")}>
          <h2>{t("housekeeping.board.people")}</h2>
          {v!.people.map((p) => (
            <div key={p.userId} className="hk-row">
              <div style={{ flex: "1 1 auto" }}>
                <b>{p.name}{p.company !== "In-house" && <span className="hk-ctr">{p.company}</span>}</b>
                <small>{p.placement}</small>
              </div>
              <span>{t("tasks.board.load", { count: p.load })}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
