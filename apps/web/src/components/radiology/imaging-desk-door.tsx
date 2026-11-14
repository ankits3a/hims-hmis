import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type React from "react";
import { fetchDeskVisits, fetchImagingDoor } from "../../lib/radiology-api";
import { searchPatients } from "../../lib/patients-api";
import { fmtIst } from "../../lib/format";
import { ImagingDoorBody, VisitOrders, orderRefusalText } from "./imaging-order-kit";
import { CreditChip } from "../patient-credit";

/**
 * PLAN 18-S RS2 (18a-iv T2 + T3), #1078 — **THE IMAGING DESK'S DOOR: find the patient, open the visit,
 * order from it or from a slip.**
 *
 * 18a-iv D1: the door is the imaging reception's, at the top of the seat, not a new screen — so it
 * sits in the station's CENTRE and the queue stays the right-hand list.
 *
 *   · **Finding.** #1078 — ONE box takes a UHID, a phone number, a name or a visit number. A visit
 *     number (`V…`, `D…`) opens that visit; anything else goes through the house patient search
 *     (`GET /patients/search`, the same lanes and reasons every desk uses), and the patient picked
 *     shows their visits of today (`GET /radiology/desk/visits`). One patient and one visit open by
 *     themselves. Registering a new patient stays at Registration.
 *   · **From a visit.** The doctor's advised imaging lines come back — and ONLY those: a study the
 *     doctor did not advise is not put under the doctor's name here (DECIDED); it goes through the slip
 *     leg below. A line the book does not name is greyed WITH its reason (D6 — a receptionist who cannot
 *     see an advised line believes it was never advised, and phones the doctor). A line already on
 *     the visit is marked and cannot be ordered twice (D3). Each needs a typed question (D4).
 *   · **From an outside slip** (D5). A manual search over the active book, placed under
 *     `external_prescription` with the referrer's name and registration typed off the slip. The
 *     visit's doctor stays the answerable clinician — the kernel requires one on every imaging order.
 *
 * The desk books and bills afterwards, at the counter; nothing here bills.
 */

/**
 * A visit number as the slip prints it: the episode letter and the day's ten digits (`V2609280007`,
 * `D2603100001`). A UHID is a prefix and eight digits (`U00110012`), so it never reads as one.
 */
const VISIT_NO = /^[VD]\d{10,}$/;

export function ImagingDeskDoor({ onOpen }: {
  /**
   * 18-S RS3 — take the found visit to the counter (Bill → Slot & slip). Opening it is the patient
   * arriving at the desk, so it is also what checks in a study booked for today.
   */
  onOpen?: (visit: { encounterNo: string; patientId: string }) => void;
} = {}): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  /** What the box was asked: a visit number, or a patient search. */
  const [asked, setAsked] = useState<{ visitNo: string } | { q: string } | null>(null);
  const [patientPick, setPatientPick] = useState<string | null>(null);
  const [visitPick, setVisitPick] = useState<string | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);

  const searchQ = asked !== null && "q" in asked ? asked.q : null;
  const hits = useQuery({
    queryKey: ["patients", "search", "imaging-desk", searchQ ?? ""],
    queryFn: () => searchPatients(searchQ ?? "", 8),
    enabled: searchQ !== null && searchQ.length >= 2,
    retry: false,
  });
  const hitList = hits.data ?? [];
  const patientId = patientPick ?? (hitList.length === 1 ? hitList[0]!.id : null);

  const visits = useQuery({
    queryKey: ["radiology", "desk", "visits", patientId ?? ""],
    queryFn: () => fetchDeskVisits(patientId ?? ""),
    enabled: patientId !== null,
    retry: false,
  });
  const visitList = visits.data?.visits ?? [];

  const visitNo = asked !== null && "visitNo" in asked
    ? asked.visitNo
    : visitPick ?? (visitList.length === 1 ? visitList[0]!.encounterNo : null);

  const door = useQuery({
    queryKey: ["radiology", "door", visitNo ?? ""],
    queryFn: () => fetchImagingDoor(visitNo ?? ""),
    enabled: visitNo !== null,
    retry: false,
  });

  const find = (e: React.FormEvent): void => {
    e.preventDefault();
    const v = typed.trim();
    setPlaced(null);
    setPatientPick(null);
    setVisitPick(null);
    if (v === "") setAsked(null);
    else if (VISIT_NO.test(v.toUpperCase())) setAsked({ visitNo: v.toUpperCase() });
    else setAsked({ q: v });
  };
  const onPlaced = (orderNo: string): void => {
    setPlaced(orderNo);
    void qc.invalidateQueries({ queryKey: ["radiology", "door", visitNo ?? ""] });
    void qc.invalidateQueries({ queryKey: ["radiology", "worklist"] });
  };

  const v = door.data?.visit;
  return (
    <section data-testid="imaging-desk-door" className="rounded border bg-card p-3 space-y-3" style={{ minWidth: 0 }}>
      <h2 className="text-base font-semibold">{t("imagingOrder.desk.heading")}</h2>
      <form className="flex flex-wrap gap-2 items-end" onSubmit={find}>
        <label className="flex min-w-0 flex-col gap-1 text-xs" htmlFor="imaging-desk-visit">
          <span className="font-medium">{t("imagingOrder.desk.find")}</span>
          <input
            id="imaging-desk-visit" className="border rounded px-2 py-1 text-sm mo" style={{ width: 260, maxWidth: "100%" }}
            placeholder={t("imagingOrder.desk.findPlaceholder")} value={typed}
            onChange={(e) => { setTyped(e.target.value); }}
          />
        </label>
        <button type="submit" className="rounded border px-3 py-1 text-sm">{t("imagingOrder.desk.findButton")}</button>
      </form>

      {asked === null && <p className="text-xs text-muted-foreground">{t("imagingOrder.desk.noVisit")}</p>}

      {searchQ !== null && (
        <div className="space-y-2">
          {hits.isError && <p role="alert" className="text-sm text-red-700">{orderRefusalText(hits.error, t("imagingOrder.forbidden"))}</p>}
          {hits.isSuccess && hitList.length === 0 && <p className="text-sm text-muted-foreground">{t("imagingOrder.desk.noPatient")}</p>}
          {hitList.length > 0 && (
            <ul className="m-0 list-none space-y-1 p-0" data-testid="desk-door-patients" aria-label={t("imagingOrder.desk.patients")}>
              {hitList.map((h) => (
                <li key={h.id}>
                  <button
                    type="button" aria-pressed={patientId === h.id}
                    className={`w-full rounded border px-2 py-1 text-left text-sm ${patientId === h.id ? "border-green-700 bg-green-50" : ""}`}
                    onClick={() => { setPatientPick(h.id); setVisitPick(null); }}
                  >
                    <b>{h.name}</b> <span className="mo text-xs">{h.uhid}</span>
                    <span className="block text-xs text-muted-foreground">
                      {[h.administrativeGender, h.phone, h.district].filter((x) => x !== null && x !== "").join(" · ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {patientId !== null && visits.isError && (
            <p role="alert" className="text-sm text-red-700">{orderRefusalText(visits.error, t("imagingOrder.forbidden"))}</p>
          )}
          {patientId !== null && visits.isSuccess && visitList.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="desk-door-no-visit">{t("imagingOrder.desk.noVisitToday")}</p>
          )}
          {visitList.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-1 p-0" data-testid="desk-door-visits" aria-label={t("imagingOrder.desk.visitsToday")}>
              {visitList.map((x) => (
                <li key={x.encounterNo}>
                  <button
                    type="button" aria-pressed={visitNo === x.encounterNo}
                    className={`rounded border px-2 py-1 text-sm ${visitNo === x.encounterNo ? "border-green-700 bg-green-50" : ""}`}
                    onClick={() => { setVisitPick(x.encounterNo); setPlaced(null); }}
                  >
                    <span className="mo">{x.encounterNo}</span> · {fmtIst(x.openedAt)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {door.isError && <p role="alert" className="text-sm text-red-700">{orderRefusalText(door.error, t("imagingOrder.forbidden"))}</p>}
      {placed !== null && <p role="status" className="text-sm text-green-800">{t("imagingOrder.placed", { orderNo: placed })}</p>}

      {door.data !== undefined && v !== undefined && (
        <div className="space-y-3">
          <div className="text-sm" data-testid="imaging-desk-visit-head">
            <b>{v.patient.display}</b> <span className="mo text-xs">{v.patient.uhid}</span> <CreditChip patientId={v.patient.id} testId="imaging-credit" />
            <div className="text-xs text-muted-foreground">
              {t("imagingOrder.desk.visitLine", { visitNo: v.encounterNo, doctor: v.doctorName ?? "—", department: v.departmentName ?? "—" })}
            </div>
          </div>
          {v.doctorUserId === null && <p role="alert" className="text-xs text-red-700">{t("imagingOrder.noDoctor")}</p>}
          {onOpen !== undefined && door.data.orders.some((o) => o.items.some((i) => i.study !== null)) && (
            <button
              type="button" className="rounded border border-green-700 px-3 py-1 text-sm font-semibold"
              data-testid="imaging-desk-open"
              onClick={() => onOpen({ encounterNo: v.encounterNo, patientId: v.patient.id })}
            >
              {t("radiology.counter.openVisit")}
            </button>
          )}

          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("imagingOrder.desk.advised")}</h3>
            <ImagingDoorBody
              view={door.data} clinicianUserId={v.doctorUserId} sendLabel={t("imagingOrder.placeOrder")} onPlaced={onPlaced}
              advisedOnly
            />
          </div>

          <div className="space-y-2 border-t pt-3" data-testid="imaging-desk-outside">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("imagingOrder.outside.heading")}</h3>
            <p className="text-xs text-muted-foreground">{t("imagingOrder.outside.note")}</p>
            <ImagingDoorBody
              view={door.data} clinicianUserId={v.doctorUserId} sendLabel={t("imagingOrder.placeOrder")} onPlaced={onPlaced}
              outside searchOnly
            />
          </div>

          <VisitOrders orders={door.data.orders} />
        </div>
      )}
    </section>
  );
}
