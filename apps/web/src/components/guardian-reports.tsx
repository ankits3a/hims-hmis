import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchPatientImaging, fetchPatientResults, reportsCard } from "../lib/brief-history";

/**
 * ═══ "REPORTS" ON A GUARDIAN'S CONSULTATION (owner 2026-10-09) ═══
 *
 * The guardian came to show reports. The in-house ones signed since the last visit sit beside the
 * "Guardian only" line, above every tab: "HbA1c · 8.9 % · 6 Oct", three at most, then "+n". The
 * same two gated reads and the same rule as the brief's "since then" block (`reportsCard` in
 * packages/contracts/src/doctor-queue.ts — the phone's consult screen calls it too), under the
 * brief's own cache keys, so opening the consultation after the brief asks the server nothing new.
 * A read that is refused is empty; nothing since the last visit draws nothing. It opens nothing —
 * the brief's block does not either.
 */
export function GuardianReports({ patientId, lastVisitDay, testId = "panel-reports" }: {
  patientId: string; lastVisitDay: string | null; testId?: string;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const lab = useQuery({ queryKey: ["brief", "lab", patientId], queryFn: () => fetchPatientResults(patientId), retry: false });
  const imaging = useQuery({ queryKey: ["brief", "imaging", patientId], queryFn: () => fetchPatientImaging(patientId), retry: false });
  if (lab.isPending || imaging.isPending) return null;
  const card = reportsCard((k, v) => t(k, v ?? {}), lab.data?.items ?? [], imaging.data?.items ?? [], lastVisitDay);
  if (card === null) return null;
  return (
    <div
      data-testid={testId} role="note"
      style={{ margin: "4px 14px 0", padding: "4px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--card)", width: "fit-content", maxWidth: "calc(100% - 28px)", boxSizing: "border-box", fontSize: 13, lineHeight: "19px" }}
    >
      <span className="tag">{card.title}</span>
      {card.lines.map((r, i) => (
        <div key={i} data-testid={`${testId}-${String(i)}`} style={{ display: "flex", whiteSpace: "pre", fontWeight: r.abnormal ? 700 : 400, color: r.abnormal ? "var(--gold)" : "var(--ink)" }}>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
          <span style={{ flexShrink: 0 }}>{r.rest}</span>
        </div>
      ))}
      {card.more > 0 && <div data-testid={`${testId}-more`} style={{ fontSize: 12, fontWeight: 700, color: "var(--dim)" }}>+{card.more}</div>}
    </div>
  );
}
