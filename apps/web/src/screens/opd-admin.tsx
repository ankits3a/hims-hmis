import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { FormProvider, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import {
  listDepartments, listDoctorSchedules, listDoctors, listLeaves, listRooms, opdErrorMessage, todayIst,
} from "../lib/opd-api";
import type { WireDepartment, WireDoctor, WireLeave, WireRoom, WireSchedule } from "../lib/opd-api";
import { FormKit, SelectField, TextField } from "../components/form-kit";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { AgentDock, logged } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";
/*
  ALIASED ON IMPORT so the four tabs' JSX does not churn: the elements are the same five, the paint
  is the design system's, and a diff of this file shows what actually changed rather than 120 lines
  of renamed tags.
*/
import {
  DeskTBody as TableBody, DeskTD as TableCell, DeskTH as TableHead, DeskTHead as TableHeader,
  DeskTR as TableRow, DeskTable as Table, TabStrip,
} from "../components/desk-fields";

/**
 * OPD masters (D7): departments, rooms, doctors, weekly schedules and leaves — the data every other
 * OPD screen reads. The read models are polled (D6: realtime pushes are hints; this surface has no
 * topic of its own), the server stays authoritative for every rule, and nothing here hides an action
 * behind a guessed role — the button renders, the server 403s, the refusal renders inline.
 */
const POLL_MS = 15_000;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const HHMM = /^\d{2}:\d{2}$/;

function ErrorLine({ message }: { message: string | null }): React.ReactElement | null {
  if (message === null) return null;
  return <p role="alert" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{message}</p>;
}

function ActiveToggle({ active, onToggle }: { active: boolean; onToggle: () => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <button type="button" className="sec" style={{ padding: "0 9px", height: 25, fontSize: 11 }} onClick={onToggle}>
      {active ? t("opd.actions.deactivate") : t("opd.actions.activate")}
    </button>
  );
}

// ——— departments ———

const departmentSchema = z.object({ code: z.string().min(1), name: z.string().min(1) });
type DepartmentValues = z.infer<typeof departmentSchema>;

function DepartmentsTab({ items, queryClient }: { items: WireDepartment[]; queryClient: QueryClient }): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<DepartmentValues>({ resolver: zodResolver(departmentSchema), defaultValues: { code: "", name: "" } });

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ["opd", "departments"] });

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await api("POST", "/opd/departments", { code: v.code, name: v.name });
      form.reset({ code: "", name: "" });
      await refresh();
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  });

  const toggle = async (row: WireDepartment): Promise<void> => {
    setError(null);
    try {
      await api("PATCH", `/opd/departments/${row.id}`, { active: !row.active });
      await refresh();
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 22, alignItems: "start" }}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("opd.labels.code")}</TableHead>
            <TableHead>{t("opd.labels.name")}</TableHead>
            <TableHead>{t("opd.labels.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((d) => (
            <TableRow key={d.id}>
              <TableCell className="mo">{d.code}</TableCell>
              <TableCell>{d.name}</TableCell>
              <TableCell><ActiveToggle active={d.active} onToggle={() => void toggle(d)} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <FormProvider {...form}>
        <FormKit onSubmit={submit}>
          <h2 className="tag" style={{ margin: 0 }}>{t("opdAdmin.newDepartment")}</h2>
          <TextField name="code" label={t("opd.labels.code")} />
          <TextField name="name" label={t("opd.labels.name")} />
          <ErrorLine message={error} />
          <button type="submit" className="pri">{t("opdAdmin.addDepartment")}</button>
        </FormKit>
      </FormProvider>
    </div>
  );
}

// ——— rooms ———

const roomSchema = z.object({ code: z.string().min(1), name: z.string().min(1), floor: z.string() });
type RoomValues = z.infer<typeof roomSchema>;

function RoomsTab({ items, queryClient }: { items: WireRoom[]; queryClient: QueryClient }): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<RoomValues>({ resolver: zodResolver(roomSchema), defaultValues: { code: "", name: "", floor: "" } });

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ["opd", "rooms"] });

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const body: { code: string; name: string; floor?: string } = { code: v.code, name: v.name };
      if (v.floor.trim() !== "") body.floor = v.floor.trim();
      await api("POST", "/opd/rooms", body);
      form.reset({ code: "", name: "", floor: "" });
      await refresh();
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  });

  const toggle = async (row: WireRoom): Promise<void> => {
    setError(null);
    try {
      await api("PATCH", `/opd/rooms/${row.id}`, { active: !row.active });
      await refresh();
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 22, alignItems: "start" }}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("opd.labels.code")}</TableHead>
            <TableHead>{t("opd.labels.name")}</TableHead>
            <TableHead>{t("opd.labels.floor")}</TableHead>
            <TableHead>{t("opd.labels.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="mo">{r.code}</TableCell>
              <TableCell>{r.name}</TableCell>
              <TableCell>{r.floor ?? "—"}</TableCell>
              <TableCell><ActiveToggle active={r.active} onToggle={() => void toggle(r)} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <FormProvider {...form}>
        <FormKit onSubmit={submit}>
          <h2 className="tag" style={{ margin: 0 }}>{t("opdAdmin.newRoom")}</h2>
          <TextField name="code" label={t("opd.labels.code")} />
          <TextField name="name" label={t("opd.labels.name")} />
          <TextField name="floor" label={t("opd.labels.floor")} />
          <ErrorLine message={error} />
          <button type="submit" className="pri">{t("opdAdmin.addRoom")}</button>
        </FormKit>
      </FormProvider>
    </div>
  );
}

// ——— doctors ———

const doctorSchema = z.object({
  username: z.string().min(1),
  displayName: z.string().min(1),
  registrationNo: z.string(),
  departmentId: z.string().min(1),
  specialty: z.string(),
});
type DoctorValues = z.infer<typeof doctorSchema>;

function DoctorsTab({
  items, departments, queryClient,
}: { items: WireDoctor[]; departments: WireDepartment[]; queryClient: QueryClient }): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<DoctorValues>({
    resolver: zodResolver(doctorSchema),
    defaultValues: { username: "", displayName: "", registrationNo: "", departmentId: "", specialty: "" },
  });

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ["opd", "doctors"] });
  const departmentName = (id: string): string => departments.find((d) => d.id === id)?.name ?? id;

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      // The doctor profile is created BY USERNAME — the server resolves it to a Plan 02 user and
      // answers unknown_user (404) when there is none. No client-side existence check mirrors that.
      const body: { username: string; displayName: string; departmentId: string; registrationNo?: string; specialty?: string } = {
        username: v.username, displayName: v.displayName, departmentId: v.departmentId,
      };
      if (v.registrationNo.trim() !== "") body.registrationNo = v.registrationNo.trim();
      if (v.specialty.trim() !== "") body.specialty = v.specialty.trim();
      await api("POST", "/opd/doctors", body);
      form.reset({ username: "", displayName: "", registrationNo: "", departmentId: "", specialty: "" });
      await refresh();
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  });

  const toggle = async (row: WireDoctor): Promise<void> => {
    setError(null);
    try {
      await api("PATCH", `/opd/doctors/${row.id}`, { active: !row.active });
      await refresh();
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 22, alignItems: "start" }}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("opd.labels.name")}</TableHead>
            <TableHead>{t("opd.labels.department")}</TableHead>
            <TableHead>{t("opdAdmin.registrationNo")}</TableHead>
            <TableHead>{t("opd.labels.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((d) => (
            <TableRow key={d.id}>
              <TableCell>{d.displayName}</TableCell>
              <TableCell>{departmentName(d.departmentId)}</TableCell>
              <TableCell className="mo">{d.registrationNo ?? "—"}</TableCell>
              <TableCell><ActiveToggle active={d.active} onToggle={() => void toggle(d)} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <FormProvider {...form}>
        <FormKit onSubmit={submit}>
          <h2 className="tag" style={{ margin: 0 }}>{t("opdAdmin.newDoctor")}</h2>
          <TextField name="username" label={t("opdAdmin.username")} />
          <TextField name="displayName" label={t("opdAdmin.displayName")} />
          <TextField name="registrationNo" label={t("opdAdmin.registrationNo")} />
          <SelectField
            name="departmentId"
            label={t("opd.labels.department")}
            options={[{ value: "", label: t("opdAdmin.pickDepartment") }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
          />
          <TextField name="specialty" label={t("opdAdmin.specialty")} />
          <ErrorLine message={error} />
          <button type="submit" className="pri">{t("opdAdmin.addDoctor")}</button>
        </FormKit>
      </FormProvider>
    </div>
  );
}

// ——— weekly schedules ———

/**
 * §3.19 — register() hands back STRINGS for every control, `<select>` and `<input type="number">`
 * included. The coercion lives HERE, at the resolver, so the value that reaches the wire is already
 * a number (and a blank slot override is already `null`, not `""` and not `0`). Written as
 * `.transform().pipe()` rather than `z.preprocess` so that `z.input` stays a string and the field
 * array types honestly against what the DOM actually holds.
 */
const scheduleRowSchema = z.object({
  weekday: z.string().min(1).transform(Number).pipe(z.number().int().min(0).max(6)),
  startTime: z.string().regex(HHMM),
  endTime: z.string().regex(HHMM),
  roomId: z.string().min(1),
  slotMinutes: z.string().transform((v) => (v.trim() === "" ? null : Number(v))).pipe(z.number().int().positive().nullable()),
  validFrom: z.string().min(1),
  validTo: z.string().transform((v) => (v.trim() === "" ? null : v)).pipe(z.string().nullable()),
});
const schedulesSchema = z.object({ items: z.array(scheduleRowSchema) });
type SchedulesInput = z.input<typeof schedulesSchema>;
type SchedulesValues = z.output<typeof schedulesSchema>;

function SchedulesEditor({
  doctorId, rooms, loaded, queryClient,
}: { doctorId: string; rooms: WireRoom[]; loaded: WireSchedule[]; queryClient: QueryClient }): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const form = useForm<SchedulesInput, unknown, SchedulesValues>({
    resolver: zodResolver(schedulesSchema),
    defaultValues: {
      items: loaded.map((r) => ({
        weekday: String(r.weekday),
        startTime: r.startTime,
        endTime: r.endTime,
        roomId: r.roomId,
        slotMinutes: r.slotMinutes === null ? "" : String(r.slotMinutes),
        validFrom: r.validFrom,
        validTo: r.validTo ?? "",
      })),
    },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "items" });

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    setSaved(false);
    try {
      await api("PUT", `/opd/doctors/${doctorId}/schedules`, { items: values.items });
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["opd", "schedules", doctorId] });
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  });

  const roomOptions = [
    { value: "", label: t("opdAdmin.pickRoom") },
    ...rooms.map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` })),
  ];

  return (
    <section className="box" style={{ display: "flex", flexDirection: "column", gap: 10, padding: "15px 17px" }}>
      <h2 className="tag" style={{ margin: 0 }}>{t("opdAdmin.schedules")}</h2>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("opdAdmin.replaceHint")}</p>
      <FormProvider {...form}>
        <FormKit onSubmit={submit}>
          {fields.map((f, i) => (
            <div key={f.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8, borderBottom: "1px solid var(--line)", paddingBottom: 9 }}>
              <SelectField
                name={`items.${i}.weekday`}
                label={t("opdAdmin.weekday")}
                options={WEEKDAYS.map((w) => ({ value: String(w), label: t(`opd.weekday.${w}`) }))}
              />
              <TextField name={`items.${i}.startTime`} label={t("opdAdmin.startTime")} type="time" />
              <TextField name={`items.${i}.endTime`} label={t("opdAdmin.endTime")} type="time" />
              <SelectField name={`items.${i}.roomId`} label={t("opd.labels.room")} options={roomOptions} />
              <TextField name={`items.${i}.slotMinutes`} label={t("opdAdmin.slotMinutes")} type="number" />
              <TextField name={`items.${i}.validFrom`} label={t("opdAdmin.validFrom")} type="date" />
              <TextField name={`items.${i}.validTo`} label={t("opdAdmin.validTo")} type="date" />
              <button type="button" className="sec" style={{ padding: "0 9px", height: 25, fontSize: 11 }} onClick={() => remove(i)}>
                {t("opdAdmin.removeRow")}
              </button>
            </div>
          ))}
          {fields.length === 0 && <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("opdAdmin.noSchedules")}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="sec"
              onClick={() =>
                append({ weekday: "0", startTime: "", endTime: "", roomId: "", slotMinutes: "", validFrom: todayIst(), validTo: "" })
              }
            >
              {t("opdAdmin.addRow")}
            </button>
            <button type="submit" className="pri">{t("opdAdmin.saveSchedules")}</button>
          </div>
          {saved && <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--green)" }}>{t("opdAdmin.schedulesSaved")}</p>}
          <ErrorLine message={error} />
        </FormKit>
      </FormProvider>
    </section>
  );
}

// ——— leaves (§11.5 cascade: the server answers with what it broke) ———

const leaveSchema = z.object({
  fromDate: z.string().min(1),
  toDate: z.string().min(1),
  reason: z.string().min(1),
});
type LeaveValues = z.infer<typeof leaveSchema>;

function LeavesPanel({
  doctorId, items, queryClient,
}: { doctorId: string; items: WireLeave[]; queryClient: QueryClient }): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [affected, setAffected] = useState<number | null>(null);
  const blank = { fromDate: todayIst(), toDate: todayIst(), reason: "" };
  const form = useForm<LeaveValues>({ resolver: zodResolver(leaveSchema), defaultValues: blank });

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ["opd", "leaves", doctorId] });

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const res = await api<{ leaveId: string; affectedAppointmentIds: string[] }>("POST", "/opd/leaves", {
        doctorId, fromDate: v.fromDate, toDate: v.toDate, reason: v.reason,
      });
      setAffected(res.affectedAppointmentIds.length);
      form.reset(blank);
      await refresh();
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  });

  const cancel = async (leaveId: string): Promise<void> => {
    setError(null);
    try {
      await api("POST", `/opd/leaves/${leaveId}/cancel`);
      setAffected(null);
      await refresh();
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  };

  return (
    <section className="box" style={{ display: "flex", flexDirection: "column", gap: 10, padding: "15px 17px" }}>
      <h2 className="tag" style={{ margin: 0 }}>{t("opdAdmin.leaves")}</h2>
      {items.length === 0 && <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("opdAdmin.noLeaves")}</p>}
      {items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("opd.labels.from")}</TableHead>
              <TableHead>{t("opd.labels.to")}</TableHead>
              <TableHead>{t("opd.labels.reason")}</TableHead>
              <TableHead>{t("opd.labels.status")}</TableHead>
              <TableHead>{t("opd.labels.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((l) => (
              <TableRow key={l.id}>
                <TableCell>{l.fromDate}</TableCell>
                <TableCell>{l.toDate}</TableCell>
                <TableCell>{l.reason}</TableCell>
                <TableCell>{t(`opdAdmin.leaveStatus.${l.status}`)}</TableCell>
                <TableCell>
                  {l.status === "scheduled" && (
                    <button type="button" className="sec" style={{ padding: "0 9px", height: 25, fontSize: 11 }} onClick={() => void cancel(l.id)}>
                      {t("opdAdmin.cancelLeave")}
                    </button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <FormProvider {...form}>
        <FormKit onSubmit={submit}>
          <TextField name="fromDate" label={t("opdAdmin.fromDate")} type="date" />
          <TextField name="toDate" label={t("opdAdmin.toDate")} type="date" />
          <TextField name="reason" label={t("opd.labels.reason")} />
          {affected !== null && <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--gold)" }}>{t("opdAdmin.leaveScheduled", { n: affected })}</p>}
          <ErrorLine message={error} />
          <button type="submit" className="pri">{t("opdAdmin.addLeave")}</button>
        </FormKit>
      </FormProvider>
    </section>
  );
}

function SchedulesAndLeavesTab({
  doctors, rooms, queryClient,
}: { doctors: WireDoctor[]; rooms: WireRoom[]; queryClient: QueryClient }): React.ReactElement {
  const { t } = useTranslation();
  const picker = useForm<{ doctorId: string }>({ defaultValues: { doctorId: "" } });
  const doctorId = picker.watch("doctorId");

  const schedules = useQuery({
    queryKey: ["opd", "schedules", doctorId],
    queryFn: () => listDoctorSchedules(doctorId),
    enabled: doctorId !== "",
    refetchInterval: POLL_MS,
  });
  const leaves = useQuery({
    queryKey: ["opd", "leaves", doctorId],
    queryFn: () => listLeaves({ doctorId }),
    enabled: doctorId !== "",
    refetchInterval: POLL_MS,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <FormProvider {...picker}>
        {/*
          The width lives here rather than in a utility class on a SHARED component: `form-kit.tsx`
          is imported by eight screens and is deliberately not restyled by FD-25 (its fields already
          inherit `.pp input`'s paint from desk-one.css, which is why they look right without being
          touched). Layout the screen owns stays in the screen.
        */}
        <div style={{ maxWidth: 340 }}>
        <SelectField
          name="doctorId"
          label={t("opd.labels.doctor")}
          options={[{ value: "", label: t("opdAdmin.pickDoctor") }, ...doctors.map((d) => ({ value: d.id, label: d.displayName }))]}
        />
        </div>
      </FormProvider>
      {doctorId === "" && <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("opdAdmin.pickDoctorHint")}</p>}
      {/* Keyed on the doctor so switching doctors re-seeds both editors from the newly loaded rows
          rather than leaving the previous doctor's form state behind. The two keys must differ:
          same-keyed siblings are duplicates to React. */}
      {doctorId !== "" && schedules.data !== undefined && (
        <SchedulesEditor
          key={`schedules-${doctorId}`}
          doctorId={doctorId}
          rooms={rooms}
          loaded={schedules.data.items}
          queryClient={queryClient}
        />
      )}
      {doctorId !== "" && (
        <LeavesPanel key={`leaves-${doctorId}`} doctorId={doctorId} items={leaves.data?.items ?? []} queryClient={queryClient} />
      )}
    </div>
  );
}

// ——— screen ———

export function OpdAdmin(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"departments" | "rooms" | "doctors" | "schedules">("departments");
  const [agentAnswer, setAgentAnswer] = useState<string | null>(null);
  const [agentLog, setAgentLog] = useState<AgentLine[]>([]);

  const departments = useQuery({ queryKey: ["opd", "departments"], queryFn: listDepartments, refetchInterval: POLL_MS });
  const rooms = useQuery({ queryKey: ["opd", "rooms"], queryFn: listRooms, refetchInterval: POLL_MS });
  const doctors = useQuery({ queryKey: ["opd", "doctors"], queryFn: listDoctors, refetchInterval: POLL_MS });

  const departmentItems = departments.data?.items ?? [];
  const roomItems = rooms.data?.items ?? [];
  const doctorItems = doctors.data?.items ?? [];

  /*
    THE MASTERS' CO-PILOT counts what is here and names what has been switched off. The second half
    is the useful one: a deactivated department is invisible at the counter and still on every past
    visit, so "why can nobody book Dermatology" has an answer this screen holds and never volunteers.
  */
  const ask = (question: string): void => {
    const q = question.toLowerCase();
    const off = [...departmentItems, ...roomItems].filter((x) => !x.active).map((x) => x.name)
      .concat(doctorItems.filter((d) => !d.active).map((d) => d.displayName));
    const answer = /inactive|deactivat|off|disabled|missing|hidden/.test(q)
      ? (off.length === 0 ? t("opdAdmin.agent.allActive") : t("opdAdmin.agent.inactive", { list: off.join(", ") }))
      : /how many|count|department|room|doctor|list/.test(q)
        ? t("opdAdmin.agent.counts", {
            departments: t("opdAdmin.agent.countDepartments", { count: departmentItems.length }),
            rooms: t("opdAdmin.agent.countRooms", { count: roomItems.length }),
            doctors: t("opdAdmin.agent.countDoctors", { count: doctorItems.length }),
          })
        : t("opdAdmin.agent.cannot");
    setAgentAnswer(answer);
    setAgentLog((l) => logged(l, question));
  };

  return (
    <PaperScreen testId="opd-admin" style={{ padding: "18px 22px", gap: 14 }}>
      <ScreenTitle title={t("opdAdmin.title")} route="/opd/admin" />
      {departments.data === undefined && <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("app.loading")}</p>}
      <TabStrip
        label={t("opdAdmin.title")}
        value={tab}
        onChange={setTab}
        options={[
          ["departments", t("opdAdmin.tabs.departments")],
          ["rooms", t("opdAdmin.tabs.rooms")],
          ["doctors", t("opdAdmin.tabs.doctors")],
          ["schedules", t("opdAdmin.tabs.schedules")],
        ] as const}
      />
      {/*
        ONE PANEL MOUNTED AT A TIME, which is what the shadcn `Tabs` did and is worth keeping
        deliberately rather than by accident: each tab holds its own react-hook-form, and mounting
        all four would keep three sets of half-typed form state alive behind the one being read.
      */}
      <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "departments" && <DepartmentsTab items={departmentItems} queryClient={queryClient} />}
        {tab === "rooms" && <RoomsTab items={roomItems} queryClient={queryClient} />}
        {tab === "doctors" && <DoctorsTab items={doctorItems} departments={departmentItems} queryClient={queryClient} />}
        {tab === "schedules" && <SchedulesAndLeavesTab doctors={doctorItems} rooms={roomItems} queryClient={queryClient} />}
      </div>

      <AgentDock
        answer={agentAnswer} log={agentLog} onAsk={ask}
        placeholder={t("opdAdmin.askPlaceholder")} idle={t("opdAdmin.agentIdle")}
      />
    </PaperScreen>
  );
}
