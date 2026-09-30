import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { radiologyErrorCode, radiologyErrorText } from "../../lib/radiology-api";
import { CRITICAL_RUNGS, closeCriticalCall, recordCriticalCall } from "../../lib/radiology-reading-api";
import type { WireCriticalCall } from "../../lib/radiology-reading-api";

/**
 * PLAN 18-S RS8b T4 — **THE CRITICAL CALLS VIEW** (board: Reading room → Critical calls).
 *
 * One call in hand at a time. The ladder is drawn as its four rungs — treating doctor → unit head →
 * duty RMO → HOD — with the rung the call is on marked, and who holds each rung today when the
 * hospital can say (the order's doctor by name; a published roster's names; else the role's name).
 *
 * "Call" only opens the two outcomes — it records nothing by itself (no presence-only button). "No
 * answer" moves the call up a rung (the server's compare-and-set); "Answered" opens the read-back.
 * The call closes ONLY on a read-back that names the finding: the server refuses
 * `read_back_mismatch` otherwise, and the refusal is shown in its words.
 */

export function CallCard({ call, now, onDone }: {
  call: WireCriticalCall; now: number; onDone: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<"idle" | "calling" | "answered">("idle");
  const rung = call.rungs[call.ladderRung] ?? call.rungs[0]!;
  const [calledName, setCalledName] = useState<string>(rung.people[0]?.name ?? "");
  const [calledUserId, setCalledUserId] = useState<string | null>(rung.people[0]?.userId ?? null);
  const everyone = [...new Map(call.rungs.flatMap((r) => r.people).map((p) => [p.userId, p])).values()];
  const [clinician, setClinician] = useState<string>(rung.people[0]?.userId ?? everyone[0]?.userId ?? "");
  const [readBack, setReadBack] = useState("");
  const [error, setError] = useState<{ code: string | null; text: string } | null>(null);

  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["radiology", "reading", "criticals"] }); };
  const record = useMutation({
    mutationFn: (outcome: "no_answer" | "answered") => recordCriticalCall(call.criticalId, {
      rung: call.ladderRung, outcome,
      calledUserId, calledName: calledUserId === null ? (calledName.trim() || null) : null,
    }),
    onSuccess: (_r, outcome) => {
      setError(null);
      /**
       * The clinician who read it back is a PERSON WITH AN ACCOUNT (F76: a typed name is not a
       * clinician). When the one who answered was typed rather than picked, nobody is pre-chosen —
       * the radiologist picks them deliberately, never the treating doctor by default.
       */
      if (outcome === "answered") { setPhase("answered"); setClinician(calledUserId ?? ""); } else { setPhase("idle"); }
      refresh();
    },
    onError: (e) => { setError({ code: radiologyErrorCode(e), text: radiologyErrorText(e) }); refresh(); },
  });
  const close = useMutation({
    mutationFn: () => closeCriticalCall(call.criticalId, { acknowledgedByClinicianId: clinician, readBack: readBack.trim() }),
    onSuccess: () => { setError(null); refresh(); onDone(); },
    onError: (e) => setError({ code: radiologyErrorCode(e), text: radiologyErrorText(e) }),
  });

  const dueMs = call.dueAt === null ? null : new Date(call.dueAt).getTime() - now;
  const mins = dueMs === null ? null : Math.round(Math.abs(dueMs) / 60_000);

  /** The dock's ONE next act for this call; Enter runs it outside a text box. */
  const dock: { label: string; hint: string; run: (() => void) | null } = phase === "answered"
    ? {
      label: t("radiology.calls.dock.close"), hint: t("radiology.calls.dock.closeHint"),
      run: readBack.trim() !== "" && clinician !== "" && !close.isPending ? () => close.mutate() : null,
    }
    : phase === "calling"
      ? { label: t("radiology.calls.dock.outcome"), hint: t("radiology.calls.dock.outcomeHint"), run: null }
      : {
        label: t("radiology.calls.dock.call", { rung: t(`radiology.calls.rung.${rung.key}`) }),
        hint: t("radiology.calls.dock.callHint"), run: () => setPhase("calling"),
      };
  const runRef = useRef<(() => void) | null>(null);
  runRef.current = dock.run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (e.key === "Enter" && !["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag) && runRef.current !== null) {
        e.preventDefault(); runRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <article className="space-y-3 rounded border bg-card p-3 text-sm" data-testid={`call-${call.criticalId}`} data-rung={call.ladderRung}>
      <header className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs font-bold text-white ${call.category === "red" ? "bg-red-700" : call.category === "orange" ? "bg-orange-600" : "bg-yellow-600"}`}>
          {call.category.toUpperCase()}
        </span>
        <b>{call.patientName}</b>
        <span className="mo text-xs text-muted-foreground">{call.patientUhid} · {call.accessionNo}</span>
        <span className="text-xs">{call.studyTypeName}</span>
      </header>
      {call.overdue && (
        <p className="m-0 text-sm font-semibold text-red-800" data-testid="call-overdue">
          {t("radiology.calls.overdue", { mins: mins ?? 0, window: call.windowMin ?? 0 })}
        </p>
      )}
      {!call.overdue && mins !== null && (
        <p className="m-0 text-xs text-muted-foreground">{t("radiology.calls.dueIn", { mins })}</p>
      )}
      <div>
        <span className="tag">{t("radiology.calls.finding")}</span>
        <p className="m-0 mt-1" data-testid="call-finding">{call.finding ?? "—"}</p>
      </div>

      <ol className="m-0 grid list-none grid-cols-1 gap-1 p-0 sm:grid-cols-4" aria-label={t("radiology.calls.ladder")} data-testid="ladder">
        {CRITICAL_RUNGS.map((key, i) => {
          const r = call.rungs.find((x) => x.key === key);
          const here = i === call.ladderRung;
          const passed = i < call.ladderRung;
          return (
            <li key={key} aria-current={here ? "step" : undefined} data-rung-key={key}
              className={`rounded border p-2 text-xs ${here ? "border-green-700 bg-green-50 font-semibold" : passed ? "opacity-60" : ""}`}>
              <span className="block">{i + 1}. {t(`radiology.calls.rung.${key}`)}</span>
              <span className="block truncate font-normal">
                {r === undefined || r.people.length === 0 ? t(`radiology.calls.rungRole.${key}`) : r.people.map((p) => p.name).join(", ")}
              </span>
            </li>
          );
        })}
      </ol>

      {call.attempts.length > 0 && (
        <ul className="m-0 list-none space-y-0.5 p-0 text-xs text-muted-foreground" data-testid="call-attempts">
          {call.attempts.map((a, i) => (
            <li key={i}>
              {new Date(a.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} · {t(`radiology.calls.rung.${CRITICAL_RUNGS[a.rung] ?? "hod"}`)} · {a.calledUserName ?? a.calledName ?? "—"} · {t(`radiology.calls.outcome.${a.outcome}`)}
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <p role="alert" className="m-0 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900" data-refusal={error.code ?? "unknown"}>{error.text}</p>
      )}

      {phase === "calling" && (
        <div className="space-y-2 rounded border p-2" data-testid="call-outcome">
          <label className="flex flex-col gap-1 text-xs">
            {t("radiology.calls.who", { rung: t(`radiology.calls.rung.${rung.key}`) })}
            {rung.people.length > 0
              ? (
                <select className="rounded border bg-card px-2 py-1 text-sm" value={calledUserId ?? ""}
                  onChange={(e) => { setCalledUserId(e.target.value === "" ? null : e.target.value); }}>
                  {rung.people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
                  <option value="">{t("radiology.calls.someoneElse")}</option>
                </select>
              )
              : null}
            {(rung.people.length === 0 || calledUserId === null) && (
              <input className="rounded border px-2 py-1 text-sm" value={calledName} maxLength={120} data-testid="called-name"
                placeholder={t("radiology.calls.namePlaceholder")} onChange={(e) => { setCalledName(e.target.value); setCalledUserId(null); }} />
            )}
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="rounded border px-3 py-1 text-sm disabled:opacity-50" data-testid="outcome-no-answer"
              disabled={record.isPending || (calledUserId === null && calledName.trim() === "")} onClick={() => record.mutate("no_answer")}>
              {t("radiology.calls.noAnswer")}
            </button>
            <button type="button" className="rounded border border-green-700 px-3 py-1 text-sm disabled:opacity-50" data-testid="outcome-answered"
              disabled={record.isPending || (calledUserId === null && calledName.trim() === "")} onClick={() => record.mutate("answered")}>
              {t("radiology.calls.answered")}
            </button>
          </div>
        </div>
      )}

      {phase === "answered" && (
        <div className="space-y-2 rounded border border-green-700 p-2" data-testid="read-back">
          <label className="flex flex-col gap-1 text-xs">
            {t("radiology.calls.clinician")}
            <select className="rounded border bg-card px-2 py-1 text-sm" value={clinician} onChange={(e) => setClinician(e.target.value)} data-testid="clinician">
              <option value="">—</option>
              {everyone.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
            </select>
            {clinician === "" && <span className="text-muted-foreground" data-testid="clinician-hint">{t("radiology.calls.clinicianHint")}</span>}
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {t("radiology.calls.readBackLabel")}
            <textarea className="rounded border px-2 py-1 text-sm" rows={2} value={readBack} maxLength={2000} data-testid="read-back-text"
              onChange={(e) => setReadBack(e.target.value)} placeholder={t("radiology.calls.readBackHint")} />
          </label>
        </div>
      )}

      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm" data-testid="calls-dock">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">{dock.hint}</span>
        <button
          type="button" data-testid="calls-dock-act"
          className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          disabled={dock.run === null} onClick={() => dock.run?.()}
        >
          {dock.label} <span className="kb">Enter</span>
        </button>
      </div>
    </article>
  );
}

export function AcknowledgedLog({ calls }: { calls: WireCriticalCall[] }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <details className="rounded border bg-card p-2 text-sm" data-testid="acknowledged-log">
      <summary className="cursor-pointer">{t("radiology.calls.logTitle", { count: calls.length })}</summary>
      {calls.length === 0
        ? <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.calls.logEmpty")}</p>
        : (
          <ul className="m-0 mt-1 list-none space-y-1 p-0">
            {calls.map((c) => (
              <li key={c.criticalId} className="rounded border p-1 text-xs">
                <b>{c.category.toUpperCase()}</b> · {c.patientName} · {c.studyTypeName} · {t("radiology.calls.closedBy", {
                  name: c.acknowledgedByName ?? "—",
                  at: c.acknowledgedAt === null ? "—" : new Date(c.acknowledgedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }),
                })}
                {c.readBack !== null && <span className="block">“{c.readBack}”</span>}
              </li>
            ))}
          </ul>
        )}
    </details>
  );
}
