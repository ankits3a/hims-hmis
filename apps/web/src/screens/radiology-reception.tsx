import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError, newIdempotencyKey } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtIst, fmtRupees } from "../lib/format";
import { fetchCurrentSession, issueInvoice, previewInvoice } from "../lib/billing-api";
import {
  checkInStudy, fetchCounter, fetchImagingDevices, fetchInvoiceLines, fetchWorklist, linkInvoiceLine,
  radiologyErrorCode, radiologyErrorDetail, radiologyErrorText, scheduleStudy, walkIn,
} from "../lib/radiology-api";
import type { WireCounterView, WireImagingDevice, WireWorklistRow } from "../lib/radiology-api";
import { RadiologyStation } from "./radiology-station";
import { ImagingDeskDoor } from "../components/radiology/imaging-desk-door";
import {
  CounterBill, CounterChecks, CounterSlip, CounterSlot, CounterStudies, Refusal, statusWord, useNow,
} from "../components/radiology/imaging-counter";
import type { SlotPick, TenderMode } from "../components/radiology/imaging-counter";
import { istDay, istInputToIso, minutesSince, nextQuarterIstInput } from "../components/radiology/desk-time";

/**
 * PLAN 18-S RS3 — **THE IMAGING COUNTER: Studies → Checks → Bill → Slot & slip.**
 *
 * The owner's counter layout (25 Sep, the lab's and the pharmacy's): the header carries the menu;
 * the LEFT lane holds the patient in hand; the CENTRE is one numbered flow with a pinned dock that
 * offers the ONE next act (Enter runs it); the RIGHT is ONE list with no filter tabs, then "Clocks
 * running", collapsed unless a clock has run out.
 *
 * ═══ PRESENCE IS DERIVED ═══
 *
 * There is no "Check in" button. Opening a patient at the desk on the day of a booked slot IS the
 * arrival: every study of that visit booked for today is checked in by that act (18-S RS3 grants
 * the desk `radiology.checkin`; the workflow edge already named the role). The gate set that opens
 * is SHOWN — the desk can tell the patient "the prep bay will ask for your creatinine" — and there
 * is no control that clears one (the manifest's first separation).
 *
 * ═══ MONEY GOES THROUGH BILLING, NOT A SECOND PATH ═══
 *
 * Self-pay settles here through the house invoice (`/billing/invoices/preview`, then
 * `/billing/invoices` with the tender), and the raised line is then LINKED to the study
 * (`POST /radiology/studies/:id/invoice-line`, `linkInvoiceLine`'s three checks) — which is what
 * makes `authorisationOf` answer `invoice` at the machine. No discount control (ruling 8; the HOD
 * gives up to 10%). No credit: the owner's alone. STAT goes first and the bill follows.
 */

type Hand = { patientId: string; encounterNo: string };
type BillDone = { invoiceNo: string; receiptNo: string | null; totalPaise: number };
const STEPS = ["studies", "checks", "bill", "slot"] as const;
const DESK_STATES = ["scheduled", "checked_in"];
const CLOCK_MINUTES = 30;

function draftId(): string {
  return `rad-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
}

export function RadiologyReception(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const now = useNow();

  const [hand, setHand] = useState<Hand | null>(null);
  const [step, setStep] = useState(0);
  const [opened, setOpened] = useState<Record<string, string[]>>({});
  const [openErrors, setOpenErrors] = useState<string[]>([]);
  const [picks, setPicks] = useState<Record<string, SlotPick>>({});
  const [slotErrors, setSlotErrors] = useState<Record<string, { code: string | null; message: string } | undefined>>({});
  const [mode, setMode] = useState<TenderMode>("cash");
  const [refText, setRefText] = useState("");
  const [addOnPick, setAddOnPick] = useState<Record<string, boolean>>({});
  const [paid, setPaid] = useState<BillDone | null>(null);
  const [billError, setBillError] = useState<{ code: string | null; message: string; relinkInvoiceId?: string } | null>(null);
  const draft = useRef(draftId());
  const idem = useRef<string | null>(null);

  const q = useQuery({ queryKey: ["radiology", "worklist", "floor"], queryFn: () => fetchWorklist("floor") });
  const devicesQ = useQuery({ queryKey: ["radiology", "devices"], queryFn: fetchImagingDevices });
  const devices: WireImagingDevice[] = devicesQ.data?.devices ?? [];
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ["radiology"] }), [qc]);

  /* ── the one list: STAT first, then orders waiting to be booked (oldest first), then by slot ── */
  const list = useMemo(() => [...rows].sort((a, b) => {
    const rank = (r: WireWorklistRow): number => (r.priority === "stat" ? 0 : r.scheduledAt === null ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const at = (r: WireWorklistRow): string => r.scheduledAt ?? r.createdAt;
    return at(a).localeCompare(at(b));
  }), [rows]);

  const mine = hand === null ? [] : rows.filter((r) => r.patientId === hand.patientId && r.encounterNo === hand.encounterNo);
  const desk = mine.filter((r) => DESK_STATES.includes(r.status));
  const inRoom = mine.filter((r) => !DESK_STATES.includes(r.status));

  const counterQs = useQueries({
    queries: desk.map((r) => ({
      queryKey: ["radiology", "counter", r.studyId],
      queryFn: () => fetchCounter(r.studyId),
    })),
  });
  const views: Record<string, WireCounterView | undefined> = {};
  desk.forEach((r, i) => { views[r.studyId] = counterQs[i]?.data?.study; });
  const viewList = desk.map((r) => views[r.studyId]).filter((v): v is WireCounterView => v !== undefined);
  const first = viewList[0];

  /* ── the bill: every desk study nothing authorises yet, plus the add-ons the desk ticked ── */
  const toBill = viewList.filter((v) => v.authorisation === null && v.intendedPayer === "self");
  const billLines = toBill.flatMap((v) => [
    { lineId: `study-${v.studyId}`, serviceId: v.serviceId, qty: 1 },
    ...v.addOns.filter((a) => addOnPick[`${a.kind}:${v.studyId}`] === true)
      .map((a) => ({ lineId: `${a.kind}-${v.studyId}`, serviceId: a.serviceId, qty: 1 })),
  ]);
  const previewQ = useQuery({
    queryKey: ["radiology", "bill-preview", hand?.encounterNo ?? "", JSON.stringify(billLines)],
    queryFn: () => previewInvoice({ encounterId: hand?.encounterNo ?? "", lines: billLines }),
    enabled: hand !== null && billLines.length > 0 && paid === null,
  });
  const sessionQ = useQuery({
    queryKey: ["billing", "session", "current"], queryFn: fetchCurrentSession,
    enabled: hand !== null && toBill.length > 0,
  });
  const drawerOpen = sessionQ.data?.session?.status === "open";

  /* ── opening a patient: the arrival, derived ── */
  const open = async (next: Hand): Promise<void> => {
    setHand(next);
    setStep(0);
    setOpened({});
    setOpenErrors([]);
    setPicks({});
    setSlotErrors({});
    setPaid(null);
    setBillError(null);
    setAddOnPick({});
    setRefText("");
    draft.current = draftId();
    idem.current = null;
    if (!can("radiology.checkin")) return;
    const today = istDay(Date.now());
    const arriving = rows.filter((r) => r.patientId === next.patientId && r.encounterNo === next.encounterNo
      && r.status === "scheduled" && r.scheduledAt !== null && istDay(r.scheduledAt) === today);
    const gates: Record<string, string[]> = {};
    const errs: string[] = [];
    for (const r of arriving) {
      try {
        gates[r.studyId] = (await checkInStudy(r.studyId)).gates;
      } catch (e) {
        errs.push(`${r.accessionNo}: ${radiologyErrorText(e)}`);
      }
    }
    setOpened(gates);
    setOpenErrors(errs);
    if (arriving.length > 0) void refresh();
  };
  const clear = (): void => { setHand(null); setStep(0); };

  /* ── money ── */
  const linkAll = async (invoiceId: string): Promise<void> => {
    const inv = await fetchInvoiceLines(invoiceId);
    const used = new Set<string>();
    for (const v of toBill) {
      const line = inv.lines.find((l) => l.serviceId === v.serviceId && !used.has(l.id));
      if (line === undefined) continue;
      used.add(line.id);
      await linkInvoiceLine(v.studyId, line.id);
    }
  };
  const collect = useMutation({
    mutationFn: async (): Promise<BillDone> => {
      const priced = previewQ.data;
      if (hand === null || first === undefined || priced === undefined) throw new Error("not priced");
      const total = priced.totals.netPayablePaise;
      idem.current ??= newIdempotencyKey();
      const result = await issueInvoice({
        draftId: draft.current,
        patientId: first.patientId,
        encounterId: hand.encounterNo,
        lines: priced.lines.map((l) => ({ lineId: l.lineId, serviceId: l.serviceId, qty: l.qty })),
        receipt: { tenders: [{ mode, amountPaise: total, ...(mode === "cash" ? {} : { refText: refText.trim() }) }] },
      }, idem.current);
      idem.current = null;
      try {
        await linkAll(result.invoiceId);
      } catch (e) {
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { relinkInvoiceId: result.invoiceId, invoiceNo: result.invoiceNo });
      }
      return { invoiceNo: result.invoiceNo, receiptNo: result.receiptNo, totalPaise: total };
    },
    onSuccess: (done) => { setPaid(done); setBillError(null); void refresh(); },
    onError: (e) => {
      /** The server answered: that body's key is spent. A network failure keeps it (the charge may have landed). */
      if (e instanceof ApiError) idem.current = null;
      const relink = (e as { relinkInvoiceId?: string }).relinkInvoiceId
        ?? (radiologyErrorCode(e) === "duplicate_invoice_refused" ? String(radiologyErrorDetail(e)?.invoiceId ?? "") || undefined : undefined);
      setBillError({ code: radiologyErrorCode(e), message: radiologyErrorText(e), ...(relink === undefined ? {} : { relinkInvoiceId: relink }) });
    },
  });
  const relink = useMutation({
    mutationFn: (invoiceId: string) => linkAll(invoiceId),
    onSuccess: () => { setBillError(null); void refresh(); },
    onError: (e) => { setBillError((prev) => ({ ...(prev ?? {}), code: radiologyErrorCode(e), message: radiologyErrorText(e) })); },
  });

  /* ── the slot ── */
  const book = useMutation({
    mutationFn: async ({ studyId, clearBed }: { studyId: string; clearBed?: boolean }) => {
      const pick = picks[studyId];
      if (pick === undefined) throw new Error("no pick");
      const device = devices.find((d) => d.id === pick.deviceResourceId);
      return scheduleStudy(studyId, {
        deviceResourceId: pick.deviceResourceId,
        scheduledAt: istInputToIso(pick.at),
        ...(clearBed === true
          ? { bedsideLocation: null }
          : device?.portable === true && pick.bedside.trim() !== "" ? { bedsideLocation: pick.bedside.trim() } : {}),
      });
    },
    onSuccess: (_r, vars) => { setSlotErrors((p) => ({ ...p, [vars.studyId]: undefined })); void refresh(); },
    onError: (e, vars) => { setSlotErrors((p) => ({ ...p, [vars.studyId]: { code: radiologyErrorCode(e), message: radiologyErrorText(e) } })); },
  });
  const walk = useMutation({
    /**
     * A walk-in is booked NOW on the first free machine — and the patient is standing at the
     * counter, so the same act is the arrival: check-in follows at once (the board's "now-slots
     * check in at once"), and the gate set it opens is shown in the lane.
     */
    mutationFn: async (studyId: string) => {
      await walkIn(studyId);
      if (!can("radiology.checkin")) return null;
      return (await checkInStudy(studyId)).gates;
    },
    onSuccess: (gates, studyId) => {
      setSlotErrors((p) => ({ ...p, [studyId]: undefined }));
      if (gates !== null) setOpened((p) => ({ ...p, [studyId]: gates }));
      void refresh();
    },
    onError: (e, studyId) => { setSlotErrors((p) => ({ ...p, [studyId]: { code: radiologyErrorCode(e), message: radiologyErrorText(e) } })); },
  });

  /* ── the dock: the ONE next act ── */
  const unbooked = desk.filter((r) => r.scheduledAt === null);
  const ready = unbooked.find((r) => {
    const p = picks[r.studyId];
    const d = devices.find((x) => x.id === p?.deviceResourceId);
    return p !== undefined && p.at !== "" && d !== undefined && !(d.ionising && d.licensedNow === false);
  });
  const total = previewQ.data?.totals.netPayablePaise;
  const needMoney = toBill.length > 0 && paid === null;
  const refMissing = mode !== "cash" && refText.trim() === "";

  let dock: { label: string; hint: string; run: (() => void) | null };
  if (hand === null) dock = { label: "", hint: "", run: null };
  else if (step === 0) dock = { label: t("radiology.counter.dock.toChecks"), hint: t("radiology.counter.dock.studiesHint", { count: desk.length }), run: () => setStep(1) };
  else if (step === 1) dock = { label: t("radiology.counter.dock.toBill"), hint: t("radiology.counter.dock.checksHint"), run: () => setStep(2) };
  else if (step === 2 && needMoney) {
    const blocked = !drawerOpen ? t("radiology.counter.drawerClosed") : refMissing ? t("radiology.counter.dock.refMissing") : total === undefined ? t("radiology.counter.pricing") : null;
    dock = {
      label: total === undefined ? t("radiology.counter.dock.collectPending") : t("radiology.counter.dock.collect", { amount: fmtRupees(total), mode: t(`radiology.counter.mode.${mode}`) }),
      hint: blocked ?? t("radiology.counter.dock.collectHint"),
      run: blocked === null && !collect.isPending ? () => collect.mutate() : null,
    };
  } else if (step === 2) dock = { label: t("radiology.counter.dock.toSlot"), hint: t("radiology.counter.dock.billHint"), run: () => setStep(3) };
  else if (ready !== undefined) {
    const p = picks[ready.studyId]!;
    const d = devices.find((x) => x.id === p.deviceResourceId);
    dock = {
      label: t("radiology.counter.dock.book", { machine: d?.code ?? "", time: p.at.slice(11, 16) }),
      hint: t("radiology.counter.dock.bookHint"),
      run: book.isPending ? null : () => book.mutate({ studyId: ready.studyId }),
    };
  } else if (unbooked.length > 0) dock = { label: t("radiology.counter.dock.pick"), hint: t("radiology.counter.dock.pickHint"), run: null };
  else dock = { label: t("radiology.counter.dock.done"), hint: t("radiology.counter.dock.doneHint"), run: clear };

  const dockRun = useRef(dock.run);
  dockRun.current = dock.run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)) return;
      if (e.key === "Enter" && dockRun.current !== null) { e.preventDefault(); dockRun.current(); }
      if (e.key === "Escape" && hand !== null) clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hand]);

  /* ── the right column ── */
  const waitingToBook = rows.filter((r) => r.scheduledAt === null && r.status === "scheduled" && minutesSince(r.createdAt, now) > CLOCK_MINUTES);
  const notReady = rows.filter((r) => r.status === "checked_in" && r.checkedInAt !== null && minutesSince(r.checkedInAt, now) > CLOCK_MINUTES);
  const clocksAlert = waitingToBook.length + notReady.length > 0;

  const queue = (
    <section aria-label={t("radiology.counter.listTitle")}>
      <h2 className="tag m-0 mb-2">{t("radiology.counter.listTitle")} · {list.length}</h2>
      {list.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.worklist.empty")}</p>}
      <ul className="m-0 list-none space-y-1 p-0" data-testid="radiology-desk-queue">
        {list.map((r) => {
          const inHand = hand !== null && r.patientId === hand.patientId && r.encounterNo === hand.encounterNo;
          return (
            <li key={r.studyId} data-acc={r.accessionNo} data-state={r.status}>
              <button
                type="button" data-testid={`row-${r.studyId}`}
                aria-current={inHand ? "true" : undefined}
                className={`w-full rounded border bg-card p-2 text-left text-sm ${inHand ? "border-green-700" : ""}`}
                onClick={() => { void open({ patientId: r.patientId, encounterNo: r.encounterNo }); }}
              >
                <span className="flex justify-between gap-2">
                  <b className="min-w-0 truncate">{r.patientName}</b>
                  <span className="mo text-xs">{r.scheduledAt === null ? t("radiology.counter.state.toBook") : fmtIst(r.scheduledAt)}</span>
                </span>
                <span className="block text-xs text-muted-foreground">
                  {r.priority === "stat" ? <b className="text-red-700">STAT · </b> : null}
                  {r.studyTypeCode} · {statusWord(t, r)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
  const clocks = (
    <ul className="m-0 list-none space-y-1 p-0 text-sm" data-testid="desk-clocks">
      {waitingToBook.map((r) => (
        <li key={`b-${r.studyId}`}>{t("radiology.counter.clockToBook", { name: r.patientName, study: r.studyTypeCode, min: minutesSince(r.createdAt, now) })}</li>
      ))}
      {notReady.map((r) => (
        <li key={`r-${r.studyId}`}>{t("radiology.counter.clockNotReady", { name: r.patientName, study: r.studyTypeCode, min: minutesSince(r.checkedInAt ?? r.createdAt, now) })}</li>
      ))}
      {!clocksAlert && <li className="text-muted-foreground">{t("radiology.counter.clocksQuiet")}</li>}
    </ul>
  );

  /* ── the lane: the patient in hand ── */
  const lane = hand === null
    ? <p className="mt-4 text-sm text-muted-foreground" data-testid="nobody-in-hand">{t("radiology.counter.nobody")}</p>
    : (
      <div className="mt-4 space-y-3 text-sm" data-testid="patient-in-hand">
        <div>
          <span className="tag">{t("radiology.counter.inHand")}</span>
          <p className="m-0 mt-1 text-base font-semibold">{first?.patientName ?? mine[0]?.patientName ?? "—"}</p>
          <p className="m-0 mo text-xs">{first?.uhid ?? ""} · {hand.encounterNo}</p>
        </div>
        <div>
          <span className="tag">{t("radiology.counter.today")}</span>
          <ul className="m-0 mt-1 list-none space-y-1 p-0">
            {mine.map((r) => (
              <li key={r.studyId} data-acc={r.accessionNo} data-state={r.status}>
                {views[r.studyId]?.studyTypeName ?? r.studyTypeCode} — <span className="text-muted-foreground">{statusWord(t, r)}</span>
              </li>
            ))}
          </ul>
        </div>
        {Object.keys(opened).length > 0 && (
          <p role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs">{t("radiology.counter.arrived")}</p>
        )}
        {openErrors.map((m) => <p key={m} role="alert" className="text-xs text-red-700">{m}</p>)}
        <button type="button" className="rounded border px-3 py-1 text-sm" onClick={clear}>
          {t("radiology.counter.clearDesk")} <span className="kb">Esc</span>
        </button>
      </div>
    );

  const patient = { name: first?.patientName ?? mine[0]?.patientName ?? "", uhid: first?.uhid ?? "" };
  const booked = desk.filter((r) => r.scheduledAt !== null);

  return (
    <RadiologyStation
      station="desk"
      title={t("radiology.reception.title")}
      place={t("radiology.station.deskPlace")}
      stats={[
        { label: t("radiology.station.onList"), value: rows.length },
        { label: t("radiology.station.stat"), value: rows.filter((r) => r.priority === "stat").length, tone: "danger" },
        { label: t("radiology.counter.toBookStat"), value: rows.filter((r) => r.scheduledAt === null && r.status === "scheduled").length, tone: "waiting" },
      ]}
      lane={lane}
      list={queue}
      inHand={hand !== null}
      closeListOn={hand === null ? null : `${hand.patientId}:${hand.encounterNo}`}
      clocks={clocks}
      clocksAlert={clocksAlert}
      clocksSummary={clocksAlert ? t("radiology.counter.clocksSummary", { count: waitingToBook.length + notReady.length }) : t("radiology.counter.clocksNone")}
    >
      {hand === null
        ? (
          <div className="space-y-4">
            <ImagingDeskDoor onOpen={(v) => { void open(v); }} />
            <p className="text-xs text-muted-foreground">{t("radiology.counter.startHint")}</p>
          </div>
        )
        : (
          <div className="flex min-h-full flex-col" data-testid="imaging-counter">
            <ol className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label={t("radiology.counter.steps")}>
              {STEPS.map((s, i) => (
                <li key={s}>
                  <button
                    type="button" aria-current={step === i ? "step" : undefined}
                    className={`rounded border px-3 py-1 text-sm ${step === i ? "border-green-700 bg-green-50 font-semibold" : ""}`}
                    onClick={() => setStep(i)}
                  >
                    <span className="mo text-xs">{String(i + 1).padStart(2, "0")}</span> {t(`radiology.counter.step.${s}`)}
                  </button>
                </li>
              ))}
            </ol>
            <div className="flex-1 py-3">
              {desk.length === 0 && (
                <p className="text-sm">{t("radiology.counter.nothingHere")}</p>
              )}
              {desk.length > 0 && step === 0 && <CounterStudies studies={desk} views={views} inRoom={inRoom} />}
              {desk.length > 0 && step === 1 && <CounterChecks studies={desk} views={views} opened={opened} />}
              {desk.length > 0 && step === 2 && (
                <CounterBill
                  views={viewList} toBill={paid === null ? toBill : []}
                  addOnPick={addOnPick} onAddOn={(k) => setAddOnPick((p) => ({ ...p, [k]: p[k] !== true }))}
                  preview={previewQ.data} previewError={previewQ.isError ? radiologyErrorText(previewQ.error) : null}
                  drawerOpen={drawerOpen} mode={mode} onMode={setMode} refText={refText} onRef={setRefText}
                  paid={paid}
                  billError={billError === null ? null : (
                    <Refusal code={billError.code} message={billError.message}>
                      {billError.relinkInvoiceId !== undefined && (
                        <button type="button" className="mt-1 rounded border px-2 py-1 text-xs" onClick={() => relink.mutate(billError.relinkInvoiceId!)}>
                          {t("radiology.counter.relink")}
                        </button>
                      )}
                    </Refusal>
                  )}
                />
              )}
              {desk.length > 0 && step === 3 && (
                <div className="space-y-3">
                  <CounterSlot
                    studies={desk} views={views} devices={devices} picks={picks}
                    onPick={(id, p) => setPicks((prev) => ({ ...prev, [id]: p.at === "" && prev[id] === undefined ? { ...p, at: nextQuarterIstInput(now) } : p }))}
                    onWalkIn={(id) => walk.mutate(id)}
                    errors={slotErrors}
                    onClearBed={(id) => book.mutate({ studyId: id, clearBed: true })}
                    onGoBill={() => setStep(2)}
                    busy={walk.isPending || book.isPending}
                  />
                  {devicesQ.isError && <Refusal code={null} message={radiologyErrorText(devicesQ.error)} />}
                  {booked.length > 0 && <CounterSlip patient={patient} booked={booked} devices={devices} views={views} />}
                </div>
              )}
            </div>
            <div
              className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm"
              data-testid="counter-dock"
            >
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">{dock.hint}</span>
              <button
                type="button" data-testid="dock-act"
                className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                disabled={dock.run === null}
                onClick={() => dock.run?.()}
              >
                {dock.label} <span className="kb">Enter</span>
              </button>
            </div>
          </div>
        )}
    </RadiologyStation>
  );
}
