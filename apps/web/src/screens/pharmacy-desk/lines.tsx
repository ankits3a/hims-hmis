import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { askPrescriber, fetchPrecheck, pharmacyErrorText, setShelfLocation } from "../../lib/pharmacy-api";
import { quoteAmountPaise } from "../../lib/pharmacy-bill";
import { ResolveSheet } from "./resolve";
import { CopilotOffer, firstLineNeedingHelp } from "./copilot";

const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
import { SubstituteSheet } from "./substitute";
import { BatchChip, BatchSheet } from "./batch";
import { adviceFor, allSettled, blockedFor, canTick, freshTick, isPartial, isSettled, istToday, packOf, pickBody, placeable, qtyLabels, qtyOf, routeScan, saltLabel, sigOf, substitutable, verifyBody } from "./work";
import type { Tick } from "./work";
import type { PickLine, VerifyLine, WireAlternativeBlock, WireDispense, WireDispenseLine, WireLinePrecheck } from "../../lib/pharmacy-api";

/**
 * PD-4 — THE LINE LIST (PD-D2, PD-D3, PD-D4; E7–E12). Two columns per line, WHAT THE DOCTOR WROTE →
 * WHAT YOU ARE GIVING, a tick that settles the line, and the rules in `work.ts`: the tick or decline
 * that settles the LAST line fires verify then pick, and a refusal lands on the line it names.
 *
 * A SCAN IS A TICK. The pack's code goes into the line's scan field (a wedge types it and presses
 * ⏎); the server checks it at the pick — the wrong item and a batch this store never received are
 * refused there, on this line (E10, E11) — and the line is ticked by the act of scanning it.
 */
export type CollectResult = { ok: true } | { ok: false; lineErrors: Record<number, string>; message: string | null };

export function LineList({
  dispense, editable, busy, onCollect, onDecline,
}: {
  dispense: WireDispense;
  /** Claimed or verified, and this desk's to work. Everything else is drawn, not worked. */
  editable: boolean;
  busy: boolean;
  onCollect: (verify: VerifyLine[] | null, pick: PickLine[]) => Promise<CollectResult>;
  onDecline: (lineIdx: number, reason: string) => Promise<boolean>;
}): React.ReactElement {
  const { t } = useTranslation();
  const [ticks, setTicks] = useState<Record<number, Tick>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [declining, setDeclining] = useState<number | null>(null);
  const [subbing, setSubbing] = useState<number | null>(null);
  /** The medicine the co-pilot named, carried into the sheet so its offer is one tap and a consent. */
  const [offered, setOffered] = useState<string | null>(null);
  const [resolving, setResolving] = useState<number | null>(null);
  /* The FEFO batch & shelf sheet (`B`), and the line the pharmacist is on — B opens there. */
  const [batchFor, setBatchFor] = useState<number | null>(null);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const settleAfterDecline = useRef(false);
  const today = istToday();
  /* PD-D18 — whoever manages what the counter sells says where it sits; the aide who picks reads it. */
  const { can } = useAuth();
  const canPlace = can("pharmacy.sale_items.manage") && dispense.storeResourceId !== null;
  const qc = useQueryClient();
  /* PD-9 — the counter asks the prescriber, by name; the server holds the Act's registration check. */
  const canAsk = can("pharmacy.dispense.place");
  const askAbout = async (lineIdx: number, blocks: readonly WireAlternativeBlock[], note: string): Promise<string | null> => {
    try {
      for (const b of blocks) await askPrescriber(dispense.id, lineIdx, { book: b.book, about: b.key, ...(note.trim() === "" ? {} : { note: note.trim() }) });
      await qc.invalidateQueries({ queryKey: ["pharmacy", "dispense", dispense.id] });
      return null;
    } catch (e) {
      return pharmacyErrorText(e, t);
    }
  };
  const place = async (itemId: string, location: string): Promise<string | null> => {
    try {
      await setShelfLocation(itemId, dispense.storeResourceId ?? "", location);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "dispense", dispense.id] });
      return null;
    } catch (e) {
      return pharmacyErrorText(e, t);
    }
  };
  /* C3b — asked once per claimed ticket: what the check would refuse, said on the line before the tick. */
  /* PD-9 — the doctor's answer changes what the check refuses, so the pre-check is asked again when any request moves. */
  const asked = dispense.lines.map((l) => (l.authorisations ?? []).map((a) => `${a.id}:${a.status}`).join(",")).join("|");
  const precheck = useQuery({
    queryKey: ["pharmacy", "precheck", dispense.id, asked],
    queryFn: () => fetchPrecheck(dispense.id),
    enabled: dispense.status === "claimed" && editable,
    staleTime: 60_000,
    retry: false,
  });

  /* A different ticket is a clean slate — the previous patient's ticks must never carry over. */
  useEffect(() => {
    setTicks(Object.fromEntries(dispense.lines.map((l) => [l.lineIdx, freshTick(l)])));
    setErrors({}); setTicketError(null); setDeclining(null);
  }, [dispense.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const collect = async (next: Record<number, Tick>): Promise<void> => {
    setTicketError(null);
    const lines = dispense.lines;
    const r = await onCollect(dispense.status === "claimed" ? verifyBody(lines, next) : null, pickBody(lines, next));
    if (r.ok) { setErrors({}); return; }
    setErrors(r.lineErrors);
    setTicketError(r.message);
    /* The refused lines are unticked: the pharmacist must look at them again before anything re-fires. */
    setTicks((prev) => {
      const out = { ...prev };
      for (const idx of Object.keys(r.lineErrors)) out[Number(idx)] = { ...out[Number(idx)]!, ticked: false };
      return out;
    });
  };

  /* A decline that settled the last open line fires the collect once the server's answer is in. */
  useEffect(() => {
    if (!settleAfterDecline.current || !editable || busy) return;
    settleAfterDecline.current = false;
    if (dispense.lines.some((l) => l.status === "open") && allSettled(dispense.lines, ticks)) void collect(ticks);
  }, [dispense]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
    The next state is computed from THIS render's ticks, not inside a `setTicks` updater: the collect
    it may fire is a stock write, and React is free to run an updater twice.
  */
  const edit = (lineIdx: number, patch: Partial<Tick>, settle: boolean): void => {
    const line = dispense.lines.find((l) => l.lineIdx === lineIdx)!;
    const merged = { ...(ticks[lineIdx] ?? freshTick(line)), ...patch };
    /* Editing a ticked line unticks it; only an explicit tick (or a scan) may tick. */
    const tick = settle ? { ...merged, ticked: canTick(line, merged) } : { ...merged, ticked: "ticked" in patch ? merged.ticked : false };
    const next = { ...ticks, [lineIdx]: tick };
    setTicks(next);
    setErrors((e) => { const out = { ...e }; delete out[lineIdx]; return out; });
    if (settle && tick.ticked && allSettled(dispense.lines, next) && dispense.lines.some((l) => l.status === "open")) {
      void collect(next);
    }
  };

  const decline = async (lineIdx: number, reason: string): Promise<void> => {
    settleAfterDecline.current = true;
    if (await onDecline(lineIdx, reason)) setDeclining(null);
    else settleAfterDecline.current = false;
  };

  /** A line whose batch the pharmacist may still choose: open, worked here, its own shelf (not a substitute's). */
  const batchable = (l: WireDispenseLine): boolean =>
    editable && l.status === "open" && l.pickedBatch == null && (l.batches ?? []).length > 0
    && blockedFor(l, ticks[l.lineIdx]) === null && ticks[l.lineIdx]?.sub == null && ticks[l.lineIdx]?.res == null && l.substitutionType !== "generic";
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "b" && e.key !== "B") return;
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector("[role=dialog]") !== null) return;
      const on = dispense.lines.find((l) => l.lineIdx === focusLine && batchable(l)) ?? dispense.lines.find((l) => batchable(l) && ticks[l.lineIdx]?.ticked !== true) ?? dispense.lines.find(batchable);
      if (on === undefined) return;
      e.preventDefault();
      setBatchFor(on.lineIdx);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* The ticket's one scan box. A pack goes to its line; the pick judges it, and a refusal lands on that line. */
  const [scanDraft, setScanDraft] = useState("");
  const [scanNote, setScanNote] = useState<string | null>(null);
  const scanIn = (): void => {
    const code = scanDraft.trim();
    if (code === "") return;
    const to = routeScan(code, dispense.lines, ticks, focusLine);
    if (to === null) { setScanNote(t("pharmacyDesk.scanBox.noLine")); return; }
    setScanDraft("");
    setScanNote(null);
    edit(to.lineIdx, { scan: code, batchId: to.batchId }, true);
  };

  const settledCount = dispense.lines.filter((l) => isSettled(l, ticks[l.lineIdx])).length;
  /* The co-pilot speaks about the first line the shelf cannot fill as written (the board's `agchip`). */
  const helpLine = firstLineNeedingHelp(dispense.lines);

  return (
    <div data-testid="desk-lines">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 15 }}>
        <div style={{ flexGrow: 1, height: 6, borderRadius: 3, background: "var(--line2)", overflow: "hidden" }}>
          <span style={{ display: "block", width: `${String(dispense.lines.length === 0 ? 0 : (settledCount * 100) / dispense.lines.length)}%`, height: "100%", background: "var(--green)" }} />
        </div>
        <span className="mo" style={{ fontSize: 12, color: "var(--dim)" }} data-testid="desk-settled">
          {t("pharmacyDesk.settled", { n: settledCount, of: dispense.lines.length })}
        </span>
      </div>
      {/* ONE scan box for the ticket: a pack scanned here finds its own line (`routeScan`) and ticks it. */}
      {editable && dispense.lines.some((l) => l.status === "open" && l.pickedBatch == null) ? (
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 13 }}>
          <input
            aria-label={t("pharmacyDesk.scanBox.label")}
            className="in mo"
            style={{ height: 34, fontSize: 12, maxWidth: 420 }}
            placeholder={t("pharmacyDesk.scanBox.placeholder")}
            value={scanDraft}
            disabled={busy}
            onChange={(e) => { setScanDraft(e.target.value); setScanNote(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); scanIn(); } }}
          />
          {scanNote === null ? null : <span role="status" style={{ fontSize: 12, color: "var(--gold-ink, #9a6208)" }}>{scanNote}</span>}
        </div>
      ) : null}
      <div style={{
        display: "flex", alignItems: "center", gap: 11, padding: "9px 15px", marginTop: 13, background: "var(--wash)",
        border: "1px solid var(--line)", borderRadius: "7px 7px 0 0",
      }}>
        <span style={{ width: 21, flexShrink: 0 }} />
        <span className="tag" style={{ width: 206, flexShrink: 0 }}>{t("pharmacyDesk.wrote")}</span>
        <span style={{ width: 14, flexShrink: 0 }} />
        <span className="tag" style={{ flexGrow: 1 }}>{t("pharmacyDesk.giving")}</span>
        <span className="tag" style={{ width: 84, textAlign: "right", flexShrink: 0 }}>{t("pharmacyDesk.qty")}</span>
        <span className="tag" style={{ width: 80, textAlign: "right", flexShrink: 0 }}>{t("pharmacyDesk.amount")}</span>
        <span style={{ width: 30, flexShrink: 0 }} />
      </div>
      <div style={{ border: "1px solid var(--line)", borderTop: "none", borderRadius: "0 0 7px 7px", background: "var(--card)" }}>
        {dispense.lines.map((l) => (
          <LineRow
            key={l.lineIdx}
            line={l}
            tick={ticks[l.lineIdx]}
            editable={editable && l.status === "open" && l.pickedBatch == null}
            busy={busy}
            today={today}
            error={errors[l.lineIdx] ?? null}
            precheck={dispense.status === "claimed" ? precheck.data?.find((p) => p.lineIdx === l.lineIdx) : undefined}
            onPlace={canPlace && l.item !== null ? (location) => place(l.item!.id, location) : null}
            prescriberName={dispense.prescriberName ?? null}
            onAsk={canAsk ? (blocks, note) => askAbout(l.lineIdx, blocks, note) : null}
            declining={declining === l.lineIdx}
            onEdit={(patch, settle) => edit(l.lineIdx, patch, settle)}
            onToggleDecline={(open) => setDeclining(open ? l.lineIdx : null)}
            onSubstitute={() => setSubbing(l.lineIdx)}
            onResolve={() => setResolving(l.lineIdx)}
            onOpenBatch={batchable(l) ? () => setBatchFor(l.lineIdx) : null}
            onFocusLine={() => setFocusLine(l.lineIdx)}
            onDecline={(reason) => void decline(l.lineIdx, reason)}
          />
        ))}
      </div>
      {editable && helpLine !== null ? (
        <CopilotOffer
          dispenseId={dispense.id}
          line={helpLine}
          tick={ticks[helpLine.lineIdx]}
          onSubstitute={(medicineId) => { setOffered(medicineId); setSubbing(helpLine.lineIdx); }}
        />
      ) : null}
      {subbing === null ? null : (
        <SubstituteSheet
          dispenseId={dispense.id}
          line={dispense.lines.find((l) => l.lineIdx === subbing)!}
          preselect={offered}
          onClose={() => { setSubbing(null); setOffered(null); }}
          onChoose={(sub) => {
            /* A different medicine is a different shelf: the batch, the scan and the tick all restart. */
            edit(subbing, { sub, batchId: null, scan: "", ticked: false }, false);
            setSubbing(null);
            setOffered(null);
            setDeclining(null);
          }}
        />
      )}
      {batchFor === null ? null : (
        <BatchSheet
          line={dispense.lines.find((l) => l.lineIdx === batchFor)!}
          tick={ticks[batchFor]}
          today={today}
          onClose={() => setBatchFor(null)}
          onChoose={(batchId) => {
            /* A chosen batch is the pick's by name; a scan of another pack would contradict it, so it is cleared. */
            if ((ticks[batchFor]?.batchId ?? null) !== batchId) edit(batchFor, { batchId, scan: "" }, false);
            setBatchFor(null);
          }}
        />
      )}
      {resolving === null ? null : (
        <ResolveSheet
          dispenseId={dispense.id}
          line={dispense.lines.find((l) => l.lineIdx === resolving)!}
          onClose={() => setResolving(null)}
          onChoose={(res) => {
            /* The shelf this line is served from is only now known: the batch, the scan and the tick restart. */
            edit(resolving, { res, batchId: null, scan: "", ticked: false }, false);
            setResolving(null);
            setDeclining(null);
          }}
        />
      )}
      {busy ? <p role="status" style={{ margin: "12px 0 0 0", fontSize: 12.5, color: "var(--dim)" }}>{t("pharmacyDesk.collecting")}</p> : null}
      {/* A refusal that landed on its lines is said there, once — not again under the list. */}
      {ticketError !== null && Object.keys(errors).length === 0
        ? <p role="alert" style={{ margin: "12px 0 0 0", fontSize: 12.5, color: "var(--red)" }}>{ticketError}</p> : null}
    </div>
  );
}


/**
 * ═══ ONE LINE, AS THE BOARD DRAWS IT ═══
 *
 * Owner, 2026-09-22: "don't complicate the pharmacy module screen — keep it minimal and in flow." The
 * row carries only: the tick · what the doctor wrote (brand, sig, salt) → what you are giving (the
 * drug and ONE badge, the FEFO batch & shelf chip, ONE note when there is something to say) · qty in
 * strips and base units · amount · ⋯. Every exception — the quantity and a short's reason, where it
 * sits, asking the doctor, declining — is behind ⋯, each in its own small sheet. Nothing that could
 * be done before is gone; it is one tap further, and the common line is quiet.
 */
type SheetKind = "qty" | "where" | "ask";
type Note = { text: string; tone: "red" | "gold" | "green" | "dim"; testId?: string; alert?: boolean };

function LineRow({
  line, tick, editable, busy, today, error, precheck, onPlace, prescriberName, onAsk, declining, onEdit, onToggleDecline, onDecline, onSubstitute, onResolve, onOpenBatch, onFocusLine,
}: {
  line: WireDispenseLine;
  tick: Tick | undefined;
  editable: boolean;
  busy: boolean;
  today: string;
  error: string | null;
  precheck: WireLinePrecheck | undefined;
  /** PD-D18 — set where this item sits; null for a reader who may not (answers an error sentence, or null). */
  onPlace: ((location: string) => Promise<string | null>) | null;
  /** PD-9 — the prescribing doctor's name, and the way to ask them; null for a reader who may not ask. */
  prescriberName: string | null;
  onAsk: ((blocks: readonly WireAlternativeBlock[], note: string) => Promise<string | null>) | null;
  /** The decline sheet is open on this line. */
  declining: boolean;
  onEdit: (patch: Partial<Tick>, settle: boolean) => void;
  onToggleDecline: (open: boolean) => void;
  onDecline: (reason: string) => void;
  onSubstitute: () => void;
  onResolve: () => void;
  /** The FEFO batch & shelf sheet for this line, or null when its batch is not the pharmacist's to choose. */
  onOpenBatch: (() => void) | null;
  onFocusLine: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [why, setWhy] = useState("");
  const [placing, setPlacing] = useState("");
  const [asking, setAsking] = useState("");
  const [sheetError, setSheetError] = useState<string | null>(null);
  const menuRef = useRef<HTMLSpanElement>(null);

  /* The menu closes on a click elsewhere, and Esc closes it without clearing the desk. */
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent): void => { if (menuRef.current !== null && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.stopImmediatePropagation(); setMenu(false); } };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [menu]);

  const rx = line.rxLine;
  const given = line.dispensedMedicine;
  const blocked = blockedFor(line, tick);
  /*
    Once the check has recorded the substitution the SERVER'S line says it (`substitutionType:
    "generic"`, the substitute as `dispensedMedicine`, the original as `orderedMedicine`); the local
    choice is only drawn while it is still a choice. Found by the walk: drawing the local one after
    verify read "Calpol 500 instead of Calpol 500".
  */
  const recorded = line.substitutionType === "generic";
  const sub = recorded ? null : (tick?.sub ?? null);
  /* PD-5b — the reading is drawn only while the server's line is still unplaced; after the check the server's medicine is the line. */
  const res = given === null ? (tick?.res ?? null) : null;
  const settled = tick !== undefined && isSettled(line, tick);
  const qty = tick === undefined ? null : qtyOf(tick);
  /* The batches on the view are the ORIGINAL item's; a substitute is picked from its own shelf by FEFO. */
  const advice = editable && qty !== null && blocked === null && sub === null && res === null ? adviceFor(line, qty, today, tick?.batchId ?? null) : null;
  const partial = tick !== undefined && isPartial(line, tick);
  const declined = line.status === "declined";
  const chipShown = line.pickedBatch != null || (advice !== null && advice.kind !== "none");
  const shelfBlock = blocked === "empty" || blocked === "not_stocked" || blocked === "not_saleable";
  /* The row's one control for a line the shelf cannot fill as written — the menu never draws it twice (walk finding). */
  const chooseRes = editable && blocked === "unresolved" && placeable(line);
  const chooseSub = editable && shelfBlock && sub === null;

  /* The prescriber: the latest request speaks; a refusal with no open request can be put to them by name. */
  const doctor = prescriberName ?? t("pharmacyDesk.auth.theDoctor");
  const requests = line.authorisations ?? [];
  const latest = requests[requests.length - 1];
  const unasked = editable && precheck?.verdict === "blocked"
    ? precheck.blocks.filter((b) => !requests.some((a) => a.book === b.book && a.about === b.key && a.status === "pending"))
    : [];

  /* The line's own money at today's shelf price: quantity × the SERVER's quote, and the rate beside it. */
  const qtyNow = qty ?? line.qtyBase;
  const money = line.quote == null || qtyNow === null || declined
    ? null
    : { amount: rupees(quoteAmountPaise(line.quote, qtyNow)), rate: t("pharmacyDesk.eachRate", { amount: rupees(line.quote.unitPaise) }) };
  const label = `${rx.drug} ${sigOf(rx)}`;
  const shownQty = qtyLabels(declined ? null : qtyNow, sub === null && res === null ? packOf(line.item) : null, line.item?.baseUom ?? res?.baseUom ?? "");

  /* ONE note: the most important thing there is to say about this line, and nothing when there is nothing. */
  const note: Note | null = (() => {
    if (error !== null) return { text: error, tone: "red", alert: true };
    if (latest !== undefined) {
      const text = latest.status === "pending" ? t("pharmacyDesk.auth.waiting", { doctor })
        : latest.status === "authorised" ? t("pharmacyDesk.auth.authorised", { doctor, reason: latest.decisionReason ?? "" })
          : t("pharmacyDesk.auth.declined", { doctor, reason: latest.decisionReason ?? "" });
      return { text, tone: latest.status === "authorised" ? "green" : latest.status === "declined" ? "red" : "gold", testId: "auth" };
    }
    /* C3b — said before the tick; once the check itself has refused the line, that refusal speaks alone. */
    if (editable && precheck?.verdict === "blocked") {
      return { text: t("pharmacyDesk.precheck.blocked", { why: precheck.blocks.map((b) => `${t(`pharmacyDesk.sub.book.${b.book}`)} ${b.about}`).join("; ") }), tone: "red", testId: "precheck" };
    }
    if (declined) return { text: t("pharmacyDesk.declined", { reason: line.declinedReason ?? "" }), tone: "gold" };
    if (line.pickedBatch != null && line.pickNote !== null) return { text: t("pharmacyDesk.givenShort", { reason: line.pickNote }), tone: "gold" };
    if (editable && blocked !== null) return { text: t(`pharmacyDesk.blocked.${blocked}`), tone: "gold" };
    if (advice?.kind === "first_short") return { text: t("pharmacyDesk.advice.firstShort", { batch: advice.batch.batchNo, n: advice.batch.available, qty: qty ?? 0 }), tone: "gold", testId: "advice" };
    if (advice?.kind === "dies_in_course") return { text: t("pharmacyDesk.advice.diesInCourse", { batch: advice.batch.batchNo, expiry: advice.batch.expiryDate ?? "", days: rx.durationDays ?? 0 }), tone: "gold", testId: "advice" };
    if (editable && partial) {
      return (tick?.reason ?? "").trim() === ""
        ? { text: t("pharmacyDesk.partialOwed", { n: qty ?? 0, of: line.qtyBase ?? 0 }), tone: "gold" }
        : { text: t("pharmacyDesk.partialSaid", { n: qty ?? 0, of: line.qtyBase ?? 0, reason: tick?.reason.trim() ?? "" }), tone: "dim" };
    }
    if (editable && (sub ?? res) !== null) return { text: t("pharmacyDesk.sub.onShelf", { n: (sub ?? res)!.available }), tone: "dim" };
    /* C7 — a price held down by law says so, or the pack and the bill disagree at the window. */
    if (money !== null && line.quote?.winner === "ceiling") {
      return { text: t("pharmacyDesk.ceiling", { mrp: rupees((line.quote.mrpUnitPaise ?? line.quote.unitPaise) * (line.quote.pack?.multiplier ?? 1)), pack: line.quote.pack?.uom ?? "" }), tone: "gold", testId: "ceiling" };
    }
    return null;
  })();
  const bar = error !== null || (editable && precheck?.verdict === "blocked") ? "var(--red)" : declined || blocked !== null ? "var(--gold)" : settled || line.pickedBatch != null ? "var(--green)" : "transparent";
  const tone = (n: Note): React.CSSProperties => ({
    display: "block", marginTop: 7, fontSize: 11.5, lineHeight: "16px", padding: "7px 9px", borderRadius: 6,
    background: n.tone === "red" ? "var(--red-soft)" : n.tone === "green" ? "var(--green-soft, #e3f1ea)" : n.tone === "gold" ? "var(--gold-soft)" : "var(--wash)",
    color: n.tone === "red" ? "var(--red)" : n.tone === "green" ? "var(--green)" : n.tone === "dim" ? "var(--dim)" : "var(--ink)",
  });
  const id = `desk-line-${String(line.lineIdx)}`;

  /* The ⋯ menu: every exception act that applies to this line, and only those. */
  type Item = { key: string; label: string; act: () => void; disabled?: boolean; kb?: string };
  const items: Item[] = !editable ? [] : [
    ...(onOpenBatch === null ? [] : [{ key: "batch", label: t("pharmacyDesk.menu.batch"), act: onOpenBatch, kb: "B" }]),
    ...(blocked === null ? [{ key: "qty", label: t("pharmacyDesk.menu.qty"), act: () => setSheet("qty") }] : []),
    ...(given !== null && !shelfBlock && sub === null && !recorded
      ? [{ key: "sub", label: t("pharmacyDesk.sub.open"), act: onSubstitute, disabled: busy || !substitutable(line) }] : []),
    ...(sub !== null ? [{ key: "unsub", label: t("pharmacyDesk.sub.undo"), act: () => onEdit({ sub: null, ticked: false }, false) }] : []),
    ...(res !== null ? [
      { key: "res", label: t("pharmacyDesk.res.open"), act: onResolve, disabled: busy },
      { key: "unres", label: t("pharmacyDesk.res.undo"), act: () => onEdit({ res: null, ticked: false }, false) },
    ] : []),
    ...(onAsk !== null && unasked.length > 0 ? [{ key: "ask", label: t("pharmacyDesk.auth.ask", { doctor }), act: () => { setAsking(""); setSheetError(null); setSheet("ask"); }, disabled: busy }] : []),
    ...(onPlace === null ? [] : [{ key: "where", label: line.location == null ? t("pharmacyDesk.rack.ask") : t("pharmacyDesk.rack.change"), act: () => { setPlacing(line.location ?? ""); setSheetError(null); setSheet("where"); } }]),
    { key: "decline", label: t("pharmacyDesk.menu.decline"), act: () => { setWhy(""); onToggleDecline(true); } },
  ];

  const closeSheet = (): void => { setSheet(null); setSheetError(null); };
  const savePlace = async (): Promise<void> => {
    if (onPlace === null) return;
    const err = await onPlace(placing);
    setSheetError(err);
    if (err === null) setSheet(null);
  };
  const sendAsk = async (): Promise<void> => {
    if (onAsk === null) return;
    const err = await onAsk(unasked, asking);
    setSheetError(err);
    if (err === null) setSheet(null);
  };

  return (
    <section data-testid={id} onFocusCapture={onFocusLine} onMouseDown={onFocusLine} style={{ borderTop: line.lineIdx === 0 ? "none" : "1px solid var(--line2)", boxShadow: `inset 3px 0 0 ${bar}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 11, padding: "12px 15px" }}>
        <span style={{ width: 21, flexShrink: 0, paddingTop: 1 }}>
          {editable ? (
            <input
              type="checkbox"
              aria-label={t("pharmacyDesk.tickLabel", { line: label })}
              checked={tick?.ticked === true}
              disabled={busy || blocked !== null || tick === undefined || (!tick.ticked && !canTick(line, tick))}
              onChange={(e) => onEdit({ ticked: e.target.checked }, e.target.checked)}
              style={{ width: 21, height: 21, accentColor: "#0e6b4e", cursor: "pointer" }}
            />
          ) : null}
        </span>

        <span style={{ width: 206, flexShrink: 0 }}>
          <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{rx.drug}</span>
          <span className="mo" style={{ display: "block", fontSize: 11.5, color: "var(--dim)", marginTop: 2 }}>
            {sigOf(rx)}{rx.instructions === null || rx.instructions === "" ? "" : ` · ${rx.instructions}`}
          </span>
          {saltLabel(line.salt) === null && !rx.noSubstitution ? null : (
            <span data-testid={`${id}-salt`} style={{ display: "block", fontSize: 10.5, color: "var(--dim)", marginTop: 1 }}>
              {[saltLabel(line.salt), rx.noSubstitution ? t("pharmacyDesk.noSubstitution") : null].filter((x) => x !== null).join(" · ")}
            </span>
          )}
        </span>

        <span style={{ width: 14, flexShrink: 0, paddingTop: 3, color: "var(--dim)" }} aria-hidden="true">→</span>

        <span style={{ flexGrow: 1, minWidth: 0 }}>
          {res !== null ? (
            <span style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }} data-testid={`${id}-res`}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{res.brandName}</span>
              <span className="pill on">{t("pharmacyDesk.res.chosen")}</span>
            </span>
          ) : given === null ? (
            chooseRes
              ? <button type="button" className="choose" disabled={busy} onClick={onResolve}>{t("pharmacyDesk.res.open")}</button>
              : editable ? null : <span className="pill gd">{t("pharmacyDesk.unresolved")}</span>
          ) : sub !== null || recorded ? (
            <span style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }} data-testid={`${id}-sub`}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{sub?.brandName ?? given.brandName}</span>
              <span className="pill on">
                {t("pharmacyDesk.generic")} · {t("pharmacyDesk.sub.insteadOf", { brand: sub !== null ? given.brandName : (line.orderedMedicine?.brandName ?? rx.drug) })}
              </span>
            </span>
          ) : chooseSub ? (
            <button type="button" className="choose" disabled={busy || !substitutable(line)} onClick={onSubstitute}>{t("pharmacyDesk.sub.open")}</button>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{given.brandName}</span>
              {line.scheduleFlag === "H1" ? <span className="pill rd">H1</span>
                : line.scheduleFlag === "X" ? <span className="pill rd">{t("pharmacyDesk.scheduleX")}</span>
                  : line.partlyChecked === true ? <span className="pill gd">{t("pharmacyDesk.notChecked")}</span> : null}
            </span>
          )}

          {/* The board's FEFO batch & shelf chip: the batch that goes out, and where it sits. */}
          {chipShown ? (
            <span style={{ display: "block" }}><BatchChip line={line} tick={tick} onOpen={onOpenBatch} /></span>
          ) : line.location != null && given !== null ? (
            <span className="pill" data-testid={`${id}-where`} style={{ marginTop: 5 }}>{line.location}</span>
          ) : null}

          {note === null ? null : (
            <span role={note.alert === true ? "alert" : undefined} data-testid={note.testId === undefined ? undefined : `${id}-${note.testId}`} style={tone(note)}>{note.text}</span>
          )}
        </span>

        <span style={{ width: 84, flexShrink: 0, textAlign: "right" }} data-testid={`${id}-qty`}>
          <span className="mo" style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{shownQty.main}</span>
          <span className="mo" style={{ display: "block", fontSize: 10.5, color: "var(--dim)", marginTop: 2 }}>{shownQty.sub}</span>
        </span>

        <span style={{ width: 80, flexShrink: 0, textAlign: "right" }}>
          {money === null ? <span className="mo" style={{ fontSize: 13.5, color: "var(--dim)" }}>—</span> : (
            <span data-testid={`${id}-money`} style={{ display: "block" }}>
              <span className="mo" style={{ display: "block", fontSize: 13.5 }}>{money.amount}</span>
              <span className="mo" style={{ display: "block", fontSize: 10.5, color: "var(--dim)" }}>{money.rate}</span>
            </span>
          )}
        </span>

        <span ref={menuRef} style={{ width: 30, flexShrink: 0, position: "relative" }}>
          {editable ? (
            <button
              type="button"
              aria-label={t("pharmacyDesk.lineMenu", { line: label })}
              aria-expanded={menu}
              aria-haspopup="true"
              onClick={() => setMenu((m) => !m)}
              style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--dim)" }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
            </button>
          ) : null}
          {menu ? (
            <span className="lmenu" data-testid={`${id}-menu`} style={{ display: "block" }}>
              {items.map((it) => (
                <button key={it.key} type="button" disabled={it.disabled === true} onClick={() => { setMenu(false); it.act(); }}>
                  {it.label}{it.kb === undefined ? null : <span className="kb">{it.kb}</span>}
                </button>
              ))}
              {rx.noSubstitution ? <span style={{ display: "block", padding: "7px 10px", fontSize: 11.5, color: "var(--dim)", lineHeight: "16px" }}>{t("pharmacyDesk.sub.noSubstitution")}</span> : null}
            </span>
          ) : null}
        </span>
      </div>

      {sheet === "qty" ? (
        <LineSheet title={t("pharmacyDesk.qtySheet.title", { drug: given?.brandName ?? rx.drug })} onClose={closeSheet}>
          <label className="tag" htmlFor={`qty-${String(line.lineIdx)}`}>{t("pharmacyDesk.qtySheet.label", { uom: line.item?.baseUom ?? res?.baseUom ?? "" })}</label>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 6 }}>
            <input
              id={`qty-${String(line.lineIdx)}`}
              aria-label={t("pharmacyDesk.qtyLabel", { line: label })}
              className="in mo"
              inputMode="numeric"
              autoFocus
              style={{ height: 38, width: 110, textAlign: "right", fontSize: 15, fontWeight: 600 }}
              value={tick?.qty ?? ""}
              onChange={(e) => onEdit({ qty: e.target.value.replace(/[^0-9]/g, "") }, false)}
            />
            <span className="mo" style={{ fontSize: 12, color: "var(--dim)" }}>
              {qtyLabels(qty, packOf(line.item), line.item?.baseUom ?? "").main}{line.qtyBase === null ? "" : ` · ${t("pharmacyDesk.ofPrescribed", { of: line.qtyBase })}`}
            </span>
          </div>
          {advice?.kind === "first_short" ? (
            <p style={{ margin: "10px 0 0 0", fontSize: 12, lineHeight: "17px" }}>
              {t("pharmacyDesk.advice.firstShort", { batch: advice.batch.batchNo, n: advice.batch.available, qty: qty ?? 0 })}{" "}
              <button type="button" className="sec" style={{ height: 26 }} onClick={() => onEdit({ qty: String(advice.batch.available) }, false)}>
                {t("pharmacyDesk.advice.give", { n: advice.batch.available })}
              </button>
            </p>
          ) : null}
          {partial ? (
            <div style={{ marginTop: 12 }}>
              <label className="tag" htmlFor={`why-short-${String(line.lineIdx)}`}>{t("pharmacyDesk.partialWhy", { n: qty ?? 0, of: line.qtyBase ?? 0 })}</label>
              <input
                id={`why-short-${String(line.lineIdx)}`}
                className="in"
                style={{ height: 34, marginTop: 5, fontSize: 12.5 }}
                value={tick?.reason ?? ""}
                placeholder={t("pharmacyDesk.partialPlaceholder")}
                onChange={(e) => onEdit({ reason: e.target.value }, false)}
              />
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button type="button" className="pri" style={{ flexGrow: 1 }} onClick={closeSheet}>{t("pharmacyDesk.qtySheet.done")}</button>
          </div>
        </LineSheet>
      ) : null}

      {sheet === "where" ? (
        <LineSheet title={t("pharmacyDesk.rack.input", { drug: given?.brandName ?? rx.drug })} onClose={closeSheet}>
          <input
            className="in mo"
            autoFocus
            aria-label={t("pharmacyDesk.rack.input", { drug: given?.brandName ?? rx.drug })}
            placeholder={t("pharmacyDesk.rack.placeholder")}
            value={placing}
            maxLength={24}
            onChange={(e) => setPlacing(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void savePlace(); } }}
          />
          {sheetError !== null ? <p role="alert" style={{ margin: "10px 0 0 0", fontSize: 12, color: "var(--red)" }}>{sheetError}</p> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button type="button" className="pri" style={{ flexGrow: 1 }} onClick={() => void savePlace()}>{t("pharmacyDesk.rack.save")}</button>
            <button type="button" className="sec" onClick={closeSheet}>{t("pharmacyDesk.rack.cancel")}</button>
          </div>
        </LineSheet>
      ) : null}

      {sheet === "ask" && onAsk !== null ? (
        <LineSheet title={t("pharmacyDesk.auth.ask", { doctor })} onClose={closeSheet}>
          <p style={{ margin: "0 0 10px 0", fontSize: 12, color: "var(--dim)", lineHeight: "17px" }}>
            {t("pharmacyDesk.precheck.blocked", { why: unasked.map((b) => `${t(`pharmacyDesk.sub.book.${b.book}`)} ${b.about}`).join("; ") })}
          </p>
          <input
            className="in"
            autoFocus
            aria-label={t("pharmacyDesk.auth.noteLabel", { doctor })}
            placeholder={t("pharmacyDesk.auth.notePlaceholder")}
            value={asking}
            onChange={(e) => setAsking(e.target.value)}
          />
          {sheetError !== null ? <p role="alert" style={{ margin: "10px 0 0 0", fontSize: 12, color: "var(--red)" }}>{sheetError}</p> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button type="button" className="pri" style={{ flexGrow: 1 }} disabled={busy} onClick={() => void sendAsk()}>{t("pharmacyDesk.auth.send", { doctor })}</button>
            <button type="button" className="sec" onClick={closeSheet}>{t("pharmacyDesk.rack.cancel")}</button>
          </div>
        </LineSheet>
      ) : null}

      {editable && declining ? (
        <LineSheet title={t("pharmacyDesk.declineTitle", { line: rx.drug })} onClose={() => onToggleDecline(false)}>
          {substitutable(line) === false && rx.noSubstitution ? (
            <p style={{ margin: "0 0 10px 0", fontSize: 12, color: "var(--dim)" }}>{t("pharmacyDesk.sub.noSubstitution")}</p>
          ) : null}
          <input
            aria-label={t("pharmacyDesk.declineWhy", { line: label })}
            className="in"
            autoFocus
            value={why}
            placeholder={t("pharmacyDesk.declinePlaceholder")}
            onChange={(e) => setWhy(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button type="button" className="pri" style={{ flexGrow: 1 }} disabled={busy || why.trim() === ""} onClick={() => onDecline(why.trim())}>
              {t("pharmacyDesk.declineIt")}
            </button>
            <button type="button" className="sec" onClick={() => onToggleDecline(false)}>{t("pharmacyDesk.rack.cancel")}</button>
          </div>
        </LineSheet>
      ) : null}
    </section>
  );
}

/** A small sheet over the desk for one line's exception; Esc closes it and only it. */
function LineSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="ovl" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="box" style={{ width: 520, maxWidth: "100%", boxShadow: "0 24px 70px rgba(19,36,32,.35)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "15px 18px", borderBottom: "1px solid var(--line2)" }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, flexGrow: 1 }}>{title}</h2>
          <button type="button" className="pill" onClick={onClose}>{t("pharmacyDesk.close")} <span className="kb">Esc</span></button>
        </div>
        <div style={{ padding: "16px 18px 18px 18px" }}>{children}</div>
      </div>
    </div>
  );
}
