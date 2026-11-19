import { useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  addToOpenTicket, getShelf, openTicketFor, raiseTicket, recordUse, reorderDraft, requestItem, saveCheck, saveReorder, searchItems, shelfTickets, storesErrorCode, undoUse,
} from "../lib/stores-api";
import { Refused, TicketNo, ageOf } from "./stores-tickets";
import { StoresCopilot } from "../components/stores/stores-copilot";
import "./stores.css";
import type { TicketPriority } from "../lib/stores-api";
import type { WireReorderLine, WireShelfItem, WireShelfView } from "@hmis/contracts";

/**
 * STORES S1 (#1111) — THE DEPARTMENT SHELF, on a 390 px phone (spec "## Screens").
 *
 * One row per item, on ONE line: name · on hand · status word · Used (or Check for a durable item). The row
 * never wraps: the name gives way with an ellipsis before the numbers do, and the screen clips sideways, so
 * there is no horizontal scroll at 390 px. Every status is a WORD (OK / Low / Out), never colour alone.
 * Department staff see no money: nothing here is a price. "Used" is two taps: the row's button, then the
 * sheet's primary. The server asks the department-scoped grant on every act; a refusal reads "Not your
 * department".
 */
const KEY = (shelfId: string) => ["stores", "shelf", shelfId] as const;
type Mode = { kind: "list" } | { kind: "used"; item: WireShelfItem } | { kind: "check" } | { kind: "reorder" } | { kind: "tickets" };
/** A notice on the shelf; after Send it names the new ticket, a link to its timeline (walk finding 5). */
type Notice = { text: string; ticket?: { id: string; indentNo: string } } | null;

const page: React.CSSProperties = {
  maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", padding: "12px 16px 24px", display: "flex", flexDirection: "column", gap: 10,
  background: "var(--paper, #fff)", minHeight: "100%",
};
const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", overflow: "hidden", minHeight: 44,
  borderBottom: "1px solid var(--rule, #e3e3e3)", padding: "4px 0",
};
const btn: React.CSSProperties = { minHeight: 36, padding: "0 12px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent", flexShrink: 0 };
const primary: React.CSSProperties = { ...btn, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 600 };

export function StoresShelf({ shelfId }: { shelfId: string }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { check } = useSearch({ strict: false }) as { check?: number | string };
  const [mode, setMode] = useState<Mode>(String(check) === "1" ? { kind: "check" } : { kind: "list" });
  const [notice, setNotice] = useState<Notice>(null);
  const shelf = useQuery({ queryKey: KEY(shelfId), queryFn: () => getShelf(shelfId), retry: false });
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: KEY(shelfId) });

  if (shelf.isError) {
    const code = storesErrorCode(shelf.error);
    return (
      <div data-testid="stores-shelf" className="stores-ui" style={page}>
        {code === "not_permitted"
          ? <Refused at={{ shelfId }} testId="shelf-refused" />
          : <p data-testid="shelf-refused" style={{ margin: 0 }}>{t("stores.shelf.failed")}</p>}
      </div>
    );
  }
  if (shelf.data === undefined) {
    return (
      <div data-testid="stores-shelf" className="stores-ui" style={page} aria-busy="true">
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...rowStyle, background: "var(--rule, #eee)", borderRadius: 4 }} />)}
      </div>
    );
  }
  const view = shelf.data;
  const head = `${view.shelf.departmentName ?? view.shelf.departmentCode ?? ""} · ${view.shelf.floorName ?? view.shelf.name}`;

  if (mode.kind === "check") {
    return <CheckScreen view={view} onDone={(n) => { setNotice({ text: n }); setMode({ kind: "list" }); void refresh(); }} onBack={() => setMode({ kind: "list" })} />;
  }
  if (mode.kind === "reorder") {
    return <ReorderScreen shelfId={view.shelf.id} onDone={(n) => { setNotice(n); setMode({ kind: "list" }); }} onBack={() => setMode({ kind: "list" })} />;
  }
  if (mode.kind === "tickets") return <TicketsScreen shelfId={view.shelf.id} onBack={() => setMode({ kind: "list" })} />;

  return (
    <div data-testid="stores-shelf" className="stores-ui" style={page}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", overflow: "hidden" }}>
        <h1 style={{ margin: 0, fontSize: 18, overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>{head}</h1>
        {view.may.work && <button type="button" style={primary} onClick={() => setMode({ kind: "reorder" })}>{t("stores.shelf.reorder")}</button>}
      </div>
      {notice !== null && (
        <p role="status" data-testid={notice.ticket === undefined ? undefined : "shelf-sent"}
          style={{ margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", gap: 6 }}>
          <span>{notice.text}</span>
          {notice.ticket !== undefined && <TicketNo id={notice.ticket.id} no={notice.ticket.indentNo} />}
        </p>
      )}
      {/* UX pass (walk finding 10): Arriving opens the counted Receive for this transfer — never a blind one-tap receipt. */}
      {view.arriving.map((a) => (
        <div key={a.transferId} data-testid={`shelf-arriving-${a.transferId}`} style={rowStyle}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {t("stores.shelf.arriving")}: {a.lines.map((l) => `${l.name} ${String(l.qty)}`).join(", ")}
          </span>
          {view.may.work && (
            <Link to="/stores/receive" search={{ transfer: a.transferId }} className="stores-btn">{t("stores.shelf.receive")}</Link>
          )}
        </div>
      ))}
      {view.items.length === 0 ? <p style={{ margin: 0 }}>{t("stores.shelf.empty")}</p> : view.items.map((i) => (
        <div key={i.itemId} data-testid={`shelf-row-${i.itemId}`} style={rowStyle}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{i.name}</span>
          <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums", minWidth: 32, textAlign: "right" }}>{String(i.onHand)}</span>
          <span style={{ flexShrink: 0, minWidth: 34, fontWeight: i.status === "ok" ? 400 : 700 }}>{t(`stores.shelf.status.${i.status}`)}</span>
          {view.may.work && (i.trackMode === "durable"
            ? <button type="button" style={btn} onClick={() => setMode({ kind: "check" })}>{t("stores.shelf.check")}</button>
            : <button type="button" style={btn} disabled={i.onHand <= 0} onClick={() => { setNotice(null); setMode({ kind: "used", item: i }); }}>{t("stores.shelf.used")}</button>)}
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {view.may.work && view.items.length > 0 && (
          <button type="button" style={btn} onClick={() => setMode({ kind: "check" })}>{t("stores.shelf.checkShelf")}</button>
        )}
        <button type="button" style={btn} onClick={() => setMode({ kind: "tickets" })}>{t("stores.ux.myTickets")}</button>
        {/* S4a (#1114): the department's tagged units and the scanner that opens a passport. */}
        <Link to="/stores/asset" className="stores-btn">{t("stores.assets.title")}</Link>
      </div>
      {/* S3 (#1113): the concierge on the shelf — "what is low", "where is my ticket", "reorder my shelf" (Send confirms). */}
      <div data-testid="shelf-copilot" style={{ minWidth: 0, maxWidth: "100%" }}><StoresCopilot variant="bar" /></div>
      {mode.kind === "used" && <UsedSheet view={view} item={mode.item} onClose={() => { setMode({ kind: "list" }); void refresh(); }} />}
    </div>
  );
}

function UsedSheet({ view, item, onClose }: { view: WireShelfView; item: WireShelfItem; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rows, setRows] = useState<string[] | null>(null);
  const refuse = (e: unknown): void => {
    const code = storesErrorCode(e);
    setNotice(code === "more_than_on_hand" ? t("stores.shelf.moreThanOnHand")
      : code === "durable_not_used" ? t("stores.shelf.durable")
      : code === "not_permitted" ? t("stores.shelf.notYours") : t("stores.shelf.failed"));
  };
  return (
    <div className="stores-ui" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "flex-end", zIndex: 20 }}>
      <div
        data-testid="shelf-used-sheet" role="dialog" aria-label={item.name}
        style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: "100%", boxSizing: "border-box", padding: "16px 16px 24px", background: "var(--paper, #fff)", borderRadius: "12px 12px 0 0" }}
      >
        <h2 style={{ margin: 0, fontSize: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</h2>
        <p style={{ margin: 0 }}>{t("stores.shelf.onHand")}: {String(item.onHand)}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="button" style={btn} aria-label="−" onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
          <span aria-label={t("stores.shelf.qty")} style={{ minWidth: 32, textAlign: "center", fontSize: 20 }}>{String(qty)}</span>
          <button type="button" style={btn} aria-label="+" onClick={() => setQty((q) => q + 1)}>+</button>
        </div>
        {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {rows === null ? (
            <button type="button" style={primary} disabled={busy} onClick={() => {
              setBusy(true);
              recordUse(view.shelf.id, item.itemId, qty)
                .then((r) => { setRows(r.ledgerEntryIds); setNotice(t("stores.shelf.saved")); })
                .catch(refuse).finally(() => setBusy(false));
            }}>{t("stores.shelf.used")}</button>
          ) : (
            <button type="button" style={btn} disabled={busy} onClick={() => {
              setBusy(true);
              Promise.all(rows.map((rowId) => undoUse(view.shelf.id, rowId, "undone in the sheet")))
                .then(() => { setRows(null); setNotice(t("stores.shelf.undone")); })
                .catch(refuse).finally(() => setBusy(false));
            }}>{t("stores.shelf.undo")}</button>
          )}
          <button type="button" style={btn} onClick={onClose}>{t("stores.shelf.close")}</button>
        </div>
      </div>
    </div>
  );
}

function CheckScreen({ view, onDone, onBack }: { view: WireShelfView; onDone: (notice: string) => void; onBack: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const items = view.items.filter((i) => i.trackMode !== "expensed");
  return (
    <div data-testid="stores-shelf" className="stores-ui" style={page}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{t("stores.shelf.checkShelf")}</h2>
      {items.map((i) => (
        <label key={i.itemId} style={rowStyle}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{i.name}</span>
          <input
            inputMode="numeric" aria-label={`${t("stores.shelf.counted")} · ${i.name}`} value={counts[i.itemId] ?? ""}
            onChange={(e) => setCounts((c) => ({ ...c, [i.itemId]: e.target.value.replace(/\D/g, "") }))}
            style={{ width: 64, minHeight: 36, flexShrink: 0, textAlign: "right" }}
          />
        </label>
      ))}
      {error !== null && <p role="status" style={{ margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={primary} onClick={() => {
          const lines = Object.entries(counts).filter(([, v]) => v !== "").map(([itemId, v]) => ({ itemId, counted: Number(v) }));
          if (lines.length === 0) { onBack(); return; }
          saveCheck(view.shelf.id, lines)
            .then((r) => onDone(r.overBook.length > 0 ? t("stores.shelf.overBook") : t("stores.shelf.countSaved")))
            .catch((e: unknown) => setError(storesErrorCode(e) === "not_permitted" ? t("stores.shelf.notYours") : t("stores.shelf.failed")));
        }}>{t("stores.shelf.saveCount")}</button>
        <button type="button" style={btn} onClick={onBack}>{t("stores.shelf.back")}</button>
      </div>
    </div>
  );
}

/** UX pass (walk finding 5) — "My tickets": the shelf's newest tickets, each number a link to its timeline. */
function TicketsScreen({ shelfId, onBack }: { shelfId: string; onBack: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores", "shelf-tickets", shelfId], queryFn: () => shelfTickets(shelfId), retry: false });
  const tickets = q.data?.tickets ?? [];
  return (
    <div data-testid="stores-shelf" className="stores-ui" style={page}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{t("stores.ux.myTickets")}</h2>
      {q.isError && <p role="status" style={{ margin: 0 }}>{t("stores.shelf.notYours")}</p>}
      {q.data !== undefined && tickets.length === 0 && <p style={{ margin: 0 }}>{t("stores.ux.noTickets")}</p>}
      <div data-testid="shelf-tickets" style={{ display: "flex", flexDirection: "column" }}>
        {tickets.map((tk) => (
          <div key={tk.id} style={rowStyle}>
            <TicketNo id={tk.id} no={tk.indentNo} />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{tk.lines.map((l) => l.itemName).join(", ")}</span>
            <span style={{ flexShrink: 0, fontWeight: 700 }}>{t(`stores.ticket.stage.${tk.stage}`)}</span>
            <span style={{ flexShrink: 0, minWidth: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{ageOf(tk.requestedAt, Date.now())}</span>
          </div>
        ))}
      </div>
      <button type="button" style={{ ...btn, alignSelf: "flex-start" }} onClick={onBack}>{t("stores.shelf.back")}</button>
    </div>
  );
}

function ReorderScreen({ shelfId, onDone, onBack }: { shelfId: string; onDone: (notice: Notice) => void; onBack: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const draft = useQuery({ queryKey: ["stores", "reorder", shelfId], queryFn: () => reorderDraft(shelfId), retry: false });
  const [extra, setExtra] = useState<WireReorderLine[]>([]);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // STORES S2a (#1112) — the draft becomes a ticket: a priority chip, a reason for an emergency, Send.
  const [priority, setPriority] = useState<TicketPriority>("routine");
  const [reason, setReason] = useState("");
  const found = useQuery({ queryKey: ["stores", "search", q.trim()], queryFn: () => searchItems(q), enabled: q.trim().length >= 2 });
  // STORES S2b (#1112, spec "Raise") — a ticket of this shelf still waiting for its HOD: offer to add to it.
  const open = useQuery({ queryKey: ["stores", "open-ticket", shelfId], queryFn: () => openTicketFor(shelfId), retry: false });
  const openTicket = open.data?.ticket ?? null;
  const lines = [...(draft.data?.lines ?? []), ...extra];
  const fail = (e: unknown): void => setNotice(storesErrorCode(e) === "not_permitted" ? t("stores.shelf.notYours") : t("stores.shelf.failed"));
  return (
    <div data-testid="stores-shelf" className="stores-ui" style={page}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{t("stores.shelf.reorder")}</h2>
      {draft.isError && <p role="status" style={{ margin: 0 }}>{t("stores.shelf.notYours")}</p>}
      {draft.data !== undefined && lines.length === 0 && <p style={{ margin: 0 }}>{t("stores.shelf.nothingToReorder")}</p>}
      {lines.map((l) => (
        <label key={l.itemId} style={rowStyle}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{l.name}</span>
          <input
            inputMode="numeric" aria-label={`${t("stores.shelf.qty")} · ${l.name}`} value={qty[l.itemId] ?? String(l.proposed)}
            onChange={(e) => setQty((c) => ({ ...c, [l.itemId]: e.target.value.replace(/\D/g, "") }))}
            style={{ width: 64, minHeight: 36, flexShrink: 0, textAlign: "right" }}
          />
        </label>
      ))}
      <input
        type="search" aria-label={t("stores.shelf.search")} placeholder={t("stores.shelf.search")} value={q}
        onChange={(e) => setQ(e.target.value)} style={{ minHeight: 40, width: "100%", boxSizing: "border-box" }}
      />
      {q.trim().length >= 2 && found.data !== undefined && (found.data.items.length === 0 ? (
        <button type="button" style={btn} onClick={() => {
          requestItem(shelfId, q.trim()).then(() => { setNotice(t("stores.shelf.requestSent")); setQ(""); }).catch(fail);
        }}>{t("stores.shelf.notInList")}</button>
      ) : found.data.items.slice(0, 8).map((it) => (
        <button key={it.id} type="button" style={{ ...btn, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} onClick={() => {
          if (!lines.some((l) => l.itemId === it.id)) setExtra((x) => [...x, { itemId: it.id, code: it.code, name: it.name, onHand: 0, proposed: 1, packUom: it.baseUom, packSize: 1 }]);
          setQ("");
        }}>{it.name}</button>
      )))}
      <div role="radiogroup" aria-label={t("stores.ticket.priorityLabel")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["routine", "urgent", "emergency"] as const).map((p) => (
          <button key={p} type="button" role="radio" aria-checked={priority === p} style={priority === p ? primary : btn} onClick={() => setPriority(p)}>
            {t(`stores.ticket.priority.${p}`)}
          </button>
        ))}
      </div>
      {priority === "emergency" && (
        <input aria-label={t("stores.ticket.reason")} placeholder={t("stores.ticket.reason")} value={reason} onChange={(e) => setReason(e.target.value)}
          style={{ minHeight: 40, width: "100%", boxSizing: "border-box" }} />
      )}
      {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
      {/* UX pass (walk finding 15): a ticket still waiting for its HOD is said once, plainly, with adding to it as the primary. */}
      {openTicket !== null && (
        <div data-testid="reorder-open-ticket" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderTop: "1px solid var(--rule, #e3e3e3)", paddingTop: 8 }}>
          <span style={{ flex: 1, minWidth: 0 }}>{t("stores.ux.waitsForHod", { no: openTicket.indentNo.slice(-4) })}</span>
          <button type="button" style={primary} data-primary="true" disabled={lines.length === 0} onClick={() => {
            const out = lines.map((l) => ({ itemId: l.itemId, qtyBase: Number(qty[l.itemId] ?? String(l.proposed)) })).filter((l) => l.qtyBase > 0);
            if (out.length === 0) return;
            addToOpenTicket(openTicket.id, out)
              .then((r) => onDone({ text: r.alreadyOn.length > 0 ? `${t("stores.ticket.added")} · ${t("stores.ticket.alreadyOn")}` : t("stores.ticket.added"), ticket: { id: openTicket.id, indentNo: openTicket.indentNo } }))
              .catch((e: unknown) => (storesErrorCode(e) === "already_on_ticket" ? setNotice(t("stores.ticket.alreadyOn")) : fail(e)));
          }}>{t("stores.ux.addToIt")}</button>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={openTicket === null ? primary : btn} data-primary={openTicket === null ? "true" : undefined} disabled={lines.length === 0} onClick={() => {
          const out = lines.map((l) => ({ itemId: l.itemId, qtyBase: Number(qty[l.itemId] ?? String(l.proposed)) })).filter((l) => l.qtyBase > 0);
          if (out.length === 0) return;
          if (priority === "emergency" && reason.trim() === "") { setNotice(t("stores.ticket.reasonNeeded")); return; }
          raiseTicket(shelfId, { lines: out, priority, emergencyReason: priority === "emergency" ? reason : null })
            .then((tk) => onDone({ text: t("stores.ticket.sent"), ticket: { id: tk.id, indentNo: tk.indentNo } }))
            .catch((e: unknown) => {
              const code = storesErrorCode(e);
              if (code === "reason_required") setNotice(t("stores.ticket.reasonNeeded"));
              else if (code === "item_id_required" || code === "not_stores_item" || code === "unknown_item") setNotice(t("stores.ticket.chooseFromList"));
              else fail(e);
            });
        }}>{t("stores.ticket.send")}</button>
        <button type="button" style={btn} disabled={lines.length === 0} onClick={() => {
          const out = lines.map((l) => ({ itemId: l.itemId, qty: Number(qty[l.itemId] ?? String(l.proposed)) })).filter((l) => l.qty > 0);
          saveReorder(shelfId, out).then(() => onDone({ text: t("stores.shelf.draftSaved") })).catch(fail);
        }}>{t("stores.shelf.saveDraft")}</button>
        <button type="button" style={btn} onClick={onBack}>{t("stores.shelf.back")}</button>
      </div>
    </div>
  );
}
