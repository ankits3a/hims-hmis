import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type React from "react";
import { deskWalkInOrder, fetchDeskWalkIn } from "../../lib/radiology-api";
import { ImagingDoorBody, istToday, orderRefusalText } from "./imaging-order-kit";
import type { PlaceImagingOrderBody, WireImagingDoor } from "../../lib/radiology-api";

/**
 * #1079 (IM2b) — **THE DESK DOOR'S THIRD ROAD: AN OUTSIDE SLIP AND NO VISIT TODAY.**
 * Spec docs/specs/1079-imaging-walk-in-visit.md.
 *
 * The patient is found and has no visit today. The clerk searches the book, types the question and the
 * referring doctor's name and registration number off the slip, and sends — ONE server act
 * (`POST /radiology/desk/walk-in-order`) opens the imaging visit under the radiologist of record and places
 * the order on it, or rides today's walk-in if there is one. The door then opens that visit, where the
 * order stands and the counter takes over (Bill → Slot & slip). No consultation fee is taken here or later.
 *
 * The study card and the search are the door's own (`ImagingDoorBody` with `outside`), so the question, the
 * side, the priority, the referrer and the duplicate override are asked exactly as on a visit's slip leg.
 * There is no visit yet, so the view handed to them carries the book and blank visit fields, and the card
 * sends through the walk-in act instead of `POST /radiology/orders`.
 *
 * The radiologist answers for the study: the sole one, or the one the clerk picks when radiology has
 * several (the server refuses to choose). None set up is said plainly — it is the go-live runbook's step.
 */
export function ImagingWalkIn({ patient, onOpened }: {
  patient: { id: string; name: string; uhid: string; administrativeGender: string };
  onOpened: (r: { encounterNo: string; orderNo: string }) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const view = useQuery({ queryKey: ["radiology", "desk", "walk-in"], queryFn: fetchDeskWalkIn, retry: false });
  const [picked, setPicked] = useState("");
  /** The visit the last send opened or rode — the card's `onPlaced` names only the order. */
  const opened = useRef<string | null>(null);

  if (view.isError) {
    return <p role="alert" className="text-sm text-red-700">{orderRefusalText(view.error, t("imagingOrder.forbidden"))}</p>;
  }
  if (view.data === undefined) return <p className="text-xs text-muted-foreground">{t("imagingOrder.walkIn.loading")}</p>;

  const radiologists = view.data.radiologists;
  const radiologist = radiologists.length === 1 ? radiologists[0]! : radiologists.find((r) => r.doctorId === picked) ?? null;

  const door: WireImagingDoor = {
    visit: {
      encounterId: "", encounterNo: "", serviceDate: istToday(), status: "registered",
      doctorName: radiologist?.displayName ?? null, doctorUserId: radiologist?.userId ?? null, departmentName: null,
      patient: {
        id: patient.id, uhid: patient.uhid, display: patient.name,
        administrativeGender: patient.administrativeGender, dob: null, restricted: false,
      },
    },
    bookActive: view.data.bookActive, lines: [], book: view.data.book, recent: {}, orders: [],
  };

  const place = async (body: PlaceImagingOrderBody, idempotencyKey: string): Promise<{ orderNo: string }> => {
    const r = await deskWalkInOrder({
      patientId: patient.id,
      ...(radiologists.length > 1 && radiologist !== null ? { doctorId: radiologist.doctorId } : {}),
      priority: body.priority,
      indication: body.indication,
      items: body.items,
      referrer: body.referrer ?? { name: "", registrationNo: "" },
    }, idempotencyKey);
    opened.current = r.encounterNo;
    return r;
  };

  return (
    <div className="space-y-2 border-t pt-3" data-testid="imaging-desk-walk-in">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("imagingOrder.walkIn.heading")}</h3>
      <p className="text-xs text-muted-foreground">{t("imagingOrder.walkIn.note")}</p>
      {radiologists.length === 0 && (
        <p role="alert" className="text-xs text-red-700" data-testid="walk-in-no-radiologist">{t("imagingOrder.walkIn.noRadiologist")}</p>
      )}
      {radiologists.length === 1 && (
        <p className="text-xs" data-testid="walk-in-radiologist">{t("imagingOrder.walkIn.under", { name: radiologists[0]!.displayName })}</p>
      )}
      {radiologists.length > 1 && (
        <label className="flex flex-col gap-1 text-xs" htmlFor="walk-in-radiologist">
          <span className="font-medium">{t("imagingOrder.walkIn.radiologist")}</span>
          <select
            id="walk-in-radiologist" className="border rounded px-2 py-1 text-sm" style={{ maxWidth: 260 }} value={picked}
            onChange={(e) => { setPicked(e.target.value); }}
          >
            <option value="">{t("imagingOrder.walkIn.pick")}</option>
            {radiologists.map((r) => <option key={r.doctorId} value={r.doctorId}>{r.displayName}</option>)}
          </select>
        </label>
      )}
      {radiologist !== null && (
        <ImagingDoorBody
          view={door} clinicianUserId={radiologist.userId} sendLabel={t("imagingOrder.placeOrder")}
          outside searchOnly place={place}
          onPlaced={(orderNo) => { if (opened.current !== null) onOpened({ encounterNo: opened.current, orderNo }); }}
        />
      )}
    </div>
  );
}
