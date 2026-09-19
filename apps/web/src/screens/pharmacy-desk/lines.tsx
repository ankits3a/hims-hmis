import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { fetchPrecheck, pharmacyErrorText, setShelfLocation } from "../../lib/pharmacy-api";
import { ResolveSheet } from "./resolve";
import { SubstituteSheet } from "./substitute";
import { adviceFor, allSettled, blockedFor, canTick, freshTick, isPartial, isSettled, istToday, pickBody, placeable, qtyOf, sigOf, substitutable, verifyBody } from "./work";
import type { Tick } from "./work";
import type { PickLine, VerifyLine, WireDispense, WireDispenseLine, WireLinePrecheck } from "../../lib/pharmacy-api";

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
  const [resolving, setResolving] = useState<number | null>(null);
  const settleAfterDecline = useRef(false);
  const today = istToday();
  /* PD-D18 — whoever manages what the counter sells says where it sits; the aide who picks reads it. */
  const { can } = useAuth();
  const canPlace = can("pharmacy.sale_items.manage") && dispense.storeResourceId !== null;
  const qc = useQueryClient();
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
  const precheck = useQuery({
    queryKey: ["pharmacy", "precheck", dispense.id],
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

  const settledCount = dispense.lines.filter((l) => isSettled(l, ticks[l.lineIdx])).length;
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
      <div style={{
        display: "flex", alignItems: "center", gap: 11, padding: "9px 15px", marginTop: 13, background: "var(--wash)",
        border: "1px solid var(--line)", borderRadius: "7px 7px 0 0",
      }}>
        <span style={{ width: 21, flexShrink: 0 }} />
        <span className="tag" style={{ width: 210, flexShrink: 0 }}>{t("pharmacyDesk.wrote")}</span>
        <span style={{ width: 14, flexShrink: 0 }} />
        <span className="tag" style={{ flexGrow: 1 }}>{t("pharmacyDesk.giving")}</span>
        <span className="tag" style={{ width: 96, textAlign: "right", flexShrink: 0 }}>{t("pharmacyDesk.qty")}</span>
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
            declining={declining === l.lineIdx}
            onEdit={(patch, settle) => edit(l.lineIdx, patch, settle)}
            onToggleDecline={() => setDeclining((d) => (d === l.lineIdx ? null : l.lineIdx))}
            onSubstitute={() => setSubbing(l.lineIdx)}
            onResolve={() => setResolving(l.lineIdx)}
            onDecline={(reason) => void decline(l.lineIdx, reason)}
          />
        ))}
      </div>
      {subbing === null ? null : (
        <SubstituteSheet
          dispenseId={dispense.id}
          line={dispense.lines.find((l) => l.lineIdx === subbing)!}
          onClose={() => setSubbing(null)}
          onChoose={(sub) => {
            /* A different medicine is a different shelf: the batch, the scan and the tick all restart. */
            edit(subbing, { sub, batchId: null, scan: "", ticked: false }, false);
            setSubbing(null);
            setDeclining(null);
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

function LineRow({
  line, tick, editable, busy, today, error, precheck, onPlace, declining, onEdit, onToggleDecline, onDecline, onSubstitute, onResolve,
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
  declining: boolean;
  onEdit: (patch: Partial<Tick>, settle: boolean) => void;
  onToggleDecline: () => void;
  onDecline: (reason: string) => void;
  onSubstitute: () => void;
  onResolve: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [why, setWhy] = useState("");
  const [placing, setPlacing] = useState<string | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const savePlace = async (): Promise<void> => {
    if (onPlace === null || placing === null) return;
    const err = await onPlace(placing);
    setPlaceError(err);
    if (err === null) setPlacing(null);
  };
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
  /* The amber note's own control — the line menu does not draw it a second time (walk finding). */
  const noteOffers = editable && (blocked === "unresolved" ? placeable(line) : blocked === "empty" || blocked === "not_stocked" || blocked === "not_saleable");
  const bar = error !== null || (editable && precheck?.verdict === "blocked") ? "var(--red)" : declined || blocked !== null ? "var(--gold)" : settled || line.pickedBatch != null ? "var(--green)" : "transparent";
  const soft = { display: "block", marginTop: 7, fontSize: 11.5, lineHeight: "16px", padding: "7px 9px", borderRadius: 6 } as const;
  const label = `${rx.drug} ${sigOf(rx)}`;

  return (
    <section data-testid={`desk-line-${String(line.lineIdx)}`} style={{ borderTop: line.lineIdx === 0 ? "none" : "1px solid var(--line2)", boxShadow: `inset 3px 0 0 ${bar}` }}>
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

        <span style={{ width: 210, flexShrink: 0 }}>
          <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{rx.drug}</span>
          <span className="mo" style={{ display: "block", fontSize: 11.5, color: "var(--dim)", marginTop: 2 }}>{sigOf(rx)}</span>
          {rx.instructions === null || rx.instructions === "" ? null : (
            <span style={{ display: "block", fontSize: 11, color: "var(--dim)", marginTop: 1 }}>{rx.instructions}</span>
          )}
          {rx.noSubstitution ? <span className="pill" style={{ marginTop: 4 }}>{t("pharmacyDesk.noSubstitution")}</span> : null}
        </span>

        <span style={{ width: 14, flexShrink: 0, paddingTop: 3, color: "var(--dim)" }} aria-hidden="true">→</span>

        <span style={{ flexGrow: 1, minWidth: 0 }}>
          {given === null && res !== null ? (
            <span style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }} data-testid={`desk-line-${String(line.lineIdx)}-res`}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{res.brandName}</span>
              <span className="pill on">{t("pharmacyDesk.res.chosen")}</span>
              {editable ? <button className="sec" style={{ height: 24 }} onClick={() => onEdit({ res: null, ticked: false }, false)}>{t("pharmacyDesk.res.undo")}</button> : null}
            </span>
          ) : given === null ? (
            /* Worked, the amber note below says it and says what to do; one sentence, not two. */
            editable ? null : <span className="pill gd">{t("pharmacyDesk.unresolved")}</span>
          ) : sub !== null ? (
            <span style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }} data-testid={`desk-line-${String(line.lineIdx)}-sub`}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{sub.brandName}</span>
              <span className="pill on">{t("pharmacyDesk.generic")}</span>
              <span style={{ fontSize: 11, color: "var(--dim)" }}>{t("pharmacyDesk.sub.insteadOf", { brand: given.brandName })}</span>
              {editable ? <button className="sec" style={{ height: 24 }} onClick={() => onEdit({ sub: null, ticked: false }, false)}>{t("pharmacyDesk.sub.undo")}</button> : null}
            </span>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }} data-testid={recorded ? `desk-line-${String(line.lineIdx)}-sub` : undefined}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{given.brandName}</span>
              {recorded ? <span className="pill on">{t("pharmacyDesk.generic")}</span> : null}
              {recorded ? <span style={{ fontSize: 11, color: "var(--dim)" }}>{t("pharmacyDesk.sub.insteadOf", { brand: line.orderedMedicine?.brandName ?? rx.drug })}</span> : null}
              {line.scheduleFlag === "H1" ? <span className="pill rd">H1</span> : null}
              {line.scheduleFlag === "X" ? <span className="pill rd">{t("pharmacyDesk.scheduleX")}</span> : null}
              {line.partlyChecked === true ? <span className="pill gd">{t("pharmacyDesk.notChecked")}</span> : null}
            </span>
          )}

          {/* PD-D18 — where to walk, beside the batch; the manager of the counter's items can say it in place. */}
          {placing !== null ? (
            <span style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 5 }}>
              <input
                className="in mo"
                autoFocus
                aria-label={t("pharmacyDesk.rack.input", { drug: given?.brandName ?? rx.drug })}
                placeholder={t("pharmacyDesk.rack.placeholder")}
                value={placing}
                maxLength={24}
                onChange={(e) => setPlacing(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void savePlace(); } }}
                style={{ height: 28, width: 180, fontSize: 11.5 }}
              />
              <button className="sec" style={{ height: 26 }} onClick={() => { setPlacing(null); setPlaceError(null); }}>{t("pharmacyDesk.rack.cancel")}</button>
            </span>
          ) : line.location != null ? (
            onPlace !== null && editable ? (
              <button className="pill" data-testid={`desk-line-${String(line.lineIdx)}-where`} title={t("pharmacyDesk.rack.change")} onClick={() => setPlacing(line.location ?? "")} style={{ marginTop: 5 }}>
                {line.location}
              </button>
            ) : <span className="pill" data-testid={`desk-line-${String(line.lineIdx)}-where`} style={{ marginTop: 5 }}>{line.location}</span>
          ) : onPlace !== null && editable ? (
            <button className="sec" style={{ height: 22, marginTop: 5, fontSize: 11 }} onClick={() => setPlacing("")}>{t("pharmacyDesk.rack.ask")}</button>
          ) : null}
          {placeError !== null ? <span role="alert" style={{ ...soft, background: "var(--red-soft)", color: "var(--red)" }}>{placeError}</span> : null}

          {line.pickedBatch != null ? (
            <span className="mo" style={{ display: "block", fontSize: 11.5, color: "var(--dim)", marginTop: 3 }} data-testid={`desk-line-${String(line.lineIdx)}-batch`}>
              {t("pharmacyDesk.givenFrom", { batch: line.pickedBatch.batchNo, expiry: line.pickedBatch.expiryDate ?? "—" })}
            </span>
          ) : advice !== null && advice.kind !== "none" ? (
            <span className="mo" style={{ display: "block", fontSize: 11.5, color: "var(--dim)", marginTop: 3 }} data-testid={`desk-line-${String(line.lineIdx)}-batch`}>
              {t("pharmacyDesk.fromBatch", { batch: advice.batch.batchNo, expiry: advice.batch.expiryDate ?? "—", n: advice.batch.available })}
              {tick !== undefined && tick.scan.trim() !== "" ? ` · ${t("pharmacyDesk.scanned")}` : ""}
            </span>
          ) : null}

          {declined ? <span style={{ ...soft, background: "var(--gold-soft)" }}>{t("pharmacyDesk.declined", { reason: line.declinedReason ?? "" })}</span> : null}
          {line.pickedBatch != null && line.pickNote !== null ? (
            <span style={{ ...soft, background: "var(--gold-soft)" }}>{t("pharmacyDesk.givenShort", { reason: line.pickNote })}</span>
          ) : null}
          {editable && blocked !== null ? (
            <span style={{ ...soft, background: "var(--gold-soft)" }}>
              {t(`pharmacyDesk.blocked.${blocked}`)}{" "}
              {blocked === "empty" || blocked === "not_stocked" || blocked === "not_saleable" ? (
                <button className="sec grn" style={{ height: 24, marginTop: 5 }} disabled={!substitutable(line)} onClick={onSubstitute}>
                  {t("pharmacyDesk.sub.open")}
                </button>
              ) : null}
              {blocked === "unresolved" && placeable(line) ? (
                <button className="sec grn" style={{ height: 24, marginTop: 5 }} disabled={busy} onClick={onResolve}>
                  {t("pharmacyDesk.res.open")}
                </button>
              ) : null}
            </span>
          ) : null}
          {editable && (sub ?? res) !== null ? (
            <span className="mo" style={{ display: "block", fontSize: 11.5, color: "var(--dim)", marginTop: 3 }}>{t("pharmacyDesk.sub.onShelf", { n: (sub ?? res)!.available })}</span>
          ) : null}

          {advice?.kind === "first_short" ? (
            <span style={{ ...soft, background: "var(--gold-soft)" }} data-testid={`desk-line-${String(line.lineIdx)}-advice`}>
              {t("pharmacyDesk.advice.firstShort", { batch: advice.batch.batchNo, n: advice.batch.available, qty: qty ?? 0 })}{" "}
              {advice.better !== null ? (
                <button className="sec grn" style={{ height: 24, marginTop: 5 }} onClick={() => onEdit({ batchId: advice.better!.batchId }, false)}>
                  {t("pharmacyDesk.advice.take", { batch: advice.better.batchNo })}
                </button>
              ) : null}{" "}
              <button className="sec" style={{ height: 24, marginTop: 5 }} onClick={() => onEdit({ qty: String(advice.batch.available) }, false)}>
                {t("pharmacyDesk.advice.give", { n: advice.batch.available })}
              </button>
            </span>
          ) : null}
          {advice?.kind === "dies_in_course" ? (
            <span style={{ ...soft, background: "var(--gold-soft)" }} data-testid={`desk-line-${String(line.lineIdx)}-advice`}>
              {t("pharmacyDesk.advice.diesInCourse", { batch: advice.batch.batchNo, expiry: advice.batch.expiryDate ?? "", days: rx.durationDays ?? 0 })}{" "}
              {advice.better !== null ? (
                <button className="sec grn" style={{ height: 24, marginTop: 5 }} onClick={() => onEdit({ batchId: advice.better!.batchId }, false)}>
                  {t("pharmacyDesk.advice.take", { batch: advice.better.batchNo })}
                </button>
              ) : null}
            </span>
          ) : null}

          {editable && partial ? (
            <span style={{ display: "block", marginTop: 7 }}>
              <label className="tag" htmlFor={`why-short-${String(line.lineIdx)}`}>{t("pharmacyDesk.partialWhy", { n: qty ?? 0, of: line.qtyBase ?? 0 })}</label>
              <input
                id={`why-short-${String(line.lineIdx)}`}
                className="in"
                style={{ height: 32, marginTop: 4, fontSize: 12.5 }}
                value={tick?.reason ?? ""}
                placeholder={t("pharmacyDesk.partialPlaceholder")}
                onChange={(e) => onEdit({ reason: e.target.value }, false)}
              />
            </span>
          ) : null}

          {editable && blocked === null ? (
            <input
              aria-label={t("pharmacyDesk.scanLabel", { line: label })}
              className="in mo"
              style={{ height: 30, marginTop: 7, fontSize: 11.5, maxWidth: 320 }}
              placeholder={t("pharmacyDesk.scanPlaceholder")}
              value={tick?.scan ?? ""}
              onChange={(e) => onEdit({ scan: e.target.value }, false)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if ((tick?.scan ?? "").trim() !== "") onEdit({}, true); } }}
            />
          ) : null}

          {error !== null ? <span role="alert" style={{ ...soft, background: "var(--red-soft)", color: "var(--red)" }}>{error}</span> : null}
          {/* C3b — said before the tick; once the check itself has refused the line, that refusal speaks alone. */}
          {editable && error === null && precheck?.verdict === "blocked" ? (
            <span data-testid={`desk-line-${String(line.lineIdx)}-precheck`} style={{ ...soft, background: "var(--red-soft)", color: "var(--red)" }}>
              {t("pharmacyDesk.precheck.blocked", { why: precheck.blocks.map((b) => `${t(`pharmacyDesk.sub.book.${b.book}`)} ${b.about}`).join("; ") })}
            </span>
          ) : null}

          {editable && declining && substitutable(line) === false && line.rxLine.noSubstitution ? (
            <span style={{ ...soft, background: "var(--wash)" }}>{t("pharmacyDesk.sub.noSubstitution")}</span>
          ) : null}
          {editable && declining ? (
            <span style={{ display: "flex", gap: 7, marginTop: 8, flexWrap: "wrap" }}>
              {noteOffers ? null : placeable(line)
                ? <button className="sec grn" style={{ height: 32 }} disabled={busy} onClick={onResolve}>{t("pharmacyDesk.res.open")}</button>
                : <button className="sec grn" style={{ height: 32 }} disabled={busy || !substitutable(line)} onClick={onSubstitute}>{t("pharmacyDesk.sub.open")}</button>}
              <input
                aria-label={t("pharmacyDesk.declineWhy", { line: label })}
                className="in"
                style={{ height: 32, fontSize: 12.5 }}
                value={why}
                placeholder={t("pharmacyDesk.declinePlaceholder")}
                onChange={(e) => setWhy(e.target.value)}
              />
              <button className="sec" style={{ height: 32 }} disabled={busy || why.trim() === ""} onClick={() => onDecline(why.trim())}>
                {t("pharmacyDesk.declineIt")}
              </button>
            </span>
          ) : null}
        </span>

        <span style={{ width: 96, flexShrink: 0, textAlign: "right" }}>
          {editable && blocked === null ? (
            <input
              aria-label={t("pharmacyDesk.qtyLabel", { line: label })}
              className="in mo"
              inputMode="numeric"
              style={{ height: 32, width: 70, textAlign: "right", fontSize: 13.5, fontWeight: 600 }}
              value={tick?.qty ?? ""}
              onChange={(e) => onEdit({ qty: e.target.value.replace(/[^0-9]/g, "") }, false)}
            />
          ) : (
            <span className="mo" style={{ fontSize: 13.5, fontWeight: 600 }}>{line.qtyBase === null ? "—" : String(line.qtyBase)}</span>
          )}
          <span className="mo" style={{ display: "block", fontSize: 10.5, color: "var(--dim)", marginTop: 2 }}>
            {line.item?.baseUom ?? res?.baseUom ?? ""}{line.qtyBase !== null && partial ? ` · ${t("pharmacyDesk.ofPrescribed", { of: line.qtyBase })}` : ""}
          </span>
        </span>

        <span style={{ width: 30, flexShrink: 0 }}>
          {editable ? (
            <button
              aria-label={t("pharmacyDesk.lineMenu", { line: label })}
              aria-expanded={declining}
              onClick={onToggleDecline}
              style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--dim)" }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
            </button>
          ) : null}
        </span>
      </div>
    </section>
  );
}
