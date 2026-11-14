import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { useAuth } from "../../lib/auth";
import { fetchExceptions, money } from "../../lib/reports-api";
import { OfficeHead } from "./office-page";
import type { WireExceptionRow } from "../../lib/reports-api";
import "./exceptions.css";

/**
 * ═══ #1065 (ruling 0097) — THE PHARMACY'S EXCEPTIONS OF A DAY, THE OWNER'S PAGE ═══
 *
 * Reports → Exceptions, `/pharmacy/office?view=reports&page=exceptions&day=YYYY-MM-DD`: every refund, discount
 * above 10%, stock adjustment and write-off, MRP revision, leakage line, cash count short or over, dearer purchase,
 * supplier credit below the debit note and paper sale entered late, biggest first, with totals by kind. The day is
 * in the address (the 08:00 digest's bell row opens it); without one it is yesterday, the digest's day. A row links
 * to the screen that holds its record only when the viewer holds a right that opens it (`linkNeeds`); otherwise it
 * shows the record's own reference as text. A leakage line a refund already explains says so and is not in the totals.
 * Only `pharmacy.exceptions.view` sees the page (`pages.ts`); the server refuses the read to anybody else.
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Yesterday's IST date in the browser: through `Asia/Kolkata`, never a hand-added offset (`lib/lab-api.ts` `istToday`). */
function istYesterday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(now.getTime() - 86_400_000));
}
const rupees = (paise: number): string => `₹${money(paise)}`;
const clock = (at: string): string =>
  new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));

/** A row's link as the router takes it: the path, and its query as a search object. */
function target(link: string): { to: string; search: Record<string, string> } {
  const [path, q] = link.split("?");
  return { to: path ?? link, search: Object.fromEntries(new URLSearchParams(q ?? "")) };
}

export function ExceptionsView(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const asked = typeof search.day === "string" && DAY_RE.test(search.day) ? search.day : null;
  const day = asked ?? istYesterday();
  const q = useQuery({ queryKey: ["pharmacy", "exceptions", day], queryFn: () => fetchExceptions(day) });
  const setDay = (next: string): void => {
    if (!DAY_RE.test(next)) return;
    void navigate({ to: "/pharmacy/office", search: { view: "reports", page: "exceptions", day: next } });
  };
  const d = q.data;
  // The server sorts; the page keeps the promise whatever it is handed.
  const rows: WireExceptionRow[] = d === undefined ? [] : [...d.rows].sort((a, b) => b.paise - a.paise || (a.at ?? "").localeCompare(b.at ?? ""));

  return (
    <div className="space-y-3 exc" data-testid="exc-page">
      <OfficeHead title={t("pharmacyOffice.exceptions.title")} lead={t("pharmacyOffice.exceptions.lead")}>
        <label className="exc-day">
          <span>{t("pharmacyOffice.exceptions.day")}</span>
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label={t("pharmacyOffice.exceptions.day")} data-testid="exc-day" className="w-40" />
        </label>
      </OfficeHead>

      {q.isLoading && <p className="text-sm text-muted-foreground">{t("pharmacyOffice.exceptions.loading")}</p>}
      {q.isError && <p role="alert" className="text-sm text-destructive">{t("pharmacyOffice.exceptions.failed")}</p>}

      {d !== undefined && (
        <>
          <div className="exc-totals" data-testid="exc-totals">
            <div className="exc-total exc-total-all" data-testid="exc-total-all">
              <span className="exc-total-k">{t("pharmacyOffice.exceptions.count", { count: d.count })}</span>
              <span className="exc-total-v">{rupees(d.totalPaise)}</span>
            </div>
            {d.totals.map((x) => (
              <div key={x.kind} className="exc-total" data-testid={`exc-total-${x.kind}`}>
                <span className="exc-total-k">{t(`pharmacyOffice.exceptions.kind.${x.kind}`)} · {x.count}</span>
                <span className="exc-total-v">{rupees(x.paise)}</span>
              </div>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="ofp-box exc-none" data-testid="exc-none">{t("pharmacyOffice.exceptions.none")}</p>
          ) : (
            <ol className="ofp-box exc-list">
              {rows.map((r) => {
                const go = target(r.link);
                // A link only to a screen the viewer may open; otherwise the record's own reference, to ask for it by.
                const opens = r.linkNeeds === undefined || r.linkNeeds.length === 0 || r.linkNeeds.some((g) => can(g));
                const same = r.sameMoneyAs ?? null;
                return (
                  <li key={r.id} className={same === null ? "exc-row" : "exc-row exc-same"} data-testid="exc-row">
                    <div className="exc-main">
                      <span className="exc-kind">{t(`pharmacyOffice.exceptions.kind.${r.kind}`)}</span>
                      <span className="exc-what">{r.what}</span>
                      <span className="exc-meta">
                        {r.who ?? "—"} · <span data-testid="exc-when">{r.at === null ? d.day : clock(r.at)}</span>
                      </span>
                      {same !== null && <span className="exc-note" data-testid="exc-same">{t("pharmacyOffice.exceptions.sameMoney")}</span>}
                    </div>
                    <div className="exc-side">
                      <span className="exc-paise" data-testid="exc-paise">{rupees(r.paise)}</span>
                      {opens
                        ? <Link to={go.to} search={go.search} className="exc-open">{t("pharmacyOffice.exceptions.open")}</Link>
                        : <span className="exc-ref" data-testid="exc-ref">{r.ref ?? ""}</span>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
