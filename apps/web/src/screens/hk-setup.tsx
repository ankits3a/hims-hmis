import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { PaperScreen } from "../components/paper-screen";
import {
  addContractorApi, cleanRefusal, defineAreaApi, doorUrl, fetchAreaQr, fetchHkSetup, revokeAreaQrApi, saveChecklistApi, setHkStaffApi,
} from "../lib/housekeeping-api";
import type { HkAreaView, HkSetupView } from "@hmis/contracts";
import "./housekeeping.css";

/**
 * HK-1 (#973, decision 0086) — HOUSEKEEPING SETUP: areas (a class, a checklist, a photo rule) and their door QR (print,
 * or revoke and reprint), checklists (a change is a new version), contractors (reports only, no deductions), and each
 * person's company and trained skills. The door QR opens `/door#<token>` on any phone: no login, four needs.
 */
const CLASSES = ["A", "B", "C_toilet", "C_public", "D"] as const;
const SKILLS = ["critical", "spill", "terminal"] as const;

export function HkSetup(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["housekeeping", "setup"], queryFn: fetchHkSetup });
  const [notice, setNotice] = useState<string | null>(null);
  const [qr, setQr] = useState<{ area: HkAreaView; token: string } | null>(null);
  const s: HkSetupView | undefined = q.data;
  const act = async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    setNotice(null);
    try { await fn(); setNotice(ok); void qc.invalidateQueries({ queryKey: ["housekeeping", "setup"] }); return true; } catch (e) {
      const r = cleanRefusal(e); setNotice(r === null ? t("tasks.refusal.failed") : `${r.message} ${r.fix}`.trim()); return false;
    }
  };

  // Area form
  const [place, setPlace] = useState("");
  const [cls, setCls] = useState<string>("B");
  const [list, setList] = useState("");
  // Checklist form
  const [listName, setListName] = useState("");
  const [listItems, setListItems] = useState("");
  const [lineage, setLineage] = useState<string | undefined>(undefined);
  // Contractor and staff forms
  const [ctr, setCtr] = useState("");
  const [person, setPerson] = useState("");
  const [company, setCompany] = useState("");
  const [skills, setSkills] = useState<string[]>([]);

  const showQr = async (a: HkAreaView): Promise<void> => {
    try { setQr({ area: a, token: (await fetchAreaQr(a.id)).token }); } catch (e) { const r = cleanRefusal(e); setNotice(r?.message ?? t("tasks.refusal.failed")); }
  };

  return (
    <PaperScreen testId="hk-setup">
      <div className="hk-page">
        <h1>{t("housekeeping.setup.title")}</h1>
        {notice !== null && <p role="status" className="hk-hint">{notice}</p>}

        <section aria-label={t("housekeeping.setup.areas")}>
          <h2>{t("housekeeping.setup.areas")}</h2>
          <form className="hk-form" onSubmit={(e) => {
            e.preventDefault();
            void act(() => defineAreaApi({ resourceId: place, areaClass: cls, checklistId: list === "" ? null : list }), t("housekeeping.setup.areaSaved"));
          }}>
            <label>{t("housekeeping.setup.place")}
              <select value={place} onChange={(e) => setPlace(e.target.value)} required>
                <option value="">—</option>
                {(s?.places ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.floorName !== null && p.kind !== "floor" ? ` · ${p.floorName}` : ""}</option>)}
              </select>
            </label>
            <label>{t("housekeeping.setup.class")}
              <select value={cls} onChange={(e) => setCls(e.target.value)}>
                {CLASSES.map((c) => <option key={c} value={c}>{t(`housekeeping.class.${c}`)}</option>)}
              </select>
            </label>
            <label>{t("housekeeping.setup.checklist")}
              <select value={list} onChange={(e) => setList(e.target.value)}>
                <option value="">—</option>
                {(s?.checklists ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} · v{c.version}</option>)}
              </select>
            </label>
            <button type="submit" className="hk-btn pri" disabled={place === ""}>{t("housekeeping.setup.saveArea")}</button>
          </form>
          <table className="hk-table" style={{ marginTop: 8 }}>
            <thead><tr><th>{t("housekeeping.setup.place")}</th><th>{t("housekeeping.setup.class")}</th><th>{t("housekeeping.setup.photo")}</th><th>{t("housekeeping.setup.qr")}</th></tr></thead>
            <tbody>
              {(s?.areas ?? []).map((a) => (
                <tr key={a.id}>
                  <td><b>{a.name}</b> <small>{a.floorName ?? ""}</small></td>
                  <td>{t(`housekeeping.class.${a.areaClass}`)}</td>
                  <td>{a.photoNeeded ? t("housekeeping.setup.yes") : t("housekeeping.setup.no")}</td>
                  <td>
                    <button type="button" className="hk-btn" onClick={() => void showQr(a)}>{t("housekeeping.setup.showQr")}</button>{" "}
                    <button type="button" className="hk-btn" onClick={() => void act(() => revokeAreaQrApi(a.id), t("housekeeping.setup.revoked"))}>{t("housekeeping.setup.revoke")}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {qr !== null && (
            <div className="hk-qr hk-print" data-testid="hk-qr">
              <b>{qr.area.name}</b>
              <QRCodeSVG value={doorUrl(qr.token)} size={180} />
              <span>{t("housekeeping.setup.qrLine")}</span>
              <button type="button" className="hk-btn no-print" onClick={() => window.print()}>{t("housekeeping.setup.print")}</button>
            </div>
          )}
        </section>

        <section aria-label={t("housekeeping.setup.checklists")}>
          <h2>{t("housekeeping.setup.checklists")}</h2>
          <form className="hk-form" onSubmit={(e) => {
            e.preventDefault();
            const items = listItems.split("\n").map((x) => x.trim()).filter((x) => x !== "").map((text) => ({ text }));
            void act(() => saveChecklistApi({ name: listName, items, ...(lineage === undefined ? {} : { lineageId: lineage }) }), t("housekeeping.setup.listSaved"))
              .then((ok) => { if (ok) { setListName(""); setListItems(""); setLineage(undefined); } });
          }}>
            <label>{t("housekeeping.setup.listName")}<input value={listName} onChange={(e) => setListName(e.target.value)} required maxLength={200} /></label>
            <label>{t("housekeeping.setup.listItems")}<textarea value={listItems} onChange={(e) => setListItems(e.target.value)} rows={5} required /></label>
            <button type="submit" className="hk-btn pri">{lineage === undefined ? t("housekeeping.setup.saveList") : t("housekeeping.setup.saveVersion")}</button>
          </form>
          <ul>
            {(s?.checklists ?? []).map((c) => (
              <li key={c.id}>
                <b>{c.name}</b> · v{c.version} · {t("housekeeping.setup.items", { count: c.items.length })}{" "}
                <button type="button" className="hk-btn" onClick={() => { setLineage(c.lineageId); setListName(c.name); setListItems(c.items.map((i) => i.text).join("\n")); }}>
                  {t("housekeeping.setup.edit")}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label={t("housekeeping.setup.contractors")}>
          <h2>{t("housekeeping.setup.contractors")}</h2>
          <form className="hk-form" onSubmit={(e) => { e.preventDefault(); void act(() => addContractorApi(ctr), t("housekeeping.setup.ctrSaved")).then((ok) => { if (ok) setCtr(""); }); }}>
            <label>{t("housekeeping.setup.ctrName")}<input value={ctr} onChange={(e) => setCtr(e.target.value)} required maxLength={200} /></label>
            <button type="submit" className="hk-btn pri">{t("housekeeping.setup.addCtr")}</button>
          </form>
          <p>{(s?.contractors ?? []).map((c) => c.name).join(" · ")}</p>
        </section>

        <section aria-label={t("housekeeping.setup.staff")}>
          <h2>{t("housekeeping.setup.staff")}</h2>
          <form className="hk-form" onSubmit={(e) => {
            e.preventDefault();
            void act(() => setHkStaffApi({ userId: person, contractorId: company === "" ? null : company, skills }), t("housekeeping.setup.staffSaved"));
          }}>
            <label>{t("housekeeping.setup.person")}
              <select value={person} onChange={(e) => {
                setPerson(e.target.value);
                const p = s?.staff.find((x) => x.userId === e.target.value);
                setCompany(p?.contractorId ?? ""); setSkills(p?.skills ?? []);
              }} required>
                <option value="">—</option>
                {(s?.people ?? []).map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
              </select>
            </label>
            <label>{t("housekeeping.setup.company")}
              <select value={company} onChange={(e) => setCompany(e.target.value)}>
                <option value="">{t("housekeeping.setup.inHouse")}</option>
                {(s?.contractors ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            {SKILLS.map((k) => (
              <label key={k} style={{ flexDirection: "row", alignItems: "center" }}>
                <input type="checkbox" checked={skills.includes(k)} onChange={(e) => setSkills((cur) => (e.target.checked ? [...cur, k] : cur.filter((x) => x !== k)))} />
                {t(`housekeeping.skill.${k}`)}
              </label>
            ))}
            <button type="submit" className="hk-btn pri" disabled={person === ""}>{t("housekeeping.setup.saveStaff")}</button>
          </form>
          <table className="hk-table" style={{ marginTop: 8 }}>
            <thead><tr><th>{t("housekeeping.setup.person")}</th><th>{t("housekeeping.setup.company")}</th><th>{t("housekeeping.setup.skills")}</th></tr></thead>
            <tbody>
              {(s?.staff ?? []).map((p) => (
                <tr key={p.userId}><td>{p.name}</td><td>{p.company}</td><td>{p.skills.map((k) => t(`housekeeping.skill.${k}`)).join(", ")}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </PaperScreen>
  );
}
