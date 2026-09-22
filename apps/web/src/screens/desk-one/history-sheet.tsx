import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { patientTimeline } from "../../lib/opd-api";
import { dayMonthIst } from "../../lib/format";
import { useDeskOptional } from "./session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-28 — THE WHOLE HISTORY, WHICH THE SERVER HAS ALWAYS SENT AND THE RAIL ALWAYS CUT TO FIVE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-06: *"At /registration & at /appointment the user can't see full history of the
 * patient on the left panel … Show maximum 3 history followed by 'See More' … Only if the
 * registration user has permission to see the full history."*
 *
 * Nothing on the server was missing. `patientTimeline` returns up to FIFTY visits and the route
 * passes no limit; the rail was throwing away everything past the fifth with one client-side
 * `.slice(0, 5)`. So this is not a new read — it is the same query, keyed the same way, rendered
 * without the cut. React Query serves it from the cache the rail already filled, so opening this
 * costs no request.
 *
 * ═══ AN OVERLAY, NOT A PAGE, AND THAT IS A DELIBERATE READING OF "A FULL PAGE" ═══
 *
 * The owner asked for "a full page with history of the patient". On this screen a page means a
 * NAVIGATION, and a navigation drops the person in hand — the defect FD-2 measured at three route
 * changes per patient and FD-9 deleted the three routes to fix. Every one of Desk One's five
 * existing overlays is a layer over the desk for exactly that reason. This is the sixth, sized to
 * fill the screen, so the clerk reads the whole history and lands back on the stage they left with
 * the patient still in the column.
 *
 * ═══ THE PERMISSION IS THE ROUTE'S OWN, ASKED WHERE THE BUTTON IS DRAWN ═══
 *
 * `GET /opd/patients/:id/timeline` is `opd.visits.read` (`opd-visits.controller.ts:612`), which
 * `front_office` holds and `cashier` deliberately does not. The See-more button is gated on the same
 * string in `dossier.tsx` rather than here, so a clerk who cannot open it is never offered it — a
 * button that answers 403 is worse than no button.
 */
export function HistorySheet({ patientId, name }: { patientId: string; name: string | null }): React.ReactElement {
  const { t } = useTranslation();
  const d = useDeskOptional();
  const history = useQuery({
    queryKey: ["d1", "timeline", patientId],
    queryFn: () => patientTimeline(patientId),
    staleTime: 60_000,
    retry: false,
  });
  const items = history.data?.items ?? [];

  return (
    <div style={{ padding: "16px 18px" }} data-testid="history-sheet">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{name ?? t("registrationCounter.history.title")}</span>
        <span style={{ fontSize: 11.5, color: "var(--faint)" }}>
          {t("registrationCounter.history.fullCount", { count: items.length })}
        </span>
      </div>

      {history.isPending ? (
        <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 10 }}>{t("registrationCounter.history.reading")}</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 10 }}>{t("registrationCounter.history.first")}</div>
      ) : (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column" }}>
          {items.map((h) => (
            /*
              A ROW IS STILL A DOOR. FD-27 made the rail's rows open that visit's papers; a clerk who
              scrolled here to find the visit a patient lost their bill for would otherwise have to
              go back and find it in the five-row strip.
            */
            <button
              key={h.encounterId}
              type="button"
              data-testid="history-full-row"
              className="drow"
              style={{ alignItems: "baseline", gap: 10, textAlign: "left", padding: "9px 0", borderBottom: "1px solid var(--line2)" }}
              onClick={() => d?.patch({ overlay: "papers", papersFor: { encounterId: h.encounterId, when: h.serviceDate } })}
            >
              <span className="mo" style={{ fontSize: 11, color: "var(--dim)", width: 66, flexShrink: 0 }}>
                {dayMonthIst(h.serviceDate)}
              </span>
              <span style={{ fontSize: 12.5, flexGrow: 1, minWidth: 0, lineHeight: "17px" }}>
                {h.departmentName ?? t("registrationCounter.history.unknownDept")}
                {h.doctorName === null ? "" : <span style={{ color: "var(--dim)" }}> · {h.doctorName.replace(/^Dr\.\s*/, "")}</span>}
                {/*
                  THE DIAGNOSIS IS NOT DRAWN HERE, and its absence is the point rather than an
                  oversight. `TimelineItem` carries `diagnosis` and `icd10Code`, and this sheet opens
                  at a REGISTRATION counter with a queue behind it and a patient's family beside
                  them. Plan 07's confidential-diagnosis leak was exactly this: a clinical field
                  rendered on a front-desk surface because the wire happened to carry it. What a
                  counter needs from a history is when they came, to whom, and what paper it left.
                */}
              </span>
              {h.prescriptionLineCount > 0 && (
                <span className="pill" style={{ height: 19, flexShrink: 0 }}>
                  {t("registrationCounter.history.rxLines", { count: h.prescriptionLineCount })}
                </span>
              )}
              <span
                className="tag"
                style={{ flexShrink: 0, color: h.status === "completed" ? "var(--green)" : h.status === "abandoned" ? "var(--gold)" : "var(--faint)" }}
              >
                {t(`registrationCounter.history.state.${h.status}`, { defaultValue: h.status })}
              </span>
            </button>
          ))}
        </div>
      )}
      <p style={{ margin: "12px 0 0", fontSize: 11, color: "var(--faint)", lineHeight: "15px" }}>
        {t("registrationCounter.history.rowOpensPapers")}
      </p>
    </div>
  );
}
