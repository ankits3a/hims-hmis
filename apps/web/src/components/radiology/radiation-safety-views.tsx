import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { todayIst } from "../../lib/opd-api";
import {
  INCIDENT_KINDS, aerbErrorText, closeIncident, declarePregnancy, endPregnancy, fetchAerbPickers,
  fetchIncidents, fetchPregnancy, fetchQaDue, importTld, investigateIncident, notifyIncident,
  recordIncident, updateIncidentActions,
} from "../../lib/aerb-api";
import type {
  IncidentAction, IncidentKind, WireAttention, WireIncident, WireQaDue, WireTldImportReport,
} from "../../lib/aerb-api";

/**
 * 18-S RS11 — the four views the Radiation safety station gains: TLD import (dry run → confirm),
 * Incidents, Pregnancy declarations, and the QA due list with its blocked machines — plus the
 * station's ONE right-hand list ("Needs you").
 *
 * Every rule is the server's: which line of a TLD file is refused, which incident must reach AERB,
 * when a QA is overdue, whether a machine is blocked. These views render what came back and post
 * what the RSO typed; they compute nothing a register could be asked to prove. Every refusal is the
 * server's sentence (`aerbErrorText`).
 */

const input = "border px-2 py-1";
const primary = "border px-3 py-1 text-sm bg-black text-white disabled:opacity-50";
const secondary = "border px-3 py-1 text-sm disabled:opacity-50";
/** Cells padded so adjacent headers never run together ("LineBadge"), the walk's 1440 finding. */
const table = "w-full text-sm [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:px-2 [&_td]:py-1 [&_td]:align-top";
/** The room console's dock (RS6): ONE next act, pinned. */
const dock = "sticky bottom-0 flex flex-wrap items-end gap-3 rounded border bg-card p-3 shadow-sm";

function Label({ text, children }: { text: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="flex flex-col gap-1 text-sm min-w-0">
      <span className="text-slate-700">{text}</span>
      {children}
    </label>
  );
}

function Refusal({ testId, message }: { testId: string; message: string | null }): React.ReactElement | null {
  if (message === null) return null;
  return <p role="alert" data-testid={testId} className="text-red-600 text-sm break-words">{message}</p>;
}

/* ═══════════════════════════════════ the ONE list ═══════════════════════════════════ */

export function SafetyAttentionList({ rows, onOpen }: {
  rows: WireAttention[];
  onOpen: (view: WireAttention["view"]) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground" data-testid="aerb-attention-empty">{t("aerb.rs11.attention.empty")}</p>;
  }
  return (
    <ul className="space-y-1" data-testid="aerb-attention">
      {rows.map((r) => (
        <li key={r.key}>
          <button
            type="button"
            data-testid={`aerb-attention-${r.key}`}
            className={`w-full rounded border p-2 text-left text-sm hover:bg-muted bg-card ${r.severity === "red" ? "border-red-400" : ""}`}
            onClick={() => { onOpen(r.view); }}
          >
            <span className="flex justify-between gap-2">
              <b className="truncate">{r.subject}</b>
              <span className={`shrink-0 text-xs ${r.severity === "red" ? "text-red-700" : "text-amber-700"}`}>
                {t(`aerb.rs11.attention.view.${r.view}`)}
              </span>
            </span>
            <span className="block text-xs text-muted-foreground break-words">{r.detail}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ═══════════════════════════════════ QA due ═══════════════════════════════════ */

export function QaDueBlock(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["aerb", "qa-due"], queryFn: fetchQaDue });
  const rows: WireQaDue[] = (q.data?.rows ?? []).filter((r) => r.state !== "ok");
  const blocked = [...new Map((q.data?.rows ?? []).filter((r) => r.deviceStatus === "qa_blocked").map((r) => [r.deviceResourceId, r])).values()];
  return (
    <section className="space-y-2" data-testid="aerb-qa-due">
      <h3 className="font-semibold text-sm">{t("aerb.rs11.qaDue.title")}</h3>
      <p className="text-xs text-muted-foreground">{t("aerb.rs11.qaDue.rule", { years: q.data?.defaultIntervalYears ?? 2 })}</p>
      {q.isError ? <Refusal testId="aerb-qa-due-error" message={aerbErrorText(q.error)} /> : null}
      {blocked.length > 0
        ? (
          <div role="alert" className="border border-red-400 p-2 text-sm" data-testid="aerb-qa-due-blocked">
            <b>{t("aerb.rs11.qaDue.blocked")}</b>{" "}
            {blocked.map((b) => `${b.deviceCode} — ${b.deviceName}`).join("; ")}
          </div>
        )
        : null}
      {rows.length === 0 && q.isSuccess
        ? <p className="text-sm" data-testid="aerb-qa-due-none">{t("aerb.rs11.qaDue.none")}</p>
        : (
          <div className="overflow-x-auto">
            <table className={table}>
              <thead><tr className="text-left">
                <th>{t("aerb.rs11.qaDue.machine")}</th><th>{t("aerb.rs11.qaDue.test")}</th>
                <th>{t("aerb.rs11.qaDue.last")}</th><th>{t("aerb.rs11.qaDue.due")}</th><th>{t("aerb.rs11.qaDue.state")}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.deviceResourceId}-${r.qaType}`} data-testid={`aerb-qa-due-${r.deviceCode}`} className={r.state === "due" ? "" : "text-red-700"}>
                    <td>{r.deviceCode} · {r.deviceName}</td>
                    <td>{r.qaType}</td>
                    <td className="mo">{r.lastPerformedOn} ({r.lastResult})</td>
                    <td className="mo">{r.dueOn}{r.defaultInterval ? ` · ${t("aerb.rs11.qaDue.default")}` : ""}</td>
                    <td>{t(`aerb.rs11.qaDue.stateName.${r.state}`)}{r.deviceStatus === "qa_blocked" ? " · qa_blocked" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

/* ═══════════════════════════════════ TLD import ═══════════════════════════════════ */

export function TldImportView({ canManage }: { canManage: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [reportedOn, setReportedOn] = useState(todayIst());
  const [labRef, setLabRef] = useState("");
  const [preview, setPreview] = useState<WireTldImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const body = (dryRun: boolean) => ({ csv, reportedOn, labRef: labRef.trim() === "" ? null : labRef.trim(), dryRun });
  const dry = useMutation({
    mutationFn: () => importTld(body(true)),
    onSuccess: (r) => { setPreview(r); setError(null); setDone(null); },
    onError: (e: unknown) => { setPreview(null); setError(aerbErrorText(e)); },
  });
  const confirm = useMutation({
    mutationFn: () => importTld(body(false)),
    onSuccess: (r) => {
      setDone(t("aerb.rs11.tld.imported", { count: r.imported }));
      setPreview(null); setCsv(""); setFileName(null); setError(null);
      void queryClient.invalidateQueries({ queryKey: ["aerb"] });
    },
    onError: (e: unknown) => { setError(aerbErrorText(e)); },
  });

  if (!canManage) return <p className="text-sm">{t("aerb.rs11.tld.rsoOnly")}</p>;

  const onFile = (f: File | undefined): void => {
    if (f === undefined) return;
    setFileName(f.name);
    setPreview(null);
    void f.text().then(setCsv);
  };

  return (
    <section className="space-y-3" data-testid="aerb-tld-import">
      <h3 className="font-semibold">{t("aerb.rs11.tld.title")}</h3>
      <p className="text-sm text-muted-foreground">{t("aerb.rs11.tld.layout")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Label text={t("aerb.rs11.tld.file")}>
          <input className={input} type="file" accept=".csv,text/csv" data-testid="aerb-tld-file" onChange={(e) => { onFile(e.target.files?.[0]); }} />
        </Label>
        <Label text={t("aerb.rs11.tld.reportedOn")}>
          <input className={input} type="date" data-testid="aerb-tld-reported-on" value={reportedOn} onChange={(e) => { setReportedOn(e.target.value); setPreview(null); }} />
        </Label>
        <Label text={t("aerb.rs11.tld.labRef")}>
          <input className={input} data-testid="aerb-tld-lab-ref" value={labRef} onChange={(e) => { setLabRef(e.target.value); }} />
        </Label>
      </div>
      <Label text={t("aerb.rs11.tld.paste")}>
        <textarea
          className={`${input} font-mono text-xs`} rows={4} data-testid="aerb-tld-csv" value={csv}
          onChange={(e) => { setCsv(e.target.value); setFileName(null); setPreview(null); }}
        />
      </Label>
      {fileName !== null ? <p className="text-xs">{fileName}</p> : null}
      <Refusal testId="aerb-tld-error" message={error} />
      {done !== null ? <p role="status" className="text-sm text-green-800" data-testid="aerb-tld-done">{done}</p> : null}

      {preview !== null
        ? (
          <div className="space-y-2" data-testid="aerb-tld-preview">
            <p className={`text-sm ${preview.errorCount > 0 ? "text-red-700" : ""}`} data-testid="aerb-tld-summary">
              {preview.errorCount > 0
                ? t("aerb.rs11.tld.refused", { bad: preview.errorCount, total: preview.rows.length })
                : t("aerb.rs11.tld.ready", { total: preview.rows.length, flagged: preview.flagged.investigation })}
            </p>
            <div className="overflow-x-auto">
              <table className={table}>
                <thead><tr className="text-left">
                  <th>{t("aerb.rs11.tld.line")}</th><th>{t("aerb.rs11.tld.badge")}</th><th>{t("aerb.rs11.tld.period")}</th>
                  <th>Hp(10)</th><th>{t("aerb.rs11.tld.flags")}</th>
                </tr></thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.line} data-testid={`aerb-tld-row-${String(r.line)}`} className={r.errors.length > 0 ? "text-red-700" : ""}>
                      <td className="mo">{r.line}</td>
                      <td>{r.badgeNo}{r.userName !== null ? ` · ${r.userName}` : ""}</td>
                      <td className="mo whitespace-nowrap">{r.periodStart ?? "?"} – {r.periodEnd ?? "?"}</td>
                      <td className="mo">{r.hp10Msv ?? "?"}</td>
                      <td className="break-words">
                        {[...r.errors,
                          ...(r.overInvestigationLevel ? [t("aerb.rs11.tld.flag.investigation", { level: r.investigationLevelMsv })] : []),
                          ...(r.overAnnualProjection ? [t("aerb.rs11.tld.flag.projection", { msv: r.projectedAnnualMsv })] : []),
                          ...(r.overAnnualLimit ? [t("aerb.rs11.tld.flag.annual", { msv: r.yearTotalMsv })] : []),
                          ...r.warnings].join(" · ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
        : null}

      <div className={dock} data-testid="aerb-tld-dock">
        {preview !== null && preview.errorCount === 0
          ? (
            <button type="button" className={primary} data-testid="aerb-tld-confirm" disabled={confirm.isPending} onClick={() => { confirm.mutate(); }}>
              {t("aerb.rs11.tld.confirm", { count: preview.rows.length })}
            </button>
          )
          : (
            <button type="button" className={primary} data-testid="aerb-tld-check" disabled={csv.trim() === "" || dry.isPending} onClick={() => { dry.mutate(); }}>
              {t("aerb.rs11.tld.check")}
            </button>
          )}
      </div>
    </section>
  );
}

/* ═══════════════════════════════════ Incidents ═══════════════════════════════════ */

const EMPTY_ACTION: IncidentAction = { action: "", owner: "", doneOn: null };

function ActionsEditor({ actions, onChange, testId }: {
  actions: IncidentAction[];
  onChange: (a: IncidentAction[]) => void;
  testId: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const set = (i: number, patch: Partial<IncidentAction>): void => {
    onChange(actions.map((a, k) => (k === i ? { ...a, ...patch } : a)));
  };
  return (
    <div className="space-y-2" data-testid={testId}>
      {actions.map((a, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
          <input className={input} placeholder={t("aerb.rs11.incident.action")} data-testid={`${testId}-action-${String(i)}`} value={a.action} onChange={(e) => { set(i, { action: e.target.value }); }} />
          <input className={input} placeholder={t("aerb.rs11.incident.owner")} data-testid={`${testId}-owner-${String(i)}`} value={a.owner} onChange={(e) => { set(i, { owner: e.target.value }); }} />
          <input className={input} type="date" aria-label={t("aerb.rs11.incident.doneOn")} data-testid={`${testId}-done-${String(i)}`} value={a.doneOn ?? ""} onChange={(e) => { set(i, { doneOn: e.target.value === "" ? null : e.target.value }); }} />
        </div>
      ))}
      <button type="button" className={secondary} data-testid={`${testId}-add`} onClick={() => { onChange([...actions, { ...EMPTY_ACTION }]); }}>
        {t("aerb.rs11.incident.addAction")}
      </button>
    </div>
  );
}

function IncidentDetail({ incident, canManage, onDone }: { incident: WireIncident; canManage: boolean; onDone: (m: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [rootCause, setRootCause] = useState(incident.rootCause ?? "");
  const [actions, setActions] = useState<IncidentAction[]>(incident.correctiveActions.length > 0 ? incident.correctiveActions : [{ ...EMPTY_ACTION }]);
  const [notifiedOn, setNotifiedOn] = useState(todayIst());
  const [notificationRef, setNotificationRef] = useState("");
  const [closureNote, setClosureNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ok = (m: string): void => { setError(null); onDone(m); void queryClient.invalidateQueries({ queryKey: ["aerb"] }); };
  const fail = (e: unknown): void => { setError(aerbErrorText(e)); };
  const investigate = useMutation({ mutationFn: () => investigateIncident(incident.id, { rootCause, correctiveActions: actions }), onSuccess: () => ok(t("aerb.rs11.incident.investigated", { no: incident.incidentNo })), onError: fail });
  const saveActions = useMutation({ mutationFn: () => updateIncidentActions(incident.id, actions), onSuccess: () => ok(t("aerb.rs11.incident.actionsSaved", { no: incident.incidentNo })), onError: fail });
  const notify = useMutation({ mutationFn: () => notifyIncident(incident.id, { notifiedOn, notificationRef }), onSuccess: () => ok(t("aerb.rs11.incident.notified", { no: incident.incidentNo })), onError: fail });
  const close = useMutation({ mutationFn: () => closeIncident(incident.id, closureNote.trim() === "" ? null : closureNote.trim()), onSuccess: () => ok(t("aerb.rs11.incident.closed", { no: incident.incidentNo })), onError: fail });

  const writable = canManage && incident.state !== "closed";
  return (
    <div className="border p-3 space-y-3" data-testid={`aerb-incident-detail-${incident.incidentNo}`}>
      <h3 className="font-semibold">{incident.incidentNo} · {t(`aerb.rs11.incident.kind.${incident.kind}`)}</h3>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt>{t("aerb.rs11.incident.who")}</dt><dd className="break-words">{incident.affectedLabel}{incident.uhid !== null ? ` · ${incident.uhid}` : ""}</dd>
        <dt>{t("aerb.rs11.incident.when")}</dt><dd className="mo">{incident.occurredAt.slice(0, 16).replace("T", " ")} UTC{incident.deviceCode !== null ? ` · ${incident.deviceCode}` : ""}</dd>
        <dt>{t("aerb.rs11.incident.dose")}</dt><dd>{incident.estimatedDoseMsv ?? "—"} mSv{incident.doseNote !== null ? ` · ${incident.doseNote}` : ""}</dd>
        <dt>{t("aerb.rs11.incident.what")}</dt><dd className="break-words">{incident.description}</dd>
        <dt>{t("aerb.rs11.incident.immediate")}</dt><dd className="break-words">{incident.immediateAction}</dd>
        <dt>{t("aerb.rs11.incident.aerb")}</dt>
        <dd className={incident.notifyOverdue ? "text-red-700" : ""} data-testid="aerb-incident-aerb">
          {incident.notifiedOn !== null
            ? t("aerb.rs11.incident.aerbDone", { on: incident.notifiedOn, ref: incident.notificationRef })
            : incident.notifyRequired
              ? t(incident.notifyOverdue ? "aerb.rs11.incident.aerbOverdue" : "aerb.rs11.incident.aerbDue")
              : t("aerb.rs11.incident.aerbNot")}
        </dd>
        {incident.rootCause !== null ? <><dt>{t("aerb.rs11.incident.rootCause")}</dt><dd className="break-words">{incident.rootCause}</dd></> : null}
      </dl>
      {incident.state !== "open" && incident.correctiveActions.length > 0
        ? (
          <ul className="text-sm list-disc pl-5">
            {incident.correctiveActions.map((a, i) => <li key={i}>{a.action} — {a.owner}: {a.doneOn ?? t("aerb.rs11.incident.openAction")}</li>)}
          </ul>
        )
        : null}
      <Refusal testId="aerb-incident-error" message={error} />
      {writable && incident.state === "open"
        ? (
          <div className="space-y-2">
            <Label text={t("aerb.rs11.incident.rootCause")}>
              <textarea className={input} rows={2} data-testid="aerb-incident-root-cause" value={rootCause} onChange={(e) => { setRootCause(e.target.value); }} />
            </Label>
            <ActionsEditor actions={actions} onChange={setActions} testId="aerb-incident-actions" />
            <button type="button" className={primary} data-testid="aerb-incident-investigate" disabled={investigate.isPending} onClick={() => { investigate.mutate(); }}>
              {t("aerb.rs11.incident.investigate")}
            </button>
          </div>
        )
        : null}
      {writable && incident.state === "investigated"
        ? (
          <div className="space-y-2">
            <ActionsEditor actions={actions} onChange={setActions} testId="aerb-incident-actions" />
            <button type="button" className={secondary} data-testid="aerb-incident-save-actions" disabled={saveActions.isPending} onClick={() => { saveActions.mutate(); }}>
              {t("aerb.rs11.incident.saveActions")}
            </button>
          </div>
        )
        : null}
      {writable && incident.notifiedOn === null
        ? (
          <div className="grid gap-2 sm:grid-cols-3 items-end">
            <Label text={t("aerb.rs11.incident.notifiedOn")}>
              <input className={input} type="date" data-testid="aerb-incident-notified-on" value={notifiedOn} onChange={(e) => { setNotifiedOn(e.target.value); }} />
            </Label>
            <Label text={t("aerb.rs11.incident.notificationRef")}>
              <input className={input} data-testid="aerb-incident-notification-ref" value={notificationRef} onChange={(e) => { setNotificationRef(e.target.value); }} />
            </Label>
            <button type="button" className={secondary} data-testid="aerb-incident-notify" disabled={notificationRef.trim() === "" || notify.isPending} onClick={() => { notify.mutate(); }}>
              {t("aerb.rs11.incident.notify")}
            </button>
          </div>
        )
        : null}
      {writable && incident.state === "investigated"
        ? (
          <div className={dock} data-testid="aerb-incident-dock">
            <Label text={t("aerb.rs11.incident.closureNote")}>
              <input className={input} data-testid="aerb-incident-closure-note" value={closureNote} onChange={(e) => { setClosureNote(e.target.value); }} />
            </Label>
            <button type="button" className={primary} data-testid="aerb-incident-close" disabled={close.isPending} onClick={() => { close.mutate(); }}>
              {t("aerb.rs11.incident.close")}
            </button>
          </div>
        )
        : null}
    </div>
  );
}

type IncidentDraft = {
  kind: IncidentKind; occurredAt: string; deviceResourceId: string; affectedType: "patient" | "worker" | "other";
  patientUhid: string; workerUserId: string; affectedName: string; estimatedDoseMsv: string; doseNote: string;
  description: string; immediateAction: string; significantlyAboveIntended: boolean;
};

function nowLocalInput(): string {
  const d = new Date(Date.now() + 330 * 60_000);
  return d.toISOString().slice(0, 16);
}

function NewIncidentForm({ onDone, onCancel }: { onDone: (m: string) => void; onCancel: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const pickers = useQuery({ queryKey: ["aerb", "pickers"], queryFn: fetchAerbPickers });
  const [d, setD] = useState<IncidentDraft>({
    kind: "wrong_patient", occurredAt: nowLocalInput(), deviceResourceId: "", affectedType: "patient", patientUhid: "",
    workerUserId: "", affectedName: "", estimatedDoseMsv: "", doseNote: "", description: "", immediateAction: "",
    significantlyAboveIntended: false,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<IncidentDraft>): void => { setD((x) => ({ ...x, ...patch })); };
  const save = useMutation({
    mutationFn: () => recordIncident({
      kind: d.kind,
      /** The datetime-local field is IST wall time. */
      occurredAt: `${d.occurredAt}:00+05:30`,
      deviceResourceId: d.deviceResourceId === "" ? null : d.deviceResourceId,
      affectedType: d.affectedType,
      patientUhid: d.affectedType === "patient" ? d.patientUhid.trim() : null,
      workerUserId: d.affectedType === "worker" && d.workerUserId !== "" ? d.workerUserId : null,
      affectedName: d.affectedType === "other" ? d.affectedName.trim() : null,
      estimatedDoseMsv: d.estimatedDoseMsv.trim() === "" ? null : Number(d.estimatedDoseMsv),
      doseNote: d.doseNote.trim() === "" ? null : d.doseNote.trim(),
      description: d.description.trim(),
      immediateAction: d.immediateAction.trim(),
      significantlyAboveIntended: d.significantlyAboveIntended,
    }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ["aerb"] });
      onDone(t(r.notifyRequired ? "aerb.rs11.incident.recordedNotify" : "aerb.rs11.incident.recorded", { no: r.incidentNo }));
    },
    onError: (e: unknown) => { setError(aerbErrorText(e)); },
  });
  const notifiable = d.kind === "worker_over_limit" || d.significantlyAboveIntended;
  return (
    <div className="border p-3 space-y-3" data-testid="aerb-incident-new">
      <h3 className="font-semibold">{t("aerb.rs11.incident.new")}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Label text={t("aerb.rs11.incident.kindLabel")}>
          <select className={input} data-testid="aerb-incident-kind" value={d.kind} onChange={(e) => { set({ kind: e.target.value as IncidentKind }); }}>
            {INCIDENT_KINDS.map((k) => <option key={k} value={k}>{t(`aerb.rs11.incident.kind.${k}`)}</option>)}
          </select>
        </Label>
        <Label text={t("aerb.rs11.incident.when")}>
          <input className={input} type="datetime-local" data-testid="aerb-incident-when" value={d.occurredAt} onChange={(e) => { set({ occurredAt: e.target.value }); }} />
        </Label>
        <Label text={t("aerb.rs11.incident.machine")}>
          <select className={input} data-testid="aerb-incident-machine" value={d.deviceResourceId} onChange={(e) => { set({ deviceResourceId: e.target.value }); }}>
            <option value="">—</option>
            {(pickers.data?.devices ?? []).map((m) => <option key={m.resourceId} value={m.resourceId}>{m.code} · {m.name}</option>)}
          </select>
        </Label>
        <Label text={t("aerb.rs11.incident.affected")}>
          <select className={input} data-testid="aerb-incident-affected" value={d.affectedType} onChange={(e) => { set({ affectedType: e.target.value as IncidentDraft["affectedType"] }); }}>
            <option value="patient">{t("aerb.rs11.incident.affectedType.patient")}</option>
            <option value="worker">{t("aerb.rs11.incident.affectedType.worker")}</option>
            <option value="other">{t("aerb.rs11.incident.affectedType.other")}</option>
          </select>
        </Label>
        {d.affectedType === "patient"
          ? <Label text={t("aerb.rs11.incident.uhid")}><input className={input} data-testid="aerb-incident-uhid" value={d.patientUhid} onChange={(e) => { set({ patientUhid: e.target.value }); }} /></Label>
          : d.affectedType === "worker"
            ? (
              <Label text={t("aerb.rs11.incident.worker")}>
                <select className={input} data-testid="aerb-incident-worker" value={d.workerUserId} onChange={(e) => { set({ workerUserId: e.target.value }); }}>
                  <option value="">—</option>
                  {(pickers.data?.users ?? []).map((u) => <option key={u.userId} value={u.userId}>{u.fullName}</option>)}
                </select>
              </Label>
            )
            : <Label text={t("aerb.rs11.incident.name")}><input className={input} data-testid="aerb-incident-name" value={d.affectedName} onChange={(e) => { set({ affectedName: e.target.value }); }} /></Label>}
        <Label text={t("aerb.rs11.incident.doseMsv")}>
          <input className={input} inputMode="decimal" data-testid="aerb-incident-dose" value={d.estimatedDoseMsv} onChange={(e) => { set({ estimatedDoseMsv: e.target.value }); }} />
        </Label>
      </div>
      <Label text={t("aerb.rs11.incident.what")}>
        <textarea className={input} rows={2} data-testid="aerb-incident-description" value={d.description} onChange={(e) => { set({ description: e.target.value }); }} />
      </Label>
      <Label text={t("aerb.rs11.incident.immediate")}>
        <textarea className={input} rows={2} data-testid="aerb-incident-immediate" value={d.immediateAction} onChange={(e) => { set({ immediateAction: e.target.value }); }} />
      </Label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" data-testid="aerb-incident-significant" checked={d.significantlyAboveIntended} onChange={(e) => { set({ significantlyAboveIntended: e.target.checked }); }} />
        {t("aerb.rs11.incident.significant")}
      </label>
      <p className={`text-sm ${notifiable ? "text-red-700" : "text-muted-foreground"}`} data-testid="aerb-incident-notify-rule">
        {t(notifiable ? "aerb.rs11.incident.willNotify" : "aerb.rs11.incident.wontNotify")}
      </p>
      <Refusal testId="aerb-incident-new-error" message={error} />
      <div className={dock}>
        <button type="button" className={primary} data-testid="aerb-incident-record" disabled={d.description.trim() === "" || d.immediateAction.trim() === "" || save.isPending} onClick={() => { save.mutate(); }}>
          {t("aerb.rs11.incident.record")}
        </button>
        <button type="button" className={secondary} onClick={onCancel}>{t("aerb.write.cancel")}</button>
      </div>
    </div>
  );
}

export function IncidentsView(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["aerb", "incidents"], queryFn: fetchIncidents });
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const rows = q.data?.rows ?? [];
  const canManage = q.data?.canManage ?? false;
  const open = rows.find((r) => r.id === openId) ?? null;
  return (
    <section className="space-y-3" data-testid="aerb-incidents">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{t("aerb.rs11.incident.title")}</h3>
        {canManage && !creating
          ? <button type="button" className={secondary} data-testid="aerb-incident-new-open" onClick={() => { setCreating(true); setOpenId(null); setOutcome(null); }}>{t("aerb.rs11.incident.new")}</button>
          : null}
      </div>
      <p className="text-xs text-muted-foreground">{t("aerb.rs11.incident.rule")}</p>
      {q.isError ? <Refusal testId="aerb-incidents-error" message={aerbErrorText(q.error)} /> : null}
      {outcome !== null ? <p role="status" className="text-sm text-green-800" data-testid="aerb-incident-outcome">{outcome}</p> : null}
      {creating ? <NewIncidentForm onDone={(m) => { setCreating(false); setOutcome(m); }} onCancel={() => { setCreating(false); }} /> : null}
      {open !== null ? <IncidentDetail key={`${open.id}-${open.state}-${open.notifiedOn ?? ""}`} incident={open} canManage={canManage} onDone={setOutcome} /> : null}
      {q.isSuccess && rows.length === 0 ? <p className="text-sm" data-testid="aerb-incidents-none">{t("aerb.rs11.incident.none")}</p> : null}
      {rows.length > 0
        ? (
          <div className="overflow-x-auto">
            <table className={table}>
              <thead><tr className="text-left">
                <th>{t("aerb.rs11.incident.no")}</th><th>{t("aerb.rs11.incident.kindLabel")}</th>
                <th>{t("aerb.rs11.incident.who")}</th><th>{t("aerb.rs11.incident.aerb")}</th><th>{t("aerb.rs11.incident.state")}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-testid={`aerb-incident-${r.incidentNo}`} className={r.notifyOverdue ? "text-red-700" : ""}>
                    <td><button type="button" className="underline" onClick={() => { setOpenId(r.id); setCreating(false); }}>{r.incidentNo}</button></td>
                    <td>{t(`aerb.rs11.incident.kind.${r.kind}`)}</td>
                    <td className="break-words">{r.affectedLabel}</td>
                    <td>{r.notifiedOn ?? (r.notifyRequired ? t(r.notifyOverdue ? "aerb.rs11.incident.aerbOverdueShort" : "aerb.rs11.incident.aerbDueShort") : "—")}</td>
                    <td>{t(`aerb.rs11.incident.stateName.${r.state}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : null}
    </section>
  );
}

/* ═══════════════════════════════════ Pregnancy declarations ═══════════════════════════════════ */

export function PregnancyView(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["aerb", "pregnancy"], queryFn: fetchPregnancy });
  const canManage = q.data?.canManage ?? false;
  const pickers = useQuery({ queryKey: ["aerb", "pickers"], queryFn: fetchAerbPickers, enabled: canManage });
  const [userId, setUserId] = useState("");
  const [declaredOn, setDeclaredOn] = useState(todayIst());
  const [expectedOn, setExpectedOn] = useState("");
  const [endReason, setEndReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const ok = (m: string): void => { setError(null); setOutcome(m); void queryClient.invalidateQueries({ queryKey: ["aerb"] }); };
  const declare = useMutation({
    mutationFn: () => declarePregnancy({ userId, declaredOn, expectedOn, remarks: null }),
    onSuccess: () => { setUserId(""); setExpectedOn(""); ok(t("aerb.rs11.pregnancy.recorded")); },
    onError: (e: unknown) => { setError(aerbErrorText(e)); },
  });
  const end = useMutation({
    mutationFn: (id: string) => endPregnancy(id, { onDate: todayIst(), reason: endReason.trim() }),
    onSuccess: () => { setEndReason(""); ok(t("aerb.rs11.pregnancy.ended")); },
    onError: (e: unknown) => { setError(aerbErrorText(e)); },
  });
  const rows = q.data?.rows ?? [];
  return (
    <section className="space-y-3" data-testid="aerb-pregnancy">
      <h3 className="font-semibold">{t("aerb.rs11.pregnancy.title")}</h3>
      <p className="text-xs text-muted-foreground">{t("aerb.rs11.pregnancy.rule", { limit: q.data?.foetalLimitMsv ?? 1 })}</p>
      {q.isError ? <Refusal testId="aerb-pregnancy-load-error" message={aerbErrorText(q.error)} /> : null}
      <Refusal testId="aerb-pregnancy-error" message={error} />
      {outcome !== null ? <p role="status" className="text-sm text-green-800" data-testid="aerb-pregnancy-outcome">{outcome}</p> : null}
      {rows.filter((r) => r.active).map((r) => (
        <div key={r.id} role="alert" className={`border p-2 text-sm ${r.overFoetalLimit ? "border-red-400" : "border-amber-400"}`} data-testid={`aerb-pregnancy-warning-${r.userId}`}>
          <b>{r.userName}</b> — {t("aerb.rs11.pregnancy.warning")}{" "}
          {t("aerb.rs11.pregnancy.dose", { msv: r.foetalDoseMsv, limit: r.foetalLimitMsv, since: r.declaredOn })}
        </div>
      ))}
      {rows.length > 0
        ? (
          <div className="overflow-x-auto">
            <table className={table}>
              <thead><tr className="text-left">
                <th>{t("aerb.rs11.pregnancy.worker")}</th><th>{t("aerb.rs11.pregnancy.declaredOn")}</th>
                <th>{t("aerb.rs11.pregnancy.expectedOn")}</th><th>{t("aerb.rs11.pregnancy.foetal")}</th><th />
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-testid={`aerb-pregnancy-${r.id}`} className={r.overFoetalLimit ? "text-red-700" : ""}>
                    <td>{r.userName}</td>
                    <td className="mo">{r.declaredOn}</td>
                    <td className="mo">{r.expectedOn}{r.lapsed ? ` · ${t("aerb.rs11.pregnancy.lapsed")}` : ""}</td>
                    <td className="mo">{r.foetalDoseMsv} / {r.foetalLimitMsv} mSv</td>
                    <td>
                      {r.endedOn !== null
                        ? `${t("aerb.rs11.pregnancy.endedOn")} ${r.endedOn}`
                        : canManage
                          ? (
                            <span className="flex flex-wrap gap-1">
                              <input className={`${input} w-32`} placeholder={t("aerb.rs11.pregnancy.endReason")} data-testid={`aerb-pregnancy-end-reason-${r.id}`} value={endReason} onChange={(e) => { setEndReason(e.target.value); }} />
                              <button type="button" className={secondary} disabled={endReason.trim() === "" || end.isPending} data-testid={`aerb-pregnancy-end-${r.id}`} onClick={() => { end.mutate(r.id); }}>
                                {t("aerb.rs11.pregnancy.end")}
                              </button>
                            </span>
                          )
                          : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : q.isSuccess ? <p className="text-sm" data-testid="aerb-pregnancy-none">{t("aerb.rs11.pregnancy.none")}</p> : null}
      {canManage
        ? (
          <div className="border p-3 space-y-2" data-testid="aerb-pregnancy-form">
            <h4 className="font-semibold text-sm">{t("aerb.rs11.pregnancy.record")}</h4>
            <div className="grid gap-3 sm:grid-cols-3">
              <Label text={t("aerb.rs11.pregnancy.worker")}>
                <select className={input} data-testid="aerb-pregnancy-user" value={userId} onChange={(e) => { setUserId(e.target.value); }}>
                  <option value="">—</option>
                  {(pickers.data?.users ?? []).map((u) => <option key={u.userId} value={u.userId}>{u.fullName}</option>)}
                </select>
              </Label>
              <Label text={t("aerb.rs11.pregnancy.declaredOn")}>
                <input className={input} type="date" data-testid="aerb-pregnancy-declared" value={declaredOn} onChange={(e) => { setDeclaredOn(e.target.value); }} />
              </Label>
              <Label text={t("aerb.rs11.pregnancy.expectedOn")}>
                <input className={input} type="date" data-testid="aerb-pregnancy-expected" value={expectedOn} onChange={(e) => { setExpectedOn(e.target.value); }} />
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">{t("aerb.rs11.pregnancy.confidential")}</p>
            <button type="button" className={primary} data-testid="aerb-pregnancy-save" disabled={userId === "" || expectedOn === "" || declare.isPending} onClick={() => { declare.mutate(); }}>
              {t("aerb.rs11.pregnancy.save")}
            </button>
          </div>
        )
        : null}
    </section>
  );
}
