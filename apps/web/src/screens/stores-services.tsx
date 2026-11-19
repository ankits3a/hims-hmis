import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { dateLocale } from "../lib/date-locale";
import { confirmService, reverseService, serviceDepartments, serviceSheets, servicesToConfirm } from "../lib/paying-api";
import { storesErrorCode } from "../lib/stores-api";
import "./stores.css";
import type { WireServiceEntryRow, WireServiceToConfirm } from "@hmis/contracts";

/**
 * STORES S6a (#1116, spec "## Screens": Service to confirm) — `/stores/services`, the department's PHONE screen (390 px).
 * Header: service · month. Rows: line · quantity prefilled from the order. Primary Confirm; secondary Short (the quantity
 * and one line). A contract billed at the start of its term is confirmed with "Term started". Done: "Confirmed". Refused:
 * "Already confirmed", "Not your department". The departments are the reader's `stores.ses.confirm` grants (department
 * scope, or any department for a hospital-scope holder such as biomedical).
 *
 * S6c (#1116, decision 2): under the list, the department's confirmed sheets ("Confirmed / पुष्टि हुई"), each with
 * "Reverse / उलटें" and a reason while it is on no bill: a reversing sheet names the first, and the month is due again.
 */
const page: React.CSSProperties = {
  maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", padding: "12px 16px 24px", display: "flex", flexDirection: "column", gap: 10,
  background: "var(--paper, #fff)", minHeight: "100%",
};
const btn: React.CSSProperties = { minHeight: 44, padding: "0 12px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent", color: "var(--ink, #222)", flexShrink: 0 };
const primary: React.CSSProperties = { ...btn, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 600, flex: "1 1 140px" };
const card: React.CSSProperties = { border: "1px solid var(--rule, #e3e3e3)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 };
const input: React.CSSProperties = { minHeight: 44, minWidth: 0, boxSizing: "border-box", maxWidth: "100%" };
const cut: React.CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

export function StoresServices(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-services", "departments"], queryFn: serviceDepartments });
  const [dept, setDept] = useState<string | null>(null);
  const depts = q.data ?? [];
  const chosen = dept ?? depts[0]?.id ?? null;
  return (
    <div className="stores-ui" data-testid="stores-services" style={page}>
      <h1 style={{ margin: 0, fontSize: 20 }}>{t("stores.services.title")}</h1>
      {depts.length > 1 && (
        <select aria-label={t("stores.services.department")} style={input} value={chosen ?? ""} onChange={(e) => setDept(e.target.value)}>
          {depts.map((d) => <option key={d.id} value={d.id}>{`${d.code} · ${d.name}`}</option>)}
        </select>
      )}
      {q.isPending ? <div aria-busy="true" style={{ height: 60, background: "var(--rule, #eee)", borderRadius: 6 }} />
        : chosen === null ? <p>{t("stores.services.notYourDept")}</p> : <><List departmentId={chosen} /><Sheets departmentId={chosen} /></>}
    </div>
  );
}

function List({ departmentId }: { departmentId: string }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-services", departmentId], queryFn: () => servicesToConfirm(departmentId) });
  if (q.isPending) return <div aria-busy="true">{[0, 1].map((i) => <div key={i} aria-hidden="true" style={{ height: 60, background: "var(--rule, #eee)", borderRadius: 6, marginBottom: 6 }} />)}</div>;
  if (q.isError) return <p>{t("stores.services.notYourDept")}</p>;
  if (q.data.length === 0) return <p>{t("stores.paying.empty")}</p>;
  return <>{q.data.map((s) => <Service key={s.purchaseOrderId} s={s} />)}</>;
}

function Service({ s }: { s: WireServiceToConfirm }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [short, setShort] = useState(false);
  const [term, setTerm] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [why, setWhy] = useState("");
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const month = new Date(`${s.period.start}T00:00:00`).toLocaleDateString(dateLocale(), { month: "short", year: "numeric" });
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const fy = (() => { const y = Number(s.period.end.slice(0, 4)); const m = Number(s.period.end.slice(5, 7)); const a = m >= 4 ? y : y - 1; return `${String(a)}-${String((a + 1) % 100).padStart(2, "0")}`; })();
      await confirmService({
        purchaseOrderId: s.purchaseOrderId, departmentId: s.department.id,
        period: term ? { kind: "term_start", key: fy, start: s.period.start, end: s.period.end } : s.period, source: term ? "term_start" : s.source,
        lines: s.lines.map((l) => {
          const v = qty[l.itemId];
          const n = v === undefined || v === "" ? l.qtyBase : Number(v);
          return { itemId: l.itemId, qtyBase: n, shortReason: n < l.qtyBase ? why : null };
        }),
      });
      setNote({ text: t("stores.services.confirmed"), ok: true });
      await qc.invalidateQueries({ queryKey: ["stores-services"] });
    } catch (e) {
      const code = e instanceof ApiError ? storesErrorCode(e) : null;
      setNote({ text: code === "ses_exists" ? t("stores.services.already") : code === "not_permitted" ? t("stores.services.notYourDept") : t(`stores.err.${code ?? "failed"}`, { defaultValue: t("stores.err.failed") }), ok: false });
    } finally { setBusy(false); }
  };
  return (
    <div style={card} data-testid={`service-${s.purchaseOrderId}`}>
      <strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>{s.vendorName} · {term ? t("stores.services.termStarted") : month}</strong>
      <span style={cut}>{s.poNo} · {s.department.code}</span>
      {s.lines.map((l) => (
        <div key={l.itemId} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ minWidth: 0, overflowWrap: "anywhere", flex: "1 1 140px" }}>{l.itemName}</span>
          {short
            ? <input aria-label={t("stores.services.qty")} inputMode="numeric" style={{ ...input, width: 100 }} value={qty[l.itemId] ?? String(l.qtyBase)} onChange={(e) => setQty({ ...qty, [l.itemId]: e.target.value })} />
            : <strong>{l.qtyBase}</strong>}
          <span>{l.baseUom}</span>
        </div>
      ))}
      {short && <input aria-label={t("stores.services.why")} placeholder={t("stores.services.why")} style={input} value={why} onChange={(e) => setWhy(e.target.value)} />}
      {note !== null && <p role="status" style={{ margin: 0, fontWeight: 700 }}>{note.text}</p>}
      {note?.ok !== true && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={primary} disabled={busy || (short && why.trim() === "")} onClick={() => void save()}>{t("stores.services.confirm")}</button>
          <button type="button" style={btn} onClick={() => setShort(!short)} aria-pressed={short}>{t("stores.services.short")}</button>
          <button type="button" style={btn} onClick={() => setTerm(!term)} aria-pressed={term}>{t("stores.services.termStarted")}</button>
        </div>
      )}
    </div>
  );
}

function Sheets({ departmentId }: { departmentId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-services", "sheets", departmentId], queryFn: () => serviceSheets(departmentId) });
  if (q.isPending || q.isError) return null;
  const rows = q.data.filter((s) => !s.reversal);
  if (rows.length === 0) return null;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="service-sheets">
      <h2 style={{ margin: 0, fontSize: 16 }}>{t("stores.services.sheets")}</h2>
      {rows.map((s) => <Sheet key={s.id} s={s} />)}
    </section>
  );
}

function Sheet({ s }: { s: WireServiceEntryRow }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const month = new Date(`${s.period.start}T00:00:00`).toLocaleDateString(dateLocale(), { month: "short", year: "numeric" });
  const status = s.reversed ? t("stores.services.reversed") : s.billNo !== null ? t("stores.services.billed") : t("stores.services.confirmed");
  const reverse = async (): Promise<void> => {
    setBusy(true);
    try { await reverseService(s.id, why.trim()); setNote({ text: t("stores.services.reversed"), ok: true }); await qc.invalidateQueries({ queryKey: ["stores-services"] }); }
    catch (e) {
      const code = e instanceof ApiError ? storesErrorCode(e) : null;
      setNote({ text: code === "not_permitted" ? t("stores.services.notYourDept") : t(`stores.err.${code ?? "failed"}`, { defaultValue: t("stores.err.failed") }), ok: false });
    } finally { setBusy(false); }
  };
  return (
    <div style={card} data-testid={`sheet-${s.id}`}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ minWidth: 0, overflowWrap: "anywhere", flex: "1 1 160px" }}>{s.sesNo} · {month}</strong>
        <span style={{ fontWeight: 600, padding: "2px 8px", borderRadius: 10, border: "1px solid var(--ink, #222)", fontSize: 13, whiteSpace: "nowrap" }}>{status}</span>
      </div>
      <span style={cut}>{s.poNo} · {s.vendorName}</span>
      {note !== null && <p role="status" style={{ margin: 0, fontWeight: 700 }}>{note.text}</p>}
      {!s.reversed && s.billNo === null && note?.ok !== true && (open ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input aria-label={t("stores.paying.reason")} placeholder={t("stores.paying.reason")} style={{ ...input, flex: "1 1 180px" }} value={why} onChange={(e) => setWhy(e.target.value)} />
          <button type="button" style={primary} disabled={busy || why.trim() === ""} onClick={() => void reverse()}>{t("stores.services.reverse")}</button>
        </div>
      ) : <button type="button" style={{ ...btn, alignSelf: "flex-start" }} onClick={() => setOpen(true)}>{t("stores.services.reverse")}</button>)}
    </div>
  );
}

