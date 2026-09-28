import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchCreditRequest, requestOwnerCredit } from "../lib/billing-api";

/**
 * ═══ GAP CLOSURE A3 — "ONLY THE OWNER APPROVES CREDIT", AS ONE CONTROL ═══
 *
 * Owner ruling 2026-09-28: nobody but the owner may issue credit, anywhere in the hospital. Every counter
 * that could let something go out unpaid mounts this beside its remainder: it files ONE request for the
 * exact amount on the exact draft (`POST /billing/credit-requests`), waits while the owner decides in
 * /approvals, and hands the counter the granted approval id the moment it reads `granted`. The counter
 * then issues with `credit.approvalId`, and the server checks the grant against the same draft, patient
 * and amount — so a changed basket is a new ask, which is why the ask is keyed by the amount.
 *
 * It replaces the old "paste the approval id" box: a cashier cannot be expected to fetch an id from
 * another screen, and a control nobody can operate gets worked around.
 */
export function OwnerCreditAsk({ draftId, patientId, amountPaise, reason, onGranted, amountText }: {
  draftId: string; patientId: string | null; amountPaise: number; reason: string;
  onGranted: (approvalId: string | null) => void; amountText: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [askedFor, setAskedFor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A different amount is a different question: the old grant would not bind to it.
  useEffect(() => {
    if (askedFor !== null && askedFor !== amountPaise) { setApprovalId(null); setAskedFor(null); onGranted(null); }
  }, [amountPaise, askedFor, onGranted]);

  const status = useQuery({
    queryKey: ["billing", "credit-request", approvalId],
    queryFn: () => fetchCreditRequest(approvalId!),
    enabled: approvalId !== null,
    refetchInterval: (q) => (q.state.data?.status === "pending" || q.state.data === undefined ? 5000 : false),
  });
  const state = status.data?.status ?? (approvalId === null ? null : "pending");
  useEffect(() => { if (state === "granted" && approvalId !== null) onGranted(approvalId); }, [state, approvalId, onGranted]);

  const ask = async (): Promise<void> => {
    if (patientId === null) return;
    setBusy(true); setError(null);
    try {
      const r = await requestOwnerCredit({ draftId, patientId, amountPaise, reason: reason.trim() });
      setApprovalId(r.approvalId); setAskedFor(amountPaise);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div data-testid="owner-credit" style={{ marginTop: 11, paddingTop: 9, borderTop: "1px solid var(--line2)" }}>
      {state === null && (
        <>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--dim)" }}>{t("ownerCredit.explain")}</p>
          <button
            type="button" className="sec" data-testid="owner-credit-ask"
            disabled={busy || patientId === null || reason.trim() === ""}
            onClick={() => void ask()}
          >
            {t("ownerCredit.ask", { amount: amountText })}
          </button>
          {reason.trim() === "" && <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--dim)" }}>{t("ownerCredit.reasonFirst")}</p>}
        </>
      )}
      {state === "pending" && <p role="status" data-testid="owner-credit-pending" style={{ margin: 0, fontSize: 12, color: "var(--gold-ink, #9a6208)" }}>{t("ownerCredit.pending", { amount: amountText })}</p>}
      {state === "granted" && <p role="status" data-testid="owner-credit-granted" style={{ margin: 0, fontSize: 12, color: "var(--green)" }}>{t("ownerCredit.granted", { amount: amountText })}</p>}
      {state === "rejected" && (
        <p role="alert" data-testid="owner-credit-rejected" style={{ margin: 0, fontSize: 12, color: "var(--red, #b23a30)" }}>
          {t("ownerCredit.rejected", { note: status.data?.decisionNote ?? "" })}
        </p>
      )}
      {error !== null && <p role="alert" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--red, #b23a30)" }}>{error}</p>}
    </div>
  );
}
