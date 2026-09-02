import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { amendVitals, fetchVisitVitals, opdErrorMessage } from "../lib/opd-api";
import type { WireBenchRow, WireVitalKey, WireVitals, WireVitalsAmendResult } from "../lib/opd-api";
import { istClock } from "./vitals-bay-capture";

/**
 * VD-2 T4 — AMEND AFTER SAVE (story 7, owner ruling 4: "a wrong entry is fixable at the desk").
 *
 * ═══ WORKS ON A COPY (phase doc D6) ═══
 *
 * The saved chart is read (`GET /opd/visits/:id/vitals`, the ACTIVE row) and edited in a copy held
 * here; nothing reaches the server until the reason is typed and the button pressed. Escape
 * abandons the copy and nothing else — the saved chart is byte-identical, which is what the
 * assertion book checks by re-opening it. The server writes a NEW row that supersedes the old
 * one (VD-1 D2), so the old value is never lost: the diff painted after the save is the one the
 * doctor sees in the trail, with the name and the clock.
 *
 * The diff is computed HERE from the two rows because `amendVitals` returns the new row, not the
 * diff (spike S6); it is the same nine scalars `changedFields` compares on the server.
 */
export const AMEND_KEYS: readonly WireVitalKey[] = ["heightCm", "weightKg", "sbp", "dbp", "pulse", "rr", "spo2", "tempC", "muacCm"];

export type Change = { key: WireVitalKey; from: number | null; to: number | null };
export function diffOf(prior: Pick<WireVitals, WireVitalKey>, next: Pick<WireVitals, WireVitalKey>): Change[] {
  const out: Change[] = [];
  for (const k of AMEND_KEYS) {
    if (prior[k] !== next[k]) out.push({ key: k, from: prior[k], to: next[k] });
  }
  return out;
}

export function activeChart(items: WireVitals[], vitalsId: string | null): WireVitals | null {
  const active = items.filter((v) => v.status === "active");
  return (vitalsId === null ? null : active.find((v) => v.id === vitalsId) ?? null) ?? active[active.length - 1] ?? null;
}

export type Amended = { result: WireVitalsAmendResult; changes: Change[]; prior: WireVitals };

export function AmendPanel({ row, onAmended }: { row: WireBenchRow; onAmended: (a: Amended) => void }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["vitals-bay", "chart", row.encounterId], queryFn: () => fetchVisitVitals(row.encounterId) });
  const chart = useMemo(() => activeChart(q.data?.items ?? [], row.vitalsId), [q.data, row.vitalsId]);
  const [copy, setCopy] = useState<Record<WireVitalKey, string> | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The copy is taken ONCE per chart; a re-read of the same chart does not overwrite the nurse's typing.
  useEffect(() => {
    if (chart === null) return;
    setCopy((prev) => prev ?? (Object.fromEntries(AMEND_KEYS.map((k) => [k, chart[k] === null ? "" : String(chart[k])])) as Record<WireVitalKey, string>));
  }, [chart]);

  if (q.isError) return <p role="alert" data-testid="amend-failed">{t("vitalsBay.amend.readFailed")}</p>;
  if (chart === null || copy === null) return <p data-testid="amend-loading">{t("app.loading")}</p>;

  const changed = AMEND_KEYS.filter((k) => copy[k] !== (chart[k] === null ? "" : String(chart[k])));

  const submit = async (): Promise<void> => {
    if (reason.trim() === "") { setError(t("vitalsBay.amend.reasonRequired")); return; }
    const body: Record<string, unknown> = { reason: reason.trim(), emergency: chart.emergency };
    for (const k of AMEND_KEYS) {
      const raw = copy[k].trim();
      if (raw === "") { body[k] = null; continue; }
      if (!/^\d+(\.\d+)?$/.test(raw)) { setError(t("vitalsBay.capture.notANumber")); return; }
      body[k] = Number(raw);
    }
    setBusy(true); setError(null);
    try {
      const result = await amendVitals(chart.id, body as never);
      onAmended({ result, changes: diffOf(chart, result.vitals), prior: chart });
    } catch (e) {
      setError(opdErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="amend" data-vitals={chart.id} className="flex flex-col gap-2">
      <p className="text-sm font-semibold">{t("vitalsBay.amend.title", { at: istClock(chart.recordedAt) })}</p>
      <p className="text-xs text-muted-foreground">{t("vitalsBay.amend.hint")}</p>
      <div className="grid grid-cols-3 gap-2" data-testid="amend-fields">
        {AMEND_KEYS.map((k) => (
          <label key={k} className="flex flex-col gap-0.5 text-xs">
            <span className="text-muted-foreground">{t(`vitalsBay.vital.${k}`)}{chart[k] !== null && copy[k] !== String(chart[k]) ? ` · ${t("vitalsBay.amend.was", { value: chart[k] })}` : ""}</span>
            <input
              data-testid={`amend-${k}`} inputMode="decimal" className="rounded border border-input bg-card px-2 py-1 font-mono text-sm"
              value={copy[k]} onChange={(e) => setCopy((c) => (c === null ? c : { ...c, [k]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <label className="flex flex-col gap-0.5 text-xs">
        <span className="text-muted-foreground">{t("vitalsBay.amend.reason")}</span>
        <input data-testid="amend-reason" className="rounded border border-input bg-card px-2 py-1 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error !== null && <p role="alert" data-testid="amend-error">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="button" data-testid="amend-save" disabled={busy || changed.length === 0} className="rounded bg-primary px-3 py-1 text-primary-foreground" onClick={() => { void submit(); }}>
          {t("vitalsBay.amend.save", { count: changed.length })}
        </button>
        <span className="text-xs text-muted-foreground">{t("vitalsBay.amend.escHint")}</span>
      </div>
    </div>
  );
}

export function AmendTrail({ amended, by }: { amended: Amended; by: string }): React.ReactElement {
  const { t } = useTranslation();
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
