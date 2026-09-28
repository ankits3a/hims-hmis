import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  checkInStudy, fetchWorklist, radiologyErrorText, scheduleStudy, walkIn,
} from "../lib/radiology-api";
import { Button } from "@/components/ui/button";
import { RadiologyStation } from "./radiology-station";

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
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ studyId: string; gates: string[] } | null>(null);

  const q = useQuery({ queryKey: ["radiology", "worklist", "floor"], queryFn: () => fetchWorklist("floor") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["radiology", "worklist"] });

  const book = useMutation({
    mutationFn: (studyId: string) => scheduleStudy(studyId, { deviceResourceId, scheduledAt }),
    onSuccess: () => { setError(null); void refresh(); },
    onError: (e) => { setError(radiologyErrorText(e)); },
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
            <Button size="sm" onClick={() => { book.mutate(r.studyId); }}>{t("radiology.reception.book")}</Button>
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

      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col text-sm">
          {t("radiology.reception.device")}
          <input
            className="border px-2 py-1" value={deviceResourceId}
            onChange={(e) => { setDeviceResourceId(e.target.value); }}
          />
        </label>
        <label className="flex flex-col text-sm">
          {t("radiology.reception.slot")}
          <input
            className="border px-2 py-1" type="datetime-local" value={scheduledAt}
            onChange={(e) => { setScheduledAt(e.target.value === "" ? "" : `${e.target.value}:00.000Z`); }}
          />
        </label>
      </div>

      {error !== null ? <p role="alert" className="text-red-600">{error}</p> : null}

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
