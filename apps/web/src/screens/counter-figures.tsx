import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { downloadReportCsv, fetchDesk, fetchReport, todayIst } from "../lib/desk-api";
import type { WireDeskCard } from "../lib/desk-api";
import { useAuth } from "../lib/auth";
import { BriefPanel, SectionTable } from "./my-day";
import { usePaletteOptional } from "../components/command-palette";

/**
 * FD-1 T4 — "YOUR FIGURES": the registration clerk's own account, inside the seat.
 *
 * The Dashboard artboard (`docs/design/2026-08-30-registration-desk/Dashboard.dc.html`) is almost
 * entirely rails that shipped in 07c and nobody joined: the period brief in sentences
 * (`GET /me/brief`), the provisional day with its signature line, print and CSV (`GET /me/report`),
 * and the three tiles FD-1 T1–T3 put on the desk (`GET /me/desk`). This screen composes them the
 * way the artboard draws them and adds NOTHING of its own: every figure here is the server's, and
 * every figure is a door. Counter timing is not shown because no timing rail exists (D6).
 *
 * Inside `[data-seat="registration-counter"]` (the alias layer), reached from the seat's header and
 * left by Escape — the artboard's own "Back to the counter · Esc". The patient in hand is untouched:
 * the seat's session lives in `usePatientInHand`, which this screen never reads or writes.
 * Exactly ONE `.print-doc`, the report (07a: two printable nodes overprint).
 */
function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function statOf(card: WireDeskCard | undefined, key: string): { value: string; href: string | null } | null {
  const s = card?.stats?.find((x) => x.key === key);
  return s === undefined ? null : { value: s.value, href: s.href ?? null };
}

/**
 * Every figure is a door, and a door is a client-side navigation (`router.tsx`'s own rule: a raw
 * anchor reloads the bundle on every click, all day). The screen mounts without a router in its
 * suite, so the route wrapper hands in `onGo` and the anchor keeps its href for the right-click.
 */
function Figure({ card, statKey, label, onGo }: { card: WireDeskCard | undefined; statKey: string; label: string; onGo: (href: string) => void }): React.ReactElement | null {
  const s = statOf(card, statKey);
  if (s === null) return null;
  const body = <><span className="font-mono text-lg">{s.value}</span> <span className="text-xs text-muted-foreground">{label}</span></>;
  return (
    <span data-testid={`figure-${statKey}`} className="flex items-baseline gap-1">
      {s.href === null ? body : (
        <a href={s.href} className="flex items-baseline gap-1 underline-offset-2 hover:underline" onClick={(e) => { e.preventDefault(); onGo(s.href!); }}>{body}</a>
      )}
    </span>
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function CounterFigures({ onBack, onGo }: { onBack: () => void; onGo: (href: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const { actor } = useAuth();
  const palette = usePaletteOptional();
  const [date, setDate] = useState(todayIst());
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  /**
   * CLOSE pass 1 CRITICAL — THE ACTOR IS IN THE KEY. The query client outlives a logout and its
   * keys carried only the date, so the next clerk on the same counter tab read the last clerk's
   * figures for up to five minutes — and printed them over her own signature line. Keyed on the
   * actor, a new login is a new cache entry; nothing renders until HER answer arrives.
   */
  const who = actor?.id ?? "";
  const desk = useQuery({ queryKey: ["me", "desk", who, date], queryFn: () => fetchDesk(date), enabled: who !== "" });
  const report = useQuery({ queryKey: ["me", "report", who, date], queryFn: () => fetchReport(date), enabled: who !== "" });
  const cards = desk.data?.cards ?? [];
  const card = (key: string): WireDeskCard | undefined => cards.find((c) => c.key === key);
  const registration = card("patients.registration");
  const cameBack = card("patients.cameBack");
  const appointments = card("opd.appointments");
  const billing = card("billing.myCollections");
  const sections = report.data?.sections ?? [];
  const provisional = report.data?.provisional ?? false;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || isTypingTarget(e.target) || palette?.isOpen === true) return;   // while the palette is open the screen claims no key (the seat's F7)
      e.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, palette?.isOpen]);

  return (
    <div data-seat="registration-counter" data-testid="counter-figures" className="min-h-screen bg-background text-foreground">
      <header className="no-print flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">{t("registrationCounter.figures.title")}</h1>
          <span className="text-sm text-muted-foreground">{actor?.id ?? ""}</span>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm">
            <span className="sr-only">{t("myDay.date")}</span>
            <input
              type="date" data-testid="figures-date" className="rounded border border-input bg-card px-2 py-1" value={date} aria-label={t("myDay.date")}
              onChange={(e) => { if (ISO_DATE.test(e.target.value)) setDate(e.target.value); }}   // a cleared or half-typed box asks nothing of the server
            />
          </label>
          <button type="button" data-testid="figures-back" className="rounded border border-border px-2 py-1 text-sm" onClick={onBack}>
            {t("registrationCounter.figures.back")} <kbd className="text-xs text-muted-foreground">Esc</kbd>
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-6 p-6">
        <BriefPanel date={date} />

        <section className="no-print flex flex-col gap-2 rounded border border-border bg-card p-3" data-testid="today-so-far">
          <h2 className="text-sm font-semibold">{t("registrationCounter.figures.today")}</h2>
          {desk.isPending && <p className="text-sm text-muted-foreground">{t("app.loading")}</p>}
          {desk.isError && <p role="alert" className="text-sm">{t("registrationCounter.figures.deskFailed")}</p>}
          <div className="flex flex-wrap gap-6">
            <Figure card={registration} statKey="desk.patients.registered" label={t("desk.patients.registered")} onGo={onGo} />
            <Figure card={registration} statKey="desk.patients.noMobile" label={t("desk.patients.noMobile")} onGo={onGo} />
            <Figure card={registration} statKey="desk.patients.duplicatesPending" label={t("desk.patients.duplicatesPending")} onGo={onGo} />
            <Figure card={appointments} statKey="desk.appointments.dueToday" label={t("desk.appointments.dueToday")} onGo={onGo} />
            <Figure card={appointments} statKey="desk.appointments.checkedIn" label={t("desk.appointments.checkedIn")} onGo={onGo} />
            <Figure card={appointments} statKey="desk.appointments.needsRebooking" label={t("desk.appointments.needsRebooking")} onGo={onGo} />
            <Figure card={billing} statKey="desk.billing.collected" label={t("desk.billing.collected")} onGo={onGo} />
            <Figure card={billing} statKey="desk.billing.receipts" label={t("desk.billing.receipts")} onGo={onGo} />
          </div>
        </section>

        <section className="no-print flex flex-col gap-2 rounded border border-border bg-card p-3" data-testid="came-back">
          <h2 className="text-sm font-semibold">{t("registrationCounter.figures.cameBack")}</h2>
          <p className="text-xs text-muted-foreground">{t("registrationCounter.figures.cameBackHint")}</p>
          {cameBack === undefined ? (
            !desk.isPending && <p className="text-sm text-muted-foreground">{t("registrationCounter.figures.noRegistrationCard")}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {/* a sentence is said only for a figure the server gave — a missing stat is silence, never "0" (D6) */}
              {statOf(cameBack, "desk.patients.duplicatesConfirmed") !== null && (
                <li data-testid="sentence-duplicates">{t("registrationCounter.figures.duplicates", { count: Number(statOf(cameBack, "desk.patients.duplicatesConfirmed")!.value) })} <a href="/merge" className="underline" onClick={(e) => { e.preventDefault(); onGo("/merge"); }}>{t("registrationCounter.figures.seeMerges")}</a></li>
              )}
              {statOf(cameBack, "desk.patients.noMobileMonth") !== null && (
                <li data-testid="sentence-noMobile">{t("registrationCounter.figures.noMobile", { count: Number(statOf(cameBack, "desk.patients.noMobileMonth")!.value) })}</li>
              )}
              {statOf(cameBack, "desk.patients.amendedWeek") !== null && (
                <li data-testid="sentence-amended">{t("registrationCounter.figures.amended", { count: Number(statOf(cameBack, "desk.patients.amendedWeek")!.value) })}</li>
              )}
            </ul>
          )}
        </section>

        <section className="no-print flex flex-col gap-2 rounded border border-border bg-card p-3" data-testid="drawer">
          <h2 className="text-sm font-semibold">{t("registrationCounter.figures.drawer")}</h2>
          {billing === undefined ? (
            !desk.isPending && <p className="text-sm text-muted-foreground" data-testid="drawer-none">{t("registrationCounter.figures.noDrawerRole")}</p>
          ) : statOf(billing, "desk.billing.noDrawer") !== null ? (
            <p className="text-sm text-muted-foreground" data-testid="drawer-closed">{t("desk.billing.noDrawer")}</p>
          ) : (
            <div className="flex flex-wrap gap-6">
              <Figure card={billing} statKey="desk.billing.float" label={t("desk.billing.float")} onGo={onGo} />
              <Figure card={billing} statKey="desk.billing.cash" label={t("desk.billing.cash")} onGo={onGo} />
              <Figure card={billing} statKey="desk.billing.expectedCash" label={t("desk.billing.expectedCash")} onGo={onGo} />
              <p className="w-full text-xs text-muted-foreground">{t("registrationCounter.figures.varianceLine")}</p>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <div className="no-print flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-semibold">{t("registrationCounter.figures.yourDay")}</h2>
            {provisional && <span className="rounded border border-state-waiting px-2 py-0.5 text-xs text-state-waiting">{t("myDay.provisional")}</span>}
            <span className="text-xs text-muted-foreground">{t("registrationCounter.figures.yourDayHint")}</span>
            <div className="ml-auto flex gap-2">
              <button type="button" data-testid="figures-print" disabled={report.data === undefined} className="rounded border border-border px-2 py-1 text-sm" onClick={() => { window.print(); }}>{t("myDay.print")}</button>
              <button
                type="button" data-testid="figures-csv" disabled={downloading} className="rounded bg-primary px-2 py-1 text-sm text-primary-foreground"
                onClick={() => {
                  setError(null); setDownloading(true);
                  downloadReportCsv(date).catch(() => { setError(t("myDay.exportFailed")); }).finally(() => { setDownloading(false); });
                }}
              >
                {t("myDay.export")}
              </button>
            </div>
          </div>
          {error !== null && <p role="alert" className="no-print text-sm">{error}</p>}
          {/* a failed report is said, never printed as an honest empty day (CLOSE pass 1) */}
          {report.isError && <p role="alert" data-testid="report-failed" className="no-print text-sm">{t("registrationCounter.figures.reportFailed")}</p>}
          {report.data !== undefined && (
          <div className="print-doc flex flex-col gap-4 rounded border border-border bg-card p-3">
            <div className="flex flex-col gap-0.5 border-b pb-2">
              <span className="text-base font-semibold">{t("myDay.docTitle")}</span>
              <span className="text-sm">{t("myDay.docFor", { date })}</span>
              <span className="text-sm">{actor?.id ?? ""}</span>
              {provisional && <span className="text-sm">{t("myDay.provisionalNote")}</span>}
            </div>
            {!report.isPending && sections.length === 0 && <p className="text-sm text-muted-foreground">{t("myDay.empty")}</p>}
            {sections.map((s) => <SectionTable key={s.key} section={s} />)}
            <div className="mt-8 flex gap-12 text-sm">
              <div className="flex-1 border-t pt-1">{t("myDay.signedBy")}</div>
              <div className="flex-1 border-t pt-1">{t("myDay.receivedBy")}</div>
            </div>
          </div>
          )}
        </section>
      </div>
    </div>
  );
}
