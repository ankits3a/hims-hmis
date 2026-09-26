import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { abdmErrorText, externalRecords, refreshExternalRequest, requestExternalRecords } from "../lib/abdm-api";
import type { WireExternalRecord, WireExternalRecords, WireHiuRequest } from "../lib/abdm-api";

/**
 * ═══ ABDM S3 — RECORDS FROM OTHER HOSPITALS, IN THE CONSULT'S HISTORY ═══
 *
 * READ-ONLY. What other facilities sent under the patient's ABDM consent, grouped by facility and
 * newest first; EVERY record carries the "External — not verified by this hospital" badge and its
 * consent's expiry, because it is another institution's statement and it will be DELETED when the
 * consent ends. Nothing here writes to this hospital's record, and the server audits every read.
 *
 * THE REQUEST is the treating doctor's, from this open consultation (the server refuses anyone else):
 * purpose, HI types, date range and expiry are shown before it is sent; the patient then approves it
 * in their ABHA app — outside this system — and the list shows where each request stands.
 */
const IST = "Asia/Kolkata";
const day = (iso: string | null): string => {
  if (iso === null) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: IST });
};
/** An ISO instant → the IST calendar date a date input holds. */
const istDate = (iso: string): string => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
const startOfIstDay = (d: string): string => new Date(`${d}T00:00:00+05:30`).toISOString();
const endOfIstDay = (d: string): string => new Date(`${d}T23:59:59+05:30`).toISOString();

function RequestForm({ data, encounterId, onSent }: { data: WireExternalRecords; encounterId: string; onSent: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [purpose, setPurpose] = useState(data.defaults.purposeCode);
  const [types, setTypes] = useState<string[]>(data.defaults.hiTypes);
  const [from, setFrom] = useState(istDate(data.defaults.from));
  const [to, setTo] = useState(istDate(data.defaults.to));
  const [expires, setExpires] = useState(istDate(data.defaults.dataEraseAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (ty: string): void => { setTypes(types.includes(ty) ? types.filter((x) => x !== ty) : [...types, ty]); };
  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await requestExternalRecords({
        encounterId, purposeCode: purpose, hiTypes: data.hiTypes.filter((ty) => types.includes(ty)),
        from: startOfIstDay(from),
        // Today means "up to now" (the server's clock), not the end of a day that has not happened.
        to: to === istDate(data.defaults.to) ? data.defaults.to : endOfIstDay(to),
        dataEraseAt: endOfIstDay(expires),
      });
      onSent();
    } catch (e) {
      setError(abdmErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="abdm-external-form" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("abdm.external.formNote", { abha: data.abha.address ?? "" })}</p>
      <label style={{ fontSize: 12.5 }}>{t("abdm.external.purpose")}
        <select data-testid="abdm-external-purpose" className="in" value={purpose} onChange={(e) => { setPurpose(e.target.value); }} style={{ display: "block", marginTop: 4 }}>
          {data.purposes.map((p) => <option key={p.code} value={p.code}>{t(`abdm.external.purposeName.${p.code}`, { defaultValue: p.text })}</option>)}
        </select>
      </label>
      <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
        <legend style={{ fontSize: 12.5 }}>{t("abdm.external.types")}</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 4 }}>
          {data.hiTypes.map((ty) => (
            <label key={ty} style={{ fontSize: 12.5, display: "flex", gap: 5, alignItems: "center" }}>
              <input type="checkbox" data-testid={`abdm-external-type-${ty}`} checked={types.includes(ty)} onChange={() => { toggle(ty); }} />
              {t(`abdm.external.hiType.${ty}`, { defaultValue: ty })}
            </label>
          ))}
        </div>
      </fieldset>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <label style={{ fontSize: 12.5 }}>{t("abdm.external.from")}
          <input type="date" data-testid="abdm-external-from" className="in" value={from} onChange={(e) => { setFrom(e.target.value); }} style={{ display: "block", marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12.5 }}>{t("abdm.external.to")}
          <input type="date" data-testid="abdm-external-to" className="in" value={to} onChange={(e) => { setTo(e.target.value); }} style={{ display: "block", marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12.5 }}>{t("abdm.external.expires")}
          <input type="date" data-testid="abdm-external-expires" className="in" value={expires} onChange={(e) => { setExpires(e.target.value); }} style={{ display: "block", marginTop: 4 }} />
        </label>
      </div>
      {error !== null && <p role="alert" data-testid="abdm-external-error" style={{ margin: 0, color: "var(--red)", fontSize: 12.5 }}>{error}</p>}
      <div>
        <button type="button" className="pri" data-testid="abdm-external-send" disabled={busy || types.length === 0 || from === "" || to === "" || expires === ""} onClick={() => { void send(); }}>
          {t("abdm.external.send")}
        </button>
      </div>
    </div>
  );
}

function RequestRow({ r, onChanged }: { r: WireHiuRequest; onChanged: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const check = async (): Promise<void> => {
    setError(null);
    try { await refreshExternalRequest(r.id); onChanged(); } catch (e) { setError(abdmErrorText(e)); }
  };
  return (
    <li data-testid={`abdm-external-request-${r.id}`} style={{ fontSize: 12.5, padding: "6px 0", borderTop: "1px solid var(--line2)" }}>
      <span className="mo">{day(r.createdAt)}</span>{" · "}
      <strong data-status={r.status}>{t(`abdm.external.status.${r.status}`)}</strong>{" · "}
      {r.purposeText}{" · "}{t("abdm.external.expiresOn", { date: day(r.dataEraseAt) })}
      {r.artefacts.length > 0 && <span style={{ color: "var(--dim)" }}>{" · "}{r.artefacts.map((a) => `${a.hipName ?? a.hipId ?? a.consentId} (${t(`abdm.external.artefact.${a.status}`)}${a.erasedAt === null ? "" : ` · ${t("abdm.external.erased", { count: a.erasedCount })}`})`).join(", ")}</span>}
      {r.error !== null && <span style={{ color: "var(--red)" }}>{" · "}{r.error}</span>}
      {r.consentRequestId !== null && (r.status === "awaiting_patient" || r.status === "requested") && (
        <button type="button" className="sec" data-testid={`abdm-external-check-${r.id}`} style={{ marginLeft: 8, padding: "1px 8px", fontSize: 12 }} onClick={() => { void check(); }}>
          {t("abdm.external.check")}
        </button>
      )}
      {error !== null && <span role="alert" style={{ color: "var(--red)" }}>{" · "}{error}</span>}
    </li>
  );
}

function RecordRow({ r }: { r: WireExternalRecord }): React.ReactElement {
  const { t } = useTranslation();
  const s = r.summary;
  return (
    <details data-testid={`abdm-external-record-${r.id}`} style={{ borderTop: "1px solid var(--line2)", padding: "6px 0" }}>
      <summary style={{ cursor: "pointer", fontSize: 12.5, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span className="mo">{day(r.recordDate)}</span>
        <span className="pill" style={{ fontSize: 11 }}>{t(`abdm.external.hiType.${r.hiType}`, { defaultValue: r.hiType })}</span>
        <span>{r.title ?? s.title ?? "—"}</span>
        <span data-testid="abdm-external-badge" className="pill" style={{ fontSize: 11, background: "var(--amber-soft, #fff4d6)", color: "var(--amber, #8a5a00)" }}>{t("abdm.external.badge")}</span>
      </summary>
      <div style={{ fontSize: 12.5, marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
        <span data-testid="abdm-external-expiry" style={{ color: "var(--dim)" }}>{t("abdm.external.consentUntil", { date: day(r.consentExpiresAt) })}</span>
        {(s.subjectName !== null || s.authors.length > 0) && (
          <span style={{ color: "var(--dim)" }}>
            {s.subjectName !== null && t("abdm.external.subject", { name: s.subjectName })}
            {s.subjectName !== null && s.authors.length > 0 && " · "}
            {s.authors.length > 0 && t("abdm.external.author", { name: s.authors.join(", ") })}
          </span>
        )}
        {!r.checksumVerified && <span data-testid="abdm-external-unverified" style={{ color: "var(--dim)" }}>{t("abdm.external.checksumUnverified")}</span>}
        <div data-testid="abdm-external-lines">
          {s.sections.length === 0 ? <p style={{ margin: 0, color: "var(--faint)" }}>{t("abdm.external.unreadable")}</p> : s.sections.map((sec, i) => (
            <div key={i} style={{ marginTop: 4 }}>
              <div style={{ fontWeight: 600 }}>{sec.title}</div>
              <ul style={{ margin: "2px 0", paddingLeft: 18 }}>{sec.lines.map((l, j) => <li key={j} style={{ whiteSpace: "pre-wrap" }}>{l}</li>)}</ul>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

export function ExternalRecordsPanel({ patientId, encounterId }: { patientId: string; encounterId: string }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const key = ["abdm", "external-records", patientId];
  const q = useQuery({ queryKey: key, queryFn: () => externalRecords(patientId), staleTime: 30_000 });
  const [formOpen, setFormOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: key }); };
  const data = q.data;
  return (
    <section data-testid="abdm-external" aria-labelledby="abdm-external-title" style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line2)", display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 id="abdm-external-title" style={{ margin: 0, fontSize: 14 }}>{t("abdm.external.title")}</h3>
      <p data-testid="abdm-external-label" style={{ margin: 0, fontSize: 12.5, color: "var(--amber, #8a5a00)" }}>{t("abdm.external.label")}</p>
      {q.isError && <p role="alert" style={{ margin: 0, color: "var(--red)", fontSize: 12.5 }}>{abdmErrorText(q.error)}</p>}
      {data === undefined ? (q.isError ? null : <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("app.loading")}</p>) : (
        <>
          {!data.hiuConfigured && <p data-testid="abdm-external-off" style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("abdm.external.off")}</p>}
          {data.hiuConfigured && !data.abha.verified && <p data-testid="abdm-external-no-abha" style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("abdm.external.noAbha")}</p>}
          {data.hiuConfigured && data.abha.verified && (sent
            ? <p data-testid="abdm-external-sent" style={{ margin: 0, fontSize: 12.5 }}>{t("abdm.external.sent")}</p>
            : formOpen
              ? <RequestForm data={data} encounterId={encounterId} onSent={() => { setSent(true); setFormOpen(false); refresh(); }} />
              : <div><button type="button" className="sec" data-testid="abdm-external-request-open" onClick={() => { setFormOpen(true); }}>{t("abdm.external.requestOpen")}</button></div>)}
          {data.requests.length > 0 && (
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t("abdm.external.requests")}</div>
              <ul data-testid="abdm-external-requests" style={{ listStyle: "none", margin: 0, padding: 0 }}>{data.requests.map((r) => <RequestRow key={r.id} r={r} onChanged={refresh} />)}</ul>
            </div>
          )}
          {data.facilities.length === 0
            ? <p data-testid="abdm-external-none" style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("abdm.external.none")}</p>
            : data.facilities.map((f) => (
              <div key={f.hipId} data-testid={`abdm-external-facility-${f.hipId}`} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px" }}>
                <h4 data-testid="abdm-external-facility-name" style={{ margin: "0 0 4px", fontSize: 13.5 }}>
                  {f.hipName ?? f.hipId} <span className="mo" style={{ fontSize: 11, color: "var(--dim)", fontWeight: 400 }}>{f.hipId}</span>
                </h4>
                {[...f.records].sort((a, b) => (b.recordDate ?? "").localeCompare(a.recordDate ?? "")).map((r) => <RecordRow key={r.id} r={r} />)}
              </div>
            ))}
        </>
      )}
    </section>
  );
}
