import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { lastCompletedVisit, lastVisitCard, showsLastVisit } from "../lib/brief-history";
import type { WireLastVisit } from "../lib/brief-history";

/**
 * ═══ "LAST VISIT" — WHAT THE DOCTOR RECORDED LAST TIME (owner 2026-10-09) ═══
 *
 * On every revisit and renewal, above "Why the patient came": the newest completed earlier visit in
 * four short rows, so the doctor is prepared before anyone walks in. The phone's patient page shows
 * the same card from the same function (`packages/contracts/src/doctor-queue.ts`).
 *
 * No new read path. The visit is chosen off the timeline the brief already holds — a history this
 * login may not read chooses nothing — and read through `GET /opd/visits/:id`, the route that gates a
 * sealed record and writes the `opd.visit` access row (the History browser's own read and cache key).
 * A refusal draws no card. Nothing here can edit, and the card opens nothing: the brief has no past-visit view to open.
 */
type TimelineRow = { encounterId: string; serviceDate: string; status: string; doctorName: string | null };

export function LastVisitCard({ visits, currentEncounterId, visitType, testId = "brief-last-visit" }: {
  visits: readonly TimelineRow[]; currentEncounterId: string; visitType: string | undefined; testId?: string;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const last = showsLastVisit(visitType) ? lastCompletedVisit(visits, currentEncounterId) : null;
  const read = useQuery({
    queryKey: ["opd", "past-visit", last?.encounterId ?? ""], enabled: last !== null, retry: false, staleTime: 5 * 60_000,
    queryFn: () => api<WireLastVisit>("GET", `/opd/visits/${last?.encounterId ?? ""}`),
  });
  if (last === null || read.data === undefined) return null;
  const card = lastVisitCard((k, v) => t(k, v ?? {}), read.data, last.doctorName);
  const clamp: React.CSSProperties = { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" };
  return (
    <section data-testid={testId} className="box" style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span className="tag" style={{ whiteSpace: "nowrap" }}>{card.title}</span>
        {card.doctor !== null && (
          <span style={{ fontSize: 12, color: "var(--dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.doctor}</span>
        )}
      </div>
      {card.rows.map((r) => (
        <div key={r.key} data-testid={`${testId}-${r.key}`} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 13.5, lineHeight: "19px" }}>
          <span style={{ flex: "0 0 74px", fontSize: 12, color: "var(--dim)", whiteSpace: "nowrap" }}>{r.label}</span>
          <span style={{ minWidth: 0, flex: 1, ...clamp }}>{r.value}</span>
        </div>
      ))}
    </section>
  );
}
