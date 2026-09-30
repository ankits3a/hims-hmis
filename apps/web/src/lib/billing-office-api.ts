import { api } from "./api";

/**
 * UX-AUDIT 2026-09-28 · BOARD — the billing back office's wire: the one ranked "needs you today" feed
 * (`GET /billing/office/needs`), deciding a settlement mismatch, paying a voucher, and the acting
 * cashier's own drawer. Shapes mirror `apps/core/src/modules/billing/office-needs.ts` and
 * `recon-resolve.ts`; money is integer paise, times are ISO instants, days are IST `YYYY-MM-DD`.
 */

export type NeedSource = "PAY" | "APPROVE" | "RECON" | "UNBILLED" | "DAY BOOK" | "GSTR-1";
export type NeedTone = "rd" | "gd" | "no";
export type NeedKind =
  | "recon_mismatch" | "recon_disputed" | "recon_missing"
  | "pay_voucher" | "approve_refund" | "refund_owner"
  | "unbilled_visit" | "daybook_paper" | "gstr1_due";

export type NeedPatient = { patientId: string; uhid: string; name: string | null; alias: string | null; restricted: boolean };
export type NeedParams = Record<string, string | number | boolean | null | string[]>;

export type WireNeedRow = {
  id: string;
  kind: NeedKind;
  source: NeedSource;
  state: "open" | "waiting";
  tier: number;
  since: string | null;
  ageMinutes: number | null;
  daysLeft: number | null;
  tone: NeedTone;
  patient: NeedPatient | null;
  params: NeedParams;
};

export type WireBillingNeeds = {
  asOf: string;
  day: string;
  rows: WireNeedRow[];
  money: { toPayPaise: number; toPayCount: number; shortPaise: number };
  limits: { reconChargeManagerMaxPaise: number; refundOwnerAbovePaise: number; reconTolerancePaise: number };
};

export function fetchBillingNeeds(): Promise<WireBillingNeeds> {
  return api<WireBillingNeeds>("GET", "/billing/office/needs");
}

export type ReconOutcome = "dispute" | "bank_charge" | "reupload";
export type WireResolveResult =
  | { status: "resolved"; tenderId: string; outcome: ReconOutcome; shortPaise: number; state: string; resolutionId: string }
  | { status: "awaiting_owner"; tenderId: string; outcome: "bank_charge"; shortPaise: number; approvalId: string };

export function resolveMismatch(tenderId: string, body: { outcome: ReconOutcome; reason: string }, idemKey?: string): Promise<WireResolveResult> {
  return api<WireResolveResult>("POST", `/billing/recon/mismatches/${encodeURIComponent(tenderId)}/resolve`, body, idemKey);
}

/**
 * OWNER RULING 2026-09-28 — Aadhaar is never stored. The payee is recorded by NAME and the TYPE of
 * document shown; this body has no place for a document number, so none can leave the browser.
 */
export type PayVoucherBody = { payeeName: string; payeeIdType: string };
export type WirePayResult = {
  voucherId: string; voucherNo: string; patientId: string; amountPaise: number;
  method: "cash" | "bank_transfer"; cashierSessionId: string | null; paidAt: string; status: "paid";
};

export function payVoucher(voucherId: string, body: PayVoucherBody, idemKey?: string): Promise<WirePayResult> {
  return api<WirePayResult>("POST", `/billing/refunds/${encodeURIComponent(voucherId)}/pay`, body, idemKey);
}

/**
 * The acting cashier's own drawer. OWNER RULING 2026-09-28 (blind count): the office never shows a
 * person their own drawer's expected cash, so this projection keeps only whether it is open and since
 * when — the expected figure the route carries is dropped here and never reaches a component.
 */
export type OwnDrawer = { open: boolean; openedAt: string | null };
export async function fetchOwnDrawer(): Promise<OwnDrawer> {
  const res = await api<{ session: { status?: string; openedAt?: string } | null }>("GET", "/billing/sessions/current");
  const s = res.session;
  if (s === null || s.status !== "open") return { open: false, openedAt: null };
  return { open: true, openedAt: typeof s.openedAt === "string" ? s.openedAt : null };
}

// ——— the office's words for money and dates ———

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const IST_MS = 330 * 60_000;

/** `2026-09-28` → `28-Sep-2026`. A calendar day already in IST: no zone arithmetic. */
export function dayWords(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (m === null) return day;
  return `${m[3]!}-${MONTHS[Number(m[2]) - 1] ?? ""}-${m[1]!}`;
}

/** An instant → `28-Sep-2026 · 11:42` in IST, whatever the desk machine's zone. */
export function instantWords(iso: string | null | undefined, withTime = true): string {
  if (iso === null || iso === undefined) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const d = new Date(t + IST_MS);
  const day = `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()] ?? ""}-${String(d.getUTCFullYear())}`;
  if (!withTime) return day;
  return `${day} · ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** `2026-09` → `September`. */
export function monthWords(month: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null) return month;
  return new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)));
}
