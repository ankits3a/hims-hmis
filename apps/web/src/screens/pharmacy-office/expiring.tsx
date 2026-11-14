import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { EXPIRY_ACTION_KINDS, expiryMonthLabel, fetchExpiryActions, istShort, moveExpiryBatch, runExpiryActions } from "../../lib/expiry-actions-api";
import { materialsErrorText } from "../../lib/materials-api";
import { rupees } from "../../lib/purchase-api";
import { qtyText } from "../../lib/returns-api";
import { Button } from "@/components/ui/button";
import type { ExpiryActionKind, WireExpiryActionGroup, WireExpiryActionList, WireExpiryActionRow } from "../../lib/expiry-actions-api";
import type { Open as ReturnsOpen } from "./returns";

/**
 * ═══ #1063 — EXPIRING: ACT NOW ═══
 *
 * The returns side's second page (`/pharmacy/office?view=returns&page=expiring`): every counter batch that has
 * expired or expires within 180 days, ONE action each — Return · Move · At risk · Write off — and NDPS apart. The
 * strip on top says when the Monday run last ran, when it runs next and how many batches it checked; Run now runs
 * it (drafting the Return group, one open draft per supplier). A row a document already holds opens that document
 * on the returns page; Move drafts the transfer at once; Write off opens the existing write-off sheet. Short text:
 * it is read on a phone at 390 px.
 */
const GROUP_TONE: Record<ExpiryActionKind | "ndps", string> = {
  return: "border-sky-400", move: "border-violet-400", at_risk: "border-amber-400", write_off: "border-red-400", ndps: "border-slate-400",
};

const counterOf = (storeCode: string): "opd" | "retail" => (storeCode.toUpperCase() === "PHARM-RETAIL" ? "retail" : "opd");

export function ExpiringView({ onOpen }: { onOpen?: (open: ReturnsOpen) => void } = {}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const key = ["pharmacy", "office", "expiry-actions"];
  const q = useQuery({ queryKey: key, queryFn: fetchExpiryActions });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canRun = can("materials.returns.manage");
  const canMove = can("materials.stock.issue");
  const canWriteOff = can("materials.writeoffs.manage");
  const locale = i18n.language === "hi" ? "hi-IN" : "en-IN";
  const d = q.data;

  const run = async (): Promise<void> => {
    setBusy("run"); setError(null); setNotice(null);
    try {
      qc.setQueryData<WireExpiryActionList>(key, await runExpiryActions());
      setNotice(t("pharmacyOffice.expiring.ran"));
    } catch (e) { setError(materialsErrorText(e, t)); } finally { setBusy(null); }
  };
  const move = async (r: WireExpiryActionRow): Promise<void> => {
    setBusy(r.key); setError(null); setNotice(null);
    try {
      await moveExpiryBatch(r.storeResourceId, r.batchId);
      setNotice(t("pharmacyOffice.expiring.moved"));
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) { setError(materialsErrorText(e, t)); } finally { setBusy(null); }
  };

  const actionOf = (r: WireExpiryActionRow): React.ReactElement | null => {
    const btn = "h-8 shrink-0 px-2.5 text-xs";
    if (r.document !== null) {
      const doc = r.document;
      return (
        <Button type="button" variant="outline" className={btn} data-testid={`expiring-doc-${r.batchId}`}
          onClick={() => onOpen?.(doc.kind === "return" ? { kind: "return", id: doc.id } : { kind: "writeoff", id: doc.id })}>
          {doc.no}
        </Button>
      );
    }
    if (r.action === "return") {
      return canRun ? <Button type="button" className={btn} disabled={busy !== null} onClick={() => void run()}>{t("pharmacyOffice.expiring.act.draft")}</Button> : null;
    }
    if (r.action === "move" && r.moveTo !== null) {
      const label = t("pharmacyOffice.expiring.act.move", { to: t(`pharmacyOffice.expiring.to.${counterOf(r.moveTo.storeCode)}`) });
      return canMove
        ? <Button type="button" className={btn} data-testid={`expiring-move-${r.batchId}`} disabled={busy !== null} onClick={() => void move(r)}>{label}</Button>
        : <span className="text-xs text-muted-foreground">{label}</span>;
    }
    if (r.action === "write_off") {
      // An expiry write-off destroys expired stock only; the damage tray goes as damage whatever its date.
      const now = r.expired || r.why === "damage_tray";
      if (!now || !canWriteOff) return <span className="text-xs text-muted-foreground">{t(now ? "pharmacyOffice.expiring.act.writeOff" : "pharmacyOffice.expiring.act.atExpiry")}</span>;
      const why = r.why === "past_window" || r.why === "no_supplier" || r.why === "damage_tray" ? r.why : "past_window";
      return (
        <Button type="button" variant="outline" className={btn} onClick={() => onOpen?.({
          kind: "newWriteoff", candidates: [{
            itemId: r.itemId, itemCode: r.itemCode, itemName: r.itemName, batchId: r.batchId, batchNo: r.batchNo, expiryDate: r.expiryDate,
            storeResourceId: r.storeResourceId, storeCode: r.storeCode, storeName: r.storeName, qtyBase: r.actionQtyBase, baseUom: r.baseUom,
            valuePaise: r.valuePaise, supplierName: r.supplierName, why,
          }],
        })}>{t("pharmacyOffice.expiring.act.writeOff")}</Button>
      );
    }
    if (r.action === "at_risk") return <span className="text-xs text-amber-800">{t("pharmacyOffice.expiring.act.sellFirst")}</span>;
    return <span className="text-xs text-muted-foreground">{t("pharmacyOffice.expiring.act.register")}</span>;
  };

  const money = (paise: number, estimated: boolean): string => `${estimated ? "≈" : ""}${rupees(paise)}`;
  const row = (r: WireExpiryActionRow): React.ReactElement => (
    <li key={r.key} data-testid={`expiring-row-${r.key}`} className="flex items-start gap-2 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="break-words font-medium">{r.itemName}</span>
          <span className="font-mono text-xs text-muted-foreground">{r.batchNo}</span>
        </div>
        <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span className={r.expired ? "font-medium text-red-700" : ""}>{t("pharmacyOffice.expiring.exp", { month: expiryMonthLabel(r.expiryDate, locale) })}</span>
          <span>{r.storeCode}{r.tray === null ? "" : ` · ${t(`pharmacyOffice.expiring.tray.${r.tray}`)}`}</span>
          <span className="tabular-nums">{qtyText(r.qtyBase, r.baseUom, r.pack)}</span>
          {r.action === "at_risk" || (r.action === "write_off" && r.actionQtyBase !== r.qtyBase)
            ? <span className="tabular-nums text-amber-800">{t("pharmacyOffice.expiring.left", { qty: qtyText(r.actionQtyBase, r.baseUom, r.pack) })}</span>
            : null}
          <span className="tabular-nums text-foreground">{rupees(r.valuePaise)}{r.estimated ? ` ${t("pharmacyOffice.expiring.est")}` : ""}</span>
          <span className="break-words">{r.supplierName}</span>
        </div>
      </div>
      {actionOf(r)}
    </li>
  );

  const section = (k: ExpiryActionKind | "ndps", g: WireExpiryActionGroup): React.ReactElement | null => (g.count === 0 ? null : (
    <section key={k} data-testid={`expiring-group-${k}`} className={`rounded border-l-4 border ${GROUP_TONE[k]}`}>
      <h2 className="flex items-baseline gap-2 border-b px-3 py-1.5 text-sm font-semibold">
        <span className="flex-1">{t(`pharmacyOffice.expiring.group.${k}`)}</span>
        <span className="tabular-nums text-muted-foreground">{g.count}</span>
        <span className="tabular-nums">{money(g.valuePaise, g.estimated)}</span>
      </h2>
      <ul className="divide-y">{g.rows.map(row)}</ul>
    </section>
  ));

  return (
    <div className="space-y-4" data-testid="expiring-view">
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(q.error, t)}</p>}
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {d !== undefined && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded border bg-muted/40 px-3 py-2 text-sm" data-testid="expiring-run">
            <span data-testid="expiring-last-run">
              {d.run.lastRunAt === null ? t("pharmacyOffice.expiring.never") : t("pharmacyOffice.expiring.lastRun", { at: istShort(d.run.lastRunAt, locale) })}
            </span>
            <span data-testid="expiring-next-run" className="text-muted-foreground">{t("pharmacyOffice.expiring.nextRun", { at: istShort(d.run.nextRunAt, locale) })}</span>
            <span data-testid="expiring-checked" className="text-muted-foreground">{t("pharmacyOffice.expiring.checked", { n: d.run.batchesChecked ?? 0 })}</span>
            {canRun && (
              <Button type="button" className="ml-auto h-8 px-3 text-xs" disabled={busy !== null} onClick={() => void run()}>
                {busy === "run" ? t("pharmacyOffice.expiring.running") : t("pharmacyOffice.expiring.runNow")}
              </Button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="expiring-counts">
            {EXPIRY_ACTION_KINDS.map((k) => (
              <div key={k} className={`rounded border-l-4 border p-2 ${GROUP_TONE[k]}`} data-testid={`expiring-count-${k}`}>
                <div className="text-xs text-muted-foreground">{t(`pharmacyOffice.expiring.group.${k}`)}</div>
                <div className="text-xl font-semibold tabular-nums">{d.groups[k].count}</div>
                <div className="text-xs tabular-nums">{money(d.groups[k].valuePaise, d.groups[k].estimated)}</div>
              </div>
            ))}
          </div>

          {EXPIRY_ACTION_KINDS.every((k) => d.groups[k].count === 0) && d.ndps.count === 0
            ? <p className="text-sm text-muted-foreground">{t("pharmacyOffice.expiring.empty")}</p>
            : (
              <div className="space-y-3">
                {EXPIRY_ACTION_KINDS.map((k) => section(k, d.groups[k]))}
                {section("ndps", d.ndps)}
              </div>
            )}
          <p className="text-xs text-muted-foreground">{t("pharmacyOffice.expiring.hint", { days: d.horizonDays, sales: d.salesWindowDays })}</p>
        </>
      )}
    </div>
  );
}
