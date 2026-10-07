import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type React from "react";
import { ApiError } from "../../lib/api";
import { fmtIst, fmtPaise } from "../../lib/format";
import { placeImagingOrder, radiologyErrorText } from "../../lib/radiology-api";
import type {
  PlaceImagingOrderBody, WireImagingDoor, WireImagingOrderable, WireImagingVisitOrder,
} from "../../lib/radiology-api";

/**
 * PLAN 18-S RS2 — **THE ORDERING DOOR'S PARTS, shared by the consult and the imaging desk.**
 *
 * One study card, one "what happened to it" list, one plain-words refusal. The two seats differ in
 * who they are (the consult's doctor sends; the desk places, and also takes outside slips), not in
 * what an imaging order needs — so the card is written once.
 *
 * ═══ WHAT THE CARD NEVER DOES ═══
 *
 *   · It never fills the indication (18a-iv D4): a CT with no stated question is a dose nobody can
 *     justify, and defaulting it to the diagnosis would be inventing a justification.
 *   · It never decides a gate. Contrast, pregnancy and PCPNDT are shown as what WILL be checked,
 *     from the book's own flags; the server's gates decide at the console.
 *   · It never bills. Nothing is billed until the desk books (18-S RS2 DECIDED; D2's harm cannot
 *     happen because nothing bills before the desk).
 */

export type Side = "" | "right" | "left" | "both";
export type Priority = "routine" | "urgent" | "stat";

/** The side is carried IN the indication: the order envelope has no side column, and the
 *  `laterality_confirm` gate confirms it against the patient at the console. English on purpose —
 *  the order is a clinical record, not a screen string. */
const SIDE_WORDS: Record<Exclude<Side, "">, string> = { right: "Right", left: "Left", both: "Both sides" };

export function composeIndication(side: Side, question: string): string {
  const q = question.trim();
  return side === "" ? q : `${SIDE_WORDS[side]} — ${q}`;
}

/** A 22c-A zod 400 carries an ARRAY of issues as `message`; everything else is the server's sentence. */
export function orderRefusalText(e: unknown, forbidden: string): string {
  if (e instanceof ApiError && e.status === 403) return forbidden;
  const body = (e as { body?: { message?: unknown } } | undefined)?.body;
  if (Array.isArray(body?.message)) {
    return body.message.map((i: { message?: string }) => i.message ?? "").filter((x) => x !== "").join("; ");
  }
  return radiologyErrorText(e);
}

function duplicateOf(e: unknown): { orderNos: string[]; itemIds: string[] } | null {
  const body = (e as { body?: { code?: string; detail?: { recentOrderNos?: string[]; recentItemIds?: string[] } } } | undefined)?.body;
  if (body?.code !== "duplicate_recent") return null;
  return { orderNos: body.detail?.recentOrderNos ?? [], itemIds: body.detail?.recentItemIds ?? [] };
}

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The IST calendar day, through `Asia/Kolkata` — the same formatter `lab-api.ts`'s `istToday` uses. */
export function istToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

/** `DD Mon HH:MM` in IST, by the same fixed +05:30 arithmetic `fmtIst` uses — a scan eight days ago
 *  must not read as "10:30". */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtIstDayTime(iso: string): string {
  const d = new Date(Date.parse(iso) + 330 * 60_000);
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? ""} ${fmtIst(iso)}`;
}

/* ── the study card ─────────────────────────────────────────────────────────────────────────── */

export type StudyCardProps = {
  view: WireImagingDoor;
  serviceId: string;
  name: string;
  pricePaise: number | null;
  orderable: WireImagingOrderable;
  /** Who answers for the scan — the consult's doctor, or the visit's doctor at the desk. */
  clinicianUserId: string | null;
  /** The walk-in leg: an outside slip, placed under `external_prescription` with its referrer. */
  outside?: boolean;
  sendLabel: string;
  onPlaced: (orderNo: string) => void;
  onRemove?: () => void;
};

export function StudyCard(p: StudyCardProps): React.ReactElement {
  const { t } = useTranslation();
  const [question, setQuestion] = useState("");
  const [side, setSide] = useState<Side>("");
  const [priority, setPriority] = useState<Priority>("routine");
  const [reason, setReason] = useState("");
  const [refName, setRefName] = useState("");
  const [refReg, setRefReg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refusedDup, setRefusedDup] = useState<{ orderNos: string[]; itemIds: string[] } | null>(null);
  /** One key per attempt at THIS card: a double click replays, a changed card is a new attempt. */
  const [idemKey, setIdemKey] = useState(newKey);

  /** The board's 30-day look-back — the server's list never names a restricted scan. */
  const recent = p.view.recent[p.serviceId] ?? [];
  const dupItemId = refusedDup?.itemIds[0] ?? recent[0]?.itemId ?? null;
  const needsReason = dupItemId !== null;

  const send = useMutation({
    mutationFn: async () => {
      const body: PlaceImagingOrderBody = {
        patientId: p.view.visit.patient.id,
        encounterNo: p.view.visit.encounterNo,
        serviceDate: istToday(),
        orderingClinicianId: p.clinicianUserId ?? "",
        priority,
        indication: composeIndication(side, question),
        items: [{
          serviceId: p.serviceId,
          ...(needsReason ? { duplicateOfItemId: dupItemId, duplicateReason: reason.trim() } : {}),
        }],
        ...(p.outside === true
          ? { authority: "external_prescription" as const, referrer: { name: refName.trim(), registrationNo: refReg.trim() } }
          : {}),
      };
      return await placeImagingOrder(body, idemKey);
    },
    onSuccess: (r) => { setError(null); p.onPlaced(r.orderNo); },
    onError: (e) => {
      const dup = duplicateOf(e);
      if (dup !== null && dup.itemIds.length > 0) setRefusedDup(dup);
      setError(orderRefusalText(e, t("imagingOrder.forbidden")));
      setIdemKey(newKey());
    },
  });

  const submit = (): void => {
    if (p.clinicianUserId === null) { setError(t("imagingOrder.noDoctor")); return; }
    if (question.trim() === "") { setError(t("imagingOrder.indicationRequired")); return; }
    if (p.orderable.lateralityApplicable && side === "") { setError(t("imagingOrder.sideRequired")); return; }
    if (needsReason && reason.trim() === "") { setError(t("imagingOrder.reasonRequired")); return; }
    if (p.outside === true && (refName.trim() === "" || refReg.trim() === "")) {
      setError(t("imagingOrder.outside.referrerRequired")); return;
    }
    setError(null);
    send.mutate();
  };

  const fieldId = (f: string) => `imaging-${f}-${p.serviceId}${p.outside === true ? "-out" : ""}`;
  const o = p.orderable;

  return (
    <div
      data-testid={`imaging-card-${p.serviceId}${p.outside === true ? "-out" : ""}`}
      className="rounded border bg-card p-3 text-sm space-y-2"
      style={{ minWidth: 0 }}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <b style={{ overflowWrap: "anywhere" }}>{p.name}</b>
        <span className="mo text-xs text-muted-foreground">
          {p.pricePaise === null ? t("imagingOrder.noPrice") : fmtPaise(p.pricePaise)}
        </span>
        {p.onRemove !== undefined && (
          <button type="button" className="ml-auto text-xs underline" onClick={p.onRemove}>{t("imagingOrder.remove")}</button>
        )}
      </div>

      {(o.contrast !== "none" || o.pcpndtApplicable || o.ionising) && (
        <ul className="text-xs text-muted-foreground space-y-0.5" data-testid={fieldId("flags")}>
          {o.contrast !== "none" && <li>{t("imagingOrder.flag.contrast")}</li>}
          {o.pcpndtApplicable && <li>{t("imagingOrder.flag.pcpndt")}</li>}
          {o.ionising && <li>{t("imagingOrder.flag.ionising")}</li>}
        </ul>
      )}

      <label className="flex flex-col gap-1" htmlFor={fieldId("q")}>
        <span className="text-xs font-medium">{t("imagingOrder.indication")}</span>
        <input
          id={fieldId("q")} className="border rounded px-2 py-1 w-full" value={question}
          placeholder={t("imagingOrder.indicationHint")}
          onChange={(e) => { setQuestion(e.target.value); }}
        />
      </label>

      <div className="flex flex-wrap gap-3 items-end">
        {o.lateralityApplicable && (
          <fieldset className="flex flex-wrap gap-2 items-center" data-testid={fieldId("side")}>
            <legend className="text-xs font-medium">{t("imagingOrder.side")}</legend>
            {(["right", "left", "both"] as const).map((s) => (
              <label key={s} className="flex items-center gap-1 text-xs">
                <input type="radio" name={fieldId("side")} checked={side === s} onChange={() => { setSide(s); }} />
                {t(`imagingOrder.sides.${s}`)}
              </label>
            ))}
          </fieldset>
        )}
        <label className="flex flex-col gap-1 text-xs" htmlFor={fieldId("prio")}>
          <span className="font-medium">{t("imagingOrder.priority")}</span>
          <select
            id={fieldId("prio")} className="border rounded px-2 py-1" value={priority}
            onChange={(e) => { setPriority(e.target.value as Priority); }}
          >
            <option value="routine">{t("imagingOrder.priorities.routine")}</option>
            <option value="urgent">{t("imagingOrder.priorities.urgent")}</option>
            <option value="stat">{t("imagingOrder.priorities.stat")}</option>
          </select>
        </label>
      </div>

      {p.outside === true && (
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-1 text-xs flex-1" style={{ minWidth: 140 }} htmlFor={fieldId("ref")}>
            <span className="font-medium">{t("imagingOrder.outside.referrerName")}</span>
            <input id={fieldId("ref")} className="border rounded px-2 py-1" value={refName} onChange={(e) => { setRefName(e.target.value); }} />
          </label>
          <label className="flex flex-col gap-1 text-xs flex-1" style={{ minWidth: 120 }} htmlFor={fieldId("reg")}>
            <span className="font-medium">{t("imagingOrder.outside.referrerReg")}</span>
            <input id={fieldId("reg")} className="border rounded px-2 py-1" value={refReg} onChange={(e) => { setRefReg(e.target.value); }} />
          </label>
        </div>
      )}

      {needsReason && (
        <div role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs space-y-1" data-testid={fieldId("dup")}>
          <p>
            {refusedDup !== null
              ? t("imagingOrder.duplicateRefused", { orderNos: refusedDup.orderNos.join(", ") })
              : t("imagingOrder.duplicate", { orderNo: recent[0]!.orderNo, when: fmtIstDayTime(recent[0]!.placedAt) })}
          </p>
          <label className="flex flex-col gap-1" htmlFor={fieldId("why")}>
            <span className="font-medium">{t("imagingOrder.duplicateReason")}</span>
            <input id={fieldId("why")} className="border rounded px-2 py-1 bg-white" value={reason} onChange={(e) => { setReason(e.target.value); }} />
          </label>
        </div>
      )}

      {error !== null && <p role="alert" className="text-red-700 text-xs">{error}</p>}

      <button
        type="button" className="pri rounded px-3 py-1 text-sm disabled:opacity-60"
        style={{ background: "var(--green, #0e6e50)", color: "#fff", border: 0, alignSelf: "flex-start" }}
        disabled={send.isPending} onClick={submit}
      >
        {send.isPending ? t("imagingOrder.sending") : p.sendLabel}
      </button>
    </div>
  );
}

/* ── what happened to it ────────────────────────────────────────────────────────────────────── */

export function studyStateText(
  t: (k: string, o?: Record<string, unknown>) => string,
  item: WireImagingVisitOrder["items"][number],
): string {
  if (item.status === "cancelled") return t("imagingOrder.state.cancelled");
  const s = item.study;
  if (s === null) return t("imagingOrder.state.sent");
  switch (s.status) {
    case "scheduled":
      return s.scheduledAt === null ? t("imagingOrder.state.toBook") : t("imagingOrder.state.booked", { when: fmtIstDayTime(s.scheduledAt) });
    case "checked_in": case "ready": return t("imagingOrder.state.arrived");
    case "in_acquisition": return t("imagingOrder.state.scanning");
    case "acquired": return t("imagingOrder.state.acquired");
    case "reported": return t("imagingOrder.state.reported");
    case "published": return t("imagingOrder.state.published");
    case "cancelled": return t("imagingOrder.state.cancelled");
    case "no_show": return t("imagingOrder.state.noShow");
    case "rescheduled": return t("imagingOrder.state.rescheduled");
    default: return s.status;
  }
}

export function VisitOrders({ orders }: { orders: WireImagingVisitOrder[] }): React.ReactElement | null {
  const { t } = useTranslation();
  if (orders.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="imaging-visit-orders">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("imagingOrder.ordersHeading")}</h3>
      <ul className="space-y-1 text-sm">
        {orders.flatMap((o) => o.items.map((i) => (
          <li key={i.itemId} className="flex flex-wrap gap-x-2 border-b py-1" data-testid={`imaging-order-${o.orderNo}`}>
            <span style={{ overflowWrap: "anywhere" }}>{i.serviceName}</span>
            <span className="mo text-xs text-muted-foreground">{o.orderNo}{o.priority !== "routine" ? ` · ${t(`imagingOrder.priorities.${o.priority}`)}` : ""}</span>
            <span className="ml-auto text-xs font-medium">{studyStateText(t, i)}</span>
          </li>
        )))}
      </ul>
    </div>
  );
}

/* ── the door body: advised lines, greyed lines, search, cards ──────────────────────────────── */

export type ImagingDoorBodyProps = {
  view: WireImagingDoor;
  clinicianUserId: string | null;
  sendLabel: string;
  onPlaced: (orderNo: string) => void;
  /** The desk's walk-in leg: search-added studies are outside slips. */
  outside?: boolean;
  /** Hide the advised lines (the desk's walk-in section reuses the search alone). */
  searchOnly?: boolean;
  /**
   * Hide the search. The desk's visit leg shows the doctor's advised lines ONLY: a study the doctor
   * did not advise is placed at the desk as an outside slip, never under the visit doctor's name.
   */
  advisedOnly?: boolean;
};

export function ImagingDoorBody(p: ImagingDoorBodyProps): React.ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const advisedIds = useMemo(() => new Set(p.view.lines.map((l) => l.serviceId)), [p.view.lines]);
  const bookBy = useMemo(() => new Map(p.view.book.map((b) => [b.serviceId, b])), [p.view.book]);

  const q = query.trim().toLowerCase();
  const matches = q.length < 2 ? [] : p.view.book.filter((b) =>
    !added.includes(b.serviceId) && (p.outside === true || !advisedIds.has(b.serviceId))
    && (b.studyTypeName.toLowerCase().includes(q) || b.studyTypeCode.toLowerCase().includes(q) || b.modality.toLowerCase().includes(q)),
  ).slice(0, 8);

  const placed = (serviceId: string) => (orderNo: string): void => {
    setAdded((a) => a.filter((x) => x !== serviceId));
    p.onPlaced(orderNo);
  };

  return (
    <div className="space-y-3">
      {!p.view.bookActive && <p role="status" className="text-xs text-red-700">{t("imagingOrder.noBook")}</p>}

      {p.searchOnly !== true && (
        p.view.lines.length === 0
          ? <p className="text-xs text-muted-foreground">{t("imagingOrder.noAdvised")}</p>
          : (
            <div className="space-y-2" data-testid="imaging-advised">
              {p.view.lines.map((l) => {
                if (l.orderable === null) {
                  return (
                    <div key={l.serviceId} data-testid={`imaging-line-${l.serviceId}`} aria-disabled="true"
                      className="rounded border border-dashed p-2 text-sm opacity-60">
                      <b>{l.name}</b> <span className="text-xs">— {t("imagingOrder.notOrderable")}</span>
                      <p className="text-xs">{l.reason}</p>
                    </div>
                  );
                }
                if (l.alreadyOrderedItemId !== null) {
                  return (
                    <div key={l.serviceId} data-testid={`imaging-line-${l.serviceId}`} className="rounded border p-2 text-sm flex flex-wrap gap-2">
                      <b>{l.name}</b>
                      <span className="text-xs text-muted-foreground">{t("imagingOrder.alreadyOrdered", { orderNo: l.alreadyOrderedOrderNo ?? "" })}</span>
                    </div>
                  );
                }
                return (
                  <div key={l.serviceId}>
                  {l.typedFromPaperBy != null && (
                    <p className="text-xs font-semibold" style={{ color: "#9a6208", margin: "0 0 2px" }} data-testid={`imaging-typed-${l.serviceId}`}>
                      {t("paper.typedBy", { name: l.typedFromPaperBy })}
                    </p>
                  )}
                  <StudyCard
                    view={p.view} serviceId={l.serviceId} name={l.name}
                    pricePaise={bookBy.get(l.serviceId)?.pricePaise ?? l.pricePaise}
                    orderable={l.orderable} clinicianUserId={p.clinicianUserId}
                    sendLabel={p.sendLabel} onPlaced={p.onPlaced}
                  />
                  </div>
                );
              })}
            </div>
          )
      )}

      {p.view.bookActive && p.advisedOnly !== true && (
        <div className="space-y-2">
          <label className="flex flex-col gap-1 text-xs" htmlFor={`imaging-search${p.outside === true ? "-out" : ""}`}>
            <span className="font-medium">{t("imagingOrder.add")}</span>
            <input
              id={`imaging-search${p.outside === true ? "-out" : ""}`} className="border rounded px-2 py-1 text-sm w-full"
              placeholder={t("imagingOrder.addPlaceholder")} value={query}
              onChange={(e) => { setQuery(e.target.value); }}
            />
          </label>
          {matches.length > 0 && (
            <ul className="space-y-1" data-testid="imaging-matches">
              {matches.map((b) => (
                <li key={b.serviceId}>
                  <button
                    type="button" className="w-full text-left rounded border px-2 py-1 text-sm hover:bg-muted"
                    onClick={() => { setAdded((a) => [...a, b.serviceId]); setQuery(""); }}
                  >
                    {b.studyTypeName} — {b.pricePaise === null ? t("imagingOrder.noPrice") : fmtPaise(b.pricePaise)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {q.length >= 2 && matches.length === 0 && <p className="text-xs text-muted-foreground">{t("imagingOrder.noMatch")}</p>}
          {added.map((id) => {
            const b = bookBy.get(id);
            if (b === undefined) return null;
            return (
              <StudyCard
                key={id} view={p.view} serviceId={id} name={b.studyTypeName} pricePaise={b.pricePaise}
                orderable={b} clinicianUserId={p.clinicianUserId} outside={p.outside}
                sendLabel={p.sendLabel} onPlaced={placed(id)}
                onRemove={() => { setAdded((a) => a.filter((x) => x !== id)); }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
