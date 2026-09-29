import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MAX_LABELS_PER_JOB, fetchLabelCandidates, printLabels } from "../../lib/labels-api";
import { pharmacyErrorText } from "../../lib/pharmacy-api";
import { printInFrame } from "../../lib/print-api";
import { rupees } from "../../lib/purchase-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { LabelKind, LabelLine, WireLabelCandidate, WireSendLabels } from "../../lib/labels-api";

/**
 * ═══ GAP A6 — RACK AND STRIP LABELS (an office page under Items) ═══
 *
 * The owner-approved Menu artboard's "Rack & strip labels". Pick a store; every item on its racks or
 * in its stock is listed with its rack and the batches the store holds. Type how many RACK labels an
 * item needs (the shelf edge) and how many STRIP labels a batch needs (loose strips cut from a box),
 * then print either set. The stickers are 50 × 25 mm on the pharmacy's barcode label printer; with no
 * relay serving it the stickers print from this browser. A strip label's QR scans at the desk's pick.
 *
 * One list and two print buttons — no filter tabs (the counter-screen rule, 2026-09-25).
 */
const copiesOf = (v: string): number => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 0;
};
const monthYear = (iso: string | null): string => (iso === null ? "—" : `${iso.slice(5, 7)}/${iso.slice(0, 4)}`);

export function LabelsView(): React.ReactElement {
  const { t } = useTranslation();
  const [store, setStore] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [rack, setRack] = useState<Record<string, string>>({});
  const [strip, setStrip] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ text: string; red: boolean } | null>(null);
  const q = useQuery({ queryKey: ["pharmacy", "labels", store, find], queryFn: () => fetchLabelCandidates(store, find) });
  const stores = q.data?.stores ?? [];
  const firstStore = q.data?.stores[0]?.id ?? null;
  useEffect(() => { if (store === null && firstStore !== null) setStore(firstStore); }, [store, firstStore]);
  const rows = store === null ? [] : q.data?.rows ?? [];

  const rackLines: LabelLine[] = rows.filter((r) => r.rack !== null && copiesOf(rack[r.itemId] ?? "") > 0)
    .map((r) => ({ itemId: r.itemId, copies: copiesOf(rack[r.itemId] ?? "") }));
  const stripLines: LabelLine[] = rows.flatMap((r) => r.batches.filter((b) => b.mrpPaise !== null && copiesOf(strip[b.batchId] ?? "") > 0)
    .map((b) => ({ itemId: r.itemId, batchId: b.batchId, copies: copiesOf(strip[b.batchId] ?? "") })));
  const count = (lines: LabelLine[]): number => lines.reduce((n, l) => n + l.copies, 0);

  const send = useMutation({
    mutationFn: (kind: LabelKind) => printLabels({ kind, storeResourceId: store!, lines: kind === "rack" ? rackLines : stripLines }),
    onSuccess: (r: WireSendLabels, kind) => {
      const n = count(kind === "rack" ? rackLines : stripLines);
      if (r.via === "relay") setNotice({ text: t("pharmacyOffice.labels.queued", { count: n }), red: false });
      else if (printInFrame(r.document)) setNotice({ text: t("pharmacyOffice.labels.browser", { count: n }), red: false });
      else setNotice({ text: t("pharmacyOffice.reports.printFailed"), red: true });
      if (kind === "rack") setRack({}); else setStrip({});
    },
    onError: (e) => setNotice({ text: pharmacyErrorText(e, t), red: true }),
  });
  const everyRack = (): void => setRack(Object.fromEntries(rows.filter((r) => r.rack !== null).map((r) => [r.itemId, "1"])));

  const printButton = (kind: LabelKind, lines: LabelLine[]): React.ReactElement => {
    const n = count(lines);
    return (
      <Button type="button" data-testid={`labels-print-${kind}`} disabled={n === 0 || n > MAX_LABELS_PER_JOB || send.isPending} onClick={() => { setNotice(null); send.mutate(kind); }}>
        {t(`pharmacyOffice.labels.print.${kind}`, { count: n })}
      </Button>
    );
  };

  return (
    <div className="space-y-4" data-testid="labels-view">
      <div>
        <h2 className="text-lg font-semibold">{t("pharmacyOffice.labels.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("pharmacyOffice.labels.lead")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <select aria-label={t("pharmacyOffice.labels.store")} className="rounded border px-2 py-1" value={store ?? ""} data-testid="labels-store"
          onChange={(e) => { setStore(e.target.value); setRack({}); setStrip({}); setNotice(null); }}>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.code}</option>)}
        </select>
        <Input aria-label={t("pharmacyOffice.labels.find")} placeholder={t("pharmacyOffice.labels.find")} className="h-8 w-56 max-w-full" value={find} onChange={(e) => setFind(e.target.value)} data-testid="labels-find" />
        <Button type="button" variant="outline" size="sm" data-testid="labels-every-rack" disabled={!rows.some((r) => r.rack !== null)} onClick={everyRack}>{t("pharmacyOffice.labels.everyRack")}</Button>
        <span className="flex-1" />
        {printButton("rack", rackLines)}
        {printButton("strip", stripLines)}
      </div>
      {count(rackLines) > MAX_LABELS_PER_JOB || count(stripLines) > MAX_LABELS_PER_JOB
        ? <p role="alert" className="text-sm text-red-600">{t("pharmacyOffice.labels.tooMany", { max: MAX_LABELS_PER_JOB })}</p> : null}
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(q.error, t)}</p>}
      {notice !== null && <p role={notice.red ? "alert" : "status"} className={`text-sm ${notice.red ? "text-red-700" : "text-green-700"}`} data-testid="labels-notice">{notice.text}</p>}
      {q.data !== undefined && store !== null && rows.length === 0 && <p className="text-sm text-muted-foreground" data-testid="labels-empty">{t("pharmacyOffice.labels.empty")}</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="labels-table">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2">{t("pharmacyOffice.labels.col.item")}</th>
                <th className="py-1 pr-2">{t("pharmacyOffice.labels.col.rack")}</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.labels.col.rackLabels")}</th>
                <th className="py-1 pr-2">{t("pharmacyOffice.labels.col.batch")}</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.labels.col.stripLabels")}</th>
              </tr>
            </thead>
            <tbody>{rows.map((r) => <Row key={r.itemId} r={r} rack={rack[r.itemId] ?? ""} strip={strip}
              onRack={(v) => setRack((m) => ({ ...m, [r.itemId]: v }))} onStrip={(id, v) => setStrip((m) => ({ ...m, [id]: v }))} />)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ r, rack, strip, onRack, onStrip }: {
  r: WireLabelCandidate; rack: string; strip: Record<string, string>; onRack: (v: string) => void; onStrip: (batchId: string, v: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const copies = (value: string, onChange: (v: string) => void, label: string, testId: string, disabled = false): React.ReactElement => (
    <input type="number" min={0} max={200} inputMode="numeric" aria-label={label} data-testid={testId} disabled={disabled}
      className="w-16 rounded border px-1 py-0.5 text-right tabular-nums disabled:opacity-40" value={value} onChange={(e) => onChange(e.target.value)} />
  );
  return (
    <tr className="border-t align-top" data-testid={`labels-row-${r.code}`}>
      <td className="py-1.5 pr-2"><div className="font-medium">{r.name}</div><div className="text-xs text-muted-foreground">{r.code}</div></td>
      <td className="whitespace-nowrap py-1.5 pr-2 font-mono text-xs">{r.rack ?? <span className="font-sans text-muted-foreground">{t("pharmacyOffice.labels.noRack")}</span>}</td>
      <td className="py-1.5 pr-2 text-right">{copies(rack, onRack, t("pharmacyOffice.labels.rackCopies", { item: r.name }), `labels-rack-${r.code}`, r.rack === null)}</td>
      <td className="py-1.5 pr-2" colSpan={2}>
        {r.batches.length === 0 ? <span className="text-xs text-muted-foreground">{t("pharmacyOffice.labels.noStock")}</span> : (
          <div className="space-y-1">
            {r.batches.map((b) => (
              <div key={b.batchId} className="flex items-center gap-2 text-xs">
                <span className="flex-1 whitespace-nowrap">
                  <span className="font-mono">{b.batchNo}</span> · {t("pharmacyOffice.labels.exp", { date: monthYear(b.expiryDate) })} · {b.mrpPaise === null
                    ? <span className="text-red-700">{t("pharmacyOffice.labels.noMrp")}</span>
                    : `${rupees(b.mrpPaise)}/${b.mrpUom ?? ""}`}
                </span>
                {copies(strip[b.batchId] ?? "", (v) => onStrip(b.batchId, v), t("pharmacyOffice.labels.stripCopies", { batch: b.batchNo }), `labels-strip-${b.batchNo}`, b.mrpPaise === null)}
              </div>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}
