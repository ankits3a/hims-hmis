import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  activateVendor, addVendorDocument, blacklistVendor, createVendor, fetchVendor, fetchVendors,
  materialsErrorMessage, reinstateVendor, suspendVendor,
} from "../lib/materials-api";
import { Button } from "@/components/ui/button";
import type { WireVendor } from "../lib/materials-api";

/**
 * PLAN 14 T9 / DD16 — **THE VENDOR MASTER, hand-built (Lane 1).**
 *
 * ═══ THE BANK ACCOUNT IS NOT ON THIS SCREEN, AND THAT IS THE DESIGN ═══
 *
 * Every read route masks `accountNo` to its last four server-side (T4, A7), so what arrives here
 * is already `"••••9012"` and there is nothing to hide. **There is also no bank-change form here.**
 * A bank change needs the OWNER's approval (O-6) and a seven-day cooling-off; putting the form on
 * the same screen as "edit vendor" would make it look like a field rather than a decision.
 * `POST /materials/vendors/:id/bank-change` exists and the owner's approvals worklist is where the
 * decision is taken; wiring a form to it is 14c's, with the payment run that gives the cooling-off
 * teeth.
 *
 * ═══ THE LIFECYCLE IS BUTTONS, AND `blacklist` IS DELIBERATELY NOT ONE OF THEM ═══
 *
 * Activate / suspend / reinstate are single actions. **Blacklisting demands a reason from O-11's
 * closed list and commits the hospital for three years**, so it is a separate control with the
 * four codes as a select — a free-text box would let a storekeeper write "poor quality" forty
 * different ways, and 14b's scorecard has to count them.
 *
 * The three-year clock is rendered beside a blacklisted vendor, because the single most likely
 * question about one is "when can we use them again" and the answer is a date the server already
 * knows (A5).
 */
export function MaterialsVendors(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [search, setSearch] = useState("");
  const [code, setCode] = useState("");
  const [legalName, setLegalName] = useState("");
  const [gstin, setGstin] = useState("");
  const [pan, setPan] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [docType, setDocType] = useState("gst_certificate");
  const [docNumber, setDocNumber] = useState("");
  const [docValidTo, setDocValidTo] = useState("");
  const [blacklistReason, setBlacklistReason] = useState("quality_failure");
  const [suspendReason, setSuspendReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const vendors = useQuery({
    queryKey: ["materials", "vendors", search],
    queryFn: () => fetchVendors({ search }),
  });
  const detail = useQuery({
    queryKey: ["materials", "vendor", selected],
    queryFn: () => fetchVendor(selected as string),
    enabled: selected !== null,
  });

  const run = async (fn: () => Promise<void>, message: string): Promise<void> => {
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(message);
      await qc.invalidateQueries({ queryKey: ["materials"] });
    } catch (e) {
      setError(materialsErrorMessage(e));
    }
  };

  const create = (): void => void run(async () => {
    await createVendor({
      code: code.trim(), legalName: legalName.trim(),
      ...(gstin.trim() === "" ? {} : { gstin: gstin.trim() }),
      ...(pan.trim() === "" ? {} : { pan: pan.trim() }),
    });
    setCode(""); setLegalName(""); setGstin(""); setPan("");
  }, t("materialsVendors.created", { code: code.trim() }));

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-xl font-semibold">{t("materialsVendors.title")}</h1>

      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p role="status" className="text-sm text-green-700">{done}</p>}

      <section className="space-y-3 rounded border p-4">
        <h2 className="font-medium">{t("materialsVendors.newVendor")}</h2>
        <p className="text-xs text-slate-500">{t("materialsVendors.draftHint")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsVendors.code")}
            <input className="rounded border px-2 py-1" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsVendors.legalName")}
            <input className="rounded border px-2 py-1" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsVendors.gstin")}
            <input className="rounded border px-2 py-1" value={gstin} onChange={(e) => setGstin(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsVendors.pan")}
            <input className="rounded border px-2 py-1" value={pan} onChange={(e) => setPan(e.target.value)} />
          </label>
        </div>
        <Button onClick={create}>{t("materialsVendors.create")}</Button>
      </section>

      <section className="space-y-3">
        <label className="flex flex-col gap-1 text-sm sm:max-w-sm">
          {t("materialsVendors.search")}
          <input className="rounded border px-2 py-1" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {vendors.isLoading && <p>{t("common.loading")}</p>}
        {vendors.data !== undefined && vendors.data.length === 0 && <p>{t("materialsVendors.empty")}</p>}
        {vendors.data !== undefined && vendors.data.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th>{t("materialsVendors.code")}</th>
                <th>{t("materialsVendors.legalName")}</th>
                <th>{t("materialsVendors.status")}</th>
                <th>{t("materialsVendors.bank")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {vendors.data.map((v: WireVendor) => (
                <tr key={v.id} className="border-t">
                  <td>{v.code}</td>
                  <td>{v.legalName}</td>
                  <td>
                    {t(`materialsVendors.status_${v.status}`)}
                    {v.status === "blacklisted" && v.blacklistUntil !== null && (
                      <span className="ml-2 text-xs text-slate-500">
                        {t("materialsVendors.blacklistUntil", { date: v.blacklistUntil.slice(0, 10) })}
                      </span>
                    )}
                  </td>
                  {/* Already masked by the server (A7). Nothing here unmasks and nothing can. */}
                  <td>{v.bank === null ? t("materialsVendors.noBank") : v.bank.accountNo}</td>
                  <td className="space-x-2">
                    <Button variant="secondary" onClick={() => setSelected(v.id)}>
                      {t("materialsVendors.open")}
                    </Button>
                    {v.status === "draft" || v.status === "suspended" ? (
                      <Button onClick={() => void run(
                        () => activateVendor(v.id), t("materialsVendors.activated", { code: v.code }),
                      )}>
                        {t("materialsVendors.activate")}
                      </Button>
                    ) : null}
                    {v.status === "active" && (
                      <Button variant="secondary" onClick={() => void run(
                        () => suspendVendor(v.id, suspendReason.trim() === "" ? "under review" : suspendReason.trim()),
                        t("materialsVendors.suspended", { code: v.code }),
                      )}>
                        {t("materialsVendors.suspend")}
                      </Button>
                    )}
                    {v.status === "blacklisted" && (
                      <Button variant="secondary" onClick={() => void run(
                        () => reinstateVendor(v.id), t("materialsVendors.reinstated", { code: v.code }),
                      )}>
                        {t("materialsVendors.reinstate")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected !== null && detail.data !== undefined && (
        <section className="space-y-4 rounded border p-4">
          <h2 className="font-medium">{detail.data.vendor.legalName}</h2>

          <div>
            <h3 className="text-sm font-medium">{t("materialsVendors.documents")}</h3>
            {detail.data.documents.length === 0
              ? <p className="text-sm text-slate-500">{t("materialsVendors.noDocuments")}</p>
              : (
                <ul className="text-sm">
                  {detail.data.documents.map((d) => (
                    <li key={d.id}>
                      {d.type} · {d.number}
                      {d.validTo !== null && ` · ${t("materialsVendors.validTo", { date: d.validTo })}`}
                    </li>
                  ))}
                </ul>
              )}
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <select className="rounded border px-2 py-1 text-sm" value={docType} onChange={(e) => setDocType(e.target.value)}>
                {["gst_certificate", "pan", "drug_licence_20b", "drug_licence_21b", "consignment_agreement", "udyam", "cancelled_cheque"]
                  .map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <input
                className="rounded border px-2 py-1 text-sm" placeholder={t("materialsVendors.documentNumber")}
                value={docNumber} onChange={(e) => setDocNumber(e.target.value)}
              />
              <input
                className="rounded border px-2 py-1 text-sm" placeholder={t("materialsVendors.validToPlaceholder")}
                value={docValidTo} onChange={(e) => setDocValidTo(e.target.value)}
              />
            </div>
            <Button
              className="mt-2"
              onClick={() => void run(async () => {
                await addVendorDocument(selected, {
                  type: docType, number: docNumber.trim(),
                  ...(docValidTo.trim() === "" ? {} : { validTo: docValidTo.trim() }),
                });
                setDocNumber(""); setDocValidTo("");
              }, t("materialsVendors.documentAdded"))}
            >
              {t("materialsVendors.addDocument")}
            </Button>
          </div>

          {/* O-11: a closed list, and three years. A separate control, never a lifecycle button. */}
          <div className="rounded border border-red-200 p-3">
            <h3 className="text-sm font-medium text-red-700">{t("materialsVendors.blacklist")}</h3>
            <p className="text-xs text-slate-500">{t("materialsVendors.blacklistHint")}</p>
            <div className="mt-2 flex gap-2">
              <select
                className="rounded border px-2 py-1 text-sm" value={blacklistReason}
                onChange={(e) => setBlacklistReason(e.target.value)}
                aria-label={t("materialsVendors.blacklistReason")}
              >
                {["quality_failure", "regulatory_breach", "integrity_breach", "chronic_non_supply"]
                  .map((r) => <option key={r} value={r}>{t(`materialsVendors.reason_${r}`)}</option>)}
              </select>
              <Button
                variant="secondary"
                onClick={() => void run(
                  async () => { await blacklistVendor(selected, blacklistReason); },
                  t("materialsVendors.blacklisted"),
                )}
              >
                {t("materialsVendors.blacklistAction")}
              </Button>
            </div>
          </div>

          <label className="flex flex-col gap-1 text-sm sm:max-w-sm">
            {t("materialsVendors.suspendReason")}
            <input
              className="rounded border px-2 py-1" value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
            />
          </label>

          <Button variant="secondary" onClick={() => setSelected(null)}>{t("materialsVendors.close")}</Button>
        </section>
      )}
    </div>
  );
}
