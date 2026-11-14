import { useTranslation } from "react-i18next";
import { dateLocale } from "../../lib/date-locale";
import { PRICE_REASONS } from "../../lib/stock-entry-api";
import type { PriceReasonCode, WirePriceCheck } from "../../lib/stock-entry-api";

/**
 * #1061 — THE PRICE NOTE under a purchase line (spec docs/specs/1061-grn-price-check.md, ruling 0096). Amber: the
 * line is more than 2% above the item's last paid receipt or this supplier's contract rate, per unit; it shows the
 * last receipts, the contract and a cheaper supplier, and asks for the reason the capture needs. "First purchase":
 * nothing on record to compare with. Shared by the stock-entry invoice grid and the PO receipt form.
 */
const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;
const pct = (bps: number): string => String(Math.round(bps / 10) / 10);
const shortDay = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(dateLocale(), { day: "2-digit", month: "short" });
};

/** Does the row's reason answer an amber price? A code, and words for `other`. */
export function priceAnswered(reason: string, text: string): boolean {
  if (!(PRICE_REASONS as readonly string[]).includes(reason)) return false;
  return reason !== "other" || text.trim() !== "";
}

export function PriceCheckNote({ check, index, reason, reasonText, onReason }: {
  check: WirePriceCheck; index: number; reason: string; reasonText: string;
  onReason: (patch: { priceReason?: PriceReasonCode | ""; priceReasonText?: string }) => void;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const row = t("stockEntry.rowN", { n: index + 1 });
  if (check.status === "first") {
    return <p className="text-xs text-gray-600" data-testid={`se-price-${String(index)}`}>{t("priceCheck.first")}</p>;
  }
  if (check.status !== "amber" || check.refPaisePerBase === null) return null;
  const missing = !priceAnswered(reason, reasonText);
  return (
    <div className="space-y-1 text-xs text-amber-900" data-testid={`se-price-${String(index)}`}>
      <p className="font-semibold">
        {t(check.refKind === "contract" ? "priceCheck.aboveContract" : "priceCheck.aboveLast", {
          pct: pct(check.riseBps ?? 0), ref: rupees(check.refPaisePerBase),
        })}
      </p>
      {check.receipts.length > 0 && (
        <p>{t("priceCheck.receipts")}{" "}{check.receipts.map((r) => `${r.vendorName} ${rupees(r.paisePerBase)} · ${shortDay(r.postedOn)}`).join("; ")}</p>
      )}
      {check.contract !== null && <p>{t("priceCheck.contract", { rate: rupees(check.contract.paisePerBase) })}</p>}
      {check.cheaper !== null && <p>{t("priceCheck.cheaper", { vendor: check.cheaper.vendorName, rate: rupees(check.cheaper.paisePerBase) })}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`${t("priceCheck.reason")} · ${row}`} value={reason} data-testid={`se-price-reason-${String(index)}`}
          className={`rounded border px-1 py-0.5 ${missing ? "border-amber-600" : ""}`}
          onChange={(e) => onReason({ priceReason: e.target.value as PriceReasonCode | "" })}
        >
          <option value="">{t("priceCheck.choose")}</option>
          {PRICE_REASONS.map((c) => <option key={c} value={c}>{t(`priceCheck.code.${c}`)}</option>)}
        </select>
        {reason === "other" && (
          <input
            aria-label={`${t("priceCheck.words")} · ${row}`} value={reasonText} maxLength={200} className="rounded border px-1 py-0.5"
            onChange={(e) => onReason({ priceReasonText: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}
