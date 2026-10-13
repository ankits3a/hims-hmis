import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { billingErrorMessage } from "../../lib/billing-api";
import { fmtPaise } from "../../lib/format";

/**
 * ═══ THE IPD RATE CARD (epic E0.4, decision 0072 answer 2) ═══
 *
 * The owner reviews the inpatient daily rates here: one row per bed class that must carry rates, one
 * column per component, the price or the word "Missing" (red AND the word — colour is never the only
 * signal). Go-live waits until every class has a room rent, a nursing charge and a visit fee; RMO and
 * cross-consultation are optional and read "Not set" without alarm.
 *
 * The incumbent's tariff arrives as a DRAFT version (`scripts/import-ipd-tariff.ts`), so the panel
 * opens on the newest draft or submitted version when one exists and can switch to the version in
 * force. It is read-only: approving the draft is the tariff's own road. `GET /tariff/ipd-rate-card`,
 * on `tariff.read`.
 */
type Component = "room" | "nursing" | "rmo" | "visit" | "cross_visit";
export type WireIpdRateCard = {
  version: { versionId: string; versionNo: number; status: string } | null;
  classes: {
    bedClass: string; label: string; missing: Component[];
    cells: { component: Component; required: boolean; serviceCode: string; pricePaise: number | null; state: "priced" | "no_service" | "no_price" | "zero" }[];
  }[];
  ready: number;
  missing: number;
};
type WireVersion = { id: string; versionNo: number; status: string };

/** Required first, then the optional two — the order a reviewer reads them in. */
const COLUMNS: readonly Component[] = ["room", "nursing", "visit", "rmo", "cross_visit"];
const IN_FORCE = "";

export function IpdRateCard(): React.ReactElement {
  const { t } = useTranslation();
  const { can, ready } = useAuth();
  const mayRead = can("tariff.read");
  const versions = useQuery({
    queryKey: ["tariff", "versions"], enabled: mayRead,
    queryFn: () => api<{ items: WireVersion[] }>("GET", "/tariff/versions"),
  });
  const pending = (versions.data?.items ?? [])
    .filter((v) => v.status === "draft" || v.status === "submitted")
    .sort((a, b) => b.versionNo - a.versionNo);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? pending[0]?.id ?? IN_FORCE;
  const card = useQuery({
    queryKey: ["tariff", "ipd-rate-card", selected], enabled: mayRead && versions.isFetched,
    queryFn: () => api<WireIpdRateCard>("GET", `/tariff/ipd-rate-card${selected === IN_FORCE ? "" : `?versionId=${encodeURIComponent(selected)}`}`),
  });

  if (!ready) return <section data-testid="ipd-rate-card" />;
  if (!mayRead) return <p className="text-sm text-muted-foreground" data-testid="ipd-rate-card-noaccess">{t("ipdRateCard.noAccess")}</p>;
  const view = card.data;
  const error = card.error ?? versions.error;

  return (
    <section className="mt-8 space-y-3" data-testid="ipd-rate-card" aria-labelledby="ipd-rate-card-title">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h2 id="ipd-rate-card-title" className="text-base font-semibold">{t("ipdRateCard.title")}</h2>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("ipdRateCard.versionLabel")}</span>
          <select
            className="rounded border bg-white px-2 py-1 text-sm" data-testid="ipd-rate-card-version"
            value={selected} onChange={(e) => setPicked(e.target.value)}
          >
            {pending.map((v) => (
              <option key={v.id} value={v.id}>{t("ipdRateCard.versionPending", { no: v.versionNo, status: t(`ipdRateCard.status.${v.status}`) })}</option>
            ))}
            <option value={IN_FORCE}>{t("ipdRateCard.versionInForce")}</option>
          </select>
        </label>
      </div>
      <p className="text-sm text-muted-foreground">{t("ipdRateCard.lead")}</p>
      {error !== null && <p role="alert" className="text-sm text-red-600">{billingErrorMessage(error)}</p>}
      {view !== undefined && (
        <>
          <p className="text-sm font-medium" data-testid="ipd-rate-card-count">
            {t("ipdRateCard.count", { ready: view.ready, missing: view.missing })}
            {view.version === null && <span className="ml-2 font-normal text-muted-foreground">{t("ipdRateCard.noVersion")}</span>}
          </p>
          <div className="rounded-lg border bg-white">
            <table className="w-full table-fixed text-sm" data-testid="ipd-rate-card-grid">
              <colgroup><col className="w-[26%]" />{COLUMNS.map((c) => <col key={c} />)}</colgroup>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="p-2 font-medium">{t("ipdRateCard.colClass")}</th>
                  {COLUMNS.map((c) => (
                    <th key={c} scope="col" className="p-2 text-right font-medium">
                      {t(`ipdRateCard.component.${c}`)}
                      {(c === "rmo" || c === "cross_visit") && <span className="block font-normal">{t("ipdRateCard.optional")}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.classes.map((row) => (
                  <tr key={row.bedClass} className="border-b last:border-b-0" data-testid={`ipd-rate-${row.bedClass}`} data-ready={row.missing.length === 0}>
                    <th scope="row" className="p-2 text-left font-medium">{row.label}</th>
                    {COLUMNS.map((c) => {
                      const cell = row.cells.find((x) => x.component === c);
                      const priced = cell !== undefined && cell.state === "priced" && cell.pricePaise !== null;
                      return (
                        <td key={c} className="p-2 text-right tabular-nums" data-testid={`ipd-rate-${row.bedClass}-${c}`} title={cell?.serviceCode}>
                          {priced
                            ? fmtPaise(cell.pricePaise as number)
                            : cell?.required
                            ? <span className="font-semibold text-red-700">{t("ipdRateCard.missing")}</span>
                            : <span className="text-muted-foreground">{t("ipdRateCard.notSet")}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
