import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { useAuth } from "../lib/auth";
import {
  addVendorFullApi, fetchLinenSetup, fileLicenceApi, itemCostApi, linenRefusal, rupees, uniformRoleApi, updateVendorApi, vendorRateApi,
} from "../lib/linen-api";
import { LinenTabs } from "./linen-store";
import type { LinenSetupView } from "@hmis/contracts";
import "./linen.css";

/**
 * ═══ LD-2 SETUP (#1014, decisions 0087 and 0092) — the laundry desk's setup (16:9; one column on a phone) ═══
 *
 * Centre: each vendor with its turnaround (routine, rush), GST and rate card; add a vendor. Below: every linen item's
 * replacement cost (the item master price; a stores goods receipt wins when the item is linked). Right: the wastewater
 * consent and the boiler licence with expiry (red within 60 days), and the roles issued uniforms. Every write is an
 * existing LD-2 act; the server refuses with words.
 */
type Say = (ok: boolean, text: string) => void;
const today = (): string => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const toPaise = (v: string): number => Math.round(Number(v) * 100);

export function LinenSetup(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const setup = useQuery({ queryKey: ["linen", "setup"], queryFn: fetchLinenSetup });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const say: Say = (ok, text) => setNotice({ ok, text });
  const d = setup.data;
  return (
    <PaperScreen testId="linen-setup" style={{ height: "var(--pp-h)" }}>
      <div className="lp-desk">
        <LinenTabs on="setup" />
        <div className="lp-grid store vendor">
          <section className="lp-centre">
            <div className="lp-title">
              <div><h1>{t("linen.setup.title")}</h1><p>{t("linen.setup.sub")}</p></div>
              {notice !== null && <p role="alert" className={notice.ok ? "ln-notice ok" : "ln-notice"} data-testid="setup-notice">{notice.text}</p>}
            </div>
            {(d?.vendors ?? []).map((v) => <VendorBox key={v.id} v={v} items={d!.items} say={say} />)}
            <AddVendor say={say} />
            {d !== undefined && <ItemCosts items={d.items} say={say} />}
          </section>
          <aside className="lp-side">
            {d !== undefined && <Licences licences={d.licences} say={say} />}
            {d !== undefined && can("linen.manage") && <UniformRoles roles={d.uniformRoles} say={say} />}
          </aside>
        </div>
      </div>
    </PaperScreen>
  );
}

function useAct(say: Say) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { say(true, t("linen.setup.saved")); void qc.invalidateQueries({ queryKey: ["linen"] }); },
    onError: (e) => say(false, t(`linen.refusal.${linenRefusal(e) ?? "failed"}`, { defaultValue: t("linen.refusal.failed") })),
  });
}

/** One vendor: turnaround and GST (editable), its rate card, and a new rate from a date. */
function VendorBox({ v, items, say }: { v: LinenSetupView["vendors"][number]; items: LinenSetupView["items"]; say: Say }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct(say);
  const [terms, setTerms] = useState({ routine: String(v.turnaroundHours), rush: String(v.rushTurnaroundHours), gst: String(v.gstRateBps / 100) });
  const [rate, setRate] = useState({ itemCode: items[0]?.code ?? "bedsheet", rupees: "", from: today() });
  const termsOk = Number(terms.routine) >= 1 && Number(terms.rush) >= 1 && Number(terms.gst) >= 0;
  return (
    <section className="box" data-testid={`setup-vendor-${v.id}`}>
      <header className="lp-h"><b>{v.name}</b><span className="mono">{t("linen.setup.terms", { routine: v.turnaroundHours, rush: v.rushTurnaroundHours, gst: v.gstRateBps / 100 })}</span></header>
      <div className="lp-form" style={{ padding: "8px 12px" }}>
        <label>{t("linen.setup.routine")}<input inputMode="numeric" value={terms.routine} onChange={(e) => setTerms({ ...terms, routine: e.target.value })} data-testid={`routine-${v.id}`} /></label>
        <label>{t("linen.setup.rush")}<input inputMode="numeric" value={terms.rush} onChange={(e) => setTerms({ ...terms, rush: e.target.value })} /></label>
        <label>{t("linen.setup.gst")}<input inputMode="decimal" value={terms.gst} onChange={(e) => setTerms({ ...terms, gst: e.target.value })} /></label>
        <button type="button" className="ln-mini" disabled={!termsOk || act.isPending} data-testid={`terms-save-${v.id}`}
          onClick={() => act.mutate(() => updateVendorApi(v.id, { turnaroundHours: Math.floor(Number(terms.routine)), rushTurnaroundHours: Math.floor(Number(terms.rush)), gstRateBps: Math.round(Number(terms.gst) * 100) }))}>
          {t("linen.setup.saveTerms")}
        </button>
      </div>
      <table className="lp-table" data-testid={`rates-${v.id}`}>
        <thead><tr><th>{t("linen.setup.item")}</th><th>{t("linen.setup.rate")}</th><th>{t("linen.setup.from")}</th></tr></thead>
        <tbody>
          {v.rates.map((r) => (
            <tr key={`${r.itemCode}-${r.effectiveFrom}`}><td>{t(`linen.item.${r.itemCode}`, { defaultValue: r.itemCode })}</td><td className="mono">{rupees(r.ratePaise)}</td><td className="mono">{r.effectiveFrom}</td></tr>
          ))}
          {v.rates.length === 0 && <tr><td colSpan={3} className="ln-empty">{t("linen.setup.noRates")}</td></tr>}
        </tbody>
      </table>
      <div className="lp-form" style={{ padding: "8px 12px" }}>
        <label>{t("linen.setup.item")}
          <select value={rate.itemCode} onChange={(e) => setRate({ ...rate, itemCode: e.target.value })} data-testid={`rate-item-${v.id}`}>
            {items.map((i) => <option key={i.code} value={i.code}>{t(`linen.item.${i.code}`, { defaultValue: i.name })}</option>)}
          </select>
        </label>
        <label>{t("linen.setup.rate")}<input inputMode="decimal" value={rate.rupees} onChange={(e) => setRate({ ...rate, rupees: e.target.value })} data-testid={`rate-rupees-${v.id}`} /></label>
        <label>{t("linen.setup.from")}<input type="date" value={rate.from} onChange={(e) => setRate({ ...rate, from: e.target.value })} data-testid={`rate-from-${v.id}`} /></label>
        <button type="button" className="ln-mini ok" disabled={!(Number(rate.rupees) >= 0) || rate.rupees === "" || rate.from === "" || act.isPending} data-testid={`rate-save-${v.id}`}
          onClick={() => act.mutate(() => vendorRateApi(v.id, rate.itemCode, toPaise(rate.rupees), rate.from))}>{t("linen.setup.addRate")}</button>
      </div>
    </section>
  );
}

function AddVendor({ say }: { say: Say }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct(say);
  const [f, setF] = useState({ name: "", routine: "24", rush: "12", gst: "18" });
  const ok = f.name.trim().length >= 2 && Number(f.routine) >= 1 && Number(f.rush) >= 1 && Number(f.gst) >= 0;
  return (
    <section className="box" data-testid="setup-add-vendor">
      <header className="lp-h"><b>{t("linen.setup.addVendor")}</b></header>
      <div className="lp-form" style={{ padding: "8px 12px" }}>
        <label>{t("linen.setup.name")}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="vendor-name" /></label>
        <label>{t("linen.setup.routine")}<input inputMode="numeric" value={f.routine} onChange={(e) => setF({ ...f, routine: e.target.value })} /></label>
        <label>{t("linen.setup.rush")}<input inputMode="numeric" value={f.rush} onChange={(e) => setF({ ...f, rush: e.target.value })} /></label>
        <label>{t("linen.setup.gst")}<input inputMode="decimal" value={f.gst} onChange={(e) => setF({ ...f, gst: e.target.value })} /></label>
        <button type="button" className="ln-mini ok" disabled={!ok || act.isPending} data-testid="vendor-add"
          onClick={() => act.mutate(async () => {
            await addVendorFullApi({ name: f.name.trim(), turnaroundHours: Math.floor(Number(f.routine)), rushTurnaroundHours: Math.floor(Number(f.rush)), gstRateBps: Math.round(Number(f.gst) * 100) });
            setF({ name: "", routine: "24", rush: "12", gst: "18" });
          })}>{t("linen.setup.add")}</button>
      </div>
    </section>
  );
}

/** Replacement cost per piece: the item master price (a linked stores item's last goods receipt wins on the server). */
function ItemCosts({ items, say }: { items: LinenSetupView["items"]; say: Say }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct(say);
  const [edit, setEdit] = useState<Record<string, string>>({});
  return (
    <section className="box" data-testid="setup-items">
      <header className="lp-h"><b>{t("linen.setup.costs")}</b></header>
      <table className="lp-table">
        <thead><tr><th>{t("linen.setup.item")}</th><th>{t("linen.setup.price")}</th><th /></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.code} data-testid={`cost-${i.code}`}>
              <td>{t(`linen.item.${i.code}`, { defaultValue: i.name })}{i.materialsItemId !== null && <span className="ln-dim"> · {t("linen.setup.fromStores")}</span>}</td>
              <td><span className="lp-form"><input inputMode="decimal" placeholder={i.pricePaise === null ? t("linen.setup.unpriced") : rupees(i.pricePaise)}
                value={edit[i.code] ?? ""} onChange={(e) => setEdit({ ...edit, [i.code]: e.target.value })} data-testid={`cost-in-${i.code}`} /></span></td>
              <td><button type="button" className="ln-mini" disabled={edit[i.code] === undefined || edit[i.code] === "" || act.isPending} data-testid={`cost-save-${i.code}`}
                onClick={() => act.mutate(async () => { await itemCostApi(i.code, toPaise(edit[i.code]!)); setEdit((e) => { const next = { ...e }; delete next[i.code]; return next; }); })}>{t("linen.setup.save")}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Licences({ licences, say }: { licences: LinenSetupView["licences"]; say: Say }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct(say);
  const [f, setF] = useState({ kind: "etp_consent" as "etp_consent" | "boiler", licenceNo: "", authority: "", validFrom: today(), validTo: "" });
  const ok = f.licenceNo.trim().length >= 2 && f.authority.trim().length >= 2 && f.validFrom !== "" && f.validTo !== "" && f.validTo >= f.validFrom;
  return (
    <section className="box" data-testid="setup-licences">
      <header className="lp-h"><b>{t("linen.vendor.licences")}</b></header>
      {(["etp_consent", "boiler"] as const).map((k) => {
        const l = licences.find((x) => x.kind === k);
        return (
          <div key={k} className="lp-crow" data-testid={`setup-licence-${k}`}>
            <div><b>{t(`linen.vendor.licence.${k}`)}</b><small>{l === undefined ? t("linen.setup.notFiled") : `${l.licenceNo} · ${l.validTo}`}</small></div>
            {l !== undefined && <span className={l.state === "ok" ? "ln-tag" : "ln-tag inf"}>{l.state === "expired" ? t("linen.vendor.expired") : t("linen.vendor.daysLeft", { count: l.daysLeft })}</span>}
          </div>
        );
      })}
      <div className="lp-form" style={{ padding: "8px 12px" }}>
        <label>{t("linen.setup.licence")}
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "etp_consent" | "boiler" })} data-testid="licence-kind">
            <option value="etp_consent">{t("linen.vendor.licence.etp_consent")}</option>
            <option value="boiler">{t("linen.vendor.licence.boiler")}</option>
          </select>
        </label>
        <label>{t("linen.setup.licenceNo")}<input value={f.licenceNo} onChange={(e) => setF({ ...f, licenceNo: e.target.value })} data-testid="licence-no" /></label>
        <label>{t("linen.setup.authority")}<input value={f.authority} onChange={(e) => setF({ ...f, authority: e.target.value })} data-testid="licence-authority" /></label>
        <label>{t("linen.setup.validFrom")}<input type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} /></label>
        <label>{t("linen.setup.validTo")}<input type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} data-testid="licence-to" /></label>
        <button type="button" className="ln-mini ok" disabled={!ok || act.isPending} data-testid="licence-save"
          onClick={() => act.mutate(() => fileLicenceApi({ ...f, licenceNo: f.licenceNo.trim(), authority: f.authority.trim() }))}>{t("linen.setup.file")}</button>
      </div>
    </section>
  );
}

/** The roles whose staff are issued uniforms: remove one, or add a role by its key. */
function UniformRoles({ roles, say }: { roles: string[]; say: Say }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct(say);
  const [role, setRole] = useState("");
  return (
    <section className="box" data-testid="setup-roles">
      <header className="lp-h"><b>{t("linen.uniforms.roles")}</b><span className="mono">{roles.length}</span></header>
      {roles.map((r) => (
        <div key={r} className="lp-crow">
          <span className="mono">{r}</span>
          <button type="button" className="ln-mini" disabled={act.isPending} onClick={() => act.mutate(() => uniformRoleApi(r, false))} data-testid={`role-off-${r}`}>{t("linen.setup.remove")}</button>
        </div>
      ))}
      <div className="lp-form" style={{ padding: "8px 12px" }}>
        <label>{t("linen.setup.roleKey")}<input value={role} onChange={(e) => setRole(e.target.value)} data-testid="role-key" /></label>
        <button type="button" className="ln-mini ok" disabled={role.trim().length < 2 || act.isPending} data-testid="role-add"
          onClick={() => act.mutate(async () => { await uniformRoleApi(role.trim(), true); setRole(""); })}>{t("linen.setup.add")}</button>
      </div>
    </section>
  );
}
