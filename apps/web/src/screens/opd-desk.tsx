import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { listDepartments, opdErrorMessage, todayIst } from "../lib/opd-api";
import { useDoctorLabel } from "../lib/use-doctor-label";
import type { WireDepartment, WireDoctorSummary, WireQueueEntryView, WireQueueView } from "../lib/opd-api";
import { useRealtime } from "../lib/realtime";
import { PatientPhoto } from "../components/patient-photo";
import { StationShell } from "../components/station/station-shell";
import type { StationLink } from "../components/station/station-shell";
import "./opd-desk.css";
import { CreditChip } from "../components/patient-credit";

/**
 * The OPD desk (§11.1 / D2 / D3) — THE QUEUE DESK of the OPD floor: the live doctor board, the picked
 * doctor's line in priority order, abandon-with-reason and the supervisor's E2 bulk queue transfer.
 *
 * ═══ UX-AUDIT 2026-09-28 — IT STOPPED BEING A SECOND REGISTRATION DESK ═══
 *
 * A Chromium audit against the boards found three equal columns, the patient drawn three times, the
 * queue's Actions column cut off, payer and referral asked before the doctor, and two competing ways
 * to choose a doctor. The larger finding was underneath: everything that screen did to OPEN a visit
 * (search, arrivals check-in, payer/referral, the token slip, the billing hand-off) Desk One already
 * does, and the owner ruled at FD-9 that the front desk is ONE screen — "keep the new design not the
 * old one". What nothing else in the product does is below the line: one doctor's live queue, now
 * serving, the fee stamp per token, the bay's class-0 flash, abandon, and the consented transfer.
 * `docs/superpowers/decisions/2026-09-28-opd-desk.md` records the comparison and the DECIDED call.
 *
 * So this is the floor coordinator's screen, in the owner's counter layout (2026-09-25) through the
 * station shell: LEFT the token in hand, or the floor's day; CENTRE one numbered flow — department,
 * doctor, act — over a pinned bar offering the single next act; RIGHT the chosen doctor's line in the
 * server's priority order with a source chip on each row, then "Clocks running", folded. Opening a
 * visit is one header link away, at Desk One.
 *
 * Three standing rules shape this file, unchanged by the rebuild:
 *  · THE SERVER IS AUTHORITATIVE. No response status is branched on beyond `api()`'s 2xx/non-2xx
 *    split, and NO client-side permission model exists: Transfer is rendered unconditionally and a
 *    403 is rendered inline where the clerk can read it.
 *  · Every read is BOTH polled (15 s) AND realtime-subscribed (D6) — the push is a hint, so a missed
 *    frame costs seconds, never correctness.
 *  · A refusal the client can know (K44 consent, K45 reason) stops the REQUEST, not just the button.
 */
const POLL_MS = 15_000;
/** DECIDED (decision doc): the OPD waiting-time target; past it the clocks raise themselves. */
const WAIT_TARGET_MIN = 60;

function patientLabel(p: { name: string | null; alias: string | null; restricted: boolean } | null | undefined): string {
  if (!p) return "—";
  return p.restricted ? (p.alias ?? "—") : (p.name ?? "—");
}

function sexAge(gender: string | undefined, dob: string | null | undefined, now: number): string {
  const g = gender === "female" ? "F" : gender === "male" ? "M" : "";
  if (dob === null || dob === undefined) return g;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return g;
  const years = Math.floor((now - d.getTime()) / (365.25 * 24 * 3600 * 1000));
  return `${String(years)} ${g}`.trim();
}

function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
}

/** The Routing board's bar: fill by line length, ink by how heavy it is (6+ red, 3+ gold). */
function barOf(waiting: number): { pct: string; ink: string } {
  return {
    pct: `${String(Math.min(100, waiting * 14))}%`,
    ink: waiting >= 6 ? "var(--red)" : waiting >= 3 ? "var(--gold)" : "var(--green)",
  };
}

function dotOf(s: WireDoctorSummary): string {
  if (s.onLeaveToday) return "var(--red)";
  if (s.status === "in") return "var(--green)";
  if (s.status === "out") return "var(--gold)";
  return "var(--faint)";
}

const CLASS_INK: Record<number, string> = { 0: "var(--red)", 1: "var(--green)", 2: "var(--gold)", 3: "var(--dim)", 4: "var(--faint)" };

/** OPD's screens, for the header's switch. Each is shown only to a person who may open it. */
const OPD_STATIONS: readonly (Omit<StationLink, "label"> & { labelKey: string })[] = [
  { key: "desk", to: "/opd/desk", labelKey: "nav.opdDesk", permission: "opd.visits.open" },
  { key: "counter", to: "/counter", labelKey: "nav.counterDesk", permission: "patients.register" },
  { key: "appointments", to: "/opd/appointments", labelKey: "nav.opdAppointments", permission: "opd.appointments.read" },
  { key: "display", to: "/opd/display", labelKey: "nav.opdDisplay", permission: "opd.display.read" },
];

type Act = null | "abandon" | "transfer";

export function OpdDesk(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const router = useRouter({ warn: false });
  const today = todayIst();
  // 2026-10-04 (owner) — the unit (or "Guest Faculty") beside each doctor's name.
  const doctorLabel = useDoctorLabel(today);
  const now = Date.now();

  const [departmentId, setDepartmentId] = useState("");
  const [selectedDoctorId, setSelectedDoctorId] = useState("");
  /** The token in hand — ONE place the patient is drawn (the lane); the list row only highlights. */
  const [inHandId, setInHandId] = useState<string | null>(null);
  const [act, setAct] = useState<Act>(null);
  const [reason, setReason] = useState("");
  const [toDoctorId, setToDoctorId] = useState("");
  const [consented, setConsented] = useState(false);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<number | null>(null);
  /* Below 1280px the list is a drawer: choosing a doctor opens it, taking a token closes it. */
  const [listRequest, setListRequest] = useState<{ open: boolean; seq: number }>({ open: false, seq: 0 });
  /**
   * VD-2 T3 — THE FLASH. `queue.escalated` rides the doctor's own queue topic (VD-1 T5): the bay
   * bumped somebody to class 0 and this board learns it in the same breath. The re-read below
   * repaints the row; the flash is the part a person mid-task actually sees. A cancel clears it — a
   * board that flashed and went quiet would leave the doctor expecting a patient nobody is sending.
   */
  const [flash, setFlash] = useState<{ tokenNo: number; cancelled: boolean } | null>(null);
  useEffect(() => { setFlash(null); }, [selectedDoctorId]); // Dr Rao's flash does not follow the picker to Dr Toppo's board

  const departments = useQuery({ queryKey: ["opd", "departments"], queryFn: listDepartments, refetchInterval: POLL_MS });
  const summary = useQuery({
    queryKey: ["opd", "queues", "summary", departmentId, today],
    queryFn: () => api<{ items: WireDoctorSummary[] }>(
      "GET", `/opd/queues/summary?departmentId=${departmentId}&serviceDate=${today}`,
    ),
    enabled: departmentId !== "",
    refetchInterval: POLL_MS,
  });
  const queue = useQuery({
    queryKey: ["opd", "queue", selectedDoctorId, today],
    queryFn: () => api<WireQueueView | { session: null }>(
      "GET", `/opd/queues?doctorId=${selectedDoctorId}&serviceDate=${today}`,
    ),
    enabled: selectedDoctorId !== "",
    refetchInterval: POLL_MS,
  });

  // D6: a frame on the picked doctor's topic is a HINT to re-read. Correctness rides the poll above.
  useRealtime(selectedDoctorId === "" ? [] : [`queue:${selectedDoctorId}:${today}`], (f) => {
    if (f.name === "queue.escalated" || f.name === "queue.escalation_cancelled") {
      const tokenNo = (f.payload as { tokenNo?: unknown } | null)?.tokenNo;
      if (typeof tokenNo === "number") setFlash({ tokenNo, cancelled: f.name === "queue.escalation_cancelled" });
    }
    void queryClient.invalidateQueries({ queryKey: ["opd", "queue", selectedDoctorId, today] });
    void queryClient.invalidateQueries({ queryKey: ["opd", "queues", "summary"] });
  });

  const departmentItems: WireDepartment[] = departments.data?.items ?? [];
  const summaryItems: WireDoctorSummary[] = summary.data?.items ?? [];
  const department = departmentItems.find((d) => d.id === departmentId) ?? null;
  const doctorRow = summaryItems.find((s) => s.doctor.id === selectedDoctorId) ?? null;
  const doctorNameOf = (id: string): string => summaryItems.find((s) => s.doctor.id === id)?.doctor.displayName ?? "";
  const queueView: WireQueueView | null =
    queue.data !== undefined && queue.data.session !== null ? queue.data : null;
  const orderedEntries = queueView?.ordered ?? [];
  const inHand = orderedEntries.find((e) => e.id === inHandId) ?? null;

  const clearAct = (): void => {
    setAct(null); setReason(""); setToDoctorId(""); setConsented(false); setEntryIds([]); setError(null); setMoved(null);
  };
  const putDown = (): void => { setInHandId(null); clearAct(); };

  /* Esc puts the token down — the lane's promise, the same key every counter uses. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setInHandId(null); setAct(null); setReason(""); setError(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* Through the router when there is one (the app), a plain link when there is not (this suite). */
  const toDeskOne = (e: React.MouseEvent): void => {
    if (router === undefined) return;
    e.preventDefault();
    void router.navigate({ to: "/counter" });
  };

  const pickDoctor = (id: string): void => {
    setSelectedDoctorId(id);
    setInHandId(null);
    clearAct();
    if (id !== "") setListRequest((r) => ({ open: true, seq: r.seq + 1 }));
  };
  const take = (e: WireQueueEntryView): void => {
    setInHandId(e.id);
    clearAct();
    setListRequest((r) => ({ open: false, seq: r.seq + 1 }));
  };
  const startTransfer = (ids: string[]): void => {
    clearAct();
    setAct("transfer");
    setEntryIds(ids);
  };

  // ——— abandon: the reason is the rule (K45), mirrored from the server's `reason_required` ———
  const submitAbandon = async (): Promise<void> => {
    if (inHand === null) return;
    // K45. This guard is the ONLY thing standing between an empty reason and a request: the button
    // is deliberately NOT disabled, so "no request was sent" can mean exactly one thing.
    if (reason.trim() === "") {
      setError(t("opdDesk.reasonRequired"));
      return;
    }
    setError(null);
    try {
      await api("POST", `/opd/visits/${inHand.encounter.id}/abandon`, { reason: reason.trim() });
      putDown();
      await queryClient.invalidateQueries({ queryKey: ["opd", "queue"] });
      await queryClient.invalidateQueries({ queryKey: ["opd", "queues", "summary"] });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  };

  // ——— the E2 bulk transfer: §11.1 says consent, so consent is a precondition of the REQUEST (K44) ———
  const submitTransfer = async (): Promise<void> => {
    // K44. Consent gates the REQUEST, not just the message: without the tick nothing leaves the
    // browser. As with abandon the button is not disabled, so the refusal has a single cause.
    if (!consented) {
      setError(t("opdDesk.consentRequired"));
      return;
    }
    if (selectedDoctorId === "" || toDoctorId === "") {
      setError(t("opdDesk.pickDoctorFirst"));
      return;
    }
    setError(null);
    setMoved(null);
    try {
      const res = await api<{ transferred: number; toSessionId: string }>("POST", "/opd/queues/transfer", {
        fromDoctorId: selectedDoctorId,
        toDoctorId,
        serviceDate: today,
        ...(entryIds.length > 0 ? { entryIds } : {}),
        consented: true,
        reason,
      });
      setMoved(res.transferred);
      setInHandId(null);
      await queryClient.invalidateQueries({ queryKey: ["opd", "queue"] });
      await queryClient.invalidateQueries({ queryKey: ["opd", "queues", "summary"] });
    } catch (e) {
      // A 403 from `opd.queue.transfer` lands here like any other refusal and is READ BY THE CLERK.
      setError(opdErrorMessage(e));
    }
  };

  /* ══════════ the floor's day — the lane while nobody is in hand ══════════ */
  const waitingTotal = summaryItems.reduce((n, s) => n + s.waitingCount, 0);
  const sessionsOpen = summaryItems.filter((s) => s.status === "in" || s.status === "out").length;
  const onLeave = summaryItems.filter((s) => s.onLeaveToday).length;
  const stats = departmentId === "" ? [] : [
    { label: t("opdDesk.statWaiting"), value: waitingTotal, tone: waitingTotal > 0 ? "waiting" as const : "plain" as const },
    { label: t("opdDesk.statSessions"), value: `${String(sessionsOpen)} / ${String(summaryItems.length)}`, tone: "live" as const },
    { label: t("opdDesk.statOnLeave"), value: onLeave, tone: onLeave > 0 ? "danger" as const : "plain" as const },
  ];

  /* ══════════ the clocks: what is running out in the chosen doctor's line ══════════ */
  const longest = orderedEntries.reduce((m, e) => Math.max(m, minutesSince(e.createdAt, now)), 0);
  const over = longest > WAIT_TARGET_MIN;
  const held = queueView?.heldForPayment?.length ?? queueView?.counts.heldForPayment ?? 0;

  const lane = inHand !== null ? (
    <section className="od-hand" data-testid="in-hand" aria-label={t("opdDesk.inHand")}>
      <span className="tag">{t("opdDesk.inHand")}</span>
      <div className="od-hand-top">
        {inHand.patient !== null && !inHand.patient.restricted
          ? <PatientPhoto patientId={inHand.patient.id} className="h-14 w-11 rounded" />
          : null}
        <div style={{ minWidth: 0 }}>
          <div className="od-hand-tok">{inHand.tokenNo}</div>
          <div className="od-hand-n">{patientLabel(inHand.patient)}</div>
          <div className="od-hand-u">
            {inHand.patient?.uhid ?? "—"} · {sexAge(inHand.patient?.administrativeGender, inHand.patient?.dob, now)}
          </div>
          <CreditChip patientId={inHand.patient?.id ?? null} testId="opd-credit" />
        </div>
      </div>
      <div className="od-hand-chips">
        {inHand.queueClass !== null && (
          <span className="od-chip" data-class={inHand.queueClass}>{t(`opd.queueClass.${inHand.queueClass}`)}</span>
        )}
        {inHand.feeStatus !== null && (
          <span className="od-stamp" data-fee={inHand.feeStatus}>{t(`opd.feeStatus.${inHand.feeStatus}`)}</span>
        )}
      </div>
      <ul className="od-hand-rows">
        <li><span>{t("opd.labels.doctor")}</span><b>{doctorRow?.doctor.displayName ?? "—"}</b></li>
        <li><span>{t("opd.labels.room")}</span><b className="mo">{doctorRow?.roomCode ?? "—"}</b></li>
        <li><span>{t("opd.labels.status")}</span><b>{t(`opd.queueStatus.${inHand.status}`)}</b></li>
        <li><span>{t("opdDesk.inLine")}</span><b className="mo">#{inHand.position ?? "—"}</b></li>
        <li><span>{t("opdDesk.waited")}</span><b className="mo">{t("opdDesk.minutes", { n: minutesSince(inHand.createdAt, now) })}</b></li>
      </ul>
      <button type="button" className="od-sec" style={{ marginTop: 14 }} onClick={putDown}>
        {t("opdDesk.putDown")} <span className="kb">Esc</span>
      </button>
    </section>
  ) : (
    <section className="od-hand" data-testid="in-hand-empty">
      <span className="tag">{t("opdDesk.inHand")}</span>
      <p className="od-hint" style={{ marginTop: 8 }}>{t("opdDesk.nobodyInHand")}</p>
      <a className="od-link" href="/counter" data-testid="open-visit-desk-one" onClick={toDeskOne}>{t("opdDesk.openVisitAtDeskOne")} →</a>
    </section>
  );

  /* ══════════ the right column: the chosen doctor's line, in the server's order ══════════ */
  const list = (
    <>
      {flash !== null && (
        <p role="status" className="od-flash" data-testid="escalation-flash" data-cancelled={flash.cancelled ? "true" : "false"}>
          {t(flash.cancelled ? "opdDesk.escalationCancelled" : "opdDesk.escalationFlash", { tokenNo: flash.tokenNo })}
          <button type="button" onClick={() => setFlash(null)}>{t("opdDesk.flashDismiss")}</button>
        </p>
      )}
      <section className="od-lh" data-testid="queue-head">
        <div className="od-lh-top">
          <span className="od-lh-t">
            {doctorRow === null ? t("opdDesk.queue") : doctorRow.doctor.displayName}
            {doctorRow !== null && (() => { const tag = doctorLabel(doctorRow.doctor); return tag === null ? null : <span className="od-dtag"> · {tag}</span>; })()}
          </span>
          <span className="od-live"><i />{t("opdDesk.live")}</span>
        </div>
        {doctorRow !== null && (
          <div className="od-lh-s">
            {t("opd.labels.room")} {doctorRow.roomCode ?? "—"} · {t(`opd.sessionStatus.${doctorRow.status}`)}
            {doctorRow.nowServing !== null && <> · {t("opdDesk.nowServing")} #{doctorRow.nowServing}</>}
          </div>
        )}
        {queueView !== null && (
          <div className="od-big">
            <b>{orderedEntries.length}</b>
            <span>{t("opdDesk.inLineNow")}</span>
          </div>
        )}
      </section>
      {selectedDoctorId === "" && <p className="od-empty">{t("opdDesk.pickDoctorHint")}</p>}
      {selectedDoctorId !== "" && queue.data !== undefined && queueView === null && (
        <p className="od-empty">{t("opdDesk.noSession")}</p>
      )}
      {queueView !== null && orderedEntries.length === 0 && <p className="od-empty">{t("opdDesk.emptyQueue")}</p>}
      {orderedEntries.length > 0 && (
        <div className="od-list" data-testid="queue-list">
          {orderedEntries.map((e) => (
            <button
              key={e.id}
              type="button"
              className="od-qrow"
              data-testid={`queue-row-${e.id}`}
              data-class={e.queueClass ?? undefined}
              aria-pressed={e.id === inHandId}
              onClick={() => take(e)}
            >
              <span className="od-tok">{e.tokenNo}</span>
              <span className="od-qb">
                <span className="od-qn">{patientLabel(e.patient)}</span>
                <span className="od-qm">
                  <span>{sexAge(e.patient?.administrativeGender, e.patient?.dob, now)}</span>
                  {e.queueClass !== null && (
                    <span className="od-chip" data-class={e.queueClass}>{t(`opd.queueClass.${e.queueClass}`)}</span>
                  )}
                  {e.status !== "waiting" && <span>· {t(`opd.queueStatus.${e.status}`)}</span>}
                </span>
              </span>
              <span className="od-qr">
                {/*
                  RC-4 T3 / D7 — THE PAID STAMP. `null` IS RENDERED AS NOTHING, deliberately: it means
                  the server declined to characterise this encounter's fee, which is NOT "unpaid".
                  `free` keeps its own stamp so a ₹0 review visit is not read as a paid one.
                */}
                {e.feeStatus !== null && (
                  <span className="od-stamp" data-fee={e.feeStatus} data-testid={`fee-status-${e.id}`}>
                    {t(`opd.feeStatus.${e.feeStatus}`)}
                  </span>
                )}
                <span className="od-qw">{t("opdDesk.minutes", { n: minutesSince(e.createdAt, now) })}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );

  const clocks = (
    <div data-testid="clocks">
      <div className="od-clk"><span>{t("opdDesk.clockLongest")}</span><b data-over={over ? "true" : "false"}>{t("opdDesk.minutes", { n: longest })}</b></div>
      <div className="od-clk"><span>{t("opdDesk.clockVitals")}</span><b>{queueView?.waitingVitals ?? 0}</b></div>
      <div className="od-clk"><span>{t("opdDesk.clockHeld")}</span><b>{held}</b></div>
      <div className="od-clk"><span>{t("opdDesk.clockLeft")}</span><b>{queueView?.counts.left ?? 0}</b></div>
    </div>
  );

  /* ══════════ the pinned bar: ONE next act, named by where the flow stands ══════════ */
  const strandedLeave = doctorRow !== null && doctorRow.onLeaveToday && doctorRow.waitingCount > 0;
  let barSentence: React.ReactNode;
  let primary: React.ReactNode = null;
  if (act === "abandon" && inHand !== null) {
    barSentence = <>{t("opdDesk.barAbandon", { tokenNo: inHand.tokenNo })}</>;
    primary = <button type="button" className="od-pri danger" onClick={() => void submitAbandon()}>{t("opdDesk.confirmAbandon")}</button>;
  } else if (act === "transfer") {
    barSentence = <>{t("opdDesk.barTransfer", { from: doctorRow?.doctor.displayName ?? "—" })}</>;
    primary = <button type="button" className="od-pri" onClick={() => void submitTransfer()}>{t("opdDesk.confirmTransfer")}</button>;
  } else if (departmentId === "") {
    barSentence = t("opdDesk.pickDepartmentHint");
  } else if (selectedDoctorId === "") {
    barSentence = t("opdDesk.barPickDoctor");
  } else if (inHand !== null) {
    barSentence = <>{t("opdDesk.barInHand", { tokenNo: inHand.tokenNo })}</>;
  } else {
    barSentence = strandedLeave
      ? t("opdDesk.onLeaveWithWaiting", { count: doctorRow?.waitingCount ?? 0 })
      : t("opdDesk.barPickToken");
  }
  /*
    K44 — "Transfer queue" is rendered ONCE and ALWAYS, before any department, doctor or role is
    known: the desk holds no permission model. It is the primary act when a doctor on leave still
    has people waiting, and a secondary one otherwise.
  */
  const transferIsNext = act === null && strandedLeave && inHand === null;
  const transferButton = act === "transfer" ? null : (
    <button
      type="button"
      className={transferIsNext ? "od-pri" : "od-sec"}
      data-testid="transfer-queue"
      onClick={() => startTransfer([])}
    >
      {t("opdDesk.transfer")}
    </button>
  );

  return (
    <StationShell
      seat="opd-desk"
      listRequest={listRequest}
      brand={t("opdDesk.brand")}
      stations={OPD_STATIONS.map((s) => ({ key: s.key, to: s.to, permission: s.permission, label: t(s.labelKey) }))}
      current="desk"
      title={t("opdDesk.title")}
      place={department === null ? t("opdDesk.place") : `${department.name} · ${today}`}
      stats={stats}
      statsLabel={t("opdDesk.statsLabel")}
      lane={lane}
      list={list}
      clocks={clocks}
      clocksSummary={selectedDoctorId === "" ? t("opdDesk.clocksIdle") : t("opdDesk.clocksSummary", { n: longest, vitals: queueView?.waitingVitals ?? 0 })}
      clocksAlert={over}
    >
      <div className="od-flow">
        {/* ① department */}
        <section className="od-step" data-state={departmentId === "" ? "now" : "done"}>
          <div className="od-step-h">
            <span className="od-n">1</span>
            <span className="od-step-t">{t("opd.labels.department")}</span>
          </div>
          <label className="od-lbl" htmlFor="desk-department">{t("opd.labels.department")}</label>
          <select
            id="desk-department"
            className="od-in"
            value={departmentId}
            onChange={(e) => {
              setDepartmentId(e.target.value);
              pickDoctor("");
            }}
          >
            <option value="">{t("opdDesk.pickDepartment")}</option>
            {departmentItems.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </section>

        {/* ② doctor — the Routing board's "everyone on today"; choosing a row is the ONE way to choose */}
        <section className="od-step" data-state={departmentId === "" ? "todo" : selectedDoctorId === "" ? "now" : "done"}>
          <div className="od-step-h">
            <span className="od-n">2</span>
            <span className="od-step-t">{t("opdDesk.board")}</span>
            {department !== null && <span className="od-step-s tag">{department.name} — {t("opdDesk.everyoneToday")}</span>}
          </div>
          {departmentId === "" && <p className="od-hint">{t("opdDesk.pickDepartmentHint")}</p>}
          <div>
            {summaryItems.map((s) => {
              const bar = barOf(s.waitingCount);
              const mins = Number.isFinite(s.avgConsultMinutes) ? s.waitingCount * s.avgConsultMinutes : null;
              return (
                <div key={s.doctor.id} data-testid={`board-row-${s.doctor.id}`}>
                  <button
                    type="button"
                    className="od-drow"
                    data-testid={`board-pick-${s.doctor.id}`}
                    aria-pressed={s.doctor.id === selectedDoctorId}
                    onClick={() => pickDoctor(s.doctor.id)}
                  >
                    <span className="od-dot" style={{ background: dotOf(s) }} />
                    <span className="od-dname">
                      {s.doctor.displayName}
                      {(() => { const tag = doctorLabel(s.doctor); return tag === null ? null : <span className="od-dtag" data-testid={`doctor-tag-${s.doctor.id}`}> · {tag}</span>; })()}
                    </span>
                    <span className="od-room">{t("opd.labels.room")}: {s.roomCode ?? "—"}</span>
                    <span className="od-bar"><i style={{ width: bar.pct, background: bar.ink }} /></span>
                    <span className="od-wait">
                      <span data-testid={`board-waiting-${s.doctor.id}`}>{s.waitingCount}</span> {t("opdDesk.waitingShort")}
                      {mins !== null && mins > 0 && <> · ~{mins}m</>}
                    </span>
                    <span className={`od-pill${s.status === "in" ? " on" : s.status === "out" ? " gd" : ""}`}>
                      {t(`opd.sessionStatus.${s.status}`)}
                    </span>
                  </button>
                  <div className="od-dmeta">
                    {s.nowServing !== null && <span>{t("opdDesk.nowServing")}: {s.nowServing}</span>}
                    {/*
                      ═══ FD-7 T8 — "NOT SCHEDULED TODAY" WAS THE WRONG SENTENCE FOR A DOCTOR ON LEAVE ═══
                      `scheduledToday` means "working today"; without the split every absent doctor would
                      read "not scheduled today" — a shrug, where "on leave today" is an answer a clerk can
                      give. With people already waiting the count is the point: they hold a token and, in a
                      bill-first hospital, have paid. The transfer that re-seats them is the bar's next act.
                    */}
                    {s.onLeaveToday ? (
                      <span className="away" data-testid={`on-leave-${s.doctor.id}`}>
                        {s.waitingCount > 0
                          ? t("opdDesk.onLeaveWithWaiting", { count: s.waitingCount })
                          : t("opdDesk.onLeaveToday")}
                      </span>
                    ) : !s.scheduledToday && (
                      <span className="warn">{t("opdDesk.notScheduledToday")}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ③ act — on the token in hand, or on the doctor's whole line */}
        <section className="od-step" data-testid="od-act" data-state={act !== null || inHand !== null ? "now" : "todo"}>
          <div className="od-step-h">
            <span className="od-n">3</span>
            <span className="od-step-t">{t("opdDesk.actTitle")}</span>
            {inHand !== null && <span className="od-step-s">{t("opdDesk.token", { tokenNo: inHand.tokenNo })}</span>}
          </div>

          {act === null && inHand === null && <p className="od-hint">{t("opdDesk.actHint")}</p>}

          {act === null && inHand !== null && (
            <div className="od-choices">
              <button type="button" className="od-choice" data-testid={`abandon-${inHand.id}`} onClick={() => { clearAct(); setAct("abandon"); }}>
                <b>{t("opdDesk.abandon")}</b>
                <span>{t("opdDesk.abandonWhy")}</span>
              </button>
              <button type="button" className="od-choice" data-testid={`move-${inHand.id}`} onClick={() => startTransfer([inHand.id])}>
                <b>{t("opdDesk.moveOne")}</b>
                <span>{t("opdDesk.moveOneWhy")}</span>
              </button>
            </div>
          )}

          {act === "abandon" && inHand !== null && (
            <div className="od-form">
              <div>
                <label className="od-lbl" htmlFor={`abandon-reason-${inHand.id}`}>{t("opd.labels.reason")}</label>
                <input
                  id={`abandon-reason-${inHand.id}`}
                  className="od-in"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              {error !== null && <p role="alert" className="od-alert">{error}</p>}
            </div>
          )}

          {act === "transfer" && (
            <div className="od-form">
              <p className="od-hint">{t("opdDesk.fromDoctor")}: <b>{doctorNameOf(selectedDoctorId) === "" ? "—" : doctorNameOf(selectedDoctorId)}</b></p>
              <div>
                <label className="od-lbl" htmlFor="transfer-to">{t("opdDesk.toDoctor")}</label>
                <select id="transfer-to" className="od-in" value={toDoctorId} onChange={(e) => setToDoctorId(e.target.value)}>
                  <option value="">{t("opdDesk.pickToDoctor")}</option>
                  {summaryItems.filter((c) => c.doctor.id !== selectedDoctorId).map((c) => (
                    <option key={c.doctor.id} value={c.doctor.id}>{c.doctor.displayName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="od-lbl" htmlFor="transfer-reason">{t("opd.labels.reason")}</label>
                <input id="transfer-reason" className="od-in" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              {orderedEntries.length > 0 && (
                <fieldset className="od-entries">
                  <legend>{t("opdDesk.entries")}</legend>
                  {orderedEntries.map((e) => (
                    <label key={e.id} className="od-check">
                      <input
                        type="checkbox"
                        data-testid={`transfer-entry-${e.id}`}
                        checked={entryIds.includes(e.id)}
                        onChange={() => setEntryIds((ids) => (ids.includes(e.id) ? ids.filter((x) => x !== e.id) : [...ids, e.id]))}
                      />
                      <span className="mo">{e.tokenNo}</span> · {patientLabel(e.patient)}
                    </label>
                  ))}
                </fieldset>
              )}
              <div className="od-check">
                <input id="transfer-consent" type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} />
                <label htmlFor="transfer-consent">{t("opdDesk.consentGiven")}</label>
              </div>
              {error !== null && <p role="alert" className="od-alert">{error}</p>}
              {moved !== null && <p className="od-ok">{t("opdDesk.transferred", { n: moved })}</p>}
            </div>
          )}
        </section>

        {/* The Main board's ladder legend, as the Routing board writes its rule down: under the flow. */}
        <section className="od-step od-ladder" aria-label={t("opdDesk.ladder")}>
          <span className="tag">{t("opdDesk.ladder")}</span>
          {[0, 1, 2, 3].map((c) => (
            <span key={c}><i style={{ background: CLASS_INK[c] }} />{t(`opdDesk.ladderRule.${c}`)}</span>
          ))}
        </section>

        <div className="od-bar-wrap" data-testid="action-bar">
          <span className="od-bar-s">{barSentence}</span>
          {act !== null && <button type="button" className="od-sec" onClick={clearAct}>{t("opdDesk.cancel")}</button>}
          {transferButton}
          {primary}
        </div>
      </div>
    </StationShell>
  );
}
