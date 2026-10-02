import { useState } from "react";
import { useAuth } from "../lib/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchSaleCandidates, fetchSaleItems, patchSaleItem, pharmacyErrorText, registerSaleItem, setSaleItemDiscount } from "../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
import { GstSlabPanel } from "../components/gst-slab-panel";
import { OfficeHead, fieldCls } from "./pharmacy-office/office-page";
import type { WireSaleItem } from "../lib/pharmacy-api";

/**
 * PLAN 16c T2 — the sale-items admin screen (D3). Two lists from one search box: the drugs already
 * bridged to a tariff service, and the active drugs that are not. Registering is one click because
 * everything the bridge needs is already on the item master (code, name, GST slab); the screen
 * declines to invent a price, and says so in its intro.
 */
export function PharmacyItems(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const registered = useQuery({ queryKey: ["pharmacy", "sale-items", search], queryFn: () => fetchSaleItems({ search }) });
  const candidates = useQuery({ queryKey: ["pharmacy", "sale-candidates", search], queryFn: () => fetchSaleCandidates({ search }) });

  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ["pharmacy", "sale-items"] });
    await qc.invalidateQueries({ queryKey: ["pharmacy", "sale-candidates"] });
  };

  const register = async (itemId: string, code: string): Promise<void> => {
    setError(null); setDone(null);
    try {
      const r = await registerSaleItem(itemId);
      setDone(t("pharmacyItems.registeredAs", { code, service: r.serviceCode }));
      await refresh();
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };

  const toggle = async (item: WireSaleItem): Promise<void> => {
    setError(null); setDone(null);
    try {
      await patchSaleItem(item.itemId, { active: !item.active });
      await refresh();
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };

  /* OWNER 2026-10-02 — the standing discount to the patient. The in-charge types a percentage and sets it; everyone else reads it. */
  const canDiscount = can("pharmacy.sale_items.discount");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const shownDiscount = (it: WireSaleItem): string => typed[it.itemId] ?? ((it.discountBps ?? 0) === 0 ? "" : String((it.discountBps ?? 0) / 100));
  const saveDiscount = async (it: WireSaleItem): Promise<void> => {
    setError(null); setDone(null);
    const pct = Number(shownDiscount(it) || "0");
    if (!Number.isFinite(pct) || pct < 0 || pct > 25) { setError(t("pharmacyItems.discountRange")); return; }
    try {
      await setSaleItemDiscount(it.itemId, Math.round(pct * 100));
      setTyped((prev) => { const next = { ...prev }; delete next[it.itemId]; return next; });
      setDone(t("pharmacyItems.discountSet", { code: it.code, pct: String(pct) }));
      await refresh();
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };

  const gstLabel = (bps: number | null): string => (bps === null || bps === 0 ? t("pharmacyItems.nil") : `${String(bps / 100)}%`);

  /* GAP-CLOSURE B5 — ONE list, grouped: what is not on sale yet (the act) first, then on sale, then withdrawn. */
  const onSale = (registered.data ?? []).filter((it) => it.active);
  const withdrawn = (registered.data ?? []).filter((it) => !it.active);
  const saleRow = (it: WireSaleItem): React.ReactElement => (
    <tr key={it.itemId} className={it.active ? "" : "ofp-dim"}>
      <td className="ofp-code">{it.code}</td>
      <td>{it.name}</td>
      <td>{it.baseUom}</td>
      <td>{gstLabel(it.gstRateBps)}</td>
      <td className="ofp-code">{it.serviceCode}</td>
      <td data-testid={`sale-discount-${it.code}`}>
        {canDiscount ? (
          <span className="flex items-center gap-1">
            <input
              aria-label={t("pharmacyItems.discountFor", { code: it.code })} inputMode="decimal" className={`${fieldCls} w-16 text-right`}
              value={shownDiscount(it)} onChange={(e) => setTyped((prev) => ({ ...prev, [it.itemId]: e.target.value }))}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => void saveDiscount(it)}>{t("pharmacyItems.discountSave")}</Button>
          </span>
        ) : ((it.discountBps ?? 0) === 0 ? "—" : `${String((it.discountBps ?? 0) / 100)}%`)}
      </td>
      <td>{it.active ? <span className="pill on">{t("pharmacyItems.active")}</span> : <span className="pill">{t("pharmacyItems.inactive")}</span>}</td>
      <td>
        <div className="ofp-rowacts">
          <Button type="button" variant="outline" size="sm" onClick={() => void toggle(it)}>
            {it.active ? t("pharmacyItems.withdraw") : t("pharmacyItems.reinstate")}
          </Button>
        </div>
      </td>
    </tr>
  );
  const head = (
    <thead>
      <tr>
        <th>{t("pharmacyItems.code")}</th>
        <th>{t("pharmacyItems.name")}</th>
        <th>{t("pharmacyItems.baseUom")}</th>
        <th>{t("pharmacyItems.gst")}</th>
        <th>{t("pharmacyItems.service")}</th>
        <th>{t("pharmacyItems.discount")}</th>
        <th>{t("pharmacyItems.status")}</th>
        <th />
      </tr>
    </thead>
  );

  return (
    <div className="space-y-4" data-testid="pharmacy-items">
      <OfficeHead title={t("pharmacyItems.title")} lead={t("pharmacyItems.intro")} />

      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p role="status" className="text-sm text-green-700">{done}</p>}

      <input
        aria-label={t("pharmacyItems.search")}
        placeholder={t("pharmacyItems.search")}
        className={`${fieldCls} ofp-search`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="ofp-box">
        <section data-testid="sale-group-candidates">
          <h2 className="ofp-group ofp-label">{t("pharmacyItems.candidates")} · {candidates.data?.length ?? "…"}</h2>
          {candidates.data !== undefined && candidates.data.length === 0 && (
            <p className="ofp-empty">{t("pharmacyItems.noCandidates")}</p>
          )}
          {candidates.data !== undefined && candidates.data.length > 0 && (
            <ul className="ofp-rows">
              {candidates.data.map((c) => (
                <li key={c.id}>
                  <span className="min-w-0 flex-1">
                    <span className="ofp-code">{c.code}</span> · {c.name} · {c.baseUom} · {t("pharmacyItems.gst")} {gstLabel(c.gstRateBps)}
                  </span>
                  <Button type="button" size="sm" onClick={() => void register(c.id, c.code)}>
                    {t("pharmacyItems.register")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section data-testid="sale-group-registered">
          <h2 className="ofp-group ofp-label">{t("pharmacyItems.registered")} · {registered.data === undefined ? "…" : `${String(onSale.length)} · ${t("pharmacyItems.withdrawnCount", { count: withdrawn.length })}`}</h2>
          {registered.data !== undefined && registered.data.length === 0 && (
            <p className="ofp-empty">{t("pharmacyItems.noneRegistered")}</p>
          )}
          {registered.data !== undefined && registered.data.length > 0 && (
            <div className="ofp-scroll">
              <table className="ofp-table min-w-[44rem]">
                {head}
                <tbody>{[...onSale, ...withdrawn].map(saleRow)}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <div className="ofp-card">
        <GstSlabPanel />
      </div>
    </div>
  );
}
