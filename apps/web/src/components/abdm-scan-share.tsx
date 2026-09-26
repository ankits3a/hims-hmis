import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { abdmErrorText, alreadyLinkedUhid, dismissShare, linkShare, mismatchChanges, mismatchComparison, pendingShares, scanShareQr } from "../lib/abdm-api";
import { searchPatients } from "../lib/patients-api";
import type { WireDemographicChange, WireFieldComparison, WireShare } from "../lib/abdm-api";

/**
 * ═══ ABDM S1 — SCAN AND SHARE AT THE COUNTER ═══
 *
 * The counter's QR (the patient scans it with an ABHA app), and the profiles patients have shared,
 * newest first, each with the token number their phone is showing. A clerk takes one of two actions:
 *
 *   · REGISTER — the ordinary registration form opens pre-filled from the share; once the UHID
 *     exists the share is linked and the ABHA is stamped verified (by the server, from ABDM's answer);
 *   · FIND ON FILE — the patient is already registered: search, pick, link. The same comparison as
 *     the OTP verification, and the same rule: a difference is confirmed by the clerk, never written.
 *
 * The list polls every five seconds — a share arrives while the patient is standing at the window.
 */
const COUNTER = /^[A-Za-z0-9]{1,20}$/;

function yearsSince(p: WireShare["profile"]): string {
  if (p.yearOfBirth === null) return "—";
  return String(new Date().getFullYear() - p.yearOfBirth);
}

function ShareMatch({ share, onDone }: { share: WireShare; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const term = share.profile.mobile !== null && /^\d{10}$/.test(share.profile.mobile) ? share.profile.mobile : (share.profile.name ?? "");
  const hits = useQuery({ queryKey: ["abdm-share-match", share.id, term], queryFn: () => searchPatients(term, 5), enabled: term.length >= 2 });
  const [pending, setPending] = useState<{ patientId: string; comparison: WireFieldComparison[]; changes: WireDemographicChange[] } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = async (patientId: string, accept: boolean): Promise<void> => {
    setError(null);
    try {
      await linkShare(share.id, { patientId, acceptAbdmDemographics: accept });
      onDone();
    } catch (e) {
      const cmp = mismatchComparison(e);
      const holder = alreadyLinkedUhid(e);
      if (cmp !== null) setPending({ patientId, comparison: cmp, changes: mismatchChanges(e) ?? [] });
      else if (holder !== null) setError(holder.uhid === null ? t("abdm.verify.linkedElsewhereHidden") : t("abdm.verify.linkedElsewhere", { uhid: holder.uhid }));
      else setError(abdmErrorText(e));
    }
  };

  return (
    <div data-testid={`abdm-share-match-${share.id}`} style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--line)" }}>
      {(hits.data ?? []).length === 0 && !hits.isFetching ? (
        <p style={{ fontSize: 12, color: "var(--dim)", margin: 0 }}>{t("abdm.share.noMatch")}</p>
      ) : null}
      {(hits.data ?? []).map((h) => (
        <div key={h.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, marginTop: 4 }}>
          <span className="mo">{h.uhid}</span><b>{h.name}</b><span>{h.phone ?? ""}</span>
          <button type="button" className="sec" style={{ marginLeft: "auto" }} data-testid={`abdm-share-link-${h.id}`} onClick={() => { void link(h.id, false); }}>
            {t("abdm.share.linkThis")}
          </button>
        </div>
      ))}
      {pending !== null ? (
        <div style={{ marginTop: 8 }} data-testid="abdm-share-mismatch">
          {pending.changes.map((c) => (
            <div key={c.field} style={{ fontSize: 12, color: "var(--red)" }}>
              {t("abdm.profile.willUpdate", { field: t(`abdm.profile.field.${c.field}`), from: c.from ?? "—", to: c.to })}
            </div>
          ))}
          <label style={{ display: "flex", gap: 8, fontSize: 12, marginTop: 6 }}>
            <input type="checkbox" data-testid="abdm-share-accept" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <span>{t("abdm.profile.accept")}</span>
          </label>
          <button type="button" className="pri" style={{ marginTop: 6 }} disabled={!accepted} data-testid="abdm-share-link-confirm" onClick={() => { void link(pending.patientId, true); }}>
            {t("abdm.verify.link")}
          </button>
        </div>
      ) : null}
      {error !== null ? <p role="alert" style={{ color: "var(--red)", fontSize: 12 }}>{error}</p> : null}
    </div>
  );
}

export function ScanSharePanel({ onRegister, onClose }: { onRegister: (share: WireShare) => void; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [counter, setCounter] = useState("1");
  const [matching, setMatching] = useState<string | null>(null);
  const valid = COUNTER.test(counter);
  const qr = useQuery({ queryKey: ["abdm-qr", counter], queryFn: () => scanShareQr(counter), enabled: valid, staleTime: 60 * 60 * 1000, retry: false });
  const shares = useQuery({ queryKey: ["abdm-shares"], queryFn: pendingShares, refetchInterval: 5000, retry: false });
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["abdm-shares"] }); };

  return (
    <div className="box" data-testid="abdm-scan-share" style={{ padding: 14, marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <b style={{ fontSize: 14 }}>{t("abdm.share.title")}</b>
        <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("abdm.share.subtitle")}</span>
        <button type="button" className="sec" style={{ marginLeft: "auto" }} onClick={onClose}>{t("abdm.verify.close")}</button>
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ textAlign: "center" }}>
          {qr.data !== undefined ? (
            <div data-testid="abdm-counter-qr" data-url={qr.data.url} style={{ background: "#fff", padding: 8, borderRadius: 6 }}>
              <QRCodeSVG value={qr.data.url} size={148} />
            </div>
          ) : (
            <div style={{ width: 164, height: 164, display: "grid", placeItems: "center", color: "var(--faint)", fontSize: 11 }}>
              {qr.error !== null ? abdmErrorText(qr.error) : "…"}
            </div>
          )}
          <label style={{ display: "block", fontSize: 11, marginTop: 6 }}>
            <span className="tag">{t("abdm.share.counter")}</span>{" "}
            <input className="in mo" data-testid="abdm-counter-id" style={{ width: 80, height: 28 }} value={counter} onChange={(e) => setCounter(e.target.value.trim())} />
          </label>
        </div>
        <div style={{ flex: 1, minWidth: 260 }}>
          {(shares.data?.shares ?? []).length === 0 ? (
            <p data-testid="abdm-shares-empty" style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("abdm.share.empty")}</p>
          ) : null}
          {(shares.data?.shares ?? []).map((s) => (
            <div key={s.id} data-testid={`abdm-share-${s.id}`} style={{ borderBottom: "1px solid var(--line)", padding: "8px 0" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span className="pill on" data-testid="abdm-share-token" style={{ fontWeight: 700 }}>{t("abdm.share.token", { n: s.tokenNumber })}</span>
                <b>{s.profile.name ?? "—"}</b>
                <span style={{ fontSize: 12 }}>{s.profile.gender ?? ""} · {yearsSince(s.profile)}</span>
                <span className="mo" style={{ fontSize: 12 }}>{s.profile.mobile ?? ""}</span>
                <span className="mo" style={{ fontSize: 12, color: "var(--dim)" }}>{s.profile.abhaAddress ?? ""}</span>
                {/* VRFY_ABHA_303's wording: "already linked in HMIS with UHID X" — the UHID only when this user may see it. */}
                {s.linkedElsewhere !== null && s.linkedElsewhere !== undefined ? (
                  <span className="pill" data-testid={`abdm-share-linked-${s.id}`} style={{ color: "var(--red)", borderColor: "var(--red-line)" }}>
                    {s.linkedElsewhere.uhid === null ? t("abdm.share.linkedHidden") : t("abdm.share.linked", { uhid: s.linkedElsewhere.uhid })}
                  </span>
                ) : null}
              </div>
              <div style={{ display: "flex", gap: 7, marginTop: 6 }}>
                <button type="button" className="pri" data-testid={`abdm-share-register-${s.id}`} onClick={() => onRegister(s)}>{t("abdm.share.register")}</button>
                <button type="button" className="sec" data-testid={`abdm-share-find-${s.id}`} onClick={() => setMatching(matching === s.id ? null : s.id)}>{t("abdm.share.findOnFile")}</button>
                <button type="button" className="sec" data-testid={`abdm-share-dismiss-${s.id}`} onClick={() => { void dismissShare(s.id).then(refresh); }}>{t("abdm.share.dismiss")}</button>
              </div>
              {matching === s.id ? <ShareMatch share={s} onDone={() => { setMatching(null); refresh(); }} /> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
