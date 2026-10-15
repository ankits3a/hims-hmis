import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { askDispenseDiscount, fetchClosing, fetchPatientRail, previewBill } from "../../lib/pharmacy-api";
import { billQtyText, quoteAmountPaise } from "../../lib/pharmacy-bill";
import { OwnerCreditAsk } from "../owner-credit-ask";
import { DiscountSheet, DiscountWait, discountLabel, useDiscountApproval } from "./discount";
import type { AppliedDiscount } from "./discount";
import type { Tender, TenderPayable, WireDispense, WirePricedDraft } from "../../lib/pharmacy-api";

/**
 * ═══ PD-6 — THE BILL IS THE RIGHT RAIL AND BUILDS LIVE (PD-D5) ═══
 *
 * It replaces the line on claim. Before the strips are collected nothing is priced — a dispensed
 * line is priced at BATCH grain (`pricing.ts`), so there is no honest amount until the pick has
 * chosen the batch — and the rail says exactly that rather than an estimate. Once collected it is
 * the server's preview, line by line, with the GST shown as INSIDE the printed MRP: this desk does
 * no arithmetic on money.
 *
 * ═══ NO DRAWER, NO TENDER — ALL OF THEM (E21, measured) ═══
 *
 * The phase doc said "no cash drawer → cash is not a tender". `receipts.ts` and `invoices.ts` both
 * call `requireOpenSession` for ANY receipt, so without the pharmacist's own open drawer the desk
 * can take no money at all — UPI and card included. The rail says so before a key is pressed, and
 * the tender keys are guarded on the same predicate the buttons are, as Desk One's are.
 */
export type TenderMode = "cash" | "upi" | "card" | "split";
const MODES: readonly TenderMode[] = ["cash", "upi", "card", "split"];

export const rupees = (paise: number): string =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A rounding line, signed: ruling 2026-09-30 makes it a deduction (−₹0.60), which `rupees` would print as "₹-0.60". */
export const signedRupees = (paise: number): string => (paise < 0 ? `−${rupees(-paise)}` : `+${rupees(paise)}`);

const toPaise = (s: string): number | null => {
  const t = s.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

/**
 * What the server is told, or why nothing is. Cash is tendered and the change is the difference;
 * a split is cash plus UPI and must add up to the bill exactly. E20 — a short tender is refused
 * HERE as well as by billing, so the key and the button can never do what the server will refuse.
 */
/*
  WALK FINDING — billing refuses every non-cash tender without a SETTLEMENT REFERENCE
  (`tender_ref_required`, `invoices.ts`): the UTR for UPI, the approval code for a card. The canvas
  drew no such field and the first UPI payment on the dev day was refused. The rail asks for it, and
  a non-cash tender without one is no tender.
*/
export function tendersFor(mode: TenderMode, payable: number, cashText: string, upiText: string, refText = ""): { tenders: Tender[]; changePaise: number } | null {
  const ref = refText.trim();
  if (mode === "upi" || mode === "card") return ref === "" ? null : { tenders: [{ mode, amountPaise: payable, refText: ref }], changePaise: 0 };
  if (mode === "cash") {
    const given = toPaise(cashText);
    if (given === null || given < payable) return null;
    /* The tender is the NOTE handed over, and the change comes out of it: billing reads a cash tender as
       the money received and caps change at the surplus above the bill. Sending the bill as the tender
       with change on top was refused on the preview (2026-09-20, core `cash-change.test.ts`). */
    return { tenders: [{ mode: "cash", amountPaise: given }], changePaise: given - payable };
  }
  const cash = toPaise(cashText);
  const upi = toPaise(upiText);
  if (cash === null || upi === null || cash <= 0 || upi <= 0 || cash + upi !== payable || ref === "") return null;
  return { tenders: [{ mode: "cash", amountPaise: cash }, { mode: "upi", amountPaise: upi, refText: ref }], changePaise: 0 };
}

/**
 * ═══ OWNER RULING 2026-09-30 — THE PAYABLE FOLLOWS THE TENDER BEING CHOSEN ═══
 *
 * *"If patient is paying using cash then keep whole-rupee rounding, … If paying via UPI or Card
 * then we can collect to the paisa."* The server quotes both (`byTender`); the rail shows the one for the
 * tender under the cashier's finger, so ₹33.60 reads ₹34.00 on Cash and Split and ₹33.60 on UPI and Card (owner's amendment: cash
 * to the NEAREST rupee — "30.49 … Rs 30 … 30.51 … 31").
 * An older server without `byTender` is read as it always was.
 */
export function payableFor(mode: TenderMode, preview: Pick<WirePricedDraft, "totals" | "byTender">): TenderPayable {
  if (preview.byTender === undefined) return { netPayablePaise: preview.totals.netPayablePaise, roundingPaise: preview.totals.roundingPaise };
  return mode === "upi" || mode === "card" ? preview.byTender.digital : preview.byTender.cash;
}

/** E27 — the reservation's deadline, said in the draft's own sentence. `null` before the pick: nothing is held. */
export function heldUntil(pickedAt: string | null, minutes = 30): string | null {
  if (pickedAt === null) return null;
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(Date.parse(pickedAt) + minutes * 60_000));
}

/**
 * E13 — whether the hold `heldUntil` names has already run out, by the desk's own clock. The sweep
 * that cancels the ticket runs every minute and the desk reads the ticket every fifteen seconds, so
 * for up to ~75 s the screen would otherwise name a deadline already past as one still to come.
 */
export function holdEnded(pickedAt: string | null, now: Date, minutes = 30): boolean {
  return pickedAt !== null && Date.parse(pickedAt) + minutes * 60_000 <= now.getTime();
}

function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
}

/**
 * WALK FINDING 2026-09-29 — the quantity each unbilled line is priced at: the one being typed on the
 * ticket while it is still being worked (claimed or verified), else the server's. A prefilled 9750
 * edited to 10 kept showing "× 9750 ₹21,840" here until the tick, because only the tick reached the
 * server. `quoteAmountPaise` mirrors the server's `quotedAmountPaise`, so the running total is the
 * same sum the server makes, over the quantities on the screen.
 */
export function railQty(status: string, line: { lineIdx: number; qtyBase: number | null }, live: Readonly<Record<number, number | null>> | null): number | null {
  if (live === null || (status !== "claimed" && status !== "verified") || !(line.lineIdx in live)) return line.qtyBase;
  return live[line.lineIdx] ?? null;
}

export function BillRail({
  dispense, preview, liveQty = null, previewError, drawerOpen, busy, error, now, onTake, onCredit, onDraft, onOpenDrawer,
  discount = null, onDiscount = null,
}: {
  dispense: WireDispense;
  preview: WirePricedDraft | null;
  /** The quantities typed on the ticket in hand, by line (`railQty`). */
  liveQty?: Readonly<Record<number, number | null>> | null;
  previewError: string | null;
  /** The pharmacist's OWN drawer is open. `null` while it is being read. */
  drawerOpen: boolean | null;
  busy: boolean;
  error: string | null;
  /** The desk's clock (it ticks every 15 s) — E13 asks it whether the hold has ended. */
  now: Date;
  /** `creditPaise` — pharmacy credit spent on this bill first (owner ruling 2026-10-02); the tenders pay only the rest. */
  onTake: (tenders: Tender[], changePaise: number, creditPaise: number) => void;
  /** GAP A3b — bill the whole amount on the owner's granted credit approval. */
  onCredit: (credit: { reason: string; approvalId: string }) => void;
  onDraft: () => void;
  onOpenDrawer: () => void;
  /** OWNER RULING 2026-09-30 — the sale discount on this bill (the desk prices the preview with it), and how to change it. */
  discount?: AppliedDiscount | null;
  onDiscount?: ((d: AppliedDiscount | null) => void) | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TenderMode>("upi");
  const [cash, setCash] = useState("");
  const [upi, setUpi] = useState("");
  const [ref, setRef] = useState("");
  const status = dispense.status;
  const collected = status === "picked";
  const paid = status === "billed" || status === "handed_over";
  const due = preview === null ? null : payableFor(mode, preview);
  const payable = due?.netPayablePaise ?? null;
  /* The owner's credit carries no tender: it is billed on the cash rule (the nearest rupee). */
  const creditPayable = preview === null ? null : payableFor("cash", preview).netPayablePaise;
  /*
    OWNER RULING 2026-10-02 — PHARMACY CREDIT, SPENT FIRST. Credit the patient kept from a return covers
    the bill before any tender; the patient pays only the difference. A bill it covers WHOLLY hands no
    coin across, so it is collected to the paisa (the digital figure) and takes no tender at all.
  */
  const creditHeld = preview?.creditAvailablePaise ?? 0;
  const [useCredit, setUseCredit] = useState(true);
  const exactPayable = preview === null ? null : payableFor("upi", preview).netPayablePaise;
  const coveredByCredit = useCredit && exactPayable !== null && creditHeld >= exactPayable && exactPayable > 0;
  const creditUse = !useCredit || payable === null ? 0 : coveredByCredit ? exactPayable : Math.min(creditHeld, payable);
  const rest = payable === null ? null : coveredByCredit ? 0 : payable - creditUse;
  const plan = rest === null ? null : coveredByCredit ? { tenders: [] as Tender[], changePaise: 0 } : rest <= 0 ? null : tendersFor(mode, rest, cash, upi, ref);
  /* A discount above the pharmacist's 10% waits for its approval; the money keys wait with it. */
  const approval = useDiscountApproval(discount);
  const discountReady = discount === null || approval.status === "none" || approval.status === "granted";
  const canTake = collected && drawerOpen === true && plan !== null && !busy && discountReady;
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  /* GAP A3b — credit, only on the owner's yes (owner ruling 2026-09-28). Closed unless opened. */
  const [creditOpen, setCreditOpen] = useState(false);
  const [creditReason, setCreditReason] = useState("");
  const [creditApproval, setCreditApproval] = useState<string | null>(null);
  const onCreditGranted = useCallback((id: string | null) => { setCreditApproval(id); }, []);

  /* A different ticket starts with an empty tender — the last patient's cash is not this one's. */
  useEffect(() => {
    setCash(""); setUpi(""); setRef(""); setMode("upi"); setUseCredit(true);
    setCreditOpen(false); setCreditReason(""); setCreditApproval(null);
    setMenuOpen(false); setSheetOpen(false);
  }, [dispense.id]);

  /* PD-D6 — `1-4` choose the tender, `Ctrl+⏎` takes it; guarded exactly as the buttons are. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!collected || drawerOpen !== true) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (canTake) onTake(plan.tenders, plan.changePaise, creditUse);
        return;
      }
      if (typingIn(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const picked = MODES[Number(e.key) - 1];
      if (picked !== undefined && /^[1-4]$/.test(e.key)) { e.preventDefault(); setMode(picked); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canTake, collected, creditUse, drawerOpen, onTake, plan]);

  /* The same read the left rail made — one query key, so this costs no second request. */
  const rail = useQuery({
    queryKey: ["pharmacy", "patient-rail", dispense.id],
    queryFn: () => fetchPatientRail(dispense.id),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const heldCard = (rail.data?.benefits ?? []).find((b) => b.usable) ?? null;
  /*
    WALK FINDING 2026-09-29 — a PAID ticket says what was TAKEN: the invoice's own payable and its
    rounding, read back off the invoice (`closing.ts`, the same read and key as the done screen). The
    re-priced shelf total ("so far ₹33.60" beside ₹34.00 taken) is never a paid ticket's figure. How the
    rounding is computed is billing's and an open owner ruling; this only shows it.
  */
  const closing = useQuery({
    queryKey: ["pharmacy", "closing", dispense.id],
    queryFn: () => fetchClosing(dispense.id),
    enabled: paid,
    retry: false,
  });
  const taken = paid ? (closing.data?.money ?? null) : null;
  const priced = dispense.lines.map((l) => {
    const qty = railQty(status, l, liveQty);
    /* A paid line is not re-priced at today's shelf: what it cost is on the invoice, and the total below says it. */
    const amount = paid || l.quote == null || qty === null || l.status === "declined" ? null : quoteAmountPaise(l.quote, qty);
    return { line: l, qty, amount };
  });
  const soFar = priced.reduce((n, p) => n + (p.amount ?? 0), 0);
  const until = heldUntil(dispense.pickedAt);
  const ended = dispense.status === "picked" && holdEnded(dispense.pickedAt, now);

  return (
    <aside
      data-testid="desk-bill"
      style={{ width: 296, flexShrink: 0, borderLeft: "1px solid var(--line)", background: "var(--card)", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 15px 3px 15px" }}>
        <span className="tag" style={{ flexGrow: 1 }}>{t("pharmacyDesk.bill.title")}</span>
        <span className={paid ? "stamp pd" : "stamp un"}>{paid ? t("pharmacyDesk.bill.paid") : t("pharmacyDesk.bill.unpaid")}</span>
        {/* OWNER RULING 2026-09-30 — the bill's exceptions live behind ⋯, as the line's do: the discount first. */}
        {collected && onDiscount !== null && preview !== null ? (
          <span style={{ position: "relative" }}>
            <button
              type="button" aria-label={t("pharmacyDiscount.menu")} aria-expanded={menuOpen} aria-haspopup="true" data-testid="desk-bill-menu"
              onClick={() => setMenuOpen((m) => !m)}
              style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--dim)" }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
            </button>
            {menuOpen ? (
              <span className="lmenu" style={{ display: "block", minWidth: 200 }}>
                <button type="button" data-testid="desk-discount-open" onClick={() => { setMenuOpen(false); setSheetOpen(true); }}>
                  {discount === null ? t("pharmacyDiscount.open") : t("pharmacyDiscount.change")}
                </button>
                {discount !== null ? (
                  <button type="button" onClick={() => { setMenuOpen(false); onDiscount(null); }}>{t("pharmacyDiscount.remove")}</button>
                ) : null}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>

      <div style={{ flexGrow: 1, overflowY: "auto", padding: "4px 15px 0 15px" }}>
        {preview === null ? (
          <>
            {priced.map(({ line: l, qty, amount }) => (
              /* Priced at today's shelf price for the batch the pick would take — the server's quote, never ours. */
              <div key={l.lineIdx} style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "7px 0", borderTop: "1px solid var(--line2)" }}>
                <span style={{ flexGrow: 1, minWidth: 0, fontSize: 12, color: l.status === "declined" ? "var(--dim)" : "var(--ink)" }}>
                  {l.dispensedMedicine?.brandName ?? l.rxLine.drug}
                  {qty === null || (amount === null && !paid) || l.status === "declined" ? null : <span className="mo" style={{ color: "var(--dim)" }}> × {qty}</span>}
                </span>
                <span className="mo" style={{ fontSize: 12, color: amount === null ? "var(--dim)" : "var(--ink)" }}>
                  {l.status === "declined" ? t("pharmacyDesk.bill.declined") : amount === null ? (paid ? null : "—") : rupees(amount)}
                </span>
              </div>
            ))}
            {taken !== null ? (
              <>
                {taken.roundingPaise !== undefined && taken.roundingPaise !== 0 ? (
                  <Row what={t("pharmacyDesk.bill.rounding")} amt={signedRupees(taken.roundingPaise)} tone="var(--dim)" />
                ) : null}
                <div style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "11px 0 0 0", marginTop: 4, borderTop: "2px solid var(--ink)" }}>
                  <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 600 }}>{t("pharmacyDesk.bill.took")}</span>
                  <span className="mo" data-testid="desk-payable" style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-.02em" }}>{rupees(taken.netPayablePaise)}</span>
                </div>
              </>
            ) : paid ? null : soFar > 0 ? (
              <div style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "11px 0 0 0", marginTop: 4, borderTop: "2px solid var(--ink)" }}>
                <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 600 }}>{t("pharmacyDesk.bill.soFar")}</span>
                <span className="mo" data-testid="desk-sofar" style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-.02em" }}>{rupees(soFar)}</span>
              </div>
            ) : null}
            <p style={{ margin: "10px 0 0 0", fontSize: 11, color: "var(--dim)", lineHeight: "16px" }}>
              {paid ? (taken === null ? null : t("pharmacyDesk.bill.inside")) : previewError ?? (soFar > 0 ? t("pharmacyDesk.bill.soFarWhy") : t("pharmacyDesk.bill.notYet"))}
            </p>
          </>
        ) : (
          <>
            {preview.lines.map((l) => (
              <div key={l.lineId} style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "7px 0", borderTop: "1px solid var(--line2)" }}>
                <span data-testid="desk-bill-line" style={{ flexGrow: 1, minWidth: 0, fontSize: 12 }}>{l.serviceName} <span className="mo" style={{ color: "var(--dim)" }}>{billQtyText(t, l.qty, l.pack)}</span></span>
                <span className="mo" style={{ fontSize: 12 }}>{rupees(l.netPaise)}</span>
              </div>
            ))}
            {preview.totals.discountPaise > 0 ? (
              <Row
                what={discount === null ? t("pharmacyDesk.bill.discount") : `${t("pharmacyDesk.bill.discount")} ${discountLabel(discount)} · ${discount.reason}`}
                amt={`−${rupees(preview.totals.discountPaise)}`} tone="var(--green)" testId="desk-discount-row"
              />
            ) : null}
            <Row what={t("pharmacyDesk.bill.cgst")} amt={rupees(preview.totals.cgstPaise)} tone="var(--dim)" />
            <Row what={t("pharmacyDesk.bill.sgst")} amt={rupees(preview.totals.sgstPaise)} tone="var(--dim)" />
            {(taken?.roundingPaise ?? due?.roundingPaise ?? 0) !== 0 ? (
              <Row what={t("pharmacyDesk.bill.rounding")} amt={signedRupees(taken?.roundingPaise ?? due?.roundingPaise ?? 0)} tone="var(--dim)" testId="desk-rounding" />
            ) : null}
            <div style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "11px 0 0 0", marginTop: 4, borderTop: "2px solid var(--ink)" }}>
              <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 600 }}>{paid ? t("pharmacyDesk.bill.took") : t("pharmacyDesk.bill.toCollect")}</span>
              <span className="mo" data-testid="desk-payable" style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-.02em" }}>{rupees(taken?.netPayablePaise ?? payable ?? preview.totals.netPayablePaise)}</span>
            </div>
            <p style={{ margin: "7px 0 0 0", fontSize: 10.5, color: "var(--dim)", lineHeight: "15px" }}>{t("pharmacyDesk.bill.inside")}</p>
            {paid || !collected || creditHeld <= 0 ? null : (
              <div data-testid="desk-store-credit" style={{ marginTop: 9, padding: "8px 10px", borderRadius: 6, border: "1px solid var(--green-line)", background: "var(--green-soft)" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <input type="checkbox" data-testid="desk-store-credit-use" checked={useCredit} onChange={(e) => setUseCredit(e.target.checked)} style={{ accentColor: "#0e6b4e" }} />
                  <span style={{ flexGrow: 1 }}>{t("pharmacyDesk.bill.storeCredit", { amount: rupees(creditHeld) })}</span>
                </label>
                {creditUse <= 0 ? null : (
                  <>
                    <Row what={t("pharmacyDesk.bill.storeCreditUsed")} amt={`−${rupees(creditUse)}`} tone="var(--green)" testId="desk-store-credit-used" />
                    <Row what={t("pharmacyDesk.bill.storeCreditRest")} amt={rupees(rest ?? 0)} tone="var(--ink)" testId="desk-store-credit-rest" />
                    {creditHeld - creditUse <= 0 ? null : <p style={{ margin: "4px 0 0 0", fontSize: 11, color: "var(--dim)" }}>{t("pharmacyDesk.bill.storeCreditLeft", { amount: rupees(creditHeld - creditUse) })}</p>}
                  </>
                )}
              </div>
            )}
            {paid ? null : <DiscountWait discount={discount} />}
            {/* C7 — a card the patient holds that is NOT on this bill is said, never applied here (money is billing's). */}
            {preview.totals.discountPaise > 0 || heldCard === null ? null : (
              <p role="status" data-testid="desk-member-note" style={{ margin: "9px 0 0 0", fontSize: 11.5, color: "var(--gold-ink, var(--gold))", lineHeight: "16px" }}>
                {t("pharmacyDesk.bill.memberNotApplied", { plan: heldCard.planTitle })}
              </p>
            )}
          </>
        )}
      </div>

      {collected ? (
        <div style={{ padding: "12px 15px", borderTop: "1px solid var(--line)" }}>
          {drawerOpen === false ? (
            <div role="status" style={{ fontSize: 11.5, color: "var(--gold)", lineHeight: "16px" }}>
              {t("pharmacyDesk.bill.noDrawer")}{" "}
              <button className="sec" style={{ height: 28, marginTop: 6 }} onClick={onOpenDrawer}>{t("pharmacyDesk.bill.openDrawer")}</button>
            </div>
          ) : (
            <>
              <div className="tag">{t("pharmacyDesk.bill.takeMoney")}</div>
              <div role="radiogroup" aria-label={t("pharmacyDesk.bill.tender")} style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6, marginTop: 9 }}>
                {MODES.map((m, i) => (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={mode === m}
                    disabled={drawerOpen !== true}
                    onClick={() => setMode(m)}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 48, borderRadius: 6,
                      border: `1px solid ${mode === m ? "var(--green)" : "var(--line)"}`,
                      background: mode === m ? "var(--green-soft)" : "var(--card)", color: mode === m ? "var(--green)" : "var(--dim)",
                    }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 600 }}>{t(`pharmacyDesk.bill.mode.${m}`)}</span>
                    <span className="kb" style={{ marginTop: 3 }}>{String(i + 1)}</span>
                  </button>
                ))}
              </div>
              {mode === "cash" || mode === "split" ? (
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <label style={{ flexGrow: 1 }}>
                    <span className="tag">{mode === "cash" ? t("pharmacyDesk.bill.tendered") : t("pharmacyDesk.bill.cashPart")}</span>
                    <input className="in mo" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} style={{ height: 36, marginTop: 4, textAlign: "right" }} />
                  </label>
                  {mode === "split" ? (
                    <label style={{ flexGrow: 1 }}>
                      <span className="tag">{t("pharmacyDesk.bill.upiPart")}</span>
                      <input className="in mo" inputMode="decimal" value={upi} onChange={(e) => setUpi(e.target.value)} style={{ height: 36, marginTop: 4, textAlign: "right" }} />
                    </label>
                  ) : (
                    <div style={{ flexGrow: 1 }}>
                      <span className="tag">{t("pharmacyDesk.bill.change")}</span>
                      <div className="mo" data-testid="desk-change" style={{
                        height: 36, marginTop: 4, borderRadius: 6, background: "var(--green-soft)", border: "1px solid var(--green-line)",
                        color: "var(--green)", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 12px", fontSize: 15, fontWeight: 600,
                      }}>{plan === null ? "—" : rupees(plan.changePaise)}</div>
                    </div>
                  )}
                </div>
              ) : null}
              {mode === "cash" ? null : (
                <label style={{ display: "block", marginTop: 10 }}>
                  <span className="tag">{mode === "card" ? t("pharmacyDesk.bill.cardRef") : t("pharmacyDesk.bill.upiRef")}</span>
                  <input className="in mo" value={ref} onChange={(e) => setRef(e.target.value)} placeholder={mode === "card" ? t("pharmacyDesk.bill.cardRefHint") : t("pharmacyDesk.bill.upiRefHint")} style={{ height: 36, marginTop: 4 }} />
                </label>
              )}
              <button className="pri" data-testid="desk-take" style={{ width: "100%", marginTop: 10, height: 46 }} disabled={!canTake} onClick={() => { if (plan !== null) onTake(plan.tenders, plan.changePaise, creditUse); }}>
                {coveredByCredit ? t("pharmacyDesk.bill.settleFromCredit") : rest === null ? t("pharmacyDesk.bill.received") : t("pharmacyDesk.bill.receivedAmount", { amount: rupees(rest) })}{" "}
                <span className="kb" style={{ borderColor: "rgba(255,255,255,.35)", background: "rgba(255,255,255,.12)", color: "#d6ece1" }}>Ctrl ⏎</span>
              </button>
            </>
          )}
          {/* GAP A3b — owner ruling 2026-09-28: nobody but the owner gives credit. The drawer is not needed: no money moves. */}
          {creditPayable !== null && creditPayable > 0 && discountReady ? (
            <div data-testid="desk-credit" style={{ marginTop: 10, paddingTop: 9, borderTop: "1px solid var(--line2)" }}>
              {!creditOpen ? (
                <button type="button" className="sec" data-testid="desk-credit-open" style={{ width: "100%", height: 32 }} onClick={() => setCreditOpen(true)}>
                  {t("pharmacyDesk.bill.creditOpen")}
                </button>
              ) : (
                <>
                  <label style={{ display: "block" }}>
                    <span className="tag">{t("pharmacyDesk.bill.creditReason")}</span>
                    <input className="in" data-testid="desk-credit-reason" value={creditReason} onChange={(e) => setCreditReason(e.target.value)} style={{ height: 36, marginTop: 4 }} />
                  </label>
                  <OwnerCreditAsk
                    draftId={dispense.id} patientId={dispense.patient.id} amountPaise={creditPayable} reason={creditReason}
                    amountText={rupees(creditPayable)} onGranted={onCreditGranted}
                  />
                  {creditApproval !== null ? (
                    <button
                      type="button" className="pri" data-testid="desk-credit-bill" style={{ width: "100%", marginTop: 10, height: 42 }} disabled={busy}
                      onClick={() => onCredit({ reason: creditReason.trim(), approvalId: creditApproval })}
                    >
                      {t("pharmacyDesk.bill.creditBill", { amount: rupees(creditPayable) })}
                    </button>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
          {error !== null ? <p role="alert" style={{ margin: "8px 0 0 0", fontSize: 11.5, color: "var(--red)", lineHeight: "16px" }}>{error}</p> : null}
          <button className="sec" style={{ width: "100%", marginTop: 8 }} onClick={onDraft}>{t("pharmacyDesk.bill.draft")}</button>
          {until !== null && ended ? <p role="status" style={{ margin: "7px 0 0 0", fontSize: 10.5, color: "var(--gold)", lineHeight: "15px" }}>{t("pharmacyDesk.bill.holdEnded", { time: until })}</p> : null}
          {until !== null && !ended ? <p style={{ margin: "7px 0 0 0", fontSize: 10.5, color: "var(--dim)", lineHeight: "15px" }}>{t("pharmacyDesk.bill.heldUntil", { time: until })}</p> : null}
        </div>
      ) : status === "claimed" || status === "verified" ? (
        <div style={{ padding: "12px 15px", borderTop: "1px solid var(--line)" }}>
          <p style={{ margin: 0, fontSize: 11, color: "var(--gold)", lineHeight: "16px" }}>{t("pharmacyDesk.bill.stillOpen")}</p>
          <button className="sec" style={{ width: "100%", marginTop: 9 }} onClick={onDraft}>{t("pharmacyDesk.bill.draft")}</button>
          <p style={{ margin: "7px 0 0 0", fontSize: 10.5, color: "var(--dim)", lineHeight: "15px" }}>{t("pharmacyDesk.bill.draftNothingHeld")}</p>
        </div>
      ) : null}
      {sheetOpen && onDiscount !== null ? (
        <DiscountSheet
          scopeKey={`dispense:${dispense.id}`}
          initial={discount}
          price={async (d) => {
            const p = await previewBill(dispense.id, d);
            return {
              quote: p.discount ?? null, cash: p.byTender?.cash ?? null, digital: p.byTender?.digital ?? null,
              taxPaise: p.totals.cgstPaise + p.totals.sgstPaise,
            };
          }}
          ask={(d) => askDispenseDiscount(dispense.id, d)}
          onApply={(d) => { setSheetOpen(false); onDiscount(d); }}
          onRemove={discount === null ? null : () => { setSheetOpen(false); onDiscount(null); }}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </aside>
  );
}

function Row({ what, amt, tone, testId }: { what: string; amt: string; tone: string; testId?: string }): React.ReactElement {
  return (
    <div data-testid={testId} style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "6px 0", borderTop: "1px solid var(--line2)" }}>
      <span style={{ flexGrow: 1, fontSize: 11.5, color: tone }}>{what}</span>
      <span className="mo" style={{ fontSize: 11.5, color: tone }}>{amt}</span>
    </div>
  );
}
