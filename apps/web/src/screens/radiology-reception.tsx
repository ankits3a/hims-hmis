import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtIst, fmtRupees } from "../lib/format";
import { fetchCurrentSession, previewInvoice } from "../lib/billing-api";
import {
  NO_SHOW_REASON, deskArrive, deskCollect, deskWalkInNow, fetchCounter, fetchDeskProposal, fetchImagingDevices, fetchNoShowsToRebook,
  fetchWorklist, markNoShow, radiologyErrorCode, radiologyErrorText, scheduleStudy, walkIn,
} from "../lib/radiology-api";
import type { DeskCollectBody, WireCounterView, WireImagingDevice, WireWorklistRow } from "../lib/radiology-api";
import { RadiologyStation } from "./radiology-station";
import { ImagingCopilot } from "../components/radiology/imaging-copilot";
import { PatientFacts } from "../components/radiology/patient-facts";
import { ImagingDeskDoor } from "../components/radiology/imaging-desk-door";
import {
  CounterBill, CounterChecks, CounterSlip, CounterSlot, CounterStudies, Refusal, statusWord, useNow,
} from "../components/radiology/imaging-counter";
import type { BillDone, SlotPick, TenderMode } from "../components/radiology/imaging-counter";
import { istDay, istInputToIso, isoToIstInput, minutesSince } from "../components/radiology/desk-time";
import { CreditChip } from "../components/patient-credit";
import { IMAGING_FLOOR_TOPIC, useImagingLive } from "../lib/radiology-live";

/**
 * PLAN 18-S RS3, #1078 (IM2) — **THE IMAGING COUNTER: Bill → Slot & slip.**
 *
 * The owner's counter layout (25 Sep, the lab's and the pharmacy's): the header carries the menu;
 * the LEFT lane holds the patient in hand — their studies and what the prep bay will ask; the CENTRE
 * is two numbered steps with a pinned dock that offers the ONE next act (Enter runs it); the RIGHT is
 * ONE list with no filter tabs, then "Clocks running", collapsed unless a clock has run out.
 *
 * #1078 — the two read-only steps (Studies, Checks) moved into the lane, and every act is ONE server
 * call (`radiology/desk.ts`): opening a patient on the day checks in every study booked for today
 * (`POST /radiology/desk/arrive`), collecting issues the invoice AND links it
 * (`POST /radiology/desk/collect`, retry-safe on its Idempotency-Key — no "relink" button), and a
 * walk-in is booked and checked in together. The Slot step opens with the server's proposal (the first
 * free quarter hour on a machine that may take the study), so Enter books it.
 *
 * ═══ PRESENCE IS DERIVED ═══
 *
 * There is no "Check in" button. Opening a patient at the desk on the day of a booked slot IS the
 * arrival. The gate set that opens is SHOWN in the lane — the desk can tell the patient "the prep bay
 * will ask for your creatinine" — and there is no control that clears one (the manifest's first
 * separation). A booked, paid patient who arrives has nothing left at the desk: the dock says Done.
 *
 * ═══ #1085 — THE LATE BOOKING AND THE NO-SHOWS TO REBOOK ═══
 *
 * A booking 30 minutes past its slot whose patient has not arrived shows in Clocks with a one-tap
 * No-show — the desk's own act (`POST /radiology/studies/:id/no-show`), with the reason the morning sweep
 * writes for the same fact ("not arrived"). Whatever the desk does not mark, the 08:00 sweep marks the
 * next morning. Below them, the last 30 days' no-shows nobody has booked again; a paid one says until when
 * its invoice holds for a rebooking of the same study (ruling 0098 §3 — no refund here).
 *
 * ═══ MONEY GOES THROUGH BILLING, NOT A SECOND PATH ═══
 *
 * The price shown is billing's preview; the collect act issues billing's own house invoice and links
 * its line to the study (`linkInvoiceLine`'s three checks), which is what makes `authorisationOf`
 * answer `invoice` at the machine. No discount control (ruling 8; the HOD gives up to 10%). No
 * credit: the owner's alone (decision 0015). STAT goes first and the bill follows.
 */

type Hand = { patientId: string; encounterNo: string };
type Step = "bill" | "slot";
const STEPS: readonly Step[] = ["bill", "slot"];
const DESK_STATES = ["scheduled", "checked_in"];
const CLOCK_MINUTES = 30;

export function RadiologyReception(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const now = useNow();

  const [hand, setHand] = useState<Hand | null>(null);
  /** `null` follows the patient: Bill while anything is owed, else Slot & slip. A click pins it. */
  const [step, setStep] = useState<Step | null>(null);
  const [opened, setOpened] = useState<Record<string, string[]>>({});
  const [openErrors, setOpenErrors] = useState<string[]>([]);
  const [picks, setPicks] = useState<Record<string, SlotPick>>({});
  const [slotErrors, setSlotErrors] = useState<Record<string, { code: string | null; message: string } | undefined>>({});
  const [mode, setMode] = useState<TenderMode>("cash");
  const [refText, setRefText] = useState("");
  const [addOnPick, setAddOnPick] = useState<Record<string, boolean>>({});
  const [paid, setPaid] = useState<BillDone | null>(null);
  const [billError, setBillError] = useState<{ code: string | null; message: string } | null>(null);
  /**
   * The collect's Idempotency-Key, kept for as long as the BODY is the same. A retry of the same bill —
   * after a dropped answer, or after the server issued and could not link — replays the issue and
   * completes the links; a changed body (another tender, another add-on) is a new attempt.
   */
  const idem = useRef<{ body: string; key: string } | null>(null);

  const q = useQuery({ queryKey: ["radiology", "worklist", "floor"], queryFn: () => fetchWorklist("floor"), refetchInterval: 60_000 });
  useImagingLive(IMAGING_FLOOR_TOPIC, [["radiology", "worklist", "floor"]]); // #1083: a frame reads the list now; the poll is the fallback
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
  const unbooked = desk.filter((r) => r.scheduledAt === null);

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
  const viewsLoading = counterQs.some((c) => c.isPending);

  /** The Slot step's prefill: the server's first free quarter hour on a machine that may take the study. */
  const proposalQs = useQueries({
    queries: unbooked.map((r) => ({
      queryKey: ["radiology", "desk", "proposal", r.studyId],
      queryFn: () => fetchDeskProposal(r.studyId),
      enabled: can("radiology.schedule"),
      retry: false,
    })),
  });
  const effectivePicks: Record<string, SlotPick> = {};
  unbooked.forEach((r, i) => {
    const p = proposalQs[i]?.data?.proposal;
    const chosen = picks[r.studyId];
    if (chosen !== undefined) effectivePicks[r.studyId] = chosen;
    else if (p !== undefined && p !== null) effectivePicks[r.studyId] = { deviceResourceId: p.deviceResourceId, at: isoToIstInput(p.scheduledAt), bedside: "" };
  });

  /* ── the bill: every desk study nothing authorises yet, plus the add-ons the desk ticked ── */
  const toBill = viewList.filter((v) => v.authorisation === null && v.intendedPayer === "self");
  const pickedAddOns = toBill.flatMap((v) => v.addOns
    .filter((a) => addOnPick[`${a.kind}:${v.studyId}`] === true)
    .map((a) => ({ studyId: v.studyId, kind: a.kind, serviceId: a.serviceId })));
  const billLines = toBill.flatMap((v) => [
    { lineId: `study-${v.studyId}`, serviceId: v.serviceId, qty: 1 },
    ...pickedAddOns.filter((a) => a.studyId === v.studyId).map((a) => ({ lineId: `${a.kind}-${v.studyId}`, serviceId: a.serviceId, qty: 1 })),
  ]);
  /**
   * Billing's price, a read. Keyed under `billing`, not `radiology`: the desk's refresh after an act
   * re-reads the radiology rows and must not re-price a bill that the collect has just closed.
   */
  const previewQ = useQuery({
    queryKey: ["billing", "preview", "imaging-desk", hand?.encounterNo ?? "", JSON.stringify(billLines)],
    queryFn: () => previewInvoice({ encounterId: hand?.encounterNo ?? "", lines: billLines }),
    enabled: hand !== null && billLines.length > 0 && paid === null,
  });
  const sessionQ = useQuery({
    queryKey: ["billing", "session", "current"], queryFn: fetchCurrentSession,
    enabled: hand !== null && toBill.length > 0,
  });
  const drawerOpen = sessionQ.data?.session?.status === "open";

  /* ── opening a patient: the arrival, derived, in one server act ── */
  const open = async (next: Hand): Promise<void> => {
    setHand(next);
    setStep(null);
    setOpened({});
    setOpenErrors([]);
    setPicks({});
    setSlotErrors({});
    setPaid(null);
    setBillError(null);
    setAddOnPick({});
    setRefText("");
    idem.current = null;
    if (!can("radiology.checkin")) return;
    const today = istDay(Date.now());
    const arriving = rows.some((r) => r.patientId === next.patientId && r.encounterNo === next.encounterNo
      && r.status === "scheduled" && r.scheduledAt !== null && istDay(r.scheduledAt) === today);
    if (!arriving) return;
    try {
      const arrival = await deskArrive(next.encounterNo);
      setOpened(Object.fromEntries(arrival.checkedIn.map((c) => [c.studyId, c.gates])));
      setOpenErrors(arrival.refused.map((r) => `${r.accessionNo}: ${r.message}`));
      if (arrival.checkedIn.length > 0) void refresh();
    } catch (e) {
      setOpenErrors([radiologyErrorText(e)]);
    }
  };
  const clear = (): void => { setHand(null); setStep(null); };

  /* ── money: one act ── */
  const collect = useMutation({
    mutationFn: async (): Promise<BillDone> => {
      const priced = previewQ.data;
      if (hand === null || priced === undefined) throw new Error("not priced");
      const body: DeskCollectBody = {
        encounterNo: hand.encounterNo,
        studyIds: toBill.map((v) => v.studyId),
        addOns: pickedAddOns.map((a) => ({ studyId: a.studyId, kind: a.kind })),
        tender: { mode, amountPaise: priced.totals.netPayablePaise, ...(mode === "cash" ? {} : { refText: refText.trim() }) },
      };
      const json = JSON.stringify(body);
      if (idem.current?.body !== json) idem.current = { body: json, key: newIdempotencyKey() };
      const done = await deskCollect(body, idem.current.key);
      idem.current = null;
      return { invoiceNo: done.invoiceNo, receiptNo: done.receiptNo, totalPaise: done.totalPaise, adopted: done.adopted };
    },
    onMutate: () => { setStep("bill"); },
    onSuccess: (done) => { setPaid(done); setBillError(null); void refresh(); },
    onError: (e) => { setBillError({ code: radiologyErrorCode(e), message: radiologyErrorText(e) }); },
  });

  /* ── the slot ── */
  const book = useMutation({
    mutationFn: async ({ studyId, clearBed }: { studyId: string; clearBed?: boolean }) => {
      const pick = effectivePicks[studyId];
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
     * A walk-in is booked NOW on the first free machine — and the patient is standing at the counter,
     * so the same act is the arrival: one server act books and checks in, in one transaction, and the
     * gate set it opens is shown in the lane. A desk without `radiology.checkin` only books.
     */
    mutationFn: async (studyId: string): Promise<string[] | null> => {
      if (!can("radiology.checkin")) { await walkIn(studyId); return null; }
      return (await deskWalkInNow(studyId)).gates;
    },
    onSuccess: (gates, studyId) => {
      setSlotErrors((p) => ({ ...p, [studyId]: undefined }));
      if (gates !== null) setOpened((p) => ({ ...p, [studyId]: gates }));
      void refresh();
    },
    onError: (e, studyId) => { setSlotErrors((p) => ({ ...p, [studyId]: { code: radiologyErrorCode(e), message: radiologyErrorText(e) } })); },
  });

  /* ── #1085 — the late booking's one-tap no-show, and the no-shows waiting to be booked again ── */
  const [noShowError, setNoShowError] = useState<string | null>(null);
  const noShow = useMutation({
    mutationFn: (studyId: string) => markNoShow(studyId, NO_SHOW_REASON),
    onSuccess: () => { setNoShowError(null); void refresh(); },
    onError: (e) => { setNoShowError(radiologyErrorText(e)); },
  });
  const rebookQ = useQuery({
    queryKey: ["radiology", "desk", "no-shows"], queryFn: fetchNoShowsToRebook,
    enabled: can("radiology.schedule"), retry: false,
  });
  const toRebook = rebookQ.data?.rows ?? [];

  /* ── the dock: the ONE next act ── */
  const needMoney = toBill.length > 0 && paid === null;
  const current: Step = step ?? (needMoney ? "bill" : "slot");
  const ready = unbooked.find((r) => {
    const p = effectivePicks[r.studyId];
    const d = devices.find((x) => x.id === p?.deviceResourceId);
    return p !== undefined && p.at !== "" && d !== undefined && !(d.ionising && d.licensedNow === false);
  });
  const total = previewQ.data?.totals.netPayablePaise;
  const refMissing = mode !== "cash" && refText.trim() === "";

  let dock: { label: string; hint: string; run: (() => void) | null };
  if (hand === null) dock = { label: "", hint: "", run: null };
  else if (viewsLoading) dock = { label: t("radiology.counter.loading"), hint: "", run: null };
  else if (current === "bill" && needMoney) {
    const blocked = !drawerOpen ? t("radiology.counter.drawerClosed") : refMissing ? t("radiology.counter.dock.refMissing") : total === undefined ? t("radiology.counter.pricing") : null;
    dock = {
      label: total === undefined ? t("radiology.counter.dock.collectPending") : t("radiology.counter.dock.collect", { amount: fmtRupees(total), mode: t(`radiology.counter.mode.${mode}`) }),
      hint: blocked ?? t("radiology.counter.dock.collectHint"),
      run: blocked === null && !collect.isPending ? () => collect.mutate() : null,
    };
  } else if (!needMoney && unbooked.length === 0) dock = { label: t("radiology.counter.dock.done"), hint: t("radiology.counter.dock.doneHint"), run: clear };
  else if (current === "bill") dock = { label: t("radiology.counter.dock.toSlot"), hint: t("radiology.counter.dock.billHint"), run: () => setStep("slot") };
  else if (ready !== undefined) {
    const p = effectivePicks[ready.studyId]!;
    const d = devices.find((x) => x.id === p.deviceResourceId);
    dock = {
      label: t("radiology.counter.dock.book", { machine: d?.code ?? "", time: p.at.slice(11, 16) }),
      hint: t("radiology.counter.dock.bookHint"),
      run: book.isPending ? null : () => book.mutate({ studyId: ready.studyId }),
    };
  } else if (unbooked.length > 0) dock = { label: t("radiology.counter.dock.pick"), hint: t("radiology.counter.dock.pickHint"), run: null };
  else dock = { label: t("radiology.counter.dock.toBill"), hint: t("radiology.counter.unpaidWords"), run: () => setStep("bill") };

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
  /** #1085 — booked, not arrived, 30 minutes past the slot. */
  const late = rows.filter((r) => r.status === "scheduled" && r.scheduledAt !== null && minutesSince(r.scheduledAt, now) > CLOCK_MINUTES);
  const clocksAlert = waitingToBook.length + notReady.length + late.length > 0;

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
                <PatientFacts row={r} />
                <span className="block text-xs text-muted-foreground">
                  {r.priority === "stat" ? <b className="text-red-700">STAT · </b> : null}
                  {r.studyTypeName ?? r.studyTypeCode} · {statusWord(t, r)}
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
      {late.map((r) => (
        <li key={`l-${r.studyId}`} className="flex flex-wrap items-center justify-between gap-2" data-late={r.studyId}>
          <span className="min-w-0">{t("radiology.counter.clockLate", { name: r.patientName, study: r.studyTypeCode, min: minutesSince(r.scheduledAt ?? r.createdAt, now) })}</span>
          <button
            type="button" data-testid={`clock-noshow-${r.studyId}`}
            className="rounded border px-2 py-0.5 text-xs disabled:opacity-50"
            disabled={!can("radiology.schedule") || noShow.isPending}
            onClick={() => noShow.mutate(r.studyId)}
          >
            {t("radiology.counter.noShowAct")}
          </button>
        </li>
      ))}
      {!clocksAlert && <li className="text-muted-foreground">{t("radiology.counter.clocksQuiet")}</li>}
      {noShowError !== null && <li role="alert" className="text-xs text-red-700">{noShowError}</li>}
      {toRebook.length > 0 && (
        <li className="pt-1" data-testid="desk-rebook">
          <span className="tag">{t("radiology.counter.rebookTitle", { count: toRebook.length })}</span>
          <ul className="m-0 mt-1 list-none space-y-1 p-0">
            {toRebook.map((r) => (
              <li key={`n-${r.studyId}`} data-rebook={r.studyId}>
                {t("radiology.counter.clockRebook", { name: r.patientName, study: r.studyTypeCode, day: fmtIst(r.missedAt) })}
                {r.paid && <span className="ml-1 text-xs text-green-800">{t("radiology.counter.rebookPaid", { until: fmtIst(r.goodUntil) })}</span>}
              </li>
            ))}
          </ul>
        </li>
      )}
    </ul>
  );

  /* ── the lane: the patient in hand, their studies, and what the prep bay will ask ── */
  const lane = hand === null
    ? <p className="mt-4 text-sm text-muted-foreground" data-testid="nobody-in-hand">{t("radiology.counter.nobody")}</p>
    : (
      <div className="mt-4 space-y-3 text-sm" data-testid="patient-in-hand">
        <div>
          <span className="tag">{t("radiology.counter.inHand")}</span>
          <p className="m-0 mt-1 text-base font-semibold">{first?.patientName ?? mine[0]?.patientName ?? "—"}</p>
          <p className="m-0 mo text-xs">{first?.uhid ?? ""} · {hand.encounterNo}</p>
          <div className="mt-1"><CreditChip patientId={hand.patientId} testId="imaging-credit" /></div>
        </div>
        <div>
          <span className="tag">{t("radiology.counter.today")}</span>
          {desk.length === 0
            ? <p className="m-0 mt-1 text-muted-foreground">{t("radiology.counter.nothingHere")}</p>
            : <div className="mt-1"><CounterStudies studies={desk} views={views} inRoom={inRoom} /></div>}
        </div>
        {Object.keys(opened).length > 0 && (
          <p role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs">{t("radiology.counter.arrived")}</p>
        )}
        {openErrors.map((m) => <p key={m} role="alert" className="text-xs text-red-700">{m}</p>)}
        {desk.length > 0 && <CounterChecks studies={desk} views={views} opened={opened} />}
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
      copilot={<ImagingCopilot subject={patient.uhid === "" ? null : patient.uhid} patientName={patient.name} />}
      clocks={clocks}
      clocksAlert={clocksAlert}
      clocksSummary={clocksAlert ? t("radiology.counter.clocksSummary", { count: waitingToBook.length + notReady.length + late.length }) : t("radiology.counter.clocksNone")}
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
                    type="button" aria-current={current === s ? "step" : undefined}
                    className={`rounded border px-3 py-1 text-sm ${current === s ? "border-green-700 bg-green-50 font-semibold" : ""}`}
                    onClick={() => setStep(s)}
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
              {desk.length > 0 && current === "bill" && (
                <CounterBill
                  views={viewList} toBill={paid === null ? toBill : []}
                  addOnPick={addOnPick} onAddOn={(k) => setAddOnPick((p) => ({ ...p, [k]: p[k] !== true }))}
                  preview={previewQ.data} previewError={previewQ.isError ? radiologyErrorText(previewQ.error) : null}
                  drawerOpen={drawerOpen} mode={mode} onMode={setMode} refText={refText} onRef={setRefText}
                  paid={paid}
                  billError={billError === null ? null : <Refusal code={billError.code} message={billError.message} />}
                />
              )}
              {desk.length > 0 && current === "slot" && (
                <div className="space-y-3">
                  <CounterSlot
                    studies={desk} views={views} devices={devices} picks={effectivePicks}
                    onPick={(id, p) => setPicks((prev) => ({ ...prev, [id]: p }))}
                    onWalkIn={(id) => walk.mutate(id)}
                    errors={slotErrors}
                    onClearBed={(id) => book.mutate({ studyId: id, clearBed: true })}
                    onGoBill={() => setStep("bill")}
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
