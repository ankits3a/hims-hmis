import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { billingErrorMessage } from "../../lib/billing-api";

/**
 * ═══ THE HOSPITAL'S UPI ID (owner 2026-10-09) ═══
 *
 * *"UPI link and QR to the hospital's UPI id."* Two fields beside the fee switches, on the same
 * permission (`billing.config.write`): the id a payer's app pays, and the name it shows. With an id
 * set, the desk's Collect sheet for a tele-call draws a QR for the exact amount; with none it does
 * not, and the desk collects at the counter only. No payment company is involved and nothing is
 * confirmed automatically — the cashier still sees the money and types its reference.
 */
type UpiConfig = { upiVpa: string | null; upiPayeeName: string | null };

export function UpiPayee(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["billing", "config", "upi"], queryFn: () => api<UpiConfig>("GET", "/billing/config"), retry: false });
  const [vpa, setVpa] = useState("");
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (q.data === undefined) return;
    setVpa(q.data.upiVpa ?? ""); setName(q.data.upiPayeeName ?? "");
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<UpiConfig>("PUT", "/billing/config", { upiVpa: vpa.trim() === "" ? null : vpa.trim(), upiPayeeName: name.trim() === "" ? null : name.trim() }),
    onSuccess: (saved) => {
      qc.setQueryData(["billing", "config", "upi"], saved);
      setNotice(t(saved.upiVpa === null ? "upiPayee.cleared" : "upiPayee.saved"));
    },
  });
  const mayChange = can("billing.config.write");
  const shapeOk = vpa.trim() === "" || /^[a-zA-Z0-9._-]{2,60}@[a-zA-Z0-9]{2,40}$/.test(vpa.trim());

  return (
    <div className="mt-6 space-y-3 rounded-lg border bg-white p-3" data-testid="upi-payee">
      <div className="text-sm font-medium">{t("upiPayee.title")}</div>
      <p className="text-sm text-muted-foreground">{t("upiPayee.lead")}</p>
      {save.error !== null && <p role="alert" className="text-sm text-red-600">{billingErrorMessage(save.error)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm font-medium" htmlFor="upi-vpa">{t("upiPayee.vpa")}</label>
          <input id="upi-vpa" data-testid="upi-vpa" className="w-64 rounded border px-2 py-1 font-mono text-sm" autoComplete="off" spellCheck={false} placeholder="hospital@bank"
            value={vpa} disabled={!mayChange || save.isPending} aria-invalid={!shapeOk} onChange={(e) => { setVpa(e.target.value); setNotice(null); }} />
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="upi-name">{t("upiPayee.name")}</label>
          <input id="upi-name" data-testid="upi-name" className="w-72 rounded border px-2 py-1 text-sm" autoComplete="off" maxLength={40}
            value={name} disabled={!mayChange || save.isPending} onChange={(e) => { setName(e.target.value); setNotice(null); }} />
        </div>
        <button type="button" data-testid="upi-save" className="h-9 rounded-md border border-emerald-800 bg-emerald-800 px-3 text-sm font-medium text-white disabled:opacity-60"
          disabled={!mayChange || !shapeOk || save.isPending} onClick={() => { save.mutate(); }}>
          {t("upiPayee.save")}
        </button>
      </div>
      {!shapeOk && <p className="text-sm text-red-600" data-testid="upi-shape">{t("upiPayee.shape")}</p>}
    </div>
  );
}
