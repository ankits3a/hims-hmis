import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { taskRefusal } from "../lib/tasks-api";
import { PATIENT_MOVE_KIND, addEscortApi, fetchEscorts, oxygenCheckApi } from "../lib/transport-api";
import type { TaskCard, TaskProof, TransportDetail } from "@hmis/contracts";

/**
 * ═══ E1.6 TRANSPORT (issue #723) — A TRANSPORT TASK ON THE PORTER'S PHONE ═══
 *
 * Inside a "My tasks" card: where from and where to (large), how (mode, oxygen, monitor, isolation) and the escort
 * state in words. A patient move adds its two steps before Start — Add escort (a critical patient), Cylinder checked
 * (oxygen) — and replaces Done with the wristband scan: a handheld scanner types the band's code into the field and
 * presses Enter; a camera-less phone can type or paste it. The server decides every rule; refusals show its words.
 */
type T = (k: string, o?: Record<string, unknown>) => string;

/** A refusal code in a few words: the engine's, else transport's, else "did not go through". */
export function refusalText(code: string | null, t: T): string {
  const failed = t("tasks.refusal.failed");
  if (code === null) return failed;
  return t(`tasks.refusal.${code}`, { defaultValue: t(`transport.refusal.${code}`, { defaultValue: failed }) });
}

/**
 * The wristband scan at Done. A patient move ALWAYS ends here — "My tasks" renders it even when the transport
 * details have not loaded, so a plain Done (which the server refuses) is never offered.
 */
export function BandScanForm({ taskId, busy, onScan }: { taskId: string; busy: boolean; onScan: (code: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const scan = (): void => { const v = code.trim(); if (v !== "") onScan(v); };
  return (
    <form className="trc-scan" onSubmit={(e) => { e.preventDefault(); scan(); }} data-testid="band-scan">
      <label htmlFor={`band-${taskId}`}>{t("transport.scan.label")}</label>
      <input
        id={`band-${taskId}`} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters"
        placeholder={t("transport.scan.placeholder")} data-testid="band-input"
      />
      <button type="submit" className="tk-act" disabled={busy || code.trim() === ""} data-testid="task-done">
        {t("transport.scan.handover")}
      </button>
    </form>
  );
}

export function TransportPanel({ c, d, verb, pool, busy, onAct, onNotice }: {
  c: TaskCard; d: TransportDetail; verb: "accept" | "start" | "done"; pool: boolean; busy: boolean;
  onAct: (verb: "accept" | "start" | "done", proof?: TaskProof) => void; onNotice: (text: string | null) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isMove = d.kind === PATIENT_MOVE_KIND;
  const beforeStart = !pool && (c.state === "assigned" || c.state === "accepted");
  const [picking, setPicking] = useState(false);
  const escorts = useQuery({ queryKey: ["transport", "escorts"], queryFn: fetchEscorts, enabled: picking, staleTime: 60_000 });
  const step = useMutation({
    mutationFn: (a: { kind: "escort"; userId: string } | { kind: "oxygen" }) =>
      a.kind === "escort" ? addEscortApi(c.id, a.userId) : oxygenCheckApi(c.id),
    onSuccess: () => { setPicking(false); onNotice(null); void qc.invalidateQueries({ queryKey: ["transport"] }); },
    onError: (e) => { onNotice(refusalText(taskRefusal(e), t)); },
  });
  const escortWords = d.escortState === "waiting" ? t("transport.escort.waiting")
    : d.escortState === "with_escort" ? t("transport.escort.with", { name: d.escortName ?? "" }) : null;

  return (
    <div className="trc" data-testid={`transport-${c.id}`}>
      <div className="trc-route" data-testid="transport-route">
        <span>{d.fromName ?? t("tasks.noPlace")}</span><b aria-hidden>→</b><span>{d.toName ?? t("tasks.noPlace")}</span>
      </div>
      {isMove && (d.patientName !== null || d.admissionNo !== null) && (
        <div className="trc-who" data-testid="transport-patient">{[d.patientName, d.admissionNo].filter(Boolean).join(" · ")}</div>
      )}
      <div className="trc-tags">
        {d.mode !== null && <span className="pill">{t(`transport.mode.${d.mode}`)}</span>}
        {d.oxygen && (
          <span className={d.oxygenChecked ? "pill gd" : "pill rd"} data-testid="transport-o2">
            {d.oxygenChecked ? t("transport.o2.checked") : t("transport.o2.needed")}
          </span>
        )}
        {d.monitor && <span className="pill">{t("transport.monitor")}</span>}
        {d.isolation !== "none" && <span className="pill rd">{t(`transport.isolation.${d.isolation}`)}</span>}
        {escortWords !== null && (
          <span className={d.escortState === "waiting" ? "pill rd" : "pill gd"} data-testid="transport-escort">{escortWords}</span>
        )}
      </div>
      {isMove && beforeStart && d.escortState === "waiting" && (
        picking ? (
          <div className="trc-pick" data-testid="escort-pick">
            {escorts.isPending && <span className="tk-empty">{t("tasks.loading")}</span>}
            {(escorts.data ?? []).length === 0 && !escorts.isPending && <span className="tk-empty">{t("transport.escort.none")}</span>}
            {(escorts.data ?? []).slice(0, 12).map((e) => (
              <button key={e.userId} type="button" className="trc-opt" disabled={step.isPending}
                onClick={() => step.mutate({ kind: "escort", userId: e.userId })}>{e.name}</button>
            ))}
          </div>
        ) : (
          <button type="button" className="tk-act take" onClick={() => setPicking(true)} data-testid="escort-add">
            {t("transport.escort.add")}
          </button>
        )
      )}
      {isMove && beforeStart && d.oxygen && !d.oxygenChecked && (
        <button type="button" className="tk-act take" disabled={step.isPending} onClick={() => step.mutate({ kind: "oxygen" })} data-testid="o2-check">
          {t("transport.o2.check")}
        </button>
      )}
      {isMove && !pool && c.state === "in_progress" ? (
        <BandScanForm taskId={c.id} busy={busy} onScan={(code) => onAct("done", { kind: "scan", code })} />
      ) : (
        <button
          type="button" className={pool ? "tk-act take" : "tk-act"} disabled={busy}
          onClick={() => onAct(verb)} data-testid={`task-${verb}`}
        >
          {t(`tasks.act.${verb}`)}
        </button>
      )}
    </div>
  );
}
