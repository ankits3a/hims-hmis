import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, newIdempotencyKey } from "../lib/api";
import { fmtPaise } from "../lib/format";
import {
  collectionQueue, deskFind, duplicateWarnings, istToday, labErrorText, placeLabOrder, previewLabOrder,
  searchOrderables,
} from "../lib/lab-api";
import { Button } from "@/components/ui/button";
import { useAuth } from "../lib/auth";
import { LabSeatFrame, sexAge } from "./lab-seat";
import type {
  DeskOrderRequest, WireDeskFindHit, WireDeskOrder, WireDuplicateWarning, WireLabDoctor, WireOrderable, WirePricedDraft,
} from "../lib/lab-api";

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
type Line = { orderable: WireOrderable; source: LineSource; onCredit: boolean; alreadyOrderedItemId: string | null };

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

  /* ── the order ── */
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
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
  const catalogue = useQuery({
    queryKey: ["lab", "catalogue", query],
    queryFn: () => searchOrderables(query),
    enabled: query.trim().length >= 2,
  });

  const find = useMutation({
    mutationFn: () => deskFind(q, serviceDate),
    onSuccess: (r) => {
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

  function choose(hit: WireDeskFindHit): void {
    setSelected(hit);
    setRegistering(false);
    setWalkInDoctorId(""); // pass 2 NEW-4 — a decision the server refuses to make is not carried to the next patient
    resetOrder();
    const advised: Line[] = [];
    for (const a of hit.visit?.advised ?? []) {
      const orderable = advisedToOrderable(a);
      if (orderable === null) continue;
      advised.push({ orderable, source: "advised", onCredit: false, alreadyOrderedItemId: a.alreadyOrderedItemId });
    }
    setLines(advised);
    setReferrerName(hit.visit?.referrerName ?? "");
  }

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
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const place = useMutation({
    mutationFn: () => {
      if (selected === null) throw new Error("no patient");
      const money = moneyBlockFor(priced, orderableLines, tender, t("lab.desk.creditReason"));
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

  return (
    <LabSeatFrame
      title={t("lab.desk.title")}
      place={t("lab.desk.place")}
      stats={[
        { label: t("lab.desk.arrivedToday"), value: waiting, tone: "live" },
      ]}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {/* ── arrived on the portal · no typing needed ── */}
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

        {/* ── walk-in with a slip · one field, three doors ── */}
        <section className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); if (q.trim() !== "") find.mutate(); }}
          >
            <label className="flex-1 text-sm">
              <span className="sr-only">{t("lab.desk.find")}</span>
              <input
                ref={fieldRef}
                className="w-full rounded border border-input bg-card px-3 py-2 text-base"
                placeholder={t("lab.desk.findPlaceholder")}
                aria-label={t("lab.desk.find")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <Button type="submit" disabled={find.isPending || q.trim() === ""}>{t("lab.desk.findGo")}</Button>
          </form>

          {hits !== null && selected === null && (
            <div className="space-y-1">
              {hits.length === 0 && (
                <p className="text-sm">
                  {t("lab.desk.noHit")}{" "}
                  <button type="button" className="underline" onClick={() => setRegistering(true)}>
                    {t("lab.desk.registerNew")}
                  </button>
                </p>
              )}
              {hits.length > 1 && <p className="text-xs text-muted-foreground">{t("lab.desk.confirmByName")}</p>}
              <ul className="divide-y divide-border rounded border border-border text-sm">
                {hits.map((h) => (
                  <li key={`${h.patient.id}-${h.visit?.encounterId ?? "none"}`}>
                    <button type="button" className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-muted"
                      onClick={() => choose(h)}>
                      <span>
                        <span className="font-medium">{h.patient.display}</span>
                        <span className="text-muted-foreground"> · {sexAge(h.patient.administrativeGender, h.patient.dob)} · {h.patient.uhid}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {h.visit === null ? t("lab.desk.noVisitToday")
                          : `${h.visit.encounterNo}${h.visit.tokenNo === null ? "" : ` · T-${String(h.visit.tokenNo)}`}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

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
                <Button type="submit" disabled={fields.name.trim() === "" || register.isPending}>{t("lab.desk.regSave")}</Button>
                <Button type="button" variant="outline" onClick={() => setRegistering(false)}>{t("lab.desk.cancel")}</Button>
              </div>
            </form>
          )}

          {selected !== null && (
            <div className="space-y-3">
              {/* ── the patient, confirmed ── */}
              <div className="rounded border border-border bg-card p-3 text-sm" data-testid="patient-card">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-lg font-semibold">{selected.patient.display}</span>
                  <span>{sexAge(selected.patient.administrativeGender, selected.patient.dob)}</span>
                  <span className="text-muted-foreground">{selected.patient.uhid}</span>
                  {selected.patient.restricted && <span className="font-semibold">{t("lab.desk.restricted")}</span>}
                </div>
                {selected.visit !== null ? (
                  <p className="text-muted-foreground">
                    {t("lab.desk.visit")} {selected.visit.encounterNo}
                    {selected.visit.doctorName !== null && <> · {selected.visit.doctorName}</>}
                    {selected.visit.departmentName !== null && <>, {selected.visit.departmentName}</>}
                    {selected.visit.tokenNo !== null && <> · {t("lab.desk.token")} <span className="font-semibold text-foreground">T-{selected.visit.tokenNo}</span></>}
                  </p>
                ) : (
                  <p className="text-muted-foreground">{t("lab.desk.walkInNote")}</p>
                )}
                {selected.orders.length > 0 && (
                  <p className="text-muted-foreground">
                    {t("lab.desk.alreadyOnVisit")}: {selected.orders.map((o) => `${o.orderNo} (${String(o.itemCount)})`).join(", ")}
                  </p>
                )}
              </div>

              {/* ── tests on the prescription ── */}
              <div className="space-y-1">
                <h2 className="text-sm font-semibold">{t("lab.desk.rxLines")}</h2>
                {selected.visit !== null && selected.visit.advised.some((a) => a.orderable === null) && (
                  <p className="text-xs">{t("lab.desk.notInCatalogue")}: {selected.visit.advised.filter((a) => a.orderable === null).map((a) => a.code).join(", ")}</p>
                )}
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1">{t("lab.desk.test")}</th>
                      <th>{t("lab.desk.tube")}</th>
                      <th>{t("lab.desk.onSlip")}</th>
                      <th className="text-right">{t("lab.desk.price")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const line = priced?.lines.find((p) => p.serviceId === l.orderable.serviceId) ?? null;
                      return (
                        <tr key={l.orderable.serviceId} className="border-t border-border">
                          <td className="py-1">
                            <span className="font-medium">{l.orderable.code}</span> · {l.orderable.nameEn}
                            {l.orderable.consentRequired && <span className="ml-1 font-semibold">{t("lab.desk.consentTag")}</span>}
                            {l.orderable.sensitive && <span className="ml-1 font-semibold">{t("lab.desk.sensitiveTag")}</span>}
                            {l.source === "advised" && <span className="ml-1 text-xs text-muted-foreground">{t("lab.desk.fromRx")}</span>}
                            {l.orderable.consentRequired && l.alreadyOrderedItemId === null && (
                              <input
                                className="ml-2 rounded border border-input px-2 py-0.5"
                                placeholder={t("lab.desk.consentRecordedBy")}
                                aria-label={`${t("lab.desk.consentRecordedBy")} ${l.orderable.code}`}
                                value={consents[l.orderable.serviceId] ?? ""}
                                onChange={(e) => setConsents((c) => ({ ...c, [l.orderable.serviceId]: e.target.value }))}
                              />
                            )}
                          </td>
                          <td className="text-muted-foreground">{l.orderable.container}</td>
                          <td>
                            {l.alreadyOrderedItemId !== null ? (
                              <span className="text-xs">{t("lab.desk.alreadyOrdered")}</span>
                            ) : (
                              <label className="flex items-center gap-1">
                                <input type="checkbox" checked={!l.onCredit}
                                  aria-label={`${t("lab.desk.billedHere")} ${l.orderable.code}`}
                                  onChange={(e) => setLines((prev) => prev.map((x) => (
                                    x.orderable.serviceId === l.orderable.serviceId ? { ...x, onCredit: !e.target.checked } : x
                                  )))} />
                                <span>{l.onCredit ? t("lab.desk.onCredit") : t("lab.desk.billedHere")}</span>
                              </label>
                            )}
                          </td>
                          <td className="text-right tabular-nums">{line === null ? "—" : fmtPaise(line.netPaise)}</td>
                          <td className="text-right">
                            {l.alreadyOrderedItemId === null && (
                              <button type="button" className="text-xs underline"
                                aria-label={`${t("lab.desk.remove")} ${l.orderable.code}`}
                                onClick={() => touchLines((prev) => prev.filter((x) => x.orderable.serviceId !== l.orderable.serviceId))}>
                                {t("lab.desk.remove")}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {lines.length === 0 && (
                      <tr><td colSpan={5} className="py-2 text-muted-foreground">{t("lab.desk.noLines")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* ── add from the catalogue ── */}
              <div className="space-y-1">
                <label className="text-sm">
                  {t("lab.desk.search")}
                  <input className="mt-1 w-full rounded border border-input px-2 py-1" value={query}
                    onChange={(e) => setQuery(e.target.value)} />
                </label>
                {catalogue.data !== undefined && catalogue.data.length > 0 && (
                  <ul className="max-h-40 space-y-1 overflow-auto text-sm">
                    {catalogue.data.slice(0, 12).map((o) => (
                      <li key={o.serviceId} className="flex items-center justify-between gap-2">
                        <span>
                          {o.code} · {o.nameEn}
                          {o.consentRequired && <span className="ml-1 font-semibold">{t("lab.desk.consentTag")}</span>}
                          {o.sensitive && <span className="ml-1 font-semibold">{t("lab.desk.sensitiveTag")}</span>}
                        </span>
                        <Button type="button" size="sm" variant="outline" onClick={() => {
                          touchLines((prev) => (prev.some((x) => x.orderable.serviceId === o.serviceId)
                            ? prev
                            : [...prev, { orderable: o, source: "added", onCredit: false, alreadyOrderedItemId: null }]));
                          setQuery("");
                        }}>{t("lab.desk.add")}</Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

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
                <label className="text-sm">
                  {t("lab.desk.tender")}
                  <select className="mt-1 w-full rounded border border-input px-2 py-1" value={tender}
                    onChange={(e) => setTender(e.target.value as typeof tender)}>
                    <option value="cash">{t("lab.desk.cash")}</option>
                    <option value="card">{t("lab.desk.card")}</option>
                    <option value="upi">{t("lab.desk.upi")}</option>
                  </select>
                </label>
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
              {missingConsent.length > 0 && (
                <p className="text-sm font-semibold">
                  {t("lab.desk.consentNeeded")}: {missingConsent.map((l) => l.orderable.code).join(", ")}
                </p>
              )}
            </div>
          )}

          {error !== null && <p role="alert" className="text-sm font-semibold">{error}</p>}
          {placed !== null && (
            <section className="space-y-1 rounded border border-border bg-card p-3 text-sm" data-testid="placed">
              <p className="font-semibold">{t("lab.desk.placed")}: {placed.orderNo}</p>
              <p>{t("lab.desk.visit")}: {placed.encounterNo} · {t("lab.desk.invoice")}: {placed.invoice.invoiceNo}
                {placed.invoice.creditExtended && <> · {t("lab.desk.creditExtended")}</>}</p>
              <p className="text-muted-foreground">{t("lab.desk.sentToCollection")}</p>
            </section>
          )}
        </section>
      </div>
    </LabSeatFrame>
  );
}
