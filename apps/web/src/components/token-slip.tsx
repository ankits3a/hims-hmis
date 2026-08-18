import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export type TokenSlipProps = {
  tokenNo: number;
  roomCode: string | null;
  doctorName: string;
  departmentCode: string;
  departmentName: string;
  serviceDate: string;
  patient: { uhid: string; name: string | null };
  qrPayload: string;
  visitType: string;
};

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
        <p className="text-sm text-neutral-600">{props.serviceDate}</p>
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
