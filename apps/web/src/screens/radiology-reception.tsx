import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  checkInStudy, fetchWorklist, radiologyErrorText, scheduleStudy, walkIn,
} from "../lib/radiology-api";
import { Button } from "@/components/ui/button";

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

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">{t("radiology.reception.title")}</h1>

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

      <table className="w-full text-sm">
        <tbody>
          {(q.data?.rows ?? []).map((r) => (
            <tr key={r.studyId} data-testid={`row-${r.studyId}`}>
              <td>{r.accessionNo}</td>
              <td>{r.patientName}</td>
              <td>{r.studyTypeCode}</td>
              <td>{r.status}</td>
              <td className="flex gap-1">
                <Button onClick={() => { book.mutate(r.studyId); }}>{t("radiology.reception.book")}</Button>
                <Button variant="outline" onClick={() => { walk.mutate(r.studyId); }}>
                  {t("radiology.reception.walkIn")}
                </Button>
                <Button variant="outline" onClick={() => { arrive.mutate(r.studyId); }}>
                  {t("radiology.reception.checkIn")}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
