import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, newIdempotencyKey } from "../lib/api";
import { fmtPaise } from "../lib/format";
import {
  collectionQueue, deskFind, duplicateWarnings, istToday, labErrorText, labFeeState, orderableDetail, placeLabOrder,
  previewLabOrder,
} from "../lib/lab-api";
import { Button } from "@/components/ui/button";
import { useAuth } from "../lib/auth";
import { LabStation, sexAge } from "./lab-seat";
import type {
  DeskOrderRequest, WireDeskFindHit, WireDeskOrder, WireDuplicateWarning, WireLabDoctor, WireOrderable, WirePricedDraft,
} from "../lib/lab-api";
import { CreditChip } from "../components/patient-credit";
import { BookingPanel, ParametersOf, PatientSummary, TestChooser, TodaysBookings, TubeDot } from "./lab-desk-flow";
import type { WireLabBooking } from "../lib/lab-api";
import { PaperSlipSheet } from "../components/paper-slip";

/**
 * PLAN 17c T1 — **LAB RECEPTION**: Sanjay's seat (design board 1).
 *
 * ═══ ONE FIELD, THREE DOORS (D4) ═══
 *
 * The clerk scans the token or the slip, or types the token, the UHID or a name. `GET /lab/desk/find`
 * decides the door by SHAPE (`T-118`, `V…`, `L…`, anything else is a patient search) and returns
 * hits the clerk CONFIRMS by name — names confirm, they never select (edge case 2: three Sunita
 * Devis on one morning). A hit with a visit brings the consult's Rx lines with it; that reader
 * (`advisedTestItems`) shipped in 17a with no consumer, and this seat is the first.
 *
 * ═══ THE UNBILLED LINE IS CREDIT, NOT A SECOND BILL (D3) ═══
 *
 * Every line is "billed here" by default. A line the patient is not paying for now is switched to
 * credit: the tender covers the paid lines' net (billing's own per-line prices from `preview`), the
 * remainder rides `credit: {reason}`, and DD23's interlock holds the report until the counter
 * settles it. The tube is drawn either way — a lab that refuses to draw blood until the bill clears
 * turns a cashier's queue into a clinical one (17a DD6).
 *
 * ═══ THE WALK-IN DOOR ═══
 *
 * A patient with no visit today — an outside prescription — is ordered with `walkIn`, and the
 * server opens the `V` visit in the LAB department in the same transaction as the order. A patient
 * with no record at all is registered in place (edge case 3) and then ordered the same way.
 *
 * What is carried from 17b's desk unchanged: the duplicate warning is shown BEFORE the order is
 * sent and acknowledged deliberately; consent is a NAME, not a checkbox; the idempotency key is
 * minted once per attempt and rotated on success.
 */

type LineSource = "advised" | "added";
type Line = {
  orderable: WireOrderable; source: LineSource; onCredit: boolean; alreadyOrderedItemId: string | null;
  /** Owner ruling 2026-10-06 — the desk scribe who typed this test from the doctor's paper, when one did. */
  typedFromPaperBy?: string | null;
};

const sexOptions = ["male", "female", "other", "unknown"] as const;
type RegisterFields = { name: string; phone: string; ageYears: string; sex: (typeof sexOptions)[number] };
const EMPTY_REGISTER: RegisterFields = { name: "", phone: "", ageYears: "", sex: "unknown" };

/** The advised line, as the basket carries it — one shape for both sources. */
function advisedToOrderable(a: WireDeskFindHit["visit"] extends infer V ? V extends { advised: (infer L)[] } ? L : never : never): WireOrderable | null {
  if (a.orderable === null) return null;
  return {
    serviceId: a.serviceId, code: a.code, nameEn: a.name, nameHi: null, discipline: "",
    specimenType: a.orderable.specimenType, container: a.orderable.container,
    consentRequired: a.orderable.consentRequired, sensitive: a.orderable.sensitive, active: true,
  };
}

/**
 * WHAT GOES ON THE WIRE FOR THE MONEY — a pure function, so the test can read it and so the four
 * cases are written once: nothing owed; everything paid; everything on credit; a mix.
 */
export function moneyBlockFor(
  priced: WirePricedDraft | null, lines: readonly Line[], tender: "cash" | "card" | "upi", creditReason: string,
): Pick<DeskOrderRequest, "receipt" | "credit"> {
  if (priced === null) return {};
  const creditIds = new Set(lines.filter((l) => l.onCredit).map((l) => l.orderable.serviceId));
  const paidPaise = priced.lines
    .filter((l) => !creditIds.has(l.serviceId))
    .reduce((sum, l) => sum + l.netPaise, 0);
  const total = priced.totals.netPayablePaise;
  if (total === 0) return {};
  if (creditIds.size === 0) return { receipt: { tenders: [{ mode: tender, amountPaise: total }] } };
  if (paidPaise === 0) return { credit: { reason: creditReason } };
  return { receipt: { tenders: [{ mode: tender, amountPaise: paidPaise }] }, credit: { reason: creditReason } };
}

function initialsOf(name: string): string {
  return name.split(/\s+/).filter((w) => w !== "").slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

export function LabDesk(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const serviceDate = istToday();

  /* ── the one field ── */
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<WireDeskFindHit[] | null>(null);
  const [selected, setSelected] = useState<WireDeskFindHit | null>(null);
  const [registering, setRegistering] = useState(false);
  const [fields, setFields] = useState<RegisterFields>(EMPTY_REGISTER);
  /** Pass 1 F6 — with two active pathologists the walk-in must name one; the server refuses to choose. */
  const [labDoctors, setLabDoctors] = useState<WireLabDoctor[]>([]);
  const [walkInDoctorId, setWalkInDoctorId] = useState("");
  const fieldRef = useRef<HTMLInputElement>(null);
  /**
   * OWNER 2026-10-11 — SUGGESTIONS WHILE TYPING, the way `/counter` does it: 180 ms after the last
   * key and from two characters, the same `GET /lab/desk/find` answers into the list below the field.
   * A suggestion is only ever a candidate the clerk taps (D4: names confirm, they never select); the
   * exact-door auto-pick stays on Enter, which is what a scanner sends, so a half-typed `T-1` can never
   * land on token 1's patient.
   */
  const [suggesting, setSuggesting] = useState(false);
  const [debounced, setDebounced] = useState("");

  /* ── the order ── */
  const [lines, setLines] = useState<Line[]>([]);
  const [slipOpen, setSlipOpen] = useState(false);
  /**
   * OWNER 2026-10-11 — which next step is open under the patient summary: none yet (the summary
   * offers New walk-in · Future appointment), the order, a booking, or the order just placed.
   */
  const [step, setStep] = useState<"none" | "order" | "book" | "done">("none");
  /** The booking this order fulfils, when the patient arrived for one. */
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [bookedNote, setBookedNote] = useState<string | null>(null);
  /** Per test in the basket, whether its parameters are shown. */
  const [openParams, setOpenParams] = useState<string[]>([]);
  const [consents, setConsents] = useState<Record<string, string>>({});
  const [reflexConsent, setReflexConsent] = useState(false);
  const [priority, setPriority] = useState<"routine" | "urgent" | "stat">("routine");
  const [referrerName, setReferrerName] = useState("");
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<WireDuplicateWarning[] | null>(null);
  const [priced, setPriced] = useState<WirePricedDraft | null>(null);
  const [tender, setTender] = useState<"cash" | "card" | "upi">("cash");
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());
  const [placed, setPlaced] = useState<WireDeskOrder | null>(null);
  /*
   * GAP A3 — a lab balance is no longer CREDIT on the server (the owner's alone since 2026-09-28): it
   * is a bill held for collection before the report (DD23), so `creditExtended` reads false. The
   * placed note says there is a balance from what THIS screen sent, not from that flag.
   */
  const placedWithBalance = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { fieldRef.current?.focus(); }, []);

  /**
   * ═══ THE PANEL ASKS FOR A GRANT THIS SEAT DOES NOT HOLD, AND SAID SO AS A FAILURE ═══
   *
   * `GET /lab/collection/queue` is gated on `lab.collection.operate` — the permission to DRAW BLOOD —
   * and `lab_reception` does not hold it. This query had no `enabled:` guard and a 30-second refetch,
   * so a reception screen fired a **forbidden request twice a minute, for ever**, and rendered
   * *"The portal list could not be loaded"* — which sends a clerk to look for a network fault that
   * does not exist. Found by opening the seat in a browser; no test can see a 403 the UI swallows.
   *
   * The `enabled:` idiom was already three lines below this, on `catalogue`.
   *
   * **The vocabulary mismatch is NOT fixed here and must not be.** Reception wants to READ the queue
   * to answer *"has my order reached?"* — the hint above the panel says exactly that — and the only
   * door is the ACT of drawing blood. Widening `lab.collection.operate` to reception would decide,
   * in a screen fix, that a clerk may draw blood. Splitting the route into a read door and an operate
   * door is a design call and it is the owner's.
   */
  const maySeePortal = can("lab.collection.operate");
  const portal = useQuery({
    queryKey: ["lab", "collection", serviceDate],
    queryFn: () => collectionQueue(serviceDate),
    enabled: maySeePortal,
    refetchInterval: 30_000,
  });
  /** Lab fee switched off in Billing office → Fees: the desk skips its money step (spec 2026-10-11). */
  const feeState = useQuery({ queryKey: ["lab", "desk", "fee-state"], queryFn: labFeeState, staleTime: 60_000, retry: false });
  const labFree = feeState.data?.labFree === true;

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 180);
    return () => clearTimeout(id);
  }, [q]);
  const live = useQuery({
    queryKey: ["lab", "desk-find", debounced, serviceDate],
    queryFn: () => deskFind(debounced, serviceDate, true),
    enabled: suggesting && debounced.length >= 2,
    retry: false,
  });
  useEffect(() => {
    if (!suggesting || live.data === undefined) return;
    setHits(live.data.hits);
    setLabDoctors(live.data.labDoctors);
  }, [live.data, suggesting]);

  const find = useMutation({
    mutationFn: () => deskFind(q, serviceDate),
    onSuccess: (r) => {
      setSuggesting(false);
      setHits(r.hits);
      setLabDoctors(r.labDoctors);
      setError(null);
      /**
       * ONE hit through an EXACT door — token, visit, order, UHID — is the person. A mobile is not
       * exact (pass 1 F10: a family phone with one registered member must still be confirmed), and
       * a name never is (D4).
       */
      if (r.hits.length === 1 && ["token", "visit", "order", "uhid"].includes(r.hits[0]!.matchedOn)) choose(r.hits[0]!);
      else setSelected(null);
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  function resetOrder(): void {
    setLines([]); setConsents({}); setReflexConsent(false); setPriority("routine"); setReferrerName("");
    setAcknowledged([]); setWarnings(null); setPriced(null); setPlaced(null); setError(null);
  }

  /**
   * A SUGGESTION carries no Rx lines (they are a logged read of the visit, never a keystroke's), so
   * picking one re-asks by the visit number and fills the basket from that answer.
   */
  const pick = useMutation({
    mutationFn: async (hit: WireDeskFindHit): Promise<WireDeskFindHit> => {
      if (hit.visit === null || hit.visit.advisedLoaded !== false) return hit;
      const full = await deskFind(hit.visit.encounterNo, serviceDate);
      return full.hits.find((h) => h.visit?.encounterId === hit.visit!.encounterId) ?? hit;
    },
    onSuccess: (hit) => choose(hit),
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  function choose(hit: WireDeskFindHit): void {
    setSuggesting(false);
    setSelected(hit);
    setRegistering(false);
    setWalkInDoctorId(""); // pass 2 NEW-4 — a decision the server refuses to make is not carried to the next patient
    resetOrder();
    const advised: Line[] = [];
    for (const a of hit.visit?.advised ?? []) {
      const orderable = advisedToOrderable(a);
      if (orderable === null) continue;
      advised.push({ orderable, source: "advised", onCredit: false, alreadyOrderedItemId: a.alreadyOrderedItemId, typedFromPaperBy: a.typedFromPaperBy ?? null });
    }
    setLines(advised);
    setReferrerName(hit.visit?.referrerName ?? "");
    setBookingId(null); setBookedNote(null); setOpenParams([]);
    /** Tests already advised today open the order at once; otherwise the summary offers the two steps. */
    setStep(advised.some((l) => l.alreadyOrderedItemId === null) ? "order" : "none");
  }

  /** Back to an empty desk for the next person. */
  function nextPatient(): void {
    setSelected(null); setHits(null); setQ(""); setDebounced(""); setSuggesting(false);
    resetOrder(); setStep("none"); setBookingId(null); setBookedNote(null);
    fieldRef.current?.focus();
  }

  /**
   * ARRIVED for a booking: take the person (asked by UHID, the full read), then open the order with
   * the booked tests in it and the booking riding along so it closes with the order.
   */
  const arrive = useMutation({
    mutationFn: async (b: WireLabBooking) => {
      let hit = selected !== null && selected.patient.id === b.patient.id ? selected : null;
      if (hit === null) {
        const r = await deskFind(b.patient.uhid, serviceDate);
        hit = r.hits.find((h) => h.patient.id === b.patient.id) ?? null;
        setLabDoctors(r.labDoctors);
      }
      if (hit === null) throw new Error(t("lab.desk.flow.arrivedNotFound"));
      const details = await Promise.all(b.tests.map((x) => orderableDetail(x.serviceId)));
      return { hit, orderables: details.map((d) => d.orderable) };
    },
    onSuccess: ({ hit, orderables }, b) => {
      choose(hit);
      setHits(null);
      touchLines((prev) => {
        const next = [...prev];
        for (const o of orderables) {
          if (!next.some((l) => l.orderable.serviceId === o.serviceId)) next.push({ orderable: o, source: "added", onCredit: false, alreadyOrderedItemId: null });
        }
        return next;
      });
      setBookingId(b.id);
      setStep("order");
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  /** THE PRICE DIES WITH THE BASKET (17b pass 2, F14): any change to the lines voids the quote. */
  function touchLines(next: (prev: Line[]) => Line[]): void {
    setLines(next);
    setWarnings(null); setPriced(null); setAcknowledged([]);
  }

  const orderableLines = lines.filter((l) => l.alreadyOrderedItemId === null);
  const serviceIds = orderableLines.map((l) => l.orderable.serviceId);

  const check = useMutation({
    mutationFn: async () => {
      if (selected === null) throw new Error("no patient");
      return {
        warnings: await duplicateWarnings(selected.patient.id, serviceIds),
        /** The duplicate check, the price and the tubes are one question: "what am I placing?" */
        priced: await previewLabOrder(selected.patient.id, selected.visit?.encounterNo ?? null, serviceIds),
      };
    },
    onSuccess: (r) => { setWarnings(r.warnings); setPriced(r.priced); setError(null); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const register = useMutation({
    mutationFn: async () => {
      const ageYears = fields.ageYears.trim() === "" ? undefined : Number(fields.ageYears);
      const body = {
        name: fields.name.trim(), sex: fields.sex,
        ...(fields.phone.trim() === "" ? {} : { phone: fields.phone.trim() }),
        ...(ageYears === undefined || Number.isNaN(ageYears) ? {} : { ageYears }),
      };
      const res = await api<{ patient: { id: string; uhid: string } }>("POST", "/patients", body);
      return res.patient;
    },
    onSuccess: (p) => {
      choose({
        matchedOn: "uhid",
        patient: { id: p.id, uhid: p.uhid, display: fields.name.trim(), administrativeGender: fields.sex, dob: null, restricted: false },
        visit: null, orders: [],
      });
      setHits(null);
      setFields(EMPTY_REGISTER);
      /** A person just registered at the lab is a walk-in: the test picker opens at once. */
      setStep("order");
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const place = useMutation({
    mutationFn: () => {
      if (selected === null) throw new Error("no patient");
      const money = moneyBlockFor(priced, orderableLines, tender, t("lab.desk.creditReason"));
      placedWithBalance.current = money.credit !== undefined;
      const body: DeskOrderRequest = {
        patientId: selected.patient.id, serviceDate, priority, reflexConsent,
        acknowledgedDuplicates: acknowledged,
        items: orderableLines.map((l) => (
          l.orderable.consentRequired && consents[l.orderable.serviceId]
            ? { serviceId: l.orderable.serviceId, consent: { recordedBy: consents[l.orderable.serviceId]! } }
            : { serviceId: l.orderable.serviceId }
        )),
        ...(selected.visit !== null
          ? { encounterNo: selected.visit.encounterNo, orderingClinicianId: selected.visit.doctorUserId ?? undefined }
          : { walkIn: {
              ...(referrerName.trim() === "" ? {} : { referrerName: referrerName.trim() }),
              ...(walkInDoctorId === "" ? {} : { doctorId: walkInDoctorId }),
            } }),
        ...money,
        ...(bookingId === null ? {} : { bookingId }),
      };
      return placeLabOrder(body, idempotencyKey);
    },
    onSuccess: async (order) => {
      setError(null);
      setLines([]); setWarnings(null); setAcknowledged([]); setPriced(null);
      setIdempotencyKey(newIdempotencyKey());
      void qc.invalidateQueries({ queryKey: ["lab"] });
      /**
       * Pass 1 F7 — a walk-in order OPENED a visit; a second Save on the same patient must ride it,
       * not open another. Re-find by the visit number the server minted and take that hit.
       */
      if (selected !== null && selected.visit === null) {
        try {
          const again = await deskFind(order.encounterNo, serviceDate);
          const hit = again.hits.find((h) => h.visit?.encounterNo === order.encounterNo);
          if (hit) { setSelected(hit); setReferrerName(hit.visit?.referrerName ?? ""); }
        } catch { /* the order stands; the next find will show the visit */ }
      }
      setPlaced(order);
      setBookingId(null);
      setStep("done");
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  /**
   * THE FREE ROAD (owner 2026-10-11): no price, no tender. The duplicate check still runs — a test
   * already drawn this week is still a question for the clerk — and with nothing to acknowledge the
   * order goes straight through; the server still records its ₹0 bill.
   */
  const sendFree = useMutation({
    mutationFn: async () => {
      if (selected === null) throw new Error("no patient");
      return duplicateWarnings(selected.patient.id, serviceIds);
    },
    onSuccess: (found) => {
      setWarnings(found);
      if (found.every((w) => acknowledged.includes(w.duplicateOfItemId))) place.mutate();
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const missingConsent = orderableLines.filter((l) => l.orderable.consentRequired && !consents[l.orderable.serviceId]);
  const unacknowledged = (warnings ?? []).filter((w) => !acknowledged.includes(w.duplicateOfItemId));
  const money = useMemo(
    () => moneyBlockFor(priced, orderableLines, tender, ""),
    [priced, orderableLines, tender],
  );
  const paidPaise = money.receipt?.tenders[0]?.amountPaise ?? 0;
  const creditPaise = priced === null ? 0 : priced.totals.netPayablePaise - paidPaise;
  const anyCredit = orderableLines.some((l) => l.onCredit);

  const waiting = (portal.data ?? []).length;

  /* ── arrived on the portal · no typing needed ── */
  const listPane = (
    <div className="space-y-4">
    <TodaysBookings serviceDate={serviceDate} onArrived={(b) => arrive.mutate(b)} />
    <section className="space-y-2" aria-label={t("lab.desk.portal")}>
      <h2 className="text-sm font-semibold">{t("lab.desk.portal")}</h2>
      <p className="text-xs text-muted-foreground">{t("lab.desk.portalHint")}</p>
      {/*
        A REFUSAL IS A SENTENCE, NOT A BLANK. Gating the query alone would replace a misleading
        error with an empty panel and no explanation, which is worse: a refusal presented as a
        failure teaches a user to ignore it, and a refusal presented as NOTHING teaches it faster.
        So the seat is told what it may not see, and by which grant.
      */}
      {!maySeePortal && <p className="text-sm">{t("lab.desk.portalNotPermitted")}</p>}
      {maySeePortal && portal.isError && <p className="text-sm">{t("lab.desk.portalUnavailable")}</p>}
      <ul className="divide-y divide-border rounded border border-border text-sm">
        {(portal.data ?? []).slice(0, 12).map((row) => (
          <li key={row.specimenId} className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="truncate">
              <span className="font-medium">{row.patientDisplay}</span>
              <span className="text-muted-foreground"> · {row.container} · {row.specimenType}</span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{row.waitingMinutes} {t("lab.desk.min")}</span>
          </li>
        ))}
        {portal.data !== undefined && portal.data.length === 0 && (
          <li className="px-2 py-1.5 text-muted-foreground">{t("lab.desk.portalEmpty")}</li>
        )}
      </ul>
    </section>
    </div>
  );

  return (
    <LabStation
      station="desk"
      title={t("lab.desk.title")}
      place={t("lab.desk.place")}
      stats={[
        { label: t("lab.desk.arrivedToday"), value: waiting, tone: "live" },
      ]}
      list={listPane}
    >
      {/* ── walk-in with a slip · one field, three doors — owner 2026-10-11: drawn in /counter's paper-and-pine (`.pp`) ── */}
      <section className="space-y-3">
      <div className="pp space-y-3" style={{ fontFamily: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', color: "var(--ink)" }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>{t("lab.desk.whoTitle")}</div>
          <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 4 }}>{t("lab.desk.whoNote")}</div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (q.trim() !== "") find.mutate(); }}>
          <input
            ref={fieldRef}
            className="in"
            style={{ height: 52, fontSize: 16 }}
            placeholder={t("lab.desk.findPlaceholder")}
            aria-label={t("lab.desk.find")}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSuggesting(true); }}
          />
        </form>

        <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
          <span className="tag">
            {hits === null || (suggesting && debounced.length < 2) ? t("lab.desk.notOnFile")
              : hits.length === 0 ? t("lab.desk.noMatch") : t("lab.desk.notOneOfThese")}
          </span>
          <button type="button" className="pill" style={{ borderColor: "var(--green)", color: "var(--green)", fontWeight: 700 }}
            onClick={() => setRegistering(true)}>
            {t("lab.desk.registerNew")}
          </button>
          <span style={{ fontSize: 11, color: "var(--faint)" }}>
            {hits !== null && debounced.length >= 2
              ? t("lab.desk.onFileFor", { count: hits.length, q: debounced })
              : t("lab.desk.lanesHint")}
          </span>
        </div>

        {suggesting && debounced.length >= 2 && live.isFetching && (
          <div className="box" style={{ padding: 20, textAlign: "center", color: "var(--faint)", borderStyle: "dashed" }}>
            {t("lab.desk.searching")}
          </div>
        )}

        {hits !== null && (selected === null || suggesting) && !(suggesting && (debounced.length < 2 || live.isFetching)) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {hits.length === 0 && (
              <div className="box" style={{ padding: 22, textAlign: "center", color: "var(--dim)", borderStyle: "dashed" }}>
                {t("lab.desk.noOneMatches", { q: q.trim() })}{" "}
                <button type="button" style={{ color: "var(--green)", fontWeight: 700, textDecoration: "underline" }}
                  onClick={() => setRegistering(true)}>
                  {t("lab.desk.registerNew")}
                </button>
              </div>
            )}
            {hits.length > 1 && <div style={{ fontSize: 11, color: "var(--faint)" }}>{t("lab.desk.confirmByName")}</div>}
            <ul style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="find-hits">
              {hits.map((h, i) => (
                <li key={`${h.patient.id}-${h.visit?.encounterId ?? "none"}`} className="box"
                  style={{
                    display: "flex", alignItems: "center", gap: 13, padding: "12px 15px", flexWrap: "wrap",
                    ...(i === 0 ? { borderColor: "var(--green)", boxShadow: "0 0 0 3px var(--green-soft)" } : {}),
                  }}>
                  <div aria-hidden style={{
                    width: 38, height: 38, borderRadius: 6, background: "var(--wash)", display: "flex",
                    alignItems: "center", justifyContent: "center", fontWeight: 600, color: "var(--dim)", flexShrink: 0,
                  }}>
                    {initialsOf(h.patient.display)}
                  </div>
                  <div style={{ width: 210, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                      {h.patient.display}
                      {h.patient.restricted && <span className="pill rd" style={{ height: 19, marginLeft: 6 }}>restricted</span>}
                    </div>
                    <div className="mo" style={{ fontSize: 11, color: "var(--dim)" }}>
                      {sexAge(h.patient.administrativeGender, h.patient.dob)}
                      {" · "}
                      {h.patient.phoneLast4 == null ? t("lab.desk.noMobile")
                        : `••••${h.patient.phoneLast4}${h.patient.phoneOf === "guardian" ? ` (${t("lab.desk.guardianMobile")})` : ""}`}
                    </div>
                    {h.patient.guardian != null && (
                      <div style={{ fontSize: 11.5, color: "var(--ink)", marginTop: 1 }} data-testid="hit-guardian">
                        {h.patient.guardian.relation === null
                          ? t("lab.desk.fatherHusband", { name: h.patient.guardian.name })
                          : t("lab.desk.guardianOf", { name: h.patient.guardian.name, relation: t(`lab.desk.relation.${h.patient.guardian.relation}`, { defaultValue: h.patient.guardian.relation }) })}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 1 }}>
                      {h.visit === null ? t("lab.desk.noVisitToday")
                        : `${h.visit.encounterNo}${h.visit.tokenNo === null ? "" : ` · T-${String(h.visit.tokenNo)}`}${
                          h.visit.departmentName === null ? "" : ` · ${h.visit.departmentName}`}`}
                    </div>
                  </div>
                  <span className="mo" style={{ fontSize: 12, fontWeight: 600, width: 120 }}>{h.patient.uhid}</span>
                  <div style={{ display: "flex", gap: 5, flexGrow: 1, flexWrap: "wrap" }}>
                    <span className="pill on" style={{ height: 20 }}>{t(`lab.desk.matchedOn.${h.matchedOn}`)}</span>
                  </div>
                  <button type="button" className={i === 0 ? "sec grn" : "sec"}
                    aria-label={`${h.patient.display} · ${h.patient.uhid}`}
                    disabled={pick.isPending}
                    onClick={() => pick.mutate(h)}>
                    {t("lab.desk.pick")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

        {registering && (
          <form
            className="grid grid-cols-2 gap-2 rounded border border-border p-3 text-sm md:grid-cols-4"
            aria-label={t("lab.desk.registerNew")}
            onSubmit={(e) => { e.preventDefault(); register.mutate(); }}
          >
            <label>{t("lab.desk.regName")}
              <input className="mt-1 w-full rounded border border-input px-2 py-1" value={fields.name}
                onChange={(e) => setFields((f) => ({ ...f, name: e.target.value }))} />
            </label>
            <label>{t("lab.desk.regPhone")}
              <input className="mt-1 w-full rounded border border-input px-2 py-1" value={fields.phone}
                onChange={(e) => setFields((f) => ({ ...f, phone: e.target.value }))} />
            </label>
            <label>{t("lab.desk.regAge")}
              <input className="mt-1 w-full rounded border border-input px-2 py-1" inputMode="numeric" value={fields.ageYears}
                onChange={(e) => setFields((f) => ({ ...f, ageYears: e.target.value }))} />
            </label>
            <label>{t("lab.desk.regSex")}
              <select className="mt-1 w-full rounded border border-input px-2 py-1" value={fields.sex}
                onChange={(e) => setFields((f) => ({ ...f, sex: e.target.value as RegisterFields["sex"] }))}>
                {sexOptions.map((s) => <option key={s} value={s}>{t(`lab.desk.sex.${s}`)}</option>)}
              </select>
            </label>
            <div className="col-span-2 flex gap-2 md:col-span-4">
              {/* DESK-FIXES E — age is mandatory at registration (DECIDED 2026-09-28; an estimate is fine). */}
              <Button type="submit" disabled={fields.name.trim() === "" || !/^\d{1,3}$/.test(fields.ageYears.trim()) || register.isPending}>{t("lab.desk.regSave")}</Button>
              <Button type="button" variant="outline" onClick={() => setRegistering(false)}>{t("lab.desk.cancel")}</Button>
            </div>
          </form>
        )}

        {selected !== null && (
          <div className="space-y-3">
            {/* ── the patient, confirmed ── */}
            <div className="pp box" data-testid="patient-card"
              style={{ fontFamily: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', color: "var(--ink)", padding: "12px 15px", display: "flex", gap: 13, alignItems: "flex-start", borderColor: "var(--green)" }}>
              <div aria-hidden style={{
                width: 44, height: 44, borderRadius: 8, background: "var(--green-soft)", color: "var(--green)", display: "flex",
                alignItems: "center", justifyContent: "center", fontWeight: 700, flexShrink: 0,
              }}>{initialsOf(selected.patient.display)}</div>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 10px" }}>
                  <span style={{ fontSize: 17, fontWeight: 700 }}>{selected.patient.display}</span>
                  <span className="mo" style={{ fontSize: 12, color: "var(--dim)" }}>{sexAge(selected.patient.administrativeGender, selected.patient.dob)}</span>
                  <span className="mo" style={{ fontSize: 12.5, fontWeight: 600 }}>{selected.patient.uhid}</span>
                  {!selected.patient.restricted && <CreditChip patientId={selected.patient.id} testId="lab-credit" />}
                  {selected.patient.restricted && <span className="pill rd" style={{ height: 20 }}>{t("lab.desk.restricted")}</span>}
                </div>
                {(selected.patient.guardian != null || selected.patient.phoneLast4 != null) && (
                  <div style={{ fontSize: 12, color: "var(--dim)" }}>
                    {selected.patient.guardian != null && (selected.patient.guardian.relation === null
                      ? t("lab.desk.fatherHusband", { name: selected.patient.guardian.name })
                      : t("lab.desk.guardianOf", { name: selected.patient.guardian.name, relation: t(`lab.desk.relation.${selected.patient.guardian.relation}`, { defaultValue: selected.patient.guardian.relation }) }))}
                    {selected.patient.guardian != null && selected.patient.phoneLast4 != null && " · "}
                    {selected.patient.phoneLast4 != null && <span className="mo">••••{selected.patient.phoneLast4}</span>}
                  </div>
                )}
                {selected.visit !== null ? (
                  <div style={{ fontSize: 12.5, color: "var(--dim)" }}>
                    {t("lab.desk.visit")} <span className="mo" style={{ color: "var(--ink)", fontWeight: 600 }}>{selected.visit.encounterNo}</span>
                    {selected.visit.doctorName !== null && <> · {selected.visit.doctorName}</>}
                    {selected.visit.departmentName !== null && <>, {selected.visit.departmentName}</>}
                    {selected.visit.tokenNo !== null && <> · {t("lab.desk.token")} <span style={{ fontWeight: 700, color: "var(--ink)" }}>T-{selected.visit.tokenNo}</span></>}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--faint)" }}>{t("lab.desk.walkInNote")}</div>
                )}
                {selected.orders.length > 0 && (
                  <div style={{ fontSize: 12, color: "var(--dim)" }}>
                    {t("lab.desk.alreadyOnVisit")}: {selected.orders.map((o) => `${o.orderNo} (${String(o.itemCount)})`).join(", ")}
                  </div>
                )}
              </div>
              <button type="button" className="sec" style={{ height: 30, flexShrink: 0 }} onClick={nextPatient}>{t("lab.desk.flow.change")}</button>
            </div>

            <PatientSummary
              hit={selected}
              serviceDate={serviceDate}
              labFree={labFree}
              canOpenReports={can("lab.reports.print")}
              stepOpen={step}
              onWalkIn={() => { setPlaced(null); setStep("order"); }}
              onBook={() => { setPlaced(null); setBookedNote(null); setStep("book"); }}
              onOrderAdvised={() => { setPlaced(null); setStep("order"); }}
              onArrived={(b) => arrive.mutate(b)}
            />
            {bookedNote !== null && (
              <div className="pp box" role="status" style={{ padding: "12px 14px", borderColor: "var(--green)", color: "var(--green)", fontWeight: 600 }} data-testid="booked-note">
                ✓ {bookedNote}
              </div>
            )}
            {step === "book" && (
              <BookingPanel hit={selected} serviceDate={serviceDate}
                onClose={() => setStep("none")}
                onBooked={(message) => { setBookedNote(message); setStep("none"); }} />
            )}

            {step === "order" && (<>
            {!lines.some((l) => l.source === "advised") && (
            <>
            {/* ── which tests? — owner 2026-10-11: common tests as chips, then one search ── */}
            <TestChooser
              chosen={lines.map((l) => l.orderable.serviceId)}
              autoFocus={selected.visit === null || lines.length === 0}
              onAdd={(o) => touchLines((prev) => (prev.some((x) => x.orderable.serviceId === o.serviceId)
                ? prev
                : [...prev, { orderable: o, source: "added", onCredit: false, alreadyOrderedItemId: null }]))}
              onRemove={(id) => touchLines((prev) => prev.filter((x) => x.orderable.serviceId !== id || x.alreadyOrderedItemId !== null))}
            />
            </>
            )}
            {/* ── the basket — owner 2026-10-11: one card per test, in /counter's paper-and-pine ── */}
            <div className="pp" style={{ fontFamily: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', color: "var(--ink)", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h2 style={{ fontSize: 14, fontWeight: 700 }}>
                  {lines.some((l) => l.source === "advised") ? t("lab.desk.rxLines") : t("lab.desk.flow.chosenTests", { count: lines.length })}
                </h2>
                {/* The photographed slip, to check a typed test against the doctor's own hand. */}
                {selected.visit !== null && lines.some((l) => l.typedFromPaperBy != null) && (
                  <button type="button" className="sec" style={{ height: 26 }} data-testid="lab-see-slip" onClick={() => { setSlipOpen(true); }}>
                    {t("paper.slip.see")}
                  </button>
                )}
              </div>
              {selected.visit !== null && selected.visit.advised.some((a) => a.orderable === null) && (
                <p style={{ fontSize: 12 }}>{t("lab.desk.notInCatalogue")}: {selected.visit.advised.filter((a) => a.orderable === null).map((a) => a.code).join(", ")}</p>
              )}
              <ul style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="basket">
                {lines.map((l) => {
                  const line = priced?.lines.find((p) => p.serviceId === l.orderable.serviceId) ?? null;
                  const paramsOpen = openParams.includes(l.orderable.serviceId);
                  return (
                    <li key={l.orderable.serviceId} className="box" style={{ padding: "9px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <TubeDot container={l.orderable.container} />
                        <span style={{ flex: "1 1 180px", minWidth: 0 }}>
                          <span style={{ fontWeight: 600 }}>{l.orderable.code}</span>
                          <span style={{ color: "var(--dim)" }}> · {l.orderable.nameEn}</span>
                          {l.orderable.consentRequired && <span className="pill gd" style={{ height: 18, marginLeft: 6 }}>{t("lab.desk.consentTag")}</span>}
                          {l.orderable.sensitive && <span className="pill rd" style={{ height: 18, marginLeft: 6 }}>{t("lab.desk.sensitiveTag")}</span>}
                          {l.source === "advised" && l.typedFromPaperBy == null && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--faint)" }}>{t("lab.desk.fromRx")}</span>}
                          {/* Owner ruling 2026-10-06 (A) — typed from the doctor's paper: billable as it stands, and it says whose typing it is. */}
                          {l.source === "advised" && l.typedFromPaperBy != null && (
                            <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: "#9a6208" }} data-testid={`lab-typed-${l.orderable.code}`}>
                              {t("paper.typedBy", { name: l.typedFromPaperBy })}
                            </span>
                          )}
                        </span>
                        <button type="button" style={{ fontSize: 11.5, color: "var(--green)", textDecoration: "underline" }}
                          aria-expanded={paramsOpen}
                          aria-label={`${t("lab.desk.flow.parameters")} ${l.orderable.code}`}
                          onClick={() => setOpenParams((p) => (paramsOpen ? p.filter((x) => x !== l.orderable.serviceId) : [...p, l.orderable.serviceId]))}>
                          {t("lab.desk.flow.parameters")}
                        </button>
                        {l.alreadyOrderedItemId !== null ? (
                          <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("lab.desk.alreadyOrdered")}</span>
                        ) : !labFree && (
                          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                            <input type="checkbox" checked={!l.onCredit}
                              aria-label={`${t("lab.desk.billedHere")} ${l.orderable.code}`}
                              onChange={(e) => setLines((prev) => prev.map((x) => (
                                x.orderable.serviceId === l.orderable.serviceId ? { ...x, onCredit: !e.target.checked } : x
                              )))} />
                            <span>{l.onCredit ? t("lab.desk.onCredit") : t("lab.desk.billedHere")}</span>
                          </label>
                        )}
                        {!labFree && <span className="mo" style={{ fontSize: 12.5, minWidth: 64, textAlign: "right" }}>{line === null ? "—" : fmtPaise(line.netPaise)}</span>}
                        {l.alreadyOrderedItemId === null && (
                          <button type="button" className="sec" style={{ height: 28, padding: "0 10px" }}
                            aria-label={`${t("lab.desk.remove")} ${l.orderable.code}`}
                            onClick={() => touchLines((prev) => prev.filter((x) => x.orderable.serviceId !== l.orderable.serviceId))}>
                            ×
                          </button>
                        )}
                      </div>
                      {paramsOpen && <div style={{ paddingLeft: 20 }}><ParametersOf serviceId={l.orderable.serviceId} /></div>}
                      {l.orderable.consentRequired && l.alreadyOrderedItemId === null && (
                        <input
                          style={{ height: 34, maxWidth: 320 }}
                          placeholder={t("lab.desk.consentRecordedBy")}
                          aria-label={`${t("lab.desk.consentRecordedBy")} ${l.orderable.code}`}
                          value={consents[l.orderable.serviceId] ?? ""}
                          onChange={(e) => setConsents((c) => ({ ...c, [l.orderable.serviceId]: e.target.value }))}
                        />
                      )}
                    </li>
                  );
                })}
                {lines.length === 0 && (
                  <li className="box" style={{ padding: 14, textAlign: "center", color: "var(--faint)", borderStyle: "dashed" }}>{t("lab.desk.noLines")}</li>
                )}
              </ul>
            </div>

            {lines.some((l) => l.source === "advised") && (
            <>
            {/* ── which tests? — owner 2026-10-11: common tests as chips, then one search ── */}
            <TestChooser
              chosen={lines.map((l) => l.orderable.serviceId)}
              autoFocus={selected.visit === null || lines.length === 0}
              onAdd={(o) => touchLines((prev) => (prev.some((x) => x.orderable.serviceId === o.serviceId)
                ? prev
                : [...prev, { orderable: o, source: "added", onCredit: false, alreadyOrderedItemId: null }]))}
              onRemove={(id) => touchLines((prev) => prev.filter((x) => x.orderable.serviceId !== id || x.alreadyOrderedItemId !== null))}
            />
            </>
            )}

            {/* ── what Vikas will draw · decided from the tests ── */}
            {priced !== null && (
              <div className="rounded border border-border p-2 text-sm" data-testid="tube-plan">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("lab.desk.tubes")}</h2>
                <ul className="flex flex-wrap gap-3">
                  {priced.tubes.map((tube) => (
                    <li key={`${tube.container}-${tube.specimenType}`}>
                      <span className="font-medium">{tube.container}</span>
                      <span className="text-muted-foreground"> · {tube.codes.join(", ")}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("lab.desk.tubesNote", { count: priced.tubes.length })}
                </p>
              </div>
            )}

            {warnings !== null && warnings.length > 0 && (
              <section className="space-y-1 rounded border p-2 text-sm" style={{ borderColor: "var(--state-waiting)" }}>
                <h2 className="font-semibold">{t("lab.desk.duplicates")}</h2>
                <p className="text-xs text-muted-foreground">{t("lab.desk.duplicatesNote")}</p>
                {warnings.map((w) => (
                  <label key={w.duplicateOfItemId} className="flex items-start gap-2">
                    <input type="checkbox" checked={acknowledged.includes(w.duplicateOfItemId)}
                      onChange={(e) => setAcknowledged((a) => (
                        e.target.checked ? [...a, w.duplicateOfItemId] : a.filter((x) => x !== w.duplicateOfItemId)
                      ))} />
                    <span>{w.reason}</span>
                  </label>
                ))}
              </section>
            )}

            {/* ── priority · referred by · money ── */}
            <div className="grid gap-2 md:grid-cols-3">
              <label className="text-sm">
                {t("lab.desk.priority")}
                <select className="mt-1 w-full rounded border border-input px-2 py-1" value={priority}
                  onChange={(e) => setPriority(e.target.value as typeof priority)}>
                  <option value="routine">{t("lab.desk.routine")}</option>
                  <option value="urgent">{t("lab.desk.urgent")}</option>
                  <option value="stat">{t("lab.desk.stat")}</option>
                </select>
              </label>
              {selected.visit === null && (
                <label className="text-sm">
                  {t("lab.desk.referredBy")}
                  <input className="mt-1 w-full rounded border border-input px-2 py-1" value={referrerName}
                    onChange={(e) => setReferrerName(e.target.value)} />
                </label>
              )}
              {selected.visit === null && labDoctors.length > 1 && (
                <label className="text-sm">
                  {t("lab.desk.pathologistOfRecord")}
                  <select className="mt-1 w-full rounded border border-input px-2 py-1" value={walkInDoctorId}
                    aria-label={t("lab.desk.pathologistOfRecord")}
                    onChange={(e) => setWalkInDoctorId(e.target.value)}>
                    <option value="">—</option>
                    {labDoctors.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
                  </select>
                </label>
              )}
              {!labFree && <label className="text-sm">
                {t("lab.desk.tender")}
                <select className="mt-1 w-full rounded border border-input px-2 py-1" value={tender}
                  onChange={(e) => setTender(e.target.value as typeof tender)}>
                  <option value="cash">{t("lab.desk.cash")}</option>
                  <option value="card">{t("lab.desk.card")}</option>
                  <option value="upi">{t("lab.desk.upi")}</option>
                </select>
              </label>}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={reflexConsent} onChange={(e) => setReflexConsent(e.target.checked)} />
              {t("lab.desk.reflexConsent")}
            </label>

            {priced !== null && (
              <div className="rounded border border-border bg-card p-2 text-sm" data-testid="money">
                <p><span className="font-semibold">{t("lab.desk.collectNow")}:</span> {fmtPaise(paidPaise)}</p>
                {anyCredit && (
                  <p>
                    <span className="font-semibold">{t("lab.desk.onCreditTotal")}:</span> {fmtPaise(creditPaise)}
                    <span className="text-xs text-muted-foreground"> — {t("lab.desk.billLaterNote")}</span>
                  </p>
                )}
              </div>
            )}

            {labFree ? (
              <div className="pp" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <button type="button" className="pri" style={{ height: 50, fontSize: 15 }} data-testid="send-free"
                  disabled={
                    orderableLines.length === 0 || missingConsent.length > 0 || sendFree.isPending || place.isPending
                    || (selected.visit === null && labDoctors.length > 1 && walkInDoctorId === "")
                  }
                  onClick={() => sendFree.mutate()}>
                  {t("lab.desk.flow.sendToCollection", { count: orderableLines.length })}
                </button>
                <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("lab.desk.flow.freeNote")}</span>
              </div>
            ) : (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={orderableLines.length === 0 || check.isPending} onClick={() => check.mutate()}>
                {t("lab.desk.checkDuplicates")}
              </Button>
              <Button
                type="button"
                disabled={
                  orderableLines.length === 0 || missingConsent.length > 0 || unacknowledged.length > 0
                  /** Taking money needs a PRICE, and the price is the server's. */
                  || priced === null || place.isPending || check.isPending
                  /** Two pathologists: the walk-in names one (F6). */
                  || (selected.visit === null && labDoctors.length > 1 && walkInDoctorId === "")
                }
                onClick={() => place.mutate()}
              >
                {t("lab.desk.save")}
              </Button>
            </div>
            )}
            {missingConsent.length > 0 && (
              <p className="text-sm font-semibold">
                {t("lab.desk.consentNeeded")}: {missingConsent.map((l) => l.orderable.code).join(", ")}
              </p>
            )}
            </>)}
          </div>
        )}

        {error !== null && <p role="alert" className="text-sm font-semibold">{error}</p>}
        {placed !== null && (
          <section className="pp box" data-testid="placed"
            style={{ fontFamily: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', color: "var(--ink)", padding: "16px 18px", borderColor: "var(--green)", boxShadow: "0 0 0 3px var(--green-soft)", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "var(--green)" }}>✓ {t("lab.desk.placed")}: <span className="mo">{placed.orderNo}</span></div>
            <div style={{ fontSize: 13 }}>{t("lab.desk.visit")}: <span className="mo" style={{ fontWeight: 600 }}>{placed.encounterNo}</span>
              {placed.invoice.netPayablePaise > 0 && <> · {t("lab.desk.invoice")}: {placed.invoice.invoiceNo}</>}
              {placed.invoice.netPayablePaise === 0 && <> · {t("lab.desk.flow.noCharge")}</>}
              {(placed.invoice.creditExtended || placedWithBalance.current) && <> · {t("lab.desk.creditExtended")}</>}</div>
            <div style={{ fontSize: 13, color: "var(--dim)" }}>{t("lab.desk.sentToCollection")}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <button type="button" className="pri" onClick={nextPatient}>{t("lab.desk.flow.nextPatient")}</button>
              {selected !== null && <button type="button" className="sec" onClick={() => { setPlaced(null); setStep("none"); }}>{t("lab.desk.flow.backToPatient")}</button>}
            </div>
          </section>
        )}
      </section>
      {slipOpen && selected !== null && selected.visit !== null && (
        <PaperSlipSheet patientId={selected.patient.id} encounterId={selected.visit.encounterId} onClose={() => { setSlipOpen(false); }} />
      )}
    </LabStation>
  );
}
