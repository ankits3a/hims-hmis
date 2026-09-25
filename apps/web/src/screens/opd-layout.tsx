import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../lib/api";
import { opdErrorMessage } from "../lib/opd-api";
import type { WireDepartment } from "../lib/opd-api";
import { DeskModal } from "../components/desk-modal";
import {
  DeskTBody, DeskTD, DeskTH, DeskTHead, DeskTR, DeskTable,
} from "../components/desk-fields";

/**
 * ═══ THE CONSULT LAYOUT BUILDER (board `Profiles`, approved 2026-09-23; 01-CONSULT-ENGINE.md §3) ═══
 *
 * Three surfaces over one server resolver (`apps/core/src/modules/opd/layout.ts`):
 *   · the ADMIN's department default (opd-admin.tsx, "Consult layout") — order, Shown, Mandatory;
 *   · the DOCTOR's own layout (the consult's ⋯ menu, "My layout") — order, and Hide on a section
 *     that is not mandatory;
 *   · the CONSULT itself, whose tabs follow `GET /opd/visits/:id/layout`.
 *
 * NOTHING HERE DECIDES A RULE. Which sections are locked, mandatory or hidden by the admin arrives
 * from the server on every read (`locked`, `mandatory`, `adminHidden`), so no list of section keys
 * has to be kept in step with the core — the controls only draw what the server said and send it
 * back, and the server refuses whatever breaks a rule. The board's COLLAPSED, ON PRINT and COPILOT
 * columns are a later slice and are not drawn.
 */

export type LayoutKey = "vitals" | "eye" | "complaints" | "exam" | "dx" | "inv" | "rx" | "treat" | "advice" | "notes";
export type WireVisitLayout = { sections: { key: LayoutKey; mandatory: boolean }[]; defaultVersion: number | null; overlayVersion: number | null };
export type WireLayoutChange =
  | { kind: "hidden" | "shown" | "mandatory" | "optional"; key: LayoutKey }
  | { kind: "moved"; key: LayoutKey; above: LayoutKey | null; below: LayoutKey | null };
export type WireLayoutAudit = { version: number; by: string; byName: string; at: string; changes: WireLayoutChange[]; summary: string };
export type WireDepartmentLayout = {
  departmentId: string; departmentName: string; version: number | null;
  sections: { key: LayoutKey; shown: boolean; mandatory: boolean; locked: boolean }[];
  audit: WireLayoutAudit[];
};
export type WireMyLayout = {
  departmentId: string; departmentName: string; version: number | null; defaultVersion: number | null;
  sections: { key: LayoutKey; mandatory: boolean; hidden: boolean }[];
  adminHidden: LayoutKey[];
  audit: WireLayoutAudit[];
};

export const fetchVisitLayout = (encounterId: string): Promise<WireVisitLayout> => api("GET", `/opd/visits/${encounterId}/layout`);
const fetchDepartmentLayout = (departmentId: string): Promise<WireDepartmentLayout> => api("GET", `/opd/layouts/${departmentId}`);
const fetchMyLayout = (): Promise<WireMyLayout> => api("GET", "/opd/me/layout");

/**
 * The consult's tabs in the layout's order: `summary` first always, then every section the layout
 * names that this screen has a tab for. NO LAYOUT (not loaded, or the read failed) IS TODAY'S ORDER —
 * the screen must never lose a tab because a read failed.
 */
export function applyLayout<T extends string>(options: readonly (readonly [T, string])[], layout: WireVisitLayout | undefined): (readonly [T, string])[] {
  if (layout === undefined) return [...options];
  const byKey = new Map<string, readonly [T, string]>(options.map((o) => [o[0], o]));
  const out: (readonly [T, string])[] = [];
  const summary = byKey.get("summary");
  if (summary !== undefined) out.push(summary);
  for (const s of layout.sections) {
    const o = byKey.get(s.key);
    if (o !== undefined && o !== summary) out.push(o);
  }
  return out;
}

/** The work strip's rows in the same order, without the sections the layout leaves off. */
export function orderRows<R extends { id: string }>(rows: readonly R[], layout: WireVisitLayout | undefined): R[] {
  if (layout === undefined) return [...rows];
  return layout.sections.flatMap((s) => rows.filter((r) => r.id === s.key));
}

/** A section's name — the consult tab's own label, so the builder and the screen never disagree. */
export function sectionLabel(t: TFunction, key: string): string {
  const k: Record<string, string> = {
    vitals: "opdConsultV2.tabs.vitals", eye: "opdEye.tab", complaints: "opdConsultV2.tabs.complaints",
    exam: "opdConsultV2.tabs.exam", dx: "opdConsultV2.tabs.dx", inv: "opdConsultV2.tabs.inv", rx: "opdConsult.tabs.rx",
    treat: "opdConsultV2.tabs.treat", advice: "opdConsultV2.tabs.advice", notes: "opdConsultV2.tabs.notes",
  };
  return k[key] === undefined ? key : t(k[key]!);
}

function changeText(t: TFunction, c: WireLayoutChange): string {
  const name = sectionLabel(t, c.key);
  if (c.kind !== "moved") return t(`opdLayout.change.${c.kind}`, { name });
  if (c.above !== null) return t("opdLayout.change.movedAbove", { name, other: sectionLabel(t, c.above) });
  return t("opdLayout.change.movedBelow", { name, other: sectionLabel(t, c.below ?? "") });
}

const fmtAt = (iso: string): string =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

/** The AUDIT block — newest first, who and what, and the board's promise about old visits. */
function AuditList({ audit, testId }: { audit: WireLayoutAudit[]; testId: string }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <h3 className="tag" style={{ margin: 0 }}>{t("opdLayout.audit")}</h3>
      {audit.length === 0 && <p style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>{t("opdLayout.auditEmpty")}</p>}
      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
        {audit.map((a) => (
          <li key={a.version} data-testid={`${testId}-v${a.version}`}>
            {t(a.version === 1 ? "opdLayout.auditRowFirst" : "opdLayout.auditRow", {
              at: fmtAt(a.at), who: a.byName, changes: a.changes.map((c) => changeText(t, c)).join("; "),
              from: a.version - 1, to: a.version,
            })}
          </li>
        ))}
      </ul>
      <p style={{ margin: 0, fontSize: 11.5, color: "var(--faint)" }}>{t("opdLayout.auditNote")}</p>
    </div>
  );
}

function move<T>(rows: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= rows.length) return [...rows];
  const out = [...rows];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

type AdminRow = WireDepartmentLayout["sections"][number];

/** The admin's department default: pick a department, order its sections, tick Shown and Mandatory. */
export function ConsultLayoutAdmin({ departments }: { departments: WireDepartment[] }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [deptId, setDeptId] = useState<string>(departments[0]?.id ?? "");
  useEffect(() => { if (deptId === "" && departments[0] !== undefined) setDeptId(departments[0].id); }, [deptId, departments]);
  const q = useQuery({ queryKey: ["opd", "layouts", deptId], enabled: deptId !== "", queryFn: () => fetchDepartmentLayout(deptId) });
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setRows(q.data?.sections ?? null); }, [q.data]);

  const edit = (key: string, patch: Partial<AdminRow>): void => {
    setRows((cur) => (cur ?? []).map((r) => {
      if (r.key !== key) return r;
      const n = { ...r, ...patch };
      // A mandatory section must be shown; a hidden one cannot be mandatory. The server says the same.
      if (patch.mandatory === true) n.shown = true;
      if (patch.shown === false) n.mandatory = false;
      return n;
    }));
  };
  const save = async (): Promise<void> => {
    if (rows === null) return;
    setError(null);
    setSaving(true);
    try {
      const saved = await api<WireDepartmentLayout>("PUT", `/opd/layouts/${deptId}`, {
        sections: rows.map((r) => ({ key: r.key, shown: r.shown, mandatory: r.mandatory })),
      });
      qc.setQueryData(["opd", "layouts", deptId], saved);
    } catch (e) {
      setError(opdErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const data = q.data;
  return (
    <div data-testid="consult-layout-admin" style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
        {t("opdLayout.department")}
        <select data-testid="layout-dept" value={deptId} onChange={(e) => { setDeptId(e.target.value); }}>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      {data !== undefined && (
        <p data-testid="layout-version" style={{ margin: 0, fontSize: 12.5, fontWeight: 600 }}>
          {data.version === null
            ? t("opdLayout.versionNone", { dept: data.departmentName })
            : t("opdLayout.versionLine", { dept: data.departmentName, version: data.version })}
        </p>
      )}
      {q.isError && <p role="alert" style={{ margin: 0, color: "var(--red)", fontSize: 12.5 }}>{opdErrorMessage(q.error)}</p>}
      {rows !== null && (
        <DeskTable>
          <DeskTHead>
            <DeskTR>
              <DeskTH>{t("opdLayout.section")}</DeskTH>
              <DeskTH>{t("opdLayout.order")}</DeskTH>
              <DeskTH>{t("opdLayout.shown")}</DeskTH>
              <DeskTH>{t("opdLayout.mandatory")}</DeskTH>
            </DeskTR>
          </DeskTHead>
          <DeskTBody>
            {rows.map((r, i) => (
              <tr key={r.key} data-testid={`layout-row-${r.key}`} style={{ verticalAlign: "top" }}>
                <DeskTD>{sectionLabel(t, r.key)}{r.locked && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--red)" }}>{t("opdLayout.locked")}</span>}</DeskTD>
                <DeskTD>
                  <button type="button" data-testid={`layout-up-${r.key}`} aria-label={t("opdLayout.up", { name: sectionLabel(t, r.key) })} disabled={i === 0}
                    onClick={() => { setRows(move(rows, i, -1)); }}>↑</button>
                  <button type="button" data-testid={`layout-down-${r.key}`} aria-label={t("opdLayout.down", { name: sectionLabel(t, r.key) })} disabled={i === rows.length - 1}
                    onClick={() => { setRows(move(rows, i, 1)); }}>↓</button>
                </DeskTD>
                <DeskTD>
                  <input type="checkbox" data-testid={`layout-shown-${r.key}`} aria-label={`${t("opdLayout.shown")} · ${sectionLabel(t, r.key)}`}
                    checked={r.shown} disabled={r.locked || r.mandatory} onChange={(e) => { edit(r.key, { shown: e.target.checked }); }} />
                </DeskTD>
                <DeskTD>
                  <input type="checkbox" data-testid={`layout-mandatory-${r.key}`} aria-label={`${t("opdLayout.mandatory")} · ${sectionLabel(t, r.key)}`}
                    checked={r.mandatory} disabled={r.locked} onChange={(e) => { edit(r.key, { mandatory: e.target.checked }); }} />
                </DeskTD>
              </tr>
            ))}
          </DeskTBody>
        </DeskTable>
      )}
      {error !== null && <p role="alert" style={{ margin: 0, color: "var(--red)", fontSize: 12.5 }}>{error}</p>}
      <div><button type="button" className="pri" data-testid="layout-save" disabled={rows === null || saving} onClick={() => void save()}>{t("opdLayout.save")}</button></div>
      {data !== undefined && <AuditList audit={data.audit} testId="layout-audit" />}
    </div>
  );
}

type MyRow = WireMyLayout["sections"][number];

/** The doctor's own layout, from the consult's ⋯ menu: reorder, and Hide only where the section is not mandatory. */
export function MyLayoutDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["opd", "me", "layout"], enabled: open, queryFn: fetchMyLayout, retry: false });
  const [rows, setRows] = useState<MyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The saved answer re-seeds the rows; "Saved" clears only when the dialog opens again.
  useEffect(() => { setRows(q.data?.sections ?? null); }, [q.data]);
  useEffect(() => { if (open) setSaved(false); }, [open]);

  const save = async (): Promise<void> => {
    if (rows === null) return;
    setError(null);
    try {
      const next = await api<WireMyLayout>("PUT", "/opd/me/layout", {
        order: rows.map((r) => r.key), hidden: rows.filter((r) => r.hidden).map((r) => r.key),
      });
      qc.setQueryData(["opd", "me", "layout"], next);
      setSaved(true);
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  };

  return (
    <DeskModal open={open} title={t("opdLayout.my.title")} titleId="my-layout-title" testId="my-layout-dialog" width={520} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>{t("opdLayout.my.rules")}</p>
        {q.isError && <p role="alert" style={{ margin: 0, color: "var(--red)", fontSize: 12.5 }}>{opdErrorMessage(q.error)}</p>}
        {rows !== null && (
          <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
            {rows.map((r, i) => (
              <li key={r.key} data-testid={`my-layout-row-${r.key}`} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, opacity: r.hidden ? 0.55 : 1 }}>
                <span style={{ flex: 1 }}>{sectionLabel(t, r.key)}</span>
                {r.mandatory
                  ? <span style={{ fontSize: 11, color: "var(--red)" }}>{t("opdLayout.my.mandatory")}</span>
                  : (
                    <label style={{ fontSize: 11.5, display: "flex", gap: 4, alignItems: "center" }}>
                      <input type="checkbox" data-testid={`my-layout-hide-${r.key}`} checked={r.hidden}
                        onChange={(e) => { setRows(rows.map((x) => (x.key === r.key ? { ...x, hidden: e.target.checked } : x))); }} />
                      {t("opdLayout.my.hide")}
                    </label>
                  )}
                <button type="button" data-testid={`my-layout-up-${r.key}`} aria-label={t("opdLayout.up", { name: sectionLabel(t, r.key) })} disabled={i === 0}
                  onClick={() => { setRows(move(rows, i, -1)); }}>↑</button>
                <button type="button" data-testid={`my-layout-down-${r.key}`} aria-label={t("opdLayout.down", { name: sectionLabel(t, r.key) })} disabled={i === rows.length - 1}
                  onClick={() => { setRows(move(rows, i, 1)); }}>↓</button>
              </li>
            ))}
          </ol>
        )}
        {q.data !== undefined && q.data.adminHidden.length > 0 && (
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--faint)" }}>
            {t("opdLayout.my.adminHidden", { list: q.data.adminHidden.map((k) => sectionLabel(t, k)).join(", ") })}
          </p>
        )}
        <p data-testid="my-layout-note" style={{ margin: 0, fontSize: 12, fontWeight: 600 }}>{t("opdLayout.my.note")}</p>
        {error !== null && <p role="alert" style={{ margin: 0, color: "var(--red)", fontSize: 12.5 }}>{error}</p>}
        {saved && <p role="status" data-testid="my-layout-saved" style={{ margin: 0, fontSize: 12, color: "var(--green)" }}>{t("opdLayout.saved")}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="pri" data-testid="my-layout-save" disabled={rows === null} onClick={() => void save()}>{t("opdLayout.my.save")}</button>
          <button type="button" onClick={onClose}>{t("opdLayout.my.close")}</button>
        </div>
        {q.data !== undefined && <AuditList audit={q.data.audit} testId="my-layout-audit" />}
      </div>
    </DeskModal>
  );
}
