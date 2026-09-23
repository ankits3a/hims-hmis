import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchPatientRail } from "../../lib/pharmacy-api";
import { billQtyText, quoteAmountPaise } from "../../lib/pharmacy-bill";
import type { Tender, WireDispense, WirePricedDraft } from "../../lib/pharmacy-api";

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

export function BillRail({
  dispense, preview, previewError, drawerOpen, busy, error, now, onTake, onDraft, onOpenDrawer,
}: {
  dispense: WireDispense;
  preview: WirePricedDraft | null;
  previewError: string | null;
  /** The pharmacist's OWN drawer is open. `null` while it is being read. */
  drawerOpen: boolean | null;
  busy: boolean;
  error: string | null;
  /** The desk's clock (it ticks every 15 s) — E13 asks it whether the hold has ended. */
  now: Date;
  onTake: (tenders: Tender[], changePaise: number) => void;
  onDraft: () => void;
  onOpenDrawer: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TenderMode>("upi");
  const [cash, setCash] = useState("");
  const [upi, setUpi] = useState("");
  const [ref, setRef] = useState("");
  const status = dispense.status;
  const collected = status === "picked";
  const paid = status === "billed" || status === "handed_over";
  const payable = preview?.totals.netPayablePaise ?? null;
  const plan = payable === null ? null : tendersFor(mode, payable, cash, upi, ref);
  const canTake = collected && drawerOpen === true && plan !== null && !busy;

  /* A different ticket starts with an empty tender — the last patient's cash is not this one's. */
  useEffect(() => { setCash(""); setUpi(""); setRef(""); setMode("upi"); }, [dispense.id]);

  /* PD-D6 — `1-4` choose the tender, `Ctrl+⏎` takes it; guarded exactly as the buttons are. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!collected || drawerOpen !== true) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (canTake) onTake(plan.tenders, plan.changePaise);
        return;
      }
      if (typingIn(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const picked = MODES[Number(e.key) - 1];
      if (picked !== undefined && /^[1-4]$/.test(e.key)) { e.preventDefault(); setMode(picked); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canTake, collected, drawerOpen, onTake, plan]);

  /* The same read the left rail made — one query key, so this costs no second request. */
  const rail = useQuery({
    queryKey: ["pharmacy", "patient-rail", dispense.id],
    queryFn: () => fetchPatientRail(dispense.id),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const heldCard = (rail.data?.benefits ?? []).find((b) => b.usable) ?? null;
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
      </div>

      <div style={{ flexGrow: 1, overflowY: "auto", padding: "4px 15px 0 15px" }}>
        {preview === null ? (
          <>
            {dispense.lines.map((l) => {
              /* Priced at today's shelf price for the batch the pick would take — the server's quote, never ours. */
              const amount = l.quote == null || l.qtyBase === null || l.status === "declined" ? null : quoteAmountPaise(l.quote, l.qtyBase);
              return (
                <div key={l.lineIdx} style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "7px 0", borderTop: "1px solid var(--line2)" }}>
                  <span style={{ flexGrow: 1, minWidth: 0, fontSize: 12, color: l.status === "declined" ? "var(--dim)" : "var(--ink)" }}>
                    {l.dispensedMedicine?.brandName ?? l.rxLine.drug}
                    {amount === null || l.qtyBase === null ? null : <span className="mo" style={{ color: "var(--dim)" }}> × {l.qtyBase}</span>}
                  </span>
                  <span className="mo" style={{ fontSize: 12, color: amount === null ? "var(--dim)" : "var(--ink)" }}>
                    {l.status === "declined" ? t("pharmacyDesk.bill.declined") : amount === null ? "—" : rupees(amount)}
                  </span>
                </div>
              );
            })}
            {(dispense.quotedTotalPaise ?? 0) > 0 ? (
              <div style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "11px 0 0 0", marginTop: 4, borderTop: "2px solid var(--ink)" }}>
                <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 600 }}>{t("pharmacyDesk.bill.soFar")}</span>
                <span className="mo" data-testid="desk-sofar" style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-.02em" }}>{rupees(dispense.quotedTotalPaise ?? 0)}</span>
              </div>
            ) : null}
            <p style={{ margin: "10px 0 0 0", fontSize: 11, color: "var(--dim)", lineHeight: "16px" }}>
              {previewError ?? ((dispense.quotedTotalPaise ?? 0) > 0 ? t("pharmacyDesk.bill.soFarWhy") : t("pharmacyDesk.bill.notYet"))}
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
              <Row what={t("pharmacyDesk.bill.discount")} amt={`−${rupees(preview.totals.discountPaise)}`} tone="var(--green)" />
            ) : null}
            <Row what={t("pharmacyDesk.bill.cgst")} amt={rupees(preview.totals.cgstPaise)} tone="var(--dim)" />
            <Row what={t("pharmacyDesk.bill.sgst")} amt={rupees(preview.totals.sgstPaise)} tone="var(--dim)" />
            {preview.totals.roundingPaise !== 0 ? (
              <Row what={t("pharmacyDesk.bill.rounding")} amt={rupees(preview.totals.roundingPaise)} tone="var(--dim)" />
            ) : null}
            <div style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "11px 0 0 0", marginTop: 4, borderTop: "2px solid var(--ink)" }}>
              <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 600 }}>{paid ? t("pharmacyDesk.bill.took") : t("pharmacyDesk.bill.toCollect")}</span>
              <span className="mo" data-testid="desk-payable" style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-.02em" }}>{rupees(preview.totals.netPayablePaise)}</span>
            </div>
            <p style={{ margin: "7px 0 0 0", fontSize: 10.5, color: "var(--dim)", lineHeight: "15px" }}>{t("pharmacyDesk.bill.inside")}</p>
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
              <button className="pri" style={{ width: "100%", marginTop: 10, height: 46 }} disabled={!canTake} onClick={() => { if (plan !== null) onTake(plan.tenders, plan.changePaise); }}>
                {payable === null ? t("pharmacyDesk.bill.received") : t("pharmacyDesk.bill.receivedAmount", { amount: rupees(payable) })}{" "}
                <span className="kb" style={{ borderColor: "rgba(255,255,255,.35)", background: "rgba(255,255,255,.12)", color: "#d6ece1" }}>Ctrl ⏎</span>
              </button>
            </>
          )}
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
    </aside>
  );
}

function Row({ what, amt, tone }: { what: string; amt: string; tone: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "6px 0", borderTop: "1px solid var(--line2)" }}>
      <span style={{ flexGrow: 1, fontSize: 11.5, color: tone }}>{what}</span>
      <span className="mo" style={{ fontSize: 11.5, color: tone }}>{amt}</span>
    </div>
  );
}
