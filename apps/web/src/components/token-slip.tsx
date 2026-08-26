import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export type TokenSlipProps = {
  tokenNo: number;
  visitNo: string;
  roomCode: string | null;
  doctorName: string;
  departmentCode: string;
  departmentName: string;
  serviceDate: string;
  patient: { uhid: string; name: string | null };
  qrPayload: string;
  visitType: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-08-17` → `17-Aug-2026`. Pure string work on an IST calendar date — constructing a Date
 *  here would re-introduce the timezone question the server already answered. */
function humanDate(serviceDate: string): string {
  const [y, m, d] = serviceDate.split("-");
  const month = MONTHS[Number(m) - 1];
  return month === undefined ? serviceDate : `${d}-${month}-${y}`;
}

/**
 * The printed token slip (D7 / §11.5): token + doctor + room only — no signature line, no more of
 * the patient than the desk that just checked them in already has on screen. `.print-doc` isolation
 * (Step 1 of this task) makes this the ONLY element that reaches the paper; a screen that could ever
 * mount this alongside another `.print-doc` surface (e.g. an e-Rx dialog) is responsible for keeping
 * the two mutually exclusive — this component itself has no opinion on that.
 */
export function TokenSlip(props: TokenSlipProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="print-doc w-[360px] space-y-2 rounded-lg border p-4">
        <p className="text-xs text-neutral-500">{t("hospital.name")}</p>
        <p className="text-sm font-medium">{props.departmentCode} · {props.departmentName}</p>
        <p className="text-sm">{props.doctorName}</p>
        <p className="text-sm">{t("slip.room")}: {props.roomCode ?? "—"}</p>
        <p data-testid="token-no" className="text-4xl font-bold tabular-nums">{props.tokenNo}</p>
        {/*
          THE VISIT NUMBER, AND ITS DATE, TOGETHER — never the number alone. `V2608170001` carries
          its date as YYMMDD so the id sorts chronologically, but a desk reading DD-MM-YY sees
          260817 as 26-Aug-2017. The spelled month beside it is the resolution, and it is why this
          pairing is a single line rather than two that a later layout change could separate.
        */}
        <p data-testid="visit-no" className="font-mono text-sm">{props.visitNo} · {humanDate(props.serviceDate)}</p>
        <p className="font-mono text-sm">{props.patient.uhid}</p>
        {props.patient.name !== null && <p className="text-sm">{props.patient.name}</p>}
        <p className="text-sm">{t(`opd.visitType.${props.visitType}`)}</p>
        <QRCodeSVG value={props.qrPayload} size={96} />
      </div>
      <Button type="button" className="no-print" onClick={() => window.print()}>
        {t("slip.print")}
      </Button>
    </div>
  );
}
