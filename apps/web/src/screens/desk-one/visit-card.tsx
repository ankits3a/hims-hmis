import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { listDepartments, listQueueSummary, moveVisitDepartment, opdErrorMessage, todayIst } from "../../lib/opd-api";
import { GuardianAbsentAction, PatientAbsentNotice } from "../../components/patient-absent";
import { useAuth } from "../../lib/auth";
import { useDoctorLabel } from "../../lib/use-doctor-label";
import { dayMonthIst } from "../../lib/format";
import { deptQueues, rs, tokenLabel } from "./model";
import { MoveDepartmentForm } from "./move-department";
import { PapersSheet } from "./papers";
import { useDeskOptional } from "./session";
import type { WirePatientAbsent, WireTimelineItem } from "../../lib/opd-api";

/** Only these move — once the doctor has seen the patient, a move is the doctor's internal referral. */
const MOVABLE = new Set(["registered", "waiting"]);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * OWNER 2026-10-05 — ONE VISIT CARD, THE SAME EVERYWHERE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"How can I change the department after I click 'hand over'? Can't I go to the patient profile
 * and click on the visit and change it? Or … clicking on this visit from the history, I should see
 * a change department or modify visit option along with token, prescription and bills."* The owner
 * said "yes go ahead" to one card for one visit, opened from Desk One's history (the counter and the
 * appointment seats), its full history sheet and the patient profile.
 *
 * It is the FD-27 papers sheet grown a header and one act: who and where the visit is, the slips
 * and bills exactly as before, and "Change department" for a visit nobody has seen yet. The move is
 * the same panel as at the bill (`MoveDepartmentForm`); the visit Desk One is holding moves through
 * the desk's own `moveDepartment`, so the patient in hand follows it — any other visit goes straight
 * to the server, and the card then shows the visit the patient now holds.
 */
export function VisitCard({
  encounterId, when, visit,
}: {
  encounterId: string;
  when: string | null;
  /** The visit's timeline row, when the opener has it; `null` is the visit Desk One holds. */
  visit: WireTimelineItem | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const d = useDeskOptional();
  const today = todayIst();
  const [current, setCurrent] = useState<{ encounterId: string; when: string | null; visit: WireTimelineItem | null }>({ encounterId, when, visit });
  const [moving, setMoving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  // Off the desk, the card reads the day's board itself; on it, the desk already holds both.
  const offDesk = d === null;
  const departments = useQuery({ queryKey: ["d1", "departments"], queryFn: listDepartments, enabled: offDesk && can("opd.visits.open"), retry: false });
  const summaries = useQuery({ queryKey: ["d1", "summary", today], queryFn: () => listQueueSummary(today), enabled: offDesk && can("opd.visits.open"), retry: false });
  const ownLabel = useDoctorLabel(today);
  const queues = useMemo(
    () => (d !== null ? d.queues : deptQueues(summaries.data?.items ?? [], departments.data?.items ?? [])),
    [d, summaries.data, departments.data],
  );
  const doctorLabel = d?.doctorLabel ?? ownLabel;
  const deptList = d !== null ? d.departments : (departments.data?.items ?? []);

  /*
    OWNER 2026-10-07 — the guardian came with the reports. Whether this visit may skip the bay turns on
    three facts the desk's own state does not carry (the kind of visit, where it stands now, whether it
    is already marked), so the card reads the visit itself — `opd.visits.read`, the grant every seat
    that opens this card holds. A read that fails offers nothing, which is the safe answer.
  */
  const detail = useQuery({
    queryKey: ["d1", "visit-detail", current.encounterId],
    queryFn: () => api<{ encounter: { status: string; visitType: string; serviceDate: string }; patientAbsent?: WirePatientAbsent | null }>(
      "GET", `/opd/visits/${encodeURIComponent(current.encounterId)}`),
    enabled: can("opd.visits.open") || can("opd.vitals.record"),
    retry: false,
  });
  const absent = detail.data?.patientAbsent ?? null;
  const mayMarkAbsent = absent === null && detail.data !== undefined
    && detail.data.encounter.visitType === "revisit" && detail.data.encounter.status === "registered"
    && detail.data.encounter.serviceDate === today;

  const inHand = d !== null && d.s.visit !== null && d.s.visit.encounterId === current.encounterId ? d.s.visit : null;
  const v = current.visit;
  const status = detail.data?.encounter.status ?? v?.status ?? (inHand !== null ? "registered" : null);
  const departmentId = v?.departmentId ?? inHand?.departmentId ?? null;
  const departmentName = v?.departmentName ?? inHand?.departmentName ?? null;
  const doctorName = v?.doctorName ?? inHand?.doctorName ?? null;
  const doctorRow = (d !== null ? d.summaries : summaries.data?.items ?? []).find((x) => x.doctor.id === (v?.doctorId ?? inHand?.doctorId));
  const unit = doctorRow === undefined ? null : doctorLabel(doctorRow.doctor);
  const departmentCode = deptList.find((x) => x.id === departmentId)?.code ?? null;
  const tokenNo = inHand?.tokenNo ?? null;
  const visitNo = v?.visitNo ?? inHand?.visitNo ?? null;

  const mayMove = can("opd.visits.open") && status !== null && MOVABLE.has(status);

  return (
    <div data-testid="visit-card">
      <div style={{ padding: "16px 18px 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span data-testid="visit-card-title" style={{ fontSize: 15, fontWeight: 700 }}>
            {visitNo === null || visitNo === "" ? t("visitCard.titleBare") : t("visitCard.title", { no: visitNo })}
          </span>
          {status === null ? null : (
            <span
              data-testid="visit-card-status"
              className={status === "abandoned" ? "pill gd" : status === "completed" ? "pill on" : "pill"}
              style={{ height: 20 }}
            >
              {t(`visitCard.status.${status}`, { defaultValue: status })}
            </span>
          )}
        </div>
        <div data-testid="visit-card-where" style={{ fontSize: 12, color: "var(--dim)", marginTop: 4, lineHeight: "17px" }}>
          {[
            current.when === null ? null : dayMonthIst(current.when),
            departmentName,
            doctorName === null ? null : `${doctorName}${unit === null ? "" : ` · ${unit}`}`,
            tokenNo === null ? null : tokenLabel(departmentCode, tokenNo),
          ].filter((x): x is string => x !== null && x !== "").join(" · ")}
        </div>

        {done === null ? null : (
          <p role="status" data-testid="visit-card-moved" style={{ margin: "10px 0 0", fontSize: 12, fontWeight: 600, color: "var(--green)" }}>{done}</p>
        )}

        {/* ═══ THE GUARDIAN CAME WITH THE REPORTS (owner 2026-10-07) ═══ */}
        {absent !== null ? (
          <div style={{ marginTop: 10 }}><PatientAbsentNotice absent={absent} testId="visit-card-absent-notice" /></div>
        ) : mayMarkAbsent ? (
          <div style={{ marginTop: 10, display: "flex" }}>
            <GuardianAbsentAction
              encounterId={current.encounterId} testId="visit-card-absent"
              onDone={() => {
                setDone(t("patientAbsent.done"));
                void qc.invalidateQueries({ queryKey: ["d1"] });
                void qc.invalidateQueries({ queryKey: ["opd-timeline"] });
              }}
            />
          </div>
        ) : null}

        {/* ═══ CHANGE DEPARTMENT ═══ */}
        {!can("opd.visits.open") ? null : status === "abandoned" ? (
          <p data-testid="visit-card-cancelled" style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--faint)" }}>{t("visitCard.abandoned")}</p>
        ) : !mayMove ? (
          status === null ? null : (
            <p data-testid="visit-card-seen" style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--faint)", lineHeight: "16px" }}>{t("visitCard.seenByDoctor")}</p>
          )
        ) : moving ? (
          <MoveDepartmentForm
            visit={{ encounterId: current.encounterId, departmentId, departmentName, doctorName, departmentCode, tokenNo }}
            queues={queues}
            doctorLabel={doctorLabel}
            onClose={() => { setMoving(false); }}
            onMove={async (input) => {
              const deptName = queues.find((q) => q.departmentId === input.departmentId)?.departmentName ?? input.departmentId;
              const newCode = deptList.find((x) => x.id === input.departmentId)?.code ?? null;
              if (inHand !== null && d !== null) {
                // The visit the desk holds: the desk re-seats the patient in hand on the new visit.
                const refused = await d.moveDepartment(input.departmentId, input.doctorId, input.reason, input.tenders);
                if (refused !== null) return refused;
                setDone(t("visitCard.moved", { dept: deptName, token: "—" }));
                d.patch({ overlay: null, papersFor: null });
                return null;
              }
              try {
                const res = await moveVisitDepartment(current.encounterId, input);
                const newDoctor = queues.flatMap((q) => q.doctors).find((x) => x.doctor.id === input.doctorId)?.doctor ?? null;
                const extra = res.money === undefined ? "" : [
                  res.money.collectedPaise > 0 ? t("registrationCounter.move.money.doneCollected", { amount: rs(res.money.collectedPaise) }) : null,
                  res.money.advancePaise > 0 ? t("registrationCounter.move.money.doneCredit", { amount: rs(res.money.advancePaise) }) : null,
                ].filter((x): x is string => x !== null).map((x) => ` ${x}.`).join("");
                setDone(t("visitCard.moved", { dept: deptName, token: res.to.tokenNo === null ? "—" : tokenLabel(newCode, res.to.tokenNo) }) + extra);
                setCurrent({
                  encounterId: res.to.encounter.id,
                  when: res.to.encounter.serviceDate,
                  visit: {
                    ...(v ?? ({} as WireTimelineItem)),
                    encounterId: res.to.encounter.id, visitNo: res.to.encounter.visitNo, status: res.to.encounter.status,
                    serviceDate: res.to.encounter.serviceDate, visitType: res.to.visitType,
                    departmentId: input.departmentId, departmentName: deptName,
                    doctorId: input.doctorId, doctorName: newDoctor?.displayName ?? null,
                  },
                });
                // Every list that showed the old visit re-reads: the desk's history, the profile's timeline, the board.
                void qc.invalidateQueries({ queryKey: ["d1"] });
                void qc.invalidateQueries({ queryKey: ["opd-timeline"] });
                void qc.invalidateQueries({ queryKey: ["pf-appt-bills"] });
                return null;
              } catch (e) {
                return opdErrorMessage(e);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="sec grn"
            data-testid="visit-card-move"
            style={{ height: 34, marginTop: 12 }}
            onClick={() => { setDone(null); setMoving(true); }}
          >
            {t("visitCard.changeDept")}
          </button>
        )}
      </div>

      {/* ═══ THE PAPERS — token slip, prescription, bills — exactly as FD-27 drew them ═══ */}
      <PapersSheet key={current.encounterId} encounterId={current.encounterId} when={current.when} />
    </div>
  );
}
