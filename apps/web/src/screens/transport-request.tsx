import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { taskRefusal } from "../lib/tasks-api";
import { fetchTransportPatients, fetchTransportPlaces, requestTransportApi } from "../lib/transport-api";
import { refusalText } from "./transport-card";
import type { RequestTransportInput, TransportPatientOption } from "@hmis/contracts";
import "./tasks.css";
import "./transport.css";

/**
 * ═══ E1.6 TRANSPORT (issue #723) — THE REQUEST SHEET (390 px phone, 1366 desk) ═══
 *
 * One sheet: what (patient move, sample run, document run), who (an admitted patient: their bed is the FROM place),
 * where to (a ward, room or theatre, or typed), how (mode, oxygen, monitor, isolation) and whether a nurse or doctor
 * escort goes. A patient in an ICU, HDU, NICU or PICU bed is shown "Escort required" — the server forces it anyway.
 * The answer says in a few words whether the request was new or joined an earlier one.
 */
const KINDS = ["patient_move", "sample_run", "document_run"] as const;
const MODES = ["wheelchair", "stretcher", "bed", "walking"] as const;
const ISOLATION = ["none", "contact", "droplet", "airborne"] as const;
const REASONS = ["admit", "transfer", "imaging", "ot", "discharge", "other"] as const;
const PRIORITIES = ["routine", "urgent", "stat"] as const;

function Chips<V extends string>({ name, values, value, label, onPick }: {
  name: string; values: readonly V[]; value: V; label: (v: V) => string; onPick: (v: V) => void;
}): React.ReactElement {
  return (
    <div className="trq-chips" role="radiogroup" aria-label={name}>
      {values.map((v) => (
        <button key={v} type="button" role="radio" aria-checked={v === value} className={v === value ? "trq-chip on" : "trq-chip"}
          onClick={() => onPick(v)} data-testid={`${name}-${v}`}>{label(v)}</button>
      ))}
    </div>
  );
}

export function TransportRequest(): React.ReactElement {
  const { t } = useTranslation();
  const [kind, setKind] = useState<(typeof KINDS)[number]>("patient_move");
  const [q, setQ] = useState("");
  const [patient, setPatient] = useState<TransportPatientOption | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [toNote, setToNote] = useState("");
  const [mode, setMode] = useState<(typeof MODES)[number]>("wheelchair");
  const [oxygen, setOxygen] = useState(false);
  const [monitor, setMonitor] = useState(false);
  const [isolation, setIsolation] = useState<(typeof ISOLATION)[number]>("none");
  const [escort, setEscort] = useState(false);
  const [highRisk, setHighRisk] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("transfer");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("routine");
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState<{ ok: boolean; text: string } | null>(null);
  const isMove = kind === "patient_move";
  const patients = useQuery({ queryKey: ["transport", "patients", q], queryFn: () => fetchTransportPatients(q), enabled: isMove && patient === null });
  const places = useQuery({ queryKey: ["transport", "places"], queryFn: fetchTransportPlaces, staleTime: 300_000 });
  const send = useMutation({
    mutationFn: (body: RequestTransportInput) => requestTransportApi(body),
    onSuccess: (a) => setAnswer({ ok: true, text: a.merged ? t("transport.req.merged") : a.escortRequired ? t("transport.req.sentEscort") : t("transport.req.sent") }),
    onError: (e) => setAnswer({ ok: false, text: refusalText(taskRefusal(e), t) }),
  });
  const critical = patient?.criticalCare === true;
  const submit = (): void => {
    setAnswer(null);
    send.mutate({
      kind,
      ...(isMove && patient !== null ? { admissionId: patient.admissionId } : {}),
      ...(from !== "" ? { fromResourceId: from } : {}),
      ...(to !== "" ? { toResourceId: to } : toNote.trim() !== "" ? { toNote: toNote.trim() } : {}),
      ...(isMove ? { mode, oxygen, monitor, isolation, escortRequired: escort, highRisk, reason } : {}),
      priority,
      ...(note.trim() !== "" ? { note: note.trim() } : {}),
    });
  };
  const placeList = places.data ?? [];

  return (
    <PaperScreen testId="transport-request">
      <form className="trq" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="trq-head">
          <h1>{t("transport.req.title")}</h1>
          <Chips name="kind" values={KINDS} value={kind} label={(v) => t(`tasks.kind.${v}`)} onPick={(v) => { setKind(v); setAnswer(null); }} />
        </div>
        <div className="trq-cols">
          <section className="box trq-sec">
            {isMove ? (
              <>
                <h2>{t("transport.req.patient")}</h2>
                {patient === null ? (
                  <>
                    <input className="trq-in" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("transport.req.findPatient")} data-testid="patient-search" />
                    <div className="trq-list">
                      {(patients.data ?? []).slice(0, 6).map((p) => (
                        <button key={p.admissionId} type="button" className="trq-pt" onClick={() => setPatient(p)} data-testid={`patient-${p.admissionId}`}>
                          <b>{p.name}</b>
                          <span>{[p.admissionNo, p.bedName].filter(Boolean).join(" · ")}</span>
                          {p.criticalCare && <span className="pill rd">{t("transport.req.critical")}</span>}
                        </button>
                      ))}
                      {patients.data !== undefined && patients.data.length === 0 && <span className="tk-empty">{t("transport.req.noPatient")}</span>}
                    </div>
                  </>
                ) : (
                  <div className="trq-pt on" data-testid="patient-picked">
                    <b>{patient.name}</b>
                    <span>{[patient.admissionNo, patient.bedName].filter(Boolean).join(" · ")}</span>
                    <button type="button" className="trq-link" onClick={() => setPatient(null)}>{t("transport.req.change")}</button>
                  </div>
                )}
                {critical && <p className="trq-warn" data-testid="escort-forced">{t("transport.req.escortForced")}</p>}
              </>
            ) : (
              <>
                <h2>{t("transport.req.from")}</h2>
                <select className="trq-in" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="from-place">
                  <option value="">{t("transport.req.pick")}</option>
                  {placeList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </>
            )}
            <h2>{t("transport.req.to")}</h2>
            <select className="trq-in" value={to} onChange={(e) => setTo(e.target.value)} data-testid="to-place">
              <option value="">{t("transport.req.pick")}</option>
              {placeList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {to === "" && (
              <input className="trq-in" value={toNote} onChange={(e) => setToNote(e.target.value)} maxLength={120}
                placeholder={t("transport.req.toNote")} data-testid="to-note" />
            )}
            {isMove && (
              <>
                <h2>{t("transport.req.reason")}</h2>
                <Chips name="reason" values={REASONS} value={reason} label={(v) => t(`transport.reason.${v}`)} onPick={setReason} />
              </>
            )}
          </section>
          <section className="box trq-sec">
            {isMove && (
              <>
                <h2>{t("transport.req.how")}</h2>
                <Chips name="mode" values={MODES} value={mode} label={(v) => t(`transport.mode.${v}`)} onPick={setMode} />
                <div className="trq-toggles">
                  <label className="trq-tog"><input type="checkbox" checked={oxygen} onChange={(e) => setOxygen(e.target.checked)} data-testid="oxygen" />{t("transport.req.oxygen")}</label>
                  <label className="trq-tog"><input type="checkbox" checked={monitor} onChange={(e) => setMonitor(e.target.checked)} />{t("transport.monitor")}</label>
                </div>
                <h2>{t("transport.req.isolation")}</h2>
                <Chips name="isolation" values={ISOLATION} value={isolation} label={(v) => t(`transport.isolation.${v}`)} onPick={setIsolation} />
                <h2>{t("transport.req.escort")}</h2>
                <div className="trq-toggles">
                  <label className="trq-tog"><input type="checkbox" checked={escort || critical} disabled={critical} onChange={(e) => setEscort(e.target.checked)} data-testid="escort" />{t("transport.req.escortNeeded")}</label>
                  <label className="trq-tog"><input type="checkbox" checked={highRisk} onChange={(e) => setHighRisk(e.target.checked)} data-testid="high-risk" />{t("transport.req.highRisk")}</label>
                </div>
              </>
            )}
            <h2>{t("transport.req.priority")}</h2>
            <Chips name="priority" values={PRIORITIES} value={priority} label={(v) => t(`transport.priority.${v}`)} onPick={setPriority} />
            <input className="trq-in" value={note} onChange={(e) => setNote(e.target.value)} maxLength={280} placeholder={t("transport.req.note")} />
            {answer !== null && <p role={answer.ok ? "status" : "alert"} className={answer.ok ? "trq-ok" : "tk-notice"} data-testid="request-answer">{answer.text}</p>}
            <button type="submit" className="tk-act" disabled={send.isPending || (isMove && patient === null)} data-testid="request-send">
              {t("transport.req.send")}
            </button>
          </section>
        </div>
      </form>
    </PaperScreen>
  );
}
