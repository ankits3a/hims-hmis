import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import {
  fetchAvailableAt, fetchItems, fetchStores, fetchTransferWorklist, issueTransfer, materialsErrorText, receiveTransfer,
} from "../lib/materials-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WireItem, WireTransferView } from "../lib/materials-api";

/**
 * ═══ STOCK TRANSFERS (2026-09-17) — THE STORES SEND, THE RECEIVING STORE CONFIRMS ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-materials-transfer-screen.md`. Until now a
 * transfer was an API only, and the walk-in retail shelf was stocked by goods receipt. Three parts:
 *   - **Send stock** (`materials.stock.issue`): from, to, lines of item and quantity in base units
 *     with what the source can give now, and a note. The server picks batches earliest-expiry first.
 *   - **Awaiting receipt** (`materials.stock.receive` to act): each line starts at what was sent;
 *     the receiver types what they counted. A shortfall stays in transit and on the discrepancy
 *     list. The server refuses the issuer, and anyone who does not keep a store that names its
 *     keepers; the refusal is shown as a sentence.
 *   - **Recent transfers**, with names, never ids.
 */
type SendLine = { item: WireItem; qty: string; available: number | null };

const whole = (v: string): boolean => /^\d+$/.test(v) && Number(v) > 0;

export function MaterialsTransfers(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [store, setStore] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [received, setReceived] = useState<string | null>(null);

  const stores = useQuery({ queryKey: ["materials", "stores"], queryFn: fetchStores });
  const board = useQuery({ queryKey: ["materials", "transfers", "worklist", store], queryFn: () => fetchTransferWorklist(store) });
  const refresh = async (): Promise<void> => { await qc.invalidateQueries({ queryKey: ["materials", "transfers"] }); };

  return (
    <div className="space-y-5 p-4">
      <h1 className="text-xl font-semibold">{t("materialsTransfers.title")}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("materialsTransfers.intro")}</p>
      {error !== null && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {sent !== null && <p className="text-sm text-green-800" data-testid="transfer-sent">{sent}</p>}
      {received !== null && <p className="text-sm text-green-800" data-testid="transfer-received">{received}</p>}

      {can("materials.stock.issue") && (
        <SendStock
          stores={stores.data ?? []}
          onError={setError}
          onSent={async (text) => { setError(null); setReceived(null); setSent(text); await refresh(); }}
        />
      )}

      <label className="block text-sm">
        {t("materialsTransfers.store")}
        <select aria-label={t("materialsTransfers.store")} className="ml-2 rounded border px-2 py-1" value={store} onChange={(e) => setStore(e.target.value)}>
          <option value="">{t("materialsTransfers.allStores")}</option>
          {(stores.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
        </select>
      </label>
      {board.error !== null && <p role="alert" className="text-sm text-red-700">{materialsErrorText(board.error, t)}</p>}

      <section className="space-y-2">
        <h2 className="font-semibold">{t("materialsTransfers.awaiting")}</h2>
        {board.data !== undefined && board.data.awaiting.length === 0 && <p className="text-sm text-muted-foreground">{t("materialsTransfers.noneAwaiting")}</p>}
        {(board.data?.awaiting ?? []).map((tr) => (
          <Awaiting
            key={tr.id} transfer={tr} canReceive={can("materials.stock.receive")}
            onError={(text) => { setSent(null); setReceived(null); setError(text); }}
            onReceived={async (text) => { setError(null); setSent(null); setReceived(text); await refresh(); }}
          />
        ))}
      </section>

      <section className="space-y-1">
        <h2 className="font-semibold">{t("materialsTransfers.recent")}</h2>
        {board.data !== undefined && board.data.recent.length === 0 && <p className="text-sm text-muted-foreground">{t("materialsTransfers.noneRecent")}</p>}
        <ul className="space-y-2 text-sm">
          {(board.data?.recent ?? []).map((tr) => (
            <li key={tr.id} data-testid={`recent-${tr.ref}`} className={tr.status === "discrepancy" ? "rounded bg-amber-50 p-2" : "p-2"}>
              <p>
                <span className="font-mono">{tr.ref}</span> · {tr.from.name} → {tr.to.name} ·{" "}
                <span className="font-medium">{t(`materialsTransfers.s_${tr.status}`)}</span>
              </p>
              <p className="text-muted-foreground">
                {t("materialsTransfers.sentBy", { name: tr.issuedBy.name, time: fmtIst(tr.issuedAt) })}
                {tr.receivedBy !== null && tr.receivedAt !== null && <> · {t("materialsTransfers.receivedBy", { name: tr.receivedBy.name, time: fmtIst(tr.receivedAt) })}</>}
              </p>
              <p className="flex flex-wrap gap-x-3">
                {tr.lines.map((l) => (
                  <span key={l.id} className="whitespace-nowrap">
                    {l.itemCode} · {l.batchNo} · {l.qtyReceived === null
                      ? t("materialsTransfers.lineSent", { qty: l.qtyIssued, unit: l.baseUom })
                      : t("materialsTransfers.lineOf", { got: l.qtyReceived, sent: l.qtyIssued, unit: l.baseUom })}
                  </span>
                ))}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function SendStock({ stores, onError, onSent }: {
  stores: { id: string; code: string; name: string }[];
  onError: (text: string) => void;
  onSent: (text: string) => Promise<void>;
}): React.ReactElement {
  const { t } = useTranslation();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<WireItem[] | null>(null);
  const [lines, setLines] = useState<SendLine[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const availability = async (source: string, list: SendLine[]): Promise<SendLine[]> => {
    if (source === "") return list.map((l) => ({ ...l, available: null }));
    return Promise.all(list.map(async (l) => ({ ...l, available: await fetchAvailableAt(source, l.item.id) })));
  };
  const find = async (): Promise<void> => {
    try { setFound(await fetchItems({ search: q.trim() })); } catch (e) { onError(materialsErrorText(e, t)); }
  };
  const add = async (item: WireItem): Promise<void> => {
    setFound(null); setQ("");
    try {
      const [line] = await availability(from, [{ item, qty: "", available: null }]);
      setLines((all) => [...all, line!]);
    } catch (e) { onError(materialsErrorText(e, t)); }
  };
  const pickSource = async (source: string): Promise<void> => {
    setFrom(source);
    try { setLines(await availability(source, lines)); } catch (e) { onError(materialsErrorText(e, t)); }
  };
  const valid = from !== "" && to !== "" && from !== to && lines.length > 0 && lines.every((l) => whole(l.qty));
  const issue = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    try {
      const r = await issueTransfer({
        fromResourceId: from, toResourceId: to,
        ...(note.trim() === "" ? {} : { note: note.trim() }),
        lines: lines.map((l) => ({ itemId: l.item.id, qtyBase: Number(l.qty) })),
      });
      const toName = stores.find((s) => s.id === to)?.name ?? to;
      setLines([]); setNote("");
      await onSent(t("materialsTransfers.sent", { ref: `TR-${r.transferId.slice(-6)}`, to: toName }));
    } catch (e) {
      onError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded border p-3" data-testid="transfer-send">
      <h2 className="font-semibold">{t("materialsTransfers.send")}</h2>
      <div className="flex flex-wrap items-center gap-4">
        <label className="text-sm">{t("materialsTransfers.from")}
          <select aria-label={t("materialsTransfers.from")} className="ml-2 rounded border px-2 py-1" value={from} onChange={(e) => { void pickSource(e.target.value); }}>
            <option value="">{t("materialsTransfers.choose")}</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
          </select>
        </label>
        <label className="text-sm">{t("materialsTransfers.to")}
          <select aria-label={t("materialsTransfers.to")} className="ml-2 rounded border px-2 py-1" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{t("materialsTransfers.choose")}</option>
            {stores.filter((s) => s.id !== from).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
          </select>
        </label>
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim() !== "") void find(); }}>
        <Input aria-label={t("materialsTransfers.itemSearch")} placeholder={t("materialsTransfers.itemSearch")} value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        <Button type="submit" variant="outline">{t("materialsTransfers.find")}</Button>
      </form>
      {found !== null && found.length === 0 && <p className="text-sm text-muted-foreground">{t("materialsTransfers.noItem")}</p>}
      {found !== null && found.length > 0 && (
        <ul className="space-y-1 text-sm">
          {found.slice(0, 20).map((i) => (
            <li key={i.id} className="flex items-center gap-2">
              <span className="font-mono">{i.code}</span><span>{i.name}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => { void add(i); }}>{t("materialsTransfers.add")}</Button>
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <div className="overflow-x-auto">
        <table className="text-sm">
          <tbody>
            {lines.map((l, idx) => (
              <tr key={`${l.item.id}-${String(idx)}`} data-testid={`send-line-${String(idx)}`}>
                <td className="pr-3 font-mono">{l.item.code}</td>
                <td className="pr-3">{l.item.name}</td>
                <td className="whitespace-nowrap pr-3 text-muted-foreground">
                  {l.available === null ? t("materialsTransfers.pickSource") : t("materialsTransfers.available", { qty: l.available, unit: l.item.baseUom })}
                </td>
                <td className="pr-2">
                  <Input aria-label={t("materialsTransfers.qty", { code: l.item.code })} inputMode="numeric" className="w-24" value={l.qty}
                    onChange={(e) => { const v = e.target.value.replace(/\D/g, ""); setLines((all) => all.map((x, j) => (j === idx ? { ...x, qty: v } : x))); }} />
                </td>
                <td className="pr-2 text-muted-foreground">{l.item.baseUom}</td>
                <td><Button type="button" size="sm" variant="link" onClick={() => setLines((all) => all.filter((_, j) => j !== idx))}>{t("materialsTransfers.remove")}</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <label className="block text-sm">{t("materialsTransfers.note")}
        <Input aria-label={t("materialsTransfers.note")} value={note} onChange={(e) => setNote(e.target.value)} className="max-w-md" />
      </label>
      <Button type="button" disabled={!valid || busy} onClick={() => { void issue(); }}>{t("materialsTransfers.issue")}</Button>
    </section>
  );
}

function Awaiting({ transfer, canReceive, onError, onReceived }: {
  transfer: WireTransferView;
  canReceive: boolean;
  onError: (text: string) => void;
  onReceived: (text: string) => Promise<void>;
}): React.ReactElement {
  const { t } = useTranslation();
  const [counted, setCounted] = useState<Record<string, string>>(
    () => Object.fromEntries(transfer.lines.map((l) => [l.id, String(l.qtyIssued)])),
  );
  const [busy, setBusy] = useState(false);
  const valid = transfer.lines.every((l) => /^\d+$/.test(counted[l.id] ?? "") && Number(counted[l.id]) <= l.qtyIssued);
  const receive = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    try {
      const r = await receiveTransfer(transfer.id, transfer.lines.map((l) => ({ lineId: l.id, qtyReceived: Number(counted[l.id]) })));
      const short = r.shortfalls.reduce((s, x) => s + x.qtyShort, 0);
      await onReceived(short === 0
        ? t("materialsTransfers.receivedAll", { ref: transfer.ref })
        : t("materialsTransfers.receivedShort", { ref: transfer.ref, short }));
    } catch (e) {
      onError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1 rounded border p-2 text-sm" data-testid={`awaiting-${transfer.ref}`}>
      <p>
        <span className="font-mono">{transfer.ref}</span> · {transfer.from.name} → {transfer.to.name} ·{" "}
        {t("materialsTransfers.sentBy", { name: transfer.issuedBy.name, time: fmtIst(transfer.issuedAt) })}
        {transfer.note !== null && <> · {transfer.note}</>}
      </p>
      <div className="overflow-x-auto">
      <table>
        <tbody>
          {transfer.lines.map((l) => {
            const got = counted[l.id] ?? "";
            const short = /^\d+$/.test(got) ? l.qtyIssued - Number(got) : 0;
            return (
              <tr key={l.id}>
                <td className="pr-3 font-mono">{l.itemCode}</td>
                <td className="pr-3">{l.itemName}</td>
                <td className="whitespace-nowrap pr-3 font-mono">{l.batchNo}</td>
                <td className="whitespace-nowrap pr-3">{l.expiryDate ?? ""}</td>
                <td className="whitespace-nowrap pr-3">{t("materialsTransfers.lineSent", { qty: l.qtyIssued, unit: l.baseUom })}</td>
                <td className="pr-2">
                  {canReceive && (
                    <Input aria-label={t("materialsTransfers.receivedQty", { batch: l.batchNo })} inputMode="numeric" className="w-24" value={got}
                      onChange={(e) => setCounted({ ...counted, [l.id]: e.target.value.replace(/\D/g, "") })} />
                  )}
                </td>
                <td className="whitespace-nowrap text-amber-800">{short > 0 ? t("materialsTransfers.short", { qty: short }) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {canReceive && <Button type="button" size="sm" disabled={!valid || busy} onClick={() => { void receive(); }}>{t("materialsTransfers.confirm")}</Button>}
    </div>
  );
}
