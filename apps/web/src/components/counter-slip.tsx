import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";

/**
 * PLAN 07b T9 — THE TOKEN AND THE RECEIPT ON ONE PIECE OF PAPER.
 *
 * The walk-in produced two documents and the counter printed them separately: a token slip from the
 * OPD desk and an invoice from the billing screen, each its own click and its own trip to the
 * printer. The patient carries both to the same place.
 *
 * ═══ WHY THIS IS ONE NODE AND NOT TWO SIBLINGS (spike S2, measured) ═══
 *
 * `styles.css` prints by hiding everything and re-showing `.print-doc`, and it positions that node
 * `position: fixed; left: 0; top: 0`. TWO `.print-doc` elements therefore do not print as two pages
 * — they STACK ON TOP OF EACH OTHER at the same origin, and the paper comes out with the receipt
 * overprinting the token. That is why `opd-desk.tsx`'s header calls "one `.print-doc` at a time"
 * load-bearing, and why combining the two documents means ONE node with two sections rather than
 * mounting both components.
 *
 * The fee half is omitted entirely for a free revisit — printing "₹0" invites the patient to ask
 * what the zero is for, and the slip already says the follow-up is free in words.
 */
export type CounterSlipProps = {
  tokenNo: number;
  visitNo: string;
  serviceDate: string;
  doctorName: string;
  departmentName: string;
  roomCode: string | null;
  patient: { uhid: string; name: string | null };
  qrPayload: string;
  /** Absent for a free revisit — see the header. */
  fee: { invoiceNo: string; paidPaise: number; creditExtended: boolean } | null;
};

export function CounterSlip(props: CounterSlipProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="print-doc w-[360px] space-y-3 rounded-lg border p-4">
      <section className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-neutral-500">{t("counterSlip.token")}</p>
        <p data-testid="slip-token" className="text-4xl font-bold tabular-nums">{props.tokenNo}</p>
        <p className="text-sm">{props.doctorName} · {props.departmentName}</p>
        {props.roomCode !== null && <p className="text-sm">{t("counterSlip.room", { code: props.roomCode })}</p>}
        <p className="text-sm">{props.patient.name ?? "—"} · {props.patient.uhid}</p>
        <p data-testid="slip-visit-no" className="text-xs text-neutral-600">{props.visitNo} · {props.serviceDate}</p>
      </section>

      {props.fee !== null && (
        <section data-testid="slip-fee" className="space-y-1 border-t pt-2">
          <p className="text-xs uppercase tracking-wide text-neutral-500">{t("counterSlip.fee")}</p>
          <p className="text-sm">{props.fee.invoiceNo}</p>
          <p className="text-lg font-semibold tabular-nums">
            ₹{(props.fee.paidPaise / 100).toFixed(2)}
          </p>
          {props.fee.creditExtended && (
            <p data-testid="slip-credit" className="text-sm font-medium">{t("counterSlip.onCredit")}</p>
          )}
        </section>
      )}

      {props.fee === null && (
        <section data-testid="slip-free" className="border-t pt-2 text-sm font-medium">
          {t("counterSlip.freeFollowUp")}
        </section>
      )}

      <section className="border-t pt-2 text-sm">
        <p>{t("counterSlip.nextStep")}</p>
      </section>

      <div className="flex justify-center pt-1">
        <QRCodeSVG value={props.qrPayload} size={88} />
      </div>
    </div>
  );
}
