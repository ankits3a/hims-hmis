import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import type React from "react";
import type { IpdEmarLabelSheet, IpdEmarPharmacyQueue, IpdEmarVerifyItem, IpdRefusalBody } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { fmtIst } from "../lib/format";
import { refusalOf } from "../lib/ipd-beds-api";
import { getLabelSheet, getPharmacyQueue, issue, resolveFlag, returnMed, verify } from "../lib/ipd-emar-api";
import type { AllergyOverride, Checks } from "../lib/ipd-emar-api";
import "./ipd-emar.css";

/**
 * E4.3 (#735) — THE INPATIENT PHARMACY DESK (desktop, 16:9; spec §4.6). Four columns: TO VERIFY (each order with the
 * server's findings — allergy, interaction or "no interaction data", dose, duplicate — the four ticks, a note for any
 * finding, Verify / Query / Reject), TO ISSUE (units, units per strip label, the patient's own medicine with its batch and
 * expiry; Issue prints the labels), ALLERGY FLAGS (an allergy recorded after the order: close once the doctor decided) and
 * RETURNS OWED (an order stopped after issue: take the unused units back, credited). No money on any of it (0058).
 *
 * LABELS print from the browser (the print relay has no label document yet; the band's precedent): an A4 sheet of labels
 * or one slip per label, each with its QR (`EML-…`), the drug in tall-man letters when it is look-alike, the dose and the
 * UHID — a sealed patient by alias, no UHID.
 */
const NO_TICKS: Checks = { allergy: false, interaction: false, dose: false, duplicate: false };

export function IpdPharmacy(): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState<IpdEmarPharmacyQueue | null>(null);
  const [error, setError] = useState<"forbidden" | "failed" | null>(null);
  const [sheet, setSheet] = useState<IpdEmarLabelSheet | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => getPharmacyQueue().then((x) => { setQ(x); setError(null); }, (e: unknown) => setError(e instanceof ApiError && e.status === 403 ? "forbidden" : "failed")), []);
  useEffect(() => { void load(); const id = setInterval(() => void load(), 30_000); return () => clearInterval(id); }, [load]);
  if (sheet !== null) return <LabelPrint sheet={sheet} onClose={() => setSheet(null)} />;
  return (
    <main className="ipde ipde-desk" data-testid="ipd-pharmacy">
      <header className="ipde-head">
        <h1>{t("ipdEmar.pharmacy.title")}</h1>
        {q !== null ? <span className="dim">{t("ipdEmar.asOf", { time: fmtIst(q.asOf) })}</span> : null}
        {notice !== null ? <span className="ipde-ok" role="status">✓ {notice}</span> : null}
      </header>
      {error === "forbidden" ? <div className="ipde-empty" role="alert">{t("ipdNursing.forbidden")}</div> : null}
      {error === "failed" ? <div className="ipde-empty" role="alert">{t("ipdNursing.loadFailed")}</div> : null}
      {q === null ? null : (
        <div className="ipde-cols">
          <section className="ipde-col" aria-label={t("ipdEmar.pharmacy.toVerify")}>
            <h2>{t("ipdEmar.pharmacy.toVerify")} <span className="ipde-count">{q.toVerify.length}</span></h2>
            {q.toVerify.length === 0 ? <div className="ipde-empty">{t("ipdEmar.pharmacy.none")}</div> : null}
            {q.toVerify.map((it) => <VerifyCard key={it.order.orderId} it={it} onDone={(w) => { setNotice(w); void load(); }} />)}
          </section>
          <section className="ipde-col" aria-label={t("ipdEmar.pharmacy.toIssue")}>
            <h2>{t("ipdEmar.pharmacy.toIssue")} <span className="ipde-count">{q.toIssue.length}</span></h2>
            {q.toIssue.length === 0 ? <div className="ipde-empty">{t("ipdEmar.pharmacy.none")}</div> : null}
            {q.toIssue.map((it) => <IssueCard key={it.order.orderId} it={it} onIssued={(id) => { void load(); getLabelSheet(id).then(setSheet, () => undefined); }} />)}
          </section>
          <section className="ipde-col" aria-label={t("ipdEmar.pharmacy.flags")}>
            <h2>{t("ipdEmar.pharmacy.flags")} <span className="ipde-count">{q.allergyFlags.length}</span></h2>
            {q.allergyFlags.length === 0 ? <div className="ipde-empty">{t("ipdEmar.pharmacy.none")}</div> : null}
            {q.allergyFlags.map((f) => <FlagCard key={f.flagId} f={f} onDone={() => { setNotice(t("ipdEmar.pharmacy.flagClosed")); void load(); }} />)}
            <h2>{t("ipdEmar.pharmacy.returns")} <span className="ipde-count">{q.returnsOwed.length}</span></h2>
            {q.returnsOwed.length === 0 ? <div className="ipde-empty">{t("ipdEmar.pharmacy.none")}</div> : null}
            {q.returnsOwed.map((r) => <ReturnCard key={r.issueId} r={r} onDone={(w) => { setNotice(w); void load(); }} />)}
          </section>
        </div>
      )}
    </main>
  );
}

function Who({ it }: { it: Pick<IpdEmarVerifyItem, "identity" | "bedCode" | "wardName" | "alerts"> }): React.ReactElement {
  return (
    <div className="ipde-who">
      <b>{it.identity.name}</b> <span className="dim">{[it.bedCode, it.wardName, it.identity.uhid ? `UHID ${it.identity.uhid}` : null].filter(Boolean).join(" · ")}</span>
      <div className="ipde-chips">{it.alerts.map((a) => <span key={a} className={`ipde-tag${a.endsWith("none recorded") ? "" : " red"}`}>{a.endsWith("none recorded") ? "" : "⚠ "}{a}</span>)}</div>
    </div>
  );
}

function Drug({ o }: { o: IpdEmarVerifyItem["order"] }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="ipde-drugline">
      <b>{o.title}</b>
      {o.tallMan !== null ? <span className="ipde-tag gold">◆ {o.tallMan}</span> : null}
      {o.highAlert ? <span className="ipde-tag red">⚠ {t("ipdEmar.highAlert")}</span> : null}
      {o.narcotic ? <span className="ipde-tag red">Ⓝ {t("ipdEmar.narcotic")}</span> : null}
      {o.verbal ? <span className="ipde-tag">☎ {t("ipdEmar.verbal")}</span> : null}
      <div className="dim">{o.doseWords}{o.prn !== null ? ` · PRN ≥ ${String(o.prn.minIntervalMinutes)} min, ≤ ${String(o.prn.max24h)}/24 h` : ""} · {t("ipdEmar.from", { time: fmtIst(o.startAt) })}</div>
    </div>
  );
}

function VerifyCard({ it, onDone }: { it: IpdEmarVerifyItem; onDone: (w: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [ticks, setTicks] = useState<Checks>(NO_TICKS);
  const [note, setNote] = useState("");
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [ovReason, setOvReason] = useState<AllergyOverride["reason"] | "">("");
  const [ovText, setOvText] = useState("");
  const allergyStop = it.findings.some((f) => f.check === "allergy");
  const needsNote = it.findings.some((f) => f.severity !== "info") || it.allergyOverrideReason !== null || !it.interactionDataPresent;
  const overrideOk = !allergyStop || (ovReason !== "" && ovText.trim() !== "");
  const all = ticks.allergy && ticks.interaction && ticks.dose && ticks.duplicate;
  const act = (decision: "verified" | "rejected" | "query"): void => {
    setBusy(true); setRefusal(null);
    verify(it.order.orderId, decision, ticks, note.trim() || undefined, allergyStop && ovReason !== "" ? { reason: ovReason, text: ovText.trim() } : undefined).then(() => { setBusy(false); onDone(t(`ipdEmar.pharmacy.did.${decision}`)); }, (e: unknown) => { setBusy(false); setRefusal(refusalOf(e)); });
  };
  return (
    <article className="ipde-card" data-testid={`ipde-verify-${it.order.orderId}`}>
      <Who it={it} />
      <Drug o={it.order} />
      <div className="dim">{t("ipdEmar.orderedBy", { name: it.orderedByName, time: fmtIst(it.orderedAt) })}</div>
      {it.allergyOverrideReason !== null && !it.findings.some((f) => f.check === "allergy") ? <div className="ipde-finding stop">⚠ {t("ipdEmar.pharmacy.override", { reason: it.allergyOverrideReason })}</div> : null}
      <ul className="ipde-findings">
        {it.findings.map((f, i) => <li key={i} className={`ipde-finding ${f.severity}`}>{f.severity === "stop" ? "✕" : f.severity === "warn" ? "⚠" : "ℹ"} {f.words}</li>)}
        {!it.interactionDataPresent ? <li className="ipde-finding info">ℹ {t("ipdEmar.pharmacy.noInteractionData")}</li> : null}
      </ul>
      <fieldset className="ipde-ticks">
        {(["allergy", "interaction", "dose", "duplicate"] as const).map((k) => (
          <label key={k}><input type="checkbox" checked={ticks[k]} onChange={(e) => setTicks({ ...ticks, [k]: e.target.checked })} /> {t(`ipdEmar.pharmacy.tick.${k}`)}</label>
        ))}
      </fieldset>
      <label className="ipde-field">{needsNote ? t("ipdEmar.pharmacy.noteNeeded") : t("ipdEmar.note")}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {allergyStop ? (
        <div className="ipde-row" data-testid="ipde-allergy-override">
          <label className="ipde-field">{t("ipdEmar.pharmacy.overrideReason")}
            <select value={ovReason} onChange={(e) => setOvReason(e.target.value as AllergyOverride["reason"] | "")}>
              <option value="">—</option>
              {(["tolerated_before", "desensitised", "no_safe_alternative", "benefit_outweighs_risk"] as const).map((r) => <option key={r} value={r}>{t(`ipdEmar.pharmacy.overrides.${r}`)}</option>)}
            </select>
          </label>
          <label className="ipde-field">{t("ipdEmar.pharmacy.overrideText")}<input value={ovText} onChange={(e) => setOvText(e.target.value)} /></label>
        </div>
      ) : null}
      {refusal !== null ? <div className="ipde-refusal" role="alert">{refusal.rule}</div> : null}
      <div className="ipde-acts">
        <button type="button" className="ipde-btn" disabled={busy || note.trim() === ""} onClick={() => act("query")}>{t("ipdEmar.pharmacy.query")}</button>
        <button type="button" className="ipde-btn" disabled={busy || note.trim() === ""} onClick={() => act("rejected")}>{t("ipdEmar.pharmacy.reject")}</button>
        <button type="button" className="ipde-btn pri" disabled={busy || !all || (needsNote && note.trim() === "") || !overrideOk} onClick={() => act("verified")} data-testid="ipde-verify-btn">{t("ipdEmar.pharmacy.verify")}</button>
      </div>
    </article>
  );
}

function IssueCard({ it, onIssued }: { it: IpdEmarPharmacyQueue["toIssue"][number]; onIssued: (issueId: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [units, setUnits] = useState("10");
  const [strip, setStrip] = useState("10");
  const [own, setOwn] = useState(false);
  const [batchNo, setBatchNo] = useState("");
  const [expiry, setExpiry] = useState("");
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const n = Number(units);
  const s = Number(strip);
  const ok = Number.isInteger(n) && n > 0 && Number.isInteger(s) && s > 0 && (!own || (batchNo.trim() !== "" && /^\d{4}-\d{2}-\d{2}$/.test(expiry)));
  return (
    <article className="ipde-card" data-testid={`ipde-issue-${it.order.orderId}`}>
      <Who it={it} />
      <Drug o={it.order} />
      <div className="ipde-row">
        <label className="ipde-field">{t("ipdEmar.pharmacy.units")}<input value={units} onChange={(e) => setUnits(e.target.value)} inputMode="numeric" /></label>
        <label className="ipde-field">{t("ipdEmar.pharmacy.perLabel")}<input value={strip} onChange={(e) => setStrip(e.target.value)} inputMode="numeric" /></label>
      </div>
      <label className="ipde-check"><input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} /> {t("ipdEmar.pharmacy.own")}</label>
      {own ? (
        <div className="ipde-row">
          <label className="ipde-field">{t("ipdEmar.pharmacy.batch")}<input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} /></label>
          <label className="ipde-field">{t("ipdEmar.pharmacy.expiry")}<input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></label>
        </div>
      ) : null}
      {ok && n > 0 && s > 0 ? <div className="dim">{t("ipdEmar.pharmacy.labelsCount", { count: Math.ceil(n / s) })}</div> : null}
      {refusal !== null ? <div className="ipde-refusal" role="alert">{refusal.rule}</div> : null}
      <div className="ipde-acts">
        <button type="button" className="ipde-btn pri" disabled={!ok} data-testid="ipde-issue-btn" onClick={() => {
          setRefusal(null);
          issue({ orderId: it.order.orderId, units: n, stripSize: s, ownMedicine: own, ...(own ? { ownBatch: { batchNo: batchNo.trim(), expiry } } : {}) })
            .then((r) => onIssued(r.issueId), (e: unknown) => setRefusal(refusalOf(e)));
        }}>{t("ipdEmar.pharmacy.issue")}</button>
      </div>
    </article>
  );
}

function FlagCard({ f, onDone }: { f: IpdEmarPharmacyQueue["allergyFlags"][number]; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  return (
    <article className="ipde-card red" data-testid={`ipde-flag-${f.flagId}`}>
      <div><b>{f.identity.name}</b> <span className="dim">{f.bedCode ?? ""}</span></div>
      <div>⚠ {f.title} · {f.substances.join(", ")}</div>
      <div className="dim">{fmtIst(f.raisedAt)}{f.orderActive ? "" : ` · ${t("ipdEmar.pharmacy.orderStopped")}`}</div>
      <div className={f.doctorDecision === null ? "ipde-finding stop" : "ipde-finding"}>{f.doctorDecision === null ? t("ipdEmar.pharmacy.awaitDoctor") : t(`ipdEmar.pharmacy.decided.${f.doctorDecision}`, { reason: f.doctorReason ?? "" })}</div>
      <label className="ipde-field">{t("ipdEmar.pharmacy.decision")}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <div className="ipde-acts"><button type="button" className="ipde-btn" disabled={note.trim() === "" || f.doctorDecision === null} onClick={() => { resolveFlag(f.flagId, note.trim()).then(onDone, () => undefined); }}>{t("ipdEmar.pharmacy.close")}</button></div>
    </article>
  );
}

function ReturnCard({ r, onDone }: { r: IpdEmarPharmacyQueue["returnsOwed"][number]; onDone: (w: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [units, setUnits] = useState(String(r.units - r.returnedUnits));
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  return (
    <article className="ipde-card" data-testid={`ipde-return-${r.issueId}`}>
      <div><b>{r.identity.name}</b> <span className="dim">{r.bedCode ?? ""}</span></div>
      <div>{r.title} · {t("ipdEmar.pharmacy.issued", { units: r.units, back: r.returnedUnits })}</div>
      <label className="ipde-field">{t("ipdEmar.pharmacy.unitsBack")}<input value={units} onChange={(e) => setUnits(e.target.value)} inputMode="numeric" /></label>
      {refusal !== null ? <div className="ipde-refusal" role="alert">{refusal.rule}</div> : null}
      <div className="ipde-acts"><button type="button" className="ipde-btn pri" disabled={!(Number(units) > 0)} onClick={() => {
        returnMed(r.issueId, Number(units), "Order stopped — unused units back").then((x) => onDone(t("ipdEmar.pharmacy.credited", { count: x.creditedUnits })), (e: unknown) => setRefusal(refusalOf(e)));
      }}>{t("ipdEmar.pharmacy.takeBack")}</button></div>
    </article>
  );
}

/** The labels: an A4 sheet (3 × 8) or one slip per label; printed by the browser. Never night mode (§4.10 edge 30). */
export function LabelPrint({ sheet, onClose }: { sheet: IpdEmarLabelSheet; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<"a4" | "slip">("a4");
  return (
    <main className="ipde ipde-labels-screen" data-testid="ipde-labels">
      <header className="ipde-head noprint">
        <h1>{t("ipdEmar.labels.title", { count: sheet.labels.length })}</h1>
        <div className="ipde-acts">
          <button type="button" className="ipde-btn" aria-pressed={layout === "a4"} onClick={() => setLayout("a4")}>{t("ipdEmar.labels.a4")}</button>
          <button type="button" className="ipde-btn" aria-pressed={layout === "slip"} onClick={() => setLayout("slip")}>{t("ipdEmar.labels.slip")}</button>
          <button type="button" className="ipde-btn pri" onClick={() => window.print()}>{t("ipdEmar.labels.print")}</button>
          <button type="button" className="ipde-btn" onClick={onClose}>{t("ipdNursing.close")}</button>
        </div>
      </header>
      <section className={`ipde-sheet ${layout}`}>
        {sheet.labels.map((l) => (
          <div key={l.labelId} className="ipde-label" data-testid="ipde-label">
            <QRCodeSVG value={l.code} size={72} level="M" />
            <div className="ipde-label-txt">
              <b className="drug">{l.tallMan ?? l.drug}</b>
              {l.highAlert ? <span className="ha">⚠ {t("ipdEmar.labels.highAlert")}</span> : null}
              <span>{l.doseWords}</span>
              <span className="who">{l.name}{l.uhid ? ` · ${l.uhid}` : ""}</span>
              <span className="meta mono">{l.code.slice(-8)} · {l.seq}/{l.of} · {l.units} u{l.ownMedicine ? ` · ${t("ipdEmar.labels.own")}` : ""}{l.bedCode ? ` · ${l.bedCode}` : ""}</span>
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
