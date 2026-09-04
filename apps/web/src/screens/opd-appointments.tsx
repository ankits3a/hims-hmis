import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { FormProvider, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { listDepartments, listDoctors, listRooms, opdErrorMessage, todayIst } from "../lib/opd-api";
import type { WireAppointment, WireDepartment, WireDoctor, WireOpenVisitResult, WireRoom, WireSlot } from "../lib/opd-api";
import { useRealtime } from "../lib/realtime";
import { AgentDock, logged } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";
import { PatientPicker } from "../components/patient-picker";
import type { PatientPickerHit } from "../components/patient-picker";
import { TokenSlip } from "../components/token-slip";
import type { TokenSlipProps } from "../components/token-slip";
import type { QrCardData } from "../components/qr-card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Appointments (D7): slot picker → book, the day list with reschedule/cancel, the needs-rebooking
 * worklist (the leave cascade's landing page), and same-day check-in producing the printed token
 * slip. Every read here is BOTH polled (`refetchInterval`, D6) and realtime-subscribed — the push is
 * a hint, never the only path to a correct screen. The server is authoritative throughout: nothing
 * here hides a button behind a guessed role, and no response status is branched on beyond `api()`'s
 * own 2xx/non-2xx split (§ HTTP status codes — every POST here rides Nest's default 201).
 */
const POLL_MS = 15_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** UTC instant → IST 'HH:MM'. Arithmetic, no Intl — the same technique as opd-api.ts's todayIst. */
function fmtIst(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function patientLabel(p: { name: string | null; alias: string | null; restricted: boolean } | null | undefined): string {
  if (!p) return "—";
  return p.restricted ? (p.alias ?? "—") : (p.name ?? "—");
}

/** FD-22's rule, applied here too: a refusal appears where the action was, never at the top. */
function ErrorLine({ message }: { message: string | null }): React.ReactElement | null {
  if (message === null) return null;
  return <p role="alert" className="text-sm text-red-600">{message}</p>;
}

// ——— the slot grid: shared by the booking panel and the reschedule dialog ———

function SlotGrid({ slots, onPick }: { slots: WireSlot[]; onPick: (slot: WireSlot) => void }): React.ReactElement {
  return (
    <div className="grid grid-cols-6 gap-2">
      {slots.map((slot) => (
        <button
          key={slot.start}
          type="button"
          data-testid={`slot-${slot.start}`}
          disabled={slot.booked}
          onClick={() => onPick(slot)}
          className={cn(
            "rounded border px-2 py-2 text-sm",
            slot.past && "opacity-50",
            slot.booked && "cursor-not-allowed bg-neutral-100 text-neutral-400",
          )}
        >
          {fmtIst(slot.start)}
        </button>
      ))}
    </div>
  );
}

// ——— reschedule: `booked` AND `needs_rebooking` both ride the same route (D7 / appointments.ts) ———

function RescheduleDialog({
  appointment, queryClient, onNote,
}: {
  appointment: WireAppointment; queryClient: QueryClient;
  onNote: (text: string, kind?: AgentLine["kind"]) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayIst());
  const [error, setError] = useState<string | null>(null);

  const slots = useQuery({
    queryKey: ["opd", "slots", appointment.doctorId, date],
    queryFn: () => api<{ slots: WireSlot[] }>("GET", `/opd/slots?doctorId=${appointment.doctorId}&date=${date}`),
    enabled: open,
  });

  const pick = async (slot: WireSlot): Promise<void> => {
    setError(null);
    try {
      await api("POST", `/opd/appointments/${appointment.id}/reschedule`, { slotStart: slot.start, doctorId: appointment.doctorId });
      onNote(`moved ${patientLabel(appointment.patient)} to ${fmtIst(slot.start)}`, "ok");
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["opd", "appointments"] });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="sec">{t("opdAppt.reschedule")}</button>
      </DialogTrigger>
      <DialogContent className="pp">
        <DialogHeader><DialogTitle>{t("opdAppt.reschedule")}</DialogTitle></DialogHeader>
        <label className="block text-sm font-medium" htmlFor={`reschedule-date-${appointment.id}`}>{t("opdAppt.newDate")}</label>
        <input
          id={`reschedule-date-${appointment.id}`}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded border px-2 py-1"
        />
        {slots.data !== undefined && <SlotGrid slots={slots.data.slots} onPick={(slot) => void pick(slot)} />}
        <ErrorLine message={error} />
      </DialogContent>
    </Dialog>
  );
}

// ——— cancel: the reason is mandatory client-side (mirror) AND server-side (the rule itself) ———

function CancelDialog({
  appointment, queryClient, onNote,
}: {
  appointment: WireAppointment; queryClient: QueryClient;
  onNote: (text: string, kind?: AgentLine["kind"]) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      await api("POST", `/opd/appointments/${appointment.id}/cancel`, { reason });
      onNote(`cancelled ${patientLabel(appointment.patient)} — ${reason}`, "warn");
      setOpen(false);
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["opd", "appointments"] });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="sec">{t("opdAppt.cancel")}</button>
      </DialogTrigger>
      <DialogContent className="pp">
        <DialogHeader><DialogTitle>{t("opdAppt.cancel")}</DialogTitle></DialogHeader>
        <label className="block text-sm font-medium" htmlFor={`cancel-reason-${appointment.id}`}>{t("opd.labels.reason")}</label>
        <input
          id={`cancel-reason-${appointment.id}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded border px-2 py-1"
        />
        <ErrorLine message={error} />
        <button className="pri" onClick={() => void submit()} disabled={reason.trim() === ""}>{t("opdAppt.confirmCancel")}</button>
      </DialogContent>
    </Dialog>
  );
}

function StatusBadge({ status }: { status: WireAppointment["status"] }): React.ReactElement {
  const { t } = useTranslation();
  /* FD-23 — the counter's three states: gone (brick), arrived (pine), expected (plain). */
  const cls = status === "cancelled" || status === "no_show" ? "pill rd" : status === "checked_in" ? "pill on" : "pill";
  return <span className={cls} style={{ height: 20 }}>{t(`opdAppt.status.${status}`)}</span>;
}

// ——— check-in: same IST day only, from `booked` (D7) — K42's ONLY guard ———

function CheckInCell({
  appointment, doctorName, departmentCode, departmentName, roomCodeOf, queryClient, onSlip,
}: {
  appointment: WireAppointment; doctorName: string; departmentCode: string; departmentName: string;
  roomCodeOf: (roomId: string | null) => string | null; queryClient: QueryClient; onSlip: (slip: TokenSlipProps) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  // K42: disabled for exactly one reason — the appointment is not for today. Nothing else gates this button.
  const disabled = appointment.serviceDate !== todayIst();

  const checkIn = async (): Promise<void> => {
    setError(null);
    try {
      const result = await api<WireOpenVisitResult>("POST", `/opd/appointments/${appointment.id}/check-in`);
      const qr = await api<QrCardData>("GET", `/patients/${appointment.patientId}/qr`);
      onSlip({
        tokenNo: result.tokenNo,
        visitNo: result.encounter.visitNo,
        roomCode: roomCodeOf(result.roomId),
        doctorName,
        departmentCode,
        departmentName,
        serviceDate: appointment.serviceDate,
        patient: { uhid: appointment.patient?.uhid ?? qr.uhid, name: appointment.patient?.name ?? qr.name },
        qrPayload: qr.payload,
        visitType: result.visitType,
      });
      await queryClient.invalidateQueries({ queryKey: ["opd", "appointments"] });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  };

  return (
    <div>
      <button className="sec grn" data-testid={`checkin-${appointment.id}`} disabled={disabled} onClick={() => void checkIn()}>
        {t("opdAppt.checkIn")}
      </button>
      <ErrorLine message={error} />
    </div>
  );
}

// ——— the Day tab: slot grid + patient picker (left), this day's bookings (right) ———

function DayTab({
  departmentId, doctorId, date, departments, doctors, rooms, queryClient, onNote,
}: {
  departmentId: string; doctorId: string; date: string;
  departments: WireDepartment[]; doctors: WireDoctor[]; rooms: WireRoom[]; queryClient: QueryClient;
  /** Every SERVER ANSWER this tab gets lands in the agent's log — never an intention, only a result. */
  onNote: (text: string, kind?: AgentLine["kind"]) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [patient, setPatient] = useState<PatientPickerHit | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);
  const [slip, setSlip] = useState<TokenSlipProps | null>(null);

  const slots = useQuery({
    queryKey: ["opd", "slots", doctorId, date],
    queryFn: () => api<{ slots: WireSlot[] }>("GET", `/opd/slots?doctorId=${doctorId}&date=${date}`),
    enabled: doctorId !== "",
  });
  const appointments = useQuery({
    queryKey: ["opd", "appointments", doctorId, date],
    queryFn: () => api<{ items: WireAppointment[] }>("GET", `/opd/appointments?doctorId=${doctorId}&serviceDate=${date}`),
    enabled: doctorId !== "",
    refetchInterval: POLL_MS,
  });

  // D6: the push is a hint — a missed frame costs the 15 s poll above, never correctness.
  useRealtime(doctorId === "" ? [] : [`queue:${doctorId}:${date}`], (frame) => {
    if (frame.name === "patient.checked_in") {
      void queryClient.invalidateQueries({ queryKey: ["opd", "appointments", doctorId, date] });
    }
  });

  const department = departments.find((d) => d.id === departmentId) ?? null;
  const doctor = doctors.find((d) => d.id === doctorId) ?? null;
  const roomCodeOf = (roomId: string | null): string | null => rooms.find((r) => r.id === roomId)?.code ?? null;

  const book = async (slot: WireSlot): Promise<void> => {
    if (patient === null || doctorId === "") return;
    setBookError(null);
    try {
      await api("POST", "/opd/appointments", { patientId: patient.id, doctorId, slotStart: slot.start });
      /*
        LOGGED AFTER THE SERVER ANSWERED, never before: a log that narrates intentions lies the
        moment one is refused. The refusal below is logged for the same reason — it is a fact.
      */
      onNote(`booked ${patient.name} at ${fmtIst(slot.start)}`, "ok");
      await queryClient.invalidateQueries({ queryKey: ["opd", "appointments", doctorId, date] });
      await queryClient.invalidateQueries({ queryKey: ["opd", "slots", doctorId, date] });
    } catch (e) {
      setBookError(opdErrorMessage(e));
      onNote(`booking REFUSED — ${opdErrorMessage(e)}`, "err");
    }
  };

  if (slip !== null) {
    return (
      <div className="space-y-4">
        <TokenSlip {...slip} />
        <button className="sec no-print" onClick={() => setSlip(null)}>{t("opdAppt.backToList")}</button>
      </div>
    );
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-2">
        <h2 style={{ fontSize: 13, fontWeight: 700 }}>{t("opdAppt.slots")}</h2>
        {doctorId === "" && <p style={{ fontSize: 12, color: "var(--dim)" }}>{t("opdAppt.pickDoctorHint")}</p>}
        {doctorId !== "" && slots.data === undefined && <p>{t("app.loading")}</p>}
        {doctorId !== "" && slots.data !== undefined && <SlotGrid slots={slots.data.slots} onPick={(slot) => void book(slot)} />}
        <ErrorLine message={bookError} />
        <h2 className="pt-2 text-sm font-semibold">{t("opdAppt.pickPatient")}</h2>
        <PatientPicker onPick={setPatient} />
        {patient !== null && (
          <p className="text-sm">{t("opdAppt.selectedPatient")}: {patient.name ?? "—"} ({patient.uhid})</p>
        )}
      </div>
      <div className="space-y-2">
        <h2 style={{ fontSize: 13, fontWeight: 700 }}>{t("opdAppt.bookings")}</h2>
        {doctorId !== "" && appointments.data !== undefined && appointments.data.items.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--dim)" }}>{t("opdAppt.none")}</p>
        )}
        {doctorId !== "" && appointments.data !== undefined && appointments.data.items.length > 0 && (
          <div role="table" className="box" style={{ overflow: "hidden" }}>
            <div role="rowgroup">
              <div role="row" style={{ display: "flex", gap: 10, padding: "9px 13px", borderBottom: "1px solid var(--line2)" }}>
                <span role="columnheader" className="tag" style={{ flexGrow: 1 }}>{t("opd.labels.patient")}</span>
                <span role="columnheader" className="tag" style={{ flexGrow: 1 }}>{t("opdAppt.time")}</span>
                <span role="columnheader" className="tag" style={{ flexGrow: 1 }}>{t("opd.labels.status")}</span>
                <span role="columnheader" className="tag" style={{ flexGrow: 1 }}>{t("opd.labels.actions")}</span>
              </div>
            </div>
            <div role="rowgroup">
              {appointments.data.items.map((apt) => (
                <div role="row" className="drow" key={apt.id}>
                  <span role="cell" style={{ flexGrow: 1, fontSize: 12 }}>
                    <span className="block">{patientLabel(apt.patient)}</span>
                    <span className="block font-mono text-xs text-neutral-600">{apt.patient?.uhid ?? "—"}</span>
                  </span>
                  <span role="cell" style={{ flexGrow: 1, fontSize: 12 }}>{fmtIst(apt.slotStart)}</span>
                  <span role="cell" style={{ flexGrow: 1, fontSize: 12 }}><StatusBadge status={apt.status} /></span>
                  <span role="cell" style={{ flexGrow: 1, fontSize: 12 }}>
                    <div className="flex flex-wrap gap-2">
                      {(apt.status === "booked" || apt.status === "needs_rebooking") && (
                        <RescheduleDialog appointment={apt} queryClient={queryClient} onNote={onNote} />
                      )}
                      {apt.status === "booked" && <CancelDialog appointment={apt} queryClient={queryClient} onNote={onNote} />}
                      {apt.status === "booked" && (
                        <CheckInCell
                          appointment={apt}
                          doctorName={doctor?.displayName ?? ""}
                          departmentCode={department?.code ?? ""}
                          departmentName={department?.name ?? ""}
                          roomCodeOf={roomCodeOf}
                          queryClient={queryClient}
                          onSlip={setSlip}
                        />
                      )}
                    </div>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ——— the needs-rebooking worklist: the leave cascade's landing page, across every doctor ———

function NeedsRebookingTab(
  { allDoctors, queryClient, onNote }: {
    allDoctors: WireDoctor[]; queryClient: QueryClient;
    onNote: (text: string, kind?: AgentLine["kind"]) => void;
  },
): React.ReactElement {
  const { t } = useTranslation();
  const items = useQuery({
    queryKey: ["opd", "appointments", "needsRebooking"],
    queryFn: () => api<{ items: WireAppointment[] }>("GET", "/opd/appointments?needsRebooking=true"),
    refetchInterval: POLL_MS,
  });
  const doctorName = (id: string): string => allDoctors.find((d) => d.id === id)?.displayName ?? id;

  return (
    <div className="space-y-2">
      <h2 style={{ fontSize: 13, fontWeight: 700 }}>{t("opdAppt.needsRebooking")}</h2>
      {items.data !== undefined && items.data.items.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--dim)" }}>{t("opdAppt.none")}</p>
      )}
      {items.data !== undefined && items.data.items.length > 0 && (
        <div role="table" className="box" style={{ overflow: "hidden" }}>
          <div role="rowgroup">
              <div role="row" style={{ display: "flex", gap: 10, padding: "9px 13px", borderBottom: "1px solid var(--line2)" }}>
                <span role="columnheader" className="tag" style={{ flexGrow: 1 }}>{t("opd.labels.patient")}</span>
              <span role="columnheader" className="tag" style={{ flexGrow: 1 }}>{t("opd.labels.doctor")}</span>
              <span role="columnheader" className="tag" style={{ flexGrow: 1 }}>{t("opdAppt.time")}</span>
              <span role="columnheader" className="tag" style={{ flexGrow: 1 }}>{t("opd.labels.actions")}</span>
              </div>
            </div>
          <div>
            {items.data.items.map((apt) => (
              <div role="row" className="drow" key={apt.id}>
                <span role="cell" style={{ flexGrow: 1, fontSize: 12 }}>
                  <span className="block">{patientLabel(apt.patient)}</span>
                  <span className="block font-mono text-xs text-neutral-600">{apt.patient?.uhid ?? "—"}</span>
                </span>
                <span role="cell" style={{ flexGrow: 1, fontSize: 12 }}>{doctorName(apt.doctorId)}</span>
                <span role="cell" style={{ flexGrow: 1, fontSize: 12 }}>{fmtIst(apt.slotStart)}</span>
                <span role="cell" style={{ flexGrow: 1, fontSize: 12 }}><RescheduleDialog appointment={apt} queryClient={queryClient} onNote={onNote} /></span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ——— screen ———

export function OpdAppointments(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const filters = useForm<{ departmentId: string; doctorId: string; date: string }>({
    defaultValues: { departmentId: "", doctorId: "", date: todayIst() },
  });
  const departmentId = filters.watch("departmentId");
  const doctorId = filters.watch("doctorId");
  const date = filters.watch("date");
  const setValue = filters.setValue;

  // Switching department invalidates the previously selected doctor — a stale id from the OLD
  // department's list must not silently keep driving the slot/day-list queries below.
  useEffect(() => {
    setValue("doctorId", "");
  }, [departmentId, setValue]);

  const departments = useQuery({ queryKey: ["opd", "departments"], queryFn: listDepartments, refetchInterval: POLL_MS });
  const doctors = useQuery({
    queryKey: ["opd", "doctors", departmentId],
    queryFn: () => api<{ items: WireDoctor[] }>("GET", `/opd/doctors?departmentId=${departmentId}`),
    enabled: departmentId !== "",
    refetchInterval: POLL_MS,
  });
  const allDoctors = useQuery({ queryKey: ["opd", "doctors", "all"], queryFn: listDoctors, refetchInterval: POLL_MS });
  const rooms = useQuery({ queryKey: ["opd", "rooms"], queryFn: listRooms, refetchInterval: POLL_MS });

  const [tab, setTab] = useState<"day" | "needsRebooking">("day");
  const [log, setLog] = useState<AgentLine[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const note = useCallback((text: string, kind: AgentLine["kind"] = "did") => {
    setLog((prev) => logged(prev, text, kind));
  }, []);

  const departmentItems = departments.data?.items ?? [];
  const doctorItems = doctors.data?.items ?? [];
  const allDoctorItems = allDoctors.data?.items ?? [];
  const roomItems = rooms.data?.items ?? [];

  /**
   * WHAT THE AGENT CAN HONESTLY ANSWER, and it says which of those it used. Everything here is
   * already on the screen — the filters, the master lists — so the answer is instant and true.
   * There is no model call and no guess: an unrecognised question says so rather than inventing.
   */
  const ask = useCallback((question: string): void => {
    const q = question.trim().toLowerCase();
    if (q === "") return;
    const doctorName = allDoctorItems.find((doc) => doc.id === doctorId)?.displayName ?? null;
    if (q.includes("doctor") && doctorName !== null) {
      setAnswer(`You are looking at ${doctorName}'s book for ${date}. — from the filters on this screen.`);
    } else if (q.includes("department")) {
      setAnswer(
        departmentId === ""
          ? "No department is picked, so the doctor list is empty. Pick one above. — from the filters on this screen."
          : `${departmentItems.find((dep) => dep.id === departmentId)?.name ?? "That department"} has ${String(doctorItems.length)} doctor(s) on file. — from the doctor master.`,
      );
    } else if (q.includes("today") || q.includes("date")) {
      setAnswer(`This book is showing ${date}; today is ${todayIst()}. Check-in is only offered on today's bookings. — from the filters and the K42 rule.`);
    } else {
      setAnswer("I answer from what is on this screen — the department and doctor you have picked, the date, and the doctor master. I cannot look anything else up.");
    }
  }, [allDoctorItems, doctorId, date, departmentId, departmentItems, doctorItems.length]);

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * FD-23 — THE APPOINTMENT BOOK, IN THE COUNTER'S LANGUAGE
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Owner ruling 2026-09-04: *"redesign /opd/appointments and /patients/ screens aligned to /counter
   * UI and UX. Remember to add AI agent/Co-pilot into it as well."*
   *
   * This screen was the last of the shadcn/neutral front-desk surfaces — the look the owner has now
   * ruled against twice ("all five defects were the SCREEN, not the server"). A clerk moving between
   * `/counter` and here was looking at two products.
   *
   * IT WEARS `.pp`, NOT `.d1`. Desk One is `position: fixed; inset: 0` and deliberately covers the
   * application chrome; this screen lives INSIDE the shell and keeps its topbar. `.pp` carries the
   * same primitives from the same file, so the marigold cannot come to mean two different things.
   *
   * EVERY TESTID AND EVERY HANDLER IS UNCHANGED. Twenty-one tests across this screen and the patient
   * record pin what these screens DO, and a redesign that quietly changed behaviour would be the
   * worst outcome — so they were kept green throughout rather than rewritten alongside.
   */
  return (
    <div className="pp" style={{ display: "flex", flexDirection: "column", minHeight: "calc(100vh - 96px)" }}>
      <div style={{ flexGrow: 1, padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 11 }}>
          <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>{t("opdAppt.title")}</span>
          <span style={{ fontSize: 12, color: "var(--dim)" }}>
            a booking is a promise about a time — the board only shows times that exist
          </span>
        </div>

        <FormProvider {...filters}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 11, marginTop: 15 }}>
            <div style={{ width: 220 }}>
              {/*
                A REAL <label htmlFor>, not a styled div. The counter's `.tag` is a visual class and
                carries no association; three tests find these fields by their label and so does a
                screen reader, so the redesign keeps the semantics and only changes the paint.
              */}
              <label className="tag" htmlFor="filter-department" style={{ display: "block", marginBottom: 5 }}>
                {t("opd.labels.department")}
              </label>
              <select
                id="filter-department"
                className="in"
                data-testid="filter-department"
                value={departmentId}
                onChange={(e) => { setValue("departmentId", e.target.value); }}
              >
                <option value="">{t("opdAppt.pickDepartment")}</option>
                {departmentItems.map((dep) => <option key={dep.id} value={dep.id}>{dep.code} · {dep.name}</option>)}
              </select>
            </div>
            <div style={{ width: 240 }}>
              <label className="tag" htmlFor="filter-doctor" style={{ display: "block", marginBottom: 5 }}>
                {t("opd.labels.doctor")}
              </label>
              <select
                id="filter-doctor"
                className="in"
                data-testid="filter-doctor"
                value={doctorId}
                onChange={(e) => { setValue("doctorId", e.target.value); }}
              >
                <option value="">{t("opdAppt.pickDoctor")}</option>
                {doctorItems.map((doc) => <option key={doc.id} value={doc.id}>{doc.displayName}</option>)}
              </select>
            </div>
            <div style={{ width: 170 }}>
              <label className="tag" htmlFor="filter-date" style={{ display: "block", marginBottom: 5 }}>
                {t("opd.labels.date")}
              </label>
              <input
                id="filter-date"
                className="in mo"
                type="date"
                data-testid="filter-date"
                value={date}
                onChange={(e) => { setValue("date", e.target.value); }}
              />
            </div>
          </div>
        </FormProvider>

        {/* Pill tabs, the counter's own idiom — not a shadcn TabsList with a grey underline. */}
        {/*
          PAINT CHANGED, SEMANTICS DID NOT. A pill is a look; `role="tab"` is what a screen reader
          and a keyboard user navigate by, and dropping it while restyling would have been a real
          regression that only the tests noticed.
        */}
        <div role="tablist" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 18 }}>
          {([["day", t("opdAppt.tabs.day")], ["needsRebooking", t("opdAppt.tabs.needsRebooking")]] as const).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              data-testid={`tab-${key}`}
              className={tab === key ? "pill on" : "pill"}
              style={{ height: 27 }}
              onClick={() => { setTab(key); }}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 16 }}>
          {tab === "day" ? (
            <DayTab
              departmentId={departmentId} doctorId={doctorId} date={date}
              departments={departmentItems} doctors={doctorItems} rooms={roomItems} queryClient={queryClient}
              onNote={note}
            />
          ) : (
            <NeedsRebookingTab allDoctors={allDoctorItems} queryClient={queryClient} onNote={note} />
          )}
        </div>
      </div>

      {/*
        THE AGENT, along the bottom exactly as it is on the counter. No model behind it — it answers
        from what is already on this screen and names the source, which is the only honest answer a
        clerk with a queue can be given in under a second.
      */}
      <AgentDock
        answer={answer}
        log={log}
        onAsk={ask}
        placeholder={t("opdAppt.askPlaceholder")}
        idle={t("opdAppt.agentIdle")}
      />
    </div>
  );
}
