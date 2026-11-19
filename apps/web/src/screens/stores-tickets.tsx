import { useEffect, useRef, useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import {
  acceptReturn, approveTicket, claimTicket, confirmLateScan, custodyLookup, declineTicket, deliverTicket, getTicket, handOverCustody, issueTicket,
  lateScans, myCustody, receiveReturn, returnUndelivered, returnsToReceive, storesErrorCode, takeCustody, ticketsComingBack, ticketsToApprove,
  ticketsToPick, ticketsToReceive, whoToAsk,
} from "../lib/stores-api";
import "./stores.css";
import { QrScan, cameraScanPossible } from "../components/qr-scan";
import type { DeliverLine } from "../lib/stores-api";
import type { WireCustodyLookup, WireLateScan, WireTicket, WireTimelineStep } from "@hmis/contracts";

/**
 * STORES S2a (#1112) — THE TICKET SCREENS (spec "## Screens"): Approve (phone, from the notice), To pick (the
 * store; a 16:9 desk as well as a phone) and the Timeline (read-only). Each fits 390 px with no sideways
 * scroll: one row per line, the name gives way with an ellipsis before the numbers do. Every status is a
 * WORD. Loading is grey rows with no text; "No connection" shows whenever the browser goes offline. The
 * server asks every grant at the ticket's department; a refusal reads as the spec's few words.
 */

const page: React.CSSProperties = {
  maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", padding: "12px 16px 24px", display: "flex", flexDirection: "column", gap: 10,
  background: "var(--paper, #fff)", minHeight: "100%",
};
const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", overflow: "hidden", minHeight: 44,
  borderBottom: "1px solid var(--rule, #e3e3e3)", padding: "4px 0",
};
const cell: React.CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" };
const num: React.CSSProperties = { flexShrink: 0, fontVariantNumeric: "tabular-nums", minWidth: 32, textAlign: "right" };
const btn: React.CSSProperties = { minHeight: 40, padding: "0 12px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent", flexShrink: 0 };
const primary: React.CSSProperties = { ...btn, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 600 };

/** True while the browser says it is online; the screens say "No connection" otherwise. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}

function Offline(): React.ReactElement | null {
  const { t } = useTranslation();
  return useOnline() ? null : <p role="alert" data-testid="stores-offline" style={{ margin: 0, fontWeight: 700 }}>{t("stores.ticket.offline")}</p>;
}

function Loading({ testId }: { testId: string }): React.ReactElement {
  return (
    <div data-testid={testId} className="stores-ui" style={page} aria-busy="true">
      {[0, 1, 2].map((i) => <div key={i} style={{ ...rowStyle, background: "var(--rule, #eee)", borderRadius: 4 }} />)}
    </div>
  );
}

/** The spec's refusal words for a server code; anything else is "Could not save". */
function useRefusal(): (e: unknown) => string {
  const { t } = useTranslation();
  return (e) => {
    const code = storesErrorCode(e);
    const known: Record<string, string> = {
      own_ticket: "stores.ticket.ownTicket", not_permitted: "stores.ticket.notYourDept", claimed_by_another: "stores.ticket.takenByAnother",
      not_approved: "stores.ticket.notApprovedYet", indent_not_approved: "stores.ticket.notApprovedYet", reason_required: "stores.ticket.reasonNeeded",
      more_than_asked: "stores.ticket.onlyDown", not_store_keeper: "stores.ticket.notYourDept",
      you_issued_it: "stores.ticket.youIssued", you_carried_it: "stores.ticket.youCarried", not_in_your_hands: "stores.ticket.notInHands",
      transfer_self_receipt: "stores.ticket.youIssued", unknown_ticket: "stores.ticket.notInHands", ambiguous_code: "stores.ticket.scan",
    };
    return t(code !== null && known[code] !== undefined ? known[code] : "stores.shelf.failed");
  };
}

const hhmm = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const ageOf = (iso: string, now: number): string => {
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  return min < 60 ? `${String(min)} m` : `${String(Math.floor(min / 60))} h`;
};

/** A step's time: the clock alone today, the day and the clock otherwise (a late scan, an old ticket). */
export const when = (iso: string, now: Date = new Date()): string => {
  const d = new Date(iso);
  return d.toDateString() === now.toDateString() ? hhmm(iso) : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${hhmm(iso)}`;
};

/**
 * UX pass (walk findings 4, 5) — a ticket is named by its last four digits on every screen (the label's typed
 * fallback, what a porter and a keeper say aloud), and the number is always a link to its timeline. The full
 * number is the timeline's heading alone.
 */
export function TicketNo({ id, no }: { id: string; no: string }): React.ReactElement {
  return <Link to="/stores/tickets/$indentId" params={{ indentId: id }} className="stores-no" style={{ flexShrink: 0 }}>{no.slice(-4)}</Link>;
}

/** The deep link a Now card or the shelf carries (`?ticket=` / `?transfer=`, walk finding 6). */
function useFocus(): { ticket?: string; transfer?: string } {
  return useSearch({ strict: false }) as { ticket?: string; transfer?: string };
}

/** Scrolls the focused card into view once, on arrival. */
function useScrollTo(focused: boolean): React.RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView?.({ block: "center" }); }, [focused]);
  return ref;
}

/**
 * UX pass (walk finding 14, programme §5.5) — a refusal is never a dead end: it names who to ask (the department's
 * HOD, from the server) and offers Back.
 */
export function Refused({ at, testId }: { at: { shelfId: string } | { indentId: string }; testId: string }): React.ReactElement {
  const { t } = useTranslation();
  const ask = useQuery({ queryKey: ["stores", "who-to-ask", at], queryFn: () => whoToAsk(at), retry: false });
  const names = (ask.data?.ask ?? []).map((p) => p.name).join(", ");
  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0, fontWeight: 700 }}>{t("stores.ticket.notYourDept")}</p>
      {ask.data !== undefined && names !== "" && <p style={{ margin: 0 }}>{`${t("stores.ux.ask", { names })} · ${ask.data.department.name}`}</p>}
      <button type="button" style={{ ...btn, alignSelf: "flex-start" }} onClick={() => window.history.back()}>{t("stores.shelf.back")}</button>
    </div>
  );
}

// ═══════════════════════════════ Approve ═══════════════════════════════

/** The deep-linked ticket first, then emergencies (walk finding 6), then the server's order (the clock). */
const rank = (tk: WireTicket, focus: string | undefined): number => (tk.id === focus ? 0 : tk.priority === "emergency" ? 1 : 2);

export function StoresApprove(): React.ReactElement {
  const { t } = useTranslation();
  const { ticket: focus } = useFocus();
  const q = useQuery({ queryKey: ["stores", "to-approve"], queryFn: ticketsToApprove, retry: false });
  if (q.data === undefined && !q.isError) return <Loading testId="stores-approve" />;
  const tickets = q.data?.tickets ?? [];
  const ordered = [...tickets].sort((a, b) => rank(a, focus) - rank(b, focus));
  return (
    <div data-testid="stores-approve" className="stores-ui" style={page}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.ticket.toApproveTitle")}</h1>
      {ordered.length === 0 ? <p style={{ margin: 0 }}>{t("stores.ticket.nothingToApprove")}</p> : ordered.map((tk) => <ApproveCard key={tk.id} ticket={tk} focused={tk.id === focus} />)}
    </div>
  );
}

function ApproveCard({ ticket, focused }: { ticket: WireTicket; focused: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refuse = useRefusal();
  const [qty, setQty] = useState<Record<number, number>>({});
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonMissing, setReasonMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ref = useScrollTo(focused);
  const done = (): Promise<void> => qc.invalidateQueries({ queryKey: ["stores", "to-approve"] });
  return (
    <section
      ref={ref} data-testid={`approve-${ticket.id}`} data-focused={focused ? "true" : undefined}
      style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: "2px solid var(--ink, #222)", paddingTop: 6 }}
    >
      <div style={rowStyle}>
        <TicketNo id={ticket.id} no={ticket.indentNo} />
        <strong style={cell}>{ticket.department.name}</strong>
        <span style={{ flexShrink: 0, fontWeight: 700 }}>{t(`stores.ticket.priority.${ticket.priority}`)}</span>
      </div>
      <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {`${t("stores.ux.by", { name: ticket.requestedBy.name })} · ${ageOf(ticket.clockFrom, Date.now())}`}
      </span>
      {ticket.emergencyReason !== null && <p style={{ margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ticket.emergencyReason}</p>}
      <div style={{ ...rowStyle, minHeight: 28, fontSize: 13 }}>
        <span style={cell}>{t("stores.ticket.item")}</span><span style={num}>{t("stores.ticket.asked")}</span><span style={{ ...num, minWidth: 64 }}>{t("stores.ticket.approveQty")}</span>
      </div>
      {ticket.lines.map((l) => (
        <label key={l.lineIdx} style={rowStyle}>
          <span style={cell}>{l.itemName}</span>
          <span style={num}>{String(l.qtyBase)}</span>
          <input
            type="number" inputMode="numeric" min={0} max={l.qtyBase} aria-label={`${t("stores.ticket.approveQty")} · ${l.itemName}`}
            value={qty[l.lineIdx] ?? l.qtyBase}
            onChange={(e) => setQty((c) => ({ ...c, [l.lineIdx]: Math.min(l.qtyBase, Math.max(0, Number(e.target.value.replace(/\D/g, "") || "0"))) }))}
            style={{ width: 64, minHeight: 36, flexShrink: 0, textAlign: "right", boxSizing: "border-box" }}
          />
        </label>
      ))}
      {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
      {declining && (
        <>
          <textarea aria-label={t("stores.ticket.reason")} placeholder={t("stores.ticket.reason")} value={reason}
            onChange={(e) => { setReason(e.target.value); if (e.target.value.trim() !== "") setReasonMissing(false); }}
            style={{ width: "100%", boxSizing: "border-box", minHeight: 56 }} />
          {reasonMissing && <p role="alert" style={{ margin: 0, fontWeight: 700 }}>{t("stores.ticket.reasonNeeded")}</p>}
        </>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!declining && (
          <button type="button" style={primary} onClick={() => {
            const lines = ticket.lines.map((l) => ({ lineIdx: l.lineIdx, qtyBase: qty[l.lineIdx] ?? l.qtyBase }));
            approveTicket(ticket.id, lines).then(done).catch((e: unknown) => setNotice(refuse(e)));
          }}>{t("stores.ticket.approve")}</button>
        )}
        <button type="button" style={declining ? primary : btn} onClick={() => {
          if (!declining) { setDeclining(true); return; }
          if (reason.trim() === "") { setReasonMissing(true); return; }
          declineTicket(ticket.id, reason).then(done).catch((e: unknown) => setNotice(refuse(e)));
        }}>{t("stores.ticket.decline")}</button>
        {declining && (
          <button type="button" style={btn} onClick={() => { setDeclining(false); setReason(""); setReasonMissing(false); }}>{t("stores.ticket.cancel")}</button>
        )}
      </div>
    </section>
  );
}

// ═══════════════════════════════ To pick ═══════════════════════════════

export function StoresPick(): React.ReactElement {
  const { t } = useTranslation();
  const { ticket: focus } = useFocus();
  const q = useQuery({ queryKey: ["stores", "to-pick"], queryFn: ticketsToPick, retry: false });
  if (q.data === undefined && !q.isError) return <Loading testId="stores-pick" />;
  // The server's order is the floor, then the clock; a deep-linked ticket comes first.
  const tickets = [...(q.data?.tickets ?? [])].sort((a, b) => Number(b.id === focus) - Number(a.id === focus));
  return (
    <div data-testid="stores-pick" className="stores-ui" style={page}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.ticket.toPickTitle")}</h1>
      {tickets.length === 0 ? <p style={{ margin: 0 }}>{t("stores.ticket.nothingToPick")}</p> : tickets.map((tk) => <PickRow key={tk.id} ticket={tk} focused={tk.id === focus} />)}
      <TakeBack />
      <LateScans />
    </div>
  );
}

/** The keeper's refusal words for taking back and confirming: each names who can, or that it is done. */
function useKeeperRefusal(): (e: unknown) => string {
  const { t } = useTranslation();
  return (e) => {
    const code = storesErrorCode(e);
    const known: Record<string, string> = {
      not_permitted: "stores.ticket.sendingKeeperOnly", nothing_to_return: "stores.ticket.alreadyBack", not_in_transit: "stores.ticket.alreadyBack",
      already_confirmed: "stores.ticket.alreadyConfirmed", unknown_scan: "stores.ticket.alreadyConfirmed",
    };
    return t(code !== null && known[code] !== undefined ? known[code] : "stores.shelf.failed");
  };
}

/**
 * UX pass (#1112) — "To take back", on the keeper's own screen: tickets coming back undelivered or sent back, and
 * the department returns on their way, each one tap. Absent when nothing is coming back.
 */
function TakeBack(): React.ReactElement | null {
  const { t } = useTranslation();
  const back = useQuery({ queryKey: ["stores", "coming-back"], queryFn: ticketsComingBack, retry: false });
  const returns = useQuery({ queryKey: ["stores", "returns-to-receive"], queryFn: returnsToReceive, retry: false });
  const tickets = back.data?.tickets ?? [];
  const rets = returns.data?.returns ?? [];
  if (tickets.length + rets.length === 0) return null;
  return (
    <section data-testid="stores-take-back" style={{ display: "flex", flexDirection: "column", gap: 2, borderTop: "2px solid var(--ink, #222)", paddingTop: 6 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{`${t("stores.now.toTakeBack")} · ${String(tickets.length + rets.length)}`}</h2>
      {tickets.map((tk) => (
        <OneTapRow key={tk.id} testId={`back-ticket-${tk.id}`} no={<TicketNo id={tk.id} no={tk.indentNo} />} label={tk.department.name} word={t(`stores.ticket.stage.${tk.stage}`)}
          action={t("stores.ticket.takeBack")} done={t("stores.ticket.backAtStore")} act={() => acceptReturn(tk.id)} invalidate={["coming-back"]} />
      ))}
      {rets.map((r) => (
        <OneTapRow key={r.transferId} testId={`back-return-${r.transferId}`} label={`${r.shelf.name} · ${r.lines.map((l) => `${l.itemName} ${String(l.qtyBase)}`).join(", ")}`}
          word={t(r.quarantine ? "stores.ticket.toQuarantine" : "stores.ticket.returnWord")}
          action={t("stores.ticket.takeBack")} done={t("stores.ticket.backAtStore")} act={() => receiveReturn(r.transferId)} invalidate={["returns-to-receive"]} />
      ))}
    </section>
  );
}

/** UX pass (#1112) — "Late scan to confirm": who scanned, the phone's time → when it reached the server; one tap. */
function LateScans(): React.ReactElement | null {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores", "late-scans"], queryFn: lateScans, retry: false });
  const scans: WireLateScan[] = q.data?.scans ?? [];
  if (scans.length === 0) return null;
  return (
    <section data-testid="stores-late-scans" style={{ display: "flex", flexDirection: "column", gap: 2, borderTop: "2px solid var(--ink, #222)", paddingTop: 6 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{`${t("stores.ticket.lateScanToConfirm")} · ${String(scans.length)}`}</h2>
      {scans.map((sc) => (
        <OneTapRow key={sc.handoffId} testId={`late-${sc.handoffId}`} no={<TicketNo id={sc.indentId} no={sc.indentNo} />} label={sc.by.name} sub={`${when(sc.phoneAt)} → ${when(sc.recordedAt)}`}
          word={t(`stores.ticket.flag.${sc.flag}`)} action={t("stores.ticket.confirm")} done={t("stores.ticket.confirmed")}
          act={() => confirmLateScan(sc.handoffId)} invalidate={["late-scans"]} />
      ))}
    </section>
  );
}

function OneTapRow({ testId, no, label, sub, word, action, done, act, invalidate }: {
  testId: string; no?: React.ReactNode; label: string; sub?: string; word: string; action: string; done: string; act: () => Promise<unknown>; invalidate: string[];
}): React.ReactElement {
  const qc = useQueryClient();
  const refuse = useKeeperRefusal();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", borderBottom: "1px solid var(--rule, #e3e3e3)" }}>
      <div style={{ ...rowStyle, borderBottom: "none" }}>
        {no}
        <span style={cell}>{label}</span>
        <span style={{ flexShrink: 0, fontWeight: 700 }}>{finished ? done : word}</span>
        {!finished && (
          <button type="button" style={primary} disabled={busy} onClick={() => {
            setBusy(true);
            act()
              .then(() => { setFinished(true); setNotice(null); return qc.invalidateQueries({ queryKey: ["stores", ...invalidate] }); })
              .catch((e: unknown) => setNotice(refuse(e)))
              .finally(() => setBusy(false));
          }}>{action}</button>
        )}
      </div>
      {sub !== undefined && <span style={{ fontSize: 13, paddingBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</span>}
      {notice !== null && <span role="status">{notice}</span>}
    </div>
  );
}

/**
 * UX pass (walk findings 2, 3) — a To pick row says what to pick: the ticket (its number opens the timeline), the
 * department, priority and age, then one line per item with the APPROVED quantity, and the shelf it goes to. A
 * ticket another keeper is picking reads "Taken by <name>" and offers no button (the server would refuse it).
 */
function PickRow({ ticket, focused }: { ticket: WireTicket; focused: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refuse = useRefusal();
  const { actor } = useAuth();
  const [notice, setNotice] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const ref = useScrollTo(focused);
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ["stores", "to-pick"] });
  const me = actor?.id ?? null;
  const theirs = ticket.claim !== null && !mine && me !== null && ticket.claim.by.id !== me;
  const claimed = mine || ticket.claim !== null;
  return (
    <div
      ref={ref as React.RefObject<HTMLDivElement>} data-testid={`pick-${ticket.id}`} data-focused={focused ? "true" : undefined}
      style={{ display: "flex", flexDirection: "column", gap: 2, borderBottom: "1px solid var(--rule, #e3e3e3)", paddingBottom: 6 }}
    >
      <div style={{ ...rowStyle, borderBottom: "none" }}>
        <TicketNo id={ticket.id} no={ticket.indentNo} />
        <span style={cell}>{ticket.department.name}</span>
        <span style={{ flexShrink: 0, fontWeight: ticket.priority === "routine" ? 400 : 700 }}>{t(`stores.ticket.priority.${ticket.priority}`)}</span>
        <span style={{ ...num, minWidth: 40 }}>{ageOf(ticket.clockFrom, Date.now())}</span>
        {theirs
          ? null
          : !claimed
            ? <button type="button" style={primary} onClick={() => { claimTicket(ticket.id).then(() => { setMine(true); return refresh(); }).catch((e: unknown) => setNotice(refuse(e))); }}>{t("stores.ticket.claim")}</button>
            : <button type="button" style={primary} onClick={() => { issueTicket(ticket.id).then(() => { setNotice(t("stores.ticket.issued")); return refresh(); }).catch((e: unknown) => setNotice(refuse(e))); }}>{t("stores.ticket.issue")}</button>}
      </div>
      {theirs && <span style={{ fontSize: 13, fontWeight: 700 }}>{`${t("stores.ticket.claimedBy")} ${ticket.claim!.by.name}`}</span>}
      {ticket.lines.map((l) => (
        <div key={l.lineIdx} data-testid={`pick-line-${String(l.lineIdx)}`} style={{ ...rowStyle, minHeight: 24, borderBottom: "none", padding: "0 0 0 12px", fontSize: 14 }}>
          <span style={cell}>{l.itemName}</span>
          <span style={num}>{String(l.qtyApproved ?? l.qtyBase)}</span>
          <span style={{ flexShrink: 0, fontSize: 13, minWidth: 40 }}>{l.baseUom}</span>
        </div>
      ))}
      <span style={{ fontSize: 13, paddingLeft: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{`→ ${ticket.shelf.name}`}</span>
      {notice !== null && <span role="status">{notice}</span>}
    </div>
  );
}

// ═══════════════════════════════ Timeline ═══════════════════════════════

/** Where the ticket's next step is done (walk finding 5: no dead end); the server decides whether this person may. */
const NEXT_STEP: Partial<Record<WireTicket["stage"], { to: "/stores/approve" | "/stores/pick" | "/stores/receive"; label: string }>> = {
  to_approve: { to: "/stores/approve", label: "stores.now.toApprove" },
  to_pick: { to: "/stores/pick", label: "stores.now.toPick" },
  to_receive: { to: "/stores/receive", label: "stores.now.toReceive" },
};

export function StoresTicketTimeline({ indentId }: { indentId: string }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores", "ticket", indentId], queryFn: () => getTicket(indentId), retry: false });
  if (q.isError) {
    return <div data-testid="stores-timeline" className="stores-ui" style={page}><Offline /><Refused at={{ indentId }} testId="timeline-refused" /></div>;
  }
  if (q.data === undefined) return <Loading testId="stores-timeline" />;
  const { ticket, timeline } = q.data;
  const next = NEXT_STEP[ticket.stage];
  return (
    <div data-testid="stores-timeline" className="stores-ui" style={page}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {`${ticket.indentNo} · ${t(`stores.ticket.stage.${ticket.stage}`)}`}
      </h1>
      <div style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", overflow: "hidden" }}>
        <span style={cell}>{`${ticket.department.name} · ${ticket.shelf.name}`}</span>
        {next !== undefined && <Link to={next.to} search={{ ticket: ticket.id }} className="stores-btn">{t(next.label)}</Link>}
      </div>
      {timeline.steps.map((s, i) => <TimelineStep key={`${s.step}-${String(i)}`} s={s} />)}
    </div>
  );
}

/**
 * UX pass (walk finding 8) — one step: what, when (the day too when not today), who with their role in words (a
 * role this screen has no word for is left off rather than shown as its key), from → to, and per line what was
 * asked, approved and issued.
 */
function TimelineStep({ s }: { s: WireTimelineStep }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const role = s.who?.roles.find((r) => i18n.exists(`stores.ux.role.${r}`));
  const small: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 };
  return (
    <div data-testid={`step-${s.step}`} style={{ display: "flex", flexDirection: "column", gap: 2, borderBottom: "1px solid var(--rule, #e3e3e3)", padding: "4px 0" }}>
      <div style={{ ...rowStyle, borderBottom: "none", minHeight: 24 }}>
        <strong style={cell}>{t(`stores.ticket.step.${s.step}`)}{s.forHod ? ` · ${t("stores.ticket.forHod")}` : ""}</strong>
        <span style={{ ...num, minWidth: 44 }}>{when(s.at)}</span>
        <span style={{ ...num, minWidth: 40 }}>{s.minutes === null ? "" : `${String(s.minutes)} m`}</span>
      </div>
      <span style={small}>
        {[s.who === null ? null : `${s.who.name}${role === undefined ? "" : ` (${t(`stores.ux.role.${role}`)})`}`,
          s.from === null ? null : `${s.from.name}${s.to === null ? "" : ` → ${s.to.name}`}`].filter((x) => x !== null).join(" · ")}
      </span>
      {s.lines.map((l) => (
        <span key={l.itemId} data-testid={`step-line-${l.itemId}`} style={{ ...small, paddingLeft: 12 }}>
          {[l.itemName, t("stores.ux.askedN", { n: l.asked }), l.approved === null ? null : t("stores.ux.approvedN", { n: l.approved }),
            l.issued === null ? null : t("stores.ux.issuedN", { n: l.issued })].filter((x) => x !== null).join(" · ")}
        </span>
      ))}
      {s.note !== null && <span style={small}>{s.note}</span>}
      {s.phoneAt != null && s.recordedAt != null && (
        <span data-testid="step-synced-late" style={small}>{`${t("stores.ticket.syncedLate")} · ${when(s.phoneAt)} → ${when(s.recordedAt)}`}</span>
      )}
    </div>
  );
}

// ═══════════════════════════════ Receive (S2b) ═══════════════════════════════

type Remainder = "short" | "wrong" | "damaged";
const REMAINDERS: readonly Remainder[] = ["short", "wrong", "damaged"];

/**
 * STORES S2b (#1112, D24) — RECEIVE, on the phone: one row per line, the issued quantity prefilled. Fewer than
 * issued makes the rest "Short"; one tap on the word makes it "Wrong", then "Damaged". Confirm is the one primary.
 * UX pass (walk finding 9): headed Item · Issued · Got; "From <porter>"; a one-tap −1 per line; and under a line
 * with a remainder the three choices in plain sight (the in-row word still cycles them).
 */
export function StoresReceive(): React.ReactElement {
  const { t } = useTranslation();
  const focus = useFocus();
  const q = useQuery({ queryKey: ["stores", "to-receive"], queryFn: ticketsToReceive, retry: false });
  if (q.data === undefined && !q.isError) return <Loading testId="stores-receive" />;
  const isFocus = (tk: WireTicket): boolean => tk.id === focus.ticket || (focus.transfer !== undefined && tk.transfer?.id === focus.transfer);
  const tickets = [...(q.data?.tickets ?? [])].sort((a, b) => Number(isFocus(b)) - Number(isFocus(a)));
  return (
    <div data-testid="stores-receive" className="stores-ui" style={page}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.ticket.receiveTitle")}</h1>
      {tickets.length === 0 ? <p style={{ margin: 0 }}>{t("stores.ticket.nothingToReceive")}</p> : tickets.map((tk) => <ReceiveCard key={tk.id} ticket={tk} focused={isFocus(tk)} />)}
    </div>
  );
}

function ReceiveCard({ ticket, focused }: { ticket: WireTicket; focused: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refuse = useRefusal();
  const ref = useScrollTo(focused);
  const issuedLines = ticket.lines.filter((l) => (l.qtyIssued ?? 0) > 0);
  const [got, setGot] = useState<Record<number, number>>({});
  const [kind, setKind] = useState<Record<number, Remainder>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const holder = ticket.custody?.holder ?? null;
  const confirm = (): void => {
    const lines: DeliverLine[] = issuedLines.map((l) => {
      const issued = l.qtyIssued ?? 0;
      const accepted = got[l.lineIdx] ?? issued;
      const rest = issued - accepted;
      return rest > 0 ? { lineIdx: l.lineIdx, accepted, [kind[l.lineIdx] ?? "short"]: rest } : { lineIdx: l.lineIdx, accepted };
    });
    setBusy(true);
    deliverTicket(ticket.id, lines)
      .then(() => { setNotice(t("stores.ticket.stage.delivered")); return qc.invalidateQueries({ queryKey: ["stores", "to-receive"] }); })
      .catch((e: unknown) => setNotice(refuse(e)))
      .finally(() => setBusy(false));
  };
  const head: React.CSSProperties = { flexShrink: 0, fontSize: 12, textAlign: "right" };
  return (
    <section
      ref={ref} data-testid={`receive-${ticket.id}`} data-focused={focused ? "true" : undefined}
      style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: "2px solid var(--ink, #222)", paddingTop: 6 }}
    >
      <div style={rowStyle}>
        <TicketNo id={ticket.id} no={ticket.indentNo} />
        <strong style={cell}>{ticket.source.name}</strong>
        <span style={{ flexShrink: 0, fontWeight: 700 }}>{t(`stores.ticket.stage.${ticket.stage}`)}</span>
      </div>
      {holder !== null && <span style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("stores.ux.from", { name: holder.name })}</span>}
      <div data-testid="receive-head" style={{ ...rowStyle, minHeight: 24, fontSize: 12 }}>
        <span style={cell}>{t("stores.ticket.item")}</span>
        <span style={{ ...head, minWidth: 32 }}>{t("stores.ticket.issued")}</span>
        <span style={{ ...head, width: 56, textAlign: "center" }}>{t("stores.ux.got")}</span>
        <span style={{ flexShrink: 0, width: 40 }} />
        <span style={{ flexShrink: 0, width: 72 }} />
      </div>
      {issuedLines.map((l) => {
        const issued = l.qtyIssued ?? 0;
        const accepted = got[l.lineIdx] ?? issued;
        const rest = issued - accepted;
        const word: Remainder | "accept" = rest > 0 ? (kind[l.lineIdx] ?? "short") : "accept";
        const set = (n: number): void => setGot((c) => ({ ...c, [l.lineIdx]: Math.min(issued, Math.max(0, n)) }));
        return (
          <div key={l.lineIdx} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <label data-testid={`receive-line-${String(l.lineIdx)}`} style={rowStyle}>
              <span style={cell}>{l.itemName}</span>
              <span style={num}>{String(issued)}</span>
              <input
                type="number" inputMode="numeric" min={0} max={issued} aria-label={`${t("stores.ticket.issued")} · ${l.itemName}`}
                value={accepted}
                onChange={(e) => set(Number(e.target.value.replace(/\D/g, "") || "0"))}
                style={{ width: 56, minHeight: 40, flexShrink: 0, textAlign: "right", boxSizing: "border-box", padding: "0 6px" }}
              />
              <button type="button" style={{ ...btn, width: 40, padding: 0 }} disabled={accepted <= 0} aria-label={`${t("stores.ux.oneLess")} · ${l.itemName}`}
                onClick={(e) => { e.preventDefault(); set(accepted - 1); }}>−1</button>
              {rest > 0
                ? (
                  <button type="button" style={{ ...btn, minWidth: 72, padding: "0 6px" }} onClick={(e) => { e.preventDefault(); setKind((c) => ({ ...c, [l.lineIdx]: REMAINDERS[(REMAINDERS.indexOf(word as Remainder) + 1) % REMAINDERS.length]! })); }}>
                    <span>{String(rest)}</span> <span>{t(`stores.ticket.status.${word}`)}</span>
                  </button>
                )
                : <span style={{ flexShrink: 0, width: 72, textAlign: "center" }}>{t("stores.ticket.status.accept")}</span>}
            </label>
            {rest > 0 && (
              <div role="radiogroup" aria-label={`${t("stores.ux.restIs")} · ${l.itemName}`} style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 12, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13 }}>{`${t("stores.ux.restIs")} ${String(rest)}:`}</span>
                {REMAINDERS.map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={word === k} style={{ ...(word === k ? primary : btn), minHeight: 36 }}
                    onClick={() => setKind((c) => ({ ...c, [l.lineIdx]: k }))}>{t(`stores.ticket.status.${k}`)}</button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
      <button type="button" style={primary} disabled={busy} onClick={confirm}>{t("stores.ticket.confirm")}</button>
    </section>
  );
}

// ═══════════════════════════════ Porter card (S2b, UX pass) ═══════════════════════════════

/** The porter card's own refusal words: each names what to do next. */
const PORTER_WORDS: Record<string, string> = {
  unknown_ticket: "stores.ticket.noSuchTicket", ambiguous_code: "stores.ticket.twoMatch", already_yours: "stores.ticket.alreadyYours",
  not_in_your_hands: "stores.ticket.notInHands", not_permitted: "stores.ticket.portersOnly", not_in_transit: "stores.ticket.notOnItsWay",
};

/** What a ticket carries, in one line: "Wet mop refill 20, Household gloves 12". */
const itemsOf = (tk: WireTicket): string =>
  tk.lines.filter((l) => (l.qtyIssued ?? l.qtyApproved ?? l.qtyBase) > 0).map((l) => `${l.itemName} ${String(l.qtyIssued ?? l.qtyApproved ?? l.qtyBase)}`).join(", ");

/**
 * STORES S2b (#1112, decision 7; UX pass) — THE PORTER'S CARD: what is in my hands, and a take in two taps — Scan
 * (the camera reads the label's QR), then Take. Without a camera the label's last four digits, typed, find the
 * ticket by themselves. The server names whose hands it is in ("Taking from <name>"). UX pass from the walk
 * (finding 11): each row leads with WHERE it goes, lists what it is, and "Bring back" asks before it acts. There is
 * no "hand back before leaving" line: the web app has no shift end to time it by, so it waits for S3's
 * end-of-shift red card rather than shouting all day.
 */
export function StoresPorter(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["stores", "custody-mine"], queryFn: myCustody, retry: false });
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [noCamera, setNoCamera] = useState(false);
  const [found, setFound] = useState<{ code: string; at: WireCustodyLookup } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bringing, setBringing] = useState<string | null>(null);
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ["stores", "custody-mine"] });
  const refuse = (e: unknown): void => {
    const c = storesErrorCode(e);
    setNotice(t(c !== null && PORTER_WORDS[c] !== undefined ? PORTER_WORDS[c] : "stores.shelf.failed"));
    setFound(null);
    setCode("");
  };
  const find = (c: string): void => {
    setNotice(null);
    setBusy(true);
    custodyLookup(c).then((at) => setFound({ code: c, at })).catch(refuse).finally(() => setBusy(false));
  };
  const take = (): void => {
    if (found === null) return;
    setBusy(true);
    (found.at.act === "take" ? takeCustody(found.code) : handOverCustody(found.code, found.at.holder.id))
      .then(() => { setNotice(t("stores.ticket.taken")); setFound(null); setCode(""); return refresh(); })
      .catch(refuse)
      .finally(() => setBusy(false));
  };
  if (q.data === undefined && !q.isError) return <Loading testId="stores-porter" />;
  const rows = q.data?.rows ?? [];
  const canScan = !noCamera && cameraScanPossible();
  const small: React.CSSProperties = { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  return (
    <div data-testid="stores-porter" className="stores-ui" style={page}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.ticket.porterTitle")}</h1>
      {rows.length === 0 ? <p style={{ margin: 0 }}>{t("stores.ticket.nothingInHands")}</p> : rows.map((r) => (
        <div key={r.ticket.id} data-testid={`porter-${r.ticket.id}`} style={{ display: "flex", flexDirection: "column", gap: 2, borderBottom: "1px solid var(--rule, #e3e3e3)", paddingBottom: 6 }}>
          <div style={{ ...rowStyle, borderBottom: "none" }}>
            <strong data-testid="porter-to" style={cell}>{`→ ${r.to.name}`}</strong>
            <span style={{ ...num, minWidth: 40 }}>{`${String(r.minutes)} m`}</span>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap", overflow: "hidden", fontSize: 13 }}>
            <TicketNo id={r.ticket.id} no={r.ticket.indentNo} />
            <span style={cell}>{t("stores.ux.from", { name: r.from.name })}</span>
          </div>
          <span style={small}>{itemsOf(r.ticket)}</span>
          {bringing === r.ticket.id ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <strong style={small}>{t("stores.ux.bringBackTo", { name: r.from.name })}</strong>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" style={{ ...primary, flex: 1 }} disabled={busy} onClick={() => {
                  setBusy(true);
                  returnUndelivered(r.ticket.id).then(() => { setBringing(null); return refresh(); }).catch(refuse).finally(() => setBusy(false));
                }}>{t("stores.ux.yesBringBack")}</button>
                <button type="button" style={btn} onClick={() => setBringing(null)}>{t("stores.ticket.cancel")}</button>
              </div>
            </div>
          ) : (
            <button type="button" style={{ ...btn, alignSelf: "flex-start" }} onClick={() => setBringing(r.ticket.id)}>{t("stores.ticket.returnBack")}</button>
          )}
        </div>
      ))}
      {found !== null ? (
        <section data-testid="porter-confirm" style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "2px solid var(--ink, #222)", paddingTop: 6 }}>
          <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("stores.ticket.takingFrom", { name: found.at.holder.name })}</strong>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700 }}>{`→ ${found.at.ticket.shelf.name}`}</span>
          <span style={small}>{`${found.at.ticket.indentNo.slice(-4)} · ${t("stores.ux.from", { name: found.at.ticket.source.name })}`}</span>
          <span style={small}>{itemsOf(found.at.ticket)}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={{ ...primary, flex: 1 }} disabled={busy} onClick={take}>{t("stores.ticket.take")}</button>
            <button type="button" style={btn} onClick={() => { setFound(null); setCode(""); }}>{t("stores.ticket.cancel")}</button>
          </div>
        </section>
      ) : scanning ? (
        <QrScan
          onRead={(text) => { setScanning(false); find(text); }}
          onClose={(why) => { setScanning(false); if (why === "unavailable") { setNoCamera(true); setNotice(t("stores.ticket.cameraOff")); } }}
        />
      ) : (
        <>
          {canScan && <button type="button" style={{ ...primary, minHeight: 48 }} disabled={busy} onClick={() => { setNotice(null); setScanning(true); }}>{t("stores.ticket.scan")}</button>}
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span>{t("stores.ticket.typeLast4")}</span>
            <input
              inputMode="numeric" autoComplete="off" maxLength={4} aria-label={t("stores.ticket.typeLast4")} value={code} disabled={busy}
              onChange={(e) => {
                const c = e.target.value.replace(/\D/g, "").slice(0, 4);
                setCode(c);
                if (c.length === 4) find(c);
              }}
              style={{ minHeight: 44, boxSizing: "border-box", width: "100%", fontSize: 20, letterSpacing: 4 }}
            />
          </label>
        </>
      )}
      {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
    </div>
  );
}
