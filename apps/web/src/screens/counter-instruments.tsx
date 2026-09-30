import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useDebounced } from "../lib/format";
import {
  fetchCardsToday, fetchCounterRecognition, lookupInstruments, membershipErrorCode, membershipErrorMessage,
  retryAfterSec,
} from "../lib/membership-api";
import { patientTimeline, todayIst } from "../lib/opd-api";
import { PaperScreen } from "../components/paper-screen";
import { istClock } from "./desk-one/model";
import type {
  WireCardToday, WireCounterAllowance, WireCounterMembership, WireCounterRecognition, WireCounterStanding,
} from "../lib/membership-api";
import type { WireTimelineItem } from "../lib/opd-api";
import "./counter-instruments.css";

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
 *
 * ═══ UX-AUDIT 2026-09-28 · BOARD — THE OWNER-APPROVED CARD-RECOGNITION BOARD, PORTED ═══
 *
 * docs/design/2026-09-28-ux-audit/card-recognition.html. Three columns: the card in hand on the left
 * (number, status, holder, validity, benefits left as counts); the numbered flow in the centre (scan →
 * pick today's visit → what the bill will do → the disclosure) with the one next act pinned below it;
 * the counter's cards today on the right. Two owner rulings of 28-Sep-2026 (money) bind it:
 *
 * · A CARD'S RUPEE BALANCE IS NEVER SHOWN AT THE COUNTER. Benefits read as visit counts ("3 of 4");
 *   a money balance reads "worked out on the bill". The wire carries no figure to show.
 * · AN EXPIRED CARD IS NEVER HONOURED. There is no apply act on this screen at all — a linked, usable
 *   card is honoured by the bill on its own — and the act the server names for an expired, suspended
 *   or cancelled card is "Bill at full rate". An unlinked card goes to Reconcile, never to the bill.
 *
 * The act is the SERVER's `nextAct`, not a rule re-derived here.
 */
const LOOKUP_DEBOUNCE_MS = 250;
const MIN_QUERY_CHARS = 2;

/** The six reasons `couponUnusableReason` can give. Each is a different sentence at the counter. */
const COUPON_REASONS = new Set([
  "retired", "not_yet_valid", "expired", "off_weekday", "outside_window", "min_bill_not_met",
]);

/** Visits that are over for today cannot be carried to a bill from here. */
const CLOSED_VISIT = new Set(["abandoned", "cancelled", "entered_in_error"]);

/** `31-Mar-2027`, IST — the board's date, never a raw ISO slice. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dmyIst(iso: string): string {
  // Numeric parts, then our own month names: ICU spells September "Sept" in en-GB, the board does not.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "numeric", year: "numeric",
  }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}-${MONTHS[Number(get("month")) - 1] ?? ""}-${get("year")}`;
}

function sexLetter(sex: string): string {
  return sex === "female" ? "F" : sex === "male" ? "M" : sex === "" ? "" : "O";
}

/** Keys that belong to a control the clerk is using, not to the screen. */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(target.tagName) || target.isContentEditable;
}

export function CounterInstruments(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [presented, setPresented] = useState<string | null>(null);
  const [pickedVisit, setPickedVisit] = useState<string | null>(null);
  const debounced = useDebounced(query, LOOKUP_DEBOUNCE_MS);

  const lookup = useQuery({
    queryKey: ["membership", "lookup", debounced],
    queryFn: () => lookupInstruments(debounced.trim()),
    enabled: presented === null && debounced.trim().length >= MIN_QUERY_CHARS,
  });

  /*
    ONE recognition per card presented: the route records it as `instrument.recognised`, so a refetch
    on window focus would write the same card into "cards today" again for nothing.
  */
  const recognition = useQuery({
    queryKey: ["membership", "recognition", presented],
    queryFn: () => fetchCounterRecognition(presented!),
    enabled: presented !== null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const today = useQuery({
    queryKey: ["membership", "cards-today"],
    queryFn: fetchCardsToday,
    refetchInterval: 60_000,
  });

  const data = recognition.data;
  useEffect(() => {
    if (data !== undefined) void queryClient.invalidateQueries({ queryKey: ["membership", "cards-today"] });
  }, [data, queryClient]);

  const card = data === undefined ? null : cardInHand(data, presented);
  const holderId = card?.holder?.patientId ?? null;
  const visits = useQuery({
    queryKey: ["opd", "timeline", holderId],
    queryFn: () => patientTimeline(holderId!),
    enabled: holderId !== null && card?.nextAct !== "reconcile",
  });
  const todays: WireTimelineItem[] = (visits.data?.items ?? [])
    .filter((v) => v.serviceDate === todayIst() && !CLOSED_VISIT.has(v.status));
  const visitId = pickedVisit ?? (todays.length === 1 ? todays[0]!.encounterId : null);
  const picked = todays.find((v) => v.encounterId === visitId) ?? null;

  function present(code: string): void {
    const c = code.trim();
    if (c === "") return;
    setPickedVisit(null);
    setQuery(c);
    setPresented(c);
  }

  function putDown(): void {
    setPresented(null);
    setPickedVisit(null);
    setQuery("");
    inputRef.current?.focus();
  }

  /* The dock's one act, as a place to go. `to` is null while it cannot be taken yet. */
  const act = nextActOf(data, card, visitId);
  function takeAct(): void {
    if (act === null || act.to === null) return;
    void navigate({ to: act.to as "/billing", search: act.search as never });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "F6") { e.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); return; }
      if (e.key === "Escape" && presented !== null) { e.preventDefault(); putDown(); return; }
      if (e.key === "Enter" && !typingInto(e.target) && act !== null && act.to !== null) { e.preventDefault(); takeAct(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const lookupCode = lookup.error === null ? null : membershipErrorCode(lookup.error);
  const bad = card !== null && card.standing !== "usable";
  const noMatch = data !== undefined && data.memberships.length === 0 && data.coupons.length === 0;
  const laneEmpty = card === null && (data === undefined || data.coupons.length === 0);

  return (
    <PaperScreen testId="counter-instruments">
      <div className="ci">
        {/* ── LEFT: the card in hand ── */}
        <aside className={`ci-lane${laneEmpty ? " empty" : ""}${bad ? " bad" : ""}`} data-testid="card-lane">
          {card !== null ? (
            <CardLane m={card} />
          ) : !laneEmpty && data !== undefined ? (
            <div className="ci-lane-head">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="src">COUPON</span><span className="tag">{t("counterInstruments.inHand")}</span></div>
              <div className="cardno big" style={{ fontSize: 20, marginTop: 10 }}>{data.coupons[0]!.code}</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{data.coupons[0]!.title}</div>
            </div>
          ) : (
            <div className="ci-lane-empty">
              <div className="tag" style={{ marginBottom: 6 }}>{t("counterInstruments.inHand")}</div>
              {t("counterInstruments.laneEmpty")}
            </div>
          )}
          <div style={{ flexGrow: 1 }} />
          <div className="ci-lane-foot"><span className="kb">Esc</span>{t("counterInstruments.putDown")}</div>
        </aside>

        {/* ── CENTRE: the flow ── */}
        <main className="ci-main">
          <div className="ci-title">
            <h1>{t("counterInstruments.title")}</h1>
            <span style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("counterInstruments.subtitle")}</span>
          </div>
          <div className="ci-flow">
            <div className="box">
              {/* 1 · scan */}
              <div className="step">
                <span className={`num${data !== undefined ? " done" : ""}`}>1</span>
                <div>
                  <h3>{t("counterInstruments.step1")}</h3>
                  <div className="scan">
                    <input
                      ref={inputRef}
                      id="instrument-query"
                      className="in"
                      aria-label={t("counterInstruments.lookupLabel")}
                      value={query}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={t("counterInstruments.lookupPlaceholder")}
                      onChange={(e) => { setQuery(e.target.value); if (presented !== null) { setPresented(null); setPickedVisit(null); } }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); present(query); } }}
                    />
                    <span className="kb">F6</span>
                  </div>
                  {lookup.error !== null && (
                    <p role="alert" data-testid="lookup-error" data-code={lookupCode ?? ""} className="hint" style={{ color: "var(--red)" }}>
                      {lookupCode === "lookup_rate_limited"
                        ? t("counterInstruments.rateLimited", { seconds: retryAfterSec(lookup.error) ?? 0 })
                        : membershipErrorMessage(lookup.error)}
                    </p>
                  )}
                  {presented === null && lookup.data !== undefined && lookup.data.hits.length === 0 && (
                    <p className="hint">{t("counterInstruments.none")}</p>
                  )}
                  {presented === null && lookup.data !== undefined && lookup.data.hits.length > 0 && (
                    <div className="hits" data-testid="lookup-hits">
                      {lookup.data.hits.map((hit) => (
                        <div key={hit.id} className="hit">
                          <span className="cardno">{hit.title}</span>
                          <span style={{ color: "var(--dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hit.subtitle}</span>
                          <button className="sec" type="button" onClick={() => present(hit.title)}>
                            {t("counterInstruments.recognise")}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {presented === null && lookup.data === undefined && lookup.error === null && (
                    <p className="hint">{t("counterInstruments.scanHint")}</p>
                  )}
                  {data !== undefined && !noMatch && (
                    <p className="hint">{t("counterInstruments.recognisedAt", { time: istClock() })}</p>
                  )}
                </div>
              </div>

              {recognition.error !== null && (
                <div className="step">
                  <span className="num off">!</span>
                  <div>
                    <p role="alert" data-testid="recognition-error" className="refuse" style={{ margin: 0 }}>
                      {membershipErrorMessage(recognition.error)}
                    </p>
                  </div>
                </div>
              )}

              {noMatch && (
                <div className="step" data-testid="recognition">
                  <span className="num off">2</span>
                  <div>
                    <div className="warn" data-testid="no-match">
                      <b>{t("counterInstruments.noMatch.title", { code: presented ?? "" })}</b>
                      <div style={{ color: "var(--dim)", marginTop: 4 }}>{t("counterInstruments.noMatch.body")}</div>
                    </div>
                    <p className="hint">{t("counterInstruments.noMatch.grace")}</p>
                  </div>
                </div>
              )}

              {data !== undefined && !noMatch && (
                <Flow
                  data={data}
                  card={card}
                  todays={todays}
                  visitsLoading={visits.isLoading && holderId !== null}
                  visitId={visitId}
                  onPick={setPickedVisit}
                />
              )}
            </div>
          </div>
          <div className="ci-phone-today">
            <TodayList items={today.data?.items ?? []} current={presented} onOpen={present} />
          </div>

          {/* ── the pinned act ── */}
          {data !== undefined && (
            <div className="dock" data-testid="dock">
              <div className="dock-next">
                <div className="tag">{t("counterInstruments.next")}</div>
                <div style={{ fontSize: 13, marginTop: 2 }} data-testid="dock-sentence">{dockSentence(t, data, card, picked, noMatch)}</div>
              </div>
              <button className="sec" type="button" onClick={putDown}>{t("counterInstruments.another")}</button>
              {/* A real link, so the place the act goes is on the element — hover shows it, a test reads it. */}
              {act !== null && act.to !== null && (
                <Link className="pri" to={act.to as "/billing"} search={act.search as never} data-testid="next-act" data-act={act.kind}>
                  {t(`counterInstruments.act.${act.kind}`)} <span className="kb">⏎</span>
                </Link>
              )}
              {act !== null && act.to === null && (
                <button className="pri" type="button" data-testid="next-act" data-act={act.kind} disabled>
                  {t(`counterInstruments.act.${act.kind}`)}
                </button>
              )}
            </div>
          )}
        </main>

        {/* ── RIGHT: the counter's cards today ── */}
        <aside className="ci-right">
          <TodayList items={today.data?.items ?? []} current={presented} onOpen={present} />
        </aside>
      </div>
    </PaperScreen>
  );
}

/** The card the clerk is holding: the one whose code was presented, else the first the server named. */
function cardInHand(data: WireCounterRecognition, presented: string | null): WireCounterMembership | null {
  const folded = (presented ?? "").trim().toLowerCase();
  return data.memberships.find((m) => m.cardCode.toLowerCase() === folded) ?? data.memberships[0] ?? null;
}

type Act = {
  kind: "take_to_bill" | "bill_full_rate" | "reconcile" | "open_billing";
  to: string | null;
  search?: Record<string, string>;
};

function nextActOf(data: WireCounterRecognition | undefined, card: WireCounterMembership | null, visitId: string | null): Act | null {
  if (data === undefined) return null;
  const visit = visitId === null ? undefined : { encounterId: visitId };
  if (card === null) {
    // A coupon alone, or nothing at all: the bill is where a coupon is typed and checked.
    return { kind: data.coupons.length > 0 ? "open_billing" : "bill_full_rate", to: "/billing" };
  }
  switch (card.nextAct) {
    case "reconcile":
      return { kind: "reconcile", to: "/counter/reconcile" };
    case "take_to_bill":
      // No visit picked, nothing to carry: the act waits rather than opening an empty bill.
      return { kind: "take_to_bill", to: visit === undefined ? null : "/billing", search: visit };
    case "bill_full_rate":
    default:
      return { kind: "bill_full_rate", to: "/billing", search: visit };
  }
}

function holderLine(m: WireCounterMembership): string | null {
  const h = m.holder;
  if (h === null) return null;
  const name = h.name ?? h.alias ?? h.uhid;
  const meta = [h.ageYears === null ? "" : String(h.ageYears), sexLetter(h.sex)].filter((x) => x !== "").join(" ");
  return meta === "" ? name : `${name} · ${meta}`;
}

function dockSentence(
  t: (k: string, o?: Record<string, unknown>) => string,
  data: WireCounterRecognition,
  card: WireCounterMembership | null,
  picked: WireTimelineItem | null,
  noMatch: boolean,
): React.ReactNode {
  if (noMatch) return t("counterInstruments.dock.noMatch");
  if (card === null) return t("counterInstruments.dock.coupon", { code: data.coupons[0]?.code ?? "" });
  const who = card.holder?.name ?? card.holder?.alias ?? "";
  if (card.nextAct === "reconcile") return <>{t("counterInstruments.dock.reconcile")} <span className="cardno">{card.cardCode}</span></>;
  if (card.nextAct === "bill_full_rate") return t("counterInstruments.dock.fullRate");
  if (picked === null) return t("counterInstruments.dock.pickVisit");
  return (
    <>
      {t("counterInstruments.dock.bill", { visit: picked.departmentName ?? picked.visitType })} <b>{who}</b>{" "}
      {t("counterInstruments.dock.withCard")} <span className="cardno">{card.cardCode}</span>
    </>
  );
}

function StatusPill({ m }: { m: WireCounterMembership }): React.ReactElement {
  const { t } = useTranslation();
  const s: WireCounterStanding = m.standing;
  if (s === "usable") return <span className="pill on" data-testid="card-status">● {t("counterInstruments.standing.usable")}</span>;
  const date = s === "expired" ? dmyIst(m.validTo) : s === "not_yet_valid" ? dmyIst(m.validFrom) : "";
  return <span className="pill rd" data-testid="card-status">✕ {t(`counterInstruments.standing.${s}`, { date })}</span>;
}

function Allowance({ a, off }: { a: WireCounterAllowance; off: boolean }): React.ReactElement {
  const { t } = useTranslation();
  if (off) return <span>{t("counterInstruments.cannotUse")}</span>;
  if (a.kind === "visits") {
    return (
      <>
        {a.granted <= 12 && (
          <span className="meter" aria-hidden="true">
            {Array.from({ length: a.granted }, (_, i) => <i key={i} className={i < a.remaining ? "" : "u"} />)}
          </span>
        )}
        <span className="mo" style={{ minWidth: 52, textAlign: "right", color: a.remaining === 0 ? "var(--dim)" : undefined }}>
          {t("counterInstruments.left", { remaining: a.remaining, granted: a.granted })}
        </span>
      </>
    );
  }
  return (
    <span style={{ color: "var(--dim)", fontSize: 11.5, textAlign: "right" }}>
      {a.kind === "on_the_bill" ? t("counterInstruments.onTheBill") : t("counterInstruments.everyVisit")}
    </span>
  );
}

function CardLane({ m }: { m: WireCounterMembership }): React.ReactElement {
  const { t } = useTranslation();
  const off = m.standing !== "usable";
  const holder = holderLine(m);
  return (
    <>
      <div className="ci-lane-head" data-testid={`membership-${m.cardCode}`}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={m.origin === "grace" ? "src gd" : "src"}>{m.origin === "grace" ? "GRACE" : "CARD"}</span>
          <span className="tag">{t("counterInstruments.inHand")}</span>
        </div>
        <div
          className="cardno big"
          data-testid="card-number"
          style={{ fontSize: 20, marginTop: 10, ...(off ? { color: "var(--dim)", textDecoration: "line-through", textDecorationColor: "var(--red-line)" } : {}) }}
        >
          {m.cardCode}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{m.planTitle}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <StatusPill m={m} />
          {!off && <span className="pill">{t("counterInstruments.validTo", { date: dmyIst(m.validTo) })}</span>}
          {m.origin === "grace" && <span className="pill gd">{t("counterInstruments.grace")}</span>}
        </div>
      </div>
      <div className="ci-lane-body">
        <div className="tag" style={{ margin: "6px 0 4px" }}>{t("counterInstruments.holder")}</div>
        {m.holder !== null ? (
          <>
            <div className="fact"><span>{t("counterInstruments.name")}</span><span style={{ fontWeight: 600 }} data-testid="holder-name">{holder}</span></div>
            <div className="fact"><span>UHID</span><span className="mo">{m.holder.uhid}</span></div>
          </>
        ) : null}
        <div className="fact">
          <span>{t("counterInstruments.linkedTo")}</span>
          <span style={m.linked ? undefined : { color: "#9a6208", fontWeight: 600 }}>
            {m.linked ? t("counterInstruments.linkedYes") : t("counterInstruments.linkedNo")}
          </span>
        </div>
        <div className="tag" style={{ margin: "14px 0 4px" }}>{t("counterInstruments.card")}</div>
        <div className="fact"><span>{t("counterInstruments.valid")}</span><span className="mo">{dmyIst(m.validFrom)} → {dmyIst(m.validTo)}</span></div>
        <div className="fact">
          <span>{t("counterInstruments.from")}</span>
          <span>{t(`counterInstruments.origin.${["import", "counter", "grace"].includes(m.origin) ? m.origin : "import"}`)}{m.verified ? ` · ${t("counterInstruments.checked")}` : ""}</span>
        </div>
        {m.queuePerk && <div className="fact"><span>{t("counterInstruments.queue")}</span><span>{t("counterInstruments.queuePerk")}</span></div>}
        <div className="tag" style={{ margin: "14px 0 2px" }}>{off ? t("counterInstruments.benefits") : t("counterInstruments.benefitsLeft")}</div>
        {m.allowances.map((b) => (
          <div key={b.benefitKey} className={off ? "ben off" : "ben"}>
            {/* BY NAME and by COUNT, never by amount — E-32 and the owner's 28-Sep-2026 ruling. */}
            <span>{b.title}</span>
            <Allowance a={b.allowance} off={off} />
          </div>
        ))}
        {!off && <p style={{ fontSize: 11, color: "var(--dim)", margin: "8px 0 0", lineHeight: "15px" }}>{t("counterInstruments.countsOnly")}</p>}
      </div>
    </>
  );
}

function Flow({
  data, card, todays, visitsLoading, visitId, onPick,
}: {
  data: WireCounterRecognition;
  card: WireCounterMembership | null;
  todays: WireTimelineItem[];
  visitsLoading: boolean;
  visitId: string | null;
  onPick: (id: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const applies = card?.nextAct === "take_to_bill";
  const honours = applies || (card === null && data.coupons.length > 0);
  return (
    <div data-testid="recognition">
      {/* 2 · which visit — or why the card goes nowhere near a bill */}
      <div className="step">
        <span className={`num${visitId !== null ? " done" : ""}`}>2</span>
        <div>
          {card !== null && card.nextAct === "reconcile" ? (
            <>
              <h3>{t("counterInstruments.step2")}</h3>
              <div className="warn" data-testid="reconcile">
                <b>{t("counterInstruments.unlinked.title")}</b>
                <div style={{ color: "var(--dim)", marginTop: 4 }}>{t("counterInstruments.unlinked.body")}</div>
              </div>
            </>
          ) : (
            <>
              {card !== null && card.nextAct === "bill_full_rate" && (
                <div className="refuse" data-testid="refusal" style={{ marginBottom: 12 }}>
                  <b>{t(`counterInstruments.refuse.${card.standing}`, { date: dmyIst(card.standing === "not_yet_valid" ? card.validFrom : card.validTo) })}</b>{" "}
                  {t("counterInstruments.refuse.body")}
                </div>
              )}
              <h3>{t("counterInstruments.step2")}</h3>
              {card === null || card.holder === null ? (
                <p className="hint" style={{ marginTop: 0 }}>{t("counterInstruments.visitsAtBill")}</p>
              ) : visitsLoading ? (
                <p className="hint" style={{ marginTop: 0 }}>{t("counterInstruments.visitsLoading")}</p>
              ) : todays.length === 0 ? (
                <p className="hint" style={{ marginTop: 0 }} data-testid="no-visit">{t("counterInstruments.noVisit")}</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }} role="radiogroup" aria-label={t("counterInstruments.step2")}>
                  {todays.map((v) => (
                    <button
                      key={v.encounterId}
                      type="button"
                      role="radio"
                      aria-checked={v.encounterId === visitId}
                      className={v.encounterId === visitId ? "opt on" : "opt"}
                      data-testid={`visit-${v.encounterId}`}
                      onClick={() => onPick(v.encounterId)}
                    >
                      <span className="radio" />
                      <span style={{ flexGrow: 1, minWidth: 0 }}>
                        <b style={{ fontWeight: 600 }}>OPD · {v.departmentName ?? v.visitType}{v.doctorName !== null ? ` · ${v.doctorName}` : ""}</b>
                        <span style={{ color: "var(--dim)" }}> · {t("counterInstruments.opened", { time: istClock(new Date(v.openedAt)) })}</span>
                      </span>
                      {applies
                        ? <span className="pill on">{t("counterInstruments.cardApplies")}</span>
                        : <span className="pill rd">{t("counterInstruments.fullRate")}</span>}
                    </button>
                  ))}
                </div>
              )}
              {card !== null && card.holder !== null && <p className="hint">{t("counterInstruments.visitsFrom")}</p>}
            </>
          )}
        </div>
      </div>

      {/* 3 · what the bill will do */}
      {honours && (
        <div className="step">
          <span className="num">3</span>
          <div>
            <h3>{t("counterInstruments.step3")}</h3>
            {card !== null && card.allowances.map((b, i) => (
              <div key={b.benefitKey} className="fact" style={i === 0 ? { borderTop: "none" } : undefined}>
                <span>{b.title}</span>
                <span>
                  {b.allowance.kind === "visits"
                    ? t("counterInstruments.willVisits", { remaining: b.allowance.remaining, granted: b.allowance.granted })
                    : b.allowance.kind === "on_the_bill" ? t("counterInstruments.onTheBill") : t("counterInstruments.everyVisit")}
                </span>
              </div>
            ))}
            {data.coupons.map((c) => (
              <div key={c.couponId} className="fact" data-testid={`coupon-${c.code}`}>
                <span>{c.title}</span>
                <span>
                  <span className="cardno" style={{ fontSize: 12 }}>{c.code}</span>{" "}
                  <span className={c.unusableReason === null ? "pill on" : "pill gd"} style={{ marginLeft: 6 }} data-testid={`coupon-reason-${c.code}`}>
                    {c.unusableReason === null
                      ? t("counterInstruments.couponApplies")
                      : t(`counterInstruments.couponReason.${COUPON_REASONS.has(c.unusableReason) ? c.unusableReason : "retired"}`)}
                  </span>
                </span>
              </div>
            ))}
            <div className="fact"><span>{t("counterInstruments.twoBenefits")}</span><span>{t("counterInstruments.largerWins")}</span></div>
            <p className="hint" style={{ marginTop: 8 }}>{t("counterInstruments.onlyOnIssue")}</p>
          </div>
        </div>
      )}

      {/*
        4 · E-32 — RENDERED AT HONOURING TIME, IN THE SERVER'S OWN WORDS. Deliberately not behind a
        "read more": a disclosure a member has to open is a disclosure they never see. A card that is
        not being honoured (expired, suspended, cancelled, unlinked) has nothing to disclose.
      */}
      {honours && (
        <div className="step">
          <span className="num">4</span>
          <div>
            <h3>{t("counterInstruments.step4")}</h3>
            <p className="disc" data-testid="disclosure" style={{ margin: 0 }}>
              <strong>{t("counterInstruments.disclosureLabel")}</strong> {data.disclosure}
            </p>
            <p className="hint" style={{ fontSize: 11 }}>{t("counterInstruments.verbatim")}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function TodayList({ items, current, onOpen }: { items: WireCardToday[]; current: string | null; onOpen: (code: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const folded = (current ?? "").trim().toLowerCase();
  return (
    <section className="box ci-today" data-testid="cards-today" style={{ overflow: "hidden" }}>
      <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 8 }}>
        <span className="tag" style={{ flexGrow: 1 }}>{t("counterInstruments.today", { count: items.length })}</span>
        <span style={{ fontSize: 11, color: "var(--dim)" }}>{t("counterInstruments.needsYouFirst")}</span>
      </div>
      {items.length === 0 ? (
        <p style={{ padding: "0 14px 14px", margin: 0, fontSize: 12, color: "var(--dim)" }}>{t("counterInstruments.todayEmpty")}</p>
      ) : (
        <div style={{ overflowY: "auto", minHeight: 0 }}>
          {items.map((r) => {
            const who = r.holder?.name ?? r.holder?.alias
              ?? (r.source === "none" ? t("counterInstruments.row.unknown")
                : r.source === "coupon" ? t("counterInstruments.row.couponOnly") : t("counterInstruments.row.noHolder"));
            const src = r.source === "none" ? "NO MATCH" : r.origin === "grace" ? "GRACE" : r.source === "coupon" ? "COUPON" : "CARD";
            const pill = r.source === "none"
              ? { cls: "pill gd", text: t("counterInstruments.row.noMatch") }
              : r.standing === null || r.standing === "usable"
                ? r.linked || r.source === "coupon"
                  ? { cls: "pill on", text: r.source === "coupon" ? t("counterInstruments.row.coupon") : t("counterInstruments.row.active") }
                  : { cls: "pill gd", text: t("counterInstruments.row.toLink") }
                : { cls: "pill rd", text: r.standing === "expired" ? t("counterInstruments.row.expired") : t("counterInstruments.row.blocked") };
            return (
              <button
                key={r.code}
                type="button"
                className={r.code.toLowerCase() === folded ? "row sel" : "row"}
                data-testid={`today-${r.code}`}
                onClick={() => onOpen(r.code)}
              >
                <span className={src === "NO MATCH" || src === "GRACE" ? "src gd" : "src"}>{src}</span>
                <span style={{ flexGrow: 1, minWidth: 0 }}>
                  <b>{who}</b>
                  <small><span className="cardno">{r.code}</span> · {istClock(new Date(r.at))}</small>
                </span>
                <span className={pill.cls}>{pill.text}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
