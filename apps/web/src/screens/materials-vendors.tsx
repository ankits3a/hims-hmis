import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  activateVendor, addVendorDocument, blacklistVendor, createVendor, fetchVendor, fetchVendors,
  materialsErrorText, reinstateVendor, suspendVendor,
} from "../lib/materials-api";
import { Button } from "@/components/ui/button";
import { NewButton, OfficeHead, fieldCls, useNewKey } from "./pharmacy-office/office-page";
import { Sheet } from "./pharmacy-office/sheet";
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
/** A vendor's state as the board's pill. */
const VENDOR_PILL: Record<string, string> = { active: "pill on", draft: "pill gd", suspended: "pill gd", blacklisted: "pill rd" };

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
  /* GAP-CLOSURE B5 — registering a vendor is a sheet over the list (N); so is an opened vendor. */
  const [creating, setCreating] = useState(false);
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
      setError(materialsErrorText(e, t));
    }
  };

  const create = (): void => void run(async () => {
    await createVendor({
      code: code.trim(), legalName: legalName.trim(),
      ...(gstin.trim() === "" ? {} : { gstin: gstin.trim() }),
      ...(pan.trim() === "" ? {} : { pan: pan.trim() }),
    });
    setCode(""); setLegalName(""); setGstin(""); setPan("");
    setCreating(false);
  }, t("materialsVendors.created", { code: code.trim() }));

  /* GAP-CLOSURE B5 — one list, in the order a buyer needs it: usable first, then drafts, suspended, blacklisted. */
  const order: Record<string, number> = { active: 0, draft: 1, suspended: 2, blacklisted: 3 };
  const rows = [...(vendors.data ?? [])].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  const openNew = (): void => { setError(null); setDone(null); setCreating(true); };
  useNewKey(openNew);
  const inSheet = creating || (selected !== null && detail.data !== undefined);
  const feedback = (
    <>
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p role="status" className="text-sm text-green-700">{done}</p>}
    </>
  );

  return (
    <div className="space-y-4" data-testid="materials-vendors">
      <OfficeHead title={t("materialsVendors.title")} lead={t("materialsVendors.draftHint")}>
        <NewButton label={t("materialsVendors.newVendor")} onClick={openNew} testId="vendor-new" />
      </OfficeHead>

      {!inSheet && feedback}

      <input
        aria-label={t("materialsVendors.search")} placeholder={t("materialsVendors.searchHint")}
        className={`${fieldCls} ofp-search`} value={search} onChange={(e) => setSearch(e.target.value)}
      />

      <div className="ofp-box">
        {vendors.isLoading && <p className="ofp-empty">{t("common.loading")}</p>}
        {vendors.data !== undefined && vendors.data.length === 0 && <p className="ofp-empty">{t("materialsVendors.empty")}</p>}
        {rows.length > 0 && (
          <div className="ofp-scroll">
            <table className="ofp-table min-w-[48rem]">
              <thead>
                <tr>
                  <th>{t("materialsVendors.code")}</th>
                  <th>{t("materialsVendors.legalName")}</th>
                  <th>{t("materialsVendors.status")}</th>
                  <th>{t("materialsVendors.bank")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((v: WireVendor) => (
                  <tr key={v.id} className={v.status === "active" ? "" : "ofp-dim"}>
                    <td className="ofp-code">{v.code}</td>
                    <td>{v.legalName}</td>
                    <td>
                      <span className={VENDOR_PILL[v.status] ?? "pill"}>{t(`materialsVendors.status_${v.status}`)}</span>
                      {v.status === "blacklisted" && v.blacklistUntil !== null && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t("materialsVendors.blacklistUntil", { date: v.blacklistUntil.slice(0, 10) })}
                        </span>
                      )}
                    </td>
                    {/* Already masked by the server (A7). Nothing here unmasks and nothing can. */}
                    <td className="ofp-code">{v.bank === null ? t("materialsVendors.noBank") : v.bank.accountNo}</td>
                    <td>
                      <div className="ofp-rowacts">
                    <Button variant="outline" size="sm" onClick={() => { setError(null); setDone(null); setSelected(v.id); }}>
                      {t("materialsVendors.open")}
                    </Button>
                    {v.status === "draft" || v.status === "suspended" ? (
                      <Button size="sm" onClick={() => void run(
                        () => activateVendor(v.id), t("materialsVendors.activated", { code: v.code }),
                      )}>
                        {t("materialsVendors.activate")}
                      </Button>
                    ) : null}
                    {v.status === "active" && (
                      <Button variant="outline" size="sm" onClick={() => void run(
                        () => suspendVendor(v.id, suspendReason.trim() === "" ? "under review" : suspendReason.trim()),
                        t("materialsVendors.suspended", { code: v.code }),
                      )}>
                        {t("materialsVendors.suspend")}
                      </Button>
                    )}
                    {v.status === "blacklisted" && (
                      <Button variant="outline" size="sm" onClick={() => void run(
                        () => reinstateVendor(v.id), t("materialsVendors.reinstated", { code: v.code }),
                      )}>
                        {t("materialsVendors.reinstate")}
                      </Button>
                    )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && (
        <Sheet title={t("materialsVendors.newVendor")} testId="vendor-new-sheet" onClose={() => setCreating(false)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create(); }}>
            {feedback}
            <p className="text-xs text-muted-foreground">{t("materialsVendors.draftHint")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsVendors.code")}
            <input className={fieldCls} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsVendors.legalName")}
            <input className={fieldCls} value={legalName} onChange={(e) => setLegalName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsVendors.gstin")}
            <input className={fieldCls} value={gstin} onChange={(e) => setGstin(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsVendors.pan")}
            <input className={fieldCls} value={pan} onChange={(e) => setPan(e.target.value)} />
          </label>
        </div>
            <Button type="submit">{t("materialsVendors.create")}</Button>
          </form>
        </Sheet>
      )}

      {selected !== null && detail.data !== undefined && (
        <Sheet title={detail.data.vendor.legalName} testId="vendor-sheet" onClose={() => setSelected(null)}>
        <div className="space-y-4">
          {feedback}
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
              <select className={fieldCls} value={docType} onChange={(e) => setDocType(e.target.value)}>
                {["gst_certificate", "pan", "drug_licence_20b", "drug_licence_21b", "consignment_agreement", "udyam", "cancelled_cheque"]
                  .map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <input
                className={fieldCls} placeholder={t("materialsVendors.documentNumber")}
                value={docNumber} onChange={(e) => setDocNumber(e.target.value)}
              />
              <input
                className={fieldCls} placeholder={t("materialsVendors.validToPlaceholder")}
                value={docValidTo} onChange={(e) => setDocValidTo(e.target.value)}
              />
            </div>
            <Button
              className="mt-2" variant="outline"
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
                className={fieldCls} value={blacklistReason}
                onChange={(e) => setBlacklistReason(e.target.value)}
                aria-label={t("materialsVendors.blacklistReason")}
              >
                {["quality_failure", "regulatory_breach", "integrity_breach", "chronic_non_supply"]
                  .map((r) => <option key={r} value={r}>{t(`materialsVendors.reason_${r}`)}</option>)}
              </select>
              <Button
                variant="destructive"
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
              className={fieldCls} value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
            />
          </label>
          {/* B5 — the reason typed here is the one Suspend sends, so the act sits beside it (same call as the list's). */}
          {detail.data.vendor.status === "active" && (
            <Button variant="outline" onClick={() => void run(
              () => suspendVendor(selected, suspendReason.trim() === "" ? "under review" : suspendReason.trim()),
              t("materialsVendors.suspended", { code: detail.data?.vendor.code ?? "" }),
            )}>
              {t("materialsVendors.suspend")}
            </Button>
          )}

        </div>
        </Sheet>
      )}
    </div>
  );
}
