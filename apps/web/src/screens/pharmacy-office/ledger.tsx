import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchStores, materialsErrorText } from "../../lib/materials-api";
import { downloadCsv, toCsv } from "../../lib/payables-api";
import { qtyText } from "../../lib/returns-api";
import { fetchLedgerItems, fetchStockLedger } from "../../lib/stock-ledger-api";
import type { LedgerDocLink, WireLedgerRow, WireStockLedger } from "../../lib/stock-ledger-api";

/**
 * ═══ GAP-CLOSURE A5 — STOCK → STOCK LEDGER: "WHERE DID THESE 50 STRIPS GO" ═══
 *
 * One item (search), optionally one store, one batch and a date range → every movement in the order
 * it happened: when, what kind (GRN in, dispensed, sold, transfer out / in, returned to the supplier,
 * count adjustment, write-off, merge…), the document by its number (opening its sheet or page where
 * the office has one), in, out, the running balance, and who. The OPENING balance (everything before
 * the range) heads it and the CLOSING balance ends it; opening + in − out = closing. CSV of what is on
 * screen. A read of `GET /materials/stock/ledger` under `materials.stock.read`.
 *
 * Keys: / item · ↑↓ ⏎ pick · X CSV. No filter tabs: the filters are the question's own words.
 */
const TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
const CLOCK = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });

type Item = { id: string; code: string; name: string; baseUom: string };

const IN_KINDS = new Set(["grn", "transfer_in", "patient_return", "receive"]);

export function StockLedgerPage({ onOpen }: { onOpen?: (link: LedgerDocLink) => void } = {}): React.ReactElement {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [item, setItem] = useState<Item | null>(null);
  const [store, setStore] = useState("");
  const [batch, setBatch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const hitsRef = useRef<HTMLDivElement>(null);
  const stores = useQuery({ queryKey: ["pharmacy", "office", "ledger", "stores"], queryFn: fetchStores });
  const hits = useQuery({ queryKey: ["pharmacy", "office", "ledger", "items", search.trim()], queryFn: () => fetchLedgerItems(search.trim()), enabled: item === null && search.trim().length >= 2 });
  const rangeOk = from === "" || to === "" || from <= to;
  const ledger = useQuery({
    queryKey: ["pharmacy", "office", "ledger", item?.id, store, batch, from, to],
    queryFn: () => fetchStockLedger({ itemId: item!.id, resourceId: store, batchId: batch, from, to }),
    enabled: item !== null && rangeOk,
  });
  const L = ledger.data;

  useEffect(() => { if (item === null) searchRef.current?.focus(); }, [item]);

  const pick = (it: Item): void => { setItem(it); setSearch(""); setBatch(""); };
  const kindText = (r: WireLedgerRow): string => t(`pharmacyOffice.ledger.kind.${r.kind}`, { defaultValue: r.reason });
  const docText = (r: WireLedgerRow): string => r.docNo ?? (r.link === null ? "" : t(`pharmacyOffice.ledger.doc.${r.link.kind}`));

  const exportCsv = (): void => {
    if (L === undefined) return;
    const span = `${from || "start"}_${to || "today"}`;
    downloadCsv(`stock-ledger-${L.item.code}-${span}.csv`, toCsv(
      ["Date", "Time", "Kind", "Document", "Store", "Batch", "Expiry", `In (${L.item.baseUom})`, `Out (${L.item.baseUom})`, `Balance (${L.item.baseUom})`, "By"],
      [
        [from, "", "Opening balance", "", "", "", "", "", "", L.opening, ""],
        ...L.rows.map((r) => {
          const at = new Date(r.occurredAt);
          return [DAY.format(at), CLOCK.format(at), kindText(r), docText(r), r.storeCode, r.batchNo, r.expiryDate ?? "", r.qtyIn || "", r.qtyOut || "", r.balance, r.actorName ?? r.actorId];
        }),
        [to, "", "Closing balance", "", "", "", "", L.totalIn, L.totalOut, L.closing, ""],
      ],
    ));
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName);
    if (typing) return;
    if (e.key === "/") { e.preventDefault(); setItem(null); setTimeout(() => searchRef.current?.focus(), 0); return; }
    if (e.key.toLowerCase() === "x" && L !== undefined) { e.preventDefault(); exportCsv(); }
  };
  const onSearchKey = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown") { e.preventDefault(); hitsRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
    if (e.key === "Enter" && hits.data?.[0] !== undefined) { e.preventDefault(); pick(hits.data[0]); }
  };
  const onHitsKey = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = Array.from(hitsRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowUp" && i <= 0) { searchRef.current?.focus(); e.preventDefault(); return; }
    all[e.key === "ArrowDown" ? Math.min(all.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
    e.preventDefault();
  };

  const q = (n: number, d: WireStockLedger): string => qtyText(n, d.item.baseUom, d.item.pack);

  return (
    <div className="pof-pine pl" tabIndex={-1} onKeyDown={onKey} data-testid="stock-ledger">
      <div className="pl-head">
        <h1>{t("pharmacyOffice.ledger.title")}</h1>
        <span className="pr-dim">{t("pharmacyOffice.ledger.sub")}</span>
      </div>

      <div className="box pl-filters">
        <div className="fld pl-item">
          <span className="tag">{t("pharmacyOffice.ledger.item")} <span className="kb">/</span></span>
          {item === null ? (
            <>
              <input ref={searchRef} className="in" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={onSearchKey}
                placeholder={t("pharmacyOffice.ledger.itemPlaceholder")} aria-label={t("pharmacyOffice.ledger.item")} data-testid="ledger-item-search" />
              {search.trim().length >= 2 && (
                <div ref={hitsRef} className="box pr-results pl-hits" onKeyDown={onHitsKey} data-testid="ledger-item-hits">
                  {hits.data !== undefined && hits.data.length === 0 && <p className="pr-dim">{t("pharmacyOffice.ledger.noItems")}</p>}
                  {(hits.data ?? []).map((it) => (
                    <button key={it.id} type="button" className="pr-hit" data-testid={`ledger-item-${it.code}`} onClick={() => pick(it)}>
                      <span className="pr-hit-main"><b>{it.name}</b><span className="pr-dim mo">{it.code} · {it.baseUom}</span></span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <span className="pl-picked" data-testid="ledger-item-picked">
              <b>{item.name}</b> <span className="pr-dim mo">{item.code}</span>
              <button type="button" className="sec" onClick={() => { setItem(null); setBatch(""); }}>{t("pharmacyOffice.ledger.change")}</button>
            </span>
          )}
        </div>
        <label className="fld">
          <span className="tag">{t("pharmacyOffice.ledger.store")}</span>
          <select className="in" value={store} onChange={(e) => setStore(e.target.value)} aria-label={t("pharmacyOffice.ledger.store")} data-testid="ledger-store">
            <option value="">{t("pharmacyOffice.ledger.allStores")}</option>
            {(stores.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
          </select>
        </label>
        <label className="fld">
          <span className="tag">{t("pharmacyOffice.ledger.batch")}</span>
          <select className="in" value={batch} onChange={(e) => setBatch(e.target.value)} disabled={L === undefined} aria-label={t("pharmacyOffice.ledger.batch")} data-testid="ledger-batch">
            <option value="">{t("pharmacyOffice.ledger.allBatches")}</option>
            {(L?.batches ?? []).map((b) => <option key={b.id} value={b.id}>{b.batchNo}{b.expiryDate === null ? "" : ` · ${b.expiryDate}`}</option>)}
          </select>
        </label>
        <label className="fld">
          <span className="tag">{t("pharmacyOffice.pay.ledger.from")}</span>
          <input type="date" className="in" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("pharmacyOffice.pay.ledger.from")} data-testid="ledger-from" />
        </label>
        <label className="fld">
          <span className="tag">{t("pharmacyOffice.pay.ledger.to")}</span>
          <input type="date" className="in" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("pharmacyOffice.pay.ledger.to")} data-testid="ledger-to" />
        </label>
        <div className="fld pl-csv">
          <span className="tag">&nbsp;</span>
          <button type="button" className="sec" disabled={L === undefined} onClick={exportCsv} data-testid="ledger-csv">{t("pharmacyOffice.pay.csv")} <span className="kb">X</span></button>
        </div>
      </div>

      {!rangeOk && <p role="alert" className="pr-bad">{t("pharmacyOffice.ledger.badRange")}</p>}
      {ledger.error !== null && <p role="alert" className="pr-bad">{materialsErrorText(ledger.error, t)}</p>}
      {item === null && <p className="pr-dim pl-empty" data-testid="ledger-empty">{t("pharmacyOffice.ledger.pickItem")}</p>}

      {L !== undefined && (
        <>
          <div className="pl-sums" data-testid="ledger-sums">
            {([["opening", L.opening], ["in", L.totalIn], ["out", L.totalOut], ["closing", L.closing]] as const).map(([k, n]) => (
              <div key={k} className={`box pl-sum ${k === "closing" ? "pl-sum-close" : ""}`} data-testid={`ledger-sum-${k}`}>
                <span className="tag">{t(`pharmacyOffice.ledger.sum.${k}`)}</span>
                <b className="mo">{k === "in" ? "+" : k === "out" ? "−" : ""}{q(n, L)}</b>
                <span className="pr-dim mo">{n} {L.item.baseUom}</span>
              </div>
            ))}
          </div>
          {L.truncated && <p className="pr-bad">{t("pharmacyOffice.ledger.truncated", { count: L.rows.length })}</p>}
          <div className="box pl-table">
            <table className="lt" data-testid="ledger-rows">
              <thead>
                <tr>
                  <th>{t("pharmacyOffice.ledger.col.when")}</th><th>{t("pharmacyOffice.ledger.col.kind")}</th><th>{t("pharmacyOffice.ledger.col.doc")}</th>
                  <th className="wide">{t("pharmacyOffice.ledger.col.store")}</th><th>{t("pharmacyOffice.returns.col.batch")}</th>
                  <th className="num">{t("pharmacyOffice.ledger.col.in")}</th><th className="num">{t("pharmacyOffice.ledger.col.out")}</th>
                  <th className="num">{t("pharmacyOffice.ledger.col.balance")}</th><th className="wide">{t("pharmacyOffice.ledger.col.who")}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="edge" data-testid="ledger-opening">
                  <td colSpan={5} className="c-when">{from === "" ? t("pharmacyOffice.ledger.openingAll") : t("pharmacyOffice.ledger.openingOn", { date: from })}</td>
                  <td className="num c-in" /><td className="num c-out" /><td className="num mo c-bal">{L.opening}</td><td className="wide" />
                </tr>
                {L.rows.length === 0 && <tr><td colSpan={9} className="pr-dim c-when">{t("pharmacyOffice.ledger.none")}</td></tr>}
                {L.rows.map((r) => (
                  <tr key={r.seq} data-testid={`ledger-row-${String(r.seq)}`}>
                    <td className="mo nowrap c-when">{TIME.format(new Date(r.occurredAt))}</td>
                    <td className="c-kind"><span className={`pill ${IN_KINDS.has(r.kind) ? "on" : r.kind === "write_off" || r.kind === "supplier_return" ? "rd" : r.kind === "adjustment" ? "gd" : ""}`}>{kindText(r)}</span></td>
                    <td className="mo c-doc">
                      {r.link !== null && onOpen !== undefined
                        ? <button type="button" className="lnk" data-testid={`ledger-doc-${String(r.seq)}`} onClick={() => onOpen(r.link!)}>{docText(r)}</button>
                        : docText(r)}
                    </td>
                    <td className="wide mo">{r.storeCode}</td>
                    <td className="mo c-batch">{r.batchNo}</td>
                    <td className="num mo pl-in c-in">{r.qtyIn === 0 ? "" : `+${String(r.qtyIn)}`}</td>
                    <td className="num mo pl-out c-out">{r.qtyOut === 0 ? "" : `−${String(r.qtyOut)}`}</td>
                    <td className="num mo c-bal" data-label={t("pharmacyOffice.ledger.col.balance")}><b>{r.balance}</b></td>
                    <td className="wide">{r.actorName ?? "—"}</td>
                  </tr>
                ))}
                <tr className="edge" data-testid="ledger-closing">
                  <td colSpan={5} className="c-when">{to === "" ? t("pharmacyOffice.ledger.closingNow") : t("pharmacyOffice.ledger.closingOn", { date: to })}</td>
                  <td className="num mo c-in">+{L.totalIn}</td><td className="num mo c-out">−{L.totalOut}</td><td className="num mo c-bal"><b>{L.closing}</b></td><td className="wide" />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="pr-dim pr-small">{t("pharmacyOffice.ledger.foot", { uom: L.item.baseUom })}</p>
        </>
      )}
    </div>
  );
}
