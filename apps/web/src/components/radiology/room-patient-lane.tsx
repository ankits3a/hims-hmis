import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type React from "react";
import { fetchReadiness } from "../../lib/radiology-api";
import { fetchCumulativeDose } from "../../lib/aerb-api";
import { fetchRoomView } from "../../lib/radiology-room-api";
import { CreditChip } from "../patient-credit";

/**
 * PLAN 18-S RS6 — **THE LEFT LANE OF THE ROOMS: the patient on the table** (the room console and, at the
 * bedside, the portable round). Who they are, what the table must know before anything starts — age and
 * sex, allergies, weight, the kidney, the pregnancy screen, the twelve-month ionising history — and the
 * one way to put them down.
 *
 * #1087 — moved out of `radiology-room.tsx` so the portable round, now a view OF the rooms, can use it
 * without the two screens importing each other. The "study page" link is gone: that address now opens
 * this same console.
 */
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
      <button type="button" className="rounded border px-3 py-1 text-sm" onClick={onClear}>
        {t("radiology.room.lane.clear")} <span className="kb">Esc</span>
      </button>
    </div>
  );
}
