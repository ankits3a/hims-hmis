import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  checkInStudy, fetchImagingDevices, fetchWorklist, radiologyErrorText, scheduleStudy, walkIn,
} from "../lib/radiology-api";
import type { WireImagingDevice } from "../lib/radiology-api";
import { Button } from "@/components/ui/button";
import { RadiologyStation } from "./radiology-station";
import { ImagingDeskDoor } from "../components/radiology/imaging-desk-door";

/**
 * PLAN 18a T9 — **IMAGING RECEPTION: the desk that books the scan and checks the patient in.**
 *
 * ═══ THIS DESK OPENS NO GATE, AND THAT IS THE POINT ═══
 *
 * `radiology_receptionist` holds `radiology.schedule` and NOT `radiology.gates.satisfy` — *"the
 * person who books the scan and takes the money does not get to record that the patient is not
 * pregnant"* (`manifest.ts`'s first separation). So this screen books, moves and walks in, and the
 * moment a patient is checked in it hands off: the gate set that opens belongs to the console.
 *
 * **Check-in is here anyway**, because the receptionist is who sees the patient arrive. The screen
 * shows WHICH gates opened so the desk can tell the patient what is still needed, and can clear
 * none of them.
 */
export function RadiologyReception(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [deviceResourceId, setDeviceResourceId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [bedside, setBedside] = useState("");
  const bedsideId = useId();
  const [bedStuck, setBedStuck] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ studyId: string; gates: string[] } | null>(null);

  const q = useQuery({ queryKey: ["radiology", "worklist", "floor"], queryFn: () => fetchWorklist("floor") });
  /**
   * 18-S RS2b — the machines, as the counter knows them. Replaces the free-text device id: nobody at
   * a desk can know a ULID. `portable` and `licensedNow` are the server's facts, only rendered here.
   */
  const devicesQ = useQuery({ queryKey: ["radiology", "devices"], queryFn: fetchImagingDevices });
  const devices: WireImagingDevice[] = devicesQ.data?.devices ?? [];
  const chosen = devices.find((d) => d.id === deviceResourceId);
  const deviceLabel = (d: WireImagingDevice): string => [
    d.code, d.name, d.room,
    d.portable ? t("radiology.reception.portable") : null,
    d.ionising && d.licensedNow === false ? t("radiology.reception.notLicensed") : null,
    d.status === "available" || d.status === "in_use" ? null : d.status,
  ].filter((part): part is string => part !== null && part !== "").join(" · ");
  const refresh = () => qc.invalidateQueries({ queryKey: ["radiology", "worklist"] });

  const book = useMutation({
    /**
     * 18-S RS2b — a portable machine sends the ward and bed as `bedsideLocation`; a department
     * machine sends none, so a study already carrying a place is refused `device_not_portable` by
     * the server rather than silently moved.
     */
    mutationFn: ({ studyId, clearBed }: { studyId: string; clearBed?: boolean }) => scheduleStudy(studyId, {
      deviceResourceId, scheduledAt,
      ...(clearBed === true
        ? { bedsideLocation: null }
        : chosen?.portable === true && bedside.trim() !== "" ? { bedsideLocation: bedside.trim() } : {}),
    }),
    onSuccess: () => { setError(null); setBedStuck(null); void refresh(); },
    onError: (e, vars) => {
      setError(radiologyErrorText(e));
      /**
       * The study carries a ward and bed and this machine cannot go there. The recovery the server
       * names is "clear the bedside location and bring the patient to the department" — so the desk
       * gets that act, explicitly, rather than a silent clear on every department booking.
       */
      const code = (e as { body?: { code?: string } } | undefined)?.body?.code;
      setBedStuck(code === "device_not_portable" ? vars.studyId : null);
    },
  });
  const walk = useMutation({
    mutationFn: (studyId: string) => walkIn(studyId),
    onSuccess: () => { setError(null); void refresh(); },
    onError: (e) => { setError(radiologyErrorText(e)); },
  });
  const arrive = useMutation({
    mutationFn: (studyId: string) => checkInStudy(studyId),
    onSuccess: (r) => { setError(null); setOpened({ studyId: r.studyId, gates: r.gates }); void refresh(); },
    onError: (e) => { setError(radiologyErrorText(e)); },
  });

  const rows = q.data?.rows ?? [];
  /**
   * PLAN 18-S RS1 — the desk's queue moves into the station's right column with the same rows and
   * the same three acts per row. The 352px column cannot hold the old five-cell table (the walk at
   * 1440 clipped Walk in and Check in off the edge), so each row stacks: who, what, then the acts.
   * The booking inputs and what check-in opened stay in the centre, which is the work.
   */
  const queue = (
    <ul className="space-y-2" data-testid="radiology-desk-queue">
      {rows.map((r) => (
        <li key={r.studyId} data-testid={`row-${r.studyId}`} className="rounded border bg-card p-2 text-sm">
          <div className="flex justify-between gap-2">
            <b>{r.patientName}</b>
            <span className="mo text-xs">{r.accessionNo}</span>
          </div>
          <div className="text-xs text-muted-foreground">{r.studyTypeCode} · {r.status}</div>
          <div className="mt-2 flex flex-wrap gap-1">
            <Button size="sm" onClick={() => { book.mutate({ studyId: r.studyId }); }}>{t("radiology.reception.book")}</Button>
            <Button size="sm" variant="outline" onClick={() => { walk.mutate(r.studyId); }}>
              {t("radiology.reception.walkIn")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { arrive.mutate(r.studyId); }}>
              {t("radiology.reception.checkIn")}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );


  return (
    <RadiologyStation
      station="desk"
      title={t("radiology.reception.title")}
      place={t("radiology.station.deskPlace")}
      stats={[
        { label: t("radiology.station.onList"), value: rows.length },
        { label: t("radiology.station.stat"), value: rows.filter((r) => r.priority === "stat").length, tone: "danger" },
      ]}
      list={queue}
    >
    <div className="space-y-4">
      {/* PLAN 18-S RS2 — the ordering door sits at the top of the centre (18a-iv D1); its own file. */}
      <ImagingDeskDoor />

      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex min-w-0 flex-col text-sm">
          {t("radiology.reception.device")}
          <select
            className="max-w-full border px-2 py-1" value={deviceResourceId}
            onChange={(e) => { setDeviceResourceId(e.target.value); }}
          >
            <option value="">{t("radiology.reception.devicePick")}</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{deviceLabel(d)}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          {t("radiology.reception.slot")}
          <input
            className="border px-2 py-1" type="datetime-local" value={scheduledAt}
            onChange={(e) => { setScheduledAt(e.target.value === "" ? "" : `${e.target.value}:00.000Z`); }}
          />
        </label>
      </div>

      {chosen?.portable === true
        ? (
          <div className="flex max-w-md flex-col text-sm">
            <label htmlFor={bedsideId}>{t("radiology.reception.bedside")}</label>
            <input
              id={bedsideId} aria-describedby={`${bedsideId}-hint`}
              className="border px-2 py-1" value={bedside} maxLength={120}
              placeholder={t("radiology.reception.bedsidePlaceholder")}
              onChange={(e) => { setBedside(e.target.value); }}
            />
            <span id={`${bedsideId}-hint`} className="text-xs text-muted-foreground">{t("radiology.reception.bedsideHint")}</span>
          </div>
        )
        : null}

      {devicesQ.isError ? <p className="text-red-600" data-testid="devices-error">{radiologyErrorText(devicesQ.error)}</p> : null}
      {error !== null ? <p role="alert" className="text-red-600">{error}</p> : null}
      {bedStuck !== null
        ? (
          <Button variant="outline" onClick={() => { book.mutate({ studyId: bedStuck, clearBed: true }); }}>
            {t("radiology.reception.clearBed")}
          </Button>
        )
        : null}

      {/**
        * The gate set, shown the moment it opens. The desk can say "we still need your creatinine"
        * and cannot clear it — which is the separation made visible rather than merely enforced.
        */}
      {opened !== null
        ? (
          <div role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm">
            <p>{t("radiology.reception.checkedIn")}</p>
            <ul>{opened.gates.map((g) => <li key={g}>{t(`radiology.gate.${g}`, { defaultValue: g })}</li>)}</ul>
          </div>
        )
        : null}
    </div>
    </RadiologyStation>
  );
}
