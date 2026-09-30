import type { TFunction } from "i18next";
import { billingPatientLabel } from "../../lib/billing-api";
import { dayWords, instantWords, monthWords } from "../../lib/billing-office-api";
import { fmtPaise } from "../../lib/format";
import type { NeedSource, WireNeedRow } from "../../lib/billing-office-api";

/**
 * UX-AUDIT 2026-09-28 · BOARD — how a row of the office's "needs you today" reads: money as ₹ with two
 * decimals, days as 28-Sep-2026, printed numbers (RFV/…, RCP/…) and names — never paise, ids or enum words.
 */

export const SRC_KEY: Record<NeedSource, string> = {
  PAY: "pay", APPROVE: "approve", RECON: "recon", UNBILLED: "unbilled", "DAY BOOK": "daybook", "GSTR-1": "gstr1",
};

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function patientOf(row: WireNeedRow): string {
  return row.patient === null ? "" : billingPatientLabel(row.patient);
}

export function methodWord(method: string, t: TFunction): string {
  return ["cash", "bank_transfer", "upi", "card"].includes(method) ? t(`billingOffice.method.${method}`) : method;
}

/** The variant of a mismatch row: owed less (short), owed more (over), with the owner, disputed. */
function reconVariant(row: WireNeedRow): "short" | "over" | "owner" | "disputed" {
  if (row.kind === "recon_disputed") return "disputed";
  if (row.params.ownerApproval === "pending") return "owner";
  return num(row.params.shortPaise) >= 0 ? "short" : "over";
}

export function needTitle(row: WireNeedRow, t: TFunction, locale = "en"): string {
  const p = row.params;
  switch (row.kind) {
    case "pay_voucher":
      return t("billingOffice.board.need.pay_voucher.title", { voucherNo: str(p.voucherNo), amount: fmtPaise(num(p.amountPaise)), method: methodWord(str(p.method), t).toLowerCase() });
    case "approve_refund":
      return t("billingOffice.board.need.approve_refund.title", { amount: fmtPaise(num(p.amountPaise)) });
    case "refund_owner":
      return t("billingOffice.board.need.refund_owner.title", { amount: fmtPaise(num(p.amountPaise)) });
    case "recon_mismatch": case "recon_disputed": {
      const v = reconVariant(row);
      return t(`billingOffice.board.need.recon.${v}`, {
        mode: methodWord(str(p.mode), t), receiptNo: str(p.receiptNo), amount: fmtPaise(Math.abs(num(p.shortPaise))),
      });
    }
    case "recon_missing":
      return t("billingOffice.board.need.recon_missing.title", { mode: methodWord(str(p.mode), t), day: dayWords(str(p.day)) });
    case "unbilled_visit":
      return t("billingOffice.board.need.unbilled_visit.title", { visitNo: str(p.visitNo) });
    case "daybook_paper":
      return t("billingOffice.board.need.daybook_paper.title", { count: num(p.count), day: dayWords(str(p.day)) });
    case "gstr1_due":
      return t("billingOffice.board.need.gstr1_due.title", { month: monthWords(str(p.month), locale), due: dayWords(str(p.due)) });
    default:
      return "";
  }
}

export function needSub(row: WireNeedRow, t: TFunction): string {
  const p = row.params;
  const who = patientOf(row);
  switch (row.kind) {
    case "pay_voucher":
      return p.approvedAt === null ? who : t("billingOffice.board.need.pay_voucher.sub", { patient: who, at: instantWords(str(p.approvedAt), false) });
    case "approve_refund": case "refund_owner":
      return str(p.note) === "" ? who : `${who} · ${str(p.note)}`;
    case "recon_mismatch": case "recon_disputed":
      return p.uploadedAt === null ? who : t("billingOffice.board.need.recon.sub", { patient: who, at: instantWords(str(p.uploadedAt), false) });
    case "recon_missing":
      return t("billingOffice.board.need.recon_missing.sub", { count: num(p.count), amount: fmtPaise(num(p.totalPaise)) });
    case "unbilled_visit":
      return `${who} · ${dayWords(str(p.serviceDate))}`;
    case "daybook_paper":
      return t("billingOffice.board.need.daybook_paper.sub", { amount: fmtPaise(num(p.totalPaise)) });
    case "gstr1_due":
      return t("billingOffice.board.need.gstr1_due.sub");
    default:
      return "";
  }
}

/** The pill: how long it has waited, or how long is left. */
export function clockText(row: WireNeedRow, t: TFunction): string {
  if (row.daysLeft !== null) return row.daysLeft <= 0 ? t("billingOffice.board.clock.due") : t("billingOffice.board.clock.d", { n: row.daysLeft });
  const m = row.ageMinutes ?? 0;
  if (m >= 24 * 60) return t("billingOffice.board.clock.d", { n: Math.floor(m / (24 * 60)) });
  if (row.kind === "unbilled_visit" || row.kind === "daybook_paper") return t("billingOffice.board.clock.today");
  if (m >= 60) return t("billingOffice.board.clock.h", { n: Math.floor(m / 60) });
  if (m < 1) return t("billingOffice.board.clock.now");
  return t("billingOffice.board.clock.m", { n: m });
}

export const pillCls = (row: WireNeedRow): string => (row.tone === "no" ? "pill" : `pill ${row.tone}`);

/** The printed number the lane shows beside the source chip. */
export function docOf(row: WireNeedRow): string {
  const p = row.params;
  return str(p.voucherNo) || str(p.receiptNo) || str(p.visitNo) || (row.kind === "gstr1_due" ? str(p.month) : "") || (row.kind === "recon_missing" || row.kind === "daybook_paper" ? dayWords(str(p.day)) : "");
}
