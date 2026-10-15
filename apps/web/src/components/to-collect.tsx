import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { fetchToCollect } from "../lib/billing-api";
import { isGone, mayReadToCollect, toCollectAmount } from "../../../../packages/contracts/src/to-collect";
import type { WireToCollectRow } from "../../../../packages/contracts/src/to-collect";

/**
 * ═══ "TO COLLECT" — THE DESK'S LIST OF PATIENTS IT LET THROUGH UNPAID (OWNER, 2026-10-09) ═══
 *
 * Owner: *"'To collect' list for desk, with money-off-doctor release: yes."* The doctor is shown no
 * money and holds nobody back for it; this block is what keeps the visit in front of the desk and
 * the cashier until the fee is settled. ONE component for Desk One and the billing counter, so the
 * two cannot drift. A DESK screen only — no doctor screen mounts it.
 *
 * The server sorts (seen-and-gone first) and decides who is listed; this draws what it sent. A seat
 * that holds none of the route's keys does not ask and draws nothing.
 */
export const TO_COLLECT_QUERY_KEY = ["billing", "to-collect"] as const;
const POLL_MS = 30_000;

export function useToCollect(): { rows: WireToCollectRow[]; permitted: boolean; ready: boolean } {
  const { permissions } = useAuth();
  const permitted = mayReadToCollect(permissions.hospital);
  const q = useQuery({
    queryKey: TO_COLLECT_QUERY_KEY, queryFn: fetchToCollect, enabled: permitted,
    refetchInterval: POLL_MS, staleTime: 10_000, retry: false,
  });
  return { rows: q.data?.items ?? [], permitted, ready: q.data !== undefined };
}

export function ToCollect({ onCollect, style }: {
  /** Opens the seat's existing collect flow for this visit. */
  onCollect: (row: WireToCollectRow) => void;
  style?: React.CSSProperties;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { rows, permitted, ready } = useToCollect();
  if (!permitted || !ready) return null;
  const mayTakeMoney = can("billing.invoice.issue");
  return (
    <div className="box" data-testid="to-collect" style={{ padding: 12, ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="tag" data-testid="to-collect-title">{t("toCollect.count", { n: rows.length })}</span>
      </div>
      {rows.length === 0 ? (
        <p data-testid="to-collect-none" style={{ margin: "7px 0 0", fontSize: 11.5, color: "var(--faint)" }}>{t("toCollect.none")}</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
          {rows.map((r) => (
            <div
              key={r.encounterId} data-testid={`to-collect-row-${r.encounterId}`} data-state={r.state}
              title={t("toCollect.why", { by: r.letThroughBy, mins: r.minutesSince, reason: r.reason })}
              style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 0", borderTop: "1px solid var(--line2)", minWidth: 0 }}
            >
              <span className="mo" style={{ fontSize: 12.5, fontWeight: 700, flexShrink: 0, minWidth: 22 }}>{r.tokenNo ?? "—"}</span>
              <span style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 12.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.patientName}</span>
                <span style={{ fontSize: 10.5, color: isGone(r) ? "var(--gold)" : "var(--dim)", fontWeight: isGone(r) ? 600 : 400 }}>
                  {t(`toCollect.state.${r.state}`)}
                </span>
              </span>
              <span className="mo" data-testid={`to-collect-amount-${r.encounterId}`} style={{ fontSize: 12.5, fontWeight: 600, flexShrink: 0 }}>
                {toCollectAmount(r.amountDuePaise)}
              </span>
              {mayTakeMoney ? (
                <button
                  type="button" className="sec" data-testid={`to-collect-go-${r.encounterId}`}
                  style={{ height: 26, padding: "0 9px", fontSize: 11.5, flexShrink: 0 }} onClick={() => onCollect(r)}
                >
                  {t("toCollect.collect")}
                </button>
              ) : (
                <span data-testid={`to-collect-counter-${r.encounterId}`} style={{ fontSize: 10.5, color: "var(--dim)", flexShrink: 0, maxWidth: 76, textAlign: "right", lineHeight: "13px" }}>
                  {t("toCollect.atCounter")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
