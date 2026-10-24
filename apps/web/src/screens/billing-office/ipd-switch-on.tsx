import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { billingErrorMessage } from "../../lib/billing-api";
import { fmtPaise } from "../../lib/format";
import type { WireIpdRateCard } from "./ipd-rate-card";

/**
 * ═══ GO-LIVE SCREENS — SWITCH ON THE IPD SERVICES ═══
 *
 * The rate card import creates every IPD_* service INACTIVE. After the owner's approval puts a priced version in
 * force, the billing office ticks them here and presses **Switch on N services** (`POST /tariff/services/switch-on`,
 * `tariff.services.manage`). A service with no price in the version IN FORCE cannot be ticked, and the server refuses
 * it anyway, so nothing goes live unpriced.
 */
type WireService = { id: string; code: string; name: string; active: boolean };

export function IpdSwitchOn(): React.ReactElement | null {
  const { t } = useTranslation();
  const { can, ready } = useAuth();
  const qc = useQueryClient();
  const mayManage = can("tariff.services.manage");
  const svc = useQuery({
    queryKey: ["tariff", "services"], enabled: mayManage,
    queryFn: () => api<{ items: WireService[] }>("GET", "/tariff/services"),
  });
  const card = useQuery({
    queryKey: ["tariff", "ipd-rate-card", ""], enabled: mayManage,
    queryFn: () => api<WireIpdRateCard>("GET", "/tariff/ipd-rate-card"),
  });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const go = useMutation({
    mutationFn: (ids: string[]) => api<{ switchedOn: string[]; alreadyOn: string[]; versionNo: number }>("POST", "/tariff/services/switch-on", { serviceIds: ids }),
    onSuccess: () => { setPicked(new Set()); void qc.invalidateQueries({ queryKey: ["tariff"] }); },
  });
  if (!ready || !mayManage) return null;

  const price = new Map<string, number>();
  for (const c of card.data?.classes ?? []) {
    for (const cell of c.cells) if (cell.state === "priced" && cell.pricePaise !== null) price.set(cell.serviceCode, cell.pricePaise);
  }
  const rows = (svc.data?.items ?? []).filter((s) => s.code.startsWith("IPD_") && !s.active).sort((a, b) => a.code.localeCompare(b.code));
  const pricedIds = rows.filter((s) => price.has(s.code)).map((s) => s.id);
  const toggle = (id: string): void => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };
  const error = go.error ?? svc.error ?? card.error;

  return (
    <section className="mt-8 space-y-3" data-testid="ipd-switch-on" aria-labelledby="ipd-switch-on-title">
      <h2 id="ipd-switch-on-title" className="text-base font-semibold">{t("ipdSwitchOn.title")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("ipdSwitchOn.lead", { no: card.data?.version?.versionNo ?? "—" })}
      </p>
      {error !== null && <p role="alert" className="text-sm text-red-600">{billingErrorMessage(error)}</p>}
      {go.data !== undefined && (
        <p role="status" className="text-sm" data-testid="ipd-switch-on-done">{t("ipdSwitchOn.done", { count: go.data.switchedOn.length })}</p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="ipd-switch-on-none">{t("ipdSwitchOn.none")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="rounded border px-3 py-1.5 text-sm disabled:opacity-50" disabled={pricedIds.length === 0}
              onClick={() => setPicked(new Set(pricedIds))} data-testid="ipd-switch-on-all">
              {t("ipdSwitchOn.pickPriced", { count: pricedIds.length })}
            </button>
            <button type="button" className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
              disabled={picked.size === 0 || go.isPending} onClick={() => go.mutate([...picked])} data-testid="ipd-switch-on-go">
              {t("ipdSwitchOn.go", { count: picked.size })}
            </button>
          </div>
          <ul className="max-h-96 divide-y overflow-y-auto rounded-lg border bg-white text-sm" data-testid="ipd-switch-on-list">
            {rows.map((s) => {
              const p = price.get(s.code);
              return (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2" data-testid={`ipd-switch-on-${s.code}`}>
                  <input type="checkbox" checked={picked.has(s.id)} disabled={p === undefined} onChange={() => toggle(s.id)}
                    aria-label={s.code} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{s.name}</span>
                    <span className="block text-xs text-muted-foreground">{s.code}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {p === undefined ? <span className="text-red-700">{t("ipdSwitchOn.noPrice")}</span> : fmtPaise(p)}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
