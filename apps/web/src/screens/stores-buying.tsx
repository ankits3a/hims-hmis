import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import {
  approveAward, approvePoSheet, buyingDesk, comparative, enterQuote, getAward, groupLines, makeRfq, moveLine, objectAward, poFromAward, poFromGroup, poSheet,
  proposeAward, sendPo, sendRfq, submitPo, suppliers,
} from "../lib/buying-api";
import { storesErrorCode } from "../lib/stores-api";
import "./stores.css";
import type {
  StoresBand, WireAward, WireBuyGroup, WireBuyRow, WireBuyingDesk, WireComparative, WireRfq, WireStoresPoRow, WireStoresPoSheet, WireStoresSupplier,
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
const input: React.CSSProperties = { minHeight: 36, minWidth: 0 };

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
  const search = useSearch({ strict: false }) as { award?: string; po?: string; tab?: string };
  const [tab, setTab] = useState<Tab>(TABS.includes(search.tab as Tab) ? (search.tab as Tab) : "buyNow");
  if (search.award !== undefined) return <div className="stores-ui" data-testid="stores-buying" style={page}><AwardSheet id={search.award} /></div>;
  if (search.po !== undefined) return <div className="stores-ui" data-testid="stores-buying" style={page}><PoSheet id={search.po} /></div>;
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
    case "rfqs": return <Rfqs rfqs={d.rfqs} />;
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
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: 16 }}>
      <section style={{ minWidth: 0 }}>
        <h2 style={{ fontSize: 16, margin: "4px 0" }}>{t("stores.buying.toGroup")}</h2>
        {lines.length === 0 && <p>{t("stores.buying.empty")}</p>}
        {lines.map(({ r, l }) => (
          <label key={key(l.prId, l.lineIdx)} style={row}>
            <input type="checkbox" checked={ticked.includes(key(l.prId, l.lineIdx))}
              onChange={(e) => setTicked(e.target.checked ? [...ticked, key(l.prId, l.lineIdx)] : ticked.filter((x) => x !== key(l.prId, l.lineIdx)))} />
            <span style={{ ...cut, flex: 1 }}>{l.itemName} × {l.qtyBase}</span>
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
        {open.map((g) => <GroupCard key={g.id} g={g} />)}
      </section>
    </div>
  );
}

function useSuppliers(): WireStoresSupplier[] {
  const q = useQuery({ queryKey: ["stores-buying", "suppliers"], queryFn: suppliers });
  return q.data?.suppliers ?? [];
}

function GroupCard({ g }: { g: WireBuyGroup }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: "2px solid var(--ink, #222)", padding: "6px 0", display: "flex", flexDirection: "column", gap: 6 }} data-testid={`group-${g.id}`}>
      <div style={row}>
        <Band band={g.band} />
        {g.split && <Word text={t("stores.buy.split")} />}
        <Word text={t(`stores.buying.stage.${g.status}`)} />
        <strong>{money(g.estimatePaise)}</strong>
        <span style={{ flex: 1 }} />
        {g.rfqId === null && (
          <button type="button" style={primary} onClick={() => setOpen(!open)}>{g.band === "A" ? t("stores.buying.makePo") : t("stores.buying.makeRfq")}</button>
        )}
      </div>
      {g.lines.map((l) => (
        <div key={`${l.prId}:${String(l.lineIdx)}`} style={row}>
          <span style={{ ...cut, flex: 1 }}>{l.itemName} × {l.qtyBase} {l.baseUom}</span>
          <span>{money(l.estimatePaise)}</span>
          {g.rfqId === null && (
            <button type="button" style={btn} disabled={act.busy}
              onClick={() => void act.run(() => moveLine({ prId: l.prId, lineIdx: l.lineIdx, toGroupId: null }), t("stores.buying.movedOut"))}>{t("stores.buying.takeOut")}</button>
          )}
        </div>
      ))}
      <Notice n={act.note} />
      {open && (g.band === "A" ? <BandAQuote g={g} /> : <RfqMaker g={g} />)}
    </div>
  );
}

/** Band A: the one quote (or a live rate contract), then Make PO; a reason when more than 2 % above the last price. */
function BandAQuote({ g }: { g: WireBuyGroup }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const list = useSuppliers().filter((s) => s.kyc.level === "complete");
  const [vendorId, setVendorId] = useState("");
  const [rates, setRates] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const items = [...new Map(g.lines.map((l) => [l.itemId, l])).values()];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
      <label style={row}>{t("stores.buying.reason")}<input style={{ ...input, flex: 1 }} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <Notice n={act.note} />
      <div style={row}>
        <button type="button" style={btn} disabled={act.busy || vendorId === ""}
          onClick={() => void act.run(() => enterQuote({ groupId: g.id, vendorId, lines: items.filter((l) => rates[l.itemId]).map((l) => ({ itemId: l.itemId, ratePaise: rupeesToPaise(rates[l.itemId]!) })) }), t("stores.buying.quoteSaved"))}>
          {t("stores.buying.confirmQuote")}
        </button>
        <button type="button" style={primary} disabled={act.busy} onClick={() => void act.run(() => poFromGroup(g.id, reason.trim() || null), t("stores.buying.poMade"))}>{t("stores.buying.makePo")}</button>
      </div>
    </div>
  );
}

/** Bands B/C: tick at least three suppliers that can quote, a reply-by date, Make RFQ (nothing is sent yet). */
function RfqMaker({ g }: { g: WireBuyGroup }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const list = useSuppliers().filter((s) => s.kyc.level !== "none");
  const [ticked, setTicked] = useState<string[]>([]);
  const [replyBy, setReplyBy] = useState("");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {list.map((s) => (
        <label key={s.id} style={row}>
          <input type="checkbox" checked={ticked.includes(s.id)} onChange={(e) => setTicked(e.target.checked ? [...ticked, s.id] : ticked.filter((x) => x !== s.id))} />
          <span style={{ ...cut, flex: 1 }}>{s.name}</span>
          <Word text={t(`stores.buying.kyc.${s.kyc.level}`)} />
        </label>
      ))}
      <label style={row}>{t("stores.buying.replyBy")}<input type="date" style={input} value={replyBy} onChange={(e) => setReplyBy(e.target.value)} /></label>
      <Notice n={act.note} />
      <button type="button" style={primary} disabled={act.busy || replyBy === "" || (g.band !== "A" && ticked.length < 3)}
        onClick={() => void act.run(() => makeRfq({ groupId: g.id, replyBy: new Date(`${replyBy}T12:30:00Z`).toISOString(), vendorIds: ticked }), t("stores.buying.rfqMade"))}>
        {t("stores.buying.makeRfq")}
      </button>
      {g.band !== "A" && ticked.length < 3 && <span>{t("stores.err.three_quotes_needed")}</span>}
    </div>
  );
}

/* ─────────────── RFQs ─────────────── */

function Rfqs({ rfqs }: { rfqs: WireRfq[] }): React.ReactElement {
  const { t } = useTranslation();
  if (rfqs.length === 0) return <p>{t("stores.buying.noRfqs")}</p>;
  return <div>{rfqs.map((r) => <RfqCard key={r.id} r={r} />)}</div>;
}

function RfqCard({ r }: { r: WireRfq }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const [channel, setChannel] = useState<"email" | "print" | "hand">("email");
  const [quoting, setQuoting] = useState<string | null>(null);
  const day = new Date(r.replyBy).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
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
          {p.status === "draft" && <button type="button" style={primary} disabled={act.busy} onClick={() => void act.run(() => submitPo(p.id), t("stores.buying.submitted"))}>{t("stores.buying.submitPo")}</button>}
          {p.status === "approved" && <button type="button" style={primary} disabled={act.busy} onClick={() => void act.run(() => sendPo(p.id), t("stores.buying.poSent"))}>{t("stores.buying.sendPo")}</button>}
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
  return <div style={kv}><span style={{ color: "var(--muted, #555)", flexShrink: 0 }}>{k}</span><span style={{ ...cut, fontWeight: 600, textAlign: "right" }}>{v}</span></div>;
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
      <Notice n={note} />
      {p.status !== "pending_approval" ? (
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
