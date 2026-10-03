import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { FormProvider, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { listDepartments, listDoctors, listPatientAppointments, listRooms, opdErrorMessage, todayIst } from "../lib/opd-api";
import { upcomingOf } from "../lib/appointment-view";
import type { WireAppointment, WireDepartment, WireDoctor, WireOpenVisitResult, WireRoom, WireSlot } from "../lib/opd-api";
import { useRealtime } from "../lib/realtime";
import { useCopilot } from "../lib/use-copilot";
import { CopilotReport } from "../components/copilot-report";
import { AgentDock, logged } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";
import { PatientPicker } from "../components/patient-picker";
import type { PatientPickerHit } from "../components/patient-picker";
import { TokenSlip } from "../components/token-slip";
import type { TokenSlipProps } from "../components/token-slip";
import { PaperScreen } from "../components/paper-screen";
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

/*
  ═══ UX-AUDIT 2026-09-28 — THREE STATES THAT RENDERED AS ONE ═══

  A real-Chromium walk found every slot drawn as bare text: a booked 09:50 had the same colour,
  no fill and no border as a free 09:40. The grid was painted with Tailwind utilities (`border`,
  `bg-neutral-100`, `opacity-50`), and this screen lives inside `.pp`, whose reset in
  `desk-one.css` — `.pp button { background: none; border: none; padding: 0 }` — out-ranks all of
  them twice over: (0,1,1) beats (0,1,0), and unlayered CSS beats `@layer utilities` whatever the
  specificity. jsdom loads no stylesheet, so every test stayed green over a screen that could not
  tell a clerk which times were taken.

  The paint now comes from `.pp .slot` primitives in that same sheet, so the reset and the paint
  are one file and one scope. FREE is a bordered button; TAKEN is dashed, washed and SAYS "Booked"
  (shape and words, not a colour step a dim monitor loses); PAST is muted and struck through but
  still clickable, as it always was here — the server is the one that refuses a past time.

  `locked` is the booking panel's "no patient yet": every slot is disabled and the panel says why.
*/
function SlotGrid(
  { slots, onPick, locked = false }: { slots: WireSlot[]; onPick: (slot: WireSlot) => void; locked?: boolean },
): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="slots">
      {slots.map((slot) => {
        const state = slot.booked ? "taken" : slot.past ? "past" : "free";
        return (
          <button
            key={slot.start}
            type="button"
            data-testid={`slot-${slot.start}`}
            disabled={slot.booked || locked}
            title={slot.booked ? t("opdAppt.slotBooked") : slot.past ? t("slotBoard.past") : t("slotBoard.free")}
            onClick={() => onPick(slot)}
            className={cn("slot mo", state)}
          >
            {fmtIst(slot.start)}
            {slot.booked && <span className="note">{t("opdAppt.slotBooked")}</span>}
          </button>
        );
      })}
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

/**
 * ═══ THIS PATIENT'S OWN BOOKINGS, WHATEVER THE FILTERS SAY (owner, 2026-10-01) ═══
 *
 * *"I can see a future appointment for U00110020 in the profile screen but I can't see any
 * appointments for the same patient at /opd/appointments. Why so?"* Because this screen listed ONE
 * doctor's book for ONE day, and with no doctor chosen it listed nothing: a booking for tomorrow with
 * another doctor could not be reached without already knowing whose book and which day it was in.
 *
 * So the patient in the "Booking for" card brings their own bookings with them — every slot they
 * still hold, any doctor, any day — each with the same Reschedule and Cancel the day list offers.
 * The query key starts `["opd", "appointments"]`, which both dialogs already invalidate.
 */
function PatientBookings({
  patient, doctors, queryClient, onNote,
}: {
  patient: PatientPickerHit; doctors: WireDoctor[]; queryClient: QueryClient;
  onNote: (text: string, kind?: AgentLine["kind"]) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const theirs = useQuery({
    queryKey: ["opd", "appointments", "patient", patient.id],
    queryFn: () => listPatientAppointments(patient.id),
    refetchInterval: POLL_MS,
  });
  const items = upcomingOf(theirs.data?.items, todayIst());
  return (
    <div data-testid="patient-bookings" style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line2)" }}>
      <span className="tag">{t("opdAppt.theirBookings")}</span>
      {theirs.data !== undefined && items.length === 0 && (
        <p data-testid="patient-bookings-none" style={{ fontSize: 12, color: "var(--dim)", margin: "6px 0 0" }}>{t("opdAppt.theirBookingsNone")}</p>
      )}
      {items.map((apt) => (
        <div key={apt.id} data-testid="patient-booking-row" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 8 }}>
          <span className="mo" style={{ fontSize: 13, fontWeight: 700 }}>{apt.serviceDate.slice(0, 10)} · {fmtIst(apt.slotStart)}</span>
          <span style={{ fontSize: 12.5, color: "var(--dim)", flexGrow: 1, minWidth: 0 }}>{doctors.find((d) => d.id === apt.doctorId)?.displayName ?? ""}</span>
          <StatusBadge status={apt.status} />
          <RescheduleDialog appointment={apt} queryClient={queryClient} onNote={onNote} />
          {apt.status === "booked" && <CancelDialog appointment={apt} queryClient={queryClient} onNote={onNote} />}
        </div>
      ))}
    </div>
  );
}

function DayTab({
  departmentId, doctorId, date, departments, doctors, allDoctors, initialPatientId, rooms, queryClient, onNote,
}: {
  departmentId: string; doctorId: string; date: string;
  departments: WireDepartment[]; doctors: WireDoctor[]; rooms: WireRoom[]; queryClient: QueryClient;
  /** Every doctor, for naming a booking held with one outside the chosen department. */
  allDoctors: WireDoctor[];
  /** The patient a link from their profile arrived for (`?patientId=`); null on an ordinary visit. */
  initialPatientId: string | null;
  /** Every SERVER ANSWER this tab gets lands in the agent's log — never an intention, only a result. */
  onNote: (text: string, kind?: AgentLine["kind"]) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [patient, setPatient] = useState<PatientPickerHit | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);
  const [slip, setSlip] = useState<TokenSlipProps | null>(null);

  // A link from the profile names the patient; put them in the card so their bookings show at once.
  useEffect(() => {
    if (initialPatientId === null) return;
    let live = true;
    void api<{ patient: { id: string; uhid: string; name: string | null; administrativeGender: string; dob: string | null } }>(
      "GET", `/patients/${encodeURIComponent(initialPatientId)}`,
    ).then(
      ({ patient: p }) => { if (live) setPatient((cur) => cur ?? { id: p.id, uhid: p.uhid, name: p.name, administrativeGender: p.administrativeGender, dob: p.dob }); },
      () => { /* an unreadable patient leaves the picker empty; the clerk searches as usual */ },
    );
    return () => { live = false; };
  }, [initialPatientId]);

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

  /*
    UX-AUDIT 2026-09-28 — A CLICK ASKS; CONFIRM BOOKS. A booking is a promise made to a patient
    about a time, and the old grid made it on a single click with no chance to see who, with whom
    and when. The click now only holds the slot in `pending`; the POST rides the dialog's Confirm.
  */
  const [pending, setPending] = useState<WireSlot | null>(null);
  const [busy, setBusy] = useState(false);

  const book = async (slot: WireSlot): Promise<void> => {
    if (patient === null || doctorId === "") return;
    setBookError(null);
    setBusy(true);
    try {
      await api("POST", "/opd/appointments", { patientId: patient.id, doctorId, slotStart: slot.start });
      /*
        LOGGED AFTER THE SERVER ANSWERED, never before: a log that narrates intentions lies the
        moment one is refused. The refusal below is logged for the same reason — it is a fact.
      */
      onNote(`booked ${patient.name} at ${fmtIst(slot.start)}`, "ok");
      setPending(null);
      await queryClient.invalidateQueries({ queryKey: ["opd", "appointments", doctorId, date] });
      await queryClient.invalidateQueries({ queryKey: ["opd", "slots", doctorId, date] });
    } catch (e) {
      // The refusal stays in the dialog, where the Confirm was (FD-22's rule).
      setBookError(opdErrorMessage(e));
      onNote(`booking REFUSED — ${opdErrorMessage(e)}`, "err");
    } finally {
      setBusy(false);
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

  /*
    UX-AUDIT 2026-09-28 — WHO FIRST, THEN WHEN. The patient search used to sit BELOW the slot grid,
    so a clerk met the times first, clicked one, and nothing happened and nothing said why. The
    artboard (`Appointment.dc.html`) opens with a "Booking for" card; this panel does the same, and
    the grid below it stays locked, with the reason in words, until that card holds a patient.

    UX-AUDIT 2026-09-28 — A REAL <table>. The day list was four flex-grow divs per row, so column
    widths followed each row's content: a checked-in row, whose actions cell is empty, put its
    time under the Status header. A table's columns are the same width in every row by definition.
  */
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {/* `min-w-0`: a grid item's automatic minimum is its min-content, and at 390 that pushed this
          column to 414 px — the page scrolled sideways under a clerk's thumb (UX-AUDIT 2026-09-28). */}
      <div className="min-w-0 space-y-3">
        <div className="box" data-testid="booking-for" style={{ padding: "12px 14px" }}>
          <span className="tag">{t("opdAppt.bookingFor")}</span>
          {patient === null ? (
            <div style={{ marginTop: 8 }}><PatientPicker onPick={setPatient} /></div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{patient.name ?? "—"}</div>
                <div className="mo" style={{ fontSize: 12, color: "var(--dim)" }}>{patient.uhid}</div>
              </div>
              <button type="button" className="sec" onClick={() => { setPatient(null); }}>{t("opdAppt.changePatient")}</button>
            </div>
          )}
          {patient !== null && <PatientBookings patient={patient} doctors={allDoctors} queryClient={queryClient} onNote={onNote} />}
        </div>
        <h2 style={{ fontSize: 13, fontWeight: 700 }}>{t("opdAppt.slots")}</h2>
        {doctorId === "" && <p style={{ fontSize: 12, color: "var(--dim)" }}>{t("opdAppt.pickDoctorHint")}</p>}
        {doctorId !== "" && slots.data === undefined && <p>{t("app.loading")}</p>}
        {doctorId !== "" && slots.data !== undefined && patient === null && (
          <p data-testid="slots-locked-hint" style={{ fontSize: 12, color: "var(--gold)" }}>{t("opdAppt.choosePatientFirst")}</p>
        )}
        {doctorId !== "" && slots.data !== undefined && (
          <SlotGrid
            slots={slots.data.slots}
            locked={patient === null}
            onPick={(slot) => { setBookError(null); setPending(slot); }}
          />
        )}
      </div>
      <div className="min-w-0 space-y-2">
        <h2 style={{ fontSize: 13, fontWeight: 700 }}>{t("opdAppt.bookings")}</h2>
        {doctorId !== "" && appointments.data !== undefined && appointments.data.items.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--dim)" }}>{t("opdAppt.none")}</p>
        )}
        {doctorId !== "" && appointments.data !== undefined && appointments.data.items.length > 0 && (
          <div className="box" style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th className="tag">{t("opd.labels.patient")}</th>
                  <th className="tag">{t("opdAppt.time")}</th>
                  <th className="tag">{t("opd.labels.status")}</th>
                  <th className="tag">{t("opd.labels.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {appointments.data.items.map((apt) => (
                  <tr key={apt.id}>
                    <td>
                      <span className="block">{patientLabel(apt.patient)}</span>
                      <span className="block mo" style={{ fontSize: 11, color: "var(--dim)" }}>{apt.patient?.uhid ?? "—"}</span>
                    </td>
                    <td className="mo">{fmtIst(apt.slotStart)}</td>
                    <td><StatusBadge status={apt.status} /></td>
                    <td>
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open && !busy) setPending(null); }}>
        <DialogContent className="pp">
          <DialogHeader><DialogTitle>{t("opdAppt.confirmTitle")}</DialogTitle></DialogHeader>
          {pending !== null && patient !== null && (
            <dl className="confirm-list">
              <dt className="tag">{t("opd.labels.patient")}</dt>
              <dd><span className="block">{patient.name ?? "—"}</span><span className="block mo" style={{ fontSize: 12, color: "var(--dim)" }}>{patient.uhid}</span></dd>
              <dt className="tag">{t("opd.labels.doctor")}</dt>
              <dd>{doctor?.displayName ?? "—"}</dd>
              <dt className="tag">{t("opd.labels.date")}</dt>
              <dd className="mo">{date}</dd>
              <dt className="tag">{t("opdAppt.time")}</dt>
              <dd className="mo">{fmtIst(pending.start)}</dd>
            </dl>
          )}
          <ErrorLine message={bookError} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="sec" disabled={busy} onClick={() => { setPending(null); }}>{t("opdAppt.cancel")}</button>
            <button type="button" className="pri" disabled={busy} onClick={() => { if (pending !== null) void book(pending); }}>
              {t("opdAppt.confirmBooking")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
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
        // UX-AUDIT 2026-09-28 — a real <table>, for the same reason as the day list's.
        <div className="box" style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="tag">{t("opd.labels.patient")}</th>
                <th className="tag">{t("opd.labels.doctor")}</th>
                <th className="tag">{t("opdAppt.time")}</th>
                <th className="tag">{t("opd.labels.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {items.data.items.map((apt) => (
                <tr key={apt.id}>
                  <td>
                    <span className="block">{patientLabel(apt.patient)}</span>
                    <span className="block mo" style={{ fontSize: 11, color: "var(--dim)" }}>{apt.patient?.uhid ?? "—"}</span>
                  </td>
                  <td>{doctorName(apt.doctorId)}</td>
                  <td className="mo">{fmtIst(apt.slotStart)}</td>
                  <td><RescheduleDialog appointment={apt} queryClient={queryClient} onNote={onNote} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ——— screen ———

export function OpdAppointments(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  /*
    A LINK MAY NAME THE BOOK TO OPEN (owner, 2026-10-01): the profile's Edit sends
    `?patientId=&departmentId=&doctorId=&date=`, so the screen opens on that doctor's day with the
    patient already in the card. Read once from the address, not through the router: the address is
    the whole of the state, and this screen is mounted in tests with no router at all.
  */
  const linked = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    const day = q.get("date") ?? "";
    return {
      patientId: q.get("patientId"), departmentId: q.get("departmentId") ?? "", doctorId: q.get("doctorId") ?? "",
      date: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : todayIst(),
    };
  }, []);
  const filters = useForm<{ departmentId: string; doctorId: string; date: string }>({
    defaultValues: { departmentId: linked.departmentId, doctorId: linked.doctorId, date: linked.date },
  });
  const departmentId = filters.watch("departmentId");
  const doctorId = filters.watch("doctorId");
  const date = filters.watch("date");
  const setValue = filters.setValue;

  // Switching department invalidates the previously selected doctor — a stale id from the OLD
  // department's list must not silently keep driving the slot/day-list queries below.
  // …and only when the department has actually CHANGED: a linked doctor arrives WITH their
  // department and must survive the first render. Compared by value rather than by a "first run"
  // flag, which a development double-mount flips before the screen has drawn — found in the browser.
  const departmentWas = useRef(departmentId);
  useEffect(() => {
    if (departmentWas.current === departmentId) return;
    departmentWas.current = departmentId;
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
  const note = useCallback((text: string, kind: AgentLine["kind"] = "did") => {
    setLog((prev) => logged(prev, text, kind));
  }, []);

  // `?? []` mints a NEW array on every render, and both of these are read by the agent's `ask`
  // callback below — an unmemoised fallback would rebuild that callback on every keystroke.
  const departmentItems = useMemo(() => departments.data?.items ?? [], [departments.data]);
  const doctorItems = doctors.data?.items ?? [];
  const allDoctorItems = useMemo(() => allDoctors.data?.items ?? [], [allDoctors.data]);
  const roomItems = rooms.data?.items ?? [];

  /**
   * ═══ FD-COPILOT — WHAT THIS SCREEN KNOWS, WHICH IS NOW THE *FALLBACK* RATHER THAN THE WHOLE ═══
   *
   * This chain used to be the entire agent, and its old header said so: *"There is no model call and
   * no guess."* It is unchanged in what it answers and demoted in when it runs. `useCopilot` asks
   * the SERVER first — which can say whether a patient anywhere in the hospital has been seen, how
   * the queues look, and can pull the clerk's day report — and this runs only when the server says
   * it did not understand.
   *
   * That split is the right one and it is not a compromise: these four answers are about the
   * FILTERS ON THIS SCREEN, which no server can see. "Which doctor's book am I looking at" is a
   * question about a dropdown. The hospital's questions go to the hospital; the screen's stay here.
   */
  const localAnswer = useCallback((question: string): string | null => {
    const q = question.trim().toLowerCase();
    if (q === "") return null;
    const doctorName = allDoctorItems.find((doc) => doc.id === doctorId)?.displayName ?? null;
    if (q.includes("doctor") && doctorName !== null) {
      return `You are looking at ${doctorName}'s book for ${date}. — from the filters on this screen.`;
    }
    if (q.includes("department")) {
      return departmentId === ""
        ? "No department is picked, so the doctor list is empty. Pick one above. — from the filters on this screen."
        : `${departmentItems.find((dep) => dep.id === departmentId)?.name ?? "That department"} has ${String(doctorItems.length)} ${doctorItems.length === 1 ? "doctor" : "doctors"} on file. — from the doctor master.`;
    }
    if (q.includes("today") || q.includes("date")) {
      return `This book is showing ${date}; today is ${todayIst()}. Check-in is only offered on today's bookings. — from the filters and the K42 rule.`;
    }
    return null;
  }, [allDoctorItems, doctorId, date, departmentId, departmentItems, doctorItems.length]);

  /*
    ═══ THE NAMES THIS SCREEN IS SHOWING — AND THIS SCREEN HAS NONE TO GIVE ═══

    The server masks identifiers by SHAPE (UHID, visit number, phone, long digit runs) and names by
    VALUE, from a list the screen supplies, because a name has no shape a pattern can find. This
    component is not the one that holds them: the day list and the rebooking rail each run their own
    query inside a child, so the only names in scope up here are doctors'.

    That is stated rather than quietly skipped, because it is the one gap in the guarantee. A clerk
    who types a UHID is covered completely; a clerk who types "has Farida been seen" on THIS screen
    sends that word to the router on a phrasebook miss. Closing it means lifting the appointment
    list to this component, or passing terms from the child — a real change with its own tests, not
    a line to sneak in here. `patient-detail.tsx` and Desk One both hold the name already and pass
    it when they are wired.
  */
  const copilot = useCopilot({ fallback: localAnswer, onNote: note, date });

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
    <PaperScreen>
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
              allDoctors={allDoctorItems} initialPatientId={linked.patientId}
              onNote={note}
            />
          ) : (
            <NeedsRebookingTab allDoctors={allDoctorItems} queryClient={queryClient} onNote={note} />
          )}
        </div>
      </div>

      {/*
        THE AGENT, along the bottom exactly as it is on the counter.

        FD-COPILOT changed what is behind it and this comment is rewritten rather than left to rot:
        it used to say "No model behind it — it answers from what is already on this screen", and
        that is no longer true. It now asks the server, which can answer about any patient, any
        queue and the clerk's own day, and falls back to this screen's own knowledge when the
        server does not recognise the question. The instant-and-true property survives: the
        phrasebook answers the common questions with no model call at all.
      */}
      <AgentDock
        answer={copilot.answer}
        log={log}
        onAsk={copilot.ask}
        placeholder={t("opdAppt.askPlaceholder")}
        idle={t("opdAppt.agentIdle")}
        panel={copilot.report === null ? undefined : (
          <CopilotReport report={copilot.report} onDismiss={copilot.dismissReport} />
        )}
      />
    </PaperScreen>
  );
}
