import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useDebounced } from "../lib/format";
import {
  fetchRecognition, lookupInstruments, membershipErrorCode, membershipErrorMessage, retryAfterSec,
} from "../lib/membership-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * PLAN 09 T3 — CARD RECOGNITION AT THE COUNTER (DD8): who is standing here, what they hold, and
 * what the hospital may honour.
 *
 * ═══ THREE RULES SHAPE THIS FILE ═══
 *
 * · NO SALES FIGURE, ANYWHERE (E-32). Not a price, not a cap, not a commission, not a "you saved
 *   ₹X". The wire shape it renders carries none, which is the cheapest way to keep it true — but
 *   the rule is stated here as well, because the temptation is a UX one and it arrives as a
 *   feature request. A benefit is shown BY NAME; the arithmetic happens once, on the invoice.
 * · THE DISCLOSURE IS THE SERVER'S SENTENCE, not a locale key. `recognition.disclosure` is
 *   rendered verbatim, so a screen cannot quietly stop saying what the hospital is obliged to say
 *   when it honours a card. Its LABEL is translated; its TEXT is not.
 * · THE SERVER STAYS AUTHORITATIVE (the `opd-admin.tsx` / `ops-mode.tsx` precedent). No client
 *   permission model and no client copy of the validity rules: a card is usable because the server
 *   said `usable`, and a coupon's refusal is the server's own reason word.
 *
 * The rate-limit refusal gets its own sentence with the seconds in it, because the alternative — a
 * generic "something went wrong" on a route that is deliberately throttled — sends a cashier to
 * the IT desk about a control that is working exactly as designed.
 */
const LOOKUP_DEBOUNCE_MS = 250;
const MIN_QUERY_CHARS = 2;

/** The six reasons `couponUnusableReason` can give. Each is a different sentence at the counter. */
const COUPON_REASONS = new Set([
  "retired", "not_yet_valid", "expired", "off_weekday", "outside_window", "min_bill_not_met",
]);

export function CounterInstruments(): React.ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [presented, setPresented] = useState<string | null>(null);
  const debounced = useDebounced(query, LOOKUP_DEBOUNCE_MS);

  const lookup = useQuery({
    queryKey: ["membership", "lookup", debounced],
    queryFn: () => lookupInstruments(debounced.trim()),
    enabled: debounced.trim().length >= MIN_QUERY_CHARS,
  });

  const recognition = useQuery({
    queryKey: ["membership", "recognition", presented],
    queryFn: () => fetchRecognition({ codes: [presented!] }),
    enabled: presented !== null,
  });

  const lookupCode = lookup.error === null ? null : membershipErrorCode(lookup.error);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4">
      <h1 className="text-lg font-semibold">{t("counterInstruments.title")}</h1>

      <section className="flex flex-col gap-2">
        <label className="text-sm" htmlFor="instrument-query">{t("counterInstruments.lookupLabel")}</label>
        <input
          id="instrument-query"
          className="rounded border px-2 py-1"
          value={query}
          placeholder={t("counterInstruments.lookupPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
        />
        {lookup.error !== null && (
          <p role="alert" data-testid="lookup-error" data-code={lookupCode ?? ""} className="text-sm text-red-600">
            {lookupCode === "lookup_rate_limited"
              ? t("counterInstruments.rateLimited", { seconds: retryAfterSec(lookup.error) ?? 0 })
              : membershipErrorMessage(lookup.error)}
          </p>
        )}
        {lookup.data !== undefined && lookup.data.hits.length === 0 && (
          <p className="text-sm text-neutral-500">{t("counterInstruments.none")}</p>
        )}
        {lookup.data !== undefined && lookup.data.hits.length > 0 && (
          <ul className="divide-y rounded border" data-testid="lookup-hits">
            {lookup.data.hits.map((hit) => (
              <li key={hit.id} className="flex items-center gap-3 px-3 py-2">
                <span className="font-mono">{hit.title}</span>
                <span className="text-sm text-neutral-600">{hit.subtitle}</span>
                <Button className="ml-auto" type="button" onClick={() => setPresented(hit.title)}>
                  {t("counterInstruments.recognise")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {recognition.error !== null && (
        <p role="alert" data-testid="recognition-error" className="text-sm text-red-600">
          {membershipErrorMessage(recognition.error)}
        </p>
      )}

      {recognition.data !== undefined && (
        <section className="flex flex-col gap-4" data-testid="recognition">
          <h2 className="text-base font-semibold">{t("counterInstruments.holds", { card: presented ?? "" })}</h2>

          {recognition.data.memberships.length === 0 && recognition.data.coupons.length === 0 && (
            <p className="text-sm text-neutral-500">{t("counterInstruments.nothingHeld")}</p>
          )}

          {recognition.data.memberships.map((m) => (
            <article key={m.instanceId} className="rounded border p-3" data-testid={`membership-${m.cardCode}`}>
              <header className="flex items-center gap-2">
                <span className="font-semibold">{m.planTitle}</span>
                <span className="font-mono text-sm">{m.cardCode}</span>
                {m.origin === "grace" && <Badge>{t("counterInstruments.grace")}</Badge>}
                <span className="ml-auto text-sm">
                  {m.usable ? t("counterInstruments.usable") : t("counterInstruments.notUsable")}
                </span>
              </header>
              <p className="text-sm text-neutral-600">
                {t("counterInstruments.validTo", { date: m.validTo.slice(0, 10) })}
              </p>
              {m.queuePerk && <p className="text-sm">{t("counterInstruments.queuePerk")}</p>}
              <ul className="mt-2 list-disc pl-5 text-sm">
                {/* BY NAME, never by amount — E-32. */}
                {m.benefits.map((b) => <li key={b.benefitKey}>{b.title}</li>)}
              </ul>
            </article>
          ))}

          {recognition.data.coupons.map((c) => (
            <article key={c.couponId} className="rounded border p-3" data-testid={`coupon-${c.code}`}>
              <header className="flex items-center gap-2">
                <span className="font-semibold">{c.title}</span>
                <span className="font-mono text-sm">{c.code}</span>
              </header>
              <p className="text-sm" data-testid={`coupon-reason-${c.code}`}>
                {c.unusableReason === null
                  ? t("counterInstruments.couponApplies")
                  : t(`counterInstruments.couponReason.${COUPON_REASONS.has(c.unusableReason) ? c.unusableReason : "retired"}`)}
              </p>
            </article>
          ))}

          {/*
            E-32 — RENDERED AT HONOURING TIME, IN THE SERVER'S OWN WORDS. Deliberately not behind a
            "read more": a disclosure a member has to open is a disclosure they never see.
          */}
          <p className="rounded bg-neutral-100 p-3 text-sm" data-testid="disclosure">
            <strong>{t("counterInstruments.disclosureLabel")}</strong> {recognition.data.disclosure}
          </p>
        </section>
      )}
    </div>
  );
}
