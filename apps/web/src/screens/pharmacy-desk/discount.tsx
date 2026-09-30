import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchDiscountRequest, pharmacyErrorText } from "../../lib/pharmacy-api";
import { LineSheet } from "./lines";
import type { DiscountAsk, DiscountAskResult, DiscountTier, TenderPayable, WireDiscountQuote } from "../../lib/pharmacy-api";

/**
 * ═══ OWNER RULING 2026-09-30 (money) — THE SALE DISCOUNT, AS A SHEET BEHIND ⋯ ═══
 *
 * *"The pharmacist may give up to 10% off MRP on a bill, with a reason. Above 10% needs the pharmacy
 * in-charge's approval. Above 25% goes to the owner. A discount worth more than ₹25,000 on one bill also
 * goes to the owner."* The same sheet serves the desk's bill and the walk-in counter.
 *
 * THE SHEET DOES NO ARITHMETIC ON MONEY. Every figure in it — the discount, the new payable for cash and for
 * UPI/card, the GST inside, and who must approve — is the server's preview of THIS bill with THIS discount
 * (`price`), because the tax is carved out of each discounted line and only the server prices lines.
 */
export type AppliedDiscount = DiscountAsk & {
  tier: DiscountTier;
  amountPaise: number;
  /** The ask filed with the in-charge or the owner; null when the pharmacist gives it. */
  approvalId: string | null;
};

export type DiscountPricing = {
  quote: WireDiscountQuote | null;
  cash: TenderPayable | null;
  digital: TenderPayable | null;
  taxPaise: number;
};

const rupees = (paise: number): string =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "8" → 800 basis points; at most two decimals and 100%. */
export function percentToBps(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps > 0 && bps <= 10000 ? bps : null;
}
/** "12.50" → 1250 paise. */
export function rupeesToPaise(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const p = Math.round(Number(t) * 100);
  return p > 0 ? p : null;
}

export function discountLabel(d: Pick<DiscountAsk, "kind" | "value">): string {
  return d.kind === "percent_bps" ? `${String(d.value / 100)}%` : rupees(d.value);
}

/** Where an ask to the in-charge or the owner stands; `granted` is what lets the bill go. */
export function useDiscountApproval(d: AppliedDiscount | null): { status: "none" | "pending" | "granted" | "rejected"; note: string | null } {
  const id = d?.approvalId ?? null;
  const q = useQuery({
    queryKey: ["pharmacy", "discount-request", id],
    queryFn: () => fetchDiscountRequest(id!),
    enabled: id !== null,
    refetchInterval: (s) => (s.state.data?.status === "pending" || s.state.data === undefined ? 5000 : false),
    retry: false,
  });
  if (d === null || d.tier === "pharmacist") return { status: "none", note: null };
  const s = q.data?.status ?? "pending";
  return { status: s === "granted" ? "granted" : s === "rejected" ? "rejected" : "pending", note: q.data?.decisionNote ?? null };
}

/** The one line the rail shows under an applied discount that waits on someone. */
export function DiscountWait({ discount }: { discount: AppliedDiscount | null }): React.ReactElement | null {
  const { t } = useTranslation();
  const a = useDiscountApproval(discount);
  if (discount === null || a.status === "none") return null;
  const who = t(`pharmacyDiscount.who.${discount.tier}`);
  const tone = a.status === "granted" ? "var(--green)" : a.status === "rejected" ? "var(--red)" : "var(--gold-ink, var(--gold))";
  return (
    <p role="status" data-testid="discount-wait" style={{ margin: "7px 0 0 0", fontSize: 11.5, lineHeight: "16px", color: tone }}>
      {a.status === "granted" ? t("pharmacyDiscount.granted", { who }) : a.status === "rejected" ? t("pharmacyDiscount.rejected", { who, note: a.note ?? "" }) : t("pharmacyDiscount.pending", { who })}
    </p>
  );
}

export function DiscountSheet({ scopeKey, initial, price, ask, onApply, onRemove, onClose }: {
  /** What is being discounted (the dispense, or the cart's signature): the preview is cached per bill. */
  scopeKey: string;
  initial: AppliedDiscount | null;
  price: (d: DiscountAsk) => Promise<DiscountPricing>;
  ask: (d: DiscountAsk) => Promise<DiscountAskResult>;
  onApply: (d: AppliedDiscount) => void;
  onRemove: (() => void) | null;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [unit, setUnit] = useState<"pct" | "rs">(initial?.kind === "flat_paise" ? "rs" : "pct");
  const [text, setText] = useState(initial === null ? "" : initial.kind === "percent_bps" ? String(initial.value / 100) : (initial.value / 100).toFixed(2));
  const [reason, setReason] = useState(initial?.reason ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setError(null); }, [unit, text]);

  const value = unit === "pct" ? percentToBps(text) : rupeesToPaise(text);
  const kind = unit === "pct" ? "percent_bps" as const : "flat_paise" as const;
  const priced = useQuery({
    queryKey: ["pharmacy", "discount-preview", scopeKey, kind, value],
    queryFn: () => price({ kind, value: value!, reason: "" }),
    enabled: value !== null,
    retry: false,
  });
  const quote = value === null ? null : priced.data?.quote ?? null;
  const reasonOk = reason.trim().length >= 3;

  const apply = async (): Promise<void> => {
    if (value === null || quote === null || !reasonOk) return;
    const d: DiscountAsk = { kind, value, reason: reason.trim() };
    if (quote.tier === "pharmacist") { onApply({ ...d, tier: "pharmacist", amountPaise: quote.amountPaise, approvalId: null }); return; }
    setBusy(true); setError(null);
    try {
      const r = await ask(d);
      onApply({ ...d, tier: r.tier, amountPaise: r.amountPaise, approvalId: r.approvalId });
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    } finally { setBusy(false); }
  };

  return (
    <LineSheet title={t("pharmacyDiscount.title")} onClose={onClose}>
      <div data-testid="discount-sheet">
        <div role="radiogroup" aria-label={t("pharmacyDiscount.unit")} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {(["pct", "rs"] as const).map((u) => (
            <button
              key={u} type="button" role="radio" aria-checked={unit === u} onClick={() => { setUnit(u); setText(""); }}
              style={{
                height: 34, borderRadius: 6, fontSize: 12.5, fontWeight: 600,
                border: `1px solid ${unit === u ? "var(--green)" : "var(--line)"}`,
                background: unit === u ? "var(--green-soft)" : "var(--card)", color: unit === u ? "var(--green)" : "var(--dim)",
              }}
            >{t(`pharmacyDiscount.unit_${u}`)}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          <label style={{ flex: "0 0 130px" }}>
            <span className="tag">{unit === "pct" ? t("pharmacyDiscount.percent") : t("pharmacyDiscount.amount")}</span>
            <input
              className="in mo" autoFocus inputMode="decimal" data-testid="discount-value" value={text}
              aria-label={unit === "pct" ? t("pharmacyDiscount.percent") : t("pharmacyDiscount.amount")}
              onChange={(e) => setText(e.target.value)} style={{ height: 38, marginTop: 4, textAlign: "right", fontSize: 15, fontWeight: 600 }}
            />
          </label>
          <label style={{ flex: "1 1 200px", minWidth: 0 }}>
            <span className="tag">{t("pharmacyDiscount.reason")}</span>
            <input
              className="in" data-testid="discount-reason" value={reason} maxLength={300} placeholder={t("pharmacyDiscount.reasonHint")}
              aria-label={t("pharmacyDiscount.reason")} onChange={(e) => setReason(e.target.value)} style={{ height: 38, marginTop: 4 }}
            />
          </label>
        </div>

        {text.trim() !== "" && value === null ? <p role="alert" style={{ margin: "9px 0 0 0", fontSize: 12, color: "var(--red)" }}>{t("pharmacyDiscount.invalid")}</p> : null}
        {priced.error !== null && value !== null ? <p role="alert" style={{ margin: "9px 0 0 0", fontSize: 12, color: "var(--red)" }}>{pharmacyErrorText(priced.error, t)}</p> : null}

        {quote !== null && priced.data !== undefined ? (
          <div data-testid="discount-preview" style={{ marginTop: 14, border: "1px solid var(--line2)", borderRadius: 8, padding: "4px 12px 10px" }}>
            <PRow what={t("pharmacyDiscount.off", { d: discountLabel({ kind, value: value! }) })} amt={`−${rupees(quote.amountPaise)}`} tone="var(--green)" />
            <PRow what={t("pharmacyDiscount.gstInside")} amt={rupees(priced.data.taxPaise)} tone="var(--dim)" />
            {priced.data.cash !== null ? <PRow what={t("pharmacyDiscount.payCash")} amt={rupees(priced.data.cash.netPayablePaise)} tone="var(--ink)" strong /> : null}
            {priced.data.digital !== null ? <PRow what={t("pharmacyDiscount.payDigital")} amt={rupees(priced.data.digital.netPayablePaise)} tone="var(--ink)" strong /> : null}
            <p data-testid="discount-tier" style={{
              margin: "10px 0 0 0", fontSize: 12, lineHeight: "17px", padding: "7px 9px", borderRadius: 6,
              background: quote.tier === "pharmacist" ? "var(--green-soft)" : "var(--gold-soft)",
              color: quote.tier === "pharmacist" ? "var(--green)" : "var(--ink)",
            }}>
              {t(`pharmacyDiscount.tier.${quote.tier}`)}
            </p>
          </div>
        ) : null}

        {error !== null ? <p role="alert" style={{ margin: "10px 0 0 0", fontSize: 12, color: "var(--red)" }}>{error}</p> : null}
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button type="button" className="pri" data-testid="discount-apply" style={{ flexGrow: 1 }} disabled={busy || quote === null || !reasonOk} onClick={() => void apply()}>
            {quote === null || quote.tier === "pharmacist" ? t("pharmacyDiscount.apply") : t("pharmacyDiscount.ask", { who: t(`pharmacyDiscount.who.${quote.tier}`) })}
          </button>
          {onRemove !== null ? <button type="button" className="sec" onClick={onRemove}>{t("pharmacyDiscount.remove")}</button> : null}
          <button type="button" className="sec" onClick={onClose}>{t("pharmacyDiscount.cancel")}</button>
        </div>
        {!reasonOk && quote !== null ? <p style={{ margin: "7px 0 0 0", fontSize: 11.5, color: "var(--dim)" }}>{t("pharmacyDiscount.reasonFirst")}</p> : null}
      </div>
    </LineSheet>
  );
}

function PRow({ what, amt, tone, strong = false }: { what: string; amt: string; tone: string; strong?: boolean }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "7px 0", borderTop: "1px solid var(--line2)" }}>
      <span style={{ flexGrow: 1, fontSize: 12, color: tone, fontWeight: strong ? 600 : 400 }}>{what}</span>
      <span className="mo" style={{ fontSize: strong ? 14 : 12, color: tone, fontWeight: strong ? 600 : 400 }}>{amt}</span>
    </div>
  );
}
