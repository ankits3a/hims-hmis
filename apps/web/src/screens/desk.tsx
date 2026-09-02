import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { fetchDesk, todayIst } from "../lib/desk-api";
import type { WireDeskCard, WireDeskRow, WireDeskStat } from "../lib/desk-api";
import { useRealtime } from "../lib/realtime";
import { useAuth } from "../lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * PLAN 07c T4 — MY DESK: THE FIRST SCREEN THIS APPLICATION HAS EVER HAD FOR A PERSON.
 *
 * ═══ WHAT THIS REPLACES ═══
 *
 * `router.tsx`'s index route was an unconditional `throw redirect({ to: "/registration" })`. A
 * doctor, a cashier, a storekeeper and the administrator all landed on the patient REGISTRATION
 * desk, and role changed only which navigation links were hidden — so for most of the hospital the
 * front door of the system was somebody else's screen. That redirect is the headline defect of this
 * plan series and this component is its replacement.
 *
 * ═══ THE CARDS ARE THE SERVER'S, AND THAT IS THE WHOLE DESIGN (DD1) ═══
 *
 * This file contains no knowledge of OPD, billing, materials or theatre. It renders whatever
 * `GET /me/desk` returns, and what that returns is the union of the cards the caller's PERMISSIONS
 * unlock — never a layout selected by role. Roles combine: the counter clerk this plan series began
 * with holds registration, appointments and billing at once, and a role-selected dashboard would
 * need designing again for every combination and would still be wrong for the fourth. When pharmacy
 * ships its card, it appears here and this file does not change.
 *
 * ═══ EVERY FIGURE IS A DOOR (T4 A2) ═══
 *
 * A number nobody can open is decoration, and decoration on a home screen is worse than nothing: it
 * tells a clerk something they must now go and find on another screen, which is the three route
 * changes per patient this plan series exists to delete. So a stat that carries an `href` renders
 * as a LINK, and the provider that emits the figure is the thing that decides where its rows are.
 *
 * ═══ A STALE NUMBER ANNOUNCES ITSELF (DD11 / T4 A3) ═══
 *
 * The counts are live over the realtime socket, subscribing to the union of the topics the cards
 * themselves declare. When that socket drops, the indicator changes and the figures are visibly
 * dimmed — because a dashboard that silently goes on showing a dropped socket's last value is worse
 * than one showing nothing at all. Nobody distrusts a number that looks fine.
 */
function StatValue({ stat }: { stat: WireDeskStat }): React.ReactElement {
  const { t } = useTranslation();
  const label = t(stat.key);
  const value = (
    <span className="text-2xl font-semibold tabular-nums" data-testid={`stat-${stat.key}`}>
      {stat.value}
    </span>
  );
  return (
    <div className="flex flex-col gap-0.5">
      {stat.href === null || stat.href === undefined ? (
        value
      ) : (
        /*
         * `as never` is the house idiom for a path the SERVER chose (`command-palette.tsx` does the
         * same for a search hit's href): TanStack types `to` as the union of routes it knows at
         * compile time, and a provider's drill target is a string that arrives at runtime. The
         * router still resolves it — a path no route matches renders the not-found boundary rather
         * than navigating nowhere silently.
         */
        <Link to={stat.href as never} className="text-2xl font-semibold tabular-nums underline decoration-dotted underline-offset-4">
          {stat.value}
        </Link>
      )}
      <span className="text-xs text-muted-foreground">{label}</span>
      {/*
        DD8 — a comparison appears only when the server had an HONEST baseline to compute it from.
        No targets are invented here and none are invented there; a figure with fourteen days of
        history behind it earns a comparison and a figure on somebody's first day does not.
      */}
      {stat.compare === null || stat.compare === undefined ? null : (
        <span className="text-xs text-muted-foreground">{stat.compare}</span>
      )}
    </div>
  );
}

function RowLine({ row }: { row: WireDeskRow }): React.ReactElement {
  const { t } = useTranslation();
  /*
   * `title` is DATA and is rendered as it arrives — the provider already aliased it if the row
   * names a restricted patient. `subtitle` is the opposite: providers put an i18n KEY there when
   * they are naming a reason ("session not started"), so it goes through `t()`, which returns the
   * string unchanged when it is not a key. Getting this backwards would either print a raw key at a
   * counter or run a patient's name through the translator.
   */
  const body = (
    <>
      {row.badge === null || row.badge === undefined ? null : (
        <span
          className={`w-5 shrink-0 text-center text-sm font-semibold ${
            row.severity === "hot" ? "text-state-danger" : row.severity === "warn" ? "text-state-waiting" : "text-muted-foreground"
          }`}
        >
          {row.badge}
        </span>
      )}
      <span className="truncate">{row.title}</span>
      <span className="truncate text-xs text-muted-foreground">{t(row.subtitle)}</span>
      {row.action === null || row.action === undefined ? null : (
        <span className="ml-auto text-xs underline">{t(row.action)}</span>
      )}
    </>
  );
  const className = "flex items-baseline gap-2 border-t py-1 text-sm first:border-t-0";
  return row.href === null || row.href === undefined ? (
    <div className={className}>{body}</div>
  ) : (
    <Link to={row.href as never} className={`${className} hover:bg-accent`}>
      {body}
    </Link>
  );
}

function DeskCardView({ card, stale }: { card: WireDeskCard; stale: boolean }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium text-muted-foreground">{t(card.titleKey)}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        {card.stats === undefined || card.stats.length === 0 ? null : (
          /*
            DD11 — THE DEGRADE IS ON THE FIGURES, NOT ON THE CARD. The rows below stay legible when
            the socket drops: a doctor who has not opened their session is still true, and hiding it
            would trade one stale number for one missing signal. It is the COUNTS that go quiet.
          */
          <div className={`flex flex-wrap gap-6 ${stale ? "opacity-40" : ""}`} data-testid={`stats-${card.key}`}>
            {card.stats.map((s) => (
              <StatValue key={s.key} stat={s} />
            ))}
          </div>
        )}
        {card.rows === undefined || card.rows.length === 0 ? null : (
          <div className="mt-3">
            {card.rows.map((r) => (
              <RowLine key={r.id} row={r} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Desk(): React.ReactElement {
  const { t } = useTranslation();
  /*
   * THE DESK IS ALWAYS TODAY. A date picker here would be a second, worse report screen; the
   * person's own day for any other date is `/my-day`, which is built for exactly that and prints.
   */
  const date = todayIst();
  const { actor } = useAuth();
  // FD-1 CLOSE pass 1 — the actor is in the key: the query client outlives a logout
  const desk = useQuery({ queryKey: ["me", "desk", actor?.id ?? "", date], queryFn: () => fetchDesk(date), enabled: actor !== null });

  const cards = useMemo(() => desk.data?.cards ?? [], [desk.data]);
  /*
   * The union of every card's declared topics, sorted and de-duplicated so the subscription key is
   * stable across renders — `useRealtime` re-subscribes whenever the joined string changes, and an
   * unstable order would tear the socket down and build it up on every refetch.
   */
  const topics = useMemo(() => [...new Set(cards.flatMap((c) => c.topics ?? []))].sort(), [cards]);
  const { connected } = useRealtime(topics, () => {
    void desk.refetch();
  });
  /*
   * Stale means "the thing that would have told me it changed is not connected" — and it is only
   * meaningful once there is something to be told about. With no live topics on the desk (a person
   * whose cards are all "today" figures) there is nothing the socket would have delivered, so
   * dimming the numbers would be a warning about nothing.
   */
  const stale = topics.length > 0 && !connected;

  const now = cards.filter((c) => c.band === "now");
  const today = cards.filter((c) => c.band === "today");

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">{t("desk.title")}</h1>
        <span className="text-sm text-muted-foreground">{date}</span>
        {topics.length === 0 ? null : (
          <span
            className={`ml-auto text-xs ${stale ? "text-state-waiting" : "text-state-live"}`}
            data-testid="desk-live"
          >
            {stale ? t("desk.offline") : t("desk.live")}
          </span>
        )}
      </div>

      {desk.isPending ? <p className="text-sm text-muted-foreground">{t("app.loading")}</p> : null}

      {/*
        E-1 — A PERSON WITH NO CARDS IS TOLD SO. This is the nav's `noneAvailable` sentence one
        level in, and it exists for the same reason: "the app is broken" and "my account has no
        access" go to different people, and a blank page cannot tell them apart. It fires only after
        the fetch resolves — a blank moment during loading is not an empty desk.
      */}
      {!desk.isPending && cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("desk.empty")}</p>
      ) : null}

      {now.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground">{t("desk.band.now")}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {now.map((c) => (
              <DeskCardView key={c.key} card={c} stale={stale} />
            ))}
          </div>
        </section>
      )}

      {today.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground">{t("desk.band.today")}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {today.map((c) => (
              <DeskCardView key={c.key} card={c} stale={stale} />
            ))}
          </div>
        </section>
      )}

      {/*
        THE CLOSE BAND, and it is one link rather than a card: every person's day ends the same way
        — read it, print it, file it. It is here for everybody, including somebody whose desk is
        otherwise empty, because a report of a day with nothing in it is still an answer (E-4).
      */}
      <section className="flex flex-col gap-2">
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground">{t("desk.band.close")}</h2>
        <Link to="/my-day" className="text-sm underline">
          {t("desk.myDay")}
        </Link>
      </section>
    </div>
  );
}
