import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { FormProvider, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { listDepartments, listDoctors, listRooms, opdErrorMessage, todayIst } from "../lib/opd-api";
import type { WireAppointment, WireDepartment, WireDoctor, WireOpenVisitResult, WireRoom, WireSlot } from "../lib/opd-api";
import { useRealtime } from "../lib/realtime";
import { PatientPicker } from "../components/patient-picker";
import type { PatientPickerHit } from "../components/patient-picker";
import { TokenSlip } from "../components/token-slip";
import type { TokenSlipProps } from "../components/token-slip";
import type { QrCardData } from "../components/qr-card";
import { SelectField, TextField } from "../components/form-kit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  appointment, queryClient,
}: { appointment: WireAppointment; queryClient: QueryClient }): React.ReactElement {
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
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["opd", "appointments"] });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">{t("opdAppt.reschedule")}</Button>
      </DialogTrigger>
      <DialogContent>
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
  appointment, queryClient,
}: { appointment: WireAppointment; queryClient: QueryClient }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      await api("POST", `/opd/appointments/${appointment.id}/cancel`, { reason });
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
        <Button size="sm" variant="outline">{t("opdAppt.cancel")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("opdAppt.cancel")}</DialogTitle></DialogHeader>
        <label className="block text-sm font-medium" htmlFor={`cancel-reason-${appointment.id}`}>{t("opd.labels.reason")}</label>
        <input
          id={`cancel-reason-${appointment.id}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded border px-2 py-1"
        />
        <ErrorLine message={error} />
        <Button onClick={() => void submit()} disabled={reason.trim() === ""}>{t("opdAppt.confirmCancel")}</Button>
      </DialogContent>
    </Dialog>
  );
}

function StatusBadge({ status }: { status: WireAppointment["status"] }): React.ReactElement {
  const { t } = useTranslation();
  const variant = status === "cancelled" || status === "no_show" ? "destructive" : status === "checked_in" ? "default" : "outline";
  return <Badge variant={variant}>{t(`opdAppt.status.${status}`)}</Badge>;
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
      <Button size="sm" data-testid={`checkin-${appointment.id}`} disabled={disabled} onClick={() => void checkIn()}>
        {t("opdAppt.checkIn")}
      </Button>
      <ErrorLine message={error} />
    </div>
  );
}

// ——— the Day tab: slot grid + patient picker (left), this day's bookings (right) ———

function DayTab({
  departmentId, doctorId, date, departments, doctors, rooms, queryClient,
}: {
  departmentId: string; doctorId: string; date: string;
  departments: WireDepartment[]; doctors: WireDoctor[]; rooms: WireRoom[]; queryClient: QueryClient;
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
      await queryClient.invalidateQueries({ queryKey: ["opd", "appointments", doctorId, date] });
      await queryClient.invalidateQueries({ queryKey: ["opd", "slots", doctorId, date] });
    } catch (e) {
      setBookError(opdErrorMessage(e));
    }
  };

  if (slip !== null) {
    return (
      <div className="space-y-4">
        <TokenSlip {...slip} />
        <Button variant="outline" className="no-print" onClick={() => setSlip(null)}>{t("opdAppt.backToList")}</Button>
      </div>
    );
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-2">
        <h2 className="text-sm font-semibold">{t("opdAppt.slots")}</h2>
        {doctorId === "" && <p className="text-sm text-neutral-500">{t("opdAppt.pickDoctorHint")}</p>}
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
        <h2 className="text-sm font-semibold">{t("opdAppt.bookings")}</h2>
        {doctorId !== "" && appointments.data !== undefined && appointments.data.items.length === 0 && (
          <p className="text-sm text-neutral-500">{t("opdAppt.none")}</p>
        )}
        {doctorId !== "" && appointments.data !== undefined && appointments.data.items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("opd.labels.patient")}</TableHead>
                <TableHead>{t("opdAppt.time")}</TableHead>
                <TableHead>{t("opd.labels.status")}</TableHead>
                <TableHead>{t("opd.labels.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {appointments.data.items.map((apt) => (
                <TableRow key={apt.id}>
                  <TableCell>
                    <span className="block">{patientLabel(apt.patient)}</span>
                    <span className="block font-mono text-xs text-neutral-600">{apt.patient?.uhid ?? "—"}</span>
                  </TableCell>
                  <TableCell>{fmtIst(apt.slotStart)}</TableCell>
                  <TableCell><StatusBadge status={apt.status} /></TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {(apt.status === "booked" || apt.status === "needs_rebooking") && (
                        <RescheduleDialog appointment={apt} queryClient={queryClient} />
                      )}
                      {apt.status === "booked" && <CancelDialog appointment={apt} queryClient={queryClient} />}
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

// ——— the needs-rebooking worklist: the leave cascade's landing page, across every doctor ———

function NeedsRebookingTab({ allDoctors, queryClient }: { allDoctors: WireDoctor[]; queryClient: QueryClient }): React.ReactElement {
  const { t } = useTranslation();
  const items = useQuery({
    queryKey: ["opd", "appointments", "needsRebooking"],
    queryFn: () => api<{ items: WireAppointment[] }>("GET", "/opd/appointments?needsRebooking=true"),
    refetchInterval: POLL_MS,
  });
  const doctorName = (id: string): string => allDoctors.find((d) => d.id === id)?.displayName ?? id;

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">{t("opdAppt.needsRebooking")}</h2>
      {items.data !== undefined && items.data.items.length === 0 && (
        <p className="text-sm text-neutral-500">{t("opdAppt.none")}</p>
      )}
      {items.data !== undefined && items.data.items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("opd.labels.patient")}</TableHead>
              <TableHead>{t("opd.labels.doctor")}</TableHead>
              <TableHead>{t("opdAppt.time")}</TableHead>
              <TableHead>{t("opd.labels.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.data.items.map((apt) => (
              <TableRow key={apt.id}>
                <TableCell>
                  <span className="block">{patientLabel(apt.patient)}</span>
                  <span className="block font-mono text-xs text-neutral-600">{apt.patient?.uhid ?? "—"}</span>
                </TableCell>
                <TableCell>{doctorName(apt.doctorId)}</TableCell>
                <TableCell>{fmtIst(apt.slotStart)}</TableCell>
                <TableCell><RescheduleDialog appointment={apt} queryClient={queryClient} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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

  const departmentItems = departments.data?.items ?? [];
  const doctorItems = doctors.data?.items ?? [];
  const allDoctorItems = allDoctors.data?.items ?? [];
  const roomItems = rooms.data?.items ?? [];

  return (
    <div className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("opdAppt.title")}</h1>
      <FormProvider {...filters}>
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            name="departmentId"
            label={t("opd.labels.department")}
            className="max-w-xs"
            options={[{ value: "", label: t("opdAppt.pickDepartment") }, ...departmentItems.map((d) => ({ value: d.id, label: d.name }))]}
          />
          <SelectField
            name="doctorId"
            label={t("opd.labels.doctor")}
            className="max-w-xs"
            options={[{ value: "", label: t("opdAppt.pickDoctor") }, ...doctorItems.map((d) => ({ value: d.id, label: d.displayName }))]}
          />
          <TextField name="date" label={t("opd.labels.date")} type="date" className="max-w-[10rem]" />
        </div>
      </FormProvider>
      <Tabs defaultValue="day">
        <TabsList>
          <TabsTrigger value="day">{t("opdAppt.tabs.day")}</TabsTrigger>
          <TabsTrigger value="needsRebooking">{t("opdAppt.tabs.needsRebooking")}</TabsTrigger>
        </TabsList>
        <TabsContent value="day">
          <DayTab
            departmentId={departmentId} doctorId={doctorId} date={date}
            departments={departmentItems} doctors={doctorItems} rooms={roomItems} queryClient={queryClient}
          />
        </TabsContent>
        <TabsContent value="needsRebooking">
          <NeedsRebookingTab allDoctors={allDoctorItems} queryClient={queryClient} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
