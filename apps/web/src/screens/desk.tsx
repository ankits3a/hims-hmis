import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { fetchDesk, todayIst } from "../lib/desk-api";
import type { WireDeskCard, WireDeskRow, WireDeskStat } from "../lib/desk-api";
import { fetchCurrentSession, openCashSession, billingErrorMessage } from "../lib/billing-api";
import { useRealtime } from "../lib/realtime";
import { useAuth } from "../lib/auth";
import { istClock, istDateLabel } from "./desk-one/model";
import "../styles/paper-pine.css";
import "./dashboard.css";

/**
 * PLAN 07c T4 — MY DESK: THE FIRST SCREEN THIS APPLICATION HAS EVER HAD FOR A PERSON.
 *
 * ═══ WHAT THIS REPLACES ═══
 *
 * `router.tsx`'s index route was an unconditional `throw redirect({ to: "/registration" })`. A
 * doctor, a cashier, a storekeeper and the administrator all landed on the patient REGISTRATION
 * desk, and role changed only which navigation links were hidden — so for most of the hospital the
 * front door of the system was somebody else's screen.
 *
 * ═══ THE CARDS ARE THE SERVER'S, AND THAT IS THE WHOLE DESIGN (DD1) ═══
 *
 * This file contains no knowledge of OPD, billing, materials or theatre. It renders whatever
 * `GET /me/desk` returns, and what that returns is the union of the cards the caller's PERMISSIONS
 * unlock — never a layout selected by role. The owner's artboard says the same thing in its own
 * note: *"the dashboard renders the union of what your permissions unlock, which is how FD-1 was
 * already built."* When pharmacy ships its card it appears here and this file does not change.
 *
 * ═══ FD-11 — IT WEARS DESK ONE'S CLOTHES NOW ═══
 *
 * Rebuilt to the owner's artboard ("Dashboard — the composer"). What changed is the SKIN and one
 * new gate; what did not change is where the numbers come from. Every figure below is still a
 * server figure with the server's own `href`, and the artboard agrees — *"Every number on this
 * screen is the server's… a plausible number at a cash counter is the worst kind."*
 *
 * ═══ EVERY FIGURE IS A DOOR (T4 A2) ═══
 *
 * A number nobody can open is decoration, and decoration on a home screen is worse than nothing.
 * A stat carrying an `href` renders as a LINK, and the provider that emits the figure decides
 * where its rows are.
 *
 * ═══ A STALE NUMBER ANNOUNCES ITSELF (DD11 / T4 A3) ═══
 *
 * The counts are live over the realtime socket, subscribing to the union of the topics the cards
 * declare. When that socket is down the FIGURES go quiet and the rows do not.
 */

/**
 * The three doors the artboard draws, and the only place in this file that names a module.
 *
 * It is a DISPLAY map and not a layout: a card absent from it still renders, with its figures and
 * its rows, just without a call to action — which is right, because `patients.cameBack` and
 * `opd.hall` are things to read rather than things to start. A card that arrives here from a module
 * nobody has written yet lands in the same place.
 */
const BANDS: { band: "now" | "today"; titleKey: string }[] = [
  { band: "now", titleKey: "desk.band.now" },
  { band: "today", titleKey: "desk.band.today" },
];

const DOOR_CTA: Record<string, { key: string; to: string; cap?: string }> = {
  "patients.registration": { key: "desk.cta.register", to: "/counter", cap: "F4" },
  "opd.appointments": { key: "desk.cta.book", to: "/opd/appointments", cap: "F7" },
  "billing.myCollections": { key: "desk.cta.take", to: "/billing", cap: "F8" },
};

/**
 * The schemes band, from the artboard, and it carries NO COUNTS — deliberately.
 *
 * The artboard shows a number on each tile and notes that "every count below is a real server
 * surface today". They are five different modules and five endpoints this screen does not have, and
 * the rule this codebase holds itself to is the artboard's own: a plausible number at a cash
 * counter is the worst kind. So the tiles ship as what they honestly are — DOORS. The owner's
 * reason for wanting them here survives intact: *"a scheme is a thing a PATIENT arrives holding — a
 * card, a coupon, an employer, a camp slip — so the clerk needs to know it exists before the money
 * screen, not after."* The counts are a follow-up, not an invention.
 */
const SCHEMES: { id: string; icon: string; to: string }[] = [
  { id: "membership", to: "/counter", icon: "M2 5h20v14H2zM2 10h20" },
  { id: "coupons", to: "/counter", icon: "M4 8V6h16v2a2 2 0 0 0 0 8v2H4v-2a2 2 0 0 0 0-8M12 6v12" },
  { id: "packages", to: "/counter", icon: "M21 8 12 3 3 8l9 5 9-5ZM3 8v8l9 5 9-5V8" },
  { id: "panels", to: "/counter", icon: "M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5" },
  { id: "partners", to: "/counter", icon: "M6 12h.01M18 6h.01M18 18h.01M8.7 10.7l6.6-3.4M8.7 13.3l6.6 3.4" },
];

function StatFigure({ stat, label }: { stat: WireDeskStat; label: string }): React.ReactElement {
  const body = (
    <>
      <span className="n mo">{stat.value}</span>
      <span className="l">{label}</span>
    </>
  );
  return stat.href === null || stat.href === undefined ? (
    <span className="fig">{body}</span>
  ) : (
    <Link to={stat.href as never} className="fig" data-testid={`fig-${stat.key}`}>{body}</Link>
  );
}

function RowLine({ row }: { row: WireDeskRow }): React.ReactElement {
  const { t } = useTranslation();
  /* §1 of the legend: marigold is attention, brick red is a refusal, pine is a settled thing. */
  const dot = row.severity === "hot" ? "var(--red)" : row.severity === "warn" ? "var(--gold)" : "var(--green)";
  const body = (
    <>
      <span className="dot" style={{ background: dot }} />
      <span className="txt">{row.title}</span>
      <span className="n mo">{t(row.subtitle)}</span>
    </>
  );
  return row.href === null || row.href === undefined ? (
    <div className="row">{body}</div>
  ) : (
    <Link to={row.href as never} className="row" style={{ textDecoration: "none", color: "inherit" }}>{body}</Link>
  );
}

function Door({ card, stale, gated }: { card: WireDeskCard; stale: boolean; gated: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const cta = DOOR_CTA[card.key];
  return (
    <div className="box door" data-testid={`door-${card.key}`}>
      <div className="hd">
        <span className="ttl">{t(card.titleKey)}</span>
        {cta === undefined ? null : <span className="pth mo">{cta.to}</span>}
      </div>
      <div className="bd">
        {card.stats === undefined || card.stats.length === 0 ? null : (
          /*
            DD11 — THE DEGRADE IS ON THE FIGURES, NOT ON THE CARD. The rows below stay legible when
            the socket drops: a doctor who has not opened their session is still true, and hiding it
            would trade one stale number for one missing signal. It is the COUNTS that go quiet.
          */
          <div className={stale ? "figs dim" : "figs"} data-testid={`stats-${card.key}`}>
            {card.stats.map((s) => <StatFigure key={s.key} stat={s} label={t(s.key)} />)}
          </div>
        )}
        {card.rows === undefined || card.rows.length === 0 ? null : (
          <div>{card.rows.map((r) => <RowLine key={r.id} row={r} />)}</div>
        )}
        {cta === undefined ? null : (
          <div style={{ marginTop: "auto", paddingTop: 4 }}>
            {/*
              THE GATE, and it is on the ACTION and never on the information. A cashier who has not
              counted their drawer may still READ their desk — the figures above are how they find
              out what is waiting. What they may not do is start serving a patient before the money
              they are holding has been declared.
            */}
            {gated ? (
              <button type="button" className="sec go" disabled data-testid={`cta-${card.key}`}>
                <span>{t(card.key === "billing.myCollections" ? "desk.cta.take" : cta.key)}</span>
                <span className="kb">{t("desk.drawer.locked")}</span>
              </button>
            ) : (
              <Link to={cta.to as never} className="sec go" data-testid={`cta-${card.key}`}>
                <span>{t(cta.key)}</span>
                {cta.cap === undefined ? null : <span className="kb">{cta.cap}</span>}
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DRAWER, AND WHY IT IS A GATE RATHER THAN A REMINDER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner's ruling: *"I want the welcome dashboard to ask the user to input the cashier drawer details
 * (the billing part). Once the user updates and confirms the details, he can now start
 * registration/appointment process."*
 *
 * A cash drawer is counted at the START of a shift because the count at the END means nothing
 * without it: `expectedCash = float + collected`, and a variance you cannot compute is a variance
 * nobody is answerable for. The server has always known this — `requireOpenSession` refuses cash
 * with no session — but the refusal arrived at the till, with a patient standing there. This moves
 * it to the one moment it costs nobody anything: before the first patient.
 *
 * ═══ IT ONLY GATES PEOPLE WHO HAVE A DRAWER ═══
 *
 * `billing.session.own` is the permission that opens one. A registration-only clerk holds no drawer
 * and can never open one, so gating them would lock them out of their own job with an instruction
 * they cannot follow. The gate is scoped to the people the ruling is about.
 */
function DrawerPanel({ onOpened }: { onOpened: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [rupees, setRupees] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /*
    Rupees in, paise out. The field is rupees because that is what is in the clerk's hand and on the
    denomination slip; the wire is paise because money in this system is an integer of the smallest
    unit everywhere, and a float that reached the server as 3720.0000000001 would be a variance
    somebody has to explain at close.
  */
  const paise = Math.round(Number(rupees) * 100);
  const valid = rupees.trim() !== "" && Number.isFinite(paise) && paise >= 0;

  const submit = (): void => {
    if (!valid || busy) return;
    setBusy(true);
    setFailed(null);
    void openCashSession(paise).then(
      () => { setBusy(false); onOpened(); },
      (e: unknown) => { setBusy(false); setFailed(billingErrorMessage(e)); },
    );
  };

  return (
    <div className="box drawer" data-testid="drawer-panel">
      <div className="say">
        <div className="ttl">{t("desk.drawer.title")}</div>
        <p className="body">{t("desk.drawer.body")}</p>
      </div>
      <div className="form">
        <div>
          <label className="tag" htmlFor="drawer-float">{t("desk.drawer.float")}</label>
          <input
            id="drawer-float"
            className={failed === null ? "in mo" : "in mo bad"}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={rupees}
            onChange={(e) => { setRupees(e.target.value); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          />
        </div>
        <button type="button" className="pri" disabled={!valid || busy} onClick={submit} data-testid="drawer-open">
          {busy ? t("desk.drawer.opening") : t("desk.drawer.open")}
        </button>
      </div>
      {failed === null ? null : <p role="alert" className="msg" style={{ flexBasis: "100%" }}>{failed}</p>}
    </div>
  );
}

export function Desk(): React.ReactElement {
  const { t } = useTranslation();
  /*
   * THE DESK IS ALWAYS TODAY. A date picker here would be a second, worse report screen; the
   * person's own day for any other date is `/my-day`, which is built for exactly that and prints.
   */
  const date = todayIst();
  const { actor, username, can } = useAuth();
  const qc = useQueryClient();
  // FD-1 CLOSE pass 1 — the actor is in the key: the query client outlives a logout
  const desk = useQuery({ queryKey: ["me", "desk", actor?.id ?? "", date], queryFn: () => fetchDesk(date), enabled: actor !== null });

  const holdsDrawer = can("billing.session.own");
  const session = useQuery({
    queryKey: ["me", "cash-session", actor?.id ?? ""],
    queryFn: fetchCurrentSession,
    enabled: actor !== null && holdsDrawer,
  });

  const cards = useMemo(() => desk.data?.cards ?? [], [desk.data]);
  /*
   * The union of every card's declared topics, sorted and de-duplicated so the subscription key is
   * stable across renders — `useRealtime` re-subscribes whenever the joined string changes, and an
   * unstable order would tear the socket down and build it up on every refetch.
   */
  const topics = useMemo(() => [...new Set(cards.flatMap((c) => c.topics ?? []))].sort(), [cards]);
  const { connected } = useRealtime(topics, () => { void desk.refetch(); });
  /*
   * Stale means "the thing that would have told me it changed is not connected" — and it is only
   * meaningful once there is something to be told about.
   */
  const stale = topics.length > 0 && !connected;

  /*
    THE GATE. Only a drawer-holder can be gated, and only while their session is genuinely absent —
    `session.isPending` is NOT "closed": treating a fetch in flight as a closed drawer would flash a
    marigold panel and disable every door for a moment on every single load.
  */
  const drawerOpen = session.data?.session?.status === "open";
  const gated = holdsDrawer && session.isSuccess && !drawerOpen;

  return (
    <div className="dash" data-testid="dashboard">
      <div className="band">
        <div className="bandhd">
          {/*
            A REAL `<h1>`. The artboard writes "Your desk today" as a small label, and a label is not
            a heading: a screen reader user landing here needs one thing that names the screen and
            can be jumped to. It carries the screen's name and wears the label's clothes.
          */}
          <h1 className="tag" style={{ margin: 0 }}>{t("desk.title")}</h1>
          <span className="bandnote">{t("desk.today")} · {username ?? ""}</span>
          {drawerOpen ? <span className="pill on" data-testid="drawer-open-pill">{t("desk.drawer.isOpen")}</span> : null}
          <span className="mo" style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--dim)" }}>
            {istDateLabel()} · {istClock()} IST
          </span>
          {topics.length === 0 ? null : (
            <span className="pill" data-testid="desk-live" style={stale ? { borderColor: "var(--gold-line)", color: "var(--gold)" } : { borderColor: "var(--green-line)", color: "var(--green)" }}>
              {stale ? t("desk.offline") : t("desk.live")}
            </span>
          )}
        </div>

        {gated ? <div style={{ marginBottom: 14 }}><DrawerPanel onOpened={() => { void qc.invalidateQueries({ queryKey: ["me", "cash-session"] }); void desk.refetch(); }} /></div> : null}

        {desk.isPending ? <p className="bandnote">{t("app.loading")}</p> : null}

        {/*
          E-1 — A PERSON WITH NO CARDS IS TOLD SO. This is the nav's `noneAvailable` sentence one
          level in: "the app is broken" and "my account has no access" go to different people, and a
          blank page cannot tell them apart. It fires only after the fetch resolves.
        */}
        {!desk.isPending && cards.length === 0 ? <p className="bandnote">{t("desk.empty")}</p> : null}

      </div>

      {/*
        THE BANDS ARE THE SERVER'S TOO. `now` is what is happening while the clerk reads the screen
        and `today` is what has already happened — a live queue and a day's total are different kinds
        of number, and flattening them into one grid would ask a clerk to work out which is which
        from the wording. The artboard draws one band because its mock had one; the data has two.
      */}
      {BANDS.map(({ band, titleKey }) => {
        const inBand = cards.filter((c) => c.band === band);
        if (inBand.length === 0) return null;
        return (
          <div className="band" key={band}>
            <div className="bandhd"><span className="tag">{t(titleKey)}</span></div>
            <div className="doors">
              {inBand.map((c) => <Door key={c.key} card={c} stale={stale} gated={gated} />)}
            </div>
          </div>
        );
      })}

      {!can("opd.visits.open") ? null : (
        <div className="band">
          <div className="bandhd">
            <span className="tag">{t("desk.schemes.title")}</span>
            <span className="bandnote">{t("desk.schemes.note")}</span>
          </div>
          <div className="schemes">
            {SCHEMES.map((s) => (
              <Link key={s.id} to={s.to as never} className="box sch" data-testid={`scheme-${s.id}`}>
                <span className="nm">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                       style={{ color: "var(--green)", flexShrink: 0 }}>
                    <path d={s.icon} />
                  </svg>
                  {t(`desk.schemes.${s.id}.name`)}
                </span>
                <span className="note">{t(`desk.schemes.${s.id}.note`)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/*
        THE CLOSE BAND, and it is one link rather than a card: every person's day ends the same way —
        read it, print it, file it. It is here for everybody, including somebody whose desk is
        otherwise empty, because a report of a day with nothing in it is still an answer (E-4).
      */}
      <div className="close">
        <span className="tag">{t("desk.band.close")}</span>
        <Link to="/my-day">{t("desk.myDay")}</Link>
        {holdsDrawer ? <span className="pill gd">{t("desk.drawer.atClose")}</span> : null}
      </div>
    </div>
  );
}
