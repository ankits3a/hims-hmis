import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import {
  billingErrorCode, billingErrorMessage, changeConsultPricesNow, CONSULT_BRANCHES, decideConsultPrices, fetchConsultPrices,
  proposeConsultPrices,
} from "../../lib/billing-api";
import { fmtPaise } from "../../lib/format";
import type { ConsultBranch, WireConsultPrices } from "../../lib/billing-api";

/**
 * ═══ THE CONSULTATION PRICE LIST (owner, 2026-10-05) ═══
 *
 * *"Build a price list in billing screen so that I could change values from there. Revisit charge,
 * New and Renewal charges."* One row per consultation fee with the price in force. A change is a
 * tariff version. OWNER RULING 2026-10-05 (money): *"The billing manager, admin can approve or admin
 * can change it directly."* So the billing manager (`billing.config.write`) sends a change for
 * approval, and the admin — the holder of `tariff.versions.activate`, the owner role — approves it
 * (never their own) or changes the prices directly with a reason. The Fees switch still decides
 * whether a consultation is charged at all.
 */
const KEY = ["billing", "consult-prices"] as const;

const istWhen = (iso: string): string =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** "100", "100.5", "1,250.00" → paise; null when it is not a sum of money. */
export function rupeesToPaise(text: string): number | null {
  const clean = text.replace(/[₹,\s]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, frac = ""] = clean.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
const paiseToRupeesText = (paise: number | null): string => (paise === null ? "" : paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));

export function ConsultPrices(): React.ReactElement {
  const { t } = useTranslation();
  const { can, actor, ready } = useAuth();
  const qc = useQueryClient();
  const mayRead = can("billing.reports.read");
  // The admin changes directly; a billing manager sends for approval; anyone else reads.
  const mayDirect = can("tariff.versions.activate");
  const mode: "direct" | "propose" | null = mayDirect ? "direct" : can("billing.config.write") ? "propose" : null;
  const q = useQuery({ queryKey: KEY, queryFn: fetchConsultPrices, enabled: mayRead });
  const [notice, setNotice] = useState<string | null>(null);

  const after = async (view: WireConsultPrices, message: string): Promise<void> => {
    qc.setQueryData(KEY, view);
    setNotice(message);
    // Every open quote priced under the old list is now wrong.
    await qc.invalidateQueries({ predicate: (query) => query.queryKey[0] !== KEY[0] || query.queryKey[1] !== KEY[1] });
  };
  const propose = useMutation({ mutationFn: proposeConsultPrices, onSuccess: (view) => after(view, t("consultPrices.sent")) });
  const now = useMutation({ mutationFn: changeConsultPricesNow, onSuccess: (view) => after(view, t("consultPrices.changed")) });
  const decide = useMutation({
    mutationFn: (v: { versionId: string; approve: boolean; note: string }) => decideConsultPrices(v.versionId, { approve: v.approve, note: v.note }),
    onSuccess: (view, v) => after(view, t(v.approve ? "consultPrices.approved" : "consultPrices.rejected")),
  });

  const error = q.error ?? propose.error ?? now.error ?? decide.error;
  const errorText = (e: unknown): string => {
    const code = billingErrorCode(e);
    return code !== null && t(`consultPrices.refusal.${code}`, { defaultValue: "" }) !== "" ? t(`consultPrices.refusal.${code}`) : billingErrorMessage(e);
  };

  if (!ready) return <div data-testid="consult-prices" />;
  if (!mayRead) {
    return <p className="text-sm text-muted-foreground" data-testid="consult-prices-noaccess">{t("consultPrices.noAccess")}</p>;
  }
  const view = q.data;
  return (
    <div className="space-y-4" data-testid="consult-prices">
      <p className="text-sm text-muted-foreground">{t("consultPrices.lead")}</p>
      <p className="text-sm" data-testid="consult-prices-rule">{t(`consultPrices.rule.${mode ?? "read"}`)}</p>
      {error !== null && <p role="alert" className="text-sm text-red-600" data-testid="consult-prices-error">{errorText(error)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {view === undefined ? null : (
        <>
          {view.pending !== null && (
            <PendingCard
              view={view} mine={actor?.id === view.pending.proposedBy.id} mayDecide={mayDirect}
              busy={decide.isPending}
              onDecide={(approve, note) => { setNotice(null); decide.mutate({ versionId: view.pending!.versionId, approve, note }); }}
            />
          )}
          <PriceCard
            key={`${view.activeVersionNo ?? "none"}-${view.pending?.versionId ?? "none"}`}
            view={view} mode={view.pending === null ? mode : null} busy={propose.isPending || now.isPending}
            onSubmit={(prices, note) => {
              setNotice(null);
              if (mode === "direct") now.mutate({ prices, note });
              else propose.mutate({ prices, ...(note === "" ? {} : { note }) });
            }}
          />
        </>
      )}
    </div>
  );
}

function PriceCard(props: {
  view: WireConsultPrices;
  /** `direct` — the admin's Change now (a reason required); `propose` — Send for approval; null — read only. */
  mode: "direct" | "propose" | null;
  busy: boolean;
  onSubmit: (prices: Partial<Record<ConsultBranch, number>>, note: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { view } = props;
  const editable = props.mode !== null;
  const initial = Object.fromEntries(view.rows.map((r) => [r.branch, paiseToRupeesText(r.activePaise)])) as Record<ConsultBranch, string>;
  const [text, setText] = useState<Record<ConsultBranch, string>>(initial);
  const [note, setNote] = useState("");
  const [bad, setBad] = useState<ConsultBranch | null>(null);

  const changed = view.rows.flatMap((r) => {
    if (r.serviceId === null) return [];
    const paise = rupeesToPaise(text[r.branch]);
    return paise !== null && paise !== r.activePaise ? [[r.branch, paise] as const] : [];
  });
  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const wrong = view.rows.find((r) => r.serviceId !== null && text[r.branch].trim() !== "" && rupeesToPaise(text[r.branch]) === null);
    if (wrong !== undefined) { setBad(wrong.branch); return; }
    setBad(null);
    props.onSubmit(Object.fromEntries(changed), note.trim());
  };

  return (
    <form className="rounded-lg border bg-white" data-testid="consult-prices-list" onSubmit={submit}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b p-3 sm:flex-nowrap">
        <div className="min-w-0 flex-1 text-sm font-medium">
          {t("consultPrices.inForce")}
          {view.activeVersionNo !== null && <span className="ml-2 text-xs font-normal text-muted-foreground">{t("consultPrices.version", { no: view.activeVersionNo })}</span>}
        </div>
        <div className="hidden w-28 shrink-0 text-right text-xs text-muted-foreground sm:block">{t("consultPrices.colNow")}</div>
        {editable && <div className="hidden w-36 shrink-0 text-right text-xs text-muted-foreground sm:block">{t("consultPrices.colNew")}</div>}
      </div>
      {CONSULT_BRANCHES.map((branch) => {
        const row = view.rows.find((r) => r.branch === branch)!;
        const unwired = row.serviceId === null;
        const free = row.activePaise === null || row.activePaise === 0;
        return (
          <div key={branch} className="flex flex-wrap items-center gap-3 border-b p-3 last:border-b-0 sm:flex-nowrap" data-testid={`consult-price-${branch}`}>
            <div className="min-w-0 flex-1 space-y-1">
              <label className="text-sm font-medium" htmlFor={`consult-price-${branch}-input`}>{t(`consultPrices.${branch}.label`)}</label>
              <p className="text-sm text-muted-foreground">{t(`consultPrices.${branch}.note`)}</p>
            </div>
            <div className="w-28 shrink-0 text-right text-sm font-medium tabular-nums" data-testid={`consult-price-${branch}-active`}>
              {unwired ? t("consultPrices.notSetUp") : free && branch === "revisit" ? t("consultPrices.free") : row.activePaise === null ? t("consultPrices.unpriced") : fmtPaise(row.activePaise)}
            </div>
            {editable && (
              <div className="flex w-full items-center gap-1 sm:w-36">
                <span aria-hidden className="text-sm text-muted-foreground sm:hidden">{t("consultPrices.colNew")}</span>
                <span aria-hidden className="ml-auto text-sm text-muted-foreground sm:ml-0">₹</span>
                <input
                  id={`consult-price-${branch}-input`} data-testid={`consult-price-${branch}-input`}
                  inputMode="decimal" autoComplete="off" disabled={unwired || props.busy}
                  aria-invalid={bad === branch} aria-label={t("consultPrices.newPrice", { what: t(`consultPrices.${branch}.label`) })}
                  value={text[branch]} onChange={(e) => setText({ ...text, [branch]: e.target.value })}
                  className={`h-9 w-32 rounded-md border bg-background px-2 text-right text-sm tabular-nums sm:w-full ${bad === branch ? "border-red-600" : ""}`}
                />
              </div>
            )}
          </div>
        );
      })}
      {bad !== null && <p role="alert" className="px-3 pt-2 text-sm text-red-600">{t("consultPrices.badAmount")}</p>}
      {editable && (
        <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 space-y-1 text-sm">
            <span className="block text-muted-foreground">{t(props.mode === "direct" ? "consultPrices.reasonLabel" : "consultPrices.noteLabel")}</span>
            <input
              data-testid="consult-prices-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} disabled={props.busy}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm" placeholder={t("consultPrices.notePlaceholder")}
            />
          </label>
          <button
            type="submit" data-testid={props.mode === "direct" ? "consult-prices-now" : "consult-prices-send"}
            disabled={props.busy || changed.length === 0 || (props.mode === "direct" && note.trim() === "")}
            className="h-9 shrink-0 rounded-md border border-emerald-800 bg-emerald-800 px-4 text-sm font-medium text-white disabled:opacity-50"
          >
            {t(props.mode === "direct" ? "consultPrices.changeNow" : "consultPrices.send")}
          </button>
        </div>
      )}
    </form>
  );
}

function PendingCard(props: {
  view: WireConsultPrices;
  mine: boolean;
  mayDecide: boolean;
  busy: boolean;
  onDecide: (approve: boolean, note: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const p = props.view.pending!;
  const [note, setNote] = useState("");
  const granted = p.approvalStatus === "granted";
  const show = (paise: number | null, branch: ConsultBranch): string =>
    branch === "revisit" && (paise === null || paise === 0) ? t("consultPrices.free") : paise === null ? t("consultPrices.unpriced") : fmtPaise(paise);
  const canAct = props.mayDecide && !props.mine;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50" data-testid="consult-prices-pending">
      <div className="space-y-1 border-b border-amber-200 p-3">
        <div className="text-sm font-medium">{t(granted ? "consultPrices.pending.grantedTitle" : "consultPrices.pending.title")}</div>
        <p className="text-sm" data-testid="consult-prices-proposer">
          {t("consultPrices.pending.by", { name: p.proposedBy.name ?? p.proposedBy.id, when: p.proposedAt === null ? "—" : istWhen(p.proposedAt) })}
        </p>
        {p.note !== null && <p className="text-sm text-muted-foreground">“{p.note}”</p>}
      </div>
      <div className="flex items-center gap-x-3 border-b border-amber-200 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1" />
        <span className="w-20 text-right">{t("consultPrices.colNow")}</span>
        <span aria-hidden>→</span>
        <span className="w-24 text-right">{t("consultPrices.colProposed")}</span>
      </div>
      {CONSULT_BRANCHES.map((branch) => {
        const now = props.view.rows.find((r) => r.branch === branch)!.activePaise;
        const next = p.prices[branch];
        const moved = next !== now;
        return (
          <div key={branch} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 px-3 py-2 text-sm" data-testid={`consult-pending-${branch}`}>
            <span className="min-w-0 flex-1">{t(`consultPrices.${branch}.label`)}</span>
            <span className="w-20 text-right tabular-nums text-muted-foreground">{show(now, branch)}</span>
            <span aria-hidden className="text-muted-foreground">→</span>
            <span className={`w-24 text-right tabular-nums ${moved ? "font-semibold" : "text-muted-foreground"}`}>{show(next, branch)}</span>
          </div>
        );
      })}
      <div className="space-y-2 p-3">
        {canAct ? (
          <>
            <label className="block space-y-1 text-sm">
              <span className="block text-muted-foreground">{t("consultPrices.pending.noteLabel")}</span>
              <input
                data-testid="consult-decision-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} disabled={props.busy}
                className="h-9 w-full rounded-md border bg-white px-2 text-sm" placeholder={t("consultPrices.pending.notePlaceholder")}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button" data-testid="consult-approve" disabled={props.busy || note.trim() === ""}
                onClick={() => props.onDecide(true, note.trim())}
                className="h-9 rounded-md border border-emerald-800 bg-emerald-800 px-4 text-sm font-medium text-white disabled:opacity-50"
              >
                {t(granted ? "consultPrices.pending.putInUse" : "consultPrices.pending.approve")}
              </button>
              {!granted && (
                <button
                  type="button" data-testid="consult-reject" disabled={props.busy || note.trim() === ""}
                  onClick={() => props.onDecide(false, note.trim())}
                  className="h-9 rounded-md border bg-white px-4 text-sm font-medium disabled:opacity-50"
                >
                  {t("consultPrices.pending.reject")}
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="consult-prices-waiting">
            {t(props.mine ? "consultPrices.pending.yours" : "consultPrices.pending.ownerDecides")}
          </p>
        )}
      </div>
    </div>
  );
}
