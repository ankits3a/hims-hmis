import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { UNLOCK_REASONS, amendVitals, fetchVitalsRow, opdErrorMessage } from "../lib/opd-api";
import { AMEND_KEYS, AMEND_REASONS, amendedReadings, diffOf } from "../../../../packages/contracts/src/vitals-entry";
import type { Change } from "../../../../packages/contracts/src/vitals-entry";
import type { WireBenchRow, WireUnlockReason, WireVitalKey, WireVitals, WireVitalsAmendBody, WireVitalsAmendResult, WireVitalsGate } from "../lib/opd-api";
import { istClock } from "./vitals-bay-capture";

/**
 * VD-2 T4 — AMEND AFTER SAVE (story 7, owner ruling 4: "a wrong entry is fixable at the desk").
 *
 * ═══ WORKS ON A COPY (phase doc D6) ═══
 *
 * The saved chart is read (`GET /opd/vitals/:id` — the row a nurse may amend she may read, the
 * CLOSE's rule after T0/F6) and edited in a copy held here; nothing reaches the server until the
 * reason is typed and the button pressed. Escape abandons the copy and nothing else — the saved
 * chart is byte-identical, which the assertion book checks by re-opening it. The server writes a
 * NEW row that supersedes the old one (VD-1 D2), so the old value is never lost: the diff painted
 * after the save is the one the doctor sees in the trail, with the name and the clock.
 *
 * ═══ THE PAIR SURVIVES THE CORRECTION (CLOSE pass 1 MAJOR) ═══
 *
 * A flat body of nine scalars made the server synthesise one typed take per vital, so the ACTIVE
 * row lost the rest-and-recheck pair, the held probe value, the device source and the override
 * notes — "never overwritten" held only on the superseded row. The amendment now posts the prior
 * row's `readings` with the corrected value REPLACING the operative take of each changed key, and
 * the prior notes, carried keys, overrides and unlock reasons ride along; a carried key the nurse
 * changes needs a preset reason (D7 holds on amend, T0/F1), and a gate the server raises again is
 * answered with the same confirm the first save had.
 */
// The rules of a correction — which scalars, the six preset reasons, the diff and the readings that
// travel with it — live in the ONE file the phone's bay also imports (mobile §3i, 2026-10-07), so the
// two bays cannot build a different amendment from the same chart. Re-exported so nothing that
// imported them from here changes.
export { AMEND_KEYS, AMEND_REASONS, amendedReadings, diffOf } from "../../../../packages/contracts/src/vitals-entry";
export type { Change } from "../../../../packages/contracts/src/vitals-entry";

export function activeChart(items: WireVitals[], vitalsId: string | null): WireVitals | null {
  const active = items.filter((v) => v.status === "active");
  return (vitalsId === null ? null : active.find((v) => v.id === vitalsId) ?? null) ?? active[active.length - 1] ?? null;
}


export type Amended = { result: WireVitalsAmendResult; changes: Change[]; prior: WireVitals };

export function AmendPanel({ row, onAmended }: { row: WireBenchRow; onAmended: (a: Amended) => void }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ["vitals-bay", "chart", row.vitalsId ?? ""],
    queryFn: () => fetchVitalsRow(row.vitalsId ?? ""),
    enabled: row.vitalsId !== null,
  });
  const chart = useMemo(() => (q.data?.vitals.status === "active" ? q.data.vitals : null), [q.data]);
  const [copy, setCopy] = useState<{ ofId: string; values: Record<WireVitalKey, string> } | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState<WireVitalKey[]>([]);
  const [unlocks, setUnlocks] = useState<Partial<Record<WireVitalKey, WireUnlockReason>>>({});
  const [gates, setGates] = useState<WireVitalsGate[]>([]);
  const [overrides, setOverrides] = useState<Partial<Record<WireVitalKey, string>>>({});

  // The copy is taken ONCE per chart; a re-read of the same chart does not overwrite the nurse's typing.
  useEffect(() => {
    if (chart === null) return;
    setCopy((prev) => prev ?? { ofId: chart.id, values: Object.fromEntries(AMEND_KEYS.map((k) => [k, chart[k] === null ? "" : String(chart[k])])) as Record<WireVitalKey, string> });
  }, [chart]);

  if (q.isError || (row.vitalsId !== null && q.data !== undefined && chart === null)) return <p role="alert" data-testid="amend-failed">{t("vitalsBay.amend.readFailed")}</p>;
  if (chart === null || copy === null) return <p data-testid="amend-loading">{t("app.loading")}</p>;
  // Another bay amended this chart while the copy was open: the copy is stale and must not be posted.
  if (copy.ofId !== chart.id) return <p role="alert" data-testid="amend-stale">{t("vitalsBay.amend.stale")}</p>;

  const carried = (chart.carriedForward as WireVitalKey[] | undefined) ?? [];
  const changed = AMEND_KEYS.filter((k) => copy.values[k] !== (chart[k] === null ? "" : String(chart[k])));
  const needsReason = changed.filter((k) => carried.includes(k) && unlocks[k] === undefined);

  const submit = async (): Promise<void> => {
    if (reason.trim() === "") { setError(t("vitalsBay.amend.reasonRequired")); return; }
    if (needsReason.length > 0) { setLocked(needsReason); return; }
    const next: Partial<Record<WireVitalKey, number | null>> = {};
    for (const k of AMEND_KEYS) {
      const raw = copy.values[k].trim();
      if (raw === "") { next[k] = null; continue; }
      if (!/^\d+(\.\d+)?$/.test(raw)) { setError(t("vitalsBay.capture.notANumber")); return; }
      next[k] = Number(raw);
    }
    const body: WireVitalsAmendBody = {
      ...next, reason: reason.trim(), emergency: chart.emergency, notes: chart.notes,
      readings: amendedReadings(chart, next),
      contextChips: Array.isArray(chart.contextChips) ? (chart.contextChips as { key: string; question: string; answer: string }[]) : [],
      carriedForward: carried.filter((k) => !changed.includes(k)),
    };
    if (Object.keys(unlocks).length > 0) body.unlockReasons = unlocks;
    if (Object.keys(overrides).length > 0) body.overrides = overrides;
    setBusy(true); setError(null);
    try {
      const result = await amendVitals(chart.id, body);
      onAmended({ result, changes: diffOf(chart, result.vitals), prior: chart });
    } catch (e) {
      if (e instanceof ApiError) {
        const b = e.body as { code?: string; detail?: { gates?: WireVitalsGate[]; locked?: { key: WireVitalKey }[] } } | null;
        if (b?.code === "vitals_gate" && b.detail?.gates !== undefined) { setGates(b.detail.gates); return; }
        if (b?.code === "carried_value_locked" && b.detail?.locked !== undefined) { setLocked(b.detail.locked.map((l) => l.key)); return; }
      }
      setError(opdErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmGate = (g: WireVitalsGate): void => {
    const reasonKey = g.kind === "slipped_digit" ? "confirmed_real" : g.kind === "shrinking_adult" ? "confirmed_after_remeasure" : "confirmed_reclip";
    setOverrides((o) => ({ ...o, [g.key]: reasonKey, ...(g.key === "sbp" || g.key === "dbp" ? { sbp: reasonKey, dbp: reasonKey } : {}) }));
    setGates((gs) => gs.filter((x) => x !== g));
  };

  return (
    <div data-testid="amend" data-vitals={chart.id} className="flex flex-col gap-2">
      <p className="text-sm font-semibold">{t("vitalsBay.amend.title", { at: istClock(chart.recordedAt) })}</p>
      <p className="text-xs text-muted-foreground">{t("vitalsBay.amend.hint")}</p>
      <div className="grid grid-cols-3 gap-2" data-testid="amend-fields">
        {AMEND_KEYS.map((k) => (
          <label key={k} className="flex flex-col gap-0.5 text-xs">
            <span className="text-muted-foreground">
              {t(`vitalsBay.vital.${k}`)}{carried.includes(k) ? ` · ${t("vitalsBay.amend.carried")}` : ""}{chart[k] !== null && copy.values[k] !== String(chart[k]) ? ` · ${t("vitalsBay.amend.was", { value: chart[k] })}` : ""}
            </span>
            <input
              data-testid={`amend-${k}`} inputMode="decimal" className="rounded border border-input bg-card px-2 py-1 font-mono text-sm"
              value={copy.values[k]} onChange={(e) => setCopy((c) => (c === null ? c : { ...c, values: { ...c.values, [k]: e.target.value } }))}
            />
            {locked.includes(k) && (
              <select
                aria-label={t("vitalsBay.unlock.label")} data-testid={`amend-unlock-${k}`} className="rounded border border-input bg-card px-1 py-0.5 text-xs"
                value={unlocks[k] ?? ""} onChange={(e) => { if (e.target.value !== "") { setUnlocks((u) => ({ ...u, [k]: e.target.value as WireUnlockReason })); setLocked((l) => l.filter((x) => x !== k)); } }}
              >
                <option value="">{t("vitalsBay.unlock.pick")}</option>
                {UNLOCK_REASONS.map((r) => <option key={r} value={r}>{t(`vitalsBay.unlock.reason.${r}`)}</option>)}
              </select>
            )}
          </label>
        ))}
      </div>
      {gates.map((g) => (
        <div key={`${g.key}-${g.kind}`} role="alertdialog" data-testid={`amend-gate-${g.key}`} className="flex flex-wrap items-center gap-2 rounded border border-destructive p-2 text-sm">
          <span>{g.message}</span>
          <button type="button" data-testid={`amend-gate-confirm-${g.key}`} className="rounded border px-2" onClick={() => confirmGate(g)}>{t("vitalsBay.gate.confirm")}</button>
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <span style={{ fontSize: 11, color: "var(--dim)" }}>{t("vitalsBay.amend.reason")}</span>
        {/*
          One tap, not a sentence. The chip WRITES the box rather than replacing it, so the nurse
          can tap the near-miss and edit the last two words — and a mis-tap is undone by tapping
          again, which clears it, exactly like the context chips upstairs.
        */}
        <div data-testid="amend-reason-presets" style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {AMEND_REASONS.map((r) => {
            const on = reason === r.text;
            return (
              <button
                key={r.key} type="button" data-testid={`amend-reason-${r.key}`} data-on={on ? "true" : "false"}
                className={on ? "pri" : "sec"} style={{ padding: "2px 8px", fontSize: 11.5 }}
                onClick={() => { setReason(on ? "" : r.text); setError(null); }}
              >
                {t(`vitalsBay.amend.reasonPreset.${r.key}`)}
              </button>
            );
          })}
        </div>
        <input
          aria-label={t("vitalsBay.amend.reason")} data-testid="amend-reason" className="in" style={{ fontSize: 13, padding: "4px 7px" }}
          placeholder={t("vitalsBay.amend.reasonPlaceholder")}
          value={reason} onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {error !== null && <p role="alert" data-testid="amend-error">{error}</p>}
      {/*
        THE SAVE WAS A BUTTON THAT LOOKED LIKE A SENTENCE. It carried `bg-primary px-3 py-1`, and
        under this seat those tokens resolve to nothing — the owner measured it at the bay:
        `background: rgba(0,0,0,0)`, `border: 0px none`, `padding: 0px`. A control that commits a
        correction to a clinical chart must look like a control, so it wears the same `pri` the
        bay's own "Save & send" wears, and the panel stops speaking a second dialect of CSS.
      */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <button type="button" data-testid="amend-save" disabled={busy || changed.length === 0} className="pri" onClick={() => { void submit(); }}>
          {t("vitalsBay.amend.save", { count: changed.length })}
        </button>
        <span style={{ fontSize: 11, color: "var(--dim)" }}>{t("vitalsBay.amend.escHint")}</span>
      </div>
    </div>
  );
}

/**
 * WHO CHANGED IT, BY NAME. The trail used to be handed `by={actor?.id}` — the signed-in ULID — and
 * printed `by 01M1R6FXR0AQN3BNA8Q8K0ESM6` at a nurse. The name now comes off the SAVED ROW, which
 * is the only thing that knows whose amendment this was: a prop the caller derives is a prop the
 * next caller derives differently, and this one had already gone wrong once.
 */
export function AmendTrail({ amended }: { amended: Amended }): React.ReactElement {
  const { t } = useTranslation();
  const by = amended.result.vitals.recordedByName;
  const at = istClock(amended.result.vitals.recordedAt);
  return (
    <ul data-testid="amend-trail" className="text-sm">
      {amended.changes.map((c) => (
        <li key={c.key} data-testid={`trail-${c.key}`}>
          {t(`vitalsBay.vital.${c.key}`)}: {c.from ?? "—"} → <b>{c.to ?? "—"}</b> · {t("vitalsBay.amend.trail", { by, at })}
        </li>
      ))}
    </ul>
  );
}
