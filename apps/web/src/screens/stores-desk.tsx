import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { heldAnywhere, useAuth } from "../lib/auth";
import {
  addCategory, addItem, addShelf, addStore, importItems, listAllShelves, listCategories, listItems, listRequests, listStores, myShelves,
  overBookCards, pickers, resolveRequest, setPar, storesErrorCode,
} from "../lib/stores-api";
import "./stores.css";
import type { WireImportResult, WireItemRequest } from "@hmis/contracts";

/**
 * STORES S1 (#1111) — `/stores`, the materials head's desk at 16:9 (fits 1366 × 768), spec "## Screens".
 *
 * Six tabs, one primary each: Categories (Add category), Items (Add item, plus Import items with a dry-run
 * table of row number · refusal), Stores (Add store), Shelves (Add shelf), Par (Set par), New items
 * (Resolve). A person without `stores.masters.manage` sees their own department shelves instead (the
 * phone shelf is one tap away), or "No permission".
 */
type Tab = "categories" | "items" | "stores" | "shelves" | "par" | "requests";
const TABS: readonly Tab[] = ["categories", "items", "stores", "shelves", "par", "requests"];
const MASTERS = "stores.masters.manage";
const CLASSES = ["consumable", "consumable_dated", "stationery", "asset", "service", "reagent", "gas", "linen"] as const;
const MODES = ["expensed", "shelf", "durable"] as const;

const cell: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid var(--rule, #e3e3e3)", textAlign: "left", whiteSpace: "nowrap" };
const btn: React.CSSProperties = { minHeight: 34, padding: "0 12px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent" };
const primary: React.CSSProperties = { ...btn, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 600 };
const field: React.CSSProperties = { minHeight: 40, minWidth: 0 };

export function StoresDesk(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("categories");
  if (!can(MASTERS)) return <MyShelves />;
  return (
    <div data-testid="stores-desk" className="stores-ui" style={{ padding: "16px clamp(16px, 3vw, 24px)", display: "flex", flexDirection: "column", gap: 12, maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box" }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>{t("stores.desk.title")}</h1>
      <TicketLinks />
      <div role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {TABS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} style={tab === k ? primary : btn} onClick={() => setTab(k)}>{t(`stores.desk.tab.${k}`)}</button>
        ))}
      </div>
      {tab === "categories" && <CategoriesTab />}
      {tab === "items" && <ItemsTab />}
      {tab === "stores" && <StoresTab />}
      {tab === "shelves" && <ShelvesTab />}
      {tab === "par" && <ParTab />}
      {tab === "requests" && <RequestsTab />}
    </div>
  );
}

function MyShelves(): React.ReactElement {
  const { t } = useTranslation();
  const links = useRoleLinks();
  const mine = useQuery({ queryKey: ["stores", "my-shelves"], queryFn: myShelves });
  if (mine.data !== undefined && mine.data.shelves.length === 0) {
    return (
      <div className="stores-ui" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8, maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box" }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.desk.title")}</h1>
        <TicketLinks />
        {links.length === 0 && <p data-testid="stores-desk-denied" style={{ margin: 0 }}>{t("stores.desk.noPermission")}</p>}
      </div>
    );
  }
  return (
    <div data-testid="stores-my-shelves" className="stores-ui" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8, maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box" }}>
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.desk.title")}</h1>
      <TicketLinks />
      <h2 style={{ margin: 0, fontSize: 16 }}>{t("stores.shelf.pickShelf")}</h2>
      {(mine.data?.shelves ?? []).map((s) => (
        <Link key={s.id} to="/stores/shelf/$shelfId" params={{ shelfId: s.id }} style={{ minHeight: 44, display: "flex", alignItems: "center" }}>
          {`${s.departmentName ?? ""} · ${s.floorName ?? s.name}`}
        </Link>
      ))}
    </div>
  );
}

type RoleLink = { to: "/stores/approve" | "/stores/pick" | "/stores/receive" | "/stores/porter" | "/stores/passes" | "/stores/gate"; label: string };

/**
 * UX pass (walk finding 13) — each person's own Stores screens, by the grants they hold at ANY scope (an HOD's
 * approval is department-scoped). Presentation only: every screen's server read answers with what this person may
 * see, and refuses the rest.
 */
function useRoleLinks(): RoleLink[] {
  const { can, permissions } = useAuth();
  const any = (p: string): boolean => heldAnywhere(permissions, p);
  const out: RoleLink[] = [];
  if (any("stores.indents.approve")) out.push({ to: "/stores/approve", label: "stores.now.toApprove" });
  if (can(MASTERS) || can("materials.stock.issue") || can("stores.gatepass.raise") || any("stores.nightstore.issue")) out.push({ to: "/stores/pick", label: "stores.now.toPick" });
  if (any("stores.shelf.work")) out.push({ to: "/stores/receive", label: "stores.now.toReceive" });
  if (any("stores.carry")) out.push({ to: "/stores/porter", label: "stores.ux.porter" });
  if (can("stores.gatepass.raise")) out.push({ to: "/stores/passes", label: "nav.storesPasses" });
  if (any("stores.gatepass.scan")) out.push({ to: "/stores/gate", label: "nav.storesGate" });
  return out;
}

function TicketLinks(): React.ReactElement {
  const { t } = useTranslation();
  const links = useRoleLinks();
  return (
    <nav data-testid="stores-ticket-links" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {links.map((l) => <Link key={l.to} to={l.to} className="stores-btn">{t(l.label)}</Link>)}
    </nav>
  );
}

function useNotice(): [string | null, (e: unknown) => void, (s: string | null) => void] {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<string | null>(null);
  const fail = (e: unknown): void => {
    const code = storesErrorCode(e);
    setNotice(code === "not_permitted" ? t("stores.desk.noPermission") : t(`stores.err.${code ?? "failed"}`, { defaultValue: t("stores.shelf.failed") }));
  };
  return [notice, fail, setNotice];
}

function Empty(): React.ReactElement {
  const { t } = useTranslation();
  return <p style={{ margin: 0 }}>{t("stores.desk.nothingYet")}</p>;
}

function CategoriesTab(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ["stores", "categories"], queryFn: listCategories });
  const [f, setF] = useState({ code: "", name: "", nameHi: "", parentId: "" });
  const [notice, fail, setNotice] = useNotice();
  const rows = cats.data?.categories ?? [];
  const tops = rows.filter((c) => c.parentId === null);
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <form style={{ display: "flex", gap: 6, flexWrap: "wrap" }} onSubmit={(e) => {
        e.preventDefault();
        addCategory({ code: f.code, name: f.name, nameHi: f.nameHi || null, parentId: f.parentId || null })
          .then(() => { setF({ code: "", name: "", nameHi: "", parentId: "" }); setNotice(null); return qc.invalidateQueries({ queryKey: ["stores", "categories"] }); }).catch(fail);
      }}>
        <input style={field} aria-label={t("stores.desk.f.code")} placeholder={t("stores.desk.f.code")} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <input style={field} aria-label={t("stores.desk.f.name")} placeholder={t("stores.desk.f.name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input style={field} aria-label={t("stores.desk.f.nameHi")} placeholder={t("stores.desk.f.nameHi")} value={f.nameHi} onChange={(e) => setF({ ...f, nameHi: e.target.value })} />
        <select style={field} aria-label={t("stores.desk.f.parent")} value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}>
          <option value="">{t("stores.desk.f.topLevel")}</option>
          {tops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button type="submit" style={primary}>{t("stores.desk.addCategory")}</button>
      </form>
      {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
      {rows.length === 0 ? <Empty /> : (
        <table style={{ borderCollapse: "collapse" }}><tbody>
          {tops.map((c) => [
            <tr key={c.id}><td style={{ ...cell, fontWeight: 600 }}>{c.code}</td><td style={cell}>{c.name}</td><td style={cell}>{c.nameHi ?? ""}</td></tr>,
            ...rows.filter((s) => s.parentId === c.id).map((s) => <tr key={s.id}><td style={cell}>↳ {s.code}</td><td style={cell}>{s.name}</td><td style={cell}>{s.nameHi ?? ""}</td></tr>),
          ])}
        </tbody></table>
      )}
    </section>
  );
}

function ItemsTab(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const items = useQuery({ queryKey: ["stores", "items"], queryFn: listItems });
  const cats = useQuery({ queryKey: ["stores", "categories"], queryFn: listCategories });
  const [f, setF] = useState({ code: "", name: "", class: "consumable", baseUom: "piece", categoryId: "", trackMode: "shelf", aliases: "" });
  const [sheet, setSheet] = useState("");
  const [result, setResult] = useState<WireImportResult | null>(null);
  const [notice, fail, setNotice] = useNotice();
  const parseSheet = (): { code: string; name: string; class: string; baseUom: string; category: string; trackMode: string; aliases: string | null }[] =>
    sheet.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").map((l) => {
      const [code = "", name = "", klass = "", baseUom = "", category = "", trackMode = "", aliases = ""] = l.split(/\t|,/).map((x) => x.trim());
      return { code, name, class: klass, baseUom, category, trackMode, aliases: aliases || null };
    });
  const reload = (): Promise<void> => qc.invalidateQueries({ queryKey: ["stores", "items"] });
  const rows = items.data?.items ?? [];
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <form style={{ display: "flex", gap: 6, flexWrap: "wrap" }} onSubmit={(e) => {
        e.preventDefault();
        addItem({
          code: f.code, name: f.name, class: f.class, baseUom: f.baseUom, categoryId: f.categoryId || null,
          trackMode: f.trackMode as (typeof MODES)[number], searchAliases: f.aliases.split(";").map((a) => a.trim()).filter((a) => a !== ""),
        }).then(() => { setF({ ...f, code: "", name: "", aliases: "" }); setNotice(null); return reload(); }).catch(fail);
      }}>
        <input style={field} aria-label={t("stores.desk.f.code")} placeholder={t("stores.desk.f.code")} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <input style={field} aria-label={t("stores.desk.f.name")} placeholder={t("stores.desk.f.name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <select style={field} aria-label={t("stores.desk.f.class")} value={f.class} onChange={(e) => setF({ ...f, class: e.target.value })}>
          {CLASSES.map((c) => <option key={c} value={c}>{t(`stores.ux.class.${c}`)}</option>)}
        </select>
        <input style={{ ...field, width: 80 }} aria-label={t("stores.desk.f.unit")} placeholder={t("stores.desk.f.unit")} value={f.baseUom} onChange={(e) => setF({ ...f, baseUom: e.target.value })} />
        <select style={field} aria-label={t("stores.desk.f.category")} value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
          <option value="">{t("stores.desk.f.category")}</option>
          {(cats.data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.parentId === null ? c.name : `↳ ${c.name}`}</option>)}
        </select>
        <select style={field} aria-label={t("stores.desk.f.trackMode")} value={f.trackMode} onChange={(e) => setF({ ...f, trackMode: e.target.value })}>
          {MODES.map((m) => <option key={m} value={m}>{t(`stores.desk.track.${m}`)}</option>)}
        </select>
        <input style={field} aria-label={t("stores.desk.f.aliases")} placeholder={t("stores.desk.f.aliases")} value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} />
        <button type="submit" style={primary}>{t("stores.desk.addItem")}</button>
      </form>
      {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
      <details>
        <summary style={{ cursor: "pointer" }}>{t("stores.desk.importItems")}</summary>
        <p style={{ margin: "6px 0", fontSize: 12 }}>{t("stores.desk.importHint")}</p>
        <textarea aria-label={t("stores.desk.importItems")} value={sheet} onChange={(e) => { setSheet(e.target.value); setResult(null); }} rows={6} style={{ width: "100%", boxSizing: "border-box" }} />
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button type="button" style={btn} onClick={() => { importItems(parseSheet(), true).then(setResult).catch(fail); }}>{t("stores.desk.dryRun")}</button>
          <button type="button" style={primary} disabled={result === null || !result.dryRun || result.wouldCreate === 0} onClick={() => {
            importItems(parseSheet(), false).then((r) => { setResult(r); return reload(); }).catch(fail);
          }}>{t("stores.desk.importNow")}</button>
        </div>
        {result !== null && (
          <div data-testid="stores-import-result" style={{ marginTop: 6 }}>
            <p style={{ margin: 0 }}>{t(result.dryRun ? "stores.desk.wouldCreate" : "stores.desk.created", { n: result.dryRun ? result.wouldCreate : result.created })}</p>
            {result.refusals.length > 0 && (
              <table style={{ borderCollapse: "collapse" }}>
                <thead><tr><th style={cell}>{t("stores.desk.row")}</th><th style={cell}>{t("stores.desk.refusal")}</th></tr></thead>
                <tbody>{result.refusals.map((r) => <tr key={r.row}><td style={cell}>{String(r.row)}</td><td style={cell}>{r.message}</td></tr>)}</tbody>
              </table>
            )}
          </div>
        )}
      </details>
      {rows.length === 0 ? <Empty /> : (
        <table style={{ borderCollapse: "collapse" }}>
          <thead><tr>{["code", "name", "class", "category", "trackMode"].map((k) => <th key={k} style={cell}>{t(`stores.desk.f.${k}`)}</th>)}</tr></thead>
          <tbody>{rows.map((i) => (
            <tr key={i.id}><td style={cell}>{i.code}</td><td style={cell}>{i.name}</td><td style={cell}>{t(`stores.ux.class.${i.class}`, { defaultValue: i.class })}</td><td style={cell}>{i.categoryName ?? ""}</td><td style={cell}>{t(`stores.desk.track.${i.trackMode}`)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

function StoresTab(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const stores = useQuery({ queryKey: ["stores", "stores"], queryFn: listStores });
  const [f, setF] = useState({ code: "", name: "", kind: "sub" as "central" | "sub" | "night" });
  const [notice, fail, setNotice] = useNotice();
  const rows = stores.data?.stores ?? [];
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <form style={{ display: "flex", gap: 6, flexWrap: "wrap" }} onSubmit={(e) => {
        e.preventDefault();
        addStore(f).then(() => { setF({ ...f, code: "", name: "" }); setNotice(null); return qc.invalidateQueries({ queryKey: ["stores", "stores"] }); }).catch(fail);
      }}>
        <input style={field} aria-label={t("stores.desk.f.code")} placeholder={t("stores.desk.f.code")} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <input style={field} aria-label={t("stores.desk.f.name")} placeholder={t("stores.desk.f.name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <select style={field} aria-label={t("stores.desk.f.kind")} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "central" | "sub" | "night" })}>
          {(["central", "sub", "night"] as const).map((k) => <option key={k} value={k}>{t(`stores.desk.kind.${k}`)}</option>)}
        </select>
        <button type="submit" style={primary}>{t("stores.desk.addStore")}</button>
      </form>
      {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
      {rows.length === 0 ? <Empty /> : (
        <table style={{ borderCollapse: "collapse" }}><tbody>
          {rows.map((s) => <tr key={s.id}><td style={cell}>{s.code}</td><td style={cell}>{s.name}</td><td style={cell}>{t(`stores.desk.kind.${s.kind}`)}</td></tr>)}
        </tbody></table>
      )}
    </section>
  );
}

function ShelvesTab(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const shelves = useQuery({ queryKey: ["stores", "shelves"], queryFn: listAllShelves });
  const stores = useQuery({ queryKey: ["stores", "stores"], queryFn: listStores });
  const pick = useQuery({ queryKey: ["stores", "pickers"], queryFn: pickers });
  const cards = useQuery({ queryKey: ["stores", "cards"], queryFn: overBookCards });
  const [f, setF] = useState({ code: "", name: "", floorId: "", departmentId: "", suppliedBy: "" });
  const [notice, fail, setNotice] = useNotice();
  const rows = shelves.data?.shelves ?? [];
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <form style={{ display: "flex", gap: 6, flexWrap: "wrap" }} onSubmit={(e) => {
        e.preventDefault();
        addShelf(f).then(() => { setF({ ...f, code: "", name: "" }); setNotice(null); return qc.invalidateQueries({ queryKey: ["stores", "shelves"] }); }).catch(fail);
      }}>
        <input style={field} aria-label={t("stores.desk.f.code")} placeholder={t("stores.desk.f.code")} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <input style={field} aria-label={t("stores.desk.f.name")} placeholder={t("stores.desk.f.name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <select style={field} aria-label={t("stores.desk.f.floor")} value={f.floorId} onChange={(e) => setF({ ...f, floorId: e.target.value })}>
          <option value="">{t("stores.desk.f.floor")}</option>
          {(pick.data?.floors ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <select style={field} aria-label={t("stores.desk.f.department")} value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>
          <option value="">{t("stores.desk.f.department")}</option>
          {(pick.data?.departments ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <select style={field} aria-label={t("stores.desk.f.suppliedBy")} value={f.suppliedBy} onChange={(e) => setF({ ...f, suppliedBy: e.target.value })}>
          <option value="">{t("stores.desk.f.suppliedBy")}</option>
          {(stores.data?.stores ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <button type="submit" style={primary}>{t("stores.desk.addShelf")}</button>
      </form>
      {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
      {(cards.data?.cards ?? []).length > 0 && (
        <div data-testid="stores-over-book" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>{t("stores.desk.overBook")}</h2>
          {(cards.data?.cards ?? []).map((c) => (
            <div key={c.cardId} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ flex: 1, minWidth: 0 }}>{`${c.shelfName}: ${c.lines.map((l) => `${l.name} ${String(l.book)} → ${String(l.counted)}`).join(", ")}`}</span>
              <Link to="/stores/shelf/$shelfId" params={{ shelfId: c.shelfId }} search={{ check: 1 }} className="stores-btn">{t("stores.ux.openCheck")}</Link>
            </div>
          ))}
        </div>
      )}
      {rows.length === 0 ? <Empty /> : (
        <table style={{ borderCollapse: "collapse" }}><tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td style={cell}>{s.code}</td><td style={cell}>{s.departmentName ?? ""}</td><td style={cell}>{s.floorName ?? ""}</td>
              <td style={cell}><Link to="/stores/shelf/$shelfId" params={{ shelfId: s.id }}>{t("stores.desk.open")}</Link></td>
            </tr>
          ))}
        </tbody></table>
      )}
    </section>
  );
}

function ParTab(): React.ReactElement {
  const { t } = useTranslation();
  const shelves = useQuery({ queryKey: ["stores", "shelves"], queryFn: listAllShelves });
  const items = useQuery({ queryKey: ["stores", "items"], queryFn: listItems });
  const [f, setF] = useState({ shelfId: "", itemId: "", minBase: "", reorderBase: "", maxBase: "" });
  const [notice, fail, setNotice] = useNotice();
  const num = (k: "minBase" | "reorderBase" | "maxBase") => (
    <input style={{ ...field, width: 70 }} inputMode="numeric" aria-label={t(`stores.desk.f.${k}`)} placeholder={t(`stores.desk.f.${k}`)} value={f[k]}
      onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/\D/g, "") })} />
  );
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <form style={{ display: "flex", gap: 6, flexWrap: "wrap" }} onSubmit={(e) => {
        e.preventDefault();
        setPar({ shelfId: f.shelfId, itemId: f.itemId, minBase: Number(f.minBase), reorderBase: Number(f.reorderBase), maxBase: Number(f.maxBase) })
          .then(() => setNotice(t("stores.shelf.saved"))).catch(fail);
      }}>
        <select style={field} aria-label={t("stores.desk.f.shelf")} value={f.shelfId} onChange={(e) => setF({ ...f, shelfId: e.target.value })}>
          <option value="">{t("stores.desk.f.shelf")}</option>
          {(shelves.data?.shelves ?? []).map((s) => <option key={s.id} value={s.id}>{`${s.code} · ${s.departmentName ?? ""}`}</option>)}
        </select>
        <select style={field} aria-label={t("stores.desk.f.item")} value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}>
          <option value="">{t("stores.desk.f.item")}</option>
          {(items.data?.items ?? []).filter((i) => i.trackMode !== "expensed").map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        {num("minBase")}{num("reorderBase")}{num("maxBase")}
        <button type="submit" style={primary}>{t("stores.desk.setPar")}</button>
      </form>
      {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
    </section>
  );
}

function RequestsTab(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const reqs = useQuery({ queryKey: ["stores", "requests"], queryFn: listRequests });
  const items = useQuery({ queryKey: ["stores", "items"], queryFn: listItems });
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState<string | null>(null);
  const [notice, fail, setNotice] = useNotice();
  const rows = reqs.data?.requests ?? [];
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
      {rows.length === 0 ? <Empty /> : rows.map((r) => (
        <div key={r.id} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid var(--rule, #e3e3e3)", padding: "6px 0" }}>
          <strong>{r.name}</strong>
          {r.similar.length > 0 && <span style={{ fontSize: 12 }}>{t("stores.desk.similar")}: {r.similar.map((s) => s.name).join(", ")}</span>}
          <select style={field} aria-label={t("stores.desk.f.item")} value={chosen[r.id] ?? ""} onChange={(e) => setChosen({ ...chosen, [r.id]: e.target.value })}>
            <option value="">{t("stores.desk.f.item")}</option>
            {(items.data?.items ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button type="button" style={btn} disabled={(chosen[r.id] ?? "") === ""} onClick={() => {
            resolveRequest(r.id, "use_existing", chosen[r.id]!).then(() => { setNotice(t("stores.desk.outcome.use_existing")); return qc.invalidateQueries({ queryKey: ["stores", "requests"] }); }).catch(fail);
          }}>{`${t("stores.desk.resolve")}: ${t("stores.desk.outcome.use_existing")}`}</button>
          {creating !== r.id && <button type="button" style={primary} onClick={() => setCreating(r.id)}>{t("stores.ux.createItem")}</button>}
          {creating === r.id && (
            <CreateFromRequest request={r} onDone={() => { setCreating(null); setNotice(t("stores.desk.outcome.created")); void qc.invalidateQueries({ queryKey: ["stores", "requests"] }); void qc.invalidateQueries({ queryKey: ["stores", "items"] }); }}
              onCancel={() => setCreating(null)} fail={fail} />
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * UX pass (walk finding 16) — a new-item request is resolved where it is read: the item form, prefilled with the
 * name the department typed, creates the item and resolves the request as "created" with it, in one submit.
 */
function CreateFromRequest({ request, onDone, onCancel, fail }: {
  request: WireItemRequest; onDone: () => void; onCancel: () => void; fail: (e: unknown) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const cats = useQuery({ queryKey: ["stores", "categories"], queryFn: listCategories });
  const [f, setF] = useState({ code: "", name: request.name, class: "consumable", baseUom: "piece", categoryId: "", trackMode: "shelf" });
  const [busy, setBusy] = useState(false);
  return (
    <form data-testid={`request-create-${request.id}`} style={{ display: "flex", gap: 6, flexWrap: "wrap", width: "100%" }} onSubmit={(e) => {
      e.preventDefault();
      setBusy(true);
      addItem({ code: f.code, name: f.name, class: f.class, baseUom: f.baseUom, categoryId: f.categoryId || null, trackMode: f.trackMode as (typeof MODES)[number] })
        .then((r) => resolveRequest(request.id, "created", r.itemId))
        .then(onDone).catch(fail).finally(() => setBusy(false));
    }}>
      <input style={field} aria-label={t("stores.desk.f.code")} placeholder={t("stores.desk.f.code")} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
      <input style={{ ...field, flex: 1, minWidth: 160 }} aria-label={t("stores.desk.f.name")} placeholder={t("stores.desk.f.name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <select style={field} aria-label={t("stores.desk.f.class")} value={f.class} onChange={(e) => setF({ ...f, class: e.target.value })}>
        {CLASSES.map((c) => <option key={c} value={c}>{t(`stores.ux.class.${c}`)}</option>)}
      </select>
      <input style={{ ...field, width: 80 }} aria-label={t("stores.desk.f.unit")} placeholder={t("stores.desk.f.unit")} value={f.baseUom} onChange={(e) => setF({ ...f, baseUom: e.target.value })} />
      <select style={field} aria-label={t("stores.desk.f.category")} value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
        <option value="">{t("stores.desk.f.category")}</option>
        {(cats.data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.parentId === null ? c.name : `↳ ${c.name}`}</option>)}
      </select>
      <select style={field} aria-label={t("stores.desk.f.trackMode")} value={f.trackMode} onChange={(e) => setF({ ...f, trackMode: e.target.value })}>
        {MODES.map((m) => <option key={m} value={m}>{t(`stores.desk.track.${m}`)}</option>)}
      </select>
      <button type="submit" style={primary} disabled={busy || f.code.trim() === "" || f.name.trim() === ""}>{t("stores.desk.addItem")}</button>
      <button type="button" style={btn} onClick={onCancel}>{t("stores.ticket.cancel")}</button>
    </form>
  );
}
