import { count, inArray, sql } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { grnLines, vendors } from "../../kernel/db/schema";
import { MaterialsError, listGrns } from "../materials";
import { istDateOf } from "./config";
import { CUSTODY_PERMISSION, LICENCES_PERMISSION } from "./controlled";
import { controlledToday } from "./controlled-office";
import { PharmacyError } from "./errors";
import { officePay, officeReturns, officeToday } from "./office";
import { listPharmacists } from "./pharmacists";
import { retailLicenceState } from "./retail";
import type { ControlledToday } from "./controlled-office";
import type { OfficePay, OfficeReturns, OfficeToday } from "./office";
import type { PharmacistView } from "./pharmacists";
import type { RetailLicenceState } from "./retail";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY GAP-CLOSURE B2 — THE OFFICE'S ONE "NEEDS YOU TODAY" LIST ═══
 *
 * The office board (owner-approved, 28 Sep) replaces seven tabs with one unfiltered list, most urgent
 * first: buying, paying, returns, stock, law and people. This FEDERATES — it owns no data and writes
 * nothing. Every side is the read the office already makes:
 *
 *   BUY    `officeToday`     — orders awaiting THIS person's approval, overdue, drafts, to receive, shortages
 *   PAY    `officePay`       — bills held for match, overdue and due-this-week payables (MSME first), runs
 *                              awaiting the owner's authorisation
 *   RETURN `officeReturns`   — credit notes awaited on dispatched returns, write-offs awaiting approval or
 *                              ready to post, open recalls
 *   STOCK  `officeReturns`'s expiry list; materials' GRNs at `gate_qc` (the opening-stock sheet's included,
 *                              challan `OPENING/…`)
 *   LAW    `retailLicenceState` (Form 20/21 missing, lapsed or inside 30 days) and `controlledToday` (the
 *                              cabinet's licences, check and acts)
 *   PEOPLE `listPharmacists` — a TRIAL-* registration, one inside 30 days, or one that has lapsed
 *
 * ═══ A SIDE THE PERSON MAY NOT READ IS ABSENT, NOT A REFUSAL ═══
 *
 * Each side is read only when the actor holds the grant its own route asks (`materials.po.raise` for
 * `/pharmacy/office/today`, `materials.bills.manage` for `/pay`, …), and a `permission_denied` from inside
 * the read (the materials readers check again) drops that side too. So the route itself needs no grant of
 * its own: somebody with none of them gets an empty list, never a 403 that hides the sides they do hold.
 *
 * ═══ CODES, NOT COPY ═══
 *
 * The office's reads return data and let the screen say it (`controlledToday.needsYou` is `{ key, params }`),
 * so a row here is a `kind` + `params`, a clock, facts and a ref; the screen renders the title, the sub-line,
 * the why and the two acts from `pharmacyOffice.today.need.<kind>.*` in the operator's language.
 *
 * ═══ THE RANKING ═══
 *
 * `tier` then `key` then `id`. Law lapsed or missing (0); law lapsing — the retail licence, a cabinet
 * licence, a pharmacist's registration (1, fewest days first); money deadlines — overdue payables and MSME
 * bills due this week (2); what waits on this person's decision — a PO, a payment run, a recall (3); held
 * bills, overdue orders, the cabinet's day (4); credit notes and write-offs to post, other bills due (5);
 * expiry and write-offs with the MS (6); pharmacists on a trial number (7); GRNs waiting for QC (8);
 * drafts, orders to receive and the short book (9).
 */
export const NEED_SOURCES = ["BUY", "PAY", "RETURN", "STOCK", "LAW", "PEOPLE"] as const;
export type NeedSource = (typeof NEED_SOURCES)[number];
export type NeedTone = "rd" | "gd" | "on" | "no";

/**
 * The row's clock. `days_left` counts down to a line; `days_late` / `days_ago` count up; `waited` is
 * minutes since it was put in front of somebody; the rest carry no number.
 */
export type NeedClock = {
  code: "days_left" | "days_late" | "days_ago" | "waited" | "window" | "today" | "open" | "draft" | "lapsed" | "missing";
  n?: number;
  tone: NeedTone;
};

/** One fact in the lane. `k` is an i18n key under `pharmacyOffice.today.fact`, or the text itself when `raw`. */
export type NeedFact = { k: string; raw?: true; v: string | number; as: "text" | "money" | "date" | "count" };

export type NeedRef = {
  kind:
    | "po" | "purchasePlan" | "grnDesk" | "bill" | "run" | "payRun" | "return" | "writeoff" | "recall" | "returnPlan"
    | "grn" | "retailLicence" | "cabinet" | "pharmacist";
  id: string | null;
};

export type NeedRow = {
  id: string;
  source: NeedSource;
  kind: string;
  params: Record<string, string | number>;
  clock: NeedClock;
  ref: NeedRef;
  facts: NeedFact[];
  tier: number;
};

/** What the copilot has drafted or would draft now — the same planners the office's cards read. */
export type NeedsCopilot = {
  po: OfficeToday["plan"] | null;
  pay: OfficePay["plan"] | null;
  returns: OfficeReturns["plan"] | null;
};

export type OfficeNeeds = {
  rows: NeedRow[];
  /** The sides this person was shown (a side with nothing today is still listed). */
  sides: NeedSource[];
  /** The header's money pill: accepted bills due in the plan's week and overdue; null without the pay side. */
  money: { dueThisWeekPaise: number; overduePaise: number; msmeDueThisWeek: number } | null;
  copilot: NeedsCopilot;
};

export type GrnAtQc = {
  id: string; grnNo: string; challanNo: string; vendorName: string; lines: number; createdAt: string;
};

/** Everything the list is built from; a `null` side was not read (no grant). */
export type NeedInputs = {
  buy: OfficeToday | null;
  pay: OfficePay | null;
  returns: OfficeReturns | null;
  grns: GrnAtQc[] | null;
  retail: RetailLicenceState | null;
  cabinet: ControlledToday | null;
  pharmacists: PharmacistView[] | null;
};

const DAY = 86_400_000;
const days = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const minutesSince = (iso: string | null, now: Date): number =>
  iso === null ? 0 : Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
const daysSince = (iso: string | null, now: Date): number => (iso === null ? 0 : Math.max(0, days(istDateOf(new Date(iso)), istDateOf(now))));

export const LAW_NOTICE_DAYS = 30;
const FACT_BILLS = 5;

type Ranked = NeedRow & { key: number };

/** The list, from what was read. Pure: the ranking and every row's shape are decided here. */
export function buildNeeds(input: NeedInputs, now: Date): OfficeNeeds {
  const today = istDateOf(now);
  const out: Ranked[] = [];
  const push = (r: Omit<Ranked, "facts"> & { facts?: NeedFact[] }): void => { out.push({ facts: [], ...r }); };

  // ── LAW: the retail licence (Form 20/21) ──
  const retail = input.retail;
  if (retail !== null && retail.state !== "no_store") {
    const l = retail.licence;
    const facts: NeedFact[] = l === null ? [] : [
      { k: "form20", v: l.form20No, as: "text" }, { k: "form21", v: l.form21No, as: "text" },
      { k: "validTo", v: l.validTo, as: "date" }, { k: "pharmacistInCharge", v: l.pharmacistInCharge, as: "text" },
    ];
    const ref: NeedRef = { kind: "retailLicence", id: l?.id ?? null };
    if (retail.state === "missing") {
      push({ id: "law:retail", source: "LAW", kind: "retail_licence_missing", params: {}, clock: { code: "missing", tone: "rd" }, ref, tier: 0, key: 0 });
    } else if (retail.state === "lapsed" || retail.state === "not_yet_valid") {
      push({ id: "law:retail", source: "LAW", kind: `retail_licence_${retail.state}`, params: { form20: l!.form20No, until: l!.validTo, from: l!.validFrom },
        clock: { code: "lapsed", tone: "rd" }, ref, facts, tier: 0, key: 0 });
    } else if (retail.daysLeft !== null && retail.daysLeft <= LAW_NOTICE_DAYS) {
      push({ id: "law:retail", source: "LAW", kind: "retail_licence_lapsing", params: { form20: l!.form20No, until: l!.validTo, days: retail.daysLeft },
        clock: { code: "days_left", n: retail.daysLeft, tone: "rd" }, ref, facts, tier: 1, key: retail.daysLeft });
    }
  }

  // ── LAW: the controlled-drug cabinet — its licences, then the rest of its day ──
  const cabinet = input.cabinet;
  if (cabinet !== null) {
    for (const s of Object.values(cabinet.licences)) {
      const facts: NeedFact[] = s.licence === null ? [] : [
        { k: "licenceNo", v: s.licence.licenceNo, as: "text" }, { k: "form", v: s.licence.form, as: "text" },
        { k: "validTo", v: s.licence.validUntil, as: "date" }, { k: "responsible", v: s.licence.responsiblePerson, as: "text" },
      ];
      const base = { id: `law:cabinet:${s.kind}`, source: "LAW" as const, ref: { kind: "cabinet" as const, id: s.licence?.id ?? null }, facts };
      if (s.state === "missing") push({ ...base, kind: "cabinet_licence_missing", params: { licence: s.kind }, clock: { code: "missing", tone: "rd" }, tier: 0, key: 0 });
      else if (s.state !== "current") {
        push({ ...base, kind: `cabinet_licence_${s.state}`, params: { licence: s.kind, until: s.licence?.validUntil ?? "" }, clock: { code: "lapsed", tone: "rd" }, tier: 0, key: 0 });
      } else if (s.renewalDue && s.daysLeft !== null) {
        push({ ...base, kind: "cabinet_licence_renewal", params: { licence: s.kind, until: s.licence?.validUntil ?? "", days: s.daysLeft },
          clock: { code: "days_left", n: s.daysLeft, tone: s.daysLeft <= LAW_NOTICE_DAYS ? "rd" : "gd" }, tier: 1, key: s.daysLeft });
      }
    }
    for (const n of cabinet.needsYou) {
      if (n.key.startsWith("licence_")) continue; // the licences are rows of their own, above
      push({ id: `law:cabinet:${n.key}`, source: "LAW", kind: `cabinet_${n.key}`, params: n.params,
        clock: n.key === "checkNotDone" ? { code: "today", tone: "gd" } : { code: "open", tone: n.key === "discrepancies" ? "rd" : "no" },
        ref: { kind: "cabinet", id: null }, tier: 4, key: n.key === "discrepancies" ? 0 : 1 });
    }
  }

  // ── PEOPLE: pharmacists' registrations ──
  for (const p of input.pharmacists ?? []) {
    if (!p.active) continue;
    const c = p.current;
    const ref: NeedRef = { kind: "pharmacist", id: p.userId };
    if (c === null) {
      const last = p.history[0];
      if (last === undefined) continue; // never registered: the register's own screen asks for it
      push({ id: `people:${p.userId}`, source: "PEOPLE", kind: "pharmacist_lapsed", params: { name: p.fullName, username: p.username, no: last.registrationNo },
        clock: { code: "lapsed", tone: "rd" }, ref, tier: 0, key: 1,
        facts: [{ k: "pharmacist", v: p.username, as: "text" }, { k: "council", v: last.council, as: "text" }, { k: "number", v: last.registrationNo, as: "text" },
          ...(last.validUntil === null ? [] : [{ k: "validUntil", v: last.validUntil, as: "date" as const }])] });
      continue;
    }
    const facts: NeedFact[] = [
      { k: "pharmacist", v: p.username, as: "text" }, { k: "council", v: c.council, as: "text" }, { k: "number", v: c.registrationNo, as: "text" },
      ...(c.validUntil === null ? [] : [{ k: "validUntil", v: c.validUntil, as: "date" as const }]),
    ];
    const left = c.validUntil === null ? null : days(today, c.validUntil);
    if (left !== null && left <= LAW_NOTICE_DAYS) {
      push({ id: `people:${p.userId}`, source: "PEOPLE", kind: "pharmacist_expiring", params: { name: p.fullName, username: p.username, no: c.registrationNo, days: left, until: c.validUntil! },
        clock: { code: "days_left", n: left, tone: left <= 7 ? "rd" : "gd" }, ref, facts, tier: 1, key: left });
    } else if (/^TRIAL-/i.test(c.registrationNo)) {
      push({ id: `people:${p.userId}`, source: "PEOPLE", kind: "pharmacist_trial", params: { name: p.fullName, username: p.username, no: c.registrationNo },
        clock: { code: "open", tone: "gd" }, ref, facts, tier: 7, key: 0 });
    }
  }

  // ── PAY ──
  const pay = input.pay;
  if (pay !== null) {
    const billFacts = (rows: OfficePay["overdue"]): NeedFact[] =>
      rows.slice(0, FACT_BILLS).map((b) => ({ k: `${b.billNo} · ${b.vendorName}`, raw: true as const, v: b.outstandingPaise, as: "money" as const }));
    const sum = (rows: OfficePay["overdue"]): number => rows.reduce((s, b) => s + b.outstandingPaise, 0);
    if (pay.overdue.length > 0) {
      const late = Math.max(...pay.overdue.map((b) => b.overdueDays));
      const msme = pay.overdue.filter((b) => b.msme).length;
      push({ id: "pay:overdue", source: "PAY", kind: "pay_overdue", params: { count: pay.overdue.length, msme, total: sum(pay.overdue), days: late },
        clock: { code: "days_late", n: late, tone: "rd" }, ref: { kind: "payRun", id: null }, tier: 2, key: -late,
        facts: [...billFacts(pay.overdue), { k: "total", v: sum(pay.overdue), as: "money" }] });
    }
    const due = (msme: boolean): OfficePay["dueThisWeek"] => pay.dueThisWeek.filter((b) => b.msme === msme);
    for (const msme of [true, false]) {
      const rows = due(msme);
      if (rows.length === 0) continue;
      const first = rows.map((b) => b.dueDate ?? today).sort()[0]!;
      const left = Math.max(0, days(today, first));
      const facts = [...billFacts(rows)];
      if (msme && pay.plan.creditPaise > 0) facts.push({ k: "lessCredit", v: -pay.plan.creditPaise, as: "money" });
      facts.push({ k: msme && pay.plan.creditPaise > 0 ? "payable" : "total", v: Math.max(0, sum(rows) - (msme ? pay.plan.creditPaise : 0)), as: "money" });
      push({ id: msme ? "pay:msme" : "pay:due", source: "PAY", kind: msme ? "pay_msme_due" : "pay_due", params: { count: rows.length, total: sum(rows), until: first, days: left,
        vendors: [...new Set(rows.map((b) => b.vendorName))].slice(0, 3).join(" · ") },
      clock: { code: "days_left", n: left, tone: msme ? "gd" : "no" }, ref: { kind: "payRun", id: null }, tier: msme ? 2 : 5, key: left, facts });
    }
    for (const r of pay.runs.filter((x) => x.status === "pending_authorisation")) {
      const waited = minutesSince(r.submittedAt ?? r.createdAt, now);
      push({ id: `pay:run:${r.id}`, source: "PAY", kind: "run_authorise", params: { runNo: r.runNo, total: r.totalPaise, vendors: r.vendorCount, bills: r.billCount },
        clock: { code: "waited", n: waited, tone: "no" }, ref: { kind: "run", id: r.id }, tier: 3, key: -waited,
        facts: [{ k: "run", v: r.runNo, as: "text" }, { k: "vendors", v: r.vendorCount, as: "count" }, { k: "bills", v: r.billCount, as: "count" }, { k: "total", v: r.totalPaise, as: "money" }] });
    }
    for (const b of pay.held) {
      const ago = daysSince(b.createdAt, now);
      push({ id: `pay:bill:${b.id}`, source: "PAY", kind: "bill_held", params: { billNo: b.billNo, vendor: b.vendorName, over: b.totalPaise - b.expectedTotalPaise },
        clock: { code: "days_ago", n: ago, tone: "no" }, ref: { kind: "bill", id: b.id }, tier: 4, key: -ago,
        facts: [{ k: "vendorBill", v: b.vendorBillNo, as: "text" }, { k: "bill", v: b.totalPaise, as: "money" }, { k: "grnValue", v: b.expectedTotalPaise, as: "money" },
          { k: "difference", v: b.totalPaise - b.expectedTotalPaise, as: "money" }] });
    }
  }

  // ── BUY ──
  const buy = input.buy;
  if (buy !== null) {
    for (const p of buy.awaitingYou) {
      const waited = minutesSince(p.submittedAt ?? p.createdAt, now);
      push({ id: `buy:po:${p.id}`, source: "BUY", kind: "po_approve", params: { poNo: p.poNo, vendor: p.vendorName, total: p.totalPaise, lines: p.lineCount, tier: p.approvalTier ?? "head" },
        clock: { code: "waited", n: waited, tone: "no" }, ref: { kind: "po", id: p.id }, tier: 3, key: -waited,
        facts: [{ k: "vendor", v: p.vendorName, as: "text" }, { k: "lines", v: p.lineCount, as: "count" }, { k: "value", v: p.totalPaise, as: "money" },
          ...(p.expectedDate === null ? [] : [{ k: "expected", v: p.expectedDate, as: "date" as const }])] });
    }
    for (const p of buy.overdue) {
      const late = p.expectedDate === null ? 0 : Math.max(0, days(p.expectedDate, today));
      push({ id: `buy:po:${p.id}`, source: "BUY", kind: "po_overdue", params: { poNo: p.poNo, vendor: p.vendorName, days: late, expected: p.expectedDate ?? "" },
        clock: { code: "days_late", n: late, tone: "gd" }, ref: { kind: "po", id: p.id }, tier: 4, key: -late,
        facts: [{ k: "vendor", v: p.vendorName, as: "text" }, { k: "value", v: p.totalPaise, as: "money" }, ...(p.expectedDate === null ? [] : [{ k: "expected", v: p.expectedDate, as: "date" as const }])] });
    }
    for (const p of buy.drafts) {
      push({ id: `buy:po:${p.id}`, source: "BUY", kind: "po_draft", params: { poNo: p.poNo, vendor: p.vendorName, total: p.totalPaise, lines: p.lineCount, agent: p.source === "agent" ? 1 : 0 },
        clock: { code: "draft", tone: "no" }, ref: { kind: "po", id: p.id }, tier: 9, key: 0,
        facts: [{ k: "vendor", v: p.vendorName, as: "text" }, { k: "lines", v: p.lineCount, as: "count" }, { k: "value", v: p.totalPaise, as: "money" }] });
    }
    const late = new Set(buy.overdue.map((p) => p.id));
    const receive = buy.toReceive.filter((p) => !late.has(p.id));
    if (receive.length > 0) {
      push({ id: "buy:receive", source: "BUY", kind: "po_receive", params: { count: receive.length, vendors: [...new Set(receive.map((p) => p.vendorName))].slice(0, 3).join(" · ") },
        clock: { code: "open", tone: "no" }, ref: { kind: "grnDesk", id: null }, tier: 9, key: 1,
        facts: receive.slice(0, FACT_BILLS).map((p) => ({ k: `${p.poNo} · ${p.vendorName}`, raw: true as const, v: p.totalPaise, as: "money" as const })) });
    }
    if (buy.shortages.length > 0) {
      push({ id: "buy:shortages", source: "BUY", kind: "shortages", params: { count: buy.shortages.length, drugs: buy.shortages.slice(0, 3).map((s) => s.drugName).join(" · ") },
        clock: { code: "open", tone: "no" }, ref: { kind: "purchasePlan", id: null }, tier: 9, key: 2,
        facts: buy.shortages.slice(0, FACT_BILLS).map((s) => ({ k: s.drugName, raw: true as const, v: s.qtyWanted ?? "—", as: "text" as const })) });
    }
  }

  // ── RETURN, and the expiry side of STOCK ──
  const ret = input.returns;
  if (ret !== null) {
    for (const r of ret.openRecalls) {
      const ago = daysSince(r.raisedAt, now);
      push({ id: `return:recall:${r.id}`, source: "RETURN", kind: "recall_open", params: { recallNo: r.recallNo, item: r.itemName, batch: r.batchNo, onHand: r.onHand },
        clock: { code: "days_ago", n: ago, tone: "rd" }, ref: { kind: "recall", id: r.id }, tier: 3, key: -ago,
        facts: [{ k: "item", v: r.itemName, as: "text" }, { k: "batch", v: r.batchNo, as: "text" }, { k: "onHand", v: r.onHand, as: "count" },
          ...(r.supplierName === null ? [] : [{ k: "supplier", v: r.supplierName, as: "text" as const }])] });
    }
    for (const r of ret.awaitingCredit) {
      const ago = daysSince(r.dispatchedAt, now);
      push({ id: `return:${r.id}`, source: "RETURN", kind: "credit_awaited", params: { vendor: r.vendorName, note: r.debitNoteNo ?? r.returnNo, total: r.totalPaise, days: ago },
        clock: { code: "days_ago", n: ago, tone: ago > 30 ? "gd" : "no" }, ref: { kind: "return", id: r.id }, tier: 5, key: -ago,
        facts: [{ k: "debitNote", v: r.totalPaise, as: "money" }, ...(r.dispatchedAt === null ? [] : [{ k: "dispatched", v: r.dispatchedAt.slice(0, 10), as: "date" as const }]),
          { k: "lines", v: r.lineCount, as: "count" }] });
    }
    for (const w of ret.writeOffsToPost) {
      push({ id: `return:wo:${w.id}`, source: "RETURN", kind: "writeoff_post", params: { no: w.writeOffNo, store: w.storeName, value: w.totalValuePaise },
        clock: { code: "open", tone: "on" }, ref: { kind: "writeoff", id: w.id }, tier: 5, key: 0,
        facts: [{ k: "store", v: w.storeName, as: "text" }, { k: "lines", v: w.lineCount, as: "count" }, { k: "value", v: w.totalValuePaise, as: "money" }] });
    }
    for (const w of ret.writeOffsAwaiting) {
      const ago = daysSince(w.requestedAt, now);
      push({ id: `return:wo:${w.id}`, source: "RETURN", kind: "writeoff_approval", params: { no: w.writeOffNo, store: w.storeName, value: w.totalValuePaise },
        clock: { code: "days_ago", n: ago, tone: "no" }, ref: { kind: "writeoff", id: w.id }, tier: 6, key: 1,
        facts: [{ k: "store", v: w.storeName, as: "text" }, { k: "lines", v: w.lineCount, as: "count" }, { k: "value", v: w.totalValuePaise, as: "money" }] });
    }
    const e = ret.expiring;
    if (e.expired + e.d90 > 0) {
      push({ id: "stock:expiry", source: "STOCK", kind: e.expired > 0 ? "expiry_expired" : "expiry", params: {
        count: e.d90, value: e.d90ValuePaise, expired: e.expired, expiredValue: e.expiredValuePaise,
        returnable: ret.plan.lines, returnableValue: ret.plan.taxablePaise, vendors: ret.plan.vendors, destroy: ret.plan.toDestroy, destroyValue: ret.plan.toDestroyValuePaise,
      }, clock: e.expired > 0 ? { code: "lapsed", tone: "rd" } : { code: "window", n: 90, tone: "no" }, ref: { kind: "returnPlan", id: null }, tier: 6, key: 0,
      facts: [
        ...(e.expired > 0 ? [{ k: "expired", v: e.expiredValuePaise, as: "money" as const }] : []),
        { k: "within30", v: e.d30, as: "count" }, { k: "within90", v: e.d90ValuePaise, as: "money" },
        { k: "returnable", v: ret.plan.taxablePaise, as: "money" }, { k: "toDestroy", v: ret.plan.toDestroyValuePaise, as: "money" },
      ] });
    }
  }

  // ── STOCK: GRNs waiting for the pharmacist's QC; the opening-stock sheet's as one row per sheet ──
  const grns = input.grns;
  if (grns !== null) {
    const sheets = new Map<string, GrnAtQc[]>();
    for (const g of grns) {
      if (g.challanNo.startsWith("OPENING/")) { sheets.set(g.challanNo, [...(sheets.get(g.challanNo) ?? []), g]); continue; }
      const ago = daysSince(g.createdAt, now);
      push({ id: `stock:grn:${g.id}`, source: "STOCK", kind: "grn_qc", params: { grnNo: g.grnNo, challan: g.challanNo, vendor: g.vendorName, lines: g.lines },
        clock: ago === 0 ? { code: "today", tone: "on" } : { code: "days_ago", n: ago, tone: "gd" }, ref: { kind: "grn", id: g.id }, tier: 8, key: -ago,
        facts: [{ k: "vendor", v: g.vendorName, as: "text" }, { k: "challan", v: g.challanNo, as: "text" }, { k: "lines", v: g.lines, as: "count" }] });
    }
    for (const [challan, list] of sheets) {
      const oldest = list.map((g) => g.createdAt).sort()[0]!;
      const ago = daysSince(oldest, now);
      const lines = list.reduce((s, g) => s + g.lines, 0);
      push({ id: `stock:opening:${challan}`, source: "STOCK", kind: "opening_qc", params: { count: list.length, challan, lines },
        clock: ago === 0 ? { code: "today", tone: "on" } : { code: "days_ago", n: ago, tone: "gd" }, ref: { kind: "grn", id: list[0]!.id }, tier: 8, key: -ago,
        facts: [{ k: "grns", v: list.length, as: "count" }, { k: "lines", v: lines, as: "count" }, ...list.slice(0, FACT_BILLS).map((g) => ({ k: g.grnNo, raw: true as const, v: g.lines, as: "count" as const }))] });
    }
  }

  out.sort((a, b) => a.tier - b.tier || a.key - b.key || a.id.localeCompare(b.id));
  const sides = NEED_SOURCES.filter((s) => {
    switch (s) {
      case "BUY": return input.buy !== null;
      case "PAY": return input.pay !== null;
      case "RETURN": return input.returns !== null;
      case "STOCK": return input.returns !== null || input.grns !== null;
      case "LAW": return input.retail !== null || input.cabinet !== null;
      case "PEOPLE": return input.pharmacists !== null;
    }
    return false;
  });
  return {
    rows: out.map((r): NeedRow => ({ id: r.id, source: r.source, kind: r.kind, params: r.params, clock: r.clock, ref: r.ref, facts: r.facts, tier: r.tier })),
    sides,
    money: pay === null ? null : {
      dueThisWeekPaise: pay.dueThisWeek.reduce((s, b) => s + b.outstandingPaise, 0), overduePaise: pay.overduePaise,
      msmeDueThisWeek: pay.dueThisWeek.filter((b) => b.msme).length,
    },
    copilot: { po: buy?.plan ?? null, pay: pay?.plan ?? null, returns: ret?.plan ?? null },
  };
}

const isDenied = (e: unknown): boolean =>
  (e instanceof PharmacyError || e instanceof MaterialsError) && e.code === "permission_denied";

/** Read a side only with its route's grant; a refusal from inside the read drops the side, anything else throws. */
async function side<T>(db: Db, userId: string, grants: readonly string[], read: () => Promise<T>): Promise<T | null> {
  let held = false;
  for (const g of grants) if (await hasPermission(db, userId, g, "hospital")) { held = true; break; }
  if (!held) return null;
  try {
    return await read();
  } catch (e) {
    if (isDenied(e)) return null;
    throw e;
  }
}

async function grnsAtQc(db: Db): Promise<GrnAtQc[]> {
  const rows = await listGrns(db, { status: "gate_qc" });
  if (rows.length === 0) return [];
  const ids = rows.map((g) => g.id);
  const vendorIds = [...new Set(rows.map((g) => g.vendorId))];
  const [counts, names] = await Promise.all([
    db.select({ grnId: grnLines.grnId, n: count() }).from(grnLines).where(inArray(grnLines.grnId, ids)).groupBy(grnLines.grnId),
    db.select({ id: vendors.id, name: sql<string>`coalesce(${vendors.tradeName}, ${vendors.legalName})` }).from(vendors).where(inArray(vendors.id, vendorIds)),
  ]);
  const lines = new Map(counts.map((c) => [c.grnId, Number(c.n)]));
  const vendor = new Map(names.map((v) => [v.id, v.name]));
  return rows.map((g) => ({
    id: g.id, grnNo: g.grnNo, challanNo: g.challanNo, vendorName: vendor.get(g.vendorId) ?? "", lines: lines.get(g.id) ?? 0, createdAt: g.createdAt.toISOString(),
  }));
}

/** `GET /pharmacy/office/needs` — every side this person may read, federated and ranked. */
export async function officeNeeds(db: Db, actor: Actor, now: Date = new Date()): Promise<OfficeNeeds> {
  const empty: NeedInputs = { buy: null, pay: null, returns: null, grns: null, retail: null, cabinet: null, pharmacists: null };
  if (actor.type !== "user") return buildNeeds(empty, now);
  const id = actor.id;
  const [buy, pay, returns, grns, retail, cabinet, pharmacists] = await Promise.all([
    side(db, id, ["materials.po.raise"], () => officeToday(db, actor, now)),
    side(db, id, ["materials.bills.manage"], () => officePay(db, actor, now)),
    side(db, id, ["materials.returns.manage"], () => officeReturns(db, actor, now)),
    side(db, id, ["materials.grn.qc"], () => grnsAtQc(db)),
    side(db, id, ["pharmacy.retail.manage"], () => retailLicenceState(db, now)),
    side(db, id, [CUSTODY_PERMISSION, LICENCES_PERMISSION, "pharmacy.register.read"], () => controlledToday(db, actor, now)),
    side(db, id, ["pharmacy.pharmacists.manage"], () => listPharmacists(db, now)),
  ]);
  return buildNeeds({ buy, pay, returns, grns, retail, cabinet, pharmacists }, now);
}
