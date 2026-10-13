import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { acceptTask, doneTask, fetchMyTasks, lateMinutes, startTask, taskRefusal } from "../lib/tasks-api";
import type { TaskCard } from "@hmis/contracts";
import "./tasks.css";

/**
 * ═══ E0.1 TASK ENGINE (issue #713) — MY TASKS, a worker's phone ═══
 *
 * One list, big buttons, one action per card: Accept · Start · Done. Below it, the tasks waiting in
 * the pool that this worker may take. Words and a coloured edge say how late a task is — never colour
 * alone. Notices are a few words on one line (owner rule). No photo button: no kind needs one yet.
 */
type T = (k: string, o?: Record<string, unknown>) => string;

/** The server's clock, carried forward by the browser's, so "late" agrees with the board. */
export function useServerNow(serverNow: string | undefined, tickMs = 15_000): number {
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (serverNow !== undefined) setOffset(Date.parse(serverNow) - Date.now()); }, [serverNow]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now + offset;
}

export type ClockTone = "late" | "soon" | "ok";
export function clockOf(dueAt: string, nowMs: number, t: T, lang: string): { tone: ClockTone; text: string } {
  const late = lateMinutes(dueAt, nowMs);
  if (Date.parse(dueAt) <= nowMs) return { tone: "late", text: t("tasks.clock.late", { count: late }) };
  const left = Math.ceil((Date.parse(dueAt) - nowMs) / 60_000);
  if (left <= 10) return { tone: "soon", text: t("tasks.clock.dueIn", { count: left }) };
  if (left <= 60) return { tone: "ok", text: t("tasks.clock.dueIn", { count: left }) };
  const at = new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(dueAt));
  return { tone: "ok", text: t("tasks.clock.dueAt", { at }) };
}

export const kindLabel = (c: Pick<TaskCard, "kind" | "label">, t: T): string => t(`tasks.kind.${c.kind}`, { defaultValue: c.label });
export const placeLine = (c: Pick<TaskCard, "placeName" | "floorName">, t: T): string =>
  c.placeName === null ? t("tasks.noPlace") : [c.placeName, c.floorName].filter((s) => s !== null && s !== "").join(" · ");

export function MyTasks(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language as string | undefined) ?? "en";
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tasks", "mine"], queryFn: fetchMyTasks, refetchInterval: 15_000 });
  const now = useServerNow(q.data?.serverNow);
  const [notice, setNotice] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: ({ c, verb }: { c: TaskCard; verb: "accept" | "start" | "done" }) =>
      (verb === "accept" ? acceptTask : verb === "start" ? startTask : doneTask)(c.id, c.version),
    onSuccess: () => { setNotice(null); void qc.invalidateQueries({ queryKey: ["tasks"] }); },
    onError: (e) => {
      const code = taskRefusal(e);
      setNotice(t(`tasks.refusal.${code ?? "failed"}`, { defaultValue: t("tasks.refusal.failed") }));
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const mine = q.data?.mine ?? [];
  const pool = q.data?.pool ?? [];
  return (
    <PaperScreen testId="my-tasks">
      <div className="tk-mine">
        <h1>{t("tasks.mine.title")}</h1>
        {notice !== null && <p role="alert" className="tk-notice" data-testid="my-tasks-notice">{notice}</p>}
        {q.isPending && <span className="tk-empty">{t("tasks.loading")}</span>}
        {q.isError && <p role="alert" className="tk-notice">{t("tasks.offline")}</p>}
        {q.data !== undefined && mine.length === 0 && pool.length === 0 && (
          <div className="tk-empty" data-testid="my-tasks-none">{t("tasks.mine.none")}</div>
        )}
        {mine.map((c) => (
          <Card key={c.id} c={c} now={now} lang={lang} busy={run.isPending} onAct={(verb) => run.mutate({ c, verb })} />
        ))}
        {pool.length > 0 && <h2 className="tk-h2">{t("tasks.mine.pool")}</h2>}
        {pool.map((c) => (
          <Card key={c.id} c={c} now={now} lang={lang} busy={run.isPending} pool onAct={(verb) => run.mutate({ c, verb })} />
        ))}
      </div>
    </PaperScreen>
  );
}

function Card({ c, now, lang, busy, pool = false, onAct }: {
  c: TaskCard; now: number; lang: string; busy: boolean; pool?: boolean; onAct: (verb: "accept" | "start" | "done") => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const clock = clockOf(c.dueAt, now, t, lang);
  const verb: "accept" | "start" | "done" = c.state === "accepted" ? "start" : c.state === "in_progress" ? "done" : "accept";
  return (
    <article className={`box tk-card ${clock.tone}`} data-testid={`task-${c.id}`}>
      <div className="what">{kindLabel(c, t)}</div>
      <div className="where">{placeLine(c, t)}</div>
      <div className="meta">
        <span className={`tk-clock ${clock.tone}`} data-testid="task-clock">{clock.text}</span>
        {c.priority !== "routine" && <span className={`pill ${c.priority === "stat" ? "rd" : "gd"}`}>{t(`tasks.priority.${c.priority}`)}</span>}
        {c.state === "in_progress" && <span className="pill on">{t("tasks.state.in_progress")}</span>}
        {c.mergedCount > 0 && <span className="pill">{t("tasks.askedAgain", { count: c.mergedCount })}</span>}
      </div>
      {c.note !== null && c.note !== "" && <div className="note">{c.note}</div>}
      <button
        type="button" className={pool ? "tk-act take" : "tk-act"} disabled={busy}
        onClick={() => onAct(verb)} data-testid={`task-${verb}`}
      >
        {t(`tasks.act.${verb}`)}
      </button>
    </article>
  );
}
