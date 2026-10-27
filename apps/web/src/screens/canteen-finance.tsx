import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import {
  approveVarianceApi, canteenRefusal, createCategoryApi, downloadDeductions, fetchCanteenDay, fetchCanteenMonth, fetchCanteenSetup, fetchDeductions,
  issueCardApi, issueRentApi, rupees, setStaffRuleApi,
} from "../lib/canteen-api";
import { todayIst } from "../lib/opd-api";
import type { CanteenStaffGst, CanteenStaffPriceBasis } from "@hmis/contracts";
import "./canteen.css";

/**
 * ═══ CN-1 CANTEEN (issue #977) — FINANCE (canteen.finance, the billing manager) ═══
 *
 * Staff meal rules, one row per category (D2: a new row changes the next sale, never a past one); meal cards; till
 * variances waiting (never the cashier's own); the caterer's monthly rent invoice at 18% (D6); the month: in-house
 * income, caterer rent, family meals (D5, D7); and the payroll deduction list as a CSV. Family meals are decided on the
 * approvals worklist like every other approval.
 */
const BASES: readonly CanteenStaffPriceBasis[] = ["free", "staff", "subsidised", "public"];

function thisMonth(): string { return todayIst().slice(0, 7); }

export function CanteenFinance(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const setup = useQuery({ queryKey: ["canteen", "setup"], queryFn: fetchCanteenSetup });
  const [month, setMonth] = useState(thisMonth());
  const [date, setDate] = useState(todayIst());
  const monthQ = useQuery({ queryKey: ["canteen", "month", month], queryFn: () => fetchCanteenMonth(month) });
  const deductions = useQuery({ queryKey: ["canteen", "deductions", month], queryFn: () => fetchDeductions(month) });
  const day = useQuery({ queryKey: ["canteen", "day", date], queryFn: () => fetchCanteenDay(date) });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const done = (key: string) => () => { setNotice({ ok: true, text: t(key) }); void qc.invalidateQueries({ queryKey: ["canteen"] }); };
  const fail = (e: unknown) => setNotice({ ok: false, text: t(`canteen.refusal.${canteenRefusal(e) ?? "failed"}`, { defaultValue: t("canteen.refusal.failed") }) });

  const [cat, setCat] = useState({ code: "", name: "" });
  const [rule, setRule] = useState({ categoryId: "", priceBasis: "staff" as CanteenStaffPriceBasis, dailyCap: 2, nightMeal: false, salaryDeduction: true, gst: "not_supply" as CanteenStaffGst });
  const [card, setCard] = useState({ username: "", categoryId: "", staffCode: "" });
  const [varNote, setVarNote] = useState("");
  const addCat = useMutation({ mutationFn: () => createCategoryApi(cat.code, cat.name), onSuccess: done("canteen.finance.saved"), onError: fail });
  const saveRule = useMutation({ mutationFn: () => setStaffRuleApi(rule), onSuccess: done("canteen.finance.ruleSaved"), onError: fail });
  const issueCard = useMutation({ mutationFn: () => issueCardApi(card), onSuccess: done("canteen.finance.cardIssued"), onError: fail });
  const approve = useMutation({ mutationFn: (sessionId: string) => approveVarianceApi(sessionId, varNote), onSuccess: done("canteen.finance.varianceApproved"), onError: fail });
  const rent = useMutation({ mutationFn: (outletId: string) => issueRentApi(outletId, month), onSuccess: (r) => { setNotice({ ok: true, text: t("canteen.finance.rentIssued", { no: r.invoiceNo, amount: rupees(r.totalPaise) }) }); void qc.invalidateQueries({ queryKey: ["canteen"] }); }, onError: fail });

  const categories = setup.data?.staffCategories ?? [];
  const pending = (day.data?.tills ?? []).flatMap((x) => x.sessions.filter((s) => s.state === "variance_pending").map((s) => ({ ...s, tillCode: x.tillCode })));
  const caterers = (setup.data?.outlets ?? []).filter((o) => o.kind === "caterer");

  return (
    <PaperScreen testId="canteen-finance">
      <div className="cn-page">
        <header className="cn-head"><h1>{t("canteen.finance.title")}</h1>
          <label className="cn-row">{t("canteen.finance.month")}<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
        </header>
        {notice !== null && <p role="alert" className={notice.ok ? "cn-notice ok" : "cn-notice"} data-testid="cn-notice">{notice.text}</p>}
        <div className="cn-grid">
          <section className="box cn-card" data-testid="cn-month">
            <h2>{t("canteen.finance.monthFigures")}</h2>
            <dl className="cn-kv">
              <dt>{t("canteen.finance.income")}</dt><dd>{rupees(monthQ.data?.salesPaise ?? 0)}</dd>
              <dt>{t("canteen.finance.rent")}</dt><dd>{rupees(monthQ.data?.rentPaise ?? 0)}</dd>
              <dt>{t("canteen.finance.familyMeals")}</dt><dd>{monthQ.data?.charity.meals ?? 0} · {rupees(monthQ.data?.charity.valuePaise ?? 0)}</dd>
            </dl>
            {caterers.map((o) => (
              <button key={o.outletId} type="button" className="cn-btn" disabled={rent.isPending} onClick={() => rent.mutate(o.outletId)} data-testid={`cn-rent-${o.code}`}>
                {t("canteen.finance.issueRent", { outlet: o.name, amount: rupees(o.monthlyRentPaise ?? 0) })}
              </button>
            ))}
          </section>

          <section className="box cn-card">
            <h2>{t("canteen.finance.deductions")}</h2>
            <div className="cn-table-wrap">
              <table className="cn-table" data-testid="cn-deductions">
                <thead><tr><th>{t("canteen.finance.staffCode")}</th><th>{t("canteen.finance.meals")}</th><th>{t("canteen.finance.amount")}</th></tr></thead>
                <tbody>{(deductions.data ?? []).map((r) => <tr key={r.userId}><td>{r.staffCode}</td><td>{r.meals}</td><td>{rupees(r.amountPaise)}</td></tr>)}</tbody>
              </table>
            </div>
            <button type="button" className="cn-btn" onClick={() => void downloadDeductions(month)}>{t("canteen.finance.csv")}</button>
          </section>

          <section className="box cn-card">
            <h2 className="cn-row">{t("canteen.finance.variances")} <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t("canteen.close.day")} /></h2>
            {pending.length === 0 && <div className="cn-empty">{t("canteen.finance.noVariance")}</div>}
            {pending.length > 0 && <label>{t("canteen.till.note")}<input value={varNote} onChange={(e) => setVarNote(e.target.value)} /></label>}
            {pending.map((s) => (
              <div key={s.sessionId} className="cn-line">
                <span>{s.tillCode} · {t("canteen.close.expected")} {rupees(s.expectedCashPaise)} · {t("canteen.close.counted")} {rupees(s.countedCashPaise)}</span>
                <b className={s.variancePaise < 0 ? "cn-short" : undefined}>{rupees(s.variancePaise)}</b>
                <button type="button" className="cn-btn" disabled={varNote.trim().length < 3 || approve.isPending} onClick={() => approve.mutate(s.sessionId)}>{t("canteen.finance.approve")}</button>
              </div>
            ))}
          </section>

          <section className="box cn-card">
            <h2>{t("canteen.finance.categories")}</h2>
            <div className="cn-table-wrap">
              <table className="cn-table" data-testid="cn-rules">
                <thead><tr><th>{t("canteen.finance.category")}</th><th>{t("canteen.finance.price")}</th><th>{t("canteen.finance.cap")}</th><th>{t("canteen.finance.night")}</th><th>{t("canteen.finance.deduct")}</th><th>GST</th></tr></thead>
                <tbody>{categories.map((c) => (
                  <tr key={c.categoryId}><td>{c.name}</td>
                    {c.rule === null ? <td colSpan={5}>{t("canteen.finance.noRule")}</td> : <>
                      <td>{t(`canteen.basis.${c.rule.priceBasis}`)}</td><td>{c.rule.dailyCap}</td><td>{c.rule.nightMeal ? "✓" : "—"}</td>
                      <td>{c.rule.salaryDeduction ? "✓" : "—"}</td><td>{t(`canteen.staffGst.${c.rule.gst}`)}</td></>}
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="cn-form">
              <input placeholder={t("canteen.finance.code")} value={cat.code} onChange={(e) => setCat({ ...cat, code: e.target.value })} aria-label={t("canteen.finance.code")} />
              <input placeholder={t("canteen.finance.name")} value={cat.name} onChange={(e) => setCat({ ...cat, name: e.target.value })} aria-label={t("canteen.finance.name")} />
              <button type="button" className="cn-btn" disabled={cat.code.length < 2 || cat.name.length < 2} onClick={() => addCat.mutate()}>{t("canteen.finance.addCategory")}</button>
            </div>
            <h3>{t("canteen.finance.newRule")}</h3>
            <div className="cn-form">
              <select value={rule.categoryId} onChange={(e) => setRule({ ...rule, categoryId: e.target.value })} aria-label={t("canteen.finance.category")} data-testid="cn-rule-cat">
                <option value="">—</option>{categories.map((c) => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
              </select>
              <select value={rule.priceBasis} onChange={(e) => setRule({ ...rule, priceBasis: e.target.value as CanteenStaffPriceBasis })} aria-label={t("canteen.finance.price")}>
                {BASES.map((b) => <option key={b} value={b}>{t(`canteen.basis.${b}`)}</option>)}
              </select>
              <label>{t("canteen.finance.cap")}<input inputMode="numeric" value={String(rule.dailyCap)} onChange={(e) => setRule({ ...rule, dailyCap: Number(e.target.value.replace(/\D/g, "")) || 0 })} /></label>
              <label className="cn-check"><input type="checkbox" checked={rule.nightMeal} onChange={(e) => setRule({ ...rule, nightMeal: e.target.checked })} /> {t("canteen.finance.night")}</label>
              <label className="cn-check"><input type="checkbox" checked={rule.salaryDeduction} onChange={(e) => setRule({ ...rule, salaryDeduction: e.target.checked })} /> {t("canteen.finance.deduct")}</label>
              <select value={rule.gst} onChange={(e) => setRule({ ...rule, gst: e.target.value as CanteenStaffGst })} aria-label="GST">
                <option value="not_supply">{t("canteen.staffGst.not_supply")}</option><option value="taxable">{t("canteen.staffGst.taxable")}</option>
              </select>
              <button type="button" className="cn-btn" disabled={rule.categoryId === "" || saveRule.isPending} onClick={() => saveRule.mutate()} data-testid="cn-save-rule">{t("canteen.finance.saveRule")}</button>
            </div>
            <h3>{t("canteen.finance.card")}</h3>
            <div className="cn-form">
              <input placeholder={t("canteen.finance.username")} value={card.username} onChange={(e) => setCard({ ...card, username: e.target.value })} aria-label={t("canteen.finance.username")} />
              <select value={card.categoryId} onChange={(e) => setCard({ ...card, categoryId: e.target.value })} aria-label={t("canteen.finance.category")}>
                <option value="">—</option>{categories.map((c) => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
              </select>
              <input placeholder={t("canteen.finance.staffCode")} value={card.staffCode} onChange={(e) => setCard({ ...card, staffCode: e.target.value })} aria-label={t("canteen.finance.staffCode")} />
              <button type="button" className="cn-btn" disabled={card.username.length < 2 || card.categoryId === "" || card.staffCode === ""} onClick={() => issueCard.mutate()}>{t("canteen.finance.issueCard")}</button>
            </div>
          </section>
        </div>
      </div>
    </PaperScreen>
  );
}
