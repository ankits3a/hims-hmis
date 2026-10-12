import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import {
  borrowApi, countApi, fetchLinenHandler, infectedApi, linenRefusal, newTapKey, receiveLaundryApi, requestCondemnApi, sendLaundryApi,
  soiledApi, topUpApi,
} from "../lib/linen-api";
import type { LinenLine } from "../lib/linen-api";
import type { LinenHandlerView, LinenItem } from "@hmis/contracts";
import "./linen.css";

/**
 * ═══ E2.4 LINEN (issue #728) — THE LINEN HANDLER'S PHONE (390 px, Hindi first) ═══
 *
 * Pick the ward once (remembered on this phone) → pick the job → item counts with big − / + steppers → Save. Each
 * button's Hindi word is its main line, English under it. Top up starts at what the ward is short of par; Count starts
 * at the book balance; the laundry jobs need no ward. Notices are a few words on one line (owner rule).
 */
const WARD_KEY = "hmis.linen.ward";
const readWard = (): string => { try { return localStorage.getItem(WARD_KEY) ?? ""; } catch { return ""; } };
const keepWard = (id: string): void => { try { localStorage.setItem(WARD_KEY, id); } catch { /* private window: forget it */ } };

export const LINEN_MODES = ["topUp", "soiled", "infected", "count", "borrow", "laundryOut", "laundryIn", "condemn"] as const;
export type LinenMode = (typeof LINEN_MODES)[number];
const NEEDS_WARD: ReadonlySet<LinenMode> = new Set(["topUp", "soiled", "infected", "count", "borrow", "condemn"]);
const CONDEMN_REASONS = ["torn", "stained", "burnt", "worn"] as const;

function Two({ k, o }: { k: string; o?: Record<string, unknown> }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span className="ln-two">
      <span className="hi" lang="hi">{t(k, { ...o, lng: "hi" })}</span>
      <span className="en" lang="en">{t(k, { ...o, lng: "en" })}</span>
    </span>
  );
}

type Row = { code: string; hint: string | null; max: number | null };

/** The starting counts and the rows a job shows, from the handler view. */
export function startingCounts(view: LinenHandlerView, mode: LinenMode, wardId: string, batchId: string, infectedBatch: boolean): { rows: Row[]; start: Record<string, number> } {
  const ward = view.wards.find((w) => w.wardId === wardId);
  const bedItems = view.items.filter((i) => i.unitsPerSet > 0 || (ward?.items.find((x) => x.itemCode === i.code)?.par ?? 0) > 0);
  const start: Record<string, number> = {};
  if (mode === "laundryOut") {
    const pool = infectedBatch ? view.soiled.infected : view.soiled.general;
    const rows = view.items.filter((i) => (pool[i.code] ?? 0) > 0).map((i) => ({ code: i.code, hint: String(pool[i.code]), max: pool[i.code]! }));
    for (const r of rows) start[r.code] = r.max!;
    return { rows, start };
  }
  if (mode === "laundryIn") {
    const batch = view.inTransit.find((b) => b.id === batchId);
    const rows = (batch?.lines ?? []).map((l) => ({ code: l.itemCode, hint: String(l.sent), max: l.sent }));
    for (const r of rows) start[r.code] = r.max!;
    return { rows, start };
  }
  const rows = bedItems.map((i) => {
    const s = ward?.items.find((x) => x.itemCode === i.code);
    if (mode === "topUp") { start[i.code] = s?.short ?? 0; return { code: i.code, hint: s === undefined ? null : `${s.onHand}/${s.par}`, max: s?.short ?? 0 }; }
    if (mode === "count") { start[i.code] = s?.onHand ?? 0; return { code: i.code, hint: s === undefined ? null : `${s.onHand}/${s.par}`, max: null }; }
    start[i.code] = 0;
    return { code: i.code, hint: s === undefined ? null : `${s.onHand}/${s.par}`, max: null };
  });
  return { rows, start };
}

export function LinenHandle(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["linen", "handler"], queryFn: fetchLinenHandler });
  const [wardId, setWardId] = useState<string>(readWard);
  const [mode, setMode] = useState<LinenMode | null>(null);
  const [fromWard, setFromWard] = useState("");
  const [batchId, setBatchId] = useState("");
  const [infectedBatch, setInfectedBatch] = useState(false);
  const [reason, setReason] = useState<string>(CONDEMN_REASONS[0]);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const view = q.data;
  const items: readonly LinenItem[] = view?.items ?? [];

  const base = useMemo(
    () => (view === undefined || mode === null ? { rows: [], start: {} } : startingCounts(view, mode, wardId, batchId, infectedBatch)),
    [view, mode, wardId, batchId, infectedBatch],
  );
  const qty = (code: string): number => edits[code] ?? base.start[code] ?? 0;
  const setQty = (code: string, n: number, max: number | null): void => {
    const v = Math.max(0, max === null ? n : Math.min(max, n));
    setEdits((e) => ({ ...e, [code]: v }));
  };
  const pick = (m: LinenMode): void => { setMode(m); setEdits({}); setNotice(null); };
  const name = (code: string, lng?: string): string =>
    t(`linen.item.${code}`, { defaultValue: items.find((i) => i.code === code)?.name ?? code, ...(lng === undefined ? {} : { lng }) });

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      if (mode === null) return;
      const key = newTapKey();
      const positive: LinenLine[] = base.rows.map((r) => ({ itemCode: r.code, qty: qty(r.code) })).filter((l) => l.qty > 0);
      const all: LinenLine[] = base.rows.map((r) => ({ itemCode: r.code, qty: qty(r.code) }));
      switch (mode) {
        case "topUp": await topUpApi(wardId, positive, key); break;
        case "soiled": await soiledApi(wardId, positive, key); break;
        case "infected": await infectedApi(wardId, positive, key); break;
        case "count": await countApi(wardId, all, key); break;
        case "borrow": await borrowApi(fromWard, wardId, positive, key); break;
        case "laundryOut": await sendLaundryApi(infectedBatch, positive, key); break;
        case "laundryIn": await receiveLaundryApi(batchId, all); break;
        case "condemn": for (const l of positive) await requestCondemnApi(wardId, l.itemCode, l.qty, t(`linen.handle.reason.${reason}`, { lng: "en" })); break;
      }
    },
    onSuccess: () => {
      setNotice({ ok: true, text: t(`linen.handle.saved.${mode ?? "topUp"}`) });
      setEdits({});
      void qc.invalidateQueries({ queryKey: ["linen"] });
    },
    onError: (e) => setNotice({ ok: false, text: t(`linen.refusal.${linenRefusal(e) ?? "failed"}`, { defaultValue: t("linen.refusal.failed") }) }),
  });

  const total = base.rows.reduce((n, r) => n + qty(r.code), 0);
  const ready = mode !== null && (!NEEDS_WARD.has(mode) || wardId !== "") && (mode !== "borrow" || (fromWard !== "" && fromWard !== wardId))
    && (mode !== "laundryIn" || batchId !== "") && (mode === "count" || mode === "laundryIn" || total > 0);
  const wardName = view?.wards.find((w) => w.wardId === wardId)?.wardName;

  return (
    <PaperScreen testId="linen-handle">
      <div className="ln-phone">
        <h1><Two k="linen.handle.title" /></h1>
        {notice !== null && <p role="alert" className={notice.ok ? "ln-notice ok" : "ln-notice"} data-testid="linen-notice">{notice.text}</p>}

        <select value={wardId} onChange={(e) => { setWardId(e.target.value); keepWard(e.target.value); setEdits({}); }} aria-label={t("linen.handle.ward")} data-testid="linen-ward">
          <option value="">{t("linen.handle.pickWard")}</option>
          {(view?.wards ?? []).map((w) => <option key={w.wardId} value={w.wardId}>{w.floorName === null ? w.wardName : `${w.wardName} · ${w.floorName}`}</option>)}
        </select>

        <div className="ln-modes" role="tablist">
          {LINEN_MODES.map((m) => (
            <button
              key={m} type="button" role="tab" aria-selected={mode === m} className={`ln-mode ${m}${mode === m ? " on" : ""}`}
              onClick={() => pick(m)} data-testid={`linen-mode-${m}`}
            >
              <Two k={`linen.handle.mode.${m}`} />
            </button>
          ))}
        </div>

        {mode !== null && (
          <section className="box ln-card" data-testid="linen-counts">
            <h2>
              <Two k={`linen.handle.mode.${mode}`} />
              {NEEDS_WARD.has(mode) && wardName !== undefined && <span className="ln-where">{wardName}</span>}
            </h2>
            {mode === "borrow" && (
              <select value={fromWard} onChange={(e) => setFromWard(e.target.value)} aria-label={t("linen.handle.fromWard")} data-testid="linen-from">
                <option value="">{t("linen.handle.fromWard")}</option>
                {(view?.wards ?? []).filter((w) => w.wardId !== wardId).map((w) => <option key={w.wardId} value={w.wardId}>{w.wardName}</option>)}
              </select>
            )}
            {mode === "laundryOut" && (
              <label className="ln-check"><input type="checkbox" checked={infectedBatch} onChange={(e) => { setInfectedBatch(e.target.checked); setEdits({}); }} data-testid="linen-infected-batch" /> <Two k="linen.handle.infectedBatch" /></label>
            )}
            {mode === "laundryIn" && (
              <select value={batchId} onChange={(e) => { setBatchId(e.target.value); setEdits({}); }} aria-label={t("linen.handle.batch")} data-testid="linen-batch">
                <option value="">{t("linen.handle.pickBatch")}</option>
                {(view?.inTransit ?? []).map((b) => <option key={b.id} value={b.id}>{b.batchNo}{b.infected ? ` · ${t("linen.board.infectedBatch")}` : ""} · {b.piecesSent}</option>)}
              </select>
            )}
            {mode === "condemn" && (
              <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label={t("linen.handle.reasonLabel")} data-testid="linen-reason">
                {CONDEMN_REASONS.map((r) => <option key={r} value={r}>{t(`linen.handle.reason.${r}`)}</option>)}
              </select>
            )}
            {base.rows.length === 0 && <div className="ln-empty">{t("linen.handle.nothing")}</div>}
            {base.rows.map((r) => (
              <div key={r.code} className="ln-step" data-testid={`step-${r.code}`}>
                <span className="nm">
                  <span className="hi" lang="hi">{name(r.code, "hi")}</span>
                  <span className="en">{name(r.code, "en")}</span>
                  {r.hint !== null && <span className="hint">{t(`linen.handle.hint.${mode}`, { v: r.hint })}</span>}
                </span>
                <button type="button" className="ln-pm" aria-label={t("linen.handle.less")} onClick={() => setQty(r.code, qty(r.code) - 1, r.max)} data-testid={`minus-${r.code}`}>−</button>
                <input
                  className="ln-qty" inputMode="numeric" value={String(qty(r.code))} aria-label={name(r.code)}
                  onChange={(e) => setQty(r.code, Number(e.target.value.replace(/\D/g, "")) || 0, r.max)} data-testid={`qty-${r.code}`}
                />
                <button type="button" className="ln-pm" aria-label={t("linen.handle.more")} onClick={() => setQty(r.code, qty(r.code) + 1, r.max)} data-testid={`plus-${r.code}`}>+</button>
              </div>
            ))}
            <button type="button" className="ln-btn big ln-save" disabled={!ready || save.isPending} onClick={() => save.mutate()} data-testid="linen-save">
              <Two k="linen.handle.save" o={{ count: total }} />
            </button>
          </section>
        )}
      </div>
    </PaperScreen>
  );
}
