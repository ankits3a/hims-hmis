import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePatientInHand } from "../lib/patient-in-hand";
import { useAuth } from "../lib/auth";
import { Button } from "@/components/ui/button";
import { AppointmentWorkspace } from "../components/appointment-workspace";
import type { AppointmentOutcome } from "../components/appointment-workspace";
import { FindPanel } from "./registration-counter";

/**
 * ═══ USER 1's SEAT — THE APPOINTMENT, ON ITS OWN SCREEN ═══
 *
 * The owner authorised TWO shapes of the front desk, and they are not in conflict:
 *
 *   · THREE PEOPLE — `/registration` (user 2), `/appointment` (user 1), `/billing` (user 3), one
 *     screen each. This is user 1's.
 *   · ONE PERSON — user 4 holds all three grants and works Desk One: a single desk with a
 *     persistent dossier and a stage that advances `find → reg → appt → bill`.
 *
 * ═══ AND BOTH RENDER THE SAME APPOINTMENT ═══
 *
 * FD-8 lifted the body of this screen into `AppointmentWorkspace`. This file is now the CHROME
 * around it — the header, the search for a patient when nobody is in hand, the permission answer
 * and the finished line — and nothing else.
 *
 * That is not tidiness. The three walk-in routing rules, the 20-minute delay rule, the live flow
 * read and the bill-first drawer check are money-and-safety behaviour; two copies of them would
 * drift, and a divergence between what user 1 sees and what user 4 sees is the kind of defect
 * nobody notices until the two clerks disagree in front of a patient.
 */
export function AppointmentSeat({ now = new Date() }: { now?: Date } = {}): React.ReactElement {
  const { t } = useTranslation();
  const { inHand, release } = usePatientInHand();
  const { can } = useAuth();
  const patientId = inHand?.patientId ?? null;
  const [done, setDone] = useState<AppointmentOutcome | null>(null);

  /*
   * D2 — THE SEAT IS ITS OWN PERMISSION. The nav row is gated too, but a screen that renders its
   * controls to a caller who cannot use them teaches the desk that the system is broken; the honest
   * answer is the one the server would give.
   */
  if (!can("opd.appointments.manage")) {
    return (
      <div data-seat="appointment-seat" data-testid="appointment-seat" className="min-h-screen bg-background p-6 text-foreground">
        <p data-testid="appt-forbidden" role="alert">{t("appointmentSeat.forbidden")}</p>
      </div>
    );
  }

  return (
    <div data-seat="appointment-seat" data-testid="appointment-seat" className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">{t("appointmentSeat.title")}</h1>
        {inHand !== null && (
          <p data-testid="appt-patient" className="text-sm text-muted-foreground">{inHand.patientId}</p>
        )}
      </header>

      <div className="p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {/* Nobody in hand: the same search-first door the counter uses, and the same component. */}
          {patientId === null && <FindPanel />}

          {patientId !== null && done === null && (
            <AppointmentWorkspace
              patientId={patientId}
              now={now}
              onOutcome={(o) => setDone(o)}
            />
          )}

          {/* THE FINISH. One line saying what happened, and the desk cleared for the next person. */}
          {done !== null && (
            <section data-testid="appt-done" className="rounded-md border border-primary/40 bg-primary/5 p-4">
              <p className="font-medium">
                {done.kind === "booked"
                  ? t("appointmentSeat.doneBooked", { at: done.at })
                  : t("appointmentSeat.doneToken", { token: done.tokenNo ?? "—" })}
              </p>
              <Button
                type="button" className="mt-3" data-testid="appt-next"
                onClick={() => {
                  // D8 — nothing of this patient carries to the next: the seat releases them and the
                  // workspace is remounted fresh by the guard above.
                  setDone(null);
                  release();
                }}
              >
                {t("appointmentSeat.next")}
              </Button>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
