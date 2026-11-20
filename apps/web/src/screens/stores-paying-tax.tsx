import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { dateLocale } from "../lib/date-locale";
import {
  addMsmeObjection, addTdsCertificate, auditFlags, closeMsmeObjection, msmeObjections, msmeReport, ownerMonthFlags, payingSuppliers, reviewFlag, saveTaxTable,
  setTallyLedgers, signTaxTable, tallyLedgers, taxTables, tdsCertificates,
} from "../lib/paying-api";
import { storesErrorCode } from "../lib/stores-api";
import type { WireAuditFlag, WireGstCredit, WireGstCreditRule, WirePayToBook, WireTaxTable, WireTdsNature, WireTdsRule } from "@hmis/contracts";

/**
 * STORES S6c (#1116) — the paying desk's remaining screens, so the accounts officer, the accountant and the owner work
 * from screens and not the API:
 *   Tax (tab)      the CA's TDS table and GST-credit table — the version in force (who signed it, when, which document),
 *                  a new version entered row by row and saved as a DRAFT, then "Record signature" with the CA's signed
 *                  document (the sign event names who recorded it); lower-deduction certificates on file and a new one.
 *   Exports        the Stores Tally ledger names (the keys the open bills still need first).
 *   Due            written MSME objections (raise on a GRN or a service entry; close on a day) and the half-yearly MSME
 *                  dues report (micro and small suppliers' bills outstanding beyond 45 days), with Download.
 *   ?flags=1       the auditor's flags for the materials head and the stores auditor: kind · department · documents ·
 *                  since; Upheld (one line: what was done) or Dismiss (a reason); the owner's monthly list of upheld flags.
 * Every status is a word; loading is grey rows; empty is "Nothing here"; a refusal is a sentence naming who to ask.
 */
const btn: React.CSSProperties = { minHeight: 40, padding: "0 12px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent", color: "var(--ink, #222)", flexShrink: 0 };
const primary: React.CSSProperties = { ...btn, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 600 };
const word: React.CSSProperties = { flexShrink: 0, fontWeight: 600, padding: "2px 8px", borderRadius: 10, border: "1px solid var(--ink, #222)", fontSize: 13, whiteSpace: "nowrap" };
const red: React.CSSProperties = { ...word, borderColor: "var(--state-danger, #b42318)", color: "var(--state-danger, #b42318)" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "6px 0", borderBottom: "1px solid var(--rule, #e3e3e3)", minWidth: 0 };
const input: React.CSSProperties = { minHeight: 40, minWidth: 0, boxSizing: "border-box", maxWidth: "100%" };
const card: React.CSSProperties = { border: "1px solid var(--rule, #e3e3e3)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 };
const wrap: React.CSSProperties = { minWidth: 0, overflowWrap: "anywhere" };
const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
const page: React.CSSProperties = {
  maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", padding: "12px 16px 24px", display: "flex", flexDirection: "column", gap: 10,
  background: "var(--paper, #fff)", minHeight: "100%",
};

const money = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", paise % 100 === 0 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps: number): string => `${String(bps / 100)} %`;
const toBps = (s: string): number => Math.round(Number(s) * 100);
const toPaise = (s: string): number => Math.round(Number(s) * 100);
const today = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const day = (d: string): string => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(dateLocale());

function GreyRows({ n = 3 }: { n?: number }): React.ReactElement {
  return <div aria-busy="true">{Array.from({ length: n }, (_, i) => <div key={i} aria-hidden="true" style={{ height: 40, background: "var(--rule, #eee)", borderRadius: 4, marginBottom: 6 }} />)}</div>;
}
function Note({ n }: { n: { text: string; ok: boolean } | null }): React.ReactElement | null {
  if (n === null) return null;
  return (
    <p role="status" data-tone={n.ok ? "ok" : "refused"} style={{
      margin: 0, fontWeight: 700, padding: "6px 10px", borderRadius: 6, borderLeft: `6px solid ${n.ok ? "var(--state-settled, #1a7f37)" : "var(--state-danger, #b42318)"}`,
      background: "var(--line, #eef2ef)",
    }}>{n.text}</p>
  );
}
const Empty = (): React.ReactElement => { const { t } = useTranslation(); return <p style={{ margin: 0 }}>{t("stores.paying.empty")}</p>; };

function useAct(key: string): { busy: boolean; note: { text: string; ok: boolean } | null; run: (f: () => Promise<unknown>, done: string) => Promise<boolean> } {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  return {
    busy, note,
    run: async (f, done) => {
      setBusy(true);
      try { await f(); setNote({ text: done, ok: true }); await qc.invalidateQueries({ queryKey: ["stores-paying", key] }); return true; }
      catch (e) {
        const code = e instanceof ApiError ? storesErrorCode(e) : null;
        setNote({ text: e instanceof ApiError ? t(`stores.err.${code ?? "failed"}`, { defaultValue: t("stores.err.failed") }) : t("stores.ticket.offline"), ok: false });
        return false;
      } finally { setBusy(false); }
    },
  };
}

/* ═══════════════════════════════ Tax (the CA's tables, certificates) ═══════════════════════════════ */

export function TaxTab(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-paying", "tax"], queryFn: taxTables });
  if (q.isPending) return <GreyRows />;
  if (q.isError) return <Note n={{ text: t("stores.paying.notYours"), ok: false }} />;
  const d = q.data;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="tax-tab">
      <TableBlock kind="tds" inForce={d.tds} drafts={d.drafts.filter((x) => x.kind === "tds")} canManage={d.canManage} />
      <TableBlock kind="gst_credit" inForce={d.gstCredit} drafts={d.drafts.filter((x) => x.kind === "gst_credit")} canManage={d.canManage} />
      <Certificates canManage={d.canManage} />
    </div>
  );
}

function Signed({ tbl }: { tbl: WireTaxTable }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span style={wrap}>
      {t("stores.paying.taxTable.version", { n: tbl.version })} · {tbl.signed === null ? <span style={red}>{t("stores.paying.taxTable.unsigned")}</span>
        : t("stores.paying.taxTable.signedBy", { who: tbl.signed.by?.name ?? "—", date: day(tbl.signed.at), doc: tbl.signed.documentRef })}
      {" · "}{t("stores.paying.taxTable.enteredBy", { who: tbl.createdBy?.name ?? "—" })}
    </span>
  );
}

function TdsRows({ rules }: { rules: WireTdsRule[] }): React.ReactElement {
  const { t } = useTranslation();
  if (rules.length === 0) return <Empty />;
  return <>{rules.map((r) => (
    <div key={r.nature} style={row}>
      <strong>{t(`stores.paying.nature.${r.nature}`)}</strong>
      <span style={{ ...wrap, flex: "1 1 160px" }}>{r.section}</span>
      <span>{t("stores.paying.taxTable.rateLine", { ind: pct(r.rateBps.individual), other: pct(r.rateBps.other), pan: pct(r.panMissingRateBps) })}</span>
      <span>{t(`stores.paying.threshold.${r.threshold.kind}`)} {money(r.threshold.paise)}</span>
      {r.categoryCodes.length > 0 && <span style={wrap}>{r.categoryCodes.join(", ")}</span>}
      <span style={word}>{t(r.on ? "stores.paying.settings.on" : "stores.paying.settings.off")}</span>
    </div>
  ))}</>;
}
function GstRows({ rules }: { rules: WireGstCreditRule[] }): React.ReactElement {
  const { t } = useTranslation();
  if (rules.length === 0) return <Empty />;
  return <>{rules.map((r) => (
    <div key={`${r.categoryCode}:${r.supplier}`} style={row}>
      <strong>{r.categoryCode}</strong>
      <span>{t(`stores.paying.supplierType.${r.supplier}`)}</span>
      <span style={word}>{t(`stores.paying.tax.${r.credit}`)}</span>
      {r.reverseCharge && <span style={word}>{t("stores.paying.tax.reverseCharge")}</span>}
    </div>
  ))}</>;
}

type TdsDraft = { nature: WireTdsNature; section: string; ind: string; other: string; pan: string; kind: "bill" | "month" | "year"; amount: string; on: boolean; cats: string };
type GstDraft = { categoryCode: string; supplier: "registered" | "unregistered" | "any"; credit: WireGstCredit; reverseCharge: boolean };
const NATURES: WireTdsNature[] = ["contract", "professional", "rent", "commission", "goods"];
const tdsDraftOf = (r: WireTdsRule): TdsDraft => ({
  nature: r.nature, section: r.section, ind: String(r.rateBps.individual / 100), other: String(r.rateBps.other / 100), pan: String(r.panMissingRateBps / 100),
  kind: r.threshold.kind, amount: String(r.threshold.paise / 100), on: r.on, cats: r.categoryCodes.join(", "),
});

function TableBlock({ kind, inForce, drafts, canManage }: { kind: "tds" | "gst_credit"; inForce: WireTaxTable | null; drafts: WireTaxTable[]; canManage: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct("tax");
  const [editing, setEditing] = useState(false);
  const [doc, setDoc] = useState("");
  const [tds, setTds] = useState<TdsDraft[]>([]);
  const [gst, setGst] = useState<GstDraft[]>([]);
  const [signFor, setSignFor] = useState<string | null>(null);
  const [signDoc, setSignDoc] = useState("");
  const start = (): void => {
    setEditing(true);
    if (kind === "tds") setTds(((inForce?.rules ?? []) as WireTdsRule[]).map(tdsDraftOf));
    else setGst(((inForce?.rules ?? []) as WireGstCreditRule[]).map((r) => ({ ...r })));
  };
  const save = (): Promise<unknown> => (kind === "tds"
    ? saveTaxTable({ kind, documentRef: doc.trim(), rules: tds.map((r) => ({
      nature: r.nature, section: r.section.trim(), rateBps: { individual: toBps(r.ind), other: toBps(r.other) }, panMissingRateBps: toBps(r.pan),
      threshold: { kind: r.kind, paise: toPaise(r.amount) }, on: r.on, categoryCodes: r.cats.split(",").map((c) => c.trim().toUpperCase()).filter((c) => c !== ""),
    })) })
    : saveTaxTable({ kind, documentRef: doc.trim(), rules: gst.map((r) => ({ ...r, categoryCode: r.categoryCode.trim().toUpperCase() })) }));
  const title = t(kind === "tds" ? "stores.paying.taxTable.tds" : "stores.paying.taxTable.gst");
  return (
    <section style={card} data-testid={`table-${kind}`}>
      <strong>{title}</strong>
      <Note n={act.note} />
      {inForce === null ? <span style={red}>{t(kind === "tds" ? "stores.paying.tax.tdsNotChecked" : "stores.paying.taxTable.defaultCredit")}</span> : <Signed tbl={inForce} />}
      {inForce !== null && (kind === "tds" ? <TdsRows rules={inForce.rules as WireTdsRule[]} /> : <GstRows rules={inForce.rules as WireGstCreditRule[]} />)}
      {drafts.map((dr) => (
        <div key={dr.id} style={{ ...card, borderStyle: "dashed" }} data-testid={`draft-${dr.id}`}>
          <Signed tbl={dr} />
          {kind === "tds" ? <TdsRows rules={dr.rules as WireTdsRule[]} /> : <GstRows rules={dr.rules as WireGstCreditRule[]} />}
          {canManage && (signFor === dr.id ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={{ ...label, flex: "1 1 200px" }}>{t("stores.paying.taxTable.signedDoc")}
                <input style={input} value={signDoc} onChange={(e) => setSignDoc(e.target.value)} /></label>
              <button type="button" style={primary} disabled={act.busy || signDoc.trim() === ""} onClick={() => void act.run(async () => { await signTaxTable(dr.id, signDoc.trim()); setSignFor(null); }, t("stores.paying.taxTable.signed"))}>{t("stores.paying.save")}</button>
            </div>
          ) : <button type="button" style={{ ...primary, alignSelf: "flex-start" }} onClick={() => { setSignFor(dr.id); setSignDoc(""); }}>{t("stores.paying.taxTable.recordSign")}</button>)}
        </div>
      ))}
      {canManage && !editing && <button type="button" style={{ ...btn, alignSelf: "flex-start" }} onClick={start}>{t("stores.paying.taxTable.newVersion")}</button>}
      {canManage && editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid={`edit-${kind}`}>
          {kind === "tds" ? tds.map((r, i) => {
            const set = (p: Partial<TdsDraft>): void => setTds(tds.map((x, j) => (j === i ? { ...x, ...p } : x)));
            return (
              <div key={i} style={{ ...row, alignItems: "flex-end" }}>
                <label style={label}>{t("stores.paying.taxTable.nature")}
                  <select style={input} value={r.nature} onChange={(e) => set({ nature: e.target.value as WireTdsNature })}>{NATURES.map((n) => <option key={n} value={n}>{t(`stores.paying.nature.${n}`)}</option>)}</select></label>
                <label style={{ ...label, flex: "1 1 160px" }}>{t("stores.paying.taxTable.section")}<input style={input} value={r.section} onChange={(e) => set({ section: e.target.value })} /></label>
                <label style={label}>{t("stores.paying.taxTable.rateInd")}<input style={{ ...input, width: 80 }} inputMode="decimal" value={r.ind} onChange={(e) => set({ ind: e.target.value })} /></label>
                <label style={label}>{t("stores.paying.taxTable.rateOther")}<input style={{ ...input, width: 80 }} inputMode="decimal" value={r.other} onChange={(e) => set({ other: e.target.value })} /></label>
                <label style={label}>{t("stores.paying.taxTable.ratePan")}<input style={{ ...input, width: 80 }} inputMode="decimal" value={r.pan} onChange={(e) => set({ pan: e.target.value })} /></label>
                <label style={label}>{t("stores.paying.taxTable.threshold")}
                  <select style={input} value={r.kind} onChange={(e) => set({ kind: e.target.value as TdsDraft["kind"] })}>{(["bill", "month", "year"] as const).map((k) => <option key={k} value={k}>{t(`stores.paying.threshold.${k}`)}</option>)}</select></label>
                <label style={label}>₹<input style={{ ...input, width: 110 }} inputMode="decimal" value={r.amount} onChange={(e) => set({ amount: e.target.value })} /></label>
                <label style={{ ...label, flex: "1 1 140px" }}>{t("stores.paying.taxTable.categories")}<input style={input} value={r.cats} onChange={(e) => set({ cats: e.target.value })} /></label>
                <label style={{ display: "flex", gap: 4, alignItems: "center", minHeight: 40 }}><input type="checkbox" checked={r.on} onChange={(e) => set({ on: e.target.checked })} />{t("stores.paying.settings.on")}</label>
                <button type="button" style={btn} onClick={() => setTds(tds.filter((_, j) => j !== i))}>{t("stores.paying.taxTable.remove")}</button>
              </div>
            );
          }) : gst.map((r, i) => {
            const set = (p: Partial<GstDraft>): void => setGst(gst.map((x, j) => (j === i ? { ...x, ...p } : x)));
            return (
              <div key={i} style={{ ...row, alignItems: "flex-end" }}>
                <label style={label}>{t("stores.paying.taxTable.category")}<input style={{ ...input, width: 110 }} value={r.categoryCode} onChange={(e) => set({ categoryCode: e.target.value })} /></label>
                <label style={label}>{t("stores.paying.taxTable.supplier")}
                  <select style={input} value={r.supplier} onChange={(e) => set({ supplier: e.target.value as GstDraft["supplier"] })}>{(["any", "registered", "unregistered"] as const).map((k) => <option key={k} value={k}>{t(`stores.paying.supplierType.${k}`)}</option>)}</select></label>
                <label style={label}>GST
                  <select style={input} value={r.credit} onChange={(e) => set({ credit: e.target.value as WireGstCredit })}>{(["not_available", "eligible", "shared"] as const).map((c) => <option key={c} value={c}>{t(`stores.paying.tax.${c}`)}</option>)}</select></label>
                <label style={{ display: "flex", gap: 4, alignItems: "center", minHeight: 40 }}><input type="checkbox" checked={r.reverseCharge} onChange={(e) => set({ reverseCharge: e.target.checked })} />{t("stores.paying.tax.reverseCharge")}</label>
                <button type="button" style={btn} onClick={() => setGst(gst.filter((_, j) => j !== i))}>{t("stores.paying.taxTable.remove")}</button>
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
            <button type="button" style={btn} disabled={kind === "tds" && tds.length >= NATURES.length} onClick={() => (kind === "tds"
              ? setTds([...tds, { nature: NATURES.find((n) => !tds.some((r) => r.nature === n)) ?? "contract", section: "", ind: "0", other: "0", pan: "0", kind: "bill", amount: "0", on: false, cats: "" }])
              : setGst([...gst, { categoryCode: "", supplier: "any", credit: "not_available", reverseCharge: false }]))}>{t("stores.paying.taxTable.addRow")}</button>
            <label style={{ ...label, flex: "1 1 200px" }}>{t("stores.paying.taxTable.caDoc")}<input style={input} value={doc} onChange={(e) => setDoc(e.target.value)} /></label>
            <button type="button" style={primary} disabled={act.busy || doc.trim() === ""} onClick={() => void act.run(async () => { await save(); setEditing(false); }, t("stores.paying.taxTable.savedDraft"))}>{t("stores.paying.taxTable.saveDraft")}</button>
            <button type="button" style={btn} onClick={() => setEditing(false)}>{t("stores.paying.taxTable.cancel")}</button>
          </div>
        </div>
      )}
    </section>
  );
}

function Certificates({ canManage }: { canManage: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-paying", "tax", "certificates"], queryFn: tdsCertificates });
  const sup = useQuery({ queryKey: ["stores-paying", "tax", "suppliers"], queryFn: payingSuppliers, enabled: canManage });
  const act = useAct("tax");
  const [f, setF] = useState({ vendorId: "", number: "", rate: "", from: "", to: "", doc: "" });
  const ready = f.vendorId !== "" && f.number.trim() !== "" && f.rate !== "" && f.from !== "" && f.to !== "" && f.doc.trim() !== "";
  return (
    <section style={card} data-testid="certificates">
      <strong>{t("stores.paying.certs.title")}</strong>
      <Note n={act.note} />
      {q.isPending ? <GreyRows n={1} /> : (q.data ?? []).length === 0 ? <Empty /> : (q.data ?? []).map((c) => {
        const live = c.validFrom <= today() && today() <= c.validTo;
        return (
          <div key={c.id} style={row}>
            <span style={{ ...wrap, flex: "1 1 160px" }}>{c.vendorName}</span>
            <span>{c.number}</span><span>{pct(c.rateBps)}</span>
            <span>{day(c.validFrom)} – {day(c.validTo)}</span>
            <span style={live ? word : red}>{t(live ? "stores.paying.certs.valid" : "stores.paying.certs.notValid")}</span>
          </div>
        );
      })}
      {canManage && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...label, flex: "1 1 200px" }}>{t("stores.paying.certs.supplier")}
            <select style={input} value={f.vendorId} onChange={(e) => setF({ ...f, vendorId: e.target.value })}>
              <option value="">—</option>{(sup.data ?? []).map((v) => <option key={v.id} value={v.id}>{`${v.code} · ${v.name}`}</option>)}
            </select></label>
          <label style={label}>{t("stores.paying.certs.number")}<input style={{ ...input, width: 140 }} value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></label>
          <label style={label}>{t("stores.paying.certs.rate")}<input style={{ ...input, width: 80 }} inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></label>
          <label style={label}>{t("stores.paying.certs.from")}<input style={input} type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
          <label style={label}>{t("stores.paying.certs.to")}<input style={input} type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
          <label style={{ ...label, flex: "1 1 160px" }}>{t("stores.paying.taxTable.caDoc")}<input style={input} value={f.doc} onChange={(e) => setF({ ...f, doc: e.target.value })} /></label>
          <button type="button" style={primary} disabled={act.busy || !ready} onClick={() => void act.run(async () => {
            await addTdsCertificate({ vendorId: f.vendorId, number: f.number.trim(), rateBps: toBps(f.rate), validFrom: f.from, validTo: f.to, documentRef: f.doc.trim() });
            setF({ vendorId: "", number: "", rate: "", from: "", to: "", doc: "" });
          }, t("stores.paying.saved"))}>{t("stores.paying.certs.add")}</button>
        </div>
      )}
    </section>
  );
}

/* ═══════════════════════════════ Exports: the Stores Tally ledger names ═══════════════════════════════ */

const ledgerLabel = (t: (k: string, o?: Record<string, unknown>) => string, key: string): string => {
  const [kind, rest] = key.split(":") as [string, string | undefined];
  if (key === "rcm_liability") return t("stores.paying.ledger.rcm");
  if (kind === "tds") return `${t("stores.paying.ledger.tds")} · ${t(`stores.paying.nature.${rest ?? ""}`, { defaultValue: rest ?? "" })}`;
  return `${t(kind === "asset" ? "stores.paying.ledger.asset" : "stores.paying.ledger.purchase")} · ${rest ?? ""}`;
};

export function TallyLedgers(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-paying", "ledgers"], queryFn: tallyLedgers });
  const act = useAct("ledgers");
  const [names, setNames] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState("");
  if (q.isPending) return <GreyRows n={2} />;
  if (q.isError) return <span />;
  const keys = [...new Set([...q.data.needed, ...Object.keys(q.data.names), ...Object.keys(names)])].sort();
  const changed = Object.entries(names).filter(([k, v]) => v.trim() !== "" && v.trim() !== (q.data.names[k] ?? ""));
  return (
    <section style={card} data-testid="tally-ledgers">
      <strong>{t("stores.paying.ledger.title")}</strong>
      <Note n={act.note} />
      {keys.length === 0 ? <Empty /> : keys.map((k) => {
        const missing = q.data.needed.includes(k) && (q.data.names[k] ?? "") === "";
        return (
          <div key={k} style={row}>
            <span style={{ ...wrap, flex: "1 1 180px" }}>{ledgerLabel(t, k)}</span>
            {missing && <span style={red}>{t("stores.paying.ledger.missing")}</span>}
            <input aria-label={ledgerLabel(t, k)} style={{ ...input, flex: "1 1 220px" }} value={names[k] ?? q.data.names[k] ?? ""} onChange={(e) => setNames({ ...names, [k]: e.target.value })} />
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={label}>{t("stores.paying.ledger.addKey")}<input style={{ ...input, width: 200 }} placeholder="purchase:HSK" value={extra} onChange={(e) => setExtra(e.target.value)} /></label>
        <button type="button" style={btn} disabled={extra.trim() === ""} onClick={() => { setNames({ ...names, [extra.trim()]: "" }); setExtra(""); }}>{t("stores.paying.taxTable.addRow")}</button>
        <button type="button" style={primary} disabled={act.busy || changed.length === 0} onClick={() => void act.run(async () => { await setTallyLedgers(Object.fromEntries(changed.map(([k, v]) => [k, v.trim()]))); setNames({}); }, t("stores.paying.saved"))}>{t("stores.paying.save")}</button>
      </div>
    </section>
  );
}

/* ═══════════════════════════════ Due: MSME objections and the half-yearly dues report ═══════════════════════════════ */

function halves(): string[] {
  const d = today();
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  let cur = m >= 4 && m <= 9 ? { y, h: 1 } : m >= 10 ? { y, h: 2 } : { y: y - 1, h: 2 };
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    out.push(`${String(cur.y)}-H${String(cur.h)}`);
    cur = cur.h === 2 ? { y: cur.y, h: 1 } : { y: cur.y - 1, h: 2 };
  }
  return out;
}

export function MsmeReport(): React.ReactElement {
  const { t } = useTranslation();
  const options = halves();
  const [half, setHalf] = useState(options[0]!);
  const q = useQuery({ queryKey: ["stores-paying", "msme-report", half], queryFn: () => msmeReport(half) });
  const csv = (): void => {
    if (q.data === undefined) return;
    const lines = ["bill,supplier_bill,supplier,udyam,class,accepted,days,outstanding_paise", ...q.data.rows.map((r) => `${r.billNo},"${r.vendorBillNo}","${r.vendorName.replace(/"/g, '""')}",${r.udyam ?? ""},${r.msmeClass},${r.acceptanceDate},${String(r.daysOutstanding)},${String(r.outstandingPaise)}`)];
    const a = document.createElement("a");
    a.href = `data:text/csv;charset=utf-8,${encodeURIComponent(`${lines.join("\n")}\n`)}`;
    a.download = `msme-dues-${half}.csv`;
    a.click();
  };
  return (
    <section style={card} data-testid="msme-report">
      <strong>{t("stores.paying.msmeReport.title")}</strong>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <select aria-label={t("stores.paying.msmeReport.half")} style={input} value={half} onChange={(e) => setHalf(e.target.value)}>
          {options.map((h) => <option key={h} value={h}>{t(h.endsWith("H1") ? "stores.paying.msmeReport.h1" : "stores.paying.msmeReport.h2", { y: Number(h.slice(0, 4)), y2: (Number(h.slice(0, 4)) + 1) % 100 })}</option>)}
        </select>
        {q.data !== undefined && <span>{t("stores.paying.msmeReport.asOf", { date: day(q.data.asOf) })} · {t("stores.paying.total")} {money(q.data.totalPaise)}</span>}
        <button type="button" style={primary} disabled={q.data === undefined} onClick={csv}>{t("stores.paying.download")}</button>
      </div>
      {q.isPending ? <GreyRows n={2} /> : q.isError ? <Note n={{ text: t("stores.paying.notYours"), ok: false }} /> : q.data.rows.length === 0 ? <Empty /> : q.data.rows.map((r) => (
        <div key={r.billId} style={row}>
          <strong>{r.billNo}</strong>
          <span style={{ ...wrap, flex: "1 1 160px" }}>{r.vendorName}</span>
          <span style={word}>{t(`stores.paying.msmeReport.${r.msmeClass === "micro" ? "micro" : "small"}`)}</span>
          <span>{t("stores.paying.msmeReport.days", { n: r.daysOutstanding })}</span>
          <span>{money(r.outstandingPaise)}</span>
          <span style={red}>{t("stores.paying.due.overdue")}</span>
        </div>
      ))}
    </section>
  );
}

export function MsmeObjections({ docs }: { docs: WirePayToBook[] }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-paying", "objections"], queryFn: msmeObjections });
  const act = useAct("objections");
  const [f, setF] = useState({ doc: "", kind: "qc_rejection" as "qc_rejection" | "short", on: today(), reason: "" });
  const [closing, setClosing] = useState<string | null>(null);
  const [c, setC] = useState({ on: today(), note: "" });
  return (
    <section style={card} data-testid="msme-objections">
      <strong>{t("stores.paying.objection.title")}</strong>
      <Note n={act.note} />
      {q.isPending ? <GreyRows n={1} /> : q.isError ? null : q.data.length === 0 ? <Empty /> : q.data.map((o) => (
        <div key={o.id}>
          <div style={row}>
            <span style={o.closed === null ? red : word}>{t(o.closed === null ? "stores.paying.objection.open" : "stores.paying.objection.closed")}</span>
            <span style={word}>{t(`stores.paying.objection.${o.kind}`)}</span>
            <strong>{o.doc.no}</strong>
            <span style={{ ...wrap, flex: "1 1 140px" }}>{o.vendorName}</span>
            <span>{day(o.raisedOn)}{o.closed !== null ? ` → ${day(o.closed.on)}` : ""}</span>
            <span style={{ ...wrap, flex: "1 1 140px" }}>{o.reason}</span>
            {o.closed === null && closing !== o.id && <button type="button" style={btn} onClick={() => { setClosing(o.id); setC({ on: today(), note: "" }); }}>{t("stores.paying.objection.close")}</button>}
          </div>
          {closing === o.id && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={label}>{t("stores.paying.objection.closedOn")}<input style={input} type="date" value={c.on} onChange={(e) => setC({ ...c, on: e.target.value })} /></label>
              <label style={{ ...label, flex: "1 1 200px" }}>{t("stores.paying.reason")}<input style={input} value={c.note} onChange={(e) => setC({ ...c, note: e.target.value })} /></label>
              <button type="button" style={primary} disabled={act.busy || c.note.trim() === ""} onClick={() => void act.run(async () => { await closeMsmeObjection(o.id, c.on, c.note.trim()); setClosing(null); }, t("stores.paying.saved"))}>{t("stores.paying.save")}</button>
            </div>
          )}
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ ...label, flex: "1 1 180px" }}>{t("stores.paying.objection.doc")}
          <select style={input} value={f.doc} onChange={(e) => setF({ ...f, doc: e.target.value })}>
            <option value="">—</option>{docs.map((d) => <option key={`${d.kind}:${d.id}`} value={`${d.kind}:${d.id}`}>{`${d.no} · ${d.vendorName}`}</option>)}
          </select></label>
        <label style={label}>{t("stores.paying.objection.kind")}
          <select style={input} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })}>
            <option value="qc_rejection">{t("stores.paying.objection.qc_rejection")}</option><option value="short">{t("stores.paying.objection.short")}</option>
          </select></label>
        <label style={label}>{t("stores.paying.objection.raisedOn")}<input style={input} type="date" value={f.on} onChange={(e) => setF({ ...f, on: e.target.value })} /></label>
        <label style={{ ...label, flex: "1 1 200px" }}>{t("stores.paying.reason")}<input style={input} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
        <button type="button" style={primary} disabled={act.busy || f.doc === "" || f.reason.trim() === ""} onClick={() => void act.run(async () => {
          const [kind, id] = f.doc.split(":") as ["grn" | "ses", string];
          await addMsmeObjection({ ...(kind === "grn" ? { grnId: id } : { sesId: id }), kind: f.kind, raisedOn: f.on, reason: f.reason.trim() });
          setF({ ...f, doc: "", reason: "" });
        }, t("stores.paying.saved"))}>{t("stores.paying.objection.raise")}</button>
      </div>
    </section>
  );
}

/* ═══════════════════════════════ ?flags=1 — the auditor's flags ═══════════════════════════════ */

export function AuditFlags(): React.ReactElement {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"open" | "upheld" | "dismissed" | "month">("open");
  const month = today().slice(0, 7);
  const q = useQuery({
    queryKey: ["stores-paying", "flags", status],
    queryFn: () => (status === "month" ? ownerMonthFlags(month) : auditFlags(status)),
  });
  return (
    <div className="stores-ui" data-testid="audit-flags" style={page}>
      <h1 style={{ margin: 0, fontSize: 20 }}>{t("stores.paying.flags.title")}</h1>
      <div role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(["open", "upheld", "dismissed", "month"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={status === k} style={status === k ? primary : btn} onClick={() => setStatus(k)}>{t(`stores.paying.flags.tab.${k}`)}</button>
        ))}
      </div>
      {q.isPending ? <GreyRows /> : q.isError ? <Note n={{ text: t("stores.paying.flags.notYours"), ok: false }} /> : q.data.length === 0 ? <Empty />
        : <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 360px), 1fr))" }}>{q.data.map((f) => <FlagCard key={f.id} f={f} />)}</div>}
    </div>
  );
}

function FlagCard({ f }: { f: WireAuditFlag }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct("flags");
  const [mode, setMode] = useState<"upheld" | "dismissed" | null>(null);
  const [note, setNote] = useState("");
  return (
    <div style={card} data-testid={`flag-${f.id}`}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <strong>{t(`stores.paying.flags.kind.${f.kind}`)}</strong>
        <span style={f.status === "open" ? red : word}>{t(`stores.paying.flags.status.${f.status}`)}</span>
        {f.stale && <span style={red}>{t("stores.paying.flags.stale")}</span>}
      </div>
      <span style={wrap}>{f.departments.length === 0 ? t("stores.paying.flags.central") : f.departments.map((d) => d.name).join(", ")}</span>
      <span style={wrap}>{f.text}</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {f.cites.filter((c) => c.no !== "").map((c) => <span key={`${c.type}:${c.id}`} style={{ ...word, fontWeight: 400 }}>{c.no}</span>)}
      </div>
      <span>{t("stores.paying.flags.since", { date: day(f.raisedAt) })}</span>
      {f.review !== null && <span style={wrap}>{t(`stores.paying.flags.status.${f.review.verdict}`)} · {f.review.by.name} · {day(f.review.at)} · {f.review.note}</span>}
      <Note n={act.note} />
      {f.status === "open" && f.refusal === "hod_reviews_own" && <span style={{ fontWeight: 600 }}>{t("stores.paying.flags.hodOwn")}</span>}
      {f.status === "open" && f.canReview && mode === null && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" style={primary} onClick={() => setMode("upheld")}>{t("stores.paying.flags.uphold")}</button>
          <button type="button" style={btn} onClick={() => setMode("dismissed")}>{t("stores.paying.flags.dismiss")}</button>
        </div>
      )}
      {f.status === "open" && f.canReview && mode !== null && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...label, flex: "1 1 200px" }}>{t(mode === "upheld" ? "stores.paying.flags.whatDone" : "stores.paying.reason")}
            <input style={input} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <button type="button" style={primary} disabled={act.busy || note.trim() === ""} onClick={() => void act.run(() => reviewFlag(f.id, mode, note.trim()), t(`stores.paying.flags.status.${mode}`))}>{t("stores.paying.save")}</button>
          <button type="button" style={btn} onClick={() => setMode(null)}>{t("stores.paying.taxTable.cancel")}</button>
        </div>
      )}
    </div>
  );
}
