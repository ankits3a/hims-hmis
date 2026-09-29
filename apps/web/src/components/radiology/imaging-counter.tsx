import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import { fmtIst, fmtRupees } from "../../lib/format";
import type { WirePricedDraft } from "../../lib/billing-api";
import type { WireCounterView, WireImagingDevice, WireWorklistRow } from "../../lib/radiology-api";
import { istDay } from "./desk-time";

/**
 * PLAN 18-S RS3 — **THE IMAGING COUNTER'S FOUR STEPS**: Studies → Checks → Bill → Slot & slip.
 *
 * Every fact on these cards is the server's: the gates check-in WILL open and the prep come from
 * `GET /radiology/studies/:id/counter` (`deriveGateSet`, `prepFor`), the price from the billing
 * preview, the machines from `/radiology/devices`. The steps RENDER; the screen that owns them
 * (`radiology-reception.tsx`) holds the one next act in the dock.
 *
 * **The desk never satisfies a gate** (the manifest's first separation): Checks tells the patient
 * what the prep bay will ask for and has no control that records an answer.
 */

/** A re-render every 30 s, so the clocks move without a refetch. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * A link to the seat that fixes a refusal. Through the router when there is one (no reload), a
 * plain link when there is not — the station shell's own rule.
 */
export function SeatLink({ to, children }: { to: string; children: React.ReactNode }): React.ReactElement {
  const router = useRouter({ warn: false });
  return (
    <a
      href={to}
      className="text-sm font-medium underline underline-offset-2"
      onClick={(e) => {
        if (router === undefined) return;
        e.preventDefault();
        void router.navigate({ to });
      }}
    >
      {children}
    </a>
  );
}

/** Where each refusal is fixed. The words stay the server's; this only names the seat. */
const REMEDY: Record<string, { to: string; key: string } | undefined> = {
  device_not_licensed: { to: "/radiology/radiation-safety", key: "radiology.counter.fix.licence" },
  device_unavailable: { to: "/radiology/diary", key: "radiology.counter.fix.down" },
  slot_taken: { to: "/radiology/diary", key: "radiology.counter.fix.diary" },
};

export function Refusal({ code, message, children, warn = false }: {
  code: string | null; message: string; children?: React.ReactNode;
  /** A warning about what the NEXT seat will refuse (gold), rather than a refusal already given (red). */
  warn?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const fix = code === null ? undefined : REMEDY[code];
  return (
    <div
      role={warn ? "note" : "alert"}
      className={`rounded border p-2 text-sm ${warn ? "border-amber-300 bg-amber-50 text-amber-950" : "border-red-300 bg-red-50 text-red-900"}`}
      data-refusal={code ?? "unknown"}
    >
      <p className="m-0">{message}</p>
      {fix !== undefined && <p className="m-0 mt-1"><SeatLink to={fix.to}>{t(fix.key)}</SeatLink></p>}
      {children}
    </div>
  );
}

export function statusWord(t: (k: string, o?: Record<string, unknown>) => string, row: { status: string; scheduledAt: string | null }): string {
  if (row.status === "scheduled" && row.scheduledAt === null) return t("radiology.counter.state.toBook");
  return t(`radiology.counter.state.${row.status}`, { defaultValue: row.status });
}

/* ═══════════════════════════ 01 · STUDIES ═══════════════════════════ */

export function CounterStudies({ studies, views, inRoom }: {
  studies: WireWorklistRow[];
  views: Record<string, WireCounterView | undefined>;
  inRoom: WireWorklistRow[];
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="space-y-2" data-testid="counter-studies">
      {studies.map((s) => {
        const v = views[s.studyId];
        return (
          <div key={s.studyId} data-acc={s.accessionNo} data-state={s.status} className="rounded border bg-card p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <b>{v?.studyTypeName ?? s.studyTypeCode}</b>
              <span className="mo text-xs">{s.accessionNo}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {s.priority === "stat" ? <b className="text-red-700">STAT · </b> : null}
              {statusWord(t, s)}
              {s.scheduledAt !== null ? ` · ${fmtIst(s.scheduledAt)}${istDay(s.scheduledAt) === istDay(Date.now()) ? "" : ` · ${istDay(s.scheduledAt)}`}` : ""}
              {s.formFRequired ? ` · ${t("radiology.worklist.formF")}` : ""}
            </div>
          </div>
        );
      })}
      {inRoom.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("radiology.counter.inRoom", { list: inRoom.map((r) => `${r.studyTypeCode} (${statusWord(t, r)})`).join(", ") })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t("radiology.counter.addStudyNote")}</p>
    </section>
  );
}

/* ═══════════════════════════ 02 · CHECKS ═══════════════════════════ */

export function CounterChecks({ studies, views, opened }: {
  studies: WireWorklistRow[];
  views: Record<string, WireCounterView | undefined>;
  /** Gates check-in already opened at this counter (opening the patient on the day). */
  opened: Record<string, string[]>;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const tEn = i18n.getFixedT("en");
  const tHi = i18n.getFixedT("hi");
  return (
    <section className="space-y-3" data-testid="counter-checks">
      <p className="text-xs text-muted-foreground">{t("radiology.counter.checksLead")}</p>
      {studies.map((s) => {
        const v = views[s.studyId];
        if (v === undefined) return <p key={s.studyId} className="text-sm text-muted-foreground">{t("radiology.counter.loading")}</p>;
        const already = opened[s.studyId];
        return (
          <div key={s.studyId} data-acc={s.accessionNo} className="rounded border bg-card p-3 space-y-2">
            <b>{v.studyTypeName}</b>
            <div>
              <h4 className="tag m-0">{already !== undefined ? t("radiology.counter.gatesOpen") : t("radiology.counter.gatesWillOpen")}</h4>
              <ul className="m-0 mt-1 list-disc pl-5 text-sm">
                {(already ?? v.checks.gates).map((g) => (
                  <li key={g}>
                    <b>{t(`radiology.gate.${g}`, { defaultValue: g })}</b> — {t(`radiology.deskGate.${g}`, { defaultValue: "" })}
                  </li>
                ))}
              </ul>
            </div>
            {v.checks.gates.includes("pregnancy_screen") && (
              <div className="rounded border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="pregnancy-question">
                <p className="m-0">{tEn("radiology.counter.pregnancyAsk")}</p>
                <p className="m-0" lang="hi">{tHi("radiology.counter.pregnancyAsk")}</p>
              </div>
            )}
            <div>
              <h4 className="tag m-0">{t("radiology.counter.tellPatient")}</h4>
              {v.checks.prep.length === 0
                ? <p className="m-0 mt-1 text-sm text-muted-foreground">{t("radiology.counter.noPrep")}</p>
                : (
                  <ul className="m-0 mt-1 list-none p-0 text-sm space-y-1">
                    {v.checks.prep.map((k) => (
                      <li key={k}>
                        {tEn(`radiology.prep.${k}`)}<br />
                        <span lang="hi" className="text-muted-foreground">{tHi(`radiology.prep.${k}`)}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">{t("radiology.counter.checksNoControl")}</p>
    </section>
  );
}

/* ═══════════════════════════ 03 · BILL ═══════════════════════════ */

export type TenderMode = "cash" | "upi" | "card";

export function CounterBill({
  views, toBill, addOnPick, onAddOn, preview, previewError, drawerOpen, mode, onMode, refText, onRef, paid, billError,
}: {
  views: WireCounterView[];
  toBill: WireCounterView[];
  addOnPick: Record<string, boolean>;
  onAddOn: (key: string) => void;
  preview: WirePricedDraft | undefined;
  previewError: string | null;
  drawerOpen: boolean;
  mode: TenderMode;
  onMode: (m: TenderMode) => void;
  refText: string;
  onRef: (v: string) => void;
  paid: { invoiceNo: string; receiptNo: string | null; totalPaise: number } | null;
  billError: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const payer = views[0]?.intendedPayer ?? "self";
  const stat = views.filter((v) => v.authorisation === "stat");
  const linked = views.filter((v) => v.authorisation === "invoice");
  const addOns = views[0]?.addOns ?? [];
  return (
    <section className="space-y-3" data-testid="counter-bill">
      <div className="rounded border bg-card p-3 text-sm">
        <span className="tag">{t("radiology.counter.whoPays")}</span>
        <p className="m-0 mt-1"><b>{t(`radiology.counter.payer.${payer}`, { defaultValue: payer })}</b></p>
        {payer !== "self" && <p className="m-0 mt-1 text-xs" data-testid="payer-note">{t("radiology.counter.payerNote")}</p>}
      </div>

      {linked.length > 0 && (
        <p role="status" className="rounded border border-green-300 bg-green-50 p-2 text-sm">
          {t("radiology.counter.alreadyPaid", { list: linked.map((v) => v.studyTypeName).join(", ") })}
        </p>
      )}
      {stat.length > 0 && (
        <p className="rounded border border-green-300 bg-green-50 p-2 text-sm">{t("radiology.counter.statNote")}</p>
      )}
      {views.some((v) => v.authorisation === "daycare") && (
        <p className="rounded border bg-card p-2 text-sm">{t("radiology.counter.daycareNote")}</p>
      )}

      {toBill.length > 0 && paid === null && (
        <div className="rounded border bg-card p-3 space-y-2">
          <span className="tag">{t("radiology.counter.lines")}</span>
          {preview === undefined && previewError === null && <p className="text-sm text-muted-foreground">{t("radiology.counter.pricing")}</p>}
          {previewError !== null && <Refusal code={null} message={previewError} />}
          {preview !== undefined && (
            <div className="text-sm">
              {preview.lines.map((l) => (
                <div key={l.lineId} className="flex justify-between gap-2 border-b py-1">
                  <span className="min-w-0">{l.serviceName}</span>
                  <span className="mo">{fmtRupees(l.netPaise)}</span>
                </div>
              ))}
              <div className="flex justify-between gap-2 py-1 text-xs text-muted-foreground">
                <span>{t("radiology.counter.gst")}</span>
                <span className="mo">{fmtRupees(preview.totals.cgstPaise + preview.totals.sgstPaise)}</span>
              </div>
              <div className="flex justify-between gap-2 border-t-2 pt-1">
                <b>{t("radiology.counter.toCollect")}</b>
                <b className="mo text-lg" data-testid="bill-total">{fmtRupees(preview.totals.netPayablePaise)}</b>
              </div>
            </div>
          )}
          <div className="text-xs">
            <span className="tag">{t("radiology.counter.extras")}</span>
            {addOns.length === 0
              ? <p className="m-0 mt-1 text-muted-foreground" data-testid="addons-note">{t("radiology.counter.addOnsMissing")}</p>
              : (
                <div className="mt-1 flex flex-wrap gap-1">
                  {toBill.flatMap((v) => v.addOns.map((a) => {
                    const key = `${a.kind}:${v.studyId}`;
                    return (
                      <button
                        key={key} type="button" aria-pressed={addOnPick[key] === true}
                        className={`rounded border px-2 py-1 ${addOnPick[key] === true ? "border-green-700 bg-green-50" : ""}`}
                        onClick={() => onAddOn(key)}
                      >
                        {a.name} · {v.studyTypeName}
                      </button>
                    );
                  }))}
                </div>
              )}
          </div>
          <p className="m-0 text-xs text-muted-foreground" data-testid="discount-note">{t("radiology.counter.noDiscount")}</p>

          <div className="space-y-1">
            <span className="tag">{t("radiology.counter.tender")}</span>
            {!drawerOpen
              ? <Refusal code={null} message={t("radiology.counter.drawerClosed")}><p className="m-0 mt-1"><SeatLink to="/billing/session">{t("radiology.counter.openDrawer")}</SeatLink></p></Refusal>
              : (
                <div className="flex flex-wrap items-end gap-2">
                  <div role="radiogroup" aria-label={t("radiology.counter.tender")} className="flex gap-1">
                    {(["cash", "upi", "card"] as const).map((m) => (
                      <button
                        key={m} type="button" role="radio" aria-checked={mode === m}
                        className={`rounded border px-3 py-1 text-sm ${mode === m ? "border-green-700 bg-green-50 font-semibold" : ""}`}
                        onClick={() => onMode(m)}
                      >
                        {t(`radiology.counter.mode.${m}`)}
                      </button>
                    ))}
                  </div>
                  {mode !== "cash" && (
                    <label className="flex min-w-0 flex-col text-xs">
                      {t(mode === "upi" ? "radiology.counter.refUpi" : "radiology.counter.refCard")}
                      <input className="border px-2 py-1 text-sm mo" value={refText} maxLength={64} onChange={(e) => onRef(e.target.value)} />
                    </label>
                  )}
                </div>
              )}
          </div>
        </div>
      )}
      {paid !== null && (
        <p role="status" className="rounded border border-green-300 bg-green-50 p-2 text-sm" data-testid="bill-paid">
          {t("radiology.counter.paid", { amount: fmtRupees(paid.totalPaise), invoiceNo: paid.invoiceNo, receipt: paid.receiptNo ?? "—" })}
        </p>
      )}
      {billError}
      {toBill.length === 0 && paid === null && linked.length === 0 && stat.length === 0 && payer === "self" && (
        <p className="text-sm text-muted-foreground">{t("radiology.counter.nothingToBill")}</p>
      )}
    </section>
  );
}

/* ═══════════════════════════ 04 · SLOT & SLIP ═══════════════════════════ */

export type SlotPick = { deviceResourceId: string; at: string; bedside: string };

export function deviceLabel(t: (k: string) => string, d: WireImagingDevice): string {
  return [
    d.code, d.name, d.room,
    d.portable ? t("radiology.reception.portable") : null,
    d.ionising && d.licensedNow === false ? t("radiology.reception.notLicensed") : null,
    d.status === "available" || d.status === "in_use" ? null : d.status,
  ].filter((part): part is string => part !== null && part !== "").join(" · ");
}

export function CounterSlot({ studies, views, devices, picks, onPick, onWalkIn, errors, onClearBed, onGoBill, busy }: {
  studies: WireWorklistRow[];
  views: Record<string, WireCounterView | undefined>;
  devices: WireImagingDevice[];
  picks: Record<string, SlotPick>;
  onPick: (studyId: string, pick: SlotPick) => void;
  onWalkIn: (studyId: string) => void;
  errors: Record<string, { code: string | null; message: string } | undefined>;
  onClearBed: (studyId: string) => void;
  /** `payment_required` is fixed at THIS counter, one step back — a button, not a link away. */
  onGoBill: () => void;
  busy: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="space-y-3" data-testid="counter-slot">
      {studies.map((s) => {
        const v = views[s.studyId];
        const pick = picks[s.studyId] ?? { deviceResourceId: "", at: "", bedside: "" };
        const fits = devices.filter((d) => v === undefined || d.modality === v.modality);
        const chosen = devices.find((d) => d.id === pick.deviceResourceId);
        const err = errors[s.studyId];
        return (
          <div key={s.studyId} data-acc={s.accessionNo} className="rounded border bg-card p-3 space-y-2" style={{ minWidth: 0 }}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <b>{v?.studyTypeName ?? s.studyTypeCode}</b>
              <span className="text-xs text-muted-foreground">{v === undefined ? "" : t("radiology.counter.block", { min: v.durationMin })}</span>
            </div>
            {s.scheduledAt !== null
              ? (
                <p className="m-0 text-sm" data-testid={`booked-${s.studyId}`}>
                  {t("radiology.counter.bookedAt", {
                    machine: devices.find((d) => d.id === s.deviceResourceId)?.code ?? "—",
                    time: fmtIst(s.scheduledAt), day: istDay(s.scheduledAt),
                  })}{" "}
                  <SeatLink to="/radiology/diary">{t("radiology.counter.moveInDiary")}</SeatLink>
                </p>
              )
              : (
                <>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex min-w-0 max-w-full flex-col text-xs">
                      {t("radiology.reception.device")}
                      <select
                        className="max-w-full border px-2 py-1 text-sm" value={pick.deviceResourceId}
                        onChange={(e) => onPick(s.studyId, { ...pick, deviceResourceId: e.target.value })}
                      >
                        <option value="">{t("radiology.reception.devicePick")}</option>
                        {fits.map((d) => <option key={d.id} value={d.id}>{deviceLabel(t, d)}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col text-xs">
                      {t("radiology.counter.timeIst")}
                      <input
                        className="border px-2 py-1 text-sm" type="datetime-local" value={pick.at}
                        onChange={(e) => onPick(s.studyId, { ...pick, at: e.target.value })}
                      />
                    </label>
                    <button type="button" className="rounded border px-3 py-1 text-sm" disabled={busy} onClick={() => onWalkIn(s.studyId)}>
                      {t("radiology.counter.walkInNow")}
                    </button>
                  </div>
                  {chosen?.portable === true && (
                    <label className="flex max-w-md flex-col text-xs">
                      {t("radiology.reception.bedside")}
                      <input
                        className="border px-2 py-1 text-sm" value={pick.bedside} maxLength={120}
                        placeholder={t("radiology.reception.bedsidePlaceholder")}
                        onChange={(e) => onPick(s.studyId, { ...pick, bedside: e.target.value })}
                      />
                    </label>
                  )}
                  {chosen !== undefined && chosen.ionising && chosen.licensedNow === false && (
                    <Refusal code="device_not_licensed" message={t("radiology.counter.notLicensedWords", { machine: chosen.code })} />
                  )}
                  {chosen !== undefined && chosen.status !== "available" && chosen.status !== "in_use" && (
                    <Refusal code="device_unavailable" message={t("radiology.counter.downWords", { machine: chosen.code, status: chosen.status })} />
                  )}
                </>
              )}
            {v !== undefined && v.authorisation === null && (
              <Refusal code="payment_required" message={t("radiology.counter.unpaidWords")} warn>
                <button type="button" className="mt-1 rounded border px-2 py-1 text-xs" onClick={onGoBill}>{t("radiology.counter.fix.bill")}</button>
              </Refusal>
            )}
            {err !== undefined && (
              <Refusal code={err.code} message={err.message}>
                {err.code === "device_not_portable" && (
                  <button type="button" className="mt-1 rounded border px-2 py-1 text-xs" onClick={() => onClearBed(s.studyId)}>
                    {t("radiology.reception.clearBed")}
                  </button>
                )}
              </Refusal>
            )}
          </div>
        );
      })}
    </section>
  );
}

/**
 * The slip, as it would print: the TOKEN (the accession on it is what the hall board calls), where
 * and when, and the prep in English and Hindi. The appointment message is QUEUED by the booking
 * itself (`kernel/notify`) — the slip says so and never that it was sent.
 */
export function CounterSlip({ patient, booked, devices, views }: {
  patient: { name: string; uhid: string };
  booked: WireWorklistRow[];
  devices: WireImagingDevice[];
  views: Record<string, WireCounterView | undefined>;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const tEn = i18n.getFixedT("en");
  const tHi = i18n.getFixedT("hi");
  const prep = [...new Set(booked.flatMap((s) => (s.formFRequired ? [] : views[s.studyId]?.checks.prep ?? [])))];
  return (
    <section className="rounded border bg-white p-4 mo text-xs leading-5" style={{ maxWidth: 420 }} data-testid="counter-slip" aria-label={t("radiology.counter.slip")}>
      <div className="text-center font-bold tracking-widest">{t("radiology.counter.slipTitle")}</div>
      <div className="my-1 text-center text-2xl font-bold" data-testid="slip-token">{booked[0]?.accessionNo}</div>
      <div>{patient.name} · {patient.uhid}</div>
      {booked.map((s) => {
        const d = devices.find((x) => x.id === s.deviceResourceId);
        return (
          <div key={s.studyId} className="mt-2">
            <b>{views[s.studyId]?.studyTypeName ?? s.studyTypeCode}</b><br />
            {d?.code ?? "—"}{d?.room ? ` · ${d.room}` : ""} · {s.scheduledAt === null ? "—" : `${istDay(s.scheduledAt)} ${fmtIst(s.scheduledAt)}`}<br />
            {t("radiology.counter.slipAcc", { acc: s.accessionNo })}
          </div>
        );
      })}
      {prep.length > 0 && (
        <div className="mt-2 border-t border-dashed pt-2">
          {prep.map((k) => (
            <div key={k}>{tEn(`radiology.prep.${k}`)}<br /><span lang="hi">{tHi(`radiology.prep.${k}`)}</span></div>
          ))}
        </div>
      )}
      <div className="mt-2 border-t border-dashed pt-2">{t("radiology.counter.messageQueued")}</div>
    </section>
  );
}
