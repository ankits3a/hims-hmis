import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { fetchReorderAdvice, fetchShortBook, pharmacyErrorText, resolveShortBook } from "../lib/pharmacy-api";
import { setStockLevel } from "../lib/purchase-api";
import { materialsErrorText } from "../lib/materials-api";
import { Button } from "@/components/ui/button";
import { OfficeHead } from "./pharmacy-office/office-page";
import type { WireReorderLine } from "../lib/pharmacy-api";

/**
 * ═══ PHARMACY P4 — THE REORDER LIST ═══
 *
 * Doc 16 §9's Replenishment, drafting tier: the server says what the counter will run out of and
 * which store holds it; people act. "Print requisition" prints the lines with a suggestion, which
 * is what a pharmacist walks to the main store with today. The two-sided issue happens in
 * materials, by the storekeeper, as it always has.
 *
 * P8 adds the shelf's other risk below the list: batches that will expire before the counter's pace
 * sells them (send them back while there is time), and stock already past its date (quarantine).
 */
/** The line's state as the board's pill (B5): out is red, reorder gold, fine pine, no use plain. */
const PILL: Record<WireReorderLine["status"], string> = {
  stock_out: "pill rd", reorder: "pill gd", ok: "pill on", no_movement: "pill",
};

export function PharmacyReorder(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const advice = useQuery({ queryKey: ["pharmacy", "reorder"], queryFn: fetchReorderAdvice });
  const w = advice.data?.window;
  /* PARITY P2 — whoever raises orders sets the levels, here, in place. */
  const canLevel = can("materials.po.raise") && advice.data?.store !== undefined;
  return (
    <div className="space-y-4" data-testid="pharmacy-reorder">
      <style>{"@media print { body * { visibility: hidden; } .reorder-print, .reorder-print * { visibility: visible; } .reorder-print { position: absolute; left: 0; top: 0; } .reorder-print .no-need { display: none; } }"}</style>
      {/* B5 — inside the office the page heading is the office's; the link goes to the orders it feeds, not to the office it is in. */}
      <OfficeHead
        title={t("pharmacyReorder.title")}
        lead={w === undefined ? null : t("pharmacyReorder.intro", { days: w.days, min: w.minCoverDays, target: w.targetCoverDays })}
      >
        {can("materials.po.raise") && (
          <Link to="/pharmacy/office" search={{ view: "buy", page: "orders" }} className="text-sm underline" data-testid="reorder-office-link">{t("pharmacyReorder.toOrders")}</Link>
        )}
      </OfficeHead>
      <ShortBook />
      {advice.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(advice.error, t)}</p>}
      {advice.data !== undefined && advice.data.items.length === 0 && <p className="text-sm">{t("pharmacyReorder.none")}</p>}
      {advice.data !== undefined && advice.data.items.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="ofp-label flex-1">{t("pharmacyReorder.listTitle", { count: advice.data.items.length })}</h2>
            <Button type="button" variant="outline" onClick={() => window.print()}>{t("pharmacyReorder.print")}</Button>
          </div>
          <div className="reorder-print ofp-box ofp-scroll">
            <table className="ofp-table min-w-[64rem]">
              <thead>
                <tr>
                  <th>{t("pharmacyReorder.item")}</th>
                  <th>{t("pharmacyReorder.status")}</th>
                  <th>{t("pharmacyReorder.available")}</th>
                  <th>{t("pharmacyReorder.used", { days: w?.days ?? 30 })}</th>
                  <th>{t("pharmacyReorder.cover")}</th>
                  <th>{t("pharmacyReorder.suggest")}</th>
                  <th>{t("pharmacyReorder.source")}</th>
                  <th>{t("pharmacyReorder.p2.levels")}</th>
                  <th>{t("pharmacyReorder.p2.onOrder")}</th>
                  <th>{t("pharmacyReorder.p2.toBuy")}</th>
                </tr>
              </thead>
              <tbody>
                {advice.data.items.map((l) => (
                  <tr key={l.itemId} data-testid={`reorder-${l.code}`} className={l.suggestBase === 0 && (l.orderBase ?? 0) === 0 ? "no-need" : ""}>
                    <td>{l.name} <span className="text-xs text-muted-foreground">{l.code}</span></td>
                    <td><span className={PILL[l.status] ?? "pill"}>{t(`pharmacyReorder.${l.status}`)}</span></td>
                    <td>{l.available} {l.baseUom}</td>
                    <td>{l.usedInWindow}</td>
                    <td>
                      {l.daysOfCover === null ? t("pharmacyReorder.noCover") : l.daysOfCover}
                      {l.unsoldByExpiry > 0 && (
                        <span className="block text-xs text-amber-800">{t("pharmacyReorder.unsoldHint", { n: l.unsoldByExpiry })}</span>
                      )}
                    </td>
                    <td>{l.suggestBase === 0 ? "" : `${String(l.suggestBase)} ${l.baseUom}${l.suggestPacks !== null ? ` (${l.suggestPacks})` : ""}`}</td>
                    <td>
                      {l.suggestBase === 0 ? "" : l.source === null
                        ? t("pharmacyReorder.purchase")
                        : t("pharmacyReorder.sourceHas", { store: l.source.storeName, n: l.source.available })}
                    </td>
                    <td>
                      {canLevel
                        ? <LevelsCell itemId={l.itemId} code={l.code} storeResourceId={advice.data.store!.id} levels={l.levels ?? null} />
                        : l.levels == null ? "" : `${String(l.levels.minBase)} / ${String(l.levels.reorderBase)} / ${String(l.levels.maxBase)}`}
                    </td>
                    <td className="py-1 pr-3" data-testid={`on-order-${l.code}`}>
                      {(l.onOrderBase ?? 0) > 0 ? `${String(l.onOrderBase)} ${l.baseUom}` : ""}
                      {(l.inDraftBase ?? 0) > 0 && <span className="block text-xs text-muted-foreground">{t("pharmacyReorder.p2.inDraft", { n: l.inDraftBase })}</span>}
                    </td>
                    <td className="py-1 pr-3" data-testid={`to-buy-${l.code}`}>{(l.orderBase ?? 0) > 0 ? `${String(l.orderBase)} ${l.baseUom}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {advice.data !== undefined && w !== undefined && (
        <section className="space-y-2" data-testid="reorder-expiring">
          <h2 className="ofp-label">{t("pharmacyReorder.expiringTitle", { days: w.nearExpiryDays })}</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyReorder.expiringIntro")}</p>
          {advice.data.expiring.length === 0
            ? <p className="text-sm">{t("pharmacyReorder.noneExpiring", { days: w.nearExpiryDays })}</p>
            : (
              <div className="ofp-box ofp-scroll">
                <table className="ofp-table min-w-[44rem]">
                  <thead>
                    <tr>
                      <th>{t("pharmacyReorder.item")}</th>
                      <th>{t("pharmacyReorder.batch")}</th>
                      <th>{t("pharmacyReorder.expiry")}</th>
                      <th>{t("pharmacyReorder.daysLeft")}</th>
                      <th>{t("pharmacyReorder.available")}</th>
                      <th>{t("pharmacyReorder.unsold")}</th>
                      <th>{t("pharmacyReorder.action")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {advice.data.expiring.map((e) => (
                      <tr key={e.batchId} data-testid={`expiring-${e.batchNo}`}>
                        <td>{e.name} <span className="text-xs text-muted-foreground">{e.code}</span></td>
                        <td>{e.batchNo}</td>
                        <td>{e.expiryDate}</td>
                        <td>{e.daysLeft === 0 ? t("pharmacyReorder.lastDay") : e.daysLeft}</td>
                        <td>{e.available} {e.baseUom}</td>
                        <td>{e.unsoldByExpiry === 0 ? "" : `${String(e.unsoldByExpiry)} ${e.baseUom}`}</td>
                        <td>
                          <span className={e.action === "move_back" ? "pill gd" : "pill on"}>
                            {t(`pharmacyReorder.${e.action}`)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </section>
      )}
      {advice.data !== undefined && advice.data.expiredOnShelf.length > 0 && (
        <section className="space-y-2" data-testid="reorder-expired">
          <h2 className="ofp-label ofp-red">{t("pharmacyReorder.expiredTitle")}</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyReorder.expiredIntro")}</p>
          <ul className="ofp-box ofp-rows">
            {advice.data.expiredOnShelf.map((e) => (
              <li key={e.batchId} data-testid={`expired-${e.batchNo}`}>
                {e.name} <span className="text-xs text-muted-foreground">{e.code}</span> · {t("pharmacyReorder.batch")} {e.batchNo} · {t("pharmacyReorder.expiry")} {e.expiryDate} · {t("pharmacyReorder.onHand")} {e.onHand} {e.baseUom}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * PARITY P2 — min / reorder / max for one item at the counter's store, typed in place. ⏎ saves; the
 * server holds `0 ≤ min ≤ reorder < max` and says so in the operator's language when it does not.
 */
function LevelsCell({ itemId, code, storeResourceId, levels }: {
  itemId: string; code: string; storeResourceId: string; levels: { minBase: number; reorderBase: number; maxBase: number } | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [v, setV] = useState({
    min: levels === null ? "" : String(levels.minBase),
    reorder: levels === null ? "" : String(levels.reorderBase),
    max: levels === null ? "" : String(levels.maxBase),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = levels === null
    ? v.min !== "" || v.reorder !== "" || v.max !== ""
    : v.min !== String(levels.minBase) || v.reorder !== String(levels.reorderBase) || v.max !== String(levels.maxBase);
  const save = async (): Promise<void> => {
    if (!dirty || busy) return;
    setBusy(true); setError(null);
    try {
      await setStockLevel({ itemId, storeResourceId, minBase: Number(v.min || "0"), reorderBase: Number(v.reorder || "0"), maxBase: Number(v.max || "0") });
      await qc.invalidateQueries({ queryKey: ["pharmacy", "reorder"] });
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const box = (k: "min" | "reorder" | "max"): React.ReactElement => (
    <input
      aria-label={t(`pharmacyReorder.p2.${k}`, { code })}
      className="w-14 rounded border px-1 py-0.5 text-right"
      inputMode="numeric"
      value={v[k]}
      onChange={(e) => setV((p) => ({ ...p, [k]: e.target.value.replace(/[^0-9]/g, "") }))}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }}
    />
  );
  return (
    <form className="flex items-center gap-1 whitespace-nowrap" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid={`levels-${code}`}>
      {box("min")}<span>/</span>{box("reorder")}<span>/</span>{box("max")}
      {dirty && <Button type="submit" size="sm" variant="outline" disabled={busy}>{t("pharmacyReorder.p2.save")}</Button>}
      {error !== null && <span role="alert" className="block text-xs text-red-600">{error}</span>}
    </form>
  );
}

const IST_WHEN = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * ═══ PARITY P1 — THE SHORT BOOK, AT THE TOP OF THE REORDER LIST ═══
 *
 * What the counter said it was out of — by `N` at the desk, from a declined line, or from the agent's
 * draft a pharmacist confirmed — oldest first, with who said so and when. These rows are what the
 * shelf figures below cannot show: a drug the hospital does not stock at all has no reorder row.
 * P2's purchase-order draft reads the same rows. Closing a row is the counter's act
 * (`pharmacy.dispense.place`): ordered, received, or dismissed.
 */
function ShortBook(): React.ReactElement | null {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const book = useQuery({ queryKey: ["pharmacy", "short-book"], queryFn: fetchShortBook, retry: false });
  const [error, setError] = useState<string | null>(null);
  const canResolve = can("pharmacy.dispense.place");
  const resolve = async (id: string, how: "ordered" | "received" | "dismissed"): Promise<void> => {
    setError(null);
    try {
      await resolveShortBook(id, how);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "short-book"] });
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };
  if (book.data === undefined) return null;
  const rows = book.data.entries;
  return (
    <section className="space-y-2" data-testid="reorder-short-book">
      <h2 className="ofp-label">{t("pharmacyReorder.short.title", { count: rows.length })}</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyReorder.short.intro")}</p>
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {rows.length === 0 ? <p className="text-sm">{t("pharmacyReorder.short.none")}</p> : (
        <div className="ofp-box ofp-scroll">
          <table className="ofp-table min-w-[40rem]">
            <thead>
              <tr>
                <th>{t("pharmacyReorder.item")}</th>
                <th>{t("pharmacyReorder.short.noted")}</th>
                <th>{t("pharmacyReorder.short.qty")}</th>
                <th>{t("pharmacyReorder.short.from")}</th>
                {canResolve && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid={`short-${r.id}`}>
                  <td>{r.drugName}{r.itemId === null && <span className="ml-1 rounded bg-muted px-1 text-xs text-muted-foreground">{t("pharmacyReorder.short.notStocked")}</span>}</td>
                  <td>{IST_WHEN.format(new Date(r.notedAt))} · {r.notedByName ?? "—"}</td>
                  <td>{r.qtyWanted ?? ""}</td>
                  <td>{t(`pharmacyReorder.short.source.${r.source}`)}</td>
                  {canResolve && (
                    <td className="whitespace-nowrap">
                      {(["ordered", "received", "dismissed"] as const).map((how) => (
                        <Button key={how} type="button" size="sm" variant="outline" className="mr-1" onClick={() => void resolve(r.id, how)}>
                          {t(`pharmacyReorder.short.${how}`)}
                        </Button>
                      ))}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
