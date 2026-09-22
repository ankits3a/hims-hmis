import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import { fmtIst } from "../lib/format";
import { todayIst } from "../lib/opd-api";
import { duplicateCandidates } from "../lib/patients-api";
import {
  checkDowntimeSheet, enterPaperDispense, fetchCounterBatches, fetchPaperDispenses, fetchPharmacyStaff, pharmacyErrorText,
  previewPaperDispense, searchCounterShelf,
} from "../lib/pharmacy-api";
import { PatientPicker } from "../components/patient-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downscaleToJpeg } from "./slip-capture";
import type { WirePatientHit } from "../lib/patients-api";
import type {
  CounterStoreCode, RetailCustomer, WireCounterBatch, WireRetailPreview, WireRetailSale, WireRetailShelfEntry, WireSheetCheck,
} from "../lib/pharmacy-api";

/**
 * ═══ PHARMACY P20 — PAPER DISPENSES, ENTERED AFTER AN OUTAGE ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p20-paper-dispenses.md`. One sheet at
 * a time, in the order the sheet is written: the sheet, where and when it happened and who handed
 * it over, the customer, the lines with their batches, the prescription for a scheduled line, and
 * the money that was taken. The server checks the sheet, the outage and every gate as of the time
 * on the sheet; this screen shows its refusals as sentences.
 */
type Line = { entry: WireRetailShelfEntry; qty: string; batchId: string; batches: WireCounterBatch[] };
type NewCustomer = { name: string; sex: "male" | "female" | "other"; age: string; phone: string };
type Customer = { kind: "existing"; id: string; label: string } | { kind: "new"; draft: NewCustomer };
type RxDraft = { prescriberName: string; prescriberRegNo: string; prescriberAddress: string; rxDate: string; photo: string | null };

const EMPTY_NEW: NewCustomer = { name: "", sex: "female", age: "", phone: "" };
const EMPTY_RX: RxDraft = { prescriberName: "", prescriberRegNo: "", prescriberAddress: "", rxDate: "", photo: null };
const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;
/** A `datetime-local` value is a wall-clock time at the hospital, which is IST. */
const istInstant = (local: string): string => `${local.length === 16 ? `${local}:00` : local}+05:30`;

export function PharmacyDowntime(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const staff = useQuery({ queryKey: ["pharmacy", "downtime", "staff"], queryFn: fetchPharmacyStaff });
  const entered = useQuery({ queryKey: ["pharmacy", "downtime", "entries"], queryFn: fetchPaperDispenses });
  const [qr, setQr] = useState("");
  const [sheet, setSheet] = useState<WireSheetCheck | null>(null);
  const [store, setStore] = useState<CounterStoreCode>("PHARM-OPD");
  const [when, setWhen] = useState("");
  const [by, setBy] = useState("");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [registering, setRegistering] = useState(false);
  const [newDraft, setNewDraft] = useState<NewCustomer>(EMPTY_NEW);
  const [matches, setMatches] = useState<WirePatientHit[] | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<WireRetailShelfEntry[] | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [preview, setPreview] = useState<WireRetailPreview | null>(null);
  const [rx, setRx] = useState<RxDraft>(EMPTY_RX);
  const [mode, setMode] = useState<"cash" | "upi" | "card">("cash");
  const [paid, setPaid] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<WireRetailSale | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);

  const stale = (): void => { setPreview(null); };
  const lineBody = (): { medicineId: string; qtyBase: number; batchId: string }[] =>
    lines.map((l) => ({ medicineId: l.entry.medicineId, qtyBase: Number(l.qty), batchId: l.batchId }));
  const linesValid = lines.length > 0 && lines.every((l) => /^\d+$/.test(l.qty) && Number(l.qty) > 0 && l.batchId !== "");

  const scan = async (): Promise<void> => {
    setError(null);
    try {
      setSheet(await checkDowntimeSheet(qr.trim()));
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };
  const search = async (): Promise<void> => {
    setError(null);
    try {
      setFound(await searchCounterShelf(store, q.trim()));
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };
  const add = async (entry: WireRetailShelfEntry): Promise<void> => {
    setError(null);
    try {
      const batches = await fetchCounterBatches(store, entry.itemId);
      setLines((all) => [...all, { entry, qty: "", batchId: entry.scannedBatchId ?? "", batches }]);
      setFound(null); setQ(""); stale();
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };
  const runPreview = async (): Promise<void> => {
    setError(null);
    try {
      const p = await previewPaperDispense({
        storeCode: store, occurredAt: istInstant(when), lines: lineBody(),
        ...(customer?.kind === "existing" ? { patientId: customer.id } : {}),
      });
      setPreview(p);
      setPaid(String(p.totals.netPayablePaise / 100));
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };
  const onPhoto = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((ok, fail) => { img.onload = () => { ok(); }; img.onerror = () => { fail(new Error("decode")); }; img.src = url; });
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
      register: { name: d.name.trim(), sex: d.sex, ...(d.age === "" ? {} : { ageYears: Number(d.age) }), ...(d.phone === "" ? {} : { phone: d.phone }) },
      ...(acknowledged ? { acknowledgedDuplicates: true } : {}),
    };
  };
  const submit = async (acknowledged = false): Promise<void> => {
    const who = customerBody(acknowledged);
    if (who === null || preview === null) return;
    setError(null);
    try {
      const sale = await enterPaperDispense({
        sheetQr: qr.trim(), storeCode: store, occurredAt: istInstant(when), dispensedBy: by, customer: who, lines: lineBody(),
        ...(preview.prescriptionRequired && rx.photo !== null ? {
          prescription: {
            prescriberName: rx.prescriberName, prescriberRegNo: rx.prescriberRegNo, prescriberAddress: rx.prescriberAddress,
            rxDate: rx.rxDate, photo: { mimeType: "image/jpeg", imageBase64: rx.photo },
          },
        } : {}),
        tenders: [{ mode, amountPaise: Math.round(Number(paid) * 100), ...(ref.trim() === "" ? {} : { refText: ref.trim() }) }],
      }, key);
      setDone(sale); setMatches(null);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "downtime", "entries"] });
    } catch (e) {
      const candidates = duplicateCandidates(e);
      if (candidates !== null) { setMatches(candidates); return; }
      setError(pharmacyErrorText(e, t));
    }
  };
  const next = (): void => {
    setQr(""); setSheet(null); setCustomer(null); setRegistering(false); setNewDraft(EMPTY_NEW); setMatches(null);
    setLines([]); setPreview(null); setRx(EMPTY_RX); setPaid(""); setRef(""); setError(null); setDone(null); setKey(newIdempotencyKey());
  };

  const sheetReady = sheet !== null && sheet.valid && sheet.enteredSaleId === null;
  const headerReady = sheetReady && when !== "" && by !== "";
  const rxComplete = rx.prescriberName.trim() !== "" && rx.prescriberRegNo.trim() !== "" && rx.prescriberAddress.trim() !== "" && rx.rxDate !== "" && rx.photo !== null;
  const canEnter = headerReady && customer !== null && preview !== null && (!preview.prescriptionRequired || rxComplete)
    && paid !== "" && Number(paid) >= 0 && (mode === "cash" || ref.trim() !== "");

  return (
    <div className="space-y-5 p-4">
      <h1 className="text-xl font-semibold">{t("pharmacyDowntime.title")}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyDowntime.intro")}</p>
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {done !== null ? (
        <section className="space-y-2 rounded border p-3" data-testid="paper-done">
          <p className="font-medium text-green-800">{t("pharmacyDowntime.entered", { serial: done.sheet?.serial ?? "", invoice: done.invoiceNo, amount: rupees(done.netPaise) })}</p>
          <p className="text-sm">{t("pharmacyDowntime.stampSheet")}</p>
          <Button type="button" onClick={next}>{t("pharmacyDowntime.nextSheet")}</Button>
        </section>
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="font-semibold">{t("pharmacyDowntime.sheet")}</h2>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (qr.trim() !== "") void scan(); }}>
              <Input aria-label={t("pharmacyDowntime.scanSheet")} placeholder={t("pharmacyDowntime.scanSheet")} value={qr}
                onChange={(e) => { setQr(e.target.value); setSheet(null); }} className="max-w-md" autoFocus />
              <Button type="submit" variant="outline">{t("pharmacyDowntime.check")}</Button>
            </form>
            {sheet !== null && (
              <p role="status" data-testid="sheet-status" className={sheetReady ? "text-sm text-green-800" : "text-sm text-red-700"}>
                {!sheet.valid ? t("pharmacyDowntime.sheetInvalid")
                  : sheet.enteredSaleId !== null ? t("pharmacyDowntime.sheetEntered", { serial: sheet.serial ?? "" })
                    : t("pharmacyDowntime.sheetOk", { desk: sheet.desk ?? "", serial: sheet.serial ?? "" })}
              </p>
            )}
          </section>

          {sheetReady && (
            <section className="flex flex-wrap items-end gap-2">
              <label className="text-sm">{t("pharmacyDowntime.counter")}
                <select className="ml-1 rounded border px-2 py-1" value={store} onChange={(e) => { setStore(e.target.value as CounterStoreCode); setLines([]); stale(); }}>
                  <option value="PHARM-OPD">{t("pharmacyDowntime.store_opd")}</option>
                  <option value="PHARM-RETAIL">{t("pharmacyDowntime.store_retail")}</option>
                </select>
              </label>
              <label className="text-sm">{t("pharmacyDowntime.when")}
                <Input type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); stale(); }} />
              </label>
              <label className="text-sm">{t("pharmacyDowntime.by")}
                <select className="ml-1 rounded border px-2 py-1" value={by} onChange={(e) => setBy(e.target.value)}>
                  <option value="">{t("pharmacyDowntime.choose")}</option>
                  {(staff.data ?? []).map((s) => (
                    <option key={s.userId} value={s.userId}>{s.fullName}{s.registered ? "" : ` ${t("pharmacyDowntime.notRegistered")}`}</option>
                  ))}
                </select>
              </label>
            </section>
          )}

          {headerReady && (
            <>
              <section className="space-y-2">
                <h2 className="font-semibold">{t("pharmacyRetail.customer")}</h2>
                {customer === null && !registering && (
                  <div className="space-y-2">
                    <PatientPicker onPick={(hit) => { setCustomer({ kind: "existing", id: hit.id, label: `${hit.name ?? hit.uhid} · ${hit.uhid}` }); stale(); }} />
                    <Button type="button" variant="outline" size="sm" onClick={() => setRegistering(true)}>{t("pharmacyRetail.newCustomer")}</Button>
                  </div>
                )}
                {customer === null && registering && (
                  <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (newDraft.name.trim() !== "") setCustomer({ kind: "new", draft: newDraft }); }}>
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
                    <Button type="submit" size="sm" disabled={newDraft.name.trim() === ""}>{t("pharmacyRetail.useCustomer")}</Button>
                  </form>
                )}
                {customer !== null && (
                  <p className="text-sm" data-testid="paper-customer">
                    {customer.kind === "existing" ? customer.label : t("pharmacyRetail.toRegister", { name: customer.draft.name })}
                    <Button type="button" variant="link" size="sm" onClick={() => { setCustomer(null); setMatches(null); stale(); }}>{t("pharmacyRetail.change")}</Button>
                  </p>
                )}
                {matches !== null && (
                  <div className="rounded border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="paper-matches">
                    <p>{t("pharmacyRetail.matches")}</p>
                    <ul className="my-1 space-y-1">
                      {matches.map((m) => (
                        <li key={m.id} className="flex items-center gap-2">
                          <span>{m.name} · {m.uhid}</span>
                          <Button type="button" size="sm" variant="outline" onClick={() => { setCustomer({ kind: "existing", id: m.id, label: `${m.name} · ${m.uhid}` }); setMatches(null); stale(); }}>{t("pharmacyRetail.useThis")}</Button>
                        </li>
                      ))}
                    </ul>
                    <Button type="button" size="sm" onClick={() => { void submit(true); }}>{t("pharmacyDowntime.someoneNew")}</Button>
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <h2 className="font-semibold">{t("pharmacyDowntime.lines")}</h2>
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim() !== "") void search(); }}>
                  <Input aria-label={t("pharmacyRetail.search")} placeholder={t("pharmacyRetail.search")} value={q} onChange={(e) => setQ(e.target.value)} className="max-w-md" />
                  <Button type="submit" variant="outline">{t("pharmacyRetail.find")}</Button>
                </form>
                {found !== null && found.length === 0 && <p className="text-sm text-muted-foreground">{t("pharmacyDowntime.notHeld")}</p>}
                {found !== null && found.length > 0 && (
                  <ul className="space-y-1" aria-label={t("pharmacyDowntime.results")}>
                    {found.map((f) => (
                      <li key={f.itemId} className="flex items-center gap-2 text-sm">
                        <span>{f.brandName} {f.strengthLabel ?? ""} {f.form}</span>
                        <Button type="button" size="sm" variant="outline" onClick={() => { void add(f); }}>{t("pharmacyRetail.add")}</Button>
                      </li>
                    ))}
                  </ul>
                )}
                {lines.length > 0 && (
                  <table className="text-sm">
                    <tbody>
                      {lines.map((l, i) => (
                        <tr key={`${l.entry.itemId}-${String(i)}`} data-testid={`paper-line-${String(i)}`}>
                          <td className="pr-2">{l.entry.brandName} {l.entry.strengthLabel ?? ""}</td>
                          <td className="pr-2">
                            <select aria-label={t("pharmacyDowntime.batchOf", { name: l.entry.brandName })} className="rounded border px-2 py-1" value={l.batchId}
                              onChange={(e) => { const v = e.target.value; setLines((all) => all.map((x, j) => (j === i ? { ...x, batchId: v } : x))); stale(); }}>
                              <option value="">{t("pharmacyDowntime.batch")}</option>
                              {l.batches.map((b) => (
                                <option key={b.batchId} value={b.batchId}>{b.batchNo}{b.expiryDate === null ? "" : ` · ${b.expiryDate}`}</option>
                              ))}
                            </select>
                          </td>
                          <td className="pr-2">
                            <Input aria-label={t("pharmacyRetail.qtyOf", { name: l.entry.brandName })} inputMode="numeric" className="w-20" value={l.qty}
                              onChange={(e) => { const v = e.target.value; setLines((all) => all.map((x, j) => (j === i ? { ...x, qty: v } : x))); stale(); }} />
                          </td>
                          <td><Button type="button" size="sm" variant="link" onClick={() => { setLines((all) => all.filter((_, j) => j !== i)); stale(); }}>{t("pharmacyRetail.remove")}</Button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <Button type="button" variant="outline" disabled={!linesValid} onClick={() => { void runPreview(); }}>{t("pharmacyRetail.price")}</Button>
              </section>

              {preview !== null && (
                <section className="space-y-2" data-testid="paper-preview">
                  <p className="font-medium">{t("pharmacyDowntime.billed", { amount: rupees(preview.totals.netPayablePaise) })}</p>
                  {preview.checks !== null && preview.checks.allergies.map((a) => (
                    <p key={`${String(a.lineIdx)}-${a.substance}`} className="text-sm text-amber-800">{t("pharmacyDowntime.allergyRecorded", { substance: a.substance })}</p>
                  ))}
                  {preview.prescriptionRequired && (
                    <fieldset className="space-y-2 rounded border p-2" data-testid="paper-rx">
                      <legend className="px-1 text-sm font-medium">{t("pharmacyDowntime.rxTitle")}</legend>
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
                      <label className="block text-sm">{t("pharmacyDowntime.photo")}
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
                    <label className="text-sm">{t("pharmacyDowntime.paid")}
                      <Input inputMode="decimal" className="w-28" value={paid} onChange={(e) => setPaid(e.target.value)} />
                    </label>
                    {mode !== "cash" && (
                      <label className="text-sm">{t("pharmacyRetail.reference")}
                        <Input value={ref} onChange={(e) => setRef(e.target.value)} />
                      </label>
                    )}
                    <Button type="button" disabled={!canEnter} onClick={() => { void submit(); }}>{t("pharmacyDowntime.enter")}</Button>
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}

      <section className="space-y-1">
        <h2 className="font-semibold">{t("pharmacyDowntime.recent")}</h2>
        {entered.data !== undefined && entered.data.length === 0 && <p className="text-sm text-muted-foreground">{t("pharmacyDowntime.noneYet")}</p>}
        <ul className="text-sm">
          {(entered.data ?? []).map((r) => (
            <li key={r.id} data-testid={`paper-row-${r.id}`}>
              {t("pharmacyDowntime.row", {
                desk: r.sheet?.desk ?? "", serial: r.sheet?.serial ?? "",
                // The hospital's clock, whatever the desk machine's timezone says.
                when: `${todayIst(new Date(r.soldAt)).split("-").reverse().join("-")} ${fmtIst(r.soldAt)}`,
                invoice: r.invoiceNo, amount: rupees(r.netPaise),
              })}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
