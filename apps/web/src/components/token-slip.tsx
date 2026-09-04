import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";

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
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TOKEN CARD — ON SCREEN. IT IS NO LONGER A PRINTED DOCUMENT (FD-24 T6)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This used to carry `.print-doc` and a `window.print()` button, and it was the app's only way to
 * put a token on paper. Owner ruling R1 made printing SERVER-SIDE, and checking a patient in now
 * queues a real 72 mm slip inside the visit's own transaction (`joinSessionInTx`). Leaving the
 * browser path here would mean TWO DIFFERENT TOKEN SLIPS in circulation for one patient:
 *
 *   · this one — A5 (the global `@page`), on whatever printer the browser defaults to, with a BARE
 *     token number; and
 *   · the real one — 72 mm continuous, on the front desk's thermal, reading `MED-4`.
 *
 * A patient holding both, or a clerk handing over whichever appeared first, is exactly the confusion
 * FD-24 T6 exists to prevent. So the print button and `.print-doc` are gone and this is now what it
 * always actually was on screen: **the clerk's confirmation of what was just issued** — read aloud,
 * checked against the paper coming out of the thermal printer.
 *
 * THE TOKEN READS `MED-4`, NOT `4`, and that is a defect repair rather than a restyle. Since FD-20
 * the series is per DEPARTMENT, so `MED-4` and `PED-4` exist at the same moment by design; a bare
 * number on the screen beside a prefixed number on the slip is a patient sent to the wrong door.
 *
 * ═══ THE GAP THIS OPENS, STATED PLAINLY ═══
 *
 * Until the print relay is installed in the hospital, NOTHING PRINTS from here. That is the direct
 * consequence of the server-side ruling and not an oversight: jobs queue correctly and print the
 * moment a relay comes up. Owner ruling R7 is what makes the interval survivable — a print failure
 * is advisory, and a patient can be sent to the doctor on a spoken token.
 */
export function TokenSlip(props: TokenSlipProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div data-testid="token-card" className="w-[360px] space-y-2 rounded-lg border p-4">
        <p className="text-xs text-neutral-500">{t("hospital.name")}</p>
        <p className="text-sm font-medium">{props.departmentCode} · {props.departmentName}</p>
        <p className="text-sm">{props.doctorName}</p>
        <p className="text-sm">{t("slip.room")}: {props.roomCode ?? "—"}</p>
        <p data-testid="token-no" className="text-4xl font-bold tabular-nums">
          {props.departmentCode.trim() === "" ? props.tokenNo : `${props.departmentCode.trim().toUpperCase()}-${String(props.tokenNo)}`}
        </p>
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
    </div>
  );
}
