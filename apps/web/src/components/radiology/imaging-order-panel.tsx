import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type React from "react";
import { fetchImagingDoor } from "../../lib/radiology-api";
import { ImagingDoorBody, VisitOrders, orderRefusalText } from "./imaging-order-kit";

/**
 * PLAN 18-S RS2 — **ORDER IMAGING, inside the consult** (board: "Doctor's door → Order imaging").
 *
 * The doctor's explicit *Send to imaging* is an ORDER, not advice (18-S RS2 DECIDED, departing from
 * 18a-iv D2 and saying so): it lands at the imaging desk as *to book* and is billed only when the
 * desk books it. Lines only advised on the prescription stay suggestions the desk confirms.
 *
 * Mounted by ONE line in `opd-consult.tsx` (the Investigations tab), so the consult lane's screen
 * carries no imaging logic. `advisedKey` changes whenever the doctor's advised list changes, which
 * is what makes a CT just advised in the tab above appear here without a reload.
 */
export function ImagingOrderPanel({ encounterNo, clinicianUserId, advisedKey }: {
  encounterNo: string | null;
  clinicianUserId: string | null;
  advisedKey: string;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [placed, setPlaced] = useState<string | null>(null);
  const door = useQuery({
    queryKey: ["radiology", "door", encounterNo ?? "", advisedKey],
    queryFn: () => fetchImagingDoor(encounterNo ?? ""),
    enabled: encounterNo !== null,
    retry: false,
  });
  if (encounterNo === null) return null;

  return (
    <div data-testid="imaging-order-panel" className="box" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "13px 15px", minWidth: 0 }}>
      <h2 className="tag" style={{ margin: 0 }}>{t("imagingOrder.title")}</h2>
      <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("imagingOrder.consultNote")}</p>
      {door.isError && <p role="alert" className="text-xs text-red-700">{orderRefusalText(door.error, t("imagingOrder.forbidden"))}</p>}
      {placed !== null && <p role="status" className="text-xs text-green-800">{t("imagingOrder.placed", { orderNo: placed })}</p>}
      {door.data !== undefined && (
        <>
          <ImagingDoorBody
            view={door.data} clinicianUserId={clinicianUserId} sendLabel={t("imagingOrder.send")}
            onPlaced={(orderNo) => { setPlaced(orderNo); void qc.invalidateQueries({ queryKey: ["radiology", "door", encounterNo] }); }}
          />
          <VisitOrders orders={door.data.orders} />
        </>
      )}
    </div>
  );
}
