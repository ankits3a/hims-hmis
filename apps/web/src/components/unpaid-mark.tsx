import { useTranslation } from "react-i18next";

/**
 * ═══ FD-32 — ONE WARNING, WORN BY EVERY DESK THE PATIENT REACHES (OWNER RULING 2026-09-13) ═══
 *
 * Owner: *"A symbol to symbolize in the vital dashboard that the user has not yet paid … also on
 * doctor consultation and the desk outside the consultation room whose job is to capture the photo
 * of prescription."*
 *
 * ONE COMPONENT FOR ALL THREE, and that is the whole point rather than tidiness: three separately
 * written badges drift, and the one that drifts is the one that quietly stops appearing. Three
 * screens import this; a fourth desk added later gets the same mark for free.
 *
 * IT SAYS WHY, NOT JUST THAT. A bare ⚠ teaches a nurse to ignore it by the second week. The
 * bypass carries the clerk's own sentence — "emergency — breathless, sent straight through" — and
 * that sentence is the thing that makes the warning actionable at the desk reading it.
 *
 * TWO STATES, DELIBERATELY DISTINCT:
 *   · UNPAID, no bypass — this patient should not be here yet. Red.
 *   · UNPAID, bypassed  — the front desk let them through ON PURPOSE and named a reason. Amber,
 *     because it is a warning and not a fault: the desk reading it must not send the patient back.
 */
export function UnpaidMark(
  { unpaid, bypass }: { unpaid: boolean; bypass: { by: string; reason: string } | null },
): React.ReactElement | null {
  const { t } = useTranslation();
  if (!unpaid) return null;
  const waived = bypass !== null;
  return (
    <span
      data-testid={waived ? "unpaid-bypassed" : "unpaid-mark"}
      title={waived ? bypass.reason : t("unpaid.title")}
      className={waived ? "pill" : "pill rd"}
      style={{ fontWeight: 700, letterSpacing: ".02em" }}
    >
      {waived ? `⚠ ${t("unpaid.bypassed")}` : `₹ ${t("unpaid.notPaid")}`}
      {waived && <span style={{ fontWeight: 400, marginLeft: 6 }}>— {bypass.reason}</span>}
    </span>
  );
}
