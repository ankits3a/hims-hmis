import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { fetchItems, materialsErrorText } from "../lib/materials-api";
import { cancelIndent, fetchIndents, issueIndent, raiseIndent, rejectIndent } from "../lib/indents-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "./pharmacy-office/sheet";
import type { WireItem, WireStore } from "../lib/materials-api";
import type { WireIndent } from "../lib/indents-api";

/**
 * ═══ PHARMACY GAP A6b — INDENTS, AT THE TOP OF THE TRANSFERS SCREEN ═══
 *
 * A sub-store asks (`materials.stock.receive`: Raise, Cancel); the supplying store answers
 * (`materials.stock.issue`: Issue as a transfer, Reject with a reason). The issue sheet starts each line at
 * what was asked and shows what the shelf has; the server picks batches FEFO and refuses more than it has.
 * Whether this user keeps the store is the server's to say, and its refusal is shown as a sentence.
 * Answered indents are listed briefly with their transfer or their reason. No filter tabs; every form is a sheet.
 */
type Open =
  | { kind: "raise" }
  | { kind: "issue"; indent: WireIndent }
  | { kind: "reject"; indent: WireIndent }
  | { kind: "cancel"; indent: WireIndent };

const RECENT_SHOWN = 10;

export function IndentsSection({ stores, storeId, onChanged }: {
  stores: WireStore[]; storeId: string; onChanged: () => Promise<void>;
}): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState<Open | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["materials", "transfers", "indents", storeId], queryFn: () => fetchIndents(storeId) });
  const all = list.data ?? [];
  const waiting = all.filter((i) => i.status === "requested");
  const answered = all.filter((i) => i.status !== "requested").slice(0, RECENT_SHOWN);
  const canIssue = can("materials.stock.issue");
  const canAsk = can("materials.stock.receive");
  const done = async (text: string): Promise<void> => { setOpen(null); setError(null); setNotice(text); await onChanged(); };

  return (
    <section className="space-y-2 rounded border p-3" data-testid="indents">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 font-semibold">{t("materialsIndents.title")}</h2>
        {canAsk && <Button type="button" size="sm" onClick={() => { setNotice(null); setOpen({ kind: "raise" }); }}>{t("materialsIndents.raise")}</Button>}
      </div>
      {notice !== null && <p className="text-sm text-green-800" data-testid="indent-done">{notice}</p>}
      {list.error !== null && <p role="alert" className="text-sm text-red-700">{materialsErrorText(list.error, t)}</p>}
      {list.data !== undefined && waiting.length === 0 && <p className="text-sm text-muted-foreground">{t("materialsIndents.noneOpen")}</p>}
      <ul className="space-y-2 text-sm">
        {waiting.map((i) => (
          <li key={i.id} className="rounded border p-2" data-testid={`indent-${i.indentNo}`}>
            <p>
              <span className="font-mono">{i.indentNo}</span> · {i.from.name} → {i.to.name} ·{" "}
              {t("materialsIndents.askedBy", { name: i.requestedBy.name, time: fmtIst(i.requestedAt) })}
              {i.note !== null && <> · {i.note}</>}
            </p>
            <p className="flex flex-wrap gap-x-3">
              {i.lines.map((l) => (
                <span key={l.lineIdx} className="whitespace-nowrap">
                  {l.itemCode} · {t("materialsIndents.qtyOf", { qty: l.qtyBase, unit: l.baseUom })}
                  {l.available !== null && <span className="text-muted-foreground"> ({t("materialsIndents.available", { qty: l.available })})</span>}
                </span>
              ))}
            </p>
            <div className="mt-1 flex gap-2">
              {canIssue && <Button type="button" size="sm" onClick={() => { setNotice(null); setOpen({ kind: "issue", indent: i }); }}>{t("materialsIndents.issue")}</Button>}
              {canIssue && <Button type="button" size="sm" variant="outline" onClick={() => { setNotice(null); setOpen({ kind: "reject", indent: i }); }}>{t("materialsIndents.reject")}</Button>}
              {canAsk && <Button type="button" size="sm" variant="outline" onClick={() => { setNotice(null); setOpen({ kind: "cancel", indent: i }); }}>{t("materialsIndents.cancel")}</Button>}
            </div>
          </li>
        ))}
      </ul>
      {answered.length > 0 && (
        <>
          <h3 className="text-sm font-medium">{t("materialsIndents.answered")}</h3>
          <ul className="space-y-1 text-sm">
            {answered.map((i) => (
              <li key={i.id} data-testid={`answered-${i.indentNo}`}>
                <span className="font-mono">{i.indentNo}</span> · {i.from.name} → {i.to.name} ·{" "}
                <span className="font-medium">{t(`materialsIndents.s_${i.status}`)}</span>
                {i.transfer !== null && <> · {t("materialsIndents.asTransfer", { ref: i.transfer.ref })}</>}
                {i.status === "issued" && <> · {i.lines.map((l) => t("materialsIndents.lineIssued", { code: l.itemCode, got: l.qtyIssued ?? 0, asked: l.qtyBase })).join(", ")}</>}
                {i.rejectReason !== null && <> · {i.rejectReason}</>}
                {i.cancelReason !== null && <> · {i.cancelReason}</>}
              </li>
            ))}
          </ul>
        </>
      )}

      {open?.kind === "raise" && (
        <RaiseSheet stores={stores} error={error} onError={setError} onClose={() => { setOpen(null); setError(null); }}
          onDone={(r) => done(t("materialsIndents.raised", { no: r.indentNo, to: r.to.name }))} />
      )}
      {open?.kind === "issue" && (
        <IssueSheet indent={open.indent} error={error} onError={setError} onClose={() => { setOpen(null); setError(null); }}
          onDone={(r) => done(t("materialsIndents.issued", { no: r.indentNo, ref: r.transfer?.ref ?? "", to: r.from.name }))} />
      )}
      {(open?.kind === "reject" || open?.kind === "cancel") && (
        <ReasonSheet kind={open.kind} indent={open.indent} error={error} onError={setError} onClose={() => { setOpen(null); setError(null); }}
          onDone={(r) => done(t(open.kind === "reject" ? "materialsIndents.rejected" : "materialsIndents.cancelled", { no: r.indentNo }))} />
      )}
    </section>
  );
}

function SheetError({ error }: { error: string | null }): React.ReactElement | null {
  return error === null ? null : <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>;
}

function RaiseSheet({ stores, error, onError, onClose, onDone }: {
  stores: WireStore[]; error: string | null; onError: (text: string) => void; onClose: () => void; onDone: (r: WireIndent) => Promise<void>;
}): React.ReactElement {
  const { t } = useTranslation();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<WireItem[] | null>(null);
  const [lines, setLines] = useState<{ item: WireItem; qty: string }[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const find = async (): Promise<void> => {
    try { setFound(await fetchItems({ search: q.trim() })); } catch (e) { onError(materialsErrorText(e, t)); }
  };
  const valid = from !== "" && to !== "" && from !== to && lines.length > 0 && lines.every((l) => /^\d+$/.test(l.qty) && Number(l.qty) > 0);
  const send = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    try {
      await onDone(await raiseIndent({
        fromResourceId: from, toResourceId: to, ...(note.trim() === "" ? {} : { note: note.trim() }),
        lines: lines.map((l) => ({ itemId: l.item.id, qtyBase: Number(l.qty) })),
      }));
    } catch (e) { onError(materialsErrorText(e, t)); } finally { setBusy(false); }
  };
  return (
    <Sheet title={t("materialsIndents.raise")} onClose={onClose} testId="indent-raise">
      <SheetError error={error} />
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-4">
          <label>{t("materialsIndents.from")}
            <select aria-label={t("materialsIndents.from")} className="ml-2 rounded border px-2 py-1" value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">{t("materialsTransfers.choose")}</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
            </select>
          </label>
          <label>{t("materialsIndents.to")}
            <select aria-label={t("materialsIndents.to")} className="ml-2 rounded border px-2 py-1" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">{t("materialsTransfers.choose")}</option>
              {stores.filter((s) => s.id !== from).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
            </select>
          </label>
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim() !== "") void find(); }}>
          <Input aria-label={t("materialsTransfers.itemSearch")} placeholder={t("materialsTransfers.itemSearch")} value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
          <Button type="submit" variant="outline">{t("materialsTransfers.find")}</Button>
        </form>
        {found !== null && found.length === 0 && <p className="text-muted-foreground">{t("materialsTransfers.noItem")}</p>}
        {found !== null && found.length > 0 && (
          <ul className="space-y-1">
            {found.slice(0, 20).map((i) => (
              <li key={i.id} className="flex items-center gap-2">
                <span className="font-mono">{i.code}</span><span>{i.name}</span>
                <Button type="button" size="sm" variant="outline" disabled={lines.some((l) => l.item.id === i.id)}
                  onClick={() => { setFound(null); setQ(""); setLines((all) => [...all, { item: i, qty: "" }]); }}>{t("materialsTransfers.add")}</Button>
              </li>
            ))}
          </ul>
        )}
        {lines.length > 0 && (
          <table>
            <tbody>
              {lines.map((l, idx) => (
                <tr key={l.item.id}>
                  <td className="pr-3 font-mono">{l.item.code}</td>
                  <td className="pr-3">{l.item.name}</td>
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
        )}
        <label className="block">{t("materialsTransfers.note")}
          <Input aria-label={t("materialsTransfers.note")} value={note} onChange={(e) => setNote(e.target.value)} className="max-w-md" />
        </label>
        <Button type="button" disabled={!valid || busy} onClick={() => { void send(); }}>{t("materialsIndents.send")}</Button>
      </div>
    </Sheet>
  );
}

function IssueSheet({ indent, error, onError, onClose, onDone }: {
  indent: WireIndent; error: string | null; onError: (text: string) => void; onClose: () => void; onDone: (r: WireIndent) => Promise<void>;
}): React.ReactElement {
  const { t } = useTranslation();
  const [qty, setQty] = useState<Record<number, string>>(() => Object.fromEntries(indent.lines.map((l) => [l.lineIdx, String(l.qtyBase)])));
  const [busy, setBusy] = useState(false);
  const ok = (l: WireIndent["lines"][number]): boolean => /^\d+$/.test(qty[l.lineIdx] ?? "") && Number(qty[l.lineIdx]) <= l.qtyBase;
  const valid = indent.lines.every(ok) && indent.lines.some((l) => Number(qty[l.lineIdx]) > 0);
  const issue = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    try {
      await onDone(await issueIndent(indent.id, indent.lines.map((l) => ({ lineIdx: l.lineIdx, qtyBase: Number(qty[l.lineIdx]) }))));
    } catch (e) { onError(materialsErrorText(e, t)); } finally { setBusy(false); }
  };
  return (
    <Sheet title={t("materialsIndents.issueTitle", { no: indent.indentNo, to: indent.from.name })} onClose={onClose} testId="indent-issue">
      <SheetError error={error} />
      <table className="text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="pr-3" colSpan={2}>{t("materialsIndents.item")}</th>
            <th className="pr-3">{t("materialsIndents.asked")}</th>
            <th className="pr-3">{t("materialsIndents.onShelf")}</th>
            <th>{t("materialsIndents.toIssue")}</th>
          </tr>
        </thead>
        <tbody>
          {indent.lines.map((l) => {
            const over = l.available !== null && Number(qty[l.lineIdx] ?? 0) > l.available;
            return (
              <tr key={l.lineIdx} data-testid={`issue-line-${String(l.lineIdx)}`}>
                <td className="pr-3 font-mono">{l.itemCode}</td>
                <td className="pr-3">{l.itemName}</td>
                <td className="whitespace-nowrap pr-3">{l.qtyBase} {l.baseUom}</td>
                <td className={over ? "whitespace-nowrap pr-3 text-amber-800" : "whitespace-nowrap pr-3"}>{l.available ?? ""}</td>
                <td>
                  <Input aria-label={t("materialsIndents.issueQty", { code: l.itemCode })} inputMode="numeric" className="w-24" value={qty[l.lineIdx] ?? ""}
                    onChange={(e) => setQty({ ...qty, [l.lineIdx]: e.target.value.replace(/\D/g, "") })} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="my-2 text-sm text-muted-foreground">{t("materialsIndents.issueHint")}</p>
      <Button type="button" disabled={!valid || busy} onClick={() => { void issue(); }}>{t("materialsIndents.issueSubmit")}</Button>
    </Sheet>
  );
}

function ReasonSheet({ kind, indent, error, onError, onClose, onDone }: {
  kind: "reject" | "cancel"; indent: WireIndent; error: string | null; onError: (text: string) => void; onClose: () => void; onDone: (r: WireIndent) => Promise<void>;
}): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    if (reason.trim() === "") return;
    setBusy(true);
    try {
      await onDone(await (kind === "reject" ? rejectIndent : cancelIndent)(indent.id, reason.trim()));
    } catch (e) { onError(materialsErrorText(e, t)); } finally { setBusy(false); }
  };
  return (
    <Sheet title={t(kind === "reject" ? "materialsIndents.rejectTitle" : "materialsIndents.cancelTitle", { no: indent.indentNo })} onClose={onClose} testId={`indent-${kind}`}>
      <SheetError error={error} />
      <label className="block text-sm">{t("materialsIndents.reason")}
        <Input aria-label={t("materialsIndents.reason")} value={reason} onChange={(e) => setReason(e.target.value)} className="max-w-md" />
      </label>
      <Button type="button" className="mt-2" disabled={reason.trim() === "" || busy} onClick={() => { void submit(); }}>
        {t(kind === "reject" ? "materialsIndents.reject" : "materialsIndents.cancel")}
      </Button>
    </Sheet>
  );
}
