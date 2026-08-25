import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchPartnerPnl } from "../lib/partners-api";
import { fmtPaise } from "../lib/format";
import type { WirePartnerPnl } from "../lib/partners-api";

/**
 * PLAN 09 T8 — THE CHANNEL P&L: one row per partner.
 *
 * ═══ THIS IS A BACK-OFFICE REPORT, NOT A COUNTER SCREEN — E-32 GOVERNS THE OTHER ONE ═══
 *
 * `counter-instruments.tsx` and `billing-counter.tsx` are where a member stands and a cashier
 * works; E-32 forbids a sales figure THERE, because a card figure at the counter is a sales pitch
 * wearing a receipt. This screen is the opposite of that surface on purpose — it is where the
 * hospital looks at its own channel relationships, guarded by `partners.pnl.read`
 * (NOT_YET_MODELLED, DD18), a permission no counter role holds. `guardrails.test.ts` scopes its
 * "no sales figure" scan to the counter screens by name and deliberately excludes this one; showing
 * commission and margin figures HERE is this screen's entire job.
 *
 * ═══ NOTHING HERE CARRIES PATIENT IDENTITY (DD15) ═══
 *
 * Every number below is a count or a sum — `cardsActive`, `memberSpendPaise` and the rest are
 * aggregates over rows this hospital already holds, never a per-patient line. The server's own
 * `assertIdentityFree` refuses a shape that carried one before it ever reaches this screen.
 *
 * ═══ WHY TWO NUMBERS STAY SEPARATE (DD5, the `partner-receivables.tsx` precedent) ═══
 *
 * `receivableExpectedPaise` is a CLAIM (what this hospital says a partner owes);
 * `receivableMatchedPaise` is MONEY (what that partner's own statements have actually confirmed,
 * off the append-only ledger). Merging them into one "receivable" figure would hide the gap this
 * report exists to show alongside the payable side.
 */
function PnlRow({ row }: { row: WirePartnerPnl }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <tr data-testid={`partner-${row.counterpartyId}`}>
      <td className="px-3 py-2">
        <span className="font-medium">{row.counterpartyName}</span>
        <span className="ml-2 text-xs text-muted-foreground">{t(`partnerPnl.payeeClass.${row.payeeClass}`, { defaultValue: row.payeeClass })}</span>
      </td>
      <td className="px-3 py-2 text-right tabular-nums" data-testid={`cards-active-${row.counterpartyId}`}>{row.cardsActive}</td>
      <td className="px-3 py-2 text-right tabular-nums" data-testid={`member-spend-${row.counterpartyId}`}>{fmtPaise(row.memberSpendPaise)}</td>
      <td className="px-3 py-2 text-right tabular-nums" data-testid={`payable-${row.counterpartyId}`}>{fmtPaise(row.payableCommissionPaise)}</td>
      <td className="px-3 py-2 text-right tabular-nums" data-testid={`receivable-expected-${row.counterpartyId}`}>{fmtPaise(row.receivableExpectedPaise)}</td>
      <td className="px-3 py-2 text-right tabular-nums" data-testid={`receivable-matched-${row.counterpartyId}`}>{fmtPaise(row.receivableMatchedPaise)}</td>
      <td className="px-3 py-2 text-right tabular-nums" data-testid={`receivable-disputed-${row.counterpartyId}`}>{fmtPaise(row.receivableDisputedPaise)}</td>
      <td className="px-3 py-2 text-right font-semibold tabular-nums" data-testid={`net-margin-${row.counterpartyId}`}>
        {fmtPaise(row.netChannelMarginPaise)}
      </td>
    </tr>
  );
}

export function PartnerPnl(): React.ReactElement {
  const { t } = useTranslation();
  const pnl = useQuery({ queryKey: ["partners", "pnl"], queryFn: () => fetchPartnerPnl() });
  const rows = pnl.data ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">{t("partnerPnl.title")}</h1>
      <p className="text-sm text-muted-foreground" data-testid="no-identity">{t("partnerPnl.noIdentity")}</p>

      {pnl.data !== undefined && rows.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="empty">{t("partnerPnl.empty")}</p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-sm" data-testid="pnl-table">
            <thead>
              <tr className="border-b bg-neutral-50 text-left">
                <th className="px-3 py-2">{t("partnerPnl.partner")}</th>
                <th className="px-3 py-2 text-right">{t("partnerPnl.cardsActive")}</th>
                <th className="px-3 py-2 text-right">{t("partnerPnl.memberSpend")}</th>
                <th className="px-3 py-2 text-right">{t("partnerPnl.payable")}</th>
                <th className="px-3 py-2 text-right">{t("partnerPnl.receivableExpected")}</th>
                <th className="px-3 py-2 text-right">{t("partnerPnl.receivableMatched")}</th>
                <th className="px-3 py-2 text-right">{t("partnerPnl.receivableDisputed")}</th>
                <th className="px-3 py-2 text-right">{t("partnerPnl.netMargin")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => <PnlRow key={row.counterpartyId} row={row} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
