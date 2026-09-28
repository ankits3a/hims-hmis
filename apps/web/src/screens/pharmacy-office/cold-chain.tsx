import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  COLDCHAIN_MANAGE, COLDCHAIN_RECORD, addColdUnit, closeColdExcursion, editColdUnit, fetchColdExcursions, fetchColdReadings, fetchColdStores,
  fetchColdUnits, isOutOfRange, parseCelsius, recordColdReading,
} from "../../lib/cold-chain-api";
import { newIdempotencyKey } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { pharmacyErrorText } from "../../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "./sheet";
import type { ColdDecision, WireColdExcursion, WireColdUnit } from "../../lib/cold-chain-api";

/**
 * ═══ PHARMACY STAGE D3 — THE FRIDGE TEMPERATURE LOG (an office page under Stock) ═══
 *
 * Every fridge with today's two slots (09:00 and 17:00 IST: read, due, missed), its last reading and any open
 * excursion; the record-reading sheet (current, and the min/max since the thermometer was last reset — it warns
 * before saving a reading that will hold the store's cold stock); the fridge's reading history; and the
 * excursion panel, where a holder of `pharmacy.coldchain.manage` decides every held batch — release with the
 * stability reason, or write off — and closes it.
 *
 * Self-contained and unrouted until B3 (#352) wires the office menu. Built on the office's legacy-side
 * primitives (shadcn + the paper-and-pine palette), as the D1 and D2 registers.
 */
const areaCls = "min-h-16 w-full rounded-md border bg-background p-2 text-sm";
const selectCls = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const slotCls: Record<string, string> = { done: "pill on", due: "pill gd", missed: "pill rd", upcoming: "pill", not_due: "pill" };
const when = (iso: string): string => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

export function ColdChainView(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const units = useQuery({ queryKey: ["pharmacy", "cold-chain", "units"], queryFn: () => fetchColdUnits() });
  const [selected, setSelected] = useState<string | null>(null);
  const [recording, setRecording] = useState<WireColdUnit | null>(null);
  const [editing, setEditing] = useState<WireColdUnit | "new" | null>(null);
  const [notice, setNotice] = useState<{ text: string; red: boolean } | null>(null);
  const items = units.data?.items ?? [];
  const first = items[0]?.id ?? null;
  useEffect(() => { if (selected === null && first !== null) setSelected(first); }, [first, selected]);
  const current = items.find((u) => u.id === selected) ?? null;
  const mayRecord = can(COLDCHAIN_RECORD);
  const mayManage = can(COLDCHAIN_MANAGE);

  return (
    <div className="space-y-4" data-testid="cold-chain-view">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{t("pharmacyOffice.coldChain.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("pharmacyOffice.coldChain.lead")}</p>
        </div>
        {mayManage && <Button type="button" variant="outline" data-testid="cold-add-unit" onClick={() => setEditing("new")}>{t("pharmacyOffice.coldChain.addUnit")}</Button>}
      </div>
      {units.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(units.error, t)}</p>}
      {notice !== null && <p role="status" className={`text-sm ${notice.red ? "text-red-700" : "text-green-700"}`} data-testid="cold-notice">{notice.text}</p>}
      {units.data !== undefined && items.length === 0 && <p className="text-sm text-muted-foreground" data-testid="cold-empty">{t("pharmacyOffice.coldChain.empty")}</p>}
      {items.length > 0 && (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="cold-units">
          {items.map((u) => (
            <li key={u.id} className={`min-w-0 rounded border p-3 ${selected === u.id ? "border-emerald-700" : ""} ${u.openExcursion !== null ? "bg-red-50/60" : ""}`} data-testid={`cold-unit-${u.label}`}>
              <button type="button" className="w-full text-left" aria-current={selected === u.id ? "true" : undefined} onClick={() => setSelected(u.id)}>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{u.label}</span>
                  <span className="text-xs text-muted-foreground">{u.store.code} · {t("pharmacyOffice.coldChain.range", { low: u.lowC, high: u.highC })}</span>
                  {!u.active && <span className="pill">{t("pharmacyOffice.coldChain.inactive")}</span>}
                </span>
                {u.openExcursion !== null && (
                  <span className="pill rd mt-1 inline-block" data-testid={`cold-excursion-${u.label}`}>
                    {t("pharmacyOffice.coldChain.excursionOpen", { no: u.openExcursion.no, count: u.openExcursion.batches })}
                  </span>
                )}
                <span className="mt-2 flex flex-wrap gap-2">
                  {u.slots.map((s) => (
                    <span key={s.slot} className={slotCls[s.state] ?? "pill"} data-testid={`cold-slot-${u.label}-${s.slot}`}>
                      {t("pharmacyOffice.coldChain.slotLabel", { slot: s.slot, state: t(`pharmacyOffice.coldChain.slot.${s.state}`) })}
                    </span>
                  ))}
                </span>
                <span className="mt-2 block truncate text-xs text-muted-foreground">
                  {u.lastReading === null
                    ? t("pharmacyOffice.coldChain.never")
                    : t("pharmacyOffice.coldChain.last", { when: when(u.lastReading.takenAt), c: u.lastReading.currentC, min: u.lastReading.minC, max: u.lastReading.maxC })}
                </span>
              </button>
              <div className="mt-2 flex flex-wrap gap-2">
                {mayRecord && u.active && (
                  <Button type="button" size="sm" data-testid={`cold-record-${u.label}`} onClick={() => { setNotice(null); setRecording(u); }}>{t("pharmacyOffice.coldChain.record")}</Button>
                )}
                {mayManage && <Button type="button" size="sm" variant="outline" onClick={() => setEditing(u)}>{t("pharmacyOffice.coldChain.editUnit")}</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ExcursionPanel mayManage={mayManage} />
      {current !== null && <ReadingHistory unit={current} />}
      {recording !== null && (
        <Sheet title={`${t("pharmacyOffice.coldChain.record")} · ${recording.label}`} testId="cold-record-sheet" onClose={() => setRecording(null)}>
          <RecordReadingForm unit={recording} onDone={(text, red) => { setRecording(null); setNotice({ text, red }); }} />
        </Sheet>
      )}
      {editing !== null && (
        <Sheet title={editing === "new" ? t("pharmacyOffice.coldChain.addUnit") : `${t("pharmacyOffice.coldChain.editUnit")} · ${editing.label}`} testId="cold-unit-sheet" onClose={() => setEditing(null)}>
          <UnitForm unit={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
        </Sheet>
      )}
    </div>
  );
}

function RecordReadingForm({ unit, onDone }: { unit: WireColdUnit; onDone: (text: string, red: boolean) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [key] = useState(() => newIdempotencyKey());
  const [cur, setCur] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [note, setNote] = useState("");
  const values = [parseCelsius(cur), parseCelsius(min), parseCelsius(max)];
  const ready = values.every((v) => v !== null);
  const ordered = ready && values[1]! <= values[0]! && values[0]! <= values[2]!;
  const warn = ready && isOutOfRange(unit, values as number[]);
  const m = useMutation({
    mutationFn: () => recordColdReading({ unitId: unit.id, currentC: values[0]!, minC: values[1]!, maxC: values[2]!, note: note.trim() === "" ? null : note.trim() }, key),
    onSuccess: async (out) => {
      await qc.invalidateQueries({ queryKey: ["pharmacy", "cold-chain"] });
      if (out.opened !== null) onDone(t("pharmacyOffice.coldChain.recordedOpened", { no: out.opened.no, count: out.opened.batches }), true);
      else onDone(t("pharmacyOffice.coldChain.recorded"), false);
    },
  });
  const field = (label: string, v: string, set: (s: string) => void, testId: string): React.ReactElement => (
    <label className="text-sm">{label}
      <Input inputMode="decimal" autoComplete="off" data-testid={testId} value={v} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <form className="space-y-3" data-testid="cold-record-form" onSubmit={(e) => { e.preventDefault(); if (ordered) m.mutate(); }}>
      <p className="text-sm text-muted-foreground">{unit.store.name} · {t("pharmacyOffice.coldChain.range", { low: unit.lowC, high: unit.highC })}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {field(t("pharmacyOffice.coldChain.f.current"), cur, setCur, "cold-current")}
        {field(t("pharmacyOffice.coldChain.f.min"), min, setMin, "cold-min")}
        {field(t("pharmacyOffice.coldChain.f.max"), max, setMax, "cold-max")}
      </div>
      <label className="block text-sm">{t("pharmacyOffice.coldChain.f.note")}
        <textarea className={areaCls} data-testid="cold-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {ready && !ordered && <p role="alert" className="text-sm text-red-600">{t("pharmacyOffice.coldChain.notOrdered")}</p>}
      {warn && ordered && <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="cold-warn">{t("pharmacyOffice.coldChain.willHold")}</p>}
      {m.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(m.error, t)}</p>}
      <Button type="submit" data-testid="cold-record-save" disabled={!ordered || m.isPending}>{t("pharmacyOffice.coldChain.save")}</Button>
    </form>
  );
}

function UnitForm({ unit, onDone }: { unit: WireColdUnit | null; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const stores = useQuery({ queryKey: ["pharmacy", "cold-chain", "stores"], queryFn: () => fetchColdStores(), enabled: unit === null });
  const [storeId, setStoreId] = useState("");
  const [label, setLabel] = useState(unit?.label ?? "");
  const [low, setLow] = useState(unit?.lowC ?? "2.0");
  const [high, setHigh] = useState(unit?.highC ?? "8.0");
  const [active, setActive] = useState(unit?.active ?? true);
  const lowN = parseCelsius(low);
  const highN = parseCelsius(high);
  const ready = label.trim() !== "" && lowN !== null && highN !== null && lowN < highN && (unit !== null || storeId !== "");
  const m = useMutation({
    mutationFn: () => {
      const body = { label: label.trim(), lowC: lowN!, highC: highN!, active };
      return unit === null ? addColdUnit({ ...body, storeResourceId: storeId }) : editColdUnit(unit.id, body);
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["pharmacy", "cold-chain"] }); onDone(); },
  });
  return (
    <form className="space-y-3" data-testid="cold-unit-form" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      {unit === null && (
        <label className="block text-sm">{t("pharmacyOffice.coldChain.f.store")}
          <select className={selectCls} data-testid="cold-unit-store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">—</option>
            {(stores.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
          </select>
        </label>
      )}
      <label className="block text-sm">{t("pharmacyOffice.coldChain.f.label")}
        <Input autoComplete="off" data-testid="cold-unit-label" value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm">{t("pharmacyOffice.coldChain.f.low")}
          <Input inputMode="decimal" data-testid="cold-unit-low" value={low} onChange={(e) => setLow(e.target.value)} />
        </label>
        <label className="text-sm">{t("pharmacyOffice.coldChain.f.high")}
          <Input inputMode="decimal" data-testid="cold-unit-high" value={high} onChange={(e) => setHigh(e.target.value)} />
        </label>
      </div>
      {unit !== null && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" data-testid="cold-unit-active" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {t("pharmacyOffice.coldChain.f.active")}
        </label>
      )}
      {m.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(m.error, t)}</p>}
      <Button type="submit" data-testid="cold-unit-save" disabled={!ready || m.isPending}>{t("pharmacyOffice.coldChain.saveUnit")}</Button>
    </form>
  );
}

function ReadingHistory({ unit }: { unit: WireColdUnit }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["pharmacy", "cold-chain", "readings", unit.id], queryFn: () => fetchColdReadings(unit.id, 7) });
  const rows = q.data?.items ?? [];
  return (
    <section className="min-w-0 rounded border p-3" data-testid="cold-history">
      <h3 className="mb-2 text-sm font-semibold">{t("pharmacyOffice.coldChain.history", { label: unit.label })}</h3>
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(q.error, t)}</p>}
      {q.data !== undefined && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("pharmacyOffice.coldChain.historyEmpty")}</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2 font-normal">{t("pharmacyOffice.coldChain.f.takenAt")}</th>
                <th className="py-1 pr-2 font-normal">{t("pharmacyOffice.coldChain.f.current")}</th>
                <th className="py-1 pr-2 font-normal">{t("pharmacyOffice.coldChain.f.min")}</th>
                <th className="py-1 pr-2 font-normal">{t("pharmacyOffice.coldChain.f.max")}</th>
                <th className="py-1 pr-2 font-normal">{t("pharmacyOffice.coldChain.f.by")}</th>
                <th className="py-1 font-normal">{t("pharmacyOffice.coldChain.f.note")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`border-t ${r.outOfRange ? "text-red-700" : ""}`} data-testid={`cold-reading-${r.id}`}>
                  <td className="py-1 pr-2 whitespace-nowrap">{when(r.takenAt)}</td>
                  <td className="py-1 pr-2 font-mono">{r.currentC}</td>
                  <td className="py-1 pr-2 font-mono">{r.minC}</td>
                  <td className="py-1 pr-2 font-mono">{r.maxC}{r.outOfRange ? ` · ${t("pharmacyOffice.coldChain.outOfRange")}` : ""}</td>
                  <td className="py-1 pr-2">{r.takenByName ?? "—"}</td>
                  <td className="py-1">{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ExcursionPanel({ mayManage }: { mayManage: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["pharmacy", "cold-chain", "excursions"], queryFn: () => fetchColdExcursions(false) });
  const rows = q.data?.items ?? [];
  const open = rows.filter((x) => x.closed === null);
  const closed = rows.filter((x) => x.closed !== null).slice(0, 5);
  return (
    <section className="space-y-3 rounded border p-3" data-testid="cold-excursions">
      <h3 className="text-sm font-semibold">{t("pharmacyOffice.coldChain.ex.title")}</h3>
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(q.error, t)}</p>}
      {q.data !== undefined && open.length === 0 && <p className="text-sm text-muted-foreground" data-testid="cold-excursions-none">{t("pharmacyOffice.coldChain.ex.none")}</p>}
      {open.map((x) => <ExcursionCard key={x.id} x={x} mayManage={mayManage} />)}
      {closed.map((x) => <ExcursionCard key={x.id} x={x} mayManage={false} />)}
    </section>
  );
}

function ExcursionCard({ x, mayManage }: { x: WireColdExcursion; mayManage: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [choice, setChoice] = useState<Record<string, { decision: ColdDecision | null; reason: string }>>({});
  const [note, setNote] = useState("");
  const set = (batchId: string, patch: Partial<{ decision: ColdDecision | null; reason: string }>): void =>
    setChoice((c) => ({ ...c, [batchId]: { decision: c[batchId]?.decision ?? null, reason: c[batchId]?.reason ?? "", ...patch } }));
  const complete = x.batches.every((b) => {
    const c = choice[b.batchId];
    return c !== undefined && c.decision !== null && (c.decision === "write_off" || c.reason.trim() !== "");
  });
  const m = useMutation({
    mutationFn: () => closeColdExcursion(x.id, {
      decisions: x.batches.map((b) => {
        const c = choice[b.batchId]!;
        return c.decision === "release" ? { batchId: b.batchId, decision: "release" as const, reason: c.reason.trim() } : { batchId: b.batchId, decision: "write_off" as const };
      }),
      note: note.trim() === "" ? null : note.trim(),
    }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["pharmacy", "cold-chain"] }); },
  });
  const open = x.closed === null;
  return (
    <article className={`min-w-0 space-y-2 rounded border p-3 ${open ? "border-red-300" : ""}`} data-testid={`cold-ex-${x.no}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">{x.no}</span>
        <span className="font-medium">{x.unit.label}</span>
        <span className="text-xs text-muted-foreground">{x.store.code}</span>
        <span className={open ? "pill rd" : "pill"}>{open ? t("pharmacyOffice.coldChain.ex.open") : t("pharmacyOffice.coldChain.ex.closedPill")}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("pharmacyOffice.coldChain.ex.opened", { when: when(x.openedAt), c: x.reading.currentC, min: x.reading.minC, max: x.reading.maxC, low: x.lowC, high: x.highC })}
      </p>
      {x.batches.length === 0 && <p className="text-sm">{t("pharmacyOffice.coldChain.ex.noBatches")}</p>}
      <ul className="divide-y rounded border empty:hidden">
        {x.batches.map((b) => {
          const c = choice[b.batchId];
          return (
            <li key={b.batchId} className="space-y-1 px-3 py-2 text-sm" data-testid={`cold-ex-batch-${b.batchNo}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{b.itemName} · {b.batchNo}{b.expiryDate === null ? "" : ` · ${b.expiryDate}`} · {b.qtyOnHand}</span>
                {b.decision !== null && <span className={b.decision.decision === "write_off" ? "pill rd" : "pill on"}>{t(`pharmacyOffice.coldChain.decision.${b.decision.decision}`)}{b.decision.reason === null ? "" : ` — ${b.decision.reason}`}</span>}
                {open && mayManage && (
                  <span className="flex gap-3">
                    {(["release", "write_off"] as const).map((d) => (
                      <label key={d} className="flex items-center gap-1">
                        <input type="radio" name={`d-${x.id}-${b.batchId}`} data-testid={`cold-decide-${b.batchNo}-${d}`} checked={c?.decision === d} onChange={() => set(b.batchId, { decision: d })} />
                        {t(`pharmacyOffice.coldChain.ex.${d === "release" ? "release" : "writeOff"}`)}
                      </label>
                    ))}
                  </span>
                )}
              </div>
              {open && mayManage && c?.decision === "release" && (
                <Input autoComplete="off" data-testid={`cold-reason-${b.batchNo}`} placeholder={t("pharmacyOffice.coldChain.ex.reason")} value={c.reason} onChange={(e) => set(b.batchId, { reason: e.target.value })} />
              )}
            </li>
          );
        })}
      </ul>
      {open && mayManage && (
        <form className="grid items-end gap-2 sm:grid-cols-[1fr_auto]" onSubmit={(e) => { e.preventDefault(); if (complete) m.mutate(); }}>
          <label className="text-sm">{t("pharmacyOffice.coldChain.ex.note")}
            <Input autoComplete="off" data-testid={`cold-ex-note-${x.no}`} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <Button type="submit" data-testid={`cold-ex-close-${x.no}`} disabled={!complete || m.isPending}>{t("pharmacyOffice.coldChain.ex.close")}</Button>
        </form>
      )}
      {open && !mayManage && <p className="text-xs text-muted-foreground">{t("pharmacyOffice.coldChain.ex.callInCharge")}</p>}
      {x.closed !== null && (
        <p className="text-xs text-muted-foreground">{t("pharmacyOffice.coldChain.ex.closed", { when: when(x.closed.closedAt), by: x.closed.closedByName ?? "—" })}{x.closed.note === null ? "" : ` — ${x.closed.note}`}</p>
      )}
      {m.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(m.error, t)}</p>}
    </article>
  );
}
