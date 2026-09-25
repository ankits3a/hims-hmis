import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../lib/api";

/**
 * ═══ THE OPHTHALMOLOGY SECTIONS (board `Ophthal`, approved 2026-09-23; 01-CONSULT-ENGINE.md §6.1) ═══
 *
 * The consult engine's first specialty. The server decides WHICH sections a visit shows, from the
 * visit's department (`GET /opd/visits/:id/sections`); this file only draws the four eye sections
 * and saves each one when the doctor leaves it. Every save is a new, versioned row on the server
 * (append-only, D7) — nothing here edits in place.
 *
 * Each eye is its own column, right eye (OD) first as the board and every Indian eye OPD writes it,
 * and a "Copy OD → OS" fills the left eye from the right for the common symmetrical finding.
 */

export type SectionKey = "eye.vision" | "eye.iop" | "eye.slit_lamp" | "eye.glasses_rx";
export type WireVisitSections = {
  profile: string | null;
  sections: { key: SectionKey; version: number; kind: string }[];
  records: Partial<Record<SectionKey, { body: unknown; at: string; authorId: string; sectionVersion: number; recordId: string }>>;
};
type Pair = { od: string; os: string };
type Lens = { sph: number | null; cyl: number | null; axis: number | null; add: number | null };

export const VISION_ROWS = ["vaUnaided", "vaGlasses", "vaPinhole", "near", "colour", "autoRefraction", "currentGlasses"] as const;
export const SLIT_LAMP_ROWS = ["lids", "conjunctiva", "cornea", "anteriorChamber", "iris", "pupil", "lens", "fundus"] as const;
const IOP_METHODS = ["NCT", "GAT", "iCare", "Tonopen", "Digital"] as const;
/** The Snellen and near notations an Indian eye OPD writes; free text stays legal. */
const VA_VALUES = ["6/6", "6/9", "6/12", "6/18", "6/24", "6/36", "6/60", "5/60", "4/60", "3/60", "2/60", "1/60", "CF 1 m", "CF ½ m", "HM", "PL+", "PL−", "NPL"];
const NEAR_VALUES = ["N5", "N6", "N8", "N10", "N12", "N18", "N24", "N36"];
const SLIT_VALUES = ["Normal", "Clear", "Quiet", "Normal depth", "Round, reactive", "NS grade 1", "NS grade 2", "NS grade 3", "NS grade 4", "PSC", "Pseudophakia", "Hazy view", "Mild NPDR", "Moderate NPDR"];

const emptyPairs = <K extends string>(rows: readonly K[]): Record<K, Pair> =>
  Object.fromEntries(rows.map((r) => [r, { od: "", os: "" }])) as Record<K, Pair>;
const emptyLens = (): Lens => ({ sph: null, cyl: null, axis: null, add: null });

export const fetchVisitSections = (encounterId: string): Promise<WireVisitSections> => api("GET", `/opd/visits/${encounterId}/sections`);

/** Signed dioptres as an optometrist writes them: −1.25, +2.50, 0.00. */
export function fmtPower(n: number | null): string {
  if (n === null) return "";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}`;
}
function num(s: string): number | null {
  const t = s.trim().replace("−", "-").replace(/^\+/, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function useSection<T>(encounterId: string, key: SectionKey, data: WireVisitSections | undefined, empty: () => T, leaseBody: () => Record<string, string>) {
  const qc = useQueryClient();
  const [value, setValue] = useState<T>(empty);
  const loaded = useRef<string | null>(null);
  const rec = data?.records[key];
  useEffect(() => {
    const stamp = `${encounterId}:${rec?.recordId ?? "none"}`;
    if (data === undefined || loaded.current === stamp) return;
    loaded.current = stamp;
    setValue(rec === undefined ? empty() : ({ ...empty(), ...(rec.body as object) } as T));
  }, [data, encounterId, rec, empty]);
  const save = useMutation({
    mutationFn: (body: T) => api<{ record: { recordId: string; at: string; body?: unknown; authorId?: string; sectionVersion?: number } }>(
      "PUT", `/opd/visits/${encounterId}/sections/${key}`, { body, ...leaseBody() }),
    /*
      The saved row goes STRAIGHT into the cache rather than through a refetch: a refetch that lands
      after the doctor has typed on would reset the grid to the row it returns. The server's own
      parsed body wins where it sent one (it fills the rows the doctor left empty).
    */
    onSuccess: (r, sent) => {
      loaded.current = `${encounterId}:${r.record.recordId}`;
      qc.setQueryData<WireVisitSections>(["opd", "sections", encounterId], (old) => old === undefined ? old : {
        ...old, records: { ...old.records, [key]: {
          body: r.record.body ?? sent, at: r.record.at, recordId: r.record.recordId,
          authorId: r.record.authorId ?? "", sectionVersion: r.record.sectionVersion ?? 1,
        } },
      });
    },
  });
  const lastSent = useRef<string>("");
  const saved = JSON.stringify(rec === undefined ? empty() : { ...empty(), ...(rec.body as object) });
  const flush = (v: T = value): void => {
    const json = JSON.stringify(v);
    if (json === saved || json === lastSent.current) return;
    lastSent.current = json;
    save.mutate(v);
  };
  /* What is on screen is not yet the row on record — typed and not left, or on its way to the server. */
  const dirty = save.isPending || JSON.stringify(value) !== saved;
  return { value, setValue, flush, save, savedAt: rec?.at ?? null, dirty };
}

function Status({ save, savedAt, testId }: { save: { isPending: boolean; isError: boolean; error: unknown }; savedAt: string | null; testId: string }): React.ReactElement {
  const { t } = useTranslation();
  const text = save.isPending ? t("opdEye.saving")
    : save.isError ? t("opdEye.saveFailed", { reason: save.error instanceof Error ? save.error.message : "" })
    : savedAt !== null ? t("opdEye.savedAt", { at: new Date(savedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) }) : "";
  return <span data-testid={testId} style={{ fontSize: 11.5, color: save.isError ? "var(--red)" : "var(--dim)" }}>{text}</span>;
}

const cell: React.CSSProperties = { height: 32, width: "100%", minWidth: 0, padding: "0 8px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--card)", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 };
const head: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 9.5, fontWeight: 600, letterSpacing: ".12em", color: "var(--dim)", textTransform: "uppercase" };

function PairGrid<K extends string>({ rows, value, onChange, onDone, list, testId, labelOf }: {
  rows: readonly K[]; value: Record<K, Pair>; onChange: (next: Record<K, Pair>) => void; onDone: () => void;
  list: (row: K) => string; testId: string; labelOf: (row: K) => string;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div data-testid={testId} style={{ display: "grid", gridTemplateColumns: "minmax(96px, 180px) minmax(0, 1fr) minmax(0, 1fr)", gap: "6px 10px", alignItems: "center" }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDone(); }}>
      <span style={head}>{t("opdEye.test")}</span><span style={head}>{t("opdEye.od")}</span><span style={head}>{t("opdEye.os")}</span>
      {rows.map((r) => (
        <div key={r} style={{ display: "contents" }}>
          <span style={{ fontSize: 13 }}>{labelOf(r)}</span>
          {(["od", "os"] as const).map((eye) => (
            <input key={eye} data-testid={`${testId}-${r}-${eye}`} aria-label={`${labelOf(r)} · ${t(`opdEye.${eye}`)}`} list={list(r) === "" ? undefined : list(r)} style={cell}
              value={value[r]?.[eye] ?? ""} maxLength={160}
              onChange={(e) => { onChange({ ...value, [r]: { ...value[r], [eye]: e.target.value } }); }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EyeSections({ encounterId, leaseBody, readOnly }: {
  encounterId: string; leaseBody: () => Record<string, string>; readOnly: boolean;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["opd", "sections", encounterId], queryFn: () => fetchVisitSections(encounterId) });
  const shown = new Set((q.data?.sections ?? []).map((s) => s.key));
  const vision = useSection(encounterId, "eye.vision", q.data, () => emptyPairs(VISION_ROWS), leaseBody);
  const iop = useSection(encounterId, "eye.iop", q.data, () => ({ method: null as string | null, od: null as number | null, os: null as number | null }), leaseBody);
  const slit = useSection(encounterId, "eye.slit_lamp", q.data, () => emptyPairs(SLIT_LAMP_ROWS), leaseBody);
  const glasses = useSection(encounterId, "eye.glasses_rx", q.data, () => ({ od: emptyLens(), os: emptyLens(), use: null as string | null, note: "" }), leaseBody);
  /*
    Board `Ophthal` — "GLASSES PRESCRIPTION · ITS OWN PRINT". The SERVER prints (owner ruling
    2026-09-04): this asks for one A4 job at the front desk for the version on record, and the server
    refuses anything but the treating doctor. `queued: false` is the same success — that version is
    already coming off the printer.
  */
  const printGlasses = useMutation({
    mutationFn: () => api<{ queued: boolean }>("POST", `/opd/visits/${encounterId}/glasses-rx/print`),
  });
  if (q.data === undefined || q.data.profile === null) return null;
  /* Only the SAVED row prints, so the button waits for it: no power on record, or an edit not yet saved, is nothing to send. */
  const hasPower = (["od", "os"] as const).some((eye) => (["sph", "cyl", "add"] as const).some((f) => glasses.value[eye][f] !== null));
  const canPrintGlasses = q.data.records["eye.glasses_rx"] !== undefined && hasPower && !glasses.dirty && !printGlasses.isPending;
  const printFailure = (e: unknown): string => {
    const body = e instanceof ApiError ? (e.body as { code?: string; message?: string } | null) : null;
    if (body?.code === "glasses_rx_empty") return t("opdEye.printEmpty");
    return t("opdEye.printFailed", { reason: body?.message ?? (e instanceof Error ? e.message : "") });
  };

  const card: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 };
  const title = (text: string, extra?: React.ReactNode, status?: React.ReactNode): React.ReactElement => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ ...head, fontWeight: 700, color: "var(--green)" }}>{text}</span>
      <span style={{ flexGrow: 1 }} />{status}{extra}
    </div>
  );
  const copyBtn = (testId: string, onClick: () => void): React.ReactElement => (
    <button type="button" className="sec" data-testid={testId} disabled={readOnly} style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={onClick}>{t("opdEye.copyOdOs")}</button>
  );
  const copyAll = <K extends string>(v: Record<K, Pair>): Record<K, Pair> =>
    Object.fromEntries(Object.entries(v).map(([k, p]) => [k, { od: (p as Pair).od, os: (p as Pair).od }])) as Record<K, Pair>;
  const lensCell = (eye: "od" | "os", f: keyof Lens): React.ReactElement => (
    <input data-testid={`eye-glasses-${eye}-${f}`} aria-label={`${t(`opdEye.lens.${f}`)} · ${t(`opdEye.${eye}`)}`} inputMode="decimal" style={cell}
      defaultValue={f === "axis" ? (glasses.value[eye][f] ?? "").toString() : fmtPower(glasses.value[eye][f])}
      key={`${eye}-${f}-${String(glasses.value[eye][f])}`}
      onBlur={(e) => {
        const n = num(e.target.value);
        const next = { ...glasses.value, [eye]: { ...glasses.value[eye], [f]: n } };
        glasses.setValue(next); glasses.flush(next);
      }} />
  );

  return (
    <div data-testid="eye-sections" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <datalist id="eye-va">{VA_VALUES.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="eye-near">{NEAR_VALUES.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="eye-slit">{SLIT_VALUES.map((v) => <option key={v} value={v} />)}</datalist>

      {shown.has("eye.vision") && (
        <section style={card} aria-label={t("opdEye.visionTitle")}>
          {title(t("opdEye.visionTitle"), copyBtn("eye-vision-copy", () => { const n = copyAll(vision.value); vision.setValue(n); vision.flush(n); }),
            <Status save={vision.save} savedAt={vision.savedAt} testId="eye-vision-status" />)}
          <PairGrid rows={VISION_ROWS} value={vision.value} onChange={vision.setValue} onDone={() => { vision.flush(); }} testId="eye-vision"
            labelOf={(r) => t(`opdEye.vision.${r}`)} list={(r) => (r === "near" ? "eye-near" : r.startsWith("va") ? "eye-va" : "")} />
          {shown.has("eye.iop") && (
            <div data-testid="eye-iop" style={{ display: "grid", gridTemplateColumns: "minmax(96px, 180px) minmax(0, 1fr) minmax(0, 1fr)", gap: "6px 10px", alignItems: "center", borderTop: "1px solid var(--line2)", paddingTop: 10 }}
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) iop.flush(); }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                {t("opdEye.iop")}
                <select data-testid="eye-iop-method" aria-label={t("opdEye.iopMethod")} value={iop.value.method ?? ""} style={{ ...cell, width: "auto", fontFamily: "inherit" }}
                  onChange={(e) => { iop.setValue({ ...iop.value, method: e.target.value === "" ? null : e.target.value }); }}>
                  <option value="">{t("opdEye.method")}</option>
                  {IOP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              {(["od", "os"] as const).map((eye) => (
                <input key={eye} data-testid={`eye-iop-${eye}`} aria-label={`${t("opdEye.iop")} · ${t(`opdEye.${eye}`)}`} inputMode="numeric" placeholder="mmHg" style={cell}
                  value={iop.value[eye] ?? ""} onChange={(e) => { iop.setValue({ ...iop.value, [eye]: num(e.target.value) }); }} />
              ))}
              <span />
              <span style={{ gridColumn: "2 / 4" }}><Status save={iop.save} savedAt={iop.savedAt} testId="eye-iop-status" /></span>
            </div>
          )}
        </section>
      )}

      {shown.has("eye.slit_lamp") && (
        <section style={card} aria-label={t("opdEye.slitTitle")}>
          {title(t("opdEye.slitTitle"), copyBtn("eye-slit-copy", () => { const n = copyAll(slit.value); slit.setValue(n); slit.flush(n); }),
            <Status save={slit.save} savedAt={slit.savedAt} testId="eye-slit-status" />)}
          <PairGrid rows={SLIT_LAMP_ROWS} value={slit.value} onChange={slit.setValue} onDone={() => { slit.flush(); }} testId="eye-slit"
            labelOf={(r) => t(`opdEye.slit.${r}`)} list={() => "eye-slit"} />
        </section>
      )}

      {shown.has("eye.glasses_rx") && (
        <section style={card} aria-label={t("opdEye.glassesTitle")}>
          {title(t("opdEye.glassesTitle"), null, <Status save={glasses.save} savedAt={glasses.savedAt} testId="eye-glasses-status" />)}
          <div data-testid="eye-glasses" style={{ display: "grid", gridTemplateColumns: "40px repeat(4, minmax(0, 1fr))", gap: "6px 10px", alignItems: "center" }}>
            <span />{(["sph", "cyl", "axis", "add"] as const).map((f) => <span key={f} style={head}>{t(`opdEye.lens.${f}`)}</span>)}
            {(["od", "os"] as const).map((eye) => (
              <div key={eye} style={{ display: "contents" }}>
                <span className="mo" style={{ fontSize: 12.5, fontWeight: 600 }}>{eye.toUpperCase()}</span>
                {lensCell(eye, "sph")}{lensCell(eye, "cyl")}{lensCell(eye, "axis")}{lensCell(eye, "add")}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <select data-testid="eye-glasses-use" aria-label={t("opdEye.use")} value={glasses.value.use ?? ""} style={{ ...cell, width: "auto", fontFamily: "inherit" }}
              onChange={(e) => { const next = { ...glasses.value, use: e.target.value === "" ? null : e.target.value }; glasses.setValue(next); glasses.flush(next); }}>
              <option value="">{t("opdEye.use")}</option>
              {(["distance", "near", "bifocal", "progressive"] as const).map((u) => <option key={u} value={u}>{t(`opdEye.useOption.${u}`)}</option>)}
            </select>
            <input data-testid="eye-glasses-note" aria-label={t("opdEye.note")} placeholder={t("opdEye.note")} style={{ ...cell, flex: "1 1 200px", width: "auto", fontFamily: "inherit" }}
              value={glasses.value.note} maxLength={200} onChange={(e) => { glasses.setValue({ ...glasses.value, note: e.target.value }); }} onBlur={() => { glasses.flush(); }} />
          </div>
          {glasses.save.isError && <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{t("opdEye.lensRule")}</p>}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="sec" data-testid="eye-glasses-print" disabled={!canPrintGlasses} style={{ height: 30, padding: "0 12px", fontSize: 12.5 }}
              onClick={() => { printGlasses.mutate(); }}>{t("opdEye.printGlasses")}</button>
            <span data-testid="eye-glasses-print-status" role={printGlasses.isError ? "alert" : undefined} style={{ fontSize: 11.5, color: printGlasses.isError ? "var(--red)" : "var(--dim)" }}>
              {printGlasses.isPending ? t("opdEye.printSending")
                : printGlasses.isError ? printFailure(printGlasses.error)
                : printGlasses.isSuccess ? t("opdEye.printSent") : ""}
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
