import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { billingErrorMessage } from "../../lib/billing-api";
import { fmtPaise } from "../../lib/format";

/**
 * #655 (UX audit HANDOFF §5.4) — "the refund form's credit-note field still takes a raw id; give it a
 * picker." The patient is picked first (the app's shared picker, as for an advance refund); this lists
 * that patient's credit notes with what each can still refund (`GET /billing/patients/:id/credit-notes`).
 * A fully refunded note is shown, so the office sees it, and cannot be chosen.
 */
export type WirePatientCreditNote = {
  creditNoteId: string; creditNoteNo: string; invoiceId: string; invoiceNo: string; issuedAt: string;
  netPaise: number; refundedPaise: number; refundablePaise: number;
};

export function CreditNotePicker({ patientId, value, onChange }: {
  patientId: string; value: string; onChange: (creditNoteId: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ["billing-office", "patient-credit-notes", patientId],
    queryFn: () => api<{ items: WirePatientCreditNote[] }>("GET", `/billing/patients/${encodeURIComponent(patientId)}/credit-notes`),
  });
  if (q.error !== null) return <p role="alert" className="text-sm text-red-600">{billingErrorMessage(q.error)}</p>;
  if (q.data === undefined) return <p className="text-sm text-neutral-500">…</p>;
  const items = q.data.items;
  return (
    <fieldset className="space-y-1" data-testid="refund-credit-notes">
      <legend className="block text-sm font-medium">{t("billingOffice.request.pickCreditNote")}</legend>
      {items.length === 0 && <p className="text-sm text-neutral-500" data-testid="refund-credit-notes-none">{t("billingOffice.request.noCreditNotes")}</p>}
      {items.map((n) => {
        const done = n.refundablePaise <= 0;
        return (
          <label key={n.creditNoteId} className="flex items-center gap-2 rounded border px-2 py-1 text-sm" style={{ opacity: done ? 0.6 : 1 }}>
            <input type="radio" name="refund-credit-note" value={n.creditNoteId} checked={value === n.creditNoteId} disabled={done}
              onChange={() => onChange(n.creditNoteId)} />
            <span className="tabular-nums">
              {done
                ? t("billingOffice.request.creditNoteDone", { creditNote: n.creditNoteNo, invoice: n.invoiceNo })
                : t("billingOffice.request.creditNoteLine", { creditNote: n.creditNoteNo, invoice: n.invoiceNo, left: fmtPaise(n.refundablePaise) })}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
