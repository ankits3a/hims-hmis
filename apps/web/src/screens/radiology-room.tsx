import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { checkInStudy, fetchImagingDevices, fetchReadiness, radiologyErrorText } from "../lib/radiology-api";
import { fetchCumulativeDose } from "../lib/aerb-api";
import {
  fetchDoseLog, fetchMachineWorklist, fetchRejects, fetchRoomView, reportBreakdown, resolveBillDecision,
} from "../lib/radiology-room-api";
import type { WireImagingDevice, WireWorklistRow } from "../lib/radiology-api";
import { RoomConsole, RoomRefusal } from "../components/radiology/room-console";
import { SeatLink, useNow } from "../components/radiology/imaging-counter";
import { istDay } from "../components/radiology/desk-time";
import { RadiologyStation } from "./radiology-station";
import { PacsInboxView } from "./radiology-pacs-inbox";
import { IrSuiteView } from "./radiology-ir";
import { CreditChip } from "../components/patient-credit";

/**
 * PLAN 18-S RS6 — **THE MODALITY ROOMS: the technologist's station.**
 *
 * One route (`/radiology/room`), four header views, the owner's layout on each:
 *
 *   · **Room console** (`?view=console&machine=CT-1&study=…`) — the machine picked in the centre;
 *     the right list is THIS machine's floor list (scheduled → in acquisition, STAT first) with
 *     "Clocks running" (STAT waiting over 10 minutes, ready over 20) folded under it; opening a
 *     patient from the list IS the patient on the table (a booked study is checked in by that act —
 *     no presence button); the centre is `RoomConsole`'s four steps with the one next act docked.
 *   · **Dose log** — the day's dose register for this machine (the existing `/aerb/doses` read),
 *     DRL breaches with the reason typed at the console.
 *   · **Rejects & repeats** — the reject analysis (`/radiology/room/rejects`) and the bill
 *     decisions the console raised; resolving one stays with the desk's permission.
 *   · **Downtime** — machines out of service, "Report breakdown" through Setup's status write, the
 *     studies to move linked to the desk's diary, and the paper-mode note.
 *
 * The study page (`/radiology/studies/$id`) stays: the lane links to it, and it links back here.
 */

/**
 * 18-S RS12 — `unmatched`: the PACS inbox (archive studies no accession + UHID could claim).
 * 18-S RS12b — `ir`: the IR suite (image-guided procedures: WHO phases, sedation, Ka,r).
 */
export type RoomViewKey = "console" | "ir" | "dose" | "rejects" | "downtime" | "unmatched";
export const ROOM_VIEWS: readonly RoomViewKey[] = ["console", "ir", "dose", "rejects", "downtime", "unmatched"];
export type RoomSearch = { view?: RoomViewKey; machine?: string; study?: string };

const STAT_CLOCK_MIN = 10;
const READY_CLOCK_MIN = 20;
const REPEAT_TARGET_PCT = 3;
const OUT_OF_SERVICE = new Set(["down", "maintenance", "qa_blocked", "retired"]);
const STATE_RANK: Record<string, number> = { in_acquisition: 0, ready: 1, checked_in: 2, scheduled: 3 };
const field = "w-full rounded border bg-background px-2 py-1 text-sm";

const minutesSince = (iso: string | null, now: number): number => (iso === null ? 0 : Math.floor((now - new Date(iso).getTime()) / 60_000));

/** The machine's list: STAT first, then whoever is furthest along, then by slot. */
export function orderRoomList(rows: readonly WireWorklistRow[]): WireWorklistRow[] {
  return [...rows].sort((a, b) => {
    if ((a.priority === "stat") !== (b.priority === "stat")) return a.priority === "stat" ? -1 : 1;
    const r = (STATE_RANK[a.status] ?? 9) - (STATE_RANK[b.status] ?? 9);
    if (r !== 0) return r;
    return (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt);
  });
}

function useGo(): (search: RoomSearch) => void {
  const router = useRouter({ warn: false });
  return (search) => {
    if (!router) return;
    void router.navigate({ to: "/radiology/room", search });
  };
}

export function RadiologyRoom({ search }: { search: RoomSearch }): React.ReactElement {
  const { t } = useTranslation();
  const view = search.view ?? "console";
  const go = useGo();
  const devicesQ = useQuery({ queryKey: ["radiology", "devices"], queryFn: fetchImagingDevices });
  const devices = devicesQ.data?.devices ?? [];
  const rooms = devices.filter((d) => !d.portable && d.status !== "retired");
  /** Arriving from the study page with only a study: the machine is the one it is booked on. */
  const studyRoomQ = useQuery({
    queryKey: ["radiology", "room", search.study ?? ""],
    queryFn: () => fetchRoomView(search.study!),
    enabled: search.study !== undefined && search.machine === undefined,
  });
  const bookedOn = studyRoomQ.data?.study.device?.id;
  const machine = rooms.find((d) => d.code === search.machine)
    ?? rooms.find((d) => d.id === bookedOn)
    ?? rooms[0] ?? null;

  const views = ROOM_VIEWS.map((v) => (
    <a
      key={v}
      href={`/radiology/room?view=${v}${machine === null ? "" : `&machine=${encodeURIComponent(machine.code)}`}`}
      className="st-nv"
      data-testid={`room-view-${v}`}
      aria-current={v === view ? "page" : undefined}
      onClick={(e) => { e.preventDefault(); go({ view: v, machine: machine?.code }); }}
    >
      {t(`radiology.room.views.${v}`)}
    </a>
  ));
  const picker = (
    <div className="flex max-w-full gap-1 overflow-x-auto pb-1" role="tablist" aria-label={t("radiology.room.machine")} data-testid="machine-picker">
      {rooms.map((d) => (
        <button
          key={d.id} type="button" role="tab" aria-selected={d.id === machine?.id}
          className={`shrink-0 rounded border px-3 py-1 text-sm ${d.id === machine?.id ? "border-green-700 bg-green-50 font-semibold" : "bg-card"}`}
          onClick={() => go({ view, machine: d.code })}
        >
          {d.code}
          {OUT_OF_SERVICE.has(d.status) || d.licensedNow === false ? <span aria-label={t("radiology.room.machineAlert")} className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-red-600 align-middle" /> : null}
        </button>
      ))}
      <SeatLink to="/radiology/portable">{t("radiology.room.toPortable")}</SeatLink>
    </div>
  );

  if (view === "dose") return <DoseView views={views} picker={picker} machine={machine} />;
  if (view === "rejects") return <RejectsView views={views} />;
  if (view === "downtime") return <DowntimeView views={views} devices={devices} />;
  if (view === "unmatched") return <PacsInboxView views={views} />;
  if (view === "ir") return <IrSuiteView views={views} studyId={search.study ?? null} />;
  return <ConsoleView views={views} picker={picker} machine={machine} studyId={search.study ?? null} devicesError={devicesQ.isError ? radiologyErrorText(devicesQ.error) : null} />;
}

/* ═══════════════════════════════ Room console ═══════════════════════════════ */

function ConsoleView({ views, picker, machine, studyId, devicesError }: {
  views: React.ReactNode; picker: React.ReactNode; machine: WireImagingDevice | null; studyId: string | null; devicesError: string | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const go = useGo();
  const now = useNow();
  const [sent, setSent] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const listQ = useQuery({
    queryKey: ["radiology", "room-list", machine?.id ?? ""],
    queryFn: () => fetchMachineWorklist(machine!.id),
    enabled: machine !== null,
    refetchInterval: 30_000,
  });
  const rows = useMemo(() => orderRoomList(listQ.data?.rows ?? []), [listQ.data]);
  const inHand = rows.find((r) => r.studyId === studyId) ?? null;

  /**
   * Opening a patient from the list is the patient on the table. A study still `scheduled` (booked,
   * not yet arrived at the desk) is checked in by that act — the plan's "presence is derived" rule;
   * the radiographer holds `radiology.checkin`. Nothing else is written by opening.
   */
  const open = async (r: WireWorklistRow): Promise<void> => {
    setSent(null);
    setOpenError(null);
    go({ view: "console", machine: machine?.code, study: r.studyId });
    if (r.status === "scheduled") {
      try {
        await checkInStudy(r.studyId);
      } catch (e) {
        setOpenError(radiologyErrorText(e));
      }
      void qc.invalidateQueries({ queryKey: ["radiology", "room-list"] });
      void qc.invalidateQueries({ queryKey: ["radiology", "gates", r.studyId] });
      void qc.invalidateQueries({ queryKey: ["radiology", "room", r.studyId] });
    }
  };
  const clear = (): void => go({ view: "console", machine: machine?.code });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape" && studyId !== null) clear(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const statWaiting = rows.filter((r) => r.priority === "stat" && r.status !== "in_acquisition" && minutesSince(r.createdAt, now) > STAT_CLOCK_MIN);
  const readyWaiting = rows.filter((r) => r.status === "ready" && minutesSince(r.checkedInAt ?? r.createdAt, now) > READY_CLOCK_MIN);
  const clocksAlert = statWaiting.length + readyWaiting.length > 0;

  const list = (
    <section aria-label={t("radiology.room.listTitle", { machine: machine?.code ?? "" })}>
      <h2 className="tag m-0 mb-2">{t("radiology.room.listTitle", { machine: machine?.code ?? "" })} · {rows.length}</h2>
      {listQ.isError && <p role="alert" className="text-sm text-red-700">{radiologyErrorText(listQ.error)}</p>}
      {!listQ.isPending && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.room.listEmpty")}</p>}
      <ul className="m-0 list-none space-y-1 p-0" data-testid="room-list">
        {rows.map((r) => (
          <li key={r.studyId} data-acc={r.accessionNo} data-state={r.status}>
            <button
              type="button" data-testid={`room-row-${r.studyId}`}
              aria-current={r.studyId === studyId ? "true" : undefined}
              className={`w-full rounded border bg-card p-2 text-left text-sm ${r.studyId === studyId ? "border-green-700" : ""}`}
              onClick={() => { void open(r); }}
            >
              <span className="flex justify-between gap-2">
                <b className="min-w-0 truncate">{r.patientName}</b>
                <span className="mo shrink-0 text-xs">{r.scheduledAt === null ? "—" : fmtIst(r.scheduledAt)}</span>
              </span>
              <span className="block text-xs text-muted-foreground">
                {r.priority === "stat" ? <b className="text-red-700">STAT · </b> : null}
                {r.studyTypeCode} · <span className={r.status === "ready" ? "text-green-800" : ""}>{t(`radiology.room.state.${r.status}`, { defaultValue: r.status })}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
  const clocks = (
    <ul className="m-0 list-none space-y-1 p-0 text-sm" data-testid="room-clocks">
      {statWaiting.map((r) => <li key={`s-${r.studyId}`} className="text-red-800">{t("radiology.room.clockStat", { name: r.patientName, study: r.studyTypeCode, min: minutesSince(r.createdAt, now) })}</li>)}
      {readyWaiting.map((r) => <li key={`r-${r.studyId}`}>{t("radiology.room.clockReady", { name: r.patientName, study: r.studyTypeCode, min: minutesSince(r.checkedInAt ?? r.createdAt, now) })}</li>)}
      {!clocksAlert && <li className="text-muted-foreground">{t("radiology.room.clocksQuiet")}</li>}
    </ul>
  );

  const next = rows.find((r) => r.status === "ready") ?? null;
  const machineDown = machine !== null && OUT_OF_SERVICE.has(machine.status);
  const unlicensed = machine !== null && machine.licensedNow === false;

  return (
    <RadiologyStation
      station="room"
      views={views}
      title={t("radiology.room.title")}
      place={machine === null ? t("radiology.room.noMachine") : `${machine.code} · ${machine.name}${machine.room === null ? "" : ` · ${machine.room}`}`}
      stats={[
        { label: t("radiology.station.onList"), value: rows.length },
        { label: t("radiology.station.stat"), value: rows.filter((r) => r.priority === "stat" && r.status !== "in_acquisition").length, tone: "danger" },
        { label: t("radiology.room.readyStat"), value: rows.filter((r) => r.status === "ready").length, tone: "live" },
      ]}
      lane={studyId === null ? undefined : <PatientLane studyId={studyId} onClear={clear} />}
      list={list}
      listSummary={inHand === null ? undefined : t("radiology.room.listSummary", { count: rows.length })}
      inHand={studyId !== null}
      closeListOn={studyId}
      clocks={clocks}
      clocksAlert={clocksAlert}
      clocksSummary={clocksAlert ? t("radiology.room.clocksSummary", { count: statWaiting.length + readyWaiting.length }) : t("radiology.room.clocksNone")}
    >
      <div className="flex min-h-full flex-col space-y-3">
        {picker}
        {devicesError !== null && <p role="alert" className="text-sm text-red-700">{devicesError}</p>}
        {machineDown && (
          <RoomRefusal r={{ code: "device_unavailable", message: t("radiology.room.machineDown", { machine: machine.code, status: t(`radiology.room.status.${machine.status}`, { defaultValue: machine.status }) }) }} />
        )}
        {unlicensed && (
          <RoomRefusal r={{ code: "device_not_licensed", message: t("radiology.room.machineUnlicensed", { machine: machine.code }) }} />
        )}
        {openError !== null && <p role="alert" className="text-sm text-red-700">{openError}</p>}
        {sent !== null && <p role="status" className="rounded border border-green-300 bg-green-50 p-2 text-sm" data-testid="sent">{t("radiology.room.sent", { acc: sent })}</p>}
        {studyId === null
          ? (
            <div className="space-y-3" data-testid="machine-idle">
              {next !== null
                ? <p className="rounded border bg-card p-3 text-sm">{t("radiology.room.nextReady", { name: next.patientName, study: next.studyTypeCode })}</p>
                : rows.length > 0
                ? <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">{t("radiology.room.noneReady")}</p>
                : null}
              <p className="text-xs text-muted-foreground">{t("radiology.room.mwlNote")}</p>
            </div>
          )
          : <RoomConsole key={studyId} studyId={studyId} onDone={(acc) => { setSent(acc); clear(); }} />}
      </div>
    </RadiologyStation>
  );
}

/** The left lane: the patient on the table. */
export function PatientLane({ studyId, onClear }: { studyId: string; onClear: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const roomQ = useQuery({ queryKey: ["radiology", "room", studyId], queryFn: () => fetchRoomView(studyId) });
  const gatesQ = useQuery({ queryKey: ["radiology", "gates", studyId], queryFn: () => fetchReadiness(studyId) });
  const v = roomQ.data?.study;
  const dose = useQuery({
    queryKey: ["aerb", "cumulative", v?.patientId],
    queryFn: () => fetchCumulativeDose(v!.patientId),
    enabled: v !== undefined && v.ionising,
    retry: false,
  });
  if (v === undefined) return <p className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p>;
  const preg = gatesQ.data?.gates.find((g) => g.kind === "pregnancy_screen");
  const kv = (k: string, val: React.ReactNode, testid?: string): React.ReactElement => (
    <div className="flex justify-between gap-2 border-b py-1 text-sm last:border-b-0" data-testid={testid}>
      <span className="text-muted-foreground">{k}</span><span className="text-right">{val}</span>
    </div>
  );
  const d = dose.data;
  return (
    <div className="mt-4 space-y-3 text-sm" data-testid="patient-on-table">
      <div>
        <span className="tag">{t("radiology.room.lane.onTable")}</span>
        <p className="m-0 mt-1 text-base font-semibold">{v.patient.name}</p>
        <p className="m-0 mo text-xs">{v.patient.uhid} · {v.accessionNo}</p>
        <div className="mt-1"><CreditChip patientId={v.patientId} testId="imaging-credit" /></div>
      </div>
      <div>
        {kv(t("radiology.room.lane.ageSex"), `${v.patient.ageYears ?? "—"} · ${t(`radiology.room.sex.${v.patient.sex}`, { defaultValue: v.patient.sex })}`)}
        {kv(t("radiology.room.lane.allergies"), v.patient.allergies.length === 0 ? t("radiology.room.lane.nka") : <b className="text-red-800">{v.patient.allergies.join(", ")}</b>, "lane-allergies")}
        {kv(t("radiology.room.lane.weight"), v.patient.weight === null ? t("radiology.room.lane.notCharted") : `${v.patient.weight.kg} kg`)}
        {v.renal !== null && kv(t("radiology.room.lane.renal"),
          v.renal.egfr !== null ? `eGFR ${v.renal.egfr}` : v.renal.creatinineUmolL !== null ? `${t("radiology.room.lane.creatinine")} ${v.renal.creatinineUmolL} µmol/L` : t("radiology.room.lane.pending"), "lane-renal")}
        {preg !== undefined && kv(t("radiology.room.lane.pregnancy"), t(`radiology.room.gateState.${preg.state}`, { defaultValue: preg.state }))}
        {v.ionising && kv(t("radiology.room.lane.priorDose"),
          d === undefined ? "—" : d.studyCount === 0 ? t("radiology.room.lane.noPrior") : t("radiology.room.lane.prior", { count: d.studyCount, months: d.months, over: d.overDrlCount }), "lane-prior")}
      </div>
      <p className="m-0"><SeatLink to={`/radiology/studies/${v.studyId}`}>{t("radiology.room.lane.studyPage")}</SeatLink></p>
      <button type="button" className="rounded border px-3 py-1 text-sm" onClick={onClear}>
        {t("radiology.room.lane.clear")} <span className="kb">Esc</span>
      </button>
    </div>
  );
}

/* ═══════════════════════════════ Dose log ═══════════════════════════════ */

function DoseView({ views, picker, machine }: { views: React.ReactNode; picker: React.ReactNode; machine: WireImagingDevice | null }): React.ReactElement {
  const { t } = useTranslation();
  const [day, setDay] = useState(() => istDay(Date.now()));
  const q = useQuery({ queryKey: ["aerb", "doses", day], queryFn: () => fetchDoseLog(day, day), retry: false });
  const rows = (q.data?.rows ?? []).filter((r) => r.source === "imaging" && (machine === null || r.deviceCode === machine.code));
  const over = rows.filter((r) => r.overDrl === true);
  const list = (
    <section aria-label={t("radiology.room.dose.breaches")}>
      <h2 className="tag m-0 mb-2">{t("radiology.room.dose.breaches")} · {over.length}</h2>
      {over.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.room.dose.noBreach")}</p>}
      <ul className="m-0 list-none space-y-1 p-0" data-testid="drl-breaches">
        {over.map((r) => (
          <li key={r.id} className="rounded border bg-card p-2 text-sm">
            <b>{r.patientName}</b> · <span className="mo text-xs">{r.procedureCode}</span>
            <span className={`block text-xs ${r.drlReason === null ? "text-red-700" : "text-muted-foreground"}`}>{r.drlReason ?? t("radiology.room.dose.noReason")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
  const cell = (v: string | number | null): string => (v === null ? "" : String(Number(v)));
  return (
    <RadiologyStation
      station="room" views={views}
      title={t("radiology.room.dose.heading")}
      place={machine === null ? t("radiology.room.noMachine") : `${machine.code} · ${day}`}
      stats={[
        { label: t("radiology.room.dose.studies"), value: rows.length },
        { label: t("radiology.room.dose.above"), value: over.length, tone: over.length > 0 ? "waiting" : "plain" },
        { label: t("radiology.room.dose.typed"), value: rows.filter((r) => r.doseManual).length },
      ]}
      list={list}
    >
      <div className="space-y-3" data-testid="dose-log">
        {picker}
        <label className="flex items-center gap-2 text-sm">{t("radiology.room.dose.day")}
          <input type="date" className="rounded border bg-background px-2 py-1 text-sm" value={day} onChange={(e) => setDay(e.target.value)} data-testid="dose-day" />
        </label>
        {q.isError && <p role="alert" className="text-sm text-red-700">{radiologyErrorText(q.error)}</p>}
        {!q.isPending && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.room.dose.empty")}</p>}
        {rows.length > 0 && (
          <div className="overflow-x-auto rounded border bg-card">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground">
                <th className="p-2">{t("radiology.room.dose.col.time")}</th><th className="p-2">{t("radiology.room.dose.col.patient")}</th>
                <th className="p-2">{t("radiology.room.dose.col.study")}</th><th className="p-2 text-right">CTDIvol</th>
                <th className="p-2 text-right">DLP</th><th className="p-2 text-right">DAP</th><th className="p-2">{t("radiology.room.dose.col.drl")}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-t ${r.overDrl === true ? "bg-amber-50" : ""}`} data-over={String(r.overDrl)}>
                    <td className="mo p-2">{fmtIst(r.occurredAt)}</td><td className="p-2">{r.patientName}</td>
                    <td className="mo p-2 text-xs">{r.procedureCode}</td>
                    <td className="mo p-2 text-right">{cell(r.doseCtdivol)}</td><td className="mo p-2 text-right">{cell(r.doseDlp)}</td><td className="mo p-2 text-right">{cell(r.doseDap)}</td>
                    <td className="p-2 text-xs">{r.overDrl === null ? t("radiology.room.dose.noLevelShort") : r.overDrl ? t("radiology.room.dose.overShort", { value: cell(r.drlValue) }) : t("radiology.room.dose.underShort")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t("radiology.room.dose.note")}</p>
      </div>
    </RadiologyStation>
  );
}

/* ═══════════════════════════════ Rejects & repeats ═══════════════════════════════ */

function RejectsView({ views }: { views: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["radiology", "rejects"], queryFn: () => fetchRejects() });
  const data = q.data;
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const resolve = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => resolveBillDecision(id, text),
    onSuccess: () => { setErr(null); void qc.invalidateQueries({ queryKey: ["radiology", "rejects"] }); },
    onError: (e) => setErr(radiologyErrorText(e)),
  });
  const mayResolve = can("radiology.bill_decisions.manage");
  const totalAcq = (data?.rows ?? []).reduce((n, r) => n + r.acquired, 0);
  const totalRep = (data?.rows ?? []).reduce((n, r) => n + r.repeats, 0);
  const pct = (rep: number, acq: number): number | null => (acq === 0 ? null : Math.round((rep / acq) * 1000) / 10);
  const overall = pct(totalRep, totalAcq);
  const maxReason = Math.max(1, ...(data?.reasons ?? []).map((r) => r.count));

  const list = (
    <section aria-label={t("radiology.room.rejects.decisions")}>
      <h2 className="tag m-0 mb-2">{t("radiology.room.rejects.decisions")} · {data?.openDecisions.length ?? 0}</h2>
      {err !== null && <p role="alert" className="text-sm text-red-700">{err}</p>}
      {(data?.openDecisions.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">{t("radiology.room.rejects.noDecisions")}</p>}
      <ul className="m-0 list-none space-y-1 p-0" data-testid="open-decisions">
        {(data?.openDecisions ?? []).map((d) => (
          <li key={d.id} className="rounded border bg-card p-2 text-sm" data-kind={d.kind}>
            <b>{t(`radiology.room.rejects.kind.${d.kind}`, { defaultValue: d.kind })}</b> · <span className="mo text-xs">{d.accessionNo}</span>
            {d.reason !== null && <span className="block text-xs text-muted-foreground">{t(`radiology.room.repeat.reasons.${d.reason}`, { defaultValue: d.reason })}</span>}
            {mayResolve
              ? (
                <span className="mt-1 flex gap-1">
                  <input className={field} value={resolution[d.id] ?? ""} placeholder={t("radiology.room.rejects.resolutionHint")}
                    onChange={(e) => setResolution((r) => ({ ...r, [d.id]: e.target.value }))} aria-label={t("radiology.room.rejects.resolution")} />
                  <button type="button" className="shrink-0 rounded border px-2 text-xs disabled:opacity-50" data-testid={`resolve-${d.id}`}
                    disabled={(resolution[d.id] ?? "").trim() === "" || resolve.isPending}
                    onClick={() => resolve.mutate({ id: d.id, text: resolution[d.id]!.trim() })}>{t("radiology.room.rejects.resolve")}</button>
                </span>
              )
              : <span className="block text-xs text-amber-800">{t("radiology.room.rejects.withDesk")}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <RadiologyStation
      station="room" views={views}
      title={t("radiology.room.rejects.heading")}
      place={data === undefined ? "" : t("radiology.room.rejects.window", { from: data.from, to: data.to })}
      stats={[
        { label: t("radiology.room.rejects.rate"), value: overall === null ? "—" : `${overall}%`, tone: overall !== null && overall > REPEAT_TARGET_PCT ? "waiting" : "plain" },
        { label: t("radiology.room.rejects.repeats"), value: totalRep },
        { label: t("radiology.room.rejects.open"), value: data?.openDecisions.length ?? 0, tone: (data?.openDecisions.length ?? 0) > 0 ? "waiting" : "plain" },
      ]}
      list={list}
    >
      <div className="space-y-3" data-testid="rejects">
        {q.isError && <p role="alert" className="text-sm text-red-700">{radiologyErrorText(q.error)}</p>}
        <section className="rounded border bg-card">
          <h3 className="m-0 border-b px-3 py-2 text-sm font-semibold">{t("radiology.room.rejects.byRoom", { target: REPEAT_TARGET_PCT })}</h3>
          {(data?.rows.length ?? 0) === 0
            ? <p className="px-3 py-2 text-sm text-muted-foreground">{t("radiology.room.rejects.none")}</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-muted-foreground">
                    <th className="p-2">{t("radiology.room.machine")}</th><th className="p-2">{t("radiology.room.rejects.tech")}</th>
                    <th className="p-2 text-right">{t("radiology.room.rejects.acquired")}</th><th className="p-2 text-right">{t("radiology.room.rejects.repeats")}</th><th className="p-2 text-right">{t("radiology.room.rejects.rate")}</th>
                  </tr></thead>
                  <tbody>
                    {data!.rows.map((r) => {
                      const p = pct(r.repeats, r.acquired);
                      return (
                        <tr key={`${r.deviceResourceId}-${r.technologistId}`} className="border-t" data-testid="rate-row">
                          <td className="mo p-2">{r.deviceCode}</td><td className="p-2">{r.technologistName}</td>
                          <td className="mo p-2 text-right">{r.acquired}</td><td className="mo p-2 text-right">{r.repeats}</td>
                          <td className={`mo p-2 text-right ${p !== null && p > REPEAT_TARGET_PCT ? "font-semibold text-amber-800" : ""}`}>{p === null ? "—" : `${p}%`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </section>
        {(data?.reasons.length ?? 0) > 0 && (
          <section className="rounded border bg-card px-3 py-2">
            <h3 className="m-0 mb-2 text-sm font-semibold">{t("radiology.room.rejects.reasons")}</h3>
            {data!.reasons.map((r) => (
              <div key={r.reason} className="flex items-center gap-2 py-1 text-sm">
                <span className="w-40 shrink-0">{t(`radiology.room.repeat.reasons.${r.reason}`)}</span>
                <span className="h-2 flex-1 rounded bg-muted"><span className="block h-2 rounded bg-green-700" style={{ width: `${(r.count / maxReason) * 100}%` }} /></span>
                <span className="mo w-6 text-right">{r.count}</span>
              </div>
            ))}
          </section>
        )}
        {(data?.log.length ?? 0) > 0 && (
          <section className="overflow-x-auto rounded border bg-card">
            <h3 className="m-0 border-b px-3 py-2 text-sm font-semibold">{t("radiology.room.rejects.log")}</h3>
            <table className="w-full text-sm">
              <tbody>
                {data!.log.map((l, i) => (
                  <tr key={`${l.studyId}-${i}`} className="border-t">
                    <td className="mo p-2 text-xs">{fmtIst(l.at)}</td><td className="mo p-2 text-xs">{l.accessionNo}</td>
                    <td className="mo p-2 text-xs">{l.studyTypeCode}</td><td className="mo p-2 text-xs">{l.deviceCode}</td>
                    <td className="p-2">{l.technologistName}</td><td className="p-2">{t(`radiology.room.repeat.reasons.${l.reason}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        <p className="text-xs text-muted-foreground">{t("radiology.room.rejects.note")}</p>
      </div>
    </RadiologyStation>
  );
}

/* ═══════════════════════════════ Downtime ═══════════════════════════════ */

function DowntimeView({ views, devices }: { views: React.ReactNode; devices: WireImagingDevice[] }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const out = devices.filter((d) => d.status === "down" || d.status === "maintenance" || d.status === "qa_blocked");
  const mayReport = can("radiology.devices.manage");
  const [pick, setPick] = useState<string>("");
  const [reason, setReason] = useState("");
  const [moved, setMoved] = useState<{ machine: string; studies: { accessionNo: string; studyTypeCode: string; scheduledAt: string | null }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const report = useMutation({
    mutationFn: () => reportBreakdown(pick, reason.trim()),
    onSuccess: (r) => {
      setErr(null);
      setMoved({ machine: devices.find((d) => d.id === pick)?.code ?? "", studies: r.studiesToMove });
      setReason("");
      void qc.invalidateQueries({ queryKey: ["radiology", "devices"] });
    },
    onError: (e) => setErr(radiologyErrorText(e)),
  });
  const list = (
    <section aria-label={t("radiology.room.down.outList")}>
      <h2 className="tag m-0 mb-2">{t("radiology.room.down.outList")} · {out.length}</h2>
      {out.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.room.down.allUp")}</p>}
      <ul className="m-0 list-none space-y-1 p-0" data-testid="machines-out">
        {out.map((d) => (
          <li key={d.id} className="rounded border bg-card p-2 text-sm" data-down={d.code}>
            <b>{d.code}</b> · {t(`radiology.room.status.${d.status}`, { defaultValue: d.status })}
            <span className="block text-xs text-muted-foreground">{d.name}{d.room === null ? "" : ` · ${d.room}`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <RadiologyStation
      station="room" views={views}
      title={t("radiology.room.down.heading")}
      place={t("radiology.room.down.place")}
      stats={[
        { label: t("radiology.room.down.machines"), value: devices.length },
        { label: t("radiology.room.down.out"), value: out.length, tone: out.length > 0 ? "danger" : "plain" },
      ]}
      list={list}
    >
      <div className="space-y-3" data-testid="downtime">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {devices.map((d) => (
            <div key={d.id} className="rounded border bg-card p-2 text-sm" data-machine={d.code} data-status={d.status}>
              <div className="flex justify-between gap-2"><b className="mo">{d.code}</b>
                <span className={OUT_OF_SERVICE.has(d.status) ? "text-red-800" : "text-green-800"}>{t(`radiology.room.status.${d.status}`, { defaultValue: d.status })}</span>
              </div>
              <div className="text-xs text-muted-foreground">{d.name}{d.room === null ? "" : ` · ${d.room}`}{d.licensedNow === false ? ` · ${t("radiology.room.down.unlicensed")}` : ""}</div>
            </div>
          ))}
        </div>
        <section className="rounded border bg-card px-3 py-2">
          <h3 className="m-0 mb-2 text-sm font-semibold">{t("radiology.room.down.report")}</h3>
          {mayReport
            ? (
              <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
                <select className={field} value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t("radiology.room.machine")} data-testid="down-machine">
                  <option value="">{t("radiology.room.down.pick")}</option>
                  {devices.filter((d) => !OUT_OF_SERVICE.has(d.status)).map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
                </select>
                <input className={field} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("radiology.room.down.reasonHint")} data-testid="down-reason" />
                <button type="button" className="rounded border border-red-400 bg-red-50 px-3 py-1 text-sm text-red-900 disabled:opacity-50" data-testid="down-report"
                  disabled={pick === "" || reason.trim() === "" || report.isPending} onClick={() => report.mutate()}>{t("radiology.room.down.markDown")}</button>
              </div>
            )
            : <p className="m-0 text-sm" data-testid="down-ask">{t("radiology.room.down.ask")}</p>}
          {err !== null && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
          {moved !== null && (
            <div role="status" className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="studies-to-move">
              <p className="m-0">{t("radiology.room.down.toMove", { machine: moved.machine, count: moved.studies.length })}</p>
              <ul className="m-0 mt-1 list-none p-0">
                {moved.studies.map((s) => <li key={s.accessionNo} className="mo text-xs">{s.accessionNo} · {s.studyTypeCode}{s.scheduledAt === null ? "" : ` · ${fmtIst(s.scheduledAt)}`}</li>)}
              </ul>
              <p className="m-0 mt-1"><SeatLink to="/radiology/diary">{t("radiology.room.down.toDiary")}</SeatLink></p>
            </div>
          )}
        </section>
        <section className="rounded border border-dashed bg-card px-3 py-2 text-sm" data-testid="paper-mode">
          <h3 className="m-0 mb-1 text-sm font-semibold">{t("radiology.room.down.paperTitle")}</h3>
          <p className="m-0">{t("radiology.room.down.paper")}</p>
        </section>
      </div>
    </RadiologyStation>
  );
}
