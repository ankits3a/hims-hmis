import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchSaleCandidates, fetchSaleItems, patchSaleItem, pharmacyErrorText, registerSaleItem } from "../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
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

  const gstLabel = (bps: number | null): string => (bps === null || bps === 0 ? t("pharmacyItems.nil") : `${String(bps / 100)}%`);

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-xl font-semibold">{t("pharmacyItems.title")}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyItems.intro")}</p>

      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p role="status" className="text-sm text-green-700">{done}</p>}

      <input
        aria-label={t("pharmacyItems.search")}
        placeholder={t("pharmacyItems.search")}
        className="w-full max-w-md rounded border px-3 py-2"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <section className="space-y-2">
        <h2 className="text-lg font-medium">{t("pharmacyItems.registered")}</h2>
        {registered.data !== undefined && registered.data.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("pharmacyItems.noneRegistered")}</p>
        )}
        {registered.data !== undefined && registered.data.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th className="py-1 pr-3">{t("pharmacyItems.code")}</th>
                <th className="py-1 pr-3">{t("pharmacyItems.name")}</th>
                <th className="py-1 pr-3">{t("pharmacyItems.baseUom")}</th>
                <th className="py-1 pr-3">{t("pharmacyItems.gst")}</th>
                <th className="py-1 pr-3">{t("pharmacyItems.service")}</th>
                <th className="py-1 pr-3">{t("pharmacyItems.status")}</th>
                <th className="py-1 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {registered.data.map((it) => (
                <tr key={it.itemId} className="border-t">
                  <td className="py-1 pr-3 font-mono">{it.code}</td>
                  <td className="py-1 pr-3">{it.name}</td>
                  <td className="py-1 pr-3">{it.baseUom}</td>
                  <td className="py-1 pr-3">{gstLabel(it.gstRateBps)}</td>
                  <td className="py-1 pr-3 font-mono">{it.serviceCode}</td>
                  <td className="py-1 pr-3">{it.active ? t("pharmacyItems.active") : t("pharmacyItems.inactive")}</td>
                  <td className="py-1 pr-3">
                    <Button type="button" variant="outline" size="sm" onClick={() => void toggle(it)}>
                      {it.active ? t("pharmacyItems.withdraw") : t("pharmacyItems.reinstate")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">{t("pharmacyItems.candidates")}</h2>
        {candidates.data !== undefined && candidates.data.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("pharmacyItems.noCandidates")}</p>
        )}
        {candidates.data !== undefined && candidates.data.length > 0 && (
          <ul className="divide-y">
            {candidates.data.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <span className="font-mono">{c.code}</span> · {c.name} · {c.baseUom} · {t("pharmacyItems.gst")} {gstLabel(c.gstRateBps)}
                </span>
                <Button type="button" size="sm" onClick={() => void register(c.id, c.code)}>
                  {t("pharmacyItems.register")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
