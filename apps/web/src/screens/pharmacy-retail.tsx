import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import { fmtIst } from "../lib/format";
import { fetchInvoicePrint } from "../lib/billing-api";
import { duplicateCandidates } from "../lib/patients-api";
import { todayIst } from "../lib/opd-api";
import {
  acceptRetailReturn, fetchRetailSale, fetchRetailSaleByBill, fetchRetailSales, fetchRetailState, pharmacyErrorText, previewRetailSale,
  searchRetailShelf, sellRetail,
} from "../lib/pharmacy-api";
import { InvoicePrint } from "../components/invoice-print";
import { PatientPicker } from "../components/patient-picker";
import { PharmacyBillAnnex } from "../components/pharmacy-bill-annex";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downscaleToJpeg } from "./slip-capture";
import type { WirePatientHit } from "../lib/patients-api";
import type {
  RetailCustomer, RetailPrescription, WireLabel, WireRetailPreview, WireRetailSale, WireRetailShelfEntry,
} from "../lib/pharmacy-api";

/**
 * ═══ PHARMACY P19 — THE WALK-IN RETAIL COUNTER ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p19-retail-sales.md`. One sale, top to
 * bottom: who is buying (found, or registered here), what (typed or scanned), the prescription when
 * a line needs one, the money. The server judges every gate — the licence, the schedule, the
 * pharmacist's registration, allergies — and this screen shows its refusal as a sentence.
 */
type CartLine = { entry: WireRetailShelfEntry; qty: string };
type NewCustomer = { name: string; sex: "male" | "female" | "other"; age: string; phone: string; address: string };
type Customer = { kind: "existing"; id: string; label: string } | { kind: "new"; draft: NewCustomer };
type RxDraft = { prescriberName: string; prescriberRegNo: string; prescriberAddress: string; rxDate: string; photo: string | null };

const EMPTY_NEW: NewCustomer = { name: "", sex: "female", age: "", phone: "", address: "" };
const EMPTY_RX: RxDraft = { prescriberName: "", prescriberRegNo: "", prescriberAddress: "", rxDate: "", photo: null };
const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;
/** "15/09/2026, 10:30", in the hospital's time whatever the desk machine's zone. */
const soldOn = (iso: string): string => {
  const d = todayIst(new Date(iso));
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}, ${fmtIst(iso)}`;
};

/** The chemist's annex, from the sale: batch, expiry and the pharmacist, as the counter's bill carries them. */
/**
 * P19b — a sealed pack comes back against its bill. The server judges O-7 (the 7 days, the sealed
 * pack, whole strips, the storage class, the batch's shelf life, what is left to return); this form
 * offers only what is left, and sends nothing until the pharmacist attests the pack is sealed.
 */
function RetailReturn(): React.ReactElement {
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
    <section className="space-y-2 rounded border p-3">
      <h2 className="font-semibold">{t("pharmacyRetail.returnTitle")}</h2>
      <p className="max-w-3xl text-xs text-muted-foreground">{t("pharmacyRetail.returnIntro")}</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (billNo.trim() !== "") void find(); }}>
        <Input aria-label={t("pharmacyRetail.billNo")} placeholder={t("pharmacyRetail.billNo")} value={billNo} onChange={(e) => setBillNo(e.target.value)} className="max-w-xs" />
        <Button type="submit" variant="outline">{t("pharmacyRetail.findBill")}</Button>
      </form>
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {sale !== null && (
        <div className="space-y-2" data-testid="retail-return">
          <p className="text-sm font-medium">{t("pharmacyRetail.returnSale", { no: sale.invoiceNo, name: sale.patient.name, when: soldOn(sale.soldAt) })}</p>
          <table className="text-sm">
            <tbody>
              {sale.lines.map((l) => (
                <tr key={l.lineIdx} data-testid={`return-line-${String(l.lineIdx)}`}>
                  <td className="pr-3">{l.drugName}</td>
                  <td className="whitespace-nowrap pr-3 font-mono">{l.batchNo}</td>
                  <td className="whitespace-nowrap pr-3">{t("pharmacyRetail.returnLineState", { sold: l.qtyBase, back: l.returnedQtyBase ?? 0 })}</td>
                  <td>
                    {leftOf(l) > 0 && (
                      <Input aria-label={t("pharmacyRetail.returnQty", { drug: l.drugName })} inputMode="numeric" className="w-20" value={qty[l.lineIdx] ?? ""}
                        onChange={(e) => setQty({ ...qty, [l.lineIdx]: e.target.value.replace(/\D/g, "") })} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">{t("pharmacyRetail.returnReason")}
              <Input aria-label={t("pharmacyRetail.returnReason")} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <label className="text-sm">{t("pharmacyRetail.returnClass")}
              <select aria-label={t("pharmacyRetail.returnClass")} className="ml-1 rounded border px-2 py-1" value={reasonClass}
                onChange={(e) => setReasonClass(e.target.value as "genuine" | "mistake")}>
                <option value="genuine">{t("pharmacyRetail.returnClass_genuine")}</option>
                <option value="mistake">{t("pharmacyRetail.returnClass_mistake")}</option>
              </select>
            </label>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={sealed} onChange={(e) => setSealed(e.target.checked)} />
              {t("pharmacyRetail.returnSealed")}
            </label>
            <Button type="button" disabled={!valid} onClick={() => { void accept(); }}>{t("pharmacyRetail.returnSubmit")}</Button>
          </div>
          {done !== null && <p className="text-sm text-green-800" data-testid="retail-returned">{t("pharmacyRetail.returned", { no: done })}</p>}
        </div>
      )}
    </section>
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

export function PharmacyRetail(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["pharmacy", "retail", "state"], queryFn: fetchRetailState });
  const today = useQuery({ queryKey: ["pharmacy", "retail", "sales"], queryFn: () => fetchRetailSales() });
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [newDraft, setNewDraft] = useState<NewCustomer>(EMPTY_NEW);
  const [registering, setRegistering] = useState(false);
  const [matches, setMatches] = useState<WirePatientHit[] | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<WireRetailShelfEntry[] | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [preview, setPreview] = useState<WireRetailPreview | null>(null);
  const [rx, setRx] = useState<RxDraft>(EMPTY_RX);
  const [mode, setMode] = useState<"cash" | "upi" | "card">("cash");
  const [tendered, setTendered] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sold, setSold] = useState<WireRetailSale | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);
  const [saleKey, setSaleKey] = useState(newIdempotencyKey);

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
  const invalidate = (): void => { setPreview(null); };

  const search = async (): Promise<void> => {
    setError(null);
    try {
      const items = await searchRetailShelf(q.trim());
      // A scanned pack with exactly one match goes straight into the cart.
      if (items.length === 1 && items[0]!.scannedBatchId !== null) { add(items[0]!); return; }
      setFound(items);
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };
  const add = (entry: WireRetailShelfEntry): void => {
    setCart((c) => [...c, { entry, qty: "" }]);
    setFound(null); setQ(""); invalidate();
  };

  const runPreview = async (): Promise<void> => {
    setError(null);
    try {
      const p = await previewRetailSale({
        ...(customer?.kind === "existing" ? { patientId: customer.id } : {}), lines: cartLines(),
      });
      setPreview(p);
      setTendered(String(p.totals.netPayablePaise / 100));
    } catch (e) {
      setError(pharmacyErrorText(e, t));
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

  const sell = async (acknowledged = false): Promise<void> => {
    const who = customerBody(acknowledged);
    if (who === null || preview === null) return;
    setError(null);
    const prescription: RetailPrescription | undefined = preview.prescriptionRequired && rx.photo !== null ? {
      prescriberName: rx.prescriberName, prescriberRegNo: rx.prescriberRegNo, prescriberAddress: rx.prescriberAddress,
      rxDate: rx.rxDate, photo: { mimeType: "image/jpeg", imageBase64: rx.photo },
    } : undefined;
    const amountPaise = Math.round(Number(tendered) * 100);
    try {
      const sale = await sellRetail({
        customer: who, lines: cartLines(), ...(prescription === undefined ? {} : { prescription }),
        tenders: [{ mode, amountPaise, ...(ref.trim() === "" ? {} : { refText: ref.trim() }) }],
        ...(mode === "cash" && amountPaise > preview.totals.netPayablePaise ? { changeGivenPaise: amountPaise - preview.totals.netPayablePaise } : {}),
      }, saleKey);
      setSold(sale); setMatches(null);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "retail", "sales"] });
    } catch (e) {
      const candidates = duplicateCandidates(e);
      if (candidates !== null) { setMatches(candidates); return; }
      setError(pharmacyErrorText(e, t));
    }
  };

  const reset = (): void => {
    setCustomer(null); setNewDraft(EMPTY_NEW); setRegistering(false); setMatches(null); setCart([]); setPreview(null);
    setRx(EMPTY_RX); setMode("cash"); setTendered(""); setRef(""); setError(null); setSold(null); setSaleKey(newIdempotencyKey());
  };

  if (printing !== null) {
    const failed = printSale.error ?? printInvoice.error;
    return (
      <div data-seat="pharmacy-retail" className="min-h-screen space-y-3 p-4">
        <Button type="button" variant="outline" className="no-print" onClick={() => setPrinting(null)}>{t("pharmacyRetail.backToCounter")}</Button>
        {failed !== null && <p role="alert" className="text-sm text-red-700">{pharmacyErrorText(failed, t)}</p>}
        {printSale.data !== undefined && printInvoice.data !== undefined && (
          <InvoicePrint data={printInvoice.data} annex={(
            <div className="space-y-1">
              <PharmacyBillAnnex label={annexOf(printSale.data)} />
              {printSale.data.prescription !== null && (
                <p className="text-xs" data-testid="bill-prescriber">
                  {t("pharmacyRetail.billPrescriber", {
                    name: printSale.data.prescription.prescriberName, reg: printSale.data.prescription.prescriberRegNo,
                    address: printSale.data.prescription.prescriberAddress, date: printSale.data.prescription.rxDate,
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
  const rxComplete = rx.prescriberName.trim() !== "" && rx.prescriberRegNo.trim() !== "" && rx.prescriberAddress.trim() !== "" && rx.rxDate !== "" && rx.photo !== null;
  const newValid = newDraft.name.trim() !== "" && (newDraft.phone === "" || /^[6-9]\d{9}$/.test(newDraft.phone)) && (newDraft.age === "" || /^\d{1,3}$/.test(newDraft.age));
  const canSell = !shut && customer !== null && preview !== null && (!preview.prescriptionRequired || rxComplete)
    && Number(tendered) * 100 >= preview.totals.netPayablePaise && (mode === "cash" || ref.trim() !== "");
  const blocked = preview?.checks !== null && preview?.checks !== undefined
    && (preview.checks.allergies.length > 0 || preview.checks.interactions.some((i) => i.severity === "severe"));

  return (
    <div data-seat="pharmacy-retail" className="min-h-screen space-y-5 p-4">
      <h1 className="text-xl font-semibold">{t("pharmacyRetail.title")}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyRetail.intro")}</p>
      {shut && (
        <p role="alert" data-testid="retail-shut" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {t(`pharmacyRetail.shut_${licence.state}`, { to: licence.licence?.validTo ?? "" })}
        </p>
      )}
      {licence?.state === "current" && licence.daysLeft !== null && licence.daysLeft <= 60 && (
        <p role="status" className="rounded bg-amber-100 p-2 text-sm text-amber-900">{t("pharmacyRetail.licenceEnds", { count: licence.daysLeft, to: licence.licence?.validTo ?? "" })}</p>
      )}
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {sold !== null ? (
        <section className="space-y-2 rounded border p-3" data-testid="retail-sold">
          <p className="font-medium text-green-800">{t("pharmacyRetail.sold", { invoice: sold.invoiceNo, amount: rupees(sold.netPaise), name: sold.patient.name })}</p>
          {sold.patient.registeredHere && <p className="text-sm">{t("pharmacyRetail.registeredAs", { uhid: sold.patient.uhid })}</p>}
          {sold.scheduled && <p className="text-sm">{t("pharmacyRetail.stampRx")}</p>}
          <div className="flex gap-2">
            <Button type="button" onClick={() => setPrinting(sold.id)}>{t("pharmacyRetail.printBill")}</Button>
            <Button type="button" variant="outline" onClick={reset}>{t("pharmacyRetail.nextSale")}</Button>
          </div>
        </section>
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="font-semibold">{t("pharmacyRetail.customer")}</h2>
            {customer === null && !registering && (
              <div className="space-y-2">
                <PatientPicker autoFocus onPick={(hit) => { setCustomer({ kind: "existing", id: hit.id, label: `${hit.name ?? hit.uhid} · ${hit.uhid}` }); invalidate(); }} />
                <Button type="button" variant="outline" size="sm" onClick={() => setRegistering(true)}>{t("pharmacyRetail.newCustomer")}</Button>
              </div>
            )}
            {customer === null && registering && (
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (newValid) setCustomer({ kind: "new", draft: newDraft }); }}>
                <label className="text-sm">{t("pharmacyRetail.name")}
                  <Input value={newDraft.name} onChange={(e) => setNewDraft({ ...newDraft, name: e.target.value })} />
                </label>
                <label className="text-sm">{t("pharmacyRetail.sex")}
                  <select className="ml-1 rounded border px-2 py-1" value={newDraft.sex} onChange={(e) => setNewDraft({ ...newDraft, sex: e.target.value as NewCustomer["sex"] })}>
                    <option value="female">{t("pharmacyRetail.sex_female")}</option>
                    <option value="male">{t("pharmacyRetail.sex_male")}</option>
                    <option value="other">{t("pharmacyRetail.sex_other")}</option>
                  </select>
                </label>
                <label className="text-sm">{t("pharmacyRetail.age")}
                  <Input inputMode="numeric" className="w-20" value={newDraft.age} onChange={(e) => setNewDraft({ ...newDraft, age: e.target.value })} />
                </label>
                <label className="text-sm">{t("pharmacyRetail.mobile")}
                  <Input inputMode="tel" className="w-36" value={newDraft.phone} onChange={(e) => setNewDraft({ ...newDraft, phone: e.target.value })} />
                </label>
                <label className="text-sm">{t("pharmacyRetail.address")}
                  <Input value={newDraft.address} onChange={(e) => setNewDraft({ ...newDraft, address: e.target.value })} />
                </label>
                <Button type="submit" size="sm" disabled={!newValid}>{t("pharmacyRetail.useCustomer")}</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setRegistering(false)}>{t("pharmacyRetail.findInstead")}</Button>
              </form>
            )}
            {customer !== null && (
              <p className="text-sm" data-testid="retail-customer">
                {customer.kind === "existing" ? customer.label : t("pharmacyRetail.toRegister", { name: customer.draft.name })}
                <Button type="button" variant="link" size="sm" onClick={() => { setCustomer(null); setMatches(null); invalidate(); }}>{t("pharmacyRetail.change")}</Button>
              </p>
            )}
            {matches !== null && (
              <div className="rounded border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="retail-matches">
                <p>{t("pharmacyRetail.matches")}</p>
                <ul className="my-1 space-y-1">
                  {matches.map((m) => (
                    <li key={m.id} className="flex items-center gap-2">
                      <span>{m.name} · {m.uhid}{m.phone === null ? "" : ` · ${m.phone}`}</span>
                      <Button type="button" size="sm" variant="outline" onClick={() => {
                        setCustomer({ kind: "existing", id: m.id, label: `${m.name} · ${m.uhid}` }); setMatches(null); invalidate();
                      }}>{t("pharmacyRetail.useThis")}</Button>
                    </li>
                  ))}
                </ul>
                <Button type="button" size="sm" onClick={() => { void sell(true); }}>{t("pharmacyRetail.someoneNew")}</Button>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold">{t("pharmacyRetail.medicines")}</h2>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim() !== "") void search(); }}>
              <Input aria-label={t("pharmacyRetail.search")} placeholder={t("pharmacyRetail.search")} value={q} onChange={(e) => setQ(e.target.value)} className="max-w-md" />
              <Button type="submit" variant="outline">{t("pharmacyRetail.find")}</Button>
            </form>
            {found !== null && found.length === 0 && <p className="text-sm text-muted-foreground">{t("pharmacyRetail.notOnShelf")}</p>}
            {found !== null && found.length > 0 && (
              <ul className="space-y-1" aria-label={t("pharmacyRetail.results")}>
                {found.map((f) => (
                  <li key={f.itemId} className="flex items-center gap-2 text-sm">
                    <span>{f.brandName} {f.strengthLabel ?? ""} {f.form}</span>
                    {f.scheduleFlag === "H" || f.scheduleFlag === "H1" ? <span className="rounded bg-red-100 px-1 text-xs text-red-800">{t("pharmacyRetail.schedule", { flag: f.scheduleFlag })}</span> : null}
                    <span className="text-muted-foreground">{t("pharmacyRetail.available", { count: f.available, unit: f.baseUom })}</span>
                    <Button type="button" size="sm" variant="outline" disabled={f.available === 0} onClick={() => add(f)}>{t("pharmacyRetail.add")}</Button>
                  </li>
                ))}
              </ul>
            )}
            {cart.length > 0 && (
              <table className="text-sm">
                <tbody>
                  {cart.map((c, i) => (
                    <tr key={`${c.entry.itemId}-${String(i)}`} data-testid={`cart-${String(i)}`}>
                      <td className="pr-2">{c.entry.brandName} {c.entry.strengthLabel ?? ""} {c.entry.form}</td>
                      <td className="pr-2">
                        {c.entry.scheduleFlag === "H" || c.entry.scheduleFlag === "H1" ? <span className="rounded bg-red-100 px-1 text-xs text-red-800">{t("pharmacyRetail.schedule", { flag: c.entry.scheduleFlag })}</span> : null}
                      </td>
                      <td className="pr-2">
                        <Input aria-label={t("pharmacyRetail.qtyOf", { name: c.entry.brandName })} inputMode="numeric" className="w-20" value={c.qty}
                          onChange={(e) => { const v = e.target.value; setCart((all) => all.map((x, j) => (j === i ? { ...x, qty: v } : x))); invalidate(); }} />
                      </td>
                      <td className="pr-2 text-muted-foreground">{c.entry.baseUom}</td>
                      <td><Button type="button" size="sm" variant="link" onClick={() => { setCart((all) => all.filter((_, j) => j !== i)); invalidate(); }}>{t("pharmacyRetail.remove")}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <Button type="button" variant="outline" disabled={!cartValid} onClick={() => { void runPreview(); }}>{t("pharmacyRetail.price")}</Button>
          </section>

          {preview !== null && (
            <section className="space-y-2" data-testid="retail-preview">
              <table className="text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="pr-3 font-normal">{t("pharmacyBill.drug")}</th>
                    <th className="pr-3 font-normal">{t("pharmacyBill.batch")}</th>
                    <th className="pr-3 font-normal">{t("pharmacyBill.expiry")}</th>
                    <th className="text-right font-normal">{t("pharmacyBill.qty")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((l) => (
                    <tr key={l.lineIdx}>
                      <td className="pr-3">{l.brandName} {l.strengthLabel ?? ""}</td>
                      <td className="pr-3 font-mono">{l.batchNo}</td>
                      <td className="pr-3">{l.expiryDate ?? ""}</td>
                      <td className="text-right">{l.qtyBase}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="font-medium" data-testid="retail-total">{t("pharmacyRetail.total", { amount: rupees(preview.totals.netPayablePaise) })}</p>
              {preview.checks !== null && preview.checks.allergies.map((a) => (
                <p key={`a-${String(a.lineIdx)}-${a.substance}`} role="alert" className="text-sm text-red-700">{t("pharmacyRetail.allergy", { substance: a.substance })}</p>
              ))}
              {preview.checks !== null && preview.checks.interactions.map((h, i) => (
                <p key={`i-${String(i)}`} className={h.severity === "severe" ? "text-sm text-red-700" : "text-sm text-amber-800"}>{h.note}</p>
              ))}
              {preview.checks === null && customer?.kind === "new" && <p className="text-xs text-muted-foreground">{t("pharmacyRetail.noHistory")}</p>}

              {preview.prescriptionRequired && (
                <fieldset className="space-y-2 rounded border p-2" data-testid="retail-rx">
                  <legend className="px-1 text-sm font-medium">{t("pharmacyRetail.rxTitle")}</legend>
                  <div className="flex flex-wrap gap-2">
                    <label className="text-sm">{t("pharmacyRetail.prescriberName")}
                      <Input value={rx.prescriberName} onChange={(e) => setRx({ ...rx, prescriberName: e.target.value })} />
                    </label>
                    <label className="text-sm">{t("pharmacyRetail.prescriberRegNo")}
                      <Input value={rx.prescriberRegNo} onChange={(e) => setRx({ ...rx, prescriberRegNo: e.target.value })} />
                    </label>
                    <label className="text-sm">{t("pharmacyRetail.prescriberAddress")}
                      <Input value={rx.prescriberAddress} onChange={(e) => setRx({ ...rx, prescriberAddress: e.target.value })} />
                    </label>
                    <label className="text-sm">{t("pharmacyRetail.rxDate")}
                      <Input type="date" value={rx.rxDate} onChange={(e) => setRx({ ...rx, rxDate: e.target.value })} />
                    </label>
                  </div>
                  <label className="block text-sm">{t("pharmacyRetail.rxPhoto")}
                    <input type="file" accept="image/*" capture="environment" className="ml-2" onChange={(e) => { void onPhoto(e.target.files?.[0]); }} />
                  </label>
                  {rx.photo !== null && <p className="text-xs text-green-700">{t("pharmacyRetail.photoReady")}</p>}
                </fieldset>
              )}

              <div className="flex flex-wrap items-end gap-2">
                <label className="text-sm">{t("pharmacyRetail.mode")}
                  <select className="ml-1 rounded border px-2 py-1" value={mode} onChange={(e) => setMode(e.target.value as "cash" | "upi" | "card")}>
                    <option value="cash">{t("pharmacyRetail.mode_cash")}</option>
                    <option value="upi">{t("pharmacyRetail.mode_upi")}</option>
                    <option value="card">{t("pharmacyRetail.mode_card")}</option>
                  </select>
                </label>
                <label className="text-sm">{t("pharmacyRetail.tendered")}
                  <Input inputMode="decimal" className="w-28" value={tendered} onChange={(e) => setTendered(e.target.value)} />
                </label>
                {mode !== "cash" && (
                  <label className="text-sm">{t("pharmacyRetail.reference")}
                    <Input value={ref} onChange={(e) => setRef(e.target.value)} />
                  </label>
                )}
                <Button type="button" disabled={!canSell || blocked} onClick={() => { void sell(); }}>{t("pharmacyRetail.sell")}</Button>
              </div>
              {mode === "cash" && Number(tendered) * 100 > preview.totals.netPayablePaise && (
                <p className="text-sm" data-testid="retail-change">{t("pharmacyRetail.change_due", { amount: rupees(Math.round(Number(tendered) * 100) - preview.totals.netPayablePaise) })}</p>
              )}
            </section>
          )}
        </>
      )}

      <RetailReturn />

      <section className="space-y-1">
        <h2 className="font-semibold">{t("pharmacyRetail.today")}</h2>
        {today.data !== undefined && today.data.length === 0 && <p className="text-sm text-muted-foreground">{t("pharmacyRetail.noneToday")}</p>}
        <ul className="text-sm">
          {(today.data ?? []).map((s) => (
            <li key={s.id} className="flex items-center gap-2" data-testid={`retail-row-${s.id}`}>
              <span>{fmtIst(s.soldAt)}</span>
              <span className="font-mono">{s.invoiceNo}</span>
              <span>{rupees(s.netPaise)}</span>
              {s.scheduled && <span className="rounded bg-red-100 px-1 text-xs text-red-800">{t("pharmacyRetail.onRx")}</span>}
              <Button type="button" size="sm" variant="link" onClick={() => setPrinting(s.id)}>{t("pharmacyRetail.printBill")}</Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
