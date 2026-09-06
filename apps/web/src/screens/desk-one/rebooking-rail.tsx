import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listNeedsRebooking, todayIst } from "../../lib/opd-api";
import { rebookingToday, slotClock } from "../../lib/appointment-view";
import { dayMonthIst } from "../../lib/format";
import { useDesk } from "./session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-26 — "THE DOCTOR IS AWAY. WHO DO I HAVE TO CALL?"
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The one capability FD-25's `/appointment` had that Desk One's appointment stage did not, and the
 * reason that screen was allowed to exist at all. It is carried over here rather than deleted with
 * the screen, because nothing else in the product answers the question:
 *
 *   · `listNeedsRebooking(true)` is the ONLY caller anywhere of the audited `contact=true` opt-in
 *     (`lib/opd-api.ts`) — the batched, PHI-logged read that returns phone numbers.
 *   · `rebookingToday` is the ONLY date bound over a server read that has none, so without it the
 *     rail lists every stranded booking the deployment has ever had.
 *   · "Draft the calls" is the only surface that turns that list into work a human can do.
 *
 * ═══ IT IS THE SEAT'S, NOT DESK ONE'S ═══
 *
 * Mounted only when `d.seat === "appointment"`. `/counter` is a one-person desk with a patient in
 * front of it; a list of OTHER people to telephone is a between-patients job for the chair whose
 * whole day is the book, and putting it on the counter would be a third column of somebody else's
 * work beside the person actually standing there. The owner's instruction was not to touch Desk One.
 *
 * ═══ A RESTRICTED ROW CARRIES NO NUMBER, AND SAYS SO ═══
 *
 * If the name is sealed the contact is sealed with it — the server's rule, not this component's.
 * The copy names that rather than rendering a blank column a clerk would read as a data error.
 */
export function RebookingRail({
  onMove,
}: {
  /** Take this booking in hand: the caller sets its doctor, its day, and marks it as being moved. */
  onMove: (row: {
    id: string; patientId: string; doctorId: string; serviceDate: string;
    slotStart: string; who: string;
  }) => void;
}): React.ReactElement | null {
  const d = useDesk();
  const { t } = useTranslation();

  const rebooking = useQuery({
    queryKey: ["needs-rebooking"],
    /*
      ONE BATCHED, AUDITED READ RATHER THAN N PER-PATIENT ONES. `contact=true` is an explicit opt-in
      that records one PHI-access row per number with the reason attached, which is what makes a
      rail of telephone numbers a lawful thing to render at all.
    */
    queryFn: () => listNeedsRebooking(true),
    staleTime: 60_000,
    retry: false,
  });

  /*
    THE DATE BOUND IS THIS SCREEN'S, BECAUSE THE ROUTE HAS NONE. Left unbounded the rail grows
    without limit and the count at the top stops meaning "calls to make today", which is the only
    thing a clerk can act on.
  */
  const toCall = useMemo(
    () => rebookingToday(rebooking.data?.items ?? [], todayIst()),
    [rebooking.data],
  );

  const nameOf = (a: { patient?: { name?: string | null; alias?: string | null } | null }): string =>
    a.patient?.name ?? a.patient?.alias ?? t("appointmentSeat.rail.restricted");

  return (
    <div className="box" style={{ padding: 14, marginTop: 16 }} data-testid="rebooking-rail">
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span className="tag">{t("appointmentSeat.rail.needRebooking")}</span>
        <span
          className={toCall.length === 0 ? "pill" : "pill rd"}
          data-testid="rebooking-count"
          style={{ marginLeft: "auto" }}
        >
          {toCall.length === 0
            ? t("appointmentSeat.rail.none")
            : t("appointmentSeat.rail.patients", { count: toCall.length })}
        </span>
        {toCall.length === 0 ? null : (
          <button
            type="button"
            className="sec"
            data-testid="rebooking-draft"
            onClick={() => {
              /*
                DRAFTING IS A LOCAL ACT. Nothing is sent and nothing is promised to the patient: the
                call list goes into the desk's own log, as `warn` lines, where the clerk works down
                it with a telephone. An agent that claimed to have called somebody would be the
                worst thing this rail could do.
              */
              for (const a of toCall) {
                d.note(t("appointmentSeat.log.call", {
                  who: nameOf(a),
                  phone: a.patient?.phone ?? t("appointmentSeat.rail.noPhone"),
                  was: `${dayMonthIst(a.slotStart)} ${slotClock(a.slotStart)}`,
                }), "warn");
              }
            }}
          >
            {t("appointmentSeat.agent.draftCalls")}
          </button>
        )}
      </div>
      {toCall.length === 0 ? (
        <p style={{ margin: "9px 0 0", fontSize: 11.5, color: "var(--faint)" }}>
          {t("appointmentSeat.rail.nothingToMove")}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 9 }}>
          {toCall.map((a) => (
            <button
              key={a.id}
              type="button"
              className="drow"
              data-testid={`rebook-${a.id}`}
              onClick={() => onMove({
                id: a.id,
                patientId: a.patientId,
                doctorId: a.doctorId,
                serviceDate: a.serviceDate,
                slotStart: a.slotStart,
                who: nameOf(a),
              })}
              style={{ flexDirection: "column", alignItems: "stretch", gap: 2, textAlign: "left" }}
            >
              <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 500, flexGrow: 1, minWidth: 0 }}>{nameOf(a)}</span>
                <span className="mo" style={{ fontSize: 11, color: "var(--dim)", flexShrink: 0 }}>
                  {a.patient?.phone ?? t("appointmentSeat.rail.noPhone")}
                </span>
              </span>
              <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                {dayMonthIst(a.slotStart)} {slotClock(a.slotStart)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
