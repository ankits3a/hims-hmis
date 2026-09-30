import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { newIdempotencyKey } from "../lib/api";
import { fmtIst, useDebounced } from "../lib/format";
import { fetchCurrentSession, fetchInvoicePrint } from "../lib/billing-api";
import { duplicateCandidates } from "../lib/patients-api";
import { todayIst } from "../lib/opd-api";
import {
  acceptRetailReturn, fetchMyRegistration, fetchRetailSale, fetchRetailSaleByBill, fetchRetailSales, fetchRetailState, pharmacyErrorText,
  askRetailDiscount, previewRetailSale, searchRetailShelf, sellRetail,
} from "../lib/pharmacy-api";
import { InvoicePrint } from "../components/invoice-print";
import { parseRupees } from "../components/money-input";
import { PatientPicker } from "../components/patient-picker";
import { PharmacyBillAnnex } from "../components/pharmacy-bill-annex";
import { istClock, istDateLabel } from "./desk-one/model";
import { rupees, signedRupees } from "./pharmacy-desk/bill";
import { DiscountSheet, DiscountWait, discountLabel, useDiscountApproval } from "./pharmacy-desk/discount";
import type { AppliedDiscount } from "./pharmacy-desk/discount";
import { expiryLabel } from "./pharmacy-desk/work";
import { downscaleToJpeg } from "./slip-capture";
import type { WirePatientHit } from "../lib/patients-api";
import type {
  RetailCustomer, RetailPrescription, WireLabel, WireRetailPreview, WireRetailSale, WireRetailSaleRow, WireRetailShelfEntry,
} from "../lib/pharmacy-api";
import "../styles/paper-pine.css";
import "./desk-one/desk-one.css";
import "./pharmacy-desk/pharmacy-desk.css";
import "./pharmacy-retail.css";

/**
 * ═══ PHARMACY P19 — THE WALK-IN RETAIL COUNTER ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p19-retail-sales.md`. The server
 * judges every gate — the licence, the schedule, the pharmacist's registration, allergies — and this
 * screen shows its refusal as a sentence.
 *
 * ═══ UX-AUDIT 2026-09-28 — THE COUNTER WEARS THE PHARMACY DESK ═══
 *
 * Decision: `docs/superpowers/decisions/2026-09-28-pharmacy-retail.md`. The screen was one stacked
 * column; it is now the desk's frame (`Desk.dc.html`): the customer in hand in the LEFT lane, one
 * numbered flow in the CENTRE (Medicines → Prescription, when a line is Schedule H/H1 → Bill) with
 * a PINNED bar that offers the single next act, and the day's sales in the RIGHT column, where a
 * return is its own entry point rather than a form in the middle of a sale. Below 1280 px the list
 * is a drawer; below 768 px the lane stacks above the flow and the bar is fixed to the screen's foot.
 * Layout classes are `rt-*` under `.d1` (`pharmacy-retail.css`): the unlayered `.d1 button` reset
 * would strip Tailwind utilities, so nothing here leans on them.
 */
type CartLine = { entry: WireRetailShelfEntry; qty: string };
type NewCustomer = { name: string; sex: "male" | "female" | "other"; age: string; phone: string; address: string };
type Customer = { kind: "existing"; id: string; name: string; uhid: string } | { kind: "new"; draft: NewCustomer };
type RxDraft = { prescriberName: string; prescriberRegNo: string; prescriberAddress: string; rxDate: string; photo: string | null };
type Mode = "cash" | "upi" | "card";

const EMPTY_NEW: NewCustomer = { name: "", sex: "female", age: "", phone: "", address: "" };
const EMPTY_RX: RxDraft = { prescriberName: "", prescriberRegNo: "", prescriberAddress: "", rxDate: "", photo: null };
/** "15/09/2026, 10:30", in the hospital's time whatever the desk machine's zone. */
const soldOn = (iso: string): string => {
  const d = todayIst(new Date(iso));
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}, ${fmtIst(iso)}`;
};
/** `2026-09-15` → `15/09/2026`, the way the hospital writes a date. */
const dmy = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso);

/**
 * UX-AUDIT 2026-09-28 — the prescription date is typed as the prescription prints it, dd/mm/yyyy
 * (a native date field showed mm/dd/yyyy on the counter's browser). Slashes are put in as the
 * pharmacist types; the wire keeps ISO. Null for anything that is not a real calendar day.
 */
export function parseDmy(text: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (m === null) return null;
  const iso = `${m[3]!}-${m[2]!}-${m[1]!}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}
function maskDmy(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter((x) => x !== "").join("/");
}
const scheduled = (flag: string | null): flag is "H" | "H1" => flag === "H" || flag === "H1";
const customerOf = (s: WireRetailSaleRow): string => s.customer?.name ?? s.customer?.alias ?? s.customer?.uhid ?? "—";

/**
 * P19b — a sealed pack comes back against its bill. The server judges O-7 (the 7 days, the sealed
 * pack, whole strips, the storage class, the batch's shelf life, what is left to return); this form
 * offers only what is left, and sends nothing until the pharmacist attests the pack is sealed.
 * UX-AUDIT 2026-09-28 — opened from the day's list as its own sheet, never inside a sale.
 */
function RetailReturn({ onClose }: { onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [billNo, setBillNo] = useState("");
  const [sale, setSale] = useState<WireRetailSale | null>(null);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [sealed, setSealed] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonClass, setReasonClass] = useState<"genuine" | "mistake">("genuine");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);

  const leftOf = (l: WireRetailSale["lines"][number]): number => l.qtyBase - (l.returnedQtyBase ?? 0);
  const wanted = sale === null ? [] : sale.lines.filter((l) => (qty[l.lineIdx] ?? "") !== "");
  const valid = sale !== null && wanted.length > 0 && sealed && reason.trim().length >= 3
    && wanted.every((l) => /^\d+$/.test(qty[l.lineIdx]!) && Number(qty[l.lineIdx]) > 0 && Number(qty[l.lineIdx]) <= leftOf(l));

  const find = async (): Promise<void> => {
    setError(null); setDone(null); setSale(null);
    try {
      setSale(await fetchRetailSaleByBill(billNo.trim()));
      setQty({}); setSealed(false); setReason(""); setReasonClass("genuine"); setKey(newIdempotencyKey());
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };
  const accept = async (): Promise<void> => {
    if (sale === null || !valid) return;
    setError(null);
    try {
      const r = await acceptRetailReturn(sale.id, {
        lines: wanted.map((l) => ({ lineIdx: l.lineIdx, qtyBase: Number(qty[l.lineIdx]) })),
        sealedIntact: true, reason: reason.trim(), reasonClass,
      }, key);
      setSale(r.sale); setDone(r.creditNoteNo);
      setQty({}); setSealed(false); setReason(""); setKey(newIdempotencyKey());
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };

  return (
    <div className="ovl rt-ovl" role="dialog" aria-modal="true" aria-label={t("pharmacyRetail.returnTitle")} onClick={onClose}>
      <div className="box rt-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="rt-sheet-head">
          <h2 className="rt-h2">{t("pharmacyRetail.returnTitle")}</h2>
          <button type="button" className="sec" onClick={onClose}>{t("pharmacyRetail.close")} <span className="kb">Esc</span></button>
        </div>
        <p className="rt-note">{t("pharmacyRetail.returnIntro")}</p>
        <form className="rt-row" onSubmit={(e) => { e.preventDefault(); if (billNo.trim() !== "") void find(); }}>
          <input className="in mo" aria-label={t("pharmacyRetail.billNo")} placeholder={t("pharmacyRetail.billNo")} value={billNo} onChange={(e) => setBillNo(e.target.value)} autoFocus />
          <button type="submit" className="sec grn">{t("pharmacyRetail.findBill")}</button>
        </form>
        {error !== null && <p role="alert" className="rt-err">{error}</p>}
        {sale !== null && (
          <div className="rt-stack" data-testid="retail-return">
            <p className="rt-strong">{t("pharmacyRetail.returnSale", { no: sale.invoiceNo, name: sale.patient.name, when: soldOn(sale.soldAt) })}</p>
            <div className="rt-tablewrap">
              <table className="rt-table">
                <tbody>
                  {sale.lines.map((l) => (
                    <tr key={l.lineIdx} data-testid={`return-line-${String(l.lineIdx)}`}>
                      <td>{l.drugName}</td>
                      <td className="mo">{l.batchNo}</td>
                      <td className="rt-nowrap">{t("pharmacyRetail.returnLineState", { sold: l.qtyBase, back: l.returnedQtyBase ?? 0 })}</td>
                      <td>
                        {leftOf(l) > 0 && (
                          <input className="in rt-qty" aria-label={t("pharmacyRetail.returnQty", { drug: l.drugName })} inputMode="numeric" value={qty[l.lineIdx] ?? ""}
                            onChange={(e) => setQty({ ...qty, [l.lineIdx]: e.target.value.replace(/\D/g, "") })} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rt-grid2">
              <label className="rt-field"><span className="tag">{t("pharmacyRetail.returnReason")}</span>
                <input className="in" aria-label={t("pharmacyRetail.returnReason")} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <label className="rt-field"><span className="tag">{t("pharmacyRetail.returnClass")}</span>
                <select className="in" aria-label={t("pharmacyRetail.returnClass")} value={reasonClass}
                  onChange={(e) => setReasonClass(e.target.value as "genuine" | "mistake")}>
                  <option value="genuine">{t("pharmacyRetail.returnClass_genuine")}</option>
                  <option value="mistake">{t("pharmacyRetail.returnClass_mistake")}</option>
                </select>
              </label>
            </div>
            <label className="rt-check">
              <input type="checkbox" checked={sealed} onChange={(e) => setSealed(e.target.checked)} />
              {t("pharmacyRetail.returnSealed")}
            </label>
            <div><button type="button" className="pri" disabled={!valid} onClick={() => { void accept(); }}>{t("pharmacyRetail.returnSubmit")}</button></div>
            {done !== null && <p className="rt-ok" data-testid="retail-returned">{t("pharmacyRetail.returned", { no: done })}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function annexOf(sale: WireRetailSale): WireLabel {
  return {
    dispenseNo: null, status: "sold", patient: { display: sale.patient.name, uhid: sale.patient.uhid }, handedOverAt: sale.soldAt,
    lines: sale.lines.map((l) => ({
      lineIdx: l.lineIdx, drug: l.drugName, strength: null, form: null, qtyBase: l.qtyBase, unit: l.baseUom, packs: null,
      batchNo: l.batchNo, expiryDate: l.expiryDate, directions: "", substitutedFor: null,
    })),
    pharmacist: { name: sale.soldByName, council: null, registrationNo: sale.pharmacistRegNo },
  };
}

/**
 * UX-AUDIT 2026-09-28 — the medicine field is a typeahead over the walk-in shelf: typing lists what
 * is on it (no Find button), ↑/↓ and Enter add the highlighted one. A scanner types and presses
 * Enter: a pack whose barcode names exactly one batch goes straight into the cart, as before.
 */
function ShelfSearch({ onAdd }: { onAdd: (entry: WireRetailShelfEntry) => void }): React.ReactElement {
  const { t } = useTranslation();
  const listId = useId();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounced = useDebounced(q.trim(), 200);
  /* The list closes a beat after the field loses focus (so a click on an option lands first); a stale close must not shut a list reopened since. */
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reopen = (): void => { if (closing.current !== null) { clearTimeout(closing.current); closing.current = null; } setOpen(true); };
  useEffect(() => () => { if (closing.current !== null) clearTimeout(closing.current); }, []);
  const found = useQuery({
    queryKey: ["pharmacy", "retail", "shelf", debounced],
    queryFn: () => searchRetailShelf(debounced),
    enabled: debounced.length >= 2,
    retry: false,
  });
  const items = found.data ?? [];
  useEffect(() => { setActive(0); }, [found.data]);

  const add = (entry: WireRetailShelfEntry): void => {
    if (entry.available === 0) return;
    onAdd(entry); setQ(""); setOpen(false); setError(null);
  };
  const enter = async (): Promise<void> => {
    const text = q.trim();
    if (text === "") return;
    if (open && debounced === text && items.length > 0) { add(items[Math.min(active, items.length - 1)]!); return; }
    /* A scan arrives faster than the debounce: ask now. */
    try {
      const now = await searchRetailShelf(text);
      if (now.length === 1 && now[0]!.scannedBatchId !== null) { add(now[0]!); return; }
      reopen();
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };

  const showList = open && debounced.length >= 2 && found.data !== undefined;
  return (
    <div className="rt-combo">
      <input
        className="in"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && items.length > 0 ? `${listId}-${String(active)}` : undefined}
        aria-label={t("pharmacyRetail.search")}
        placeholder={t("pharmacyRetail.searchPlaceholder")}
        autoComplete="off"
        value={q}
        onChange={(e) => { setQ(e.target.value); reopen(); setError(null); }}
        onFocus={reopen}
        onBlur={() => { closing.current = setTimeout(() => { closing.current = null; setOpen(false); }, 150); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); reopen(); setActive((a) => Math.min(a + 1, Math.max(items.length - 1, 0))); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); void enter(); }
          else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
        }}
      />
      {showList && (
        <ul id={listId} role="listbox" aria-label={t("pharmacyRetail.results")} className="rt-options">
          {items.length === 0 && <li className="rt-option rt-muted" role="presentation">{t("pharmacyRetail.notOnShelf")}</li>}
          {items.map((f, i) => (
            <li
              key={f.itemId}
              id={`${listId}-${String(i)}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={f.available === 0}
              className={i === active ? "rt-option sel" : "rt-option"}
              onMouseDown={(e) => { e.preventDefault(); add(f); }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="rt-grow">
                <span className="rt-strong">{f.brandName}</span> <span className="rt-muted">{f.strengthLabel ?? ""} {f.form}</span>
              </span>
              {scheduled(f.scheduleFlag) && <span className="pill rd">{t("pharmacyRetail.schedule", { flag: f.scheduleFlag })}</span>}
              <span className={f.available === 0 ? "rt-muted mo" : "mo"}>{t("pharmacyRetail.available", { count: f.available, unit: f.baseUom })}</span>
            </li>
          ))}
        </ul>
      )}
      {error !== null && <p role="alert" className="rt-err">{error}</p>}
    </div>
  );
}

export function PharmacyRetail(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { username } = useAuth();
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["pharmacy", "retail", "state"], queryFn: fetchRetailState });
  const today = useQuery({ queryKey: ["pharmacy", "retail", "sales"], queryFn: () => fetchRetailSales() });
  /* The desk's header, the same two preconditions: may this login sell a scheduled drug, and is a drawer open to take money. */
  const registration = useQuery({ queryKey: ["pharmacy", "pharmacists", "me"], queryFn: fetchMyRegistration, staleTime: 5 * 60_000, retry: false });
  const drawer = useQuery({ queryKey: ["billing", "session", "current"], queryFn: fetchCurrentSession, refetchInterval: 60_000, retry: false });
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [newDraft, setNewDraft] = useState<NewCustomer>(EMPTY_NEW);
  const [registering, setRegistering] = useState(false);
  const [matches, setMatches] = useState<WirePatientHit[] | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [preview, setPreview] = useState<WireRetailPreview | null>(null);
  const [rx, setRx] = useState<RxDraft>(EMPTY_RX);
  const [mode, setMode] = useState<Mode>("cash");
  const [tendered, setTendered] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sold, setSold] = useState<WireRetailSale | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);
  const [saleKey, setSaleKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [returning, setReturning] = useState(false);
  /*
    OWNER RULING 2026-09-30 — the walk-in discount, from the bill's ⋯ sheet. `cartId` is the cart's own id: an
    ask above 10% is filed against it, and the sale is made under it, so one approval sells one cart once.
  */
  const [discount, setDiscount] = useState<AppliedDiscount | null>(null);
  const [cartId, setCartId] = useState(newIdempotencyKey);
  const [billMenu, setBillMenu] = useState(false);
  const [discountSheet, setDiscountSheet] = useState(false);
  const approval = useDiscountApproval(discount);
  const [clock, setClock] = useState(() => istClock());
  useEffect(() => {
    const id = setInterval(() => { setClock(istClock()); }, 15_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (returning) setReturning(false);
      else if (listOpen) setListOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listOpen, returning]);

  const printSale = useQuery({ queryKey: ["pharmacy", "retail", "sale", printing], queryFn: () => fetchRetailSale(printing ?? ""), enabled: printing !== null });
  const printInvoice = useQuery({
    queryKey: ["billing", "invoice-print", printSale.data?.invoiceId],
    queryFn: () => fetchInvoicePrint(printSale.data?.invoiceId ?? ""),
    enabled: printSale.data !== undefined,
  });

  const cartLines = (): { medicineId: string; qtyBase: number; batchId?: string }[] => cart.map((c) => ({
    medicineId: c.entry.medicineId, qtyBase: Number(c.qty),
    ...(c.entry.scannedBatchId === null ? {} : { batchId: c.entry.scannedBatchId }),
  }));
  const cartValid = cart.length > 0 && cart.every((c) => /^\d+$/.test(c.qty) && Number(c.qty) > 0);
  /* A changed cart is a different bill: its preview, and any discount priced on the old one, go. */
  const invalidate = (): void => { setPreview(null); setDiscount(null); setCartId(newIdempotencyKey()); };

  const add = (entry: WireRetailShelfEntry): void => {
    setCart((c) => [...c, { entry, qty: "" }]);
    invalidate();
  };

  const runPreview = async (withDiscount: AppliedDiscount | null = discount): Promise<void> => {
    setError(null); setBusy(true);
    try {
      const p = await previewRetailSale({
        ...(customer?.kind === "existing" ? { patientId: customer.id } : {}), lines: cartLines(),
        ...(withDiscount === null ? {} : { discount: { kind: withDiscount.kind, value: withDiscount.value, reason: withDiscount.reason } }),
      });
      setPreview(p);
      /* UX-AUDIT 2026-09-28 — nothing is prefilled: the cash box waits for what the customer hands over. */
      setTendered("");
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const onPhoto = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setError(null);
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((done, fail) => { img.onload = () => { done(); }; img.onerror = () => { fail(new Error("decode")); }; img.src = url; });
      const b64 = await downscaleToJpeg(img, img.naturalWidth, img.naturalHeight);
      if (b64 === null) { setError(t("pharmacyRetail.photoTooLarge")); return; }
      setRx((r) => ({ ...r, photo: b64 }));
    } catch {
      setError(t("pharmacyRetail.photoUnreadable"));
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const customerBody = (acknowledged: boolean): RetailCustomer | null => {
    if (customer === null) return null;
    if (customer.kind === "existing") return { existingId: customer.id };
    const d = customer.draft;
    return {
      register: {
        name: d.name.trim(), sex: d.sex,
        ...(d.age === "" ? {} : { ageYears: Number(d.age) }),
        ...(d.phone === "" ? {} : { phone: d.phone }),
        ...(d.address.trim() === "" ? {} : { addressLine: d.address.trim() }),
      },
      ...(acknowledged ? { acknowledgedDuplicates: true } : {}),
    };
  };

  /* OWNER RULING 2026-09-30 — cash rounds DOWN to the rupee, UPI and card are collected to the paisa. */
  const due = preview === null ? null
    : preview.byTender === undefined ? { netPayablePaise: preview.totals.netPayablePaise, roundingPaise: preview.totals.roundingPaise ?? 0 }
      : mode === "cash" ? preview.byTender.cash : preview.byTender.digital;
  const payable = due?.netPayablePaise ?? 0;
  const cashParse = parseRupees(tendered);
  const cashPaise = cashParse.ok ? cashParse.paise : undefined;
  /* A UPI or card payment is the bill's amount exactly; only cash is counted, and its change given. */
  const amountPaise = mode === "cash" ? (cashPaise ?? 0) : payable;

  const sell = async (acknowledged = false): Promise<void> => {
    const who = customerBody(acknowledged);
    if (who === null || preview === null) return;
    setError(null);
    const rxIso = parseDmy(rx.rxDate);
    const prescription: RetailPrescription | undefined = preview.prescriptionRequired && rx.photo !== null && rxIso !== null ? {
      prescriberName: rx.prescriberName, prescriberRegNo: rx.prescriberRegNo, prescriberAddress: rx.prescriberAddress,
      rxDate: rxIso, photo: { mimeType: "image/jpeg", imageBase64: rx.photo },
    } : undefined;
    setBusy(true);
    try {
      const sale = await sellRetail({
        customer: who, lines: cartLines(), ...(prescription === undefined ? {} : { prescription }),
        tenders: [{ mode, amountPaise, ...(ref.trim() === "" ? {} : { refText: ref.trim() }) }],
        ...(mode === "cash" && amountPaise > payable ? { changeGivenPaise: amountPaise - payable } : {}),
        ...(discount === null ? {} : {
          discount: { kind: discount.kind, value: discount.value, reason: discount.reason, ...(discount.approvalId === null ? {} : { approvalId: discount.approvalId }) },
          ...(discount.approvalId === null ? {} : { draftId: cartId }),
        }),
      }, saleKey);
      setSold(sale); setMatches(null);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "retail", "sales"] });
    } catch (e) {
      const candidates = duplicateCandidates(e);
      if (candidates !== null) { setMatches(candidates); return; }
      setError(pharmacyErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const reset = (): void => {
    setCustomer(null); setNewDraft(EMPTY_NEW); setRegistering(false); setMatches(null); setCart([]); setPreview(null);
    setRx(EMPTY_RX); setMode("cash"); setTendered(""); setRef(""); setError(null); setSold(null); setSaleKey(newIdempotencyKey());
    setDiscount(null); setCartId(newIdempotencyKey()); setBillMenu(false); setDiscountSheet(false);
  };

  if (printing !== null) {
    const failed = printSale.error ?? printInvoice.error;
    return (
      <div data-seat="pharmacy-retail" className="min-h-screen space-y-3 p-4">
        <button type="button" className="no-print rounded border px-3 py-1 text-sm" onClick={() => setPrinting(null)}>{t("pharmacyRetail.backToCounter")}</button>
        {failed !== null && <p role="alert" className="text-sm text-red-700">{pharmacyErrorText(failed, t)}</p>}
        {printSale.data !== undefined && printInvoice.data !== undefined && (
          <InvoicePrint data={printInvoice.data} rows={printSale.data.billRows ?? null} annex={(
            <div className="space-y-1">
              <PharmacyBillAnnex label={annexOf(printSale.data)} />
              {printSale.data.prescription !== null && (
                <p className="text-xs" data-testid="bill-prescriber">
                  {t("pharmacyRetail.billPrescriber", {
                    name: printSale.data.prescription.prescriberName, reg: printSale.data.prescription.prescriberRegNo,
                    address: printSale.data.prescription.prescriberAddress, date: dmy(printSale.data.prescription.rxDate),
                  })}
                </p>
              )}
            </div>
          )} />
        )}
      </div>
    );
  }

  const licence = state.data;
  const shut = licence !== undefined && licence.state !== "current";
  const rxIso = parseDmy(rx.rxDate);
  const rxFuture = rxIso !== null && rxIso > todayIst();
  const rxComplete = rx.prescriberName.trim() !== "" && rx.prescriberRegNo.trim() !== "" && rx.prescriberAddress.trim() !== ""
    && rxIso !== null && !rxFuture && rx.photo !== null;
  const newValid = newDraft.name.trim() !== "" && (newDraft.phone === "" || /^[6-9]\d{9}$/.test(newDraft.phone)) && (newDraft.age === "" || /^\d{1,3}$/.test(newDraft.age));
  const blocked = preview?.checks !== null && preview?.checks !== undefined
    && (preview.checks.allergies.length > 0 || preview.checks.interactions.some((i) => i.severity === "severe"));
  const moneyOk = preview !== null && (mode === "cash" ? cashPaise !== undefined && cashPaise >= payable : ref.trim() !== "");
  const discountReady = discount === null || approval.status === "none" || approval.status === "granted";
  const canSell = !shut && !busy && customer !== null && preview !== null && (!preview.prescriptionRequired || rxComplete) && moneyOk && !blocked && discountReady;
  const byIdx = new Map((preview?.lines ?? []).map((l) => [l.lineIdx, l] as const));
  const rxNeeded = preview?.prescriptionRequired ?? cart.some((c) => scheduled(c.entry.scheduleFlag));
  const rows = today.data ?? [];

  /* The pinned bar: ONE next act, and the reason it is not open yet said beside it. */
  const step = sold !== null ? 3 : preview === null ? 1 : preview.prescriptionRequired && !rxComplete ? 2 : 3;
  const why: string | null = sold !== null ? null
    : shut ? t("pharmacyRetail.why.shut")
      : cart.length === 0 ? t("pharmacyRetail.why.empty")
        : !cartValid ? t("pharmacyRetail.why.qty")
          : preview === null ? t("pharmacyRetail.why.price")
            : customer === null ? t("pharmacyRetail.why.customer")
              : blocked ? t("pharmacyRetail.why.blocked")
                : preview.prescriptionRequired && !rxComplete ? t("pharmacyRetail.why.rx")
                  : !moneyOk ? (mode === "cash" ? t("pharmacyRetail.why.cash", { amount: rupees(payable) }) : t("pharmacyRetail.why.ref"))
                    : null;

  const stepLabel = [t("pharmacyRetail.step.medicines"), t("pharmacyRetail.step.prescription"), t("pharmacyRetail.step.bill")];

  return (
    <div className="d1" data-lang={i18n.language.startsWith("hi") ? "hi" : "en"} data-seat="pharmacy-retail">
      <div className="rt-frame">
        <div className="top rt-top">
          <div className="rt-brand">
            <div className="rt-diamond" />
            <span className="mo rt-word">{t("pharmacyRetail.wordmark")}</span>
          </div>
          <span className="rt-where">
            {t("pharmacyRetail.where")} · <strong>{username ?? t("pharmacyDesk.thisDesk")}</strong>
          </span>
          {registration.data === undefined ? null : registration.data.registration === null ? (
            <span className="pill rd" data-testid="retail-registered">{t("pharmacyDesk.header.notRegistered")}</span>
          ) : (
            <span className="pill on" data-testid="retail-registered" title={registration.data.registration.council}>
              {t("pharmacyDesk.header.registered", { no: registration.data.registration.registrationNo })}
            </span>
          )}
          {drawer.isPending ? null : drawer.data?.session?.status === "open" ? (
            <span className="pill">{t("pharmacyDesk.header.drawerOpen", { float: rupees(drawer.data.session.openingFloatPaise) })}</span>
          ) : (
            <span className="pill gd">{t("pharmacyDesk.header.noDrawer")}</span>
          )}
          <span className="pill">PHARM-RETAIL</span>
          <div className="rt-grow" />
          <span className="mo rt-clock">{istDateLabel()} · {clock}</span>
          <button type="button" className="pill rt-listbtn" aria-expanded={listOpen} onClick={() => setListOpen((o) => !o)}>
            {t("pharmacyRetail.todayCount", { count: rows.length })}
          </button>
        </div>

        <div className="rt-body">
          {/* ── LEFT: the customer in hand ── */}
          <aside className="rt-lane" aria-label={t("pharmacyRetail.customer")}>
            <p className="tag">{customer === null ? t("pharmacyRetail.nobodyInHand") : t("pharmacyRetail.inHand")}</p>
            {customer === null && !registering && (
              <div className="rt-stack">
                <p className="rt-note">{t("pharmacyRetail.findHint")}</p>
                <div className="rt-pick">
                  <PatientPicker autoFocus onPick={(hit) => { setCustomer({ kind: "existing", id: hit.id, name: hit.name ?? hit.uhid, uhid: hit.uhid }); invalidate(); }} />
                </div>
                <button type="button" className="sec" onClick={() => setRegistering(true)}>{t("pharmacyRetail.newCustomer")}</button>
              </div>
            )}
            {customer === null && registering && (
              <form className="rt-stack" onSubmit={(e) => { e.preventDefault(); if (newValid) setCustomer({ kind: "new", draft: newDraft }); }}>
                <label className="rt-field"><span className="tag">{t("pharmacyRetail.name")}</span>
                  <input className="in" aria-label={t("pharmacyRetail.name")} value={newDraft.name} onChange={(e) => setNewDraft({ ...newDraft, name: e.target.value })} autoFocus />
                </label>
                <div className="rt-grid2">
                  <label className="rt-field"><span className="tag">{t("pharmacyRetail.sex")}</span>
                    <select className="in" aria-label={t("pharmacyRetail.sex")} value={newDraft.sex} onChange={(e) => setNewDraft({ ...newDraft, sex: e.target.value as NewCustomer["sex"] })}>
                      <option value="female">{t("pharmacyRetail.sex_female")}</option>
                      <option value="male">{t("pharmacyRetail.sex_male")}</option>
                      <option value="other">{t("pharmacyRetail.sex_other")}</option>
                    </select>
                  </label>
                  <label className="rt-field"><span className="tag">{t("pharmacyRetail.age")}</span>
                    <input className="in" aria-label={t("pharmacyRetail.age")} inputMode="numeric" value={newDraft.age} onChange={(e) => setNewDraft({ ...newDraft, age: e.target.value })} />
                  </label>
                </div>
                <label className="rt-field"><span className="tag">{t("pharmacyRetail.mobile")}</span>
                  <input className="in mo" aria-label={t("pharmacyRetail.mobile")} inputMode="tel" value={newDraft.phone} onChange={(e) => setNewDraft({ ...newDraft, phone: e.target.value })} />
                </label>
                <label className="rt-field"><span className="tag">{t("pharmacyRetail.address")}</span>
                  <input className="in" aria-label={t("pharmacyRetail.address")} value={newDraft.address} onChange={(e) => setNewDraft({ ...newDraft, address: e.target.value })} />
                </label>
                <div className="rt-row">
                  <button type="submit" className="pri" disabled={!newValid}>{t("pharmacyRetail.useCustomer")}</button>
                  <button type="button" className="sec" onClick={() => setRegistering(false)}>{t("pharmacyRetail.findInstead")}</button>
                </div>
              </form>
            )}
            {customer !== null && (
              <div className="rt-who" data-testid="retail-customer">
                <p className="rt-name">{customer.kind === "existing" ? customer.name : customer.draft.name}</p>
                <p className="mo rt-muted">
                  {customer.kind === "existing" ? customer.uhid : t("pharmacyRetail.toRegisterNote")}
                </p>
                <button type="button" className="rt-link" onClick={() => { setCustomer(null); setMatches(null); invalidate(); }}>{t("pharmacyRetail.change")}</button>
              </div>
            )}
            {matches !== null && (
              <div className="rt-warn" data-testid="retail-matches">
                <p>{t("pharmacyRetail.matches")}</p>
                <ul className="rt-stack">
                  {matches.map((m) => (
                    <li key={m.id} className="rt-stack-tight">
                      <span>{m.name} · {m.uhid}{m.phone === null ? "" : ` · ${m.phone}`}</span>
                      <button type="button" className="sec" onClick={() => {
                        setCustomer({ kind: "existing", id: m.id, name: m.name ?? m.uhid, uhid: m.uhid }); setMatches(null); invalidate();
                      }}>{t("pharmacyRetail.useThis")}</button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="sec grn" onClick={() => { void sell(true); }}>{t("pharmacyRetail.someoneNew")}</button>
              </div>
            )}
            {preview?.checks === null && customer?.kind === "new" && <p className="rt-note">{t("pharmacyRetail.noHistory")}</p>}
          </aside>

          {/* ── CENTRE: one numbered flow, and the bar that offers the next act ── */}
          <main className="rt-centre">
            <div className="rt-scroll">
              <div className="rt-head">
                <h1 className="rt-h1">{t("pharmacyRetail.title")}</h1>
                <ol className="rt-steps" aria-label={t("pharmacyRetail.stepsLabel")}>
                  {stepLabel.map((label, i) => {
                    const n = i + 1;
                    const skip = n === 2 && !rxNeeded;
                    return (
                      <li key={label} className={skip ? "rt-step skip" : n === step ? "rt-step now" : n < step ? "rt-step done" : "rt-step"} aria-current={n === step ? "step" : undefined}>
                        <span className="rt-dot">{n}</span>{label}{skip ? <span className="rt-muted"> · {t("pharmacyRetail.step.notNeeded")}</span> : null}
                      </li>
                    );
                  })}
                </ol>
              </div>
              {shut && (
                <p role="alert" data-testid="retail-shut" className="rt-bad">
                  {t(`pharmacyRetail.shut_${licence.state}`, { to: licence.licence?.validTo === undefined ? "" : dmy(licence.licence.validTo) })}
                </p>
              )}
              {licence?.state === "current" && licence.daysLeft !== null && licence.daysLeft <= 60 && (
                <p role="status" className="rt-warn">{t("pharmacyRetail.licenceEnds", { count: licence.daysLeft, to: licence.licence?.validTo === undefined ? "" : dmy(licence.licence.validTo) })}</p>
              )}
              {error !== null && <p role="alert" className="rt-bad">{error}</p>}

              {sold !== null ? (
                <section className="box rt-card" data-testid="retail-sold">
                  <p className="rt-okbig">{t("pharmacyRetail.sold", { invoice: sold.invoiceNo, amount: rupees(sold.netPaise), name: sold.patient.name })}</p>
                  {sold.patient.registeredHere && <p>{t("pharmacyRetail.registeredAs", { uhid: sold.patient.uhid })}</p>}
                  {sold.scheduled && <p>{t("pharmacyRetail.stampRx")}</p>}
                  <div className="rt-row">
                    <button type="button" className="sec grn" onClick={() => setPrinting(sold.id)}>{t("pharmacyRetail.printBill")}</button>
                  </div>
                </section>
              ) : (
                <>
                  <section className="box rt-card rt-medcard" aria-labelledby="rt-s1">
                    <h2 id="rt-s1" className="rt-h2"><span className="rt-dot">1</span>{t("pharmacyRetail.medicines")}</h2>
                    <ShelfSearch onAdd={add} />
                    {cart.length > 0 && (
                      <div className="rt-tablewrap">
                        <table className="rt-table rt-cart" data-testid="retail-cart">
                          <thead>
                            <tr>
                              <th className="tag">{t("pharmacyBill.drug")}</th>
                              <th className="tag">{t("pharmacyBill.qty")}</th>
                              <th className="tag">{t("pharmacyBill.batch")}</th>
                              <th className="tag">{t("pharmacyBill.expiry")}</th>
                              <th className="tag rt-num">{t("pharmacyRetail.rate")}</th>
                              <th className="tag rt-num">{t("pharmacyRetail.gst")}</th>
                              <th className="tag rt-num">{t("pharmacyRetail.amount")}</th>
                              <th><span className="sr-only">{t("pharmacyRetail.remove")}</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            {cart.map((c, i) => {
                              const p = byIdx.get(i);
                              return (
                                <tr key={`${c.entry.itemId}-${String(i)}`} data-testid={`cart-${String(i)}`}>
                                  <td>
                                    <span className="rt-strong">{c.entry.brandName}</span> <span className="rt-muted">{c.entry.strengthLabel ?? ""} {c.entry.form}</span>
                                    {scheduled(c.entry.scheduleFlag) ? <> <span className="pill rd">{t("pharmacyRetail.schedule", { flag: c.entry.scheduleFlag })}</span></> : null}
                                  </td>
                                  <td className="rt-nowrap" data-label={t("pharmacyBill.qty")}>
                                    <input className="in rt-qty mo" aria-label={t("pharmacyRetail.qtyOf", { name: c.entry.brandName })} inputMode="numeric" value={c.qty}
                                      onChange={(e) => { const v = e.target.value.replace(/\D/g, ""); setCart((all) => all.map((x, j) => (j === i ? { ...x, qty: v } : x))); invalidate(); }} />
                                    <span className="rt-muted"> {c.entry.baseUom}</span>
                                  </td>
                                  <td className="mo rt-nowrap" data-label={t("pharmacyBill.batch")}>{p?.batchNo ?? "—"}</td>
                                  <td className="mo rt-nowrap" data-label={t("pharmacyBill.expiry")}>{p === undefined ? "—" : expiryLabel(p.expiryDate)}</td>
                                  <td className="mo rt-num" data-label={t("pharmacyRetail.rate")}>{p?.price === undefined ? "—" : rupees(p.price.unitPaise)}</td>
                                  <td className="mo rt-num" data-label={t("pharmacyRetail.gst")}>{p?.price === undefined ? "—" : `${String(p.price.gstRateBps / 100)}% · ${rupees(p.price.taxPaise)}`}</td>
                                  <td className="mo rt-num rt-strong" data-label={t("pharmacyRetail.amount")}>{p?.price === undefined ? "—" : rupees(p.price.amountPaise)}</td>
                                  <td><button type="button" className="rt-link" onClick={() => { setCart((all) => all.filter((_, j) => j !== i)); invalidate(); }}>{t("pharmacyRetail.remove")}</button></td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {preview !== null && (
                      <dl className="rt-totals" data-testid="retail-totals">
                        <dt>{t("pharmacyRetail.gross")}</dt><dd className="mo">{rupees(preview.totals.grossPaise)}</dd>
                        {preview.totals.discountPaise > 0 && <><dt data-testid="retail-discount">{discount === null ? t("pharmacyRetail.discount") : `${t("pharmacyRetail.discount")} ${discountLabel(discount)} · ${discount.reason}`}</dt><dd className="mo">− {rupees(preview.totals.discountPaise)}</dd></>}
                        <dt>{t("pharmacyRetail.gstInside")}</dt><dd className="mo">{rupees(preview.totals.taxPaise)}</dd>
                        {due !== null && due.roundingPaise !== 0 && <><dt>{t("pharmacyDiscount.rounding")}</dt><dd className="mo" data-testid="retail-rounding">{signedRupees(due.roundingPaise)}</dd></>}
                        <dt className="rt-pay">{t("pharmacyRetail.payable")}</dt><dd className="mo rt-pay" data-testid="retail-total">{rupees(payable)}</dd>
                      </dl>
                    )}
                    {preview !== null && <p className="rt-note">{t("pharmacyRetail.mrpNote")}</p>}
                    {preview?.checks?.allergies.map((a) => (
                      <p key={`a-${String(a.lineIdx)}-${a.substance}`} role="alert" className="rt-bad">{t("pharmacyRetail.allergy", { substance: a.substance })}</p>
                    ))}
                    {preview?.checks?.interactions.map((h, i) => (
                      <p key={`i-${String(i)}`} className={h.severity === "severe" ? "rt-bad" : "rt-warn"}>{h.note}</p>
                    ))}
                  </section>

                  {preview !== null && preview.prescriptionRequired && (
                    <section className="box rt-card" data-testid="retail-rx" aria-labelledby="rt-s2">
                      <h2 id="rt-s2" className="rt-h2"><span className="rt-dot">2</span>{t("pharmacyRetail.rxTitle")}</h2>
                      <div className="rt-grid2">
                        <label className="rt-field"><span className="tag">{t("pharmacyRetail.prescriberName")}</span>
                          <input className="in" aria-label={t("pharmacyRetail.prescriberName")} value={rx.prescriberName} onChange={(e) => setRx({ ...rx, prescriberName: e.target.value })} />
                        </label>
                        <label className="rt-field"><span className="tag">{t("pharmacyRetail.prescriberRegNo")}</span>
                          <input className="in mo" aria-label={t("pharmacyRetail.prescriberRegNo")} value={rx.prescriberRegNo} onChange={(e) => setRx({ ...rx, prescriberRegNo: e.target.value })} />
                        </label>
                        <label className="rt-field rt-span2"><span className="tag">{t("pharmacyRetail.prescriberAddress")}</span>
                          <input className="in" aria-label={t("pharmacyRetail.prescriberAddress")} value={rx.prescriberAddress} onChange={(e) => setRx({ ...rx, prescriberAddress: e.target.value })} />
                        </label>
                        <label className="rt-field"><span className="tag">{t("pharmacyRetail.rxDate")}</span>
                          <input className="in mo" aria-label={t("pharmacyRetail.rxDate")} inputMode="numeric" placeholder={t("pharmacyRetail.dateFormat")}
                            value={rx.rxDate} onChange={(e) => setRx({ ...rx, rxDate: maskDmy(e.target.value) })} />
                          {rx.rxDate.length === 10 && rxIso === null && <span className="rt-err">{t("pharmacyRetail.dateInvalid")}</span>}
                          {rxFuture && <span className="rt-err">{t("pharmacyRetail.dateFuture")}</span>}
                        </label>
                        <label className="rt-field"><span className="tag">{t("pharmacyRetail.rxPhoto")}</span>
                          <input type="file" accept="image/*" capture="environment" aria-label={t("pharmacyRetail.rxPhoto")} onChange={(e) => { void onPhoto(e.target.files?.[0]); }} />
                          {rx.photo !== null && <span className="rt-ok">{t("pharmacyRetail.photoReady")}</span>}
                        </label>
                      </div>
                    </section>
                  )}

                  {preview !== null && (
                    <section className="box rt-card" aria-labelledby="rt-s3">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <h2 id="rt-s3" className="rt-h2" style={{ flexGrow: 1 }}><span className="rt-dot">3</span>{t("pharmacyRetail.step.bill")}</h2>
                        {/* OWNER RULING 2026-09-30 — the discount lives behind ⋯, never in the line rows. */}
                        {sold === null ? (
                          <span style={{ position: "relative" }}>
                            <button
                              type="button" aria-label={t("pharmacyDiscount.menu")} aria-expanded={billMenu} aria-haspopup="true" data-testid="retail-bill-menu"
                              onClick={() => setBillMenu((m) => !m)}
                              style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--dim)" }}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
                            </button>
                            {billMenu ? (
                              <span className="lmenu" style={{ display: "block", minWidth: 200 }}>
                                <button type="button" data-testid="retail-discount-open" onClick={() => { setBillMenu(false); setDiscountSheet(true); }}>
                                  {discount === null ? t("pharmacyDiscount.open") : t("pharmacyDiscount.change")}
                                </button>
                                {discount !== null ? (
                                  <button type="button" onClick={() => { setBillMenu(false); setDiscount(null); void runPreview(null); }}>{t("pharmacyDiscount.remove")}</button>
                                ) : null}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                      <DiscountWait discount={discount} />
                      <div className="rt-seg" role="radiogroup" aria-label={t("pharmacyRetail.mode")}>
                        {(["cash", "upi", "card"] as const).map((m) => (
                          <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "rt-segb on" : "rt-segb"} onClick={() => setMode(m)}>
                            {t(`pharmacyRetail.mode_${m}`)}
                          </button>
                        ))}
                      </div>
                      {mode === "cash" ? (
                        <div className="rt-row rt-end">
                          <label className="rt-field"><span className="tag">{t("pharmacyRetail.tendered")}</span>
                            <input className="in mo rt-money" aria-label={t("pharmacyRetail.tendered")} inputMode="decimal" placeholder={(payable / 100).toFixed(2)}
                              value={tendered} onChange={(e) => setTendered(e.target.value)} />
                          </label>
                          <button type="button" className="sec" onClick={() => setTendered((payable / 100).toFixed(2))}>{t("pharmacyRetail.exact", { amount: rupees(payable) })}</button>
                        </div>
                      ) : (
                        <div className="rt-row rt-end">
                          <p className="rt-strong">{t("pharmacyRetail.charge", { amount: rupees(payable) })}</p>
                          <label className="rt-field"><span className="tag">{t("pharmacyRetail.reference")}</span>
                            <input className="in mo" aria-label={t("pharmacyRetail.reference")} value={ref} onChange={(e) => setRef(e.target.value)} />
                          </label>
                        </div>
                      )}
                      {mode === "cash" && !cashParse.ok && <p className="rt-err">{t("pharmacyRetail.cashInvalid")}</p>}
                      {mode === "cash" && cashPaise !== undefined && cashPaise > payable && (
                        <p className="rt-strong" data-testid="retail-change">{t("pharmacyRetail.change_due", { amount: rupees(cashPaise - payable) })}</p>
                      )}
                    </section>
                  )}
                </>
              )}
            </div>

            {discountSheet && preview !== null ? (
              <DiscountSheet
                scopeKey={`cart:${cartId}`}
                initial={discount}
                price={async (d) => {
                  const p = await previewRetailSale({ ...(customer?.kind === "existing" ? { patientId: customer.id } : {}), lines: cartLines(), discount: d });
                  return { quote: p.discount ?? null, cash: p.byTender?.cash ?? null, digital: p.byTender?.digital ?? null, taxPaise: p.totals.taxPaise };
                }}
                ask={(d) => askRetailDiscount({ draftId: cartId, ...(customer?.kind === "existing" ? { patientId: customer.id } : {}), lines: cartLines(), discount: d })}
                onApply={(d) => { setDiscountSheet(false); setDiscount(d); void runPreview(d); }}
                onRemove={discount === null ? null : () => { setDiscountSheet(false); setDiscount(null); void runPreview(null); }}
                onClose={() => setDiscountSheet(false)}
              />
            ) : null}
            <div className="rt-bar" data-testid="retail-bar">
              <div className="rt-grow">
                <p className="tag">{t("pharmacyRetail.stepOf", { n: step, label: stepLabel[step - 1] })}</p>
                <p className="rt-barwhy">{sold !== null ? t("pharmacyRetail.why.sold") : why ?? t("pharmacyRetail.why.ready")}</p>
              </div>
              {sold !== null ? (
                <button type="button" className="pri" onClick={reset}>{t("pharmacyRetail.nextSale")}</button>
              ) : preview === null ? (
                <button type="button" className="pri" disabled={!cartValid || busy} onClick={() => { void runPreview(); }}>{t("pharmacyRetail.price")}</button>
              ) : (
                <button type="button" className="pri" aria-label={t("pharmacyRetail.sell")} disabled={!canSell} onClick={() => { void sell(); }}>
                  {t("pharmacyRetail.sell")} · {rupees(payable)}
                </button>
              )}
            </div>
          </main>

          {/* ── RIGHT: the day's walk-in sales; a return starts here, never inside a sale ── */}
          {listOpen && <div className="rt-scrim" onClick={() => setListOpen(false)} aria-hidden="true" />}
          <aside className={listOpen ? "rt-list open" : "rt-list"} aria-label={t("pharmacyRetail.today")}>
            <div className="rt-listhead">
              <p className="tag">{t("pharmacyRetail.todayTag", { count: rows.length })}</p>
              <button type="button" className="rt-link rt-closelist" onClick={() => setListOpen(false)}>{t("pharmacyRetail.close")}</button>
            </div>
            <div className="rt-listact">
              <button type="button" className="sec" onClick={() => setReturning(true)}>{t("pharmacyRetail.returnTitle")}</button>
            </div>
            <h2 className="sr-only">{t("pharmacyRetail.today")}</h2>
            {today.data !== undefined && rows.length === 0 && <p className="rt-note rt-pad">{t("pharmacyRetail.noneToday")}</p>}
            <ul className="rt-sales">
              {rows.map((s) => (
                <li key={s.id} data-testid={`retail-row-${s.id}`} className="rt-sale">
                  <div className="rt-saletop">
                    <span className="rt-strong rt-ellipsis">{customerOf(s)}</span>
                    <span className="mo rt-strong">{rupees(s.netPaise)}</span>
                  </div>
                  <div className="rt-salebot">
                    <span className="mo rt-muted">{fmtIst(s.soldAt)}</span>
                    <span className="mo rt-muted rt-ellipsis">{s.invoiceNo}</span>
                    {s.scheduled && <span className="pill rd">{t("pharmacyRetail.onRx")}</span>}
                    <span className="rt-grow" />
                    <button type="button" className="rt-link" onClick={() => setPrinting(s.id)}>{t("pharmacyRetail.printBill")}</button>
                  </div>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
      {returning && <RetailReturn onClose={() => setReturning(false)} />}
    </div>
  );
}
