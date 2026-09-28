import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type React from "react";
import { fetchImagingDoor } from "../../lib/radiology-api";
import { ImagingDoorBody, VisitOrders, orderRefusalText } from "./imaging-order-kit";

/**
 * PLAN 18-S RS2 (18a-iv T2 + T3) — **THE IMAGING DESK'S DOOR: order from a visit, or from a slip.**
 *
 * 18a-iv D1: the door is the imaging reception's, at the top of the seat, not a new screen — so it
 * sits in the station's CENTRE and the queue stays the right-hand list.
 *
 *   · **From a visit.** The receptionist types the `V…` number; the doctor's advised imaging lines come
 *     back — and ONLY those: a study the doctor did not advise is not put under the doctor's name here
 *     (DECIDED); it goes through the slip leg below. A line the book does not name is greyed WITH its reason (D6 — a receptionist who cannot
 *     see an advised line believes it was never advised, and phones the doctor). A line already on
 *     the visit is marked and cannot be ordered twice (D3). Each needs a typed question (D4).
 *   · **From an outside slip** (D5). A manual search over the active book, placed under
 *     `external_prescription` with the referrer's name and registration typed off the slip. The
 *     visit's doctor stays the answerable clinician — the kernel requires one on every imaging order.
 *
 * The desk books and bills afterwards, from the queue; nothing here bills.
 */
export function ImagingDeskDoor(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const [visitNo, setVisitNo] = useState<string | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);

  const door = useQuery({
    queryKey: ["radiology", "door", visitNo ?? ""],
    queryFn: () => fetchImagingDoor(visitNo ?? ""),
    enabled: visitNo !== null,
    retry: false,
  });

  const find = (e: React.FormEvent): void => {
    e.preventDefault();
    const v = typed.trim().toUpperCase();
    setPlaced(null);
    setVisitNo(v === "" ? null : v);
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
        <label className="flex flex-col gap-1 text-xs" htmlFor="imaging-desk-visit">
          <span className="font-medium">{t("imagingOrder.desk.find")}</span>
          <input
            id="imaging-desk-visit" className="border rounded px-2 py-1 text-sm mo" style={{ width: 180, maxWidth: "100%" }}
            placeholder={t("imagingOrder.desk.findPlaceholder")} value={typed}
            onChange={(e) => { setTyped(e.target.value); }}
          />
        </label>
        <button type="submit" className="rounded border px-3 py-1 text-sm">{t("imagingOrder.desk.findButton")}</button>
      </form>

      {visitNo === null && <p className="text-xs text-muted-foreground">{t("imagingOrder.desk.noVisit")}</p>}
      {door.isError && <p role="alert" className="text-sm text-red-700">{orderRefusalText(door.error, t("imagingOrder.forbidden"))}</p>}
      {placed !== null && <p role="status" className="text-sm text-green-800">{t("imagingOrder.placed", { orderNo: placed })}</p>}

      {door.data !== undefined && v !== undefined && (
        <div className="space-y-3">
          <div className="text-sm" data-testid="imaging-desk-visit-head">
            <b>{v.patient.display}</b> <span className="mo text-xs">{v.patient.uhid}</span>
            <div className="text-xs text-muted-foreground">
              {t("imagingOrder.desk.visitLine", { visitNo: v.encounterNo, doctor: v.doctorName ?? "—", department: v.departmentName ?? "—" })}
            </div>
          </div>
          {v.doctorUserId === null && <p role="alert" className="text-xs text-red-700">{t("imagingOrder.noDoctor")}</p>}

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
