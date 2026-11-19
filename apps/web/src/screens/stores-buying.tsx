import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import {
  approveAward, approvePoSheet, buyingDesk, comparative, confirmGroupDraft, confirmPoDraft, confirmQuoteLine, confirmRfqDraft, decideAdvance, dismissDraft,
  draftPdf, draftPo, draftRfq, enterQuote, getAward, getDraft, getException, groupLines, makeRfq, moveLine, objectAward, poFromAward, poFromGroup, poSheet,
  proposeAward, readQuotePdf, refuseException, requestAdvance, requestException, scorecard, sendPo, sendRfq, signException, submitPo, suppliers,
} from "../lib/buying-api";
import { storesErrorCode } from "../lib/stores-api";
import "./stores.css";
import type {
  StoresBand, WireAgentProposal, WireAward, WireBuyException, WireBuyGroup, WireBuyRow, WireBuyingDesk, WireComparative, WireRfq, WireStoresPoRow,
  WireStoresPoSheet, WireStoresSupplier,
} from "@hmis/contracts";

/**
 * STORES S5b (#1115, spec "## Screens") — `/stores/buying`, THE BUYING DESK BY HAND (16:9, fits 1366 × 768) and, from a
 * notice, the PHONE SHEET that approves one award (`?award=`) or one PO (`?po=`) in one tap at 390 px.
 *
 * Tabs: Buy now (urgent and emergency requests the moment they are approved), Grouping (tick approved lines → Make group;
 * a group shows its band word, "Split?", its status; band A: the one quote then Make PO; bands B/C: Make RFQ with the
 * suppliers ticked), RFQs (Send RFQ is the person's tap: it records the send and hands over the PDFs; Confirm quote per
 * supplier), Comparisons (the comparative: columns per supplier, rows per line, L1/L2/L3 as words, fixed layout so 3 × 10
 * fits with no sideways scroll; Propose award, a reason when not L1), Awards (status words, Make PO), POs (Submit PO,
 * Send PO; every PO says "Pay after GRN"). Every status is a word; loading is grey rows with no text; a refusal is the
 * server's code as a few words.
 *
 * S5c (#1115): the buyer agent's drafts sit beside the buyer's own work and wait for a tap — the night's groups on
 * Grouping (Make group / Not this), "Draft by agent" for an RFQ (suppliers ticked best first, nothing sent) or a band A
 * PO, "Read PDF" for a supplier's quotation (Quote entry: the PDF on the left, the draft lines on the right, each with
 * the line of text it came from; Confirm line per line). "One supplier" asks for a single-source or emergency purchase;
 * a PO can ask for an equipment advance. Phone sheets: `?exception=` (certify / approve / confirm) and, on `?po=`, the
 * advance for the owner.
 */
type Tab = "buyNow" | "grouping" | "rfqs" | "comparisons" | "awards" | "pos";
const TABS: Tab[] = ["buyNow", "grouping", "rfqs", "comparisons", "awards", "pos"];

const page: React.CSSProperties = {
  maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", padding: "12px 16px 24px", display: "flex", flexDirection: "column", gap: 10,
  background: "var(--paper, #fff)", minHeight: "100%",
};
const btn: React.CSSProperties = { minHeight: 40, padding: "0 12px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent", color: "var(--ink, #222)", flexShrink: 0 };
const primary: React.CSSProperties = { ...btn, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 600 };
const word: React.CSSProperties = { flexShrink: 0, fontWeight: 600, padding: "2px 8px", borderRadius: 10, border: "1px solid var(--ink, #222)", fontSize: 13, whiteSpace: "nowrap" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "6px 0", borderBottom: "1px solid var(--rule, #e3e3e3)", minWidth: 0 };
const cut: React.CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const th: React.CSSProperties = { textAlign: "left", padding: "4px 6px", borderBottom: "2px solid var(--ink, #222)", fontSize: 13, ...cut };
const td: React.CSSProperties = { padding: "4px 6px", borderBottom: "1px solid var(--rule, #e3e3e3)", fontSize: 13, ...cut };
const input: React.CSSProperties = { minHeight: 40, minWidth: 0, boxSizing: "border-box" };

const money = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const rupeesToPaise = (s: string): number => Math.round(Number(s) * 100);

function GreyRows({ n = 3 }: { n?: number }): React.ReactElement {
  return <div aria-busy="true">{Array.from({ length: n }, (_, i) => <div key={i} aria-hidden="true" style={{ height: 40, background: "var(--rule, #eee)", borderRadius: 4, marginBottom: 6 }} />)}</div>;
}

function Notice({ n }: { n: { text: string; ok: boolean } | null }): React.ReactElement | null {
  if (n === null) return null;
  return (
    <p role="status" data-tone={n.ok ? "ok" : "refused"} style={{
      margin: 0, fontWeight: 700, fontSize: 16, padding: "6px 10px", borderRadius: 6,
      borderLeft: `6px solid ${n.ok ? "var(--state-settled, #1a7f37)" : "var(--state-danger, #b42318)"}`, background: "var(--line, #eef2ef)",
    }}>{n.text}</p>
  );
}

function useRefusal(): (e: unknown) => string {
  const { t } = useTranslation();
  return (e) => {
    if (!(e instanceof ApiError)) return t("stores.ticket.offline");
    const code = storesErrorCode(e);
    return code === null ? t("stores.err.failed") : t(`stores.err.${code}`, { defaultValue: t("stores.err.failed") });
  };
}

function Band({ band }: { band: StoresBand }): React.ReactElement {
  const { t } = useTranslation();
  return <span data-band={band} style={{ ...word, borderStyle: band === "C" ? "double" : "solid", borderWidth: band === "C" ? 3 : 1 }}>{t(`stores.buy.band.${band}`)}</span>;
}
const Word = ({ text }: { text: string }): React.ReactElement => <span style={word}>{text}</span>;

/** One act's button: runs, says the outcome in a few words, refreshes the desk. */
function useAct(): { busy: boolean; note: { text: string; ok: boolean } | null; run: (f: () => Promise<unknown>, done: string) => Promise<boolean> } {
  const qc = useQueryClient();
  const refused = useRefusal();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  return {
    busy, note,
    run: async (f, done) => {
      setBusy(true);
      try { await f(); setNote({ text: done, ok: true }); await qc.invalidateQueries({ queryKey: ["stores-buying"] }); return true; }
      catch (e) { setNote({ text: refused(e), ok: false }); return false; }
      finally { setBusy(false); }
    },
  };
}

export function StoresBuying(): React.ReactElement {
  const { t } = useTranslation();
  const search = useSearch({ strict: false }) as { award?: string; po?: string; tab?: string; exception?: string; quote?: string };
  const [tab, setTab] = useState<Tab>(TABS.includes(search.tab as Tab) ? (search.tab as Tab) : "buyNow");
  if (search.award !== undefined) return <div className="stores-ui" data-testid="stores-buying" style={page}><AwardSheet id={search.award} /></div>;
  if (search.po !== undefined) return <div className="stores-ui" data-testid="stores-buying" style={page}><PoSheet id={search.po} /></div>;
  if (search.exception !== undefined) return <div className="stores-ui" data-testid="stores-buying" style={page}><ExceptionSheet id={search.exception} /></div>;
  return (
    <div className="stores-ui" data-testid="stores-buying" style={page}>
      <h1 style={{ margin: 0, fontSize: 20 }}>{t("stores.buying.title")}</h1>
      <div role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {TABS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} style={tab === k ? primary : btn} onClick={() => setTab(k)}>{t(`stores.buying.tab.${k}`)}</button>
        ))}
      </div>
      <Desk tab={tab} />
    </div>
  );
}

function Desk({ tab }: { tab: Tab }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-buying", "desk"], queryFn: buyingDesk });
  if (q.isPending) return <GreyRows />;
  if (q.isError) return <Notice n={{ text: t("stores.buying.notYours"), ok: false }} />;
  const d: WireBuyingDesk = q.data;
  switch (tab) {
    case "buyNow": return <BuyNow rows={d.buyNow} />;
    case "grouping": return <Grouping desk={d} />;
    case "rfqs": return <Rfqs rfqs={d.rfqs} reads={(d.proposals ?? []).filter((p) => p.kind === "quote_read")} />;
    case "comparisons": return <Comparisons rfqs={d.rfqs.filter((r) => r.status !== "drafted")} />;
    case "awards": return <Awards awards={d.awards} buyer={d.can.buy} />;
    case "pos": return <Pos pos={d.pos} />;
  }
}

/* ─────────────── Buy now ─────────────── */

function BuyNow({ rows }: { rows: WireBuyRow[] }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  if (rows.length === 0) return <p>{t("stores.buying.empty")}</p>;
  return (
    <div>
      <Notice n={act.note} />
      {rows.map((r) => (
        <div key={r.prId} style={row} data-testid={`buynow-${r.prId}`}>
          <strong>{r.prNo}</strong>
          <Word text={t(`stores.buy.priority.${r.priority}`)} />
          <Band band={r.band} />
          <Word text={t(`stores.buying.stage.${r.status}`)} />
          <span style={{ ...cut, flex: 1 }}>{r.department?.name ?? t("stores.buying.centralStore")} · {r.lines.map((l) => `${l.itemName} × ${String(l.qtyBase)}`).join(", ")}</span>
          <span>{money(r.estimatePaise)}</span>
          {r.lines.some((l) => l.groupId === null) && (
            <button type="button" style={primary} disabled={act.busy}
              onClick={() => void act.run(() => groupLines(r.lines.filter((l) => l.groupId === null).map((l) => ({ prId: l.prId, lineIdx: l.lineIdx }))), t("stores.buying.grouped"))}>
              {t("stores.buying.makeGroup")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─────────────── Grouping ─────────────── */

function Grouping({ desk }: { desk: WireBuyingDesk }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const [ticked, setTicked] = useState<string[]>([]);
  const key = (prId: string, lineIdx: number): string => `${prId}:${String(lineIdx)}`;
  const lines = desk.groupable.flatMap((r) => r.lines.map((l) => ({ r, l })));
  const open = desk.groups.filter((g) => g.awardId === null);
  const narrow = typeof window !== "undefined" && window.innerWidth < 900;
  const drafts = (desk.proposals ?? []).filter((p) => p.kind === "grouping");
  return (
    <div style={{ display: "grid", gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "minmax(0, 1fr) minmax(0, 2fr)", gap: 16 }}>
      <section style={{ minWidth: 0 }}>
        {drafts.length > 0 && <AgentGroups drafts={drafts} />}
        <h2 style={{ fontSize: 16, margin: "4px 0" }}>{t("stores.buying.toGroup")}</h2>
        {lines.length === 0 && <p>{t("stores.buying.empty")}</p>}
        {lines.map(({ r, l }) => (
          <label key={key(l.prId, l.lineIdx)} style={row}>
            <input type="checkbox" checked={ticked.includes(key(l.prId, l.lineIdx))}
              onChange={(e) => setTicked(e.target.checked ? [...ticked, key(l.prId, l.lineIdx)] : ticked.filter((x) => x !== key(l.prId, l.lineIdx)))} />
            <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{l.itemName} × {l.qtyBase}</span>
            <span>{r.prNo}</span>
            <Band band={r.band} />
          </label>
        ))}
        <Notice n={act.note} />
        <button type="button" style={primary} disabled={act.busy || ticked.length === 0}
          onClick={() => void act.run(async () => {
            await groupLines(ticked.map((k) => { const [prId, i] = k.split(":"); return { prId: prId!, lineIdx: Number(i) }; }));
            setTicked([]);
          }, t("stores.buying.grouped"))}>{t("stores.buying.makeGroup")}</button>
      </section>
      <section style={{ minWidth: 0 }}>
        <h2 style={{ fontSize: 16, margin: "4px 0" }}>{t("stores.buying.groups")}</h2>
        {open.length === 0 && <p>{t("stores.buying.noGroups")}</p>}
        {open.map((g) => <GroupCard key={g.id} g={g} exception={(desk.exceptions ?? []).find((e) => e.groupId === g.id && e.status !== "refused") ?? null} />)}
      </section>
    </div>
  );
}

function useSuppliers(): WireStoresSupplier[] {
  const q = useQuery({ queryKey: ["stores-buying", "suppliers"], queryFn: suppliers });
  return q.data?.suppliers ?? [];
}

function GroupCard({ g, exception }: { g: WireBuyGroup; exception: WireBuyException | null }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const [open, setOpen] = useState(false);
  const [one, setOne] = useState(false);
  const bought = exception !== null && ["approved", "confirmed", "overdue"].includes(exception.status);
  return (
    <div style={{ borderTop: "2px solid var(--ink, #222)", padding: "6px 0", display: "flex", flexDirection: "column", gap: 6 }} data-testid={`group-${g.id}`}>
      <div style={row}>
        <Band band={g.band} />
        {g.split && <Word text={t("stores.buy.split")} />}
        <Word text={t(`stores.buying.stage.${g.status}`)} />
        <strong>{money(g.estimatePaise)}</strong>
        <span style={{ flex: 1 }} />
        {exception !== null && <Word text={`${t(`stores.buying.exception.${exception.kind}`)} · ${t(`stores.buying.exceptionStatus.${exception.status}`)}`} />}
        {g.rfqId === null && g.band !== "A" && exception === null && g.awardId === null && (
          <button type="button" style={btn} onClick={() => setOne(!one)}>{t("stores.buying.oneSupplier")}</button>
        )}
        {g.rfqId === null && !(exception !== null && !bought) && (
          <button type="button" style={primary} onClick={() => setOpen(!open)}>{g.band === "A" || bought ? t("stores.buying.makePo") : t("stores.buying.makeRfq")}</button>
        )}
      </div>
      {g.lines.map((l) => (
        <div key={`${l.prId}:${String(l.lineIdx)}`} style={row}>
          <span style={{ flex: "1 1 12em", minWidth: 0, overflowWrap: "anywhere" }}>{l.itemName} × {l.qtyBase} {l.baseUom}</span>
          <span>{money(l.estimatePaise)}</span>
          {g.rfqId === null && (
            <button type="button" style={btn} disabled={act.busy}
              onClick={() => void act.run(() => moveLine({ prId: l.prId, lineIdx: l.lineIdx, toGroupId: null }), t("stores.buying.movedOut"))}>{t("stores.buying.takeOut")}</button>
          )}
        </div>
      ))}
      <Notice n={act.note} />
      {one && <ExceptionMaker g={g} onDone={() => setOne(false)} />}
      {open && (g.band === "A" || bought ? <BandAQuote g={g} onlyVendor={bought ? exception.vendorId : null} /> : <RfqMaker g={g} />)}
    </div>
  );
}

/** Band A: the one quote (or a live rate contract), then Make PO; a reason when more than 2 % above the last price. */
function BandAQuote({ g, onlyVendor = null }: { g: WireBuyGroup; onlyVendor?: string | null }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const list = useSuppliers().filter((s) => s.kyc.level === "complete" && (onlyVendor === null || s.id === onlyVendor));
  const [vendorId, setVendorId] = useState(onlyVendor ?? "");
  const [draft, setDraft] = useState<WireAgentProposal | null>(null);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const items = [...new Map(g.lines.map((l) => [l.itemId, l])).values()];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {draft === null && (
        <>
          <label style={row}>{t("stores.buying.supplier")}
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} style={input}>
              <option value="">—</option>
              {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          {items.map((l) => (
            <label key={l.itemId} style={row}><span style={{ ...cut, flex: 1 }}>{l.itemName}</span>{t("stores.buying.rate")}
              <input inputMode="decimal" style={{ ...input, width: 110 }} value={rates[l.itemId] ?? ""} onChange={(e) => setRates({ ...rates, [l.itemId]: e.target.value })} />
            </label>
          ))}
        </>
      )}
      <label style={row}>{t("stores.buying.reason")}<input style={{ ...input, flex: 1 }} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <Notice n={act.note} />
      <div style={row}>
        {draft === null && <button type="button" style={btn} disabled={act.busy || vendorId === ""}
          onClick={() => void act.run(() => enterQuote({ groupId: g.id, vendorId, lines: items.filter((l) => rates[l.itemId]).map((l) => ({ itemId: l.itemId, ratePaise: rupeesToPaise(rates[l.itemId]!) })) }), t("stores.buying.quoteSaved"))}>
          {t("stores.buying.confirmQuote")}
        </button>}
        {onlyVendor === null && draft === null && (
          <button type="button" style={btn} disabled={act.busy} onClick={() => void act.run(async () => { setDraft(await draftPo(g.id)); }, t("stores.buying.agent.drafted"))}>
            {t("stores.buying.agent.draft")}
          </button>
        )}
        <button type="button" style={primary} disabled={act.busy}
          onClick={() => void act.run(() => (draft !== null ? confirmPoDraft(draft.id, reason.trim() || null) : poFromGroup(g.id, reason.trim() || null)), t("stores.buying.poMade"))}>
          {t("stores.buying.makePo")}
        </button>
      </div>
      {draft !== null && (
        <div data-testid="po-draft" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 700 }}>{t("stores.buying.agent.poDraft")}</span>
          {draft.lines.map((l) => (
            <div key={l.itemId} style={row}>
              <span style={{ ...cut, flex: 1 }}>{l.itemName} × {l.qtyBase}</span>
              <span>{l.ratePaise === null ? "—" : money(l.ratePaise)}</span>
              <Word text={l.source?.text === "Rate contract" ? t("stores.buying.agent.viaContract") : t("stores.buying.agent.viaQuote")} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Bands B/C: tick at least three suppliers that can quote, a reply-by date, Make RFQ (nothing is sent yet). */
function RfqMaker({ g }: { g: WireBuyGroup }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const own = useSuppliers().filter((s) => s.kyc.level !== "none");
  const [ticked, setTicked] = useState<string[]>([]);
  const [replyBy, setReplyBy] = useState("");
  const [draft, setDraft] = useState<WireAgentProposal | null>(null);
  const list = draft === null ? own.map((s) => ({ id: s.id, name: s.name, kyc: s.kyc.level, approved: null as boolean | null, score: null as number | null }))
    : draft.suppliers.map((s) => ({ id: s.vendorId, name: s.name, kyc: s.kyc, approved: s.approvedForCategory, score: s.score }));
  const useDraft = async (): Promise<void> => {
    const d = await draftRfq(g.id);
    setDraft(d);
    setTicked(d.suppliers.filter((s) => s.suggested).map((s) => s.vendorId));
    if (d.replyBy !== null) setReplyBy(new Date(d.replyBy).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {draft === null && (
        <button type="button" style={{ ...btn, alignSelf: "flex-start" }} disabled={act.busy} onClick={() => void act.run(useDraft, t("stores.buying.agent.drafted"))}>
          {t("stores.buying.agent.draft")}
        </button>
      )}
      {draft !== null && <span style={{ fontWeight: 700 }}>{t("stores.buying.agent.rfqDraft")}</span>}
      {list.map((s) => (
        <label key={s.id} style={row}>
          <input type="checkbox" checked={ticked.includes(s.id)} onChange={(e) => setTicked(e.target.checked ? [...ticked, s.id] : ticked.filter((x) => x !== s.id))} />
          <span style={{ ...cut, flex: 1 }}>{s.name}</span>
          <Word text={t(`stores.buying.kyc.${s.kyc}`)} />
          {s.approved === false && <Word text={t("stores.buying.agent.notApproved")} />}
          {s.score !== null && <ScoreWords vendorId={s.id} />}
        </label>
      ))}
      <label style={row}>{t("stores.buying.replyBy")}<input type="date" style={input} value={replyBy} onChange={(e) => setReplyBy(e.target.value)} /></label>
      <Notice n={act.note} />
      <button type="button" style={primary} disabled={act.busy || replyBy === "" || (g.band !== "A" && ticked.length < 3)}
        onClick={() => void act.run(() => (draft !== null
          ? confirmRfqDraft(draft.id, { vendorIds: ticked, replyBy: new Date(`${replyBy}T11:30:00Z`).toISOString(), deliveryDate: draft.deliveryDate })
          : makeRfq({ groupId: g.id, replyBy: new Date(`${replyBy}T12:30:00Z`).toISOString(), vendorIds: ticked })), t("stores.buying.rfqMade"))}>
        {t("stores.buying.makeRfq")}
      </button>
      {g.band !== "A" && ticked.length < 3 && <span>{t("stores.err.three_quotes_needed")}</span>}
    </div>
  );
}

/* ─────────────── RFQs ─────────────── */

function Rfqs({ rfqs, reads }: { rfqs: WireRfq[]; reads: WireAgentProposal[] }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  if (open !== null) return <QuoteRead id={open} onClose={() => setOpen(null)} />;
  if (rfqs.length === 0 && reads.length === 0) return <p>{t("stores.buying.noRfqs")}</p>;
  return (
    <div>
      {reads.length > 0 && (
        <section data-testid="quote-reads" style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 8 }}>
          <h2 style={{ fontSize: 16, margin: "4px 0" }}>{t("stores.buying.agent.toConfirm")}</h2>
          {reads.map((p) => (
            <div key={p.id} style={row}>
              <strong style={{ ...cut, flex: 1 }}>{p.vendorName ?? "—"}</strong>
              <span>{t("stores.buying.agent.linesLeft", { n: p.lines.filter((l) => l.state === "draft").length, m: p.lines.length })}</span>
              <button type="button" style={primary} onClick={() => setOpen(p.id)}>{t("stores.buying.open")}</button>
            </div>
          ))}
        </section>
      )}
      {rfqs.map((r) => <RfqCard key={r.id} r={r} onRead={setOpen} />)}
    </div>
  );
}

function RfqCard({ r, onRead }: { r: WireRfq; onRead: (proposalId: string) => void }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const act = useAct();
  const [channel, setChannel] = useState<"email" | "print" | "hand">("email");
  const [quoting, setQuoting] = useState<string | null>(null);
  const day = new Date(r.replyBy).toLocaleDateString(i18n.language === "hi" ? "hi-IN" : "en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  return (
    <div style={{ borderTop: "2px solid var(--ink, #222)", padding: "6px 0" }} data-testid={`rfq-${r.id}`}>
      <div style={row}>
        <strong>{r.rfqNo}</strong><Band band={r.band} /><Word text={t(`stores.buying.rfqStatus.${r.status}`)} />
        <span>{t("stores.buying.replyBy")} {day}</span>
        <span>{t("stores.buying.received", { n: r.received, m: r.invitees.length })}</span>
        <span style={{ flex: 1 }} />
        {r.status === "drafted" && (
          <>
            <select aria-label={t("stores.buying.channel")} value={channel} onChange={(e) => setChannel(e.target.value as "email" | "print" | "hand")} style={input}>
              {(["email", "print", "hand"] as const).map((c) => <option key={c} value={c}>{t(`stores.buying.via.${c}`)}</option>)}
            </select>
            <button type="button" style={primary} disabled={act.busy} onClick={() => void act.run(() => sendRfq(r.id, channel), t("stores.buying.rfqSent"))}>{t("stores.buying.sendRfq")}</button>
          </>
        )}
      </div>
      <div style={{ ...cut }}>{r.lines.map((l) => `${l.itemName} × ${String(l.qtyBase)}`).join(", ")}</div>
      {r.invitees.map((i) => (
        <div key={i.vendorId} style={row}>
          <span style={{ ...cut, flex: 1 }}>{i.name}</span>
          <Word text={t(`stores.buying.kyc.${i.kyc}`)} />
          <Word text={i.quoted ? t("stores.buying.quoted") : t("stores.buying.waiting")} />
          {r.sent !== null && <a href={`/api/stores/rfqs/${encodeURIComponent(r.id)}/print?vendorId=${encodeURIComponent(i.vendorId)}`} target="_blank" rel="noreferrer">{t("stores.buying.pdf")}</a>}
          {r.sent !== null && r.status !== "closed" && <button type="button" style={btn} onClick={() => setQuoting(quoting === i.vendorId ? null : i.vendorId)}>{t("stores.buying.enterQuote")}</button>}
          {r.sent !== null && r.status !== "closed" && !i.quoted && <PdfPicker rfqId={r.id} vendorId={i.vendorId} onRead={onRead} />}
          <ScoreWords vendorId={i.vendorId} />
        </div>
      ))}
      <Notice n={act.note} />
      {quoting !== null && <QuoteEntry r={r} vendorId={quoting} onDone={() => setQuoting(null)} />}
    </div>
  );
}

/** Quote entry: rate, discount %, GST % per line, freight and other; Confirm quote. */
function QuoteEntry({ r, vendorId, onDone }: { r: WireRfq; vendorId: string; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const [v, setV] = useState<Record<string, { rate: string; disc: string; gst: string }>>({});
  const [freight, setFreight] = useState("");
  const [other, setOther] = useState("");
  const set = (itemId: string, k: "rate" | "disc" | "gst", x: string): void => setV({ ...v, [itemId]: { rate: "", disc: "", gst: "", ...v[itemId], [k]: x } });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 12 }}>
      {r.lines.map((l) => (
        <div key={l.itemId} style={row}>
          <span style={{ ...cut, flex: 1 }}>{l.itemName} × {l.qtyBase}</span>
          <input aria-label={t("stores.buying.rate")} placeholder={t("stores.buying.rate")} inputMode="decimal" style={{ ...input, width: 100 }} value={v[l.itemId]?.rate ?? ""} onChange={(e) => set(l.itemId, "rate", e.target.value)} />
          <input aria-label={t("stores.buying.discount")} placeholder={t("stores.buying.discount")} inputMode="decimal" style={{ ...input, width: 70 }} value={v[l.itemId]?.disc ?? ""} onChange={(e) => set(l.itemId, "disc", e.target.value)} />
          <input aria-label={t("stores.buying.gst")} placeholder={t("stores.buying.gst")} inputMode="decimal" style={{ ...input, width: 70 }} value={v[l.itemId]?.gst ?? ""} onChange={(e) => set(l.itemId, "gst", e.target.value)} />
        </div>
      ))}
      <div style={row}>
        <input aria-label={t("stores.buying.freight")} placeholder={t("stores.buying.freight")} inputMode="decimal" style={{ ...input, width: 110 }} value={freight} onChange={(e) => setFreight(e.target.value)} />
        <input aria-label={t("stores.buying.other")} placeholder={t("stores.buying.other")} inputMode="decimal" style={{ ...input, width: 110 }} value={other} onChange={(e) => setOther(e.target.value)} />
        <button type="button" style={primary} disabled={act.busy} onClick={() => void act.run(async () => {
          await enterQuote({
            rfqId: r.id, vendorId, freightPaise: freight === "" ? 0 : rupeesToPaise(freight), otherPaise: other === "" ? 0 : rupeesToPaise(other),
            lines: r.lines.filter((l) => (v[l.itemId]?.rate ?? "") !== "").map((l) => ({
              itemId: l.itemId, ratePaise: rupeesToPaise(v[l.itemId]!.rate),
              ...(v[l.itemId]!.disc === "" ? {} : { discountBps: Math.round(Number(v[l.itemId]!.disc) * 100) }),
              ...(v[l.itemId]!.gst === "" ? {} : { gstRateBps: Math.round(Number(v[l.itemId]!.gst) * 100) }),
            })),
          });
          onDone();
        }, t("stores.buying.quoteSaved"))}>{t("stores.buying.confirmQuote")}</button>
      </div>
      <Notice n={act.note} />
    </div>
  );
}

/* ─────────────── Comparisons ─────────────── */

function Comparisons({ rfqs }: { rfqs: WireRfq[] }): React.ReactElement {
  const { t } = useTranslation();
  const [pick, setPick] = useState<string | null>(null);
  if (rfqs.length === 0) return <p>{t("stores.buying.noRfqs")}</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {rfqs.map((r) => (
          <button key={r.id} type="button" style={pick === r.id ? primary : btn} onClick={() => setPick(r.id)}>
            {r.rfqNo} <span style={{ ...word, marginLeft: 6 }}>{t(`stores.buying.rfqStatus.${r.status}`)}</span>
          </button>
        ))}
      </div>
      {pick !== null && <Comparative rfqId={pick} />}
    </div>
  );
}

function Comparative({ rfqId }: { rfqId: string }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const q = useQuery({ queryKey: ["stores-buying", "cmp", rfqId], queryFn: () => comparative(rfqId) });
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  if (q.isPending) return <GreyRows n={5} />;
  if (q.isError) return <Notice n={{ text: t("stores.buying.notYours"), ok: false }} />;
  const c: WireComparative = q.data;
  if (c.sealed) return <p data-testid="comparative-sealed" style={{ fontWeight: 700 }}>{t("stores.buying.received", { n: c.received, m: c.invited })}</p>;
  const l1 = c.suppliers.find((s) => s.wholeRank === 1)?.vendorId ?? null;
  const chosen = vendorId ?? l1;
  const rank = (r: number | null): string => (r === null ? "—" : `L${String(r)}`);
  return (
    <div data-testid="comparative-box" style={{ overflowX: "hidden", maxWidth: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
      {c.reinvite && <Word text={t("stores.buying.reinvite")} />}
      <table data-testid="comparative-table" style={{ tableLayout: "fixed", width: "100%", borderCollapse: "collapse" }}>
        <colgroup><col style={{ width: "26%" }} /><col style={{ width: "6%" }} />{c.suppliers.map((s) => <col key={s.vendorId} />)}</colgroup>
        <thead>
          <tr>
            <th style={th}>{t("stores.buying.item")}</th><th style={th}>{t("stores.buying.qty")}</th>
            {c.suppliers.map((s) => (
              <th key={s.vendorId} style={th} title={s.name}>
                {s.name}{s.late && <> · {t("stores.buying.late")}</>}{s.kind === "negotiated" && <> · {t("stores.buying.negotiated")}</>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {c.lines.map((l, i) => (
            <tr key={l.itemId} data-testid={`cmp-line-${String(i)}`}>
              <td style={td} title={l.itemName}>{l.itemName}</td><td style={td}>{l.qtyBase}</td>
              {c.suppliers.map((s) => {
                const cell = l.cells.find((x) => x.vendorId === s.vendorId);
                return (
                  <td key={s.vendorId} style={td}>
                    {cell === undefined ? "—" : <>{money(cell.landedPaise)} <span style={{ fontWeight: 700 }}>{rank(cell.rank)}</span></>}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr>
            <td style={{ ...td, fontWeight: 700 }}>{t("stores.buying.landed")}</td><td style={td} />
            {c.suppliers.map((s) => <td key={s.vendorId} style={{ ...td, fontWeight: 700 }}>{money(s.totals.landedPaise)} {rank(s.wholeRank)}</td>)}
          </tr>
          <tr>
            <td style={td}>{t("stores.buying.beforeGst")}</td><td style={td} />
            {c.suppliers.map((s) => <td key={s.vendorId} style={td}>{money(s.totals.beforeGstPaise)}</td>)}
          </tr>
          <tr>
            <td style={td}>{t("stores.buying.terms")}</td><td style={td} />
            {c.suppliers.map((s) => (
              <td key={s.vendorId} style={td}>
                {s.paymentTermsDays ?? "—"} / {s.deliveryDays ?? "—"}
                {s.technical !== null && <> · {t(`stores.buying.technical.${s.technical}`)}</>}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <div style={row}>
        <label style={row}>{t("stores.buying.supplier")}
          <select value={chosen ?? ""} onChange={(e) => setVendorId(e.target.value)} style={input}>
            {c.suppliers.filter((s) => s.wholeRank !== null).map((s) => <option key={s.vendorId} value={s.vendorId}>{s.name} · {rank(s.wholeRank)}</option>)}
          </select>
        </label>
        {chosen !== l1 && <input aria-label={t("stores.buying.reason")} placeholder={t("stores.buying.reasonNeeded")} style={{ ...input, flex: 1 }} value={reason} onChange={(e) => setReason(e.target.value)} />}
        <button type="button" style={primary} disabled={act.busy || chosen === null}
          onClick={() => void act.run(() => proposeAward({ rfqId, vendorId: chosen!, reason: reason.trim() || null }), t("stores.buying.proposed"))}>{t("stores.buying.proposeAward")}</button>
      </div>
      <Notice n={act.note} />
    </div>
  );
}

/* ─────────────── Awards and POs ─────────────── */

function Awards({ awards, buyer }: { awards: WireAward[]; buyer: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  if (awards.length === 0) return <p>{t("stores.buying.noAwards")}</p>;
  return (
    <div>
      <Notice n={act.note} />
      {awards.map((a) => (
        <div key={a.id} style={row} data-testid={`award-${a.id}`}>
          <strong>{a.rfqNo ?? t("stores.buying.oneQuote")}</strong><Band band={a.band} /><Word text={t(`stores.buying.awardStatus.${a.status}`)} />
          <span style={{ ...cut, flex: 1 }}>{[...new Set(a.lines.map((l) => l.vendorName))].join(", ")}</span>
          <span>{money(a.totalPaise)}</span>
          {a.band === "C" && <span>{t("stores.buying.signed", { n: a.seats.filter((s) => s.signedBy !== null && s.kind !== "object").length, m: a.seats.length })}</span>}
          {a.mine !== null && <a href={`/stores/buying?award=${encodeURIComponent(a.id)}`} style={{ ...btn, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>{t("stores.buying.open")}</a>}
          {buyer && a.status !== "sent_back" && a.poIds.length === 0 && (
            <button type="button" style={primary} disabled={act.busy} onClick={() => void act.run(() => poFromAward(a.id), t("stores.buying.poMade"))}>{t("stores.buying.makePo")}</button>
          )}
        </div>
      ))}
    </div>
  );
}

function Pos({ pos }: { pos: WireStoresPoRow[] }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const [advanceFor, setAdvanceFor] = useState<string | null>(null);
  if (pos.length === 0) return <p>{t("stores.buying.noPos")}</p>;
  return (
    <div>
      <Notice n={act.note} />
      {pos.map((p) => (
        <div key={p.id} style={row} data-testid={`po-${p.id}`}>
          <strong>{p.poNo}</strong><Word text={t(`stores.buying.poStatus.${p.status}`, { defaultValue: p.status })} />
          <span style={{ ...cut, flex: 1 }}>{p.vendorName}</span>
          <span>{money(p.totalPaise)}</span>
          <Word text={t("stores.buying.payAfterGrn")} />
          {!["cancelled", "received"].includes(p.status) && (
            <button type="button" style={btn} onClick={() => setAdvanceFor(advanceFor === p.id ? null : p.id)}>{t("stores.buying.advance.ask")}</button>
          )}
          {p.status === "draft" && <button type="button" style={primary} disabled={act.busy} onClick={() => void act.run(() => submitPo(p.id), t("stores.buying.submitted"))}>{t("stores.buying.submitPo")}</button>}
          {p.status === "approved" && <button type="button" style={primary} disabled={act.busy} onClick={() => void act.run(() => sendPo(p.id), t("stores.buying.poSent"))}>{t("stores.buying.sendPo")}</button>}
          {advanceFor === p.id && <AdvanceForm poId={p.id} onDone={() => setAdvanceFor(null)} />}
        </div>
      ))}
    </div>
  );
}

/* ─────────────── the phone sheets (from a notice) ─────────────── */

const sheet: React.CSSProperties = { maxWidth: "100%", overflowX: "hidden", display: "flex", flexDirection: "column", gap: 8, boxSizing: "border-box" };
const kv: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--rule, #e3e3e3)", minWidth: 0 };
const big: React.CSSProperties = { ...primary, minHeight: 52, width: "100%", fontSize: 18 };

function Kv({ k, v }: { k: string; v: React.ReactNode }): React.ReactElement {
  return (
    <div style={kv}>
      <span style={{ flexShrink: 0, opacity: 0.72 }}>{k}</span>
      <span style={{ minWidth: 0, fontWeight: 600, textAlign: "right", overflowWrap: "anywhere" }}>{v}</span>
    </div>
  );
}

function AwardSheet({ id }: { id: string }): React.ReactElement {
  const { t } = useTranslation();
  const refused = useRefusal();
  const q = useQuery({ queryKey: ["stores-buying", "award", id], queryFn: () => getAward(id) });
  const [after, setAfter] = useState<WireAward | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [objecting, setObjecting] = useState(false);
  const [reason, setReason] = useState("");
  if (q.isPending) return <GreyRows />;
  if (q.isError) return <Notice n={{ text: refused(q.error), ok: false }} />;
  const a = after ?? q.data;
  const vendors = [...new Set(a.lines.map((l) => l.vendorName))].join(", ");
  const ranks = [...new Set(a.lines.map((l) => (l.rank === null ? null : `L${String(l.rank)}`)).filter((x): x is string => x !== null))].join(", ");
  const label = a.mine?.seat === "owner" || a.band !== "C" ? t("stores.buying.approve") : t("stores.buying.sign");
  const act = async (f: () => Promise<WireAward>): Promise<void> => {
    try { const r = await f(); setAfter(r); setNote(null); } catch (e) { setNote({ text: refused(e), ok: false }); }
  };
  return (
    <div data-testid="approve-sheet" style={sheet}>
      <h1 style={{ margin: 0, fontSize: 18 }}>{a.rfqNo ?? t("stores.buying.oneQuote")}</h1>
      <Kv k={t("stores.buying.value")} v={money(a.totalPaise)} />
      <Kv k={t("stores.buying.band")} v={<Band band={a.band} />} />
      <Kv k={t("stores.buying.supplier")} v={vendors} />
      <Kv k={t("stores.buying.rank")} v={ranks || "—"} />
      {a.reason !== null && <Kv k={t("stores.buying.reason")} v={a.reason} />}
      {a.band === "C" && <Kv k={t("stores.buying.seats")} v={t("stores.buying.signed", { n: a.seats.filter((s) => s.signedBy !== null && s.kind !== "object").length, m: a.seats.length })} />}
      <Notice n={note} />
      {a.status !== "proposed" ? (
        <p style={{ margin: 0, fontWeight: 700, fontSize: 18 }}>{t(`stores.buying.awardStatus.${a.status}`)}</p>
      ) : after !== null && a.mine === null ? (
        <p style={{ margin: 0, fontWeight: 700, fontSize: 18 }}>{t("stores.buying.signedDone")}</p>
      ) : a.mine === null ? (
        <p style={{ margin: 0 }}>{t("stores.buying.notYours")}</p>
      ) : !a.mine.canSign ? (
        <p style={{ margin: 0 }}>{t("stores.err.awaiting_seats")}</p>
      ) : (
        <>
          <button type="button" style={big} onClick={() => void act(() => approveAward(a.id))}>{label}</button>
          {!objecting && <button type="button" style={btn} onClick={() => setObjecting(true)}>{t("stores.buying.object")}</button>}
          {objecting && (
            <div style={{ display: "flex", gap: 6 }}>
              <input aria-label={t("stores.buying.reason")} placeholder={t("stores.buying.reasonNeeded")} style={{ ...input, flex: 1 }} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button type="button" style={primary} disabled={reason.trim() === ""} onClick={() => void act(() => objectAward(a.id, reason))}>{t("stores.buying.object")}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PoSheet({ id }: { id: string }): React.ReactElement {
  const { t } = useTranslation();
  const refused = useRefusal();
  const q = useQuery({ queryKey: ["stores-buying", "po", id], queryFn: () => poSheet(id) });
  const [after, setAfter] = useState<WireStoresPoSheet | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  if (q.isPending) return <GreyRows />;
  if (q.isError) return <Notice n={{ text: refused(q.error), ok: false }} />;
  const p = after ?? q.data;
  return (
    <div data-testid="approve-sheet" style={sheet}>
      <h1 style={{ margin: 0, fontSize: 18 }}>{p.poNo}</h1>
      <Kv k={t("stores.buying.value")} v={money(p.totalPaise)} />
      {p.band !== null && <Kv k={t("stores.buying.band")} v={<Band band={p.band} />} />}
      <Kv k={t("stores.buying.supplier")} v={p.vendorName} />
      <Kv k={t("stores.buying.rank")} v={p.rank === null ? "—" : `L${String(p.rank)}`} />
      {p.reason !== null && <Kv k={t("stores.buying.reason")} v={p.reason} />}
      <Kv k={t("stores.buying.tier")} v={t(p.tier === "owner" ? "stores.buying.ownerTier" : "stores.buying.headTier")} />
      {p.advance != null && p.advance.status === "requested" && <Kv k={t("stores.buying.advance.poStatus")} v={t(`stores.buying.poStatus.${p.status}`, { defaultValue: p.status })} />}
      <Kv k={t("stores.buying.advance.terms")} v={p.payTerms?.kind === "advance" ? t("stores.buying.advance.approvedWord", { pct: p.payTerms.pctBps / 100 }) : t("stores.buying.payAfterGrn")} />
      {p.advance != null && p.advance.status === "requested" && <AdvanceDecision a={p.advance} onDone={(x) => setAfter({ ...p, advance: x, payTerms: x.status === "approved" ? { kind: "advance", pctBps: x.pctBps, amountPaise: x.amountPaise, advanceId: x.id } : p.payTerms })} />}
      <Notice n={note} />
      {p.advance != null && p.advance.status === "requested" ? null : p.status !== "pending_approval" ? (
        <p style={{ margin: 0, fontWeight: 700, fontSize: 18 }}>{t(`stores.buying.poStatus.${p.status}`, { defaultValue: p.status })}</p>
      ) : !p.canApprove ? (
        <p style={{ margin: 0 }}>{t("stores.buying.notYours")}</p>
      ) : (
        <button type="button" style={big} onClick={() => void (async () => {
          try { setAfter(await approvePoSheet(p.poId)); setNote(null); } catch (e) { setNote({ text: refused(e), ok: false }); }
        })()}>{p.canApproveBoth ? t("stores.buying.approveBoth") : t("stores.buying.approve")}</button>
      )}
    </div>
  );
}

/* ─────────────── S5c: the buyer agent's drafts ─────────────── */

/** The night's groups (the agent's preview): Make group is the buyer's tap; nothing is grouped, sent or ordered before it. */
function AgentGroups({ drafts }: { drafts: WireAgentProposal[] }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  return (
    <section data-testid="agent-groups" style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
      <h2 style={{ fontSize: 16, margin: "4px 0" }}>{t("stores.buying.agent.groups")}</h2>
      <span style={{ fontSize: 13 }}>{t("stores.buying.agent.nothingSent")}</span>
      {drafts.map((p) => (
        <div key={p.id} data-testid={`agent-group-${p.id}`} style={{ borderTop: "1px solid var(--ink, #222)", padding: "6px 0", display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={row}>
            {p.band !== null && <Band band={p.band} />}
            <strong style={{ flex: "1 1 10em", minWidth: 0, overflowWrap: "anywhere" }}>{p.vendorName === null ? `${p.label ?? ""} · ${t("stores.buying.agent.anySupplier")}` : p.label}</strong>
            <span>{money(p.estimatePaise ?? 0)}</span>
          </div>
          <span style={{ overflowWrap: "anywhere", fontSize: 13 }}>{p.lines.map((l) => `${l.itemName} × ${String(l.qtyBase)}`).join(", ")} · {p.departments.map((d) => d.name).join(", ")}</span>
          <div style={row}>
            <button type="button" style={primary} disabled={act.busy} onClick={() => void act.run(() => confirmGroupDraft(p.id), t("stores.buying.grouped"))}>{t("stores.buying.makeGroup")}</button>
            <button type="button" style={btn} disabled={act.busy} onClick={() => void act.run(() => dismissDraft(p.id, null), t("stores.buying.agent.dismissed"))}>{t("stores.buying.agent.notThis")}</button>
          </div>
        </div>
      ))}
      <Notice n={act.note} />
    </section>
  );
}

/** "Read PDF / PDF पढ़ें": the supplier's quotation, read into draft lines (nothing is a quote until each line is confirmed). */
function PdfPicker({ rfqId, vendorId, onRead }: { rfqId: string; vendorId: string; onRead: (proposalId: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const pick = (f: File | undefined): void => {
    if (f === undefined) return;
    void act.run(async () => {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const p = await readQuotePdf({ rfqId, vendorId, pdfBase64: btoa(bin) });
      onRead(p.id);
    }, t("stores.buying.agent.read"));
  };
  return (
    <>
      <label style={{ ...btn, display: "inline-flex", alignItems: "center", cursor: "pointer" }}>
        {act.busy ? t("stores.buying.agent.reading") : t("stores.buying.agent.readPdf")}
        <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      {act.note !== null && !act.note.ok && <Notice n={act.note} />}
    </>
  );
}

/** The kept PDF as a blob URL for the left pane (a data: URL's viewer cannot reach its storage), revoked on unmount. */
function useBlobUrl(b64: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (b64 === undefined || typeof URL.createObjectURL !== "function") return undefined;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const u = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    setUrl(u);
    return () => { URL.revokeObjectURL(u); };
  }, [b64]);
  return url;
}

/** Quote entry from a PDF (16:9): the PDF page on the left, the draft lines on the right, each with its source. */
function QuoteRead({ id, onClose }: { id: string; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-buying", "draft", id], queryFn: () => getDraft(id) });
  const pdf = useQuery({ queryKey: ["stores-buying", "draft-pdf", id], queryFn: () => draftPdf(id), staleTime: Infinity });
  const narrow = typeof window !== "undefined" && window.innerWidth < 900;
  const url = useBlobUrl(pdf.data?.pdfBase64);
  if (q.isPending) return <GreyRows n={4} />;
  if (q.isError) return <Notice n={{ text: t("stores.buying.notYours"), ok: false }} />;
  const p = q.data;
  return (
    <div data-testid="quote-read" style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={row}>
        <strong style={{ ...cut, flex: 1 }}>{p.vendorName ?? "—"}</strong>
        <Word text={p.reader === "model" ? t("stores.buying.agent.byAgent") : t("stores.buying.agent.byRules")} />
        <button type="button" style={btn} onClick={onClose}>{t("stores.buying.agent.back")}</button>
      </div>
      {p.readable === false && <Notice n={{ text: t("stores.buying.agent.unreadable"), ok: false }} />}
      <div style={{ display: "grid", gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
        <div style={{ minWidth: 0, minHeight: narrow ? 240 : 480, border: "1px solid var(--rule, #e3e3e3)" }}>
          {url === null ? <GreyRows n={6} /> : <iframe title={t("stores.buying.agent.pdf")} src={url} style={{ width: "100%", height: "100%", minHeight: narrow ? 240 : 480, border: 0 }} />}
        </div>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {p.lines.map((l) => <ReadLine key={l.lineIdx} p={p} lineIdx={l.lineIdx} />)}
          {p.status !== "open" && <p style={{ margin: 0, fontWeight: 700 }}>{p.status === "confirmed" ? t("stores.buying.quoteSaved") : t("stores.buying.agent.dismissed")}</p>}
        </div>
      </div>
    </div>
  );
}

function ReadLine({ p, lineIdx }: { p: WireAgentProposal; lineIdx: number }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const act = useAct();
  const l = p.lines.find((x) => x.lineIdx === lineIdx)!;
  const [rate, setRate] = useState(l.ratePaise === null ? "" : String(l.ratePaise / 100));
  const [disc, setDisc] = useState(l.discountBps === null ? "" : String(l.discountBps / 100));
  const [gst, setGst] = useState(l.gstRateBps === null ? "" : String(l.gstRateBps / 100));
  const done = l.state !== "draft";
  const go = (drop: boolean): void => void act.run(async () => {
    await confirmQuoteLine(p.id, drop ? { lineIdx, drop: true } : {
      lineIdx, ratePaise: rupeesToPaise(rate), discountBps: disc === "" ? 0 : Math.round(Number(disc) * 100), gstRateBps: gst === "" ? null : Math.round(Number(gst) * 100),
    });
    await qc.invalidateQueries({ queryKey: ["stores-buying", "draft", p.id] });
  }, drop ? t("stores.buying.agent.dropped") : t("stores.buying.agent.lineOk"));
  return (
    <div data-testid={`read-line-${String(lineIdx)}`} style={{ borderTop: "1px solid var(--rule, #e3e3e3)", padding: "6px 0", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={row}>
        <strong style={{ flex: "1 1 12em", minWidth: 0, overflowWrap: "anywhere" }}>{l.itemName} × {l.qtyBase}</strong>
        {done && <Word text={l.state === "confirmed" ? t("stores.buying.agent.lineOk") : t("stores.buying.agent.dropped")} />}
      </div>
      <span style={{ fontSize: 13, overflowWrap: "anywhere" }} data-testid={`read-source-${String(lineIdx)}`}>
        {l.source === null ? t("stores.buying.agent.noSource") : t("stores.buying.agent.source", { page: l.source.page, text: l.source.text })}
      </span>
      <div style={row}>
        <input aria-label={t("stores.buying.rate")} placeholder={t("stores.buying.rate")} inputMode="decimal" disabled={done} style={{ ...input, width: 100 }} value={rate} onChange={(e) => setRate(e.target.value)} />
        <input aria-label={t("stores.buying.discount")} placeholder={t("stores.buying.discount")} inputMode="decimal" disabled={done} style={{ ...input, width: 70 }} value={disc} onChange={(e) => setDisc(e.target.value)} />
        <input aria-label={t("stores.buying.gst")} placeholder={t("stores.buying.gst")} inputMode="decimal" disabled={done} style={{ ...input, width: 70 }} value={gst} onChange={(e) => setGst(e.target.value)} />
        {!done && <button type="button" style={primary} disabled={act.busy || rate === ""} onClick={() => go(false)}>{t("stores.buying.agent.confirmLine")}</button>}
        {!done && <button type="button" style={btn} disabled={act.busy} onClick={() => go(true)}>{t("stores.buying.agent.drop")}</button>}
      </div>
      <Notice n={act.note} />
    </div>
  );
}

/** The scorecard in words, from rows: "On time 2 of 3 · Fill 7 of 9 · Rejected 0 of 7". */
function ScoreWords({ vendorId }: { vendorId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-buying", "score", vendorId], queryFn: () => scorecard(vendorId), retry: false, staleTime: 300_000 });
  if (q.data === undefined) return null;
  const c = q.data;
  if (c.onTime.den + c.fill.den + c.rejected.den === 0) return <span style={{ fontSize: 12 }}>{t("stores.buying.score.none")}</span>;
  return (
    <span data-testid={`score-${vendorId}`} style={{ fontSize: 12, overflowWrap: "anywhere" }}>
      {t("stores.buying.score.line", { on: c.onTime.num, onOf: c.onTime.den, fill: c.fill.num, fillOf: c.fill.den, rej: c.rejected.num, rejOf: c.rejected.den })}
    </span>
  );
}

/* ─────────────── S5c: single source / emergency, advances ─────────────── */

function ExceptionMaker({ g, onDone }: { g: WireBuyGroup; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const list = useSuppliers().filter((s) => s.kyc.level !== "none");
  const [kind, setKind] = useState<"single_source" | "emergency">("single_source");
  const [vendorId, setVendorId] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div data-testid={`exception-${g.id}`} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={row}>
        {(["single_source", "emergency"] as const).map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} style={kind === k ? primary : btn} onClick={() => setKind(k)}>{t(`stores.buying.exception.${k}`)}</button>
        ))}
      </div>
      <label style={row}>{t("stores.buying.supplier")}
        <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} style={input}>
          <option value="">—</option>
          {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label style={row}>{t("stores.buying.reason")}
        <input style={{ ...input, flex: 1 }} placeholder={t(kind === "emergency" ? "stores.buying.exception.whyEmergency" : "stores.buying.exception.whyOne")} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <span style={{ fontSize: 13 }}>{t(kind === "emergency" ? "stores.buying.exception.emergencyRule" : "stores.buying.exception.singleRule")}</span>
      <Notice n={act.note} />
      <button type="button" style={{ ...primary, alignSelf: "flex-start" }} disabled={act.busy || vendorId === "" || reason.trim() === ""}
        onClick={() => void act.run(async () => { await requestException({ kind, groupId: g.id, vendorId, reason: reason.trim() }); onDone(); }, t("stores.buying.exception.asked"))}>
        {t("stores.buying.exception.ask")}
      </button>
    </div>
  );
}

function AdvanceForm({ poId, onDone }: { poId: string; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const [pct, setPct] = useState("30");
  const [no, setNo] = useState("");
  const [bank, setBank] = useState("");
  const [validTo, setValidTo] = useState("");
  const [amount, setAmount] = useState("");
  return (
    <div data-testid={`advance-${poId}`} style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
      <span style={{ fontSize: 13 }}>{t("stores.buying.advance.rule")}</span>
      <div style={row}>
        <input aria-label={t("stores.buying.advance.pct")} placeholder={t("stores.buying.advance.pct")} inputMode="decimal" style={{ ...input, width: 80 }} value={pct} onChange={(e) => setPct(e.target.value)} />
        <input aria-label={t("stores.buying.advance.bgNo")} placeholder={t("stores.buying.advance.bgNo")} style={{ ...input, width: 140 }} value={no} onChange={(e) => setNo(e.target.value)} />
        <input aria-label={t("stores.buying.advance.bank")} placeholder={t("stores.buying.advance.bank")} style={{ ...input, width: 160 }} value={bank} onChange={(e) => setBank(e.target.value)} />
        <input aria-label={t("stores.buying.advance.validTo")} type="date" style={input} value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        <input aria-label={t("stores.buying.advance.bgAmount")} placeholder={t("stores.buying.advance.bgAmount")} inputMode="decimal" style={{ ...input, width: 130 }} value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <Notice n={act.note} />
      <button type="button" style={{ ...primary, alignSelf: "flex-start" }} disabled={act.busy || no === "" || bank === "" || validTo === "" || amount === ""}
        onClick={() => void act.run(async () => {
          await requestAdvance(poId, { pctBps: Math.round(Number(pct) * 100), guaranteeNo: no, guaranteeBank: bank, guaranteeValidTo: validTo, guaranteePaise: rupeesToPaise(amount) });
          onDone();
        }, t("stores.buying.advance.asked"))}>{t("stores.buying.advance.ask")}</button>
    </div>
  );
}

function AdvanceDecision({ a, onDone }: { a: NonNullable<WireStoresPoSheet["advance"]>; onDone: (x: NonNullable<WireStoresPoSheet["advance"]>) => void }): React.ReactElement {
  const { t } = useTranslation();
  const refused = useRefusal();
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const go = (approve: boolean): void => void (async () => {
    try { onDone(await decideAdvance(a.id, approve, reason.trim() || null)); setNote(null); } catch (e) { setNote({ text: refused(e), ok: false }); }
  })();
  return (
    <div data-testid="advance-decision" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Kv k={t("stores.buying.advance.title")} v={`${String(a.pctBps / 100)}% · ${money(a.amountPaise)}`} />
      <Kv k={t("stores.buying.advance.bgNo")} v={`${a.guaranteeNo} · ${a.guaranteeBank} · ${money(a.guaranteePaise)}`} />
      <Kv k={t("stores.buying.advance.validTo")} v={a.guaranteeValidTo} />
      <Notice n={note} />
      <button type="button" style={big} onClick={() => go(true)}>{t("stores.buying.advance.approve")}</button>
      <div style={{ display: "flex", gap: 6 }}>
        <input aria-label={t("stores.buying.reason")} placeholder={t("stores.buying.reasonNeeded")} style={{ ...input, flex: 1 }} value={reason} onChange={(e) => setReason(e.target.value)} />
        <button type="button" style={btn} disabled={reason.trim() === ""} onClick={() => go(false)}>{t("stores.buying.advance.refuse")}</button>
      </div>
    </div>
  );
}

/** The phone sheet of a single-source or emergency purchase: the one tap of whoever holds the next step. */
function ExceptionSheet({ id }: { id: string }): React.ReactElement {
  const { t } = useTranslation();
  const refused = useRefusal();
  const q = useQuery({ queryKey: ["stores-buying", "exception", id], queryFn: () => getException(id) });
  const [after, setAfter] = useState<WireBuyException | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [refusing, setRefusing] = useState(false);
  const [reason, setReason] = useState("");
  if (q.isPending) return <GreyRows />;
  if (q.isError) return <Notice n={{ text: refused(q.error), ok: false }} />;
  const e = after ?? q.data;
  const act = async (f: () => Promise<WireBuyException>): Promise<void> => {
    try { setAfter(await f()); setNote(null); } catch (x) { setNote({ text: refused(x), ok: false }); }
  };
  return (
    <div data-testid="exception-sheet" style={sheet}>
      <h1 style={{ margin: 0, fontSize: 18 }}>{t(`stores.buying.exception.${e.kind}`)}</h1>
      <Kv k={t("stores.buying.value")} v={money(e.valuePaise)} />
      <Kv k={t("stores.buying.supplier")} v={e.vendorName} />
      <Kv k={t("stores.buying.reason")} v={e.reason} />
      <Kv k={t("stores.buying.exception.status")} v={t(`stores.buying.exceptionStatus.${e.status}`)} />
      {e.confirmBy !== null && <Kv k={t("stores.buying.exception.confirmBy")} v={new Date(e.confirmBy).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} />}
      <Notice n={note} />
      {e.mine === null ? (
        <p style={{ margin: 0, fontWeight: 700 }}>{["approved", "confirmed", "refused"].includes(e.status) ? t(`stores.buying.exceptionStatus.${e.status}`) : t("stores.buying.notYours")}</p>
      ) : (
        <>
          <button type="button" style={big} onClick={() => void act(() => signException(e.id))}>{t(`stores.buying.exception.do.${e.mine}`)}</button>
          {e.mine !== "confirm" && !refusing && <button type="button" style={btn} onClick={() => setRefusing(true)}>{t("stores.buying.exception.refuse")}</button>}
          {refusing && (
            <div style={{ display: "flex", gap: 6 }}>
              <input aria-label={t("stores.buying.reason")} placeholder={t("stores.buying.reasonNeeded")} style={{ ...input, flex: 1 }} value={reason} onChange={(x) => setReason(x.target.value)} />
              <button type="button" style={primary} disabled={reason.trim() === ""} onClick={() => void act(() => refuseException(e.id, reason))}>{t("stores.buying.exception.refuse")}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
