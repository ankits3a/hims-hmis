import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  approveTicket, claimTicket, declineTicket, getTicket, issueTicket, storesErrorCode, ticketsToApprove, ticketsToPick,
} from "../lib/stores-api";
import type { WireTicket } from "@hmis/contracts";

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
    <div data-testid={testId} style={page} aria-busy="true">
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
    };
    return t(code !== null && known[code] !== undefined ? known[code] : "stores.shelf.failed");
  };
}

const ageOf = (iso: string, now: number): string => {
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  return min < 60 ? `${String(min)} m` : `${String(Math.floor(min / 60))} h`;
};

// ═══════════════════════════════ Approve ═══════════════════════════════

export function StoresApprove({ focus }: { focus?: string }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores", "to-approve"], queryFn: ticketsToApprove, retry: false });
  if (q.data === undefined && !q.isError) return <Loading testId="stores-approve" />;
  const tickets = q.data?.tickets ?? [];
  const ordered = focus === undefined ? tickets : [...tickets].sort((a, b) => Number(b.id === focus) - Number(a.id === focus));
  return (
    <div data-testid="stores-approve" style={page}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.ticket.toApproveTitle")}</h1>
      {ordered.length === 0 ? <p style={{ margin: 0 }}>{t("stores.ticket.nothingToApprove")}</p> : ordered.map((tk) => <ApproveCard key={tk.id} ticket={tk} />)}
    </div>
  );
}

function ApproveCard({ ticket }: { ticket: WireTicket }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refuse = useRefusal();
  const [qty, setQty] = useState<Record<number, number>>({});
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const done = (): Promise<void> => qc.invalidateQueries({ queryKey: ["stores", "to-approve"] });
  return (
    <section data-testid={`approve-${ticket.id}`} style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: "2px solid var(--ink, #222)", paddingTop: 6 }}>
      <div style={rowStyle}>
        <strong style={cell}>{`${ticket.indentNo} · ${ticket.department.name}`}</strong>
        <span style={{ flexShrink: 0, fontWeight: 700 }}>{t(`stores.ticket.priority.${ticket.priority}`)}</span>
      </div>
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
        <textarea aria-label={t("stores.ticket.reason")} placeholder={t("stores.ticket.reason")} value={reason} onChange={(e) => setReason(e.target.value)}
          style={{ width: "100%", boxSizing: "border-box", minHeight: 56 }} />
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!declining && (
          <button type="button" style={primary} onClick={() => {
            const lines = ticket.lines.map((l) => ({ lineIdx: l.lineIdx, qtyBase: qty[l.lineIdx] ?? l.qtyBase }));
            approveTicket(ticket.id, lines).then(done).catch((e: unknown) => setNotice(refuse(e)));
          }}>{t("stores.ticket.approve")}</button>
        )}
        <button type="button" style={btn} onClick={() => {
          if (!declining) { setDeclining(true); return; }
          if (reason.trim() === "") { setNotice(t("stores.ticket.reasonNeeded")); return; }
          declineTicket(ticket.id, reason).then(done).catch((e: unknown) => setNotice(refuse(e)));
        }}>{t("stores.ticket.decline")}</button>
      </div>
    </section>
  );
}

// ═══════════════════════════════ To pick ═══════════════════════════════

export function StoresPick(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores", "to-pick"], queryFn: ticketsToPick, retry: false });
  if (q.data === undefined && !q.isError) return <Loading testId="stores-pick" />;
  const tickets = q.data?.tickets ?? [];
  return (
    <div data-testid="stores-pick" style={page}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.ticket.toPickTitle")}</h1>
      {tickets.length === 0 ? <p style={{ margin: 0 }}>{t("stores.ticket.nothingToPick")}</p> : tickets.map((tk) => <PickRow key={tk.id} ticket={tk} />)}
    </div>
  );
}

function PickRow({ ticket }: { ticket: WireTicket }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refuse = useRefusal();
  const [notice, setNotice] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ["stores", "to-pick"] });
  const claimed = mine || ticket.claim !== null;
  return (
    <div data-testid={`pick-${ticket.id}`} style={{ display: "flex", flexDirection: "column", gap: 2, borderBottom: "1px solid var(--rule, #e3e3e3)" }}>
      <div style={{ ...rowStyle, borderBottom: "none" }}>
        <span style={cell}>{`${ticket.indentNo} · ${ticket.department.name}`}</span>
        <span style={{ flexShrink: 0, fontWeight: ticket.priority === "routine" ? 400 : 700 }}>{t(`stores.ticket.priority.${ticket.priority}`)}</span>
        <span style={num}>{String(ticket.lines.length)}</span>
        <span style={{ ...num, minWidth: 40 }}>{ageOf(ticket.clockFrom, Date.now())}</span>
        {!claimed
          ? <button type="button" style={primary} onClick={() => { claimTicket(ticket.id).then(() => { setMine(true); return refresh(); }).catch((e: unknown) => setNotice(refuse(e))); }}>{t("stores.ticket.claim")}</button>
          : <button type="button" style={primary} onClick={() => { issueTicket(ticket.id).then(() => { setNotice(t("stores.ticket.issued")); return refresh(); }).catch((e: unknown) => setNotice(refuse(e))); }}>{t("stores.ticket.issue")}</button>}
      </div>
      {ticket.claim !== null && !mine && <span style={{ fontSize: 13 }}>{`${t("stores.ticket.claimedBy")} ${ticket.claim.by.name}`}</span>}
      {notice !== null && <span role="status">{notice}</span>}
    </div>
  );
}

// ═══════════════════════════════ Timeline ═══════════════════════════════

export function StoresTicketTimeline({ indentId }: { indentId: string }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores", "ticket", indentId], queryFn: () => getTicket(indentId), retry: false });
  if (q.isError) {
    return <div data-testid="stores-timeline" style={page}><Offline /><p style={{ margin: 0 }}>{t("stores.ticket.notYourDept")}</p></div>;
  }
  if (q.data === undefined) return <Loading testId="stores-timeline" />;
  const { ticket, timeline } = q.data;
  return (
    <div data-testid="stores-timeline" style={page}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {`${ticket.indentNo} · ${t(`stores.ticket.stage.${ticket.stage}`)}`}
      </h1>
      {timeline.steps.map((s, i) => (
        <div key={`${s.step}-${String(i)}`} data-testid={`step-${s.step}`} style={{ display: "flex", flexDirection: "column", gap: 2, borderBottom: "1px solid var(--rule, #e3e3e3)", padding: "4px 0" }}>
          <div style={{ ...rowStyle, borderBottom: "none", minHeight: 24 }}>
            <strong style={cell}>{t(`stores.ticket.step.${s.step}`)}{s.forHod ? ` · ${t("stores.ticket.forHod")}` : ""}</strong>
            <span style={num}>{new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span style={{ ...num, minWidth: 40 }}>{s.minutes === null ? "" : `${String(s.minutes)} m`}</span>
          </div>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>
            {[s.who === null ? null : `${s.who.name}${s.who.roles.length > 0 ? ` (${s.who.roles[0]!})` : ""}`,
              s.from === null ? null : `${s.from.name}${s.to === null ? "" : ` → ${s.to.name}`}`].filter((x) => x !== null).join(" · ")}
          </span>
          {s.note !== null && <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.note}</span>}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════ Receive (S2b, not built yet) ═══════════════════════════════

export function StoresReceive(): React.ReactElement {
  return <div data-testid="stores-receive" />;
}
