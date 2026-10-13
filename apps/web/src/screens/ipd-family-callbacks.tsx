import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdFamilyCallbackList } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { closeFamilyCallback, listFamilyCallbacks } from "../lib/ipd-family-api";
import "./ipd-family-desk.css";

/*
 * E3.3 (#731) — THE WARD DESK'S FAMILY CALLBACKS (spec §4.10 edge 14): every "Request a callback" a family sent from the
 * family page, oldest first. The desk calls the attendant back (or hands it to the nurse in charge / the doctor) and
 * marks it done with a note. Nothing on this screen or behind it answers a question automatically. `ipd.family.issue`.
 * Works at 390 px (a ward phone) and on the desk's 1920 × 1080.
 */

const when = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(iso));
const POLL_MS = 30_000;

export function IpdFamilyCallbacks(): React.ReactElement {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"open" | "done">("open");
  const [list, setList] = useState<IpdFamilyCallbackList | null>(null);
  const [error, setError] = useState<"forbidden" | "failed" | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    listFamilyCallbacks(status).then((l) => { setList(l); setError(null); }, (e: unknown) => setError(e instanceof ApiError && e.status === 403 ? "forbidden" : "failed"));
  }, [status]);
  useEffect(() => { load(); const id = setInterval(load, POLL_MS); return () => clearInterval(id); }, [load]);
  const close = (id: string) => {
    const note = (notes[id] ?? "").trim();
    if (note === "") return;
    setBusy(id);
    closeFamilyCallback(id, note).then(() => { setBusy(null); load(); }, () => { setBusy(null); setError("failed"); });
  };
  return (
    <main className="ipdfc" data-testid="ipd-family-callbacks">
      <header className="ipdfc-head">
        <h1>{t("ipdFamilyCalls.title")}</h1>
        <div className="seg" role="group" aria-label={t("ipdFamilyCalls.show")}>
          <button type="button" aria-pressed={status === "open"} className={status === "open" ? "on" : ""} onClick={() => setStatus("open")}>{t("ipdFamilyCalls.open")}</button>
          <button type="button" aria-pressed={status === "done"} className={status === "done" ? "on" : ""} onClick={() => setStatus("done")}>{t("ipdFamilyCalls.done")}</button>
        </div>
      </header>
      <p className="ipdfc-note">{t("ipdFamilyCalls.note")}</p>
      {error === "forbidden" ? <div className="ipdfc-empty" role="alert">{t("ipdFamilyCalls.forbidden")}</div> : null}
      {error === "failed" ? <div className="ipdfc-empty warn" role="alert">{t("ipdFamilyCalls.failed")}</div> : null}
      {list === null && error === null ? <div className="ipdfc-empty">{t("ipdFamilyCalls.loading")}</div> : null}
      {list !== null && list.rows.length === 0 ? <div className="ipdfc-empty">{status === "open" ? t("ipdFamilyCalls.emptyOpen") : t("ipdFamilyCalls.emptyDone")}</div> : null}
      <ul className="ipdfc-list" aria-label={t("ipdFamilyCalls.title")}>
        {list?.rows.map((c) => (
          <li key={c.id} className={`ipdfc-row ${c.status}`}>
            <div className="top">
              <b>{c.privacy === "sealed" ? t("ipdFamilyCalls.sealed") : c.patientName ?? "—"}</b>
              <span className="mono">{[c.bedCode, c.wardName].filter(Boolean).join(" · ")}</span>
              <span className="mono when">{when(c.createdAt)}</span>
            </div>
            <q className="text">{c.text}</q>
            <div className="bottom">
              <span className="phone">☎ <span className="mono">{c.phoneMasked}</span></span>
              <Link to="/ipd/discharge" search={{ admission: c.admissionId } as never} className="open">{t("ipdFamilyCalls.openAdmission")}</Link>
            </div>
            {c.status === "open" ? (
              <div className="act">
                <input value={notes[c.id] ?? ""} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} placeholder={t("ipdFamilyCalls.notePlaceholder")} aria-label={t("ipdFamilyCalls.notePlaceholder")} />
                <button type="button" disabled={busy === c.id || (notes[c.id] ?? "").trim() === ""} onClick={() => close(c.id)}>{t("ipdFamilyCalls.calledBack")}</button>
              </div>
            ) : (
              <span className="done">✓ {t("ipdFamilyCalls.closedBy", { name: c.closedBy ?? "", time: c.closedAt === null ? "" : when(c.closedAt) })} — {c.note}</span>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
