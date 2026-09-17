import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchCounterSummary } from "../lib/pharmacy-api";
import { fmtPaise } from "../lib/format";

/**
 * ═══ PHARMACY P7 — TODAY AT THE COUNTER, IN ONE LINE ═══
 *
 * The in-charge's glance, from `GET /pharmacy/summary`: what went out, how long it took, what is
 * still waiting, what was declined and why, and the money that came back. It refreshes once a
 * minute. A failed read shows nothing: the strip is a convenience, never a gate.
 */
export function CounterDayStrip(): React.ReactElement | null {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["pharmacy", "summary"], queryFn: () => fetchCounterSummary(), refetchInterval: 60_000, retry: false });
  if (q.data === undefined) return null;
  const s = q.data;
  const open = s.open.queued + s.open.claimed + s.open.verified + s.open.picked + s.open.billed;
  const parts = [
    t("pharmacyDay.handedOver", { n: s.handedOver }),
    ...(s.notCollected === undefined || s.notCollected === 0 ? [] : [t("pharmacyDay.notCollected", { n: s.notCollected, of: s.queuedToday ?? 0 })]),
    ...(s.medianMinutes.queueToHandover === null ? [] : [t("pharmacyDay.wait", { m: s.medianMinutes.queueToHandover })]),
    t("pharmacyDay.open", { n: open }),
    t("pharmacyDay.billed", { amount: fmtPaise(s.billedPaise) }),
    t("pharmacyDay.declined", { n: s.declinedLines }),
    ...(s.declinedTop[0] === undefined ? [] : [t("pharmacyDay.topReason", { reason: s.declinedTop[0].reason })]),
    t("pharmacyDay.returns", { n: s.returns }),
    t("pharmacyDay.refunds", { n: s.refundedAfterBilling }),
    ...(s.partlyCheckedLines === 0 ? [] : [t("pharmacyDay.partly", { n: s.partlyCheckedLines })]),
    t("pharmacyDay.h1", { n: s.scheduledHandovers }),
    ...(s.scan === undefined || s.scan.pickedLines === 0 ? [] : [t("pharmacyDay.scanned", { n: s.scan.scannedLines, of: s.scan.pickedLines })]),
  ];
  return (
    <p data-testid="counter-day-strip" className="rounded border bg-muted/40 px-3 py-1 text-xs">
      <span className="font-medium">{t("pharmacyDay.today")}</span>: {parts.join(" · ")}
    </p>
  );
}
