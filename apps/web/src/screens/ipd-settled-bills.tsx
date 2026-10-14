import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, newIdempotencyKey } from "../lib/api";
import { fmtPaise } from "../lib/format";
import { askBillVoid, getSettledBills, prepareSupplementaryBill, settleSupplementaryBill, voidBill } from "../lib/ipd-discharge-api";
import type React from "react";
import type { IpdDischargeBillDesk, IpdFinalBill, IpdSettledBill } from "@hmis/contracts";

/*
 * #763 — SETTLED BILLS on the bill desk: the settled IPD bills with an open question (and the last few days' bills), each
 * with its acts. "Supplementary bill" composes the charges after the settled bill (another night, services) and settles
 * them like the final bill — paid, or dues recorded against the signed undertaking (⚖ never a detention). "Void bill"
 * asks the billing manager's approval with a reason, then voids with it: a credit note, the claim withdrawn, the refund
 * cancelled, the running bill reopened. `ipd.discharge.bill` (billing staff) — the panel says nothing to anyone else.
 */

type Row = IpdDischargeBillDesk["rows"][number];
/** The exceptions that may hide charges after the bill: the act posts them (the settlement day once the stay ran past 14:00). */
const SUPP_PROMPTS: readonly Row["exceptions"][number][] = ["supplementary_owed", "settled_not_exited", "ended_after_bill"];
type Supp = { admissionId: string; bill: IpdFinalBill; cash: string; undertaking: string; key: string };

const rupeesToPaise = (s: string): number => {
  const n = Number(s.replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};

function billName(b: IpdSettledBill, t: (k: string, o?: Record<string, unknown>) => string): string {
  return b.kind === "final" ? t("ipdBillDesk.settled.finalBill") : t("ipdBillDesk.settled.supplementaryBill", { n: b.seq });
}

function VoidAct({ row, bill, onDone }: { row: Row; bill: IpdSettledBill; onDone: (msg: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = bill.voidApproval?.status ?? null;
  if (status === "pending") return <span className="dim small">{t("ipdBillDesk.settled.voidWaiting")}</span>;
  const granted = status === "granted";
  const go = (): void => {
    if (reason.trim() === "") { setError(t("ipdBillDesk.settled.reasonNeeded")); return; }
    setBusy(true);
    setError(null);
    const act = granted
      ? voidBill(row.admissionId, bill.billId, bill.voidApproval!.approvalId, reason.trim()).then(() => t("ipdBillDesk.settled.voided"))
      : askBillVoid(row.admissionId, bill.billId, reason.trim()).then(() => t("ipdBillDesk.settled.voidAsked"));
    act.then(onDone, (e: unknown) => setError(e instanceof ApiError && typeof e.body === "object" && e.body !== null && "code" in e.body
      ? t(`ipdBillDesk.settled.refusal.${String((e.body as { code: unknown }).code)}`, t("ipdBillDesk.settled.failed"))
      : t("ipdBillDesk.settled.failed"))).finally(() => setBusy(false));
  };
  if (!open) {
    return (
      <button type="button" className="ipdb-btn" onClick={() => setOpen(true)}>
        {granted ? t("ipdBillDesk.settled.voidBill") : t("ipdBillDesk.settled.askVoid")}
      </button>
    );
  }
  return (
    <span className="ipdsb-form">
      <label>
        <span className="sr">{t("ipdBillDesk.settled.reason")}</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("ipdBillDesk.settled.reason")} maxLength={500} />
      </label>
      <button type="button" className="ipdb-btn pri" disabled={busy} onClick={go}>
        {granted ? t("ipdBillDesk.settled.voidBill") : t("ipdBillDesk.settled.askVoid")}
      </button>
      {error === null ? null : <span role="alert" className="ipdbd-due small">{error}</span>}
    </span>
  );
}

export function IpdSettledBills(): React.ReactElement | null {
  const { t } = useTranslation();
  const [desk, setDesk] = useState<IpdDischargeBillDesk | null>(null);
  const [supp, setSupp] = useState<Supp | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback((): Promise<void> => getSettledBills().then((d) => setDesk(d), () => setDesk(null)), []);
  useEffect(() => { void load(); }, [load]);

  if (desk === null) return null;
  const done = (msg: string): void => { setNotice(msg); setSupp(null); void load(); };

  const openSupp = (admissionId: string): void => {
    setError(null);
    prepareSupplementaryBill(admissionId).then(
      (bill) => bill.lines.length === 0 ? setNotice(t("ipdBillDesk.settled.refusal.nothing_to_bill")) : setSupp({ admissionId, bill, cash: bill.balancePaise > 0 ? (bill.balancePaise / 100).toFixed(2) : "", undertaking: "", key: newIdempotencyKey() }),
      () => setError(t("ipdBillDesk.settled.failed")),
    );
  };

  const settle = (): void => {
    if (supp === null) return;
    const cash = rupeesToPaise(supp.cash);
    const balance = supp.bill.balancePaise;
    const dues = cash < balance;
    if (dues && supp.undertaking.trim() === "") { setError(t("ipdBillDesk.settled.undertakingNeeded")); return; }
    setBusy(true);
    setError(null);
    settleSupplementaryBill(supp.key, {
      admissionId: supp.admissionId, billVersion: supp.bill.billVersion, patientPayablePaise: supp.bill.patientPaise,
      settlement: dues ? "dues_recorded" : balance > 0 ? "paid" : "refund_due",
      payments: cash > 0 ? [{ tender: "cash", amountPaise: cash }] : [],
      ...(dues ? { undertakingDocumentId: supp.undertaking.trim() } : {}),
    }).then(
      (r) => done(t("ipdBillDesk.settled.suppSettled", { billNo: r.billNo })),
      () => setError(t("ipdBillDesk.settled.failed")),
    ).finally(() => setBusy(false));
  };

  return (
    <section className="ipdb-card ipdsb" aria-label={t("ipdBillDesk.settled.title")}>
      <h2>{t("ipdBillDesk.settled.title")}</h2>
      {notice === null ? null : <p role="status" className="ipdbd-notice">{notice}</p>}
      {error === null ? null : <p role="alert" className="ipdbd-due">{error}</p>}
      {desk.rows.length === 0 ? <p className="dim">{t("ipdBillDesk.settled.empty")}</p> : (
        <ul className="ipdsb-rows">
          {desk.rows.map((r) => {
            const newest = r.bills[r.bills.length - 1];
            return (
              <li key={r.admissionId} className="ipdsb-row">
                <div className="ipdsb-head">
                  <span className="mono strong">{r.admissionNo ?? r.admissionId}</span>
                  {r.exceptions.map((x) => <span key={x} className="ipdb-tag warn">{t(`ipdBillDesk.settled.exception.${x}`)}</span>)}
                </div>
                <ul className="ipdsb-bills">
                  {r.bills.map((b) => (
                    <li key={b.billId}>
                      <span>{billName(b, t)}</span>
                      <span className="mono dim">{b.billNo ?? "—"}</span>
                      <span className="num">{fmtPaise(b.patientPaise)}</span>
                      {b.duesPaise > 0 ? <span className="ipdbd-due">{t("ipdBillDesk.due", { amount: fmtPaise(b.duesPaise) })}</span> : null}
                      {b.billId === newest?.billId ? <VoidAct row={r} bill={b} onDone={done} /> : null}
                    </li>
                  ))}
                </ul>
                {SUPP_PROMPTS.some((x) => r.exceptions.includes(x)) && supp?.admissionId !== r.admissionId ? (
                  <button type="button" className="ipdb-btn" onClick={() => openSupp(r.admissionId)}>{t("ipdBillDesk.settled.supplementary")}</button>
                ) : null}
                {supp?.admissionId === r.admissionId ? (
                  <div className="ipdsb-supp" role="group" aria-label={t("ipdBillDesk.settled.supplementary")}>
                    <span>{t("ipdBillDesk.settled.suppLines", { count: supp.bill.lines.length })}</span>
                    <span>{t("ipdBillDesk.settled.suppPatient", { amount: fmtPaise(supp.bill.patientRoundedPaise) })}</span>
                    <span className="strong">{t("ipdBillDesk.settled.suppBalance", { amount: fmtPaise(Math.max(0, supp.bill.balancePaise)) })}</span>
                    <label>
                      {t("ipdBillDesk.settled.cash")}
                      <input inputMode="decimal" value={supp.cash} onChange={(e) => setSupp({ ...supp, cash: e.target.value })} />
                    </label>
                    <label>
                      {t("ipdBillDesk.settled.undertaking")}
                      <input value={supp.undertaking} onChange={(e) => setSupp({ ...supp, undertaking: e.target.value })} />
                    </label>
                    <button type="button" className="ipdb-btn pri" disabled={busy} onClick={settle}>{t("ipdBillDesk.settled.settle")}</button>
                    <button type="button" className="ipdb-btn" onClick={() => setSupp(null)}>{t("ipdBillDesk.settled.cancel")}</button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
