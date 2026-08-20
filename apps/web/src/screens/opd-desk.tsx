import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { FormProvider, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { listDepartments, listRooms, opdErrorMessage, todayIst } from "../lib/opd-api";
import type {
  OpdVisitType, WireAppointment, WireDepartment, WireDoctorSummary, WireOpenVisitResult,
  WireQueueEntryView, WireQueueView, WireRoom, WireTimelineItem,
} from "../lib/opd-api";
import { useRealtime } from "../lib/realtime";
import { PatientPicker } from "../components/patient-picker";
import type { PatientPickerHit } from "../components/patient-picker";
import { TokenSlip } from "../components/token-slip";
import type { TokenSlipProps } from "../components/token-slip";
import type { QrCardData } from "../components/qr-card";
import { FormKit, SelectField, TextField } from "../components/form-kit";
import { PatientPhoto } from "./registration-desk";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * The OPD desk (§11.1 / D2 / D3): the front office's one screen — walk-in visit opening with the
 * printed token slip, today's arrivals check-in, the live doctor board, the picked doctor's queue,
 * abandon-with-reason and the supervisor's E2 bulk queue transfer.
 *
 * Three standing rules shape this file:
 *  · THE SERVER IS AUTHORITATIVE. No response status is branched on beyond `api()`'s 2xx/non-2xx
 *    split (every POST here rides Nest's default 201), and NO client-side permission model exists:
 *    Transfer is rendered unconditionally and a 403 is rendered inline where the clerk can read it.
 *  · Every read is BOTH polled (15 s) AND realtime-subscribed (D6) — the push is a hint, so a missed
 *    frame costs seconds, never correctness.
 *  · ONE `.print-doc` at a time: the token slip REPLACES the desk view rather than sitting beside it,
 *    which is what keeps `styles.css`'s print isolation from ever printing two documents.
 */
const POLL_MS = 15_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * UTC instant → IST 'HH:MM'. Arithmetic, no Intl — the same technique as opd-api.ts's `todayIst`.
 * (Deliberately local: `opd-api.ts` is not in this task's Files list, so the appointments screen's
 * identical helper is duplicated rather than lifted.)
 */
function fmtIst(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

function patientLabel(p: { name: string | null; alias: string | null; restricted: boolean } | null | undefined): string {
  if (!p) return "—";
  return p.restricted ? (p.alias ?? "—") : (p.name ?? "—");
}

function ErrorLine({ message }: { message: string | null }): React.ReactElement | null {
  if (message === null) return null;
  return <p role="alert" className="text-sm text-red-600">{message}</p>;
}

type OpenVisitForm = {
  doctorId: string;
  intendedPayer: "self" | "tpa" | "pmjay" | "corporate";
  referralSource: "" | "internal_doctor" | "external_rmp" | "camp" | "other";
  referrerName: string;
};

type Opened = { slip: TokenSlipProps; visitType: OpdVisitType };

// ——— abandon: the reason is the rule (K45), mirrored from the server's `reason_required` ———

function AbandonDialog({
  entry, queryClient,
}: { entry: WireQueueEntryView; queryClient: QueryClient }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    // K45. This guard is the ONLY thing standing between an empty reason and a request: the button
    // is deliberately NOT disabled, so "no request was sent" can mean exactly one thing.
    if (reason.trim() === "") {
      setError(t("opdDesk.reasonRequired"));
      return;
    }
    setError(null);
    try {
      await api("POST", `/opd/visits/${entry.encounter.id}/abandon`, { reason: reason.trim() });
      setOpen(false);
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["opd", "queue"] });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid={`abandon-${entry.id}`}>{t("opdDesk.abandon")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("opdDesk.abandonTitle")}</DialogTitle></DialogHeader>
        <label className="block text-sm font-medium" htmlFor={`abandon-reason-${entry.id}`}>{t("opd.labels.reason")}</label>
        <input
          id={`abandon-reason-${entry.id}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded border px-2 py-1"
        />
        <ErrorLine message={error} />
        <Button onClick={() => void submit()}>{t("opdDesk.confirmAbandon")}</Button>
      </DialogContent>
    </Dialog>
  );
}

// ——— the E2 bulk transfer: §11.1 says consent, so consent is a precondition of the REQUEST (K44) ———

function TransferDialog({
  fromDoctorId, fromDoctorName, candidates, entries, serviceDate, queryClient,
}: {
  fromDoctorId: string; fromDoctorName: string; candidates: WireDoctorSummary[];
  entries: WireQueueEntryView[]; serviceDate: string; queryClient: QueryClient;
}): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [toDoctorId, setToDoctorId] = useState("");
  const [consented, setConsented] = useState(false);
  const [reason, setReason] = useState("");
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<number | null>(null);

  const toggleEntry = (id: string): void => {
    setEntryIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };

  const submit = async (): Promise<void> => {
    // K44. Consent gates the REQUEST, not just the message: without the tick nothing leaves the
    // browser. As with abandon the button is not disabled, so the refusal has a single cause.
    if (!consented) {
      setError(t("opdDesk.consentRequired"));
      return;
    }
    if (fromDoctorId === "" || toDoctorId === "") {
      setError(t("opdDesk.pickDoctorFirst"));
      return;
    }
    setError(null);
    setMoved(null);
    try {
      const res = await api<{ transferred: number; toSessionId: string }>("POST", "/opd/queues/transfer", {
        fromDoctorId,
        toDoctorId,
        serviceDate,
        ...(entryIds.length > 0 ? { entryIds } : {}),
        consented: true,
        reason,
      });
      setMoved(res.transferred);
      await queryClient.invalidateQueries({ queryKey: ["opd", "queue"] });
      await queryClient.invalidateQueries({ queryKey: ["opd", "queues", "summary"] });
    } catch (e) {
      // A 403 from `opd.queue.transfer` lands here like any other refusal and is READ BY THE CLERK.
      setError(opdErrorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* Rendered unconditionally — the UI holds no permission model (Plan 05 rule). */}
        <Button size="sm" variant="outline">{t("opdDesk.transfer")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("opdDesk.transferTitle")}</DialogTitle></DialogHeader>
        <p className="text-sm">{t("opdDesk.fromDoctor")}: {fromDoctorName === "" ? "—" : fromDoctorName}</p>
        <label className="block text-sm font-medium" htmlFor="transfer-to">{t("opdDesk.toDoctor")}</label>
        <select
          id="transfer-to"
          value={toDoctorId}
          onChange={(e) => setToDoctorId(e.target.value)}
          className="w-full rounded border px-2 py-1"
        >
          <option value="">{t("opdDesk.pickToDoctor")}</option>
          {candidates.filter((c) => c.doctor.id !== fromDoctorId).map((c) => (
            <option key={c.doctor.id} value={c.doctor.id}>{c.doctor.displayName}</option>
          ))}
        </select>
        <label className="block text-sm font-medium" htmlFor="transfer-reason">{t("opd.labels.reason")}</label>
        <input
          id="transfer-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded border px-2 py-1"
        />
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t("opdDesk.entries")}</legend>
          {entries.map((e) => (
            <label key={e.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid={`transfer-entry-${e.id}`}
                checked={entryIds.includes(e.id)}
                onChange={() => toggleEntry(e.id)}
              />
              {e.tokenNo} · {patientLabel(e.patient)}
            </label>
          ))}
        </fieldset>
        <div className="flex items-center gap-2 text-sm">
          <input
            id="transfer-consent"
            type="checkbox"
            checked={consented}
            onChange={(e) => setConsented(e.target.checked)}
          />
          <label htmlFor="transfer-consent">{t("opdDesk.consentGiven")}</label>
        </div>
        <ErrorLine message={error} />
        {moved !== null && <p className="text-sm text-emerald-700">{t("opdDesk.transferred", { n: moved })}</p>}
        <Button onClick={() => void submit()}>{t("opdDesk.confirmTransfer")}</Button>
      </DialogContent>
    </Dialog>
  );
}

// ——— screen ———

export function OpdDesk(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const today = todayIst();

  const [patient, setPatient] = useState<PatientPickerHit | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const [departmentId, setDepartmentId] = useState("");
  const [selectedDoctorId, setSelectedDoctorId] = useState("");
  const [opened, setOpened] = useState<Opened | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [checkInError, setCheckInError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const form = useForm<OpenVisitForm>({
    defaultValues: { doctorId: "", intendedPayer: "self", referralSource: "", referrerName: "" },
  });

  /**
   * "Next patient" refocuses the picker's search box. The `data-search-input` tag that `/` focuses
   * (keyboard.tsx) now lives ON the picker's own input — Plan 08 T13 absorbed that debt — so this
   * effect no longer stamps it from outside and only the refocus remains.
   */
  useEffect(() => {
    const input = pickerRef.current?.querySelector("input");
    if (!input) return;
    if (pickerKey > 0) input.focus();
  }, [pickerKey]);

  const departments = useQuery({ queryKey: ["opd", "departments"], queryFn: listDepartments, refetchInterval: POLL_MS });
  const rooms = useQuery({ queryKey: ["opd", "rooms"], queryFn: listRooms, refetchInterval: POLL_MS });
  const summary = useQuery({
    queryKey: ["opd", "queues", "summary", departmentId, today],
    queryFn: () => api<{ items: WireDoctorSummary[] }>(
      "GET", `/opd/queues/summary?departmentId=${departmentId}&serviceDate=${today}`,
    ),
    enabled: departmentId !== "",
    refetchInterval: POLL_MS,
  });
  const arrivals = useQuery({
    queryKey: ["opd", "appointments", "arrivals", patient?.id ?? "", today],
    queryFn: () => api<{ items: WireAppointment[] }>(
      "GET", `/opd/appointments?patientId=${patient?.id ?? ""}&serviceDate=${today}`,
    ),
    enabled: patient !== null,
    refetchInterval: POLL_MS,
  });
  const timeline = useQuery({
    queryKey: ["opd", "timeline", patient?.id ?? ""],
    queryFn: () => api<{ items: WireTimelineItem[] }>("GET", `/opd/patients/${patient?.id ?? ""}/timeline`),
    enabled: patient !== null,
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
  useRealtime(selectedDoctorId === "" ? [] : [`queue:${selectedDoctorId}:${today}`], () => {
    void queryClient.invalidateQueries({ queryKey: ["opd", "queue", selectedDoctorId, today] });
    void queryClient.invalidateQueries({ queryKey: ["opd", "queues", "summary"] });
  });

  const departmentItems: WireDepartment[] = departments.data?.items ?? [];
  const roomItems: WireRoom[] = rooms.data?.items ?? [];
  const summaryItems: WireDoctorSummary[] = summary.data?.items ?? [];
  const department = departmentItems.find((d) => d.id === departmentId) ?? null;
  const roomCodeOf = (roomId: string | null): string | null => roomItems.find((r) => r.id === roomId)?.code ?? null;
  const doctorNameOf = (id: string): string => summaryItems.find((s) => s.doctor.id === id)?.doctor.displayName ?? "";
  const queueView: WireQueueView | null =
    queue.data !== undefined && queue.data.session !== null ? queue.data : null;
  const orderedEntries = queueView?.ordered ?? [];

  const slipFor = (result: WireOpenVisitResult, qr: QrCardData, doctorId: string): Opened => ({
    slip: {
      tokenNo: result.tokenNo,
      roomCode: roomCodeOf(result.roomId),
      doctorName: doctorNameOf(doctorId),
      departmentCode: department?.code ?? "",
      departmentName: department?.name ?? "",
      serviceDate: today,
      patient: { uhid: qr.uhid, name: qr.name },
      qrPayload: qr.payload,
      visitType: result.visitType,
    },
    visitType: result.visitType,
  });

  const openVisit = async (doctorId: string): Promise<void> => {
    if (patient === null || departmentId === "" || doctorId === "") {
      setOpenError(t("opdDesk.pickPatientHint"));
      return;
    }
    setOpenError(null);
    const values = form.getValues();
    const body: Record<string, unknown> = {
      patientId: patient.id, departmentId, doctorId, intendedPayer: values.intendedPayer,
    };
    // The referral pair travels ONLY when the clerk chose one — a blank select is not "self".
    if (values.referralSource !== "") {
      body.referralSource = values.referralSource;
      if (values.referrerName.trim() !== "") body.referrerName = values.referrerName.trim();
    }
    try {
      const result = await api<WireOpenVisitResult>("POST", "/opd/visits", body);
      const qr = await api<QrCardData>("GET", `/patients/${patient.id}/qr`);
      setOpened(slipFor(result, qr, doctorId));
      await queryClient.invalidateQueries({ queryKey: ["opd", "queues", "summary"] });
      await queryClient.invalidateQueries({ queryKey: ["opd", "queue"] });
    } catch (e) {
      setOpenError(opdErrorMessage(e));
    }
  };

  const checkIn = async (appointment: WireAppointment): Promise<void> => {
    if (patient === null) return;
    setCheckInError(null);
    try {
      const result = await api<WireOpenVisitResult>("POST", `/opd/appointments/${appointment.id}/check-in`);
      const qr = await api<QrCardData>("GET", `/patients/${patient.id}/qr`);
      setOpened(slipFor(result, qr, appointment.doctorId));
      await queryClient.invalidateQueries({ queryKey: ["opd", "appointments"] });
      await queryClient.invalidateQueries({ queryKey: ["opd", "queues", "summary"] });
    } catch (e) {
      setCheckInError(opdErrorMessage(e));
    }
  };

  const nextPatient = (): void => {
    setOpened(null);
    setPatient(null);
    setOpenError(null);
    setCheckInError(null);
    form.reset({ doctorId: "", intendedPayer: "self", referralSource: "", referrerName: "" });
    setPickerKey((k) => k + 1);
  };

  // The slip REPLACES the desk: exactly one `.print-doc` can ever be mounted (print isolation).
  if (opened !== null) {
    return (
      <div className="space-y-4 p-6">
        <div className="no-print flex items-center gap-3">
          <Badge data-testid="visit-type-badge" variant={opened.visitType === "revisit" ? "default" : "outline"}>
            {t(`opd.visitType.${opened.visitType}`)}
          </Badge>
          {opened.visitType === "revisit" && (
            <span className="text-sm text-emerald-700">{t("opdDesk.freeFollowUp")}</span>
          )}
        </div>
        <TokenSlip {...opened.slip} />
        <Button variant="outline" className="no-print" onClick={nextPatient}>{t("opdDesk.nextPatient")}</Button>
      </div>
    );
  }

  const lastVisit = timeline.data?.items[0];

  return (
    <div className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("opdDesk.title")}</h1>
      <div className="grid gap-6 lg:grid-cols-3">
        {/* (a) who is at the desk: picker, today's arrivals, the last-visit hint */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">{t("opdDesk.pickPatient")}</h2>
          <div ref={pickerRef}>
            <PatientPicker key={pickerKey} onPick={setPatient} />
          </div>
          {patient !== null && (
            <div className="flex items-center gap-3 rounded border p-2">
              <PatientPhoto patientId={patient.id} className="h-12 w-10 rounded" />
              <div className="min-w-0">
                <p className="text-sm">{t("opdDesk.selectedPatient")}: {patient.name ?? "—"}</p>
                <p className="font-mono text-xs text-neutral-600">{patient.uhid}</p>
              </div>
            </div>
          )}
          {patient !== null && (
            <p className="text-sm text-neutral-600">
              {lastVisit === undefined
                ? t("opdDesk.noHistory")
                : t("opdDesk.lastSeen", { date: lastVisit.serviceDate, department: lastVisit.departmentName ?? "—" })}
            </p>
          )}
          <h2 className="pt-2 text-sm font-semibold">{t("opdDesk.arrivals")}</h2>
          <div data-testid="arrivals" className="space-y-2">
            {patient === null && <p className="text-sm text-neutral-500">{t("opdDesk.pickPatientHint")}</p>}
            {patient !== null && (arrivals.data?.items ?? []).length === 0 && (
              <p className="text-sm text-neutral-500">{t("opdDesk.noArrivals")}</p>
            )}
            {(arrivals.data?.items ?? []).map((apt) => (
              <div key={apt.id} className="flex items-center gap-2 rounded border p-2 text-sm">
                <span>{fmtIst(apt.slotStart)}</span>
                <Badge variant="outline">{t(`opdAppt.status.${apt.status}`)}</Badge>
                {apt.status === "booked" && (
                  <Button size="sm" data-testid={`checkin-${apt.id}`} onClick={() => void checkIn(apt)}>
                    {t("opdDesk.checkIn")}
                  </Button>
                )}
              </div>
            ))}
            <ErrorLine message={checkInError} />
          </div>
        </div>

        {/* (b) the department's doctor board + the walk-in details the open posts */}
        <div className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="desk-department">{t("opd.labels.department")}</label>
          <select
            id="desk-department"
            value={departmentId}
            onChange={(e) => {
              setDepartmentId(e.target.value);
              setSelectedDoctorId("");
            }}
            className="w-full rounded border px-2 py-1"
          >
            <option value="">{t("opdDesk.pickDepartment")}</option>
            {departmentItems.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>

          <FormProvider {...form}>
            <FormKit onSubmit={() => openVisit(form.getValues().doctorId)}>
              <SelectField
                name="doctorId"
                label={t("opd.labels.doctor")}
                options={[
                  { value: "", label: t("opdDesk.pickDoctor") },
                  ...summaryItems.map((s) => ({ value: s.doctor.id, label: s.doctor.displayName })),
                ]}
              />
              <SelectField
                name="intendedPayer"
                label={t("opdDesk.intendedPayer")}
                options={[
                  { value: "self", label: t("opdDesk.payer.self") },
                  { value: "tpa", label: t("opdDesk.payer.tpa") },
                  { value: "pmjay", label: t("opdDesk.payer.pmjay") },
                  { value: "corporate", label: t("opdDesk.payer.corporate") },
                ]}
              />
              <SelectField
                name="referralSource"
                label={t("opdDesk.referralSource")}
                options={[
                  { value: "", label: t("opdDesk.referral.none") },
                  { value: "internal_doctor", label: t("opdDesk.referral.internal_doctor") },
                  { value: "external_rmp", label: t("opdDesk.referral.external_rmp") },
                  { value: "camp", label: t("opdDesk.referral.camp") },
                  { value: "other", label: t("opdDesk.referral.other") },
                ]}
              />
              <TextField name="referrerName" label={t("opdDesk.referrerName")} />
            </FormKit>
          </FormProvider>
          <ErrorLine message={openError} />

          <h2 className="pt-2 text-sm font-semibold">{t("opdDesk.board")}</h2>
          {departmentId === "" && <p className="text-sm text-neutral-500">{t("opdDesk.pickDepartmentHint")}</p>}
          <div className="space-y-2">
            {summaryItems.map((s) => (
              <div key={s.doctor.id} data-testid={`board-row-${s.doctor.id}`} className="rounded border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid={`board-pick-${s.doctor.id}`}
                    onClick={() => setSelectedDoctorId(s.doctor.id)}
                    className="text-sm font-medium hover:underline"
                  >
                    {s.doctor.displayName}
                  </button>
                  <Badge variant="outline">{t(`opd.sessionStatus.${s.status}`)}</Badge>
                  <span className="text-xs text-neutral-600">{t("opd.labels.room")}: {s.roomCode ?? "—"}</span>
                  <span className="text-xs text-neutral-600">
                    {t("opdDesk.waiting")}: <span data-testid={`board-waiting-${s.doctor.id}`}>{s.waitingCount}</span>
                  </span>
                  {s.nowServing !== null && (
                    <span className="text-xs text-neutral-600">{t("opdDesk.nowServing")}: {s.nowServing}</span>
                  )}
                  <Button
                    size="sm"
                    data-testid={`open-visit-${s.doctor.id}`}
                    onClick={() => void openVisit(s.doctor.id)}
                  >
                    {t("opdDesk.openVisit")}
                  </Button>
                </div>
                {!s.scheduledToday && (
                  <p className="pt-1 text-xs text-amber-700">{t("opdDesk.notScheduledToday")}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* (c) the picked doctor's queue + the two desk actions */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t("opdDesk.queue")}</h2>
            <TransferDialog
              fromDoctorId={selectedDoctorId}
              fromDoctorName={doctorNameOf(selectedDoctorId)}
              candidates={summaryItems}
              entries={orderedEntries}
              serviceDate={today}
              queryClient={queryClient}
            />
          </div>
          {selectedDoctorId === "" && <p className="text-sm text-neutral-500">{t("opdDesk.pickDoctorHint")}</p>}
          {selectedDoctorId !== "" && queue.data !== undefined && queueView === null && (
            <p className="text-sm text-neutral-500">{t("opdDesk.noSession")}</p>
          )}
          {queueView !== null && orderedEntries.length === 0 && (
            <p className="text-sm text-neutral-500">{t("opdDesk.emptyQueue")}</p>
          )}
          {queueView !== null && orderedEntries.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("opd.labels.token")}</TableHead>
                  <TableHead>{t("opd.labels.patient")}</TableHead>
                  <TableHead>{t("opd.labels.status")}</TableHead>
                  <TableHead>{t("opd.labels.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orderedEntries.map((e) => (
                  <TableRow key={e.id} data-testid={`queue-row-${e.id}`}>
                    <TableCell className="tabular-nums">{e.tokenNo}</TableCell>
                    <TableCell>
                      <span className="block">{patientLabel(e.patient)}</span>
                      <span className="block font-mono text-xs text-neutral-600">{e.patient?.uhid ?? "—"}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{t(`opd.queueStatus.${e.status}`)}</Badge>
                      {e.queueClass !== null && (
                        <Badge variant="secondary">{t(`opd.queueClass.${e.queueClass}`)}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <AbandonDialog entry={e} queryClient={queryClient} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}
