import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  INCIDENT_RECORD, INCIDENT_REVIEW, MED_INCIDENT_FACTORS, MED_INCIDENT_STAGES, MED_INCIDENT_TYPES,
  addIncidentEvent, categoriesOf, fetchIncidentIndicator, fetchIncidents, incidentsCsv, isHarmCategory, recordIncident,
} from "../../lib/incidents-api";
import { newIdempotencyKey } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { downloadCsv } from "../../lib/payables-api";
import { searchPatients } from "../../lib/patients-api";
import { pharmacyErrorText } from "../../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "./sheet";
import type {
  IncidentEventBody, MedIncidentFactor, MedIncidentKind, MedIncidentStage, MedIncidentType, NccMerpCategory, WireIncident, WireIncidentMonth,
} from "../../lib/incidents-api";
import type { WirePatientHit } from "../../lib/patients-api";

/**
 * ═══ PHARMACY STAGE D2 — THE MEDICATION ERROR AND NEAR-MISS LOG (an office page under Law) ═══
 *
 * The indicator strip (errors per 1,000 dispensed lines and near misses, month by month), the log newest
 * first with each incident's state read off its events (to review, reviewed, closed; an unreviewed one at
 * NCC MERP E or above turns red after 24 hours), the record sheet, and — for a holder of
 * `pharmacy.incidents.review` — the review (root cause, action taken) and the close.
 *
 * BLAME-FREE. The reporter is drawn as the server sends it: the role for everyone, the name beside it only
 * when the server sent one (a reviewer). The CSV export carries the role alone, whoever presses it.
 *
 * Built on the office's legacy-side primitives (shadcn + the paper-and-pine palette), as D1's ADR register.
 */
const HOUR = 3_600_000;
const REVIEW_HOURS = 24;
const selectCls = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const areaCls = "min-h-20 w-full rounded-md border bg-background p-2 text-sm";

/** The incident's state as one pill: closed, reviewed, or waiting on review (red once a harmful one is past 24 h). */
export function incidentPill(r: WireIncident, t: TFunction, now: number = Date.now()): { cls: string; text: string } {
  if (r.state.closed) return { cls: "pill", text: t("pharmacyOffice.incidents.state.closed") };
  if (r.state.reviewed) return { cls: "pill on", text: t("pharmacyOffice.incidents.state.reviewed") };
  const hours = Math.max(0, Math.floor((now - Date.parse(r.createdAt)) / HOUR));
  if (isHarmCategory(r.category) && hours >= REVIEW_HOURS) return { cls: "pill rd", text: t("pharmacyOffice.incidents.state.late", { hours }) };
  return { cls: "pill gd", text: t("pharmacyOffice.incidents.state.toReview") };
}

/** Who reported it: the role always; the name only when the server sent it (a reviewer reading). */
export function reporterText(r: WireIncident, t: TFunction): string {
  return r.reporter.name === null ? r.reporter.roleTitle : t("pharmacyOffice.incidents.reporterNamed", { name: r.reporter.name, role: r.reporter.roleTitle });
}

function patientText(r: WireIncident, t: TFunction): string | null {
  const p = r.patient;
  if (p === null) return null;
  const who = p.restricted ? (p.alias ?? t("pharmacyOffice.incidents.patientHidden")) : (p.name ?? "");
  return `${who} · ${p.uhid}`;
}

export function IncidentRegisterView(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["pharmacy", "incidents"], queryFn: () => fetchIncidents() });
  const [selected, setSelected] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  const toReview = items.filter((r) => !r.state.reviewed && !r.state.closed).length;
  const first = items[0]?.id ?? null;
  useEffect(() => { if (selected === null && first !== null) setSelected(first); }, [first, selected]);
  const current = items.find((r) => r.id === selected) ?? null;

  return (
    <div className="space-y-4" data-testid="incidents-view">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{t("pharmacyOffice.incidents.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("pharmacyOffice.incidents.lead", { count: toReview })}</p>
        </div>
        {items.length > 0 && (
          <Button type="button" variant="outline" data-testid="incidents-export"
            onClick={() => downloadCsv(`medication-incidents-${new Date().toISOString().slice(0, 10)}.csv`, incidentsCsv(items))}>
            {t("pharmacyOffice.incidents.export")}
          </Button>
        )}
        {can(INCIDENT_RECORD) && <Button type="button" data-testid="incidents-record-open" onClick={() => setRecording(true)}>{t("pharmacyOffice.incidents.record")}</Button>}
      </div>
      <IndicatorStrip />
      <p className="text-xs text-muted-foreground">{t("pharmacyOffice.incidents.blameFree")}</p>
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(q.error, t)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700" data-testid="incidents-notice">{notice}</p>}
      {q.data !== undefined && items.length === 0 && <p className="text-sm text-muted-foreground" data-testid="incidents-empty">{t("pharmacyOffice.incidents.empty")}</p>}
      {items.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <ul className="divide-y rounded border" data-testid="incidents-list">
            {items.map((r) => {
              const pill = incidentPill(r, t);
              return (
                <li key={r.id}>
                  <button
                    type="button" data-testid={`incident-row-${r.no}`} aria-current={selected === r.id ? "true" : undefined}
                    className={`flex w-full flex-col gap-1 px-3 py-2 text-left ${selected === r.id ? "bg-emerald-50/60" : "hover:bg-muted/50"}`}
                    onClick={() => setSelected(r.id)}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">{r.no}</span>
                      <span className={r.kind === "error" ? "pill rd" : "pill"}>{t(`pharmacyOffice.incidents.kind.${r.kind}`)} · {r.category}</span>
                      <span className={pill.cls} data-testid={`incident-state-${r.no}`}>{pill.text}</span>
                    </span>
                    <span className="truncate text-sm font-medium">{t(`pharmacyOffice.incidents.type.${r.type}`)} · {t(`pharmacyOffice.incidents.stage.${r.stage}`)}</span>
                    <span className="truncate text-xs text-muted-foreground" data-testid={`incident-reporter-${r.no}`}>{reporterText(r, t)} · {r.createdAt.slice(0, 10)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {current !== null && <IncidentDetail r={current} canReview={can(INCIDENT_REVIEW)} />}
        </div>
      )}
      {recording && (
        <Sheet title={t("pharmacyOffice.incidents.record")} testId="incidents-record-sheet" onClose={() => setRecording(false)}>
          <IncidentRecordForm onDone={(no, id) => { setRecording(false); setSelected(id); setNotice(t("pharmacyOffice.incidents.recorded", { no })); }} />
        </Sheet>
      )}
    </div>
  );
}

/** Errors per 1,000 dispensed lines and near misses, the last six IST months, oldest first. No person on it. */
function IndicatorStrip(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["pharmacy", "incidents", "indicator"], queryFn: () => fetchIncidentIndicator(6) });
  if (q.error !== null) return <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(q.error, t)}</p>;
  const months: WireIncidentMonth[] = q.data?.months ?? [];
  return (
    <section aria-label={t("pharmacyOffice.incidents.indicator.title")} className="rounded border p-3" data-testid="incidents-indicator">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold">{t("pharmacyOffice.incidents.indicator.title")}</h3>
        <span className="text-xs text-muted-foreground">{t("pharmacyOffice.incidents.indicator.hint")}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {months.map((m) => (
          <div key={m.month} className="min-w-0 rounded bg-muted/40 px-2 py-1.5" data-testid={`indicator-${m.month}`}>
            <div className="text-xs text-muted-foreground">{m.month}</div>
            <div className="font-mono text-base font-semibold">{m.errorsPer1000 === null ? "—" : m.errorsPer1000.toFixed(2)}</div>
            <div className="truncate text-xs text-muted-foreground">
              {t("pharmacyOffice.incidents.indicator.cell", { errors: m.errors, near: m.nearMisses, lines: m.dispensedLines })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Fact({ k, v, testId }: { k: string; v: string; testId?: string }): React.ReactElement {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="truncate" data-testid={testId}>{v}</dd></div>;
}

function IncidentDetail({ r, canReview }: { r: WireIncident; canReview: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const patient = patientText(r, t);
  return (
    <section className="min-w-0 space-y-3 rounded border p-3" data-testid="incident-detail">
      <h3 className="font-semibold">{r.no} · {t(`pharmacyOffice.incidents.kind.${r.kind}`)} · {t("pharmacyOffice.incidents.category", { c: r.category })}</h3>
      <p className="whitespace-pre-wrap text-sm" data-testid="incident-what">{r.whatHappened}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <Fact k={t("pharmacyOffice.incidents.f.stage")} v={t(`pharmacyOffice.incidents.stage.${r.stage}`)} />
        <Fact k={t("pharmacyOffice.incidents.f.type")} v={t(`pharmacyOffice.incidents.type.${r.type}`)} />
        <Fact k={t("pharmacyOffice.incidents.f.factors")} v={r.factors.length === 0 ? "—" : r.factors.map((f) => t(`pharmacyOffice.incidents.factor.${f}`)).join(", ")} />
        <Fact k={t("pharmacyOffice.incidents.f.item")} v={r.item?.name ?? "—"} />
        <Fact k={t("pharmacyOffice.incidents.f.dispense")} v={r.dispenseNo === null ? "—" : `${r.dispenseNo} · ${t("pharmacyOffice.incidents.line", { n: (r.lineIdx ?? 0) + 1 })}`} />
        <Fact k={t("pharmacyOffice.incidents.f.patient")} v={patient ?? "—"} />
        <Fact k={t("pharmacyOffice.incidents.f.reporter")} v={reporterText(r, t)} testId="incident-reporter" />
        <Fact k={t("pharmacyOffice.incidents.f.recorded")} v={r.createdAt.slice(0, 16).replace("T", " ")} />
      </dl>
      {r.events.length > 0 && (
        <ol className="space-y-1 text-sm" data-testid="incident-events">
          {r.events.map((e) => (
            <li key={e.id}>
              • {e.kind === "reviewed"
                ? t("pharmacyOffice.incidents.ev.reviewed", { cause: e.rootCause ?? "", action: e.actionTaken ?? "" })
                : e.note === null ? t("pharmacyOffice.incidents.ev.closed") : t("pharmacyOffice.incidents.ev.closedNote", { note: e.note })}
              {" "}<span className="text-xs text-muted-foreground">{e.recordedByName === null ? "" : `${e.recordedByName} · `}{e.recordedAt.slice(0, 10)}</span>
            </li>
          ))}
        </ol>
      )}
      {canReview && !r.state.closed && <ReviewActions r={r} />}
    </section>
  );
}

function ReviewActions({ r }: { r: WireIncident }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [cause, setCause] = useState(r.state.rootCause ?? "");
  const [action, setAction] = useState(r.state.actionTaken ?? "");
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: (body: IncidentEventBody) => addIncidentEvent(r.id, body),
    onSuccess: async () => { setNote(""); await qc.invalidateQueries({ queryKey: ["pharmacy", "incidents"] }); },
  });
  return (
    <div className="space-y-3 border-t pt-3" data-testid="incident-actions">
      <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); m.mutate({ kind: "reviewed", rootCause: cause.trim(), actionTaken: action.trim() }); }}>
        <label className="text-sm">{t("pharmacyOffice.incidents.act.cause")}
          <textarea className={areaCls} data-testid="incident-cause" value={cause} onChange={(e) => setCause(e.target.value)} />
        </label>
        <label className="text-sm">{t("pharmacyOffice.incidents.act.action")}
          <textarea className={areaCls} data-testid="incident-action" value={action} onChange={(e) => setAction(e.target.value)} />
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" variant="outline" data-testid="incident-review-save" disabled={m.isPending || cause.trim() === "" || action.trim() === ""}>
            {r.state.reviewed ? t("pharmacyOffice.incidents.act.revise") : t("pharmacyOffice.incidents.act.review")}
          </Button>
        </div>
      </form>
      {r.state.reviewed && (
        <form className="grid items-end gap-2 sm:grid-cols-[1fr_auto]" onSubmit={(e) => { e.preventDefault(); m.mutate({ kind: "closed", note: note.trim() === "" ? null : note.trim() }); }}>
          <label className="text-sm">{t("pharmacyOffice.incidents.act.closeNote")}
            <Input data-testid="incident-close-note" autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <Button type="submit" data-testid="incident-close" disabled={m.isPending}>{t("pharmacyOffice.incidents.act.close")}</Button>
        </form>
      )}
      {m.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(m.error, t)}</p>}
    </div>
  );
}

/** What a caller already knows about the incident — the desk's line, when it is recorded from there. */
export type IncidentPrefill = {
  dispenseLine?: { dispenseId: string; lineIdx: number };
  itemId?: string | null;
  patientId?: string | null;
  /** How the prefilled context reads on the sheet ("Crocin 500 · line 2 · Asha Devi"). */
  summary?: string;
  kind?: MedIncidentKind;
  stage?: MedIncidentStage;
};

export function IncidentRecordForm({ prefill, onDone }: { prefill?: IncidentPrefill; onDone: (no: string, id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [key] = useState(() => newIdempotencyKey());
  const [kind, setKind] = useState<MedIncidentKind>(prefill?.kind ?? "near_miss");
  const [category, setCategory] = useState<NccMerpCategory>(kind === "near_miss" ? "B" : "C");
  const [stage, setStage] = useState<MedIncidentStage>(prefill?.stage ?? "dispensing");
  const [type, setType] = useState<MedIncidentType>("wrong_drug");
  const [factors, setFactors] = useState<MedIncidentFactor[]>([]);
  const [what, setWhat] = useState("");
  const [patientQ, setPatientQ] = useState("");
  const [hits, setHits] = useState<WirePatientHit[]>([]);
  const [patient, setPatient] = useState<WirePatientHit | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  const fromLine = prefill?.dispenseLine !== undefined;

  const pickKind = (k: MedIncidentKind): void => { setKind(k); setCategory(k === "near_miss" ? "B" : "C"); };
  const toggle = (f: MedIncidentFactor): void => setFactors((xs) => (xs.includes(f) ? xs.filter((x) => x !== f) : [...xs, f]));
  const findPatient = async (): Promise<void> => {
    if (patientQ.trim().length < 2) return;
    setFindError(null);
    try { setHits(await searchPatients(patientQ.trim(), 6)); } catch (e) { setHits([]); setFindError(pharmacyErrorText(e, t)); }
  };

  const m = useMutation({
    mutationFn: () => recordIncident({
      kind, category, stage, type, factors, whatHappened: what.trim(),
      ...(fromLine ? { dispenseLine: prefill!.dispenseLine! } : {}),
      ...(prefill?.itemId ? { itemId: prefill.itemId } : {}),
      ...(prefill?.patientId ? { patientId: prefill.patientId } : patient !== null ? { patientId: patient.id } : {}),
    }, key),
    onSuccess: async (out) => { await qc.invalidateQueries({ queryKey: ["pharmacy", "incidents"] }); onDone(out.no, out.incidentId); },
  });
  const ready = what.trim() !== "";

  return (
    <form className="space-y-4" data-testid="incident-record-form" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      {prefill?.summary !== undefined && <p className="rounded bg-muted/40 px-3 py-2 text-sm" data-testid="incident-prefill">{prefill.summary}</p>}
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">{t("pharmacyOffice.incidents.form.kind")}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(["near_miss", "error"] as const).map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input type="radio" name="incident-kind" data-testid={`incident-kind-${k}`} checked={kind === k} onChange={() => pickKind(k)} />
              {t(`pharmacyOffice.incidents.kindHint.${k}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="text-sm">{t("pharmacyOffice.incidents.f.category")}
          <select className={selectCls} data-testid="incident-category" value={category} onChange={(e) => setCategory(e.target.value as NccMerpCategory)}>
            {categoriesOf(kind).map((c) => <option key={c} value={c}>{t(`pharmacyOffice.incidents.merp.${c}`)}</option>)}
          </select>
        </label>
        <label className="text-sm">{t("pharmacyOffice.incidents.f.stage")}
          <select className={selectCls} data-testid="incident-stage" value={stage} onChange={(e) => setStage(e.target.value as MedIncidentStage)}>
            {MED_INCIDENT_STAGES.map((s) => <option key={s} value={s}>{t(`pharmacyOffice.incidents.stage.${s}`)}</option>)}
          </select>
        </label>
        <label className="text-sm">{t("pharmacyOffice.incidents.f.type")}
          <select className={selectCls} data-testid="incident-type" value={type} onChange={(e) => setType(e.target.value as MedIncidentType)}>
            {MED_INCIDENT_TYPES.map((x) => <option key={x} value={x}>{t(`pharmacyOffice.incidents.type.${x}`)}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-sm font-semibold">{t("pharmacyOffice.incidents.f.factors")}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {MED_INCIDENT_FACTORS.map((f) => (
            <label key={f} className="flex items-center gap-2">
              <input type="checkbox" data-testid={`incident-factor-${f}`} checked={factors.includes(f)} onChange={() => toggle(f)} />
              {t(`pharmacyOffice.incidents.factor.${f}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm">{t("pharmacyOffice.incidents.form.what")}
        <textarea className={areaCls} data-testid="incident-what-text" value={what} onChange={(e) => setWhat(e.target.value)} />
      </label>
      {!fromLine && prefill?.patientId == null && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">{t("pharmacyOffice.incidents.form.patient")}</legend>
          {patient === null ? (
            <>
              <div className="flex gap-2">
                <Input data-testid="incident-patient-q" autoComplete="off" placeholder={t("pharmacyOffice.incidents.form.patientFind")} value={patientQ}
                  onChange={(e) => setPatientQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void findPatient(); } }} />
                <Button type="button" variant="outline" data-testid="incident-patient-find" onClick={() => void findPatient()}>{t("pharmacyOffice.incidents.form.find")}</Button>
              </div>
              {findError !== null && <p role="alert" className="text-sm text-red-600">{findError}</p>}
              <ul className="divide-y rounded border empty:hidden">
                {hits.map((h) => (
                  <li key={h.id}><button type="button" data-testid={`incident-patient-${h.uhid}`} className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50" onClick={() => setPatient(h)}>{h.name} · {h.uhid}</button></li>
                ))}
              </ul>
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm" data-testid="incident-patient-picked">
              <span className="font-medium">{patient.name} · {patient.uhid}</span>
              <button type="button" className="text-xs underline" onClick={() => setPatient(null)}>{t("pharmacyOffice.incidents.form.change")}</button>
            </div>
          )}
        </fieldset>
      )}
      {m.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(m.error, t)}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" data-testid="incident-record-save" disabled={!ready || m.isPending}>{t("pharmacyOffice.incidents.form.save")}</Button>
        <span className="text-xs text-muted-foreground">{t("pharmacyOffice.incidents.form.saveHint")}</span>
      </div>
    </form>
  );
}
