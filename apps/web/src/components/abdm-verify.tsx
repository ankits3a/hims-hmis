import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  abdmErrorCode, abdmErrorText, abhaAddressSuggestions, abhaCard, alreadyLinkedUhid, chooseAbhaAccount, createAbhaAddress,
  downloadAbhaCard, linkAbha, mismatchChanges, mismatchComparison, resendAbhaOtp, sendCreationMobileOtp, startAbhaCreate,
  startAbhaFindByAadhaar, startAbhaVerification, submitAbhaOtp, verifyCreationMobileOtp,
} from "../lib/abdm-api";
import type { WireAbdmProfile, WireAbhaFlow, WireDemographicChange, WireFieldComparison } from "../lib/abdm-api";

/**
 * ═══ ABDM S1 — "VERIFY WITH ABDM", "FIND BY AADHAAR" AND "CREATE ABHA" ═══
 *
 * One panel, used by the registration counter (no patient yet) and by the patient's record (a patient
 * to link). NHA FT case IDs (`ft-matrix.md` §2) are named where a step answers one.
 *
 *   1. what the patient has: an ABHA number, an ABHA address or the ABHA's MOBILE (VRFY_101/102/301),
 *      and how the OTP should reach them — or, with the hospital's Aadhaar switch on, their Aadhaar
 *      number and consent (find: VRFY_401; create: CRT_101–104);
 *   2. the OTP, with RE-SEND after 60 s, at most twice (CRT_106, VRFY_305/405);
 *   3. a mobile / Aadhaar find lists the ABHAs it found, and the clerk picks one (VRFY_303/404);
 *   4. ABDM's profile beside the hospital's. DECIDED, following the workbook: ABDM-verified name,
 *      birth and gender are authoritative — linking takes them (shown first, accepted by the clerk)
 *      and locks them while the ABHA stays verified. Mobile and address stay the hospital's.
 *      "Already linked with UHID X" when another record holds the ABHA (TAGGING_…).
 *   5. creation extras: a different mobile checked by OTP (CRT_109), ABDM's address suggestions or
 *      a typed address (CRT_112), and the card shown or downloaded (CRT_114).
 *
 * WHAT THIS SCREEN NEVER HOLDS: ABDM's transaction id or the patient's ABHA session — the server keeps
 * both behind an opaque handle. The Aadhaar number is in this component's state only until the one
 * request that carries it is sent, and is cleared the moment it is; a re-send asks for it again.
 */
export type AbdmHospitalSide = { name: string | null; dob: string | null; gender: string | null; phone: string | null };
export type AbdmPanelMode = "verify" | "create" | "find_aadhaar";

type Props = {
  mode: AbdmPanelMode;
  initialIdentifier?: string;
  /** The patient on file this flow is for. With one, the panel LINKS; without one, it hands the result back. */
  patientId?: string | null;
  /** The counter's unsaved form, compared on screen when there is no patient yet. */
  against?: AbdmHospitalSide | null;
  /** The counter: take the verified ABHA (and ABDM's name, birth, gender) onto the form. */
  onUse?: (flow: WireAbhaFlow, accepted: boolean) => void;
  onLinked?: (changed: string[]) => void;
  onClose: () => void;
};

const norm = (v: string | null): string => (v ?? "").toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, " ").trim();
const aadhaarDigits = (v: string): string => v.replace(/\D/g, "");

/** The on-screen comparison for a counter form — the server compares again, authoritatively, at the link. */
export function compareOnScreen(p: WireAbdmProfile, h: AbdmHospitalSide): WireFieldComparison[] {
  const row = (field: WireFieldComparison["field"], abdm: string | null, hospital: string | null, same: (a: string, b: string) => boolean): WireFieldComparison => ({
    field, abdm, hospital, result: abdm === null || hospital === null || hospital === "" ? "unknown" : same(abdm, hospital) ? "same" : "differs",
  });
  const year = (s: string): string => s.slice(0, 4);
  return [
    row("name", p.name, h.name, (a, b) => norm(a) === norm(b)),
    row("dob", p.dob ?? (p.yearOfBirth === null ? null : String(p.yearOfBirth)), h.dob, (a, b) => (a.length === 4 || b.length === 4 ? year(a) === year(b) : a === b)),
    row("gender", p.gender, h.gender, (a, b) => a === b),
    row("mobile", p.mobile, h.phone, (a, b) => {
      const shown = a.replace(/\D/g, "");
      return /[*Xx]/.test(a) ? b.replace(/\D/g, "").endsWith(shown) : shown.slice(-10) === b.replace(/\D/g, "").slice(-10);
    }),
  ];
}

function AadhaarField({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }): React.ReactElement {
  const { t } = useTranslation();
  const d = aadhaarDigits(value);
  return (
    <>
      <input
        className="in mo" data-testid={testId} type="password" inputMode="numeric" autoComplete="off"
        value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d ]/g, "").slice(0, 14))}
      />
      {/* CRT_ABHA_104 — a MESSAGE, not only a greyed button, and never the digits themselves. */}
      {d.length > 0 && d.length !== 12 ? (
        <p role="alert" data-testid={`${testId}-invalid`} style={{ color: "var(--red)", fontSize: 11.5, margin: "4px 0 0" }}>{t("abdm.create.aadhaarInvalid")}</p>
      ) : null}
    </>
  );
}

export function AbdmVerifyPanel({ mode, initialIdentifier = "", patientId = null, against = null, onUse, onLinked, onClose }: Props): React.ReactElement {
  const { t } = useTranslation();
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [method, setMethod] = useState<"aadhaar_otp" | "mobile_otp">("aadhaar_otp");
  const [aadhaar, setAadhaar] = useState("");
  const [consented, setConsented] = useState(false);
  const [otp, setOtp] = useState("");
  const [mobile, setMobile] = useState(against?.phone ?? "");
  const [mobileOtp, setMobileOtp] = useState("");
  const [address, setAddress] = useState("");
  const [flow, setFlow] = useState<WireAbhaFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [serverComparison, setServerComparison] = useState<WireFieldComparison[] | null>(null);
  const [serverChanges, setServerChanges] = useState<WireDemographicChange[] | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [linked, setLinked] = useState(false);
  const [elsewhere, setElsewhere] = useState<{ uhid: string | null } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /* The re-send countdown ticks only while an OTP is awaited. */
  useEffect(() => {
    if (flow?.stage !== "otp_sent") return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [flow?.stage]);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const cmp = mismatchComparison(e);
      const linkedTo = alreadyLinkedUhid(e);
      if (cmp !== null) {
        setServerComparison(cmp);
        setServerChanges(mismatchChanges(e));
        setError(t("abdm.verify.mismatchRefused"));
      } else if (linkedTo !== null) {
        setElsewhere(linkedTo);
      } else if (abdmErrorCode(e) === "abdm_transaction_expired" || abdmErrorCode(e) === "abdm_transaction_not_found") {
        setFlow(null);
        setError(t("abdm.verify.expired"));
      } else {
        setError(abdmErrorText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const takeFlow = (next: WireAbhaFlow): void => {
    setFlow(next);
    const holder = next.linkedElsewhere as { uhid: string | null } | null | undefined;
    if (holder !== null && holder !== undefined) setElsewhere(holder);
  };

  const start = (): Promise<void> => run(async () => {
    if (mode === "create" || mode === "find_aadhaar") {
      const digits = aadhaar;
      setAadhaar(""); // cleared the moment the one request that carries it is on its way
      const body = { aadhaar: digits, patientConsented: consented, patientId };
      takeFlow(mode === "create" ? await startAbhaCreate(body) : await startAbhaFindByAadhaar(body));
    } else {
      takeFlow(await startAbhaVerification({ identifier, method, patientId }));
    }
    setOtp("");
  });

  const resend = (): Promise<void> => run(async () => {
    if (flow === null) return;
    const digits = aadhaar;
    setAadhaar("");
    takeFlow(await resendAbhaOtp(flow.transactionId, flow.resendNeedsAadhaar ? { aadhaar: digits } : {}));
    setOtp("");
  });

  const confirmOtp = (): Promise<void> => run(async () => {
    if (flow === null) return;
    const next = await submitAbhaOtp(flow.transactionId, mode === "create" ? { otp, mobile } : { otp });
    setOtp("");
    takeFlow(next);
  });

  const choose = (abhaNumber: string): Promise<void> => run(async () => {
    if (flow === null) return;
    takeFlow(await chooseAbhaAccount(flow.transactionId, abhaNumber));
  });

  const sendMobile = (): Promise<void> => run(async () => { if (flow !== null) takeFlow(await sendCreationMobileOtp(flow.transactionId)); });
  const verifyMobile = (): Promise<void> => run(async () => {
    if (flow === null) return;
    takeFlow(await verifyCreationMobileOtp(flow.transactionId, mobileOtp));
    setMobileOtp("");
  });
  const suggest = (): Promise<void> => run(async () => { if (flow !== null) takeFlow(await abhaAddressSuggestions(flow.transactionId)); });
  const makeAddress = (value: string): Promise<void> => run(async () => { if (flow !== null) takeFlow(await createAbhaAddress(flow.transactionId, value)); });

  const showCard = (): Promise<void> => run(async () => {
    if (flow === null) return;
    const c = await abhaCard(flow.transactionId);
    setCard(`data:${c.mimeType};base64,${c.imageBase64}`);
  });
  const saveCard = (): Promise<void> => run(async () => { if (flow !== null) await downloadAbhaCard(flow.transactionId); });

  const link = (): Promise<void> => run(async () => {
    if (flow === null || patientId === null) return;
    const res = await linkAbha(flow.transactionId, { patientId, acceptAbdmDemographics: accepted });
    setLinked(true);
    onLinked?.(res.changed);
  });

  const profile = flow?.stage === "authenticated" ? flow.profile : null;
  const comparison: WireFieldComparison[] | null = serverComparison
    ?? flow?.comparison
    ?? (profile !== null && against !== null ? compareOnScreen(profile, against) : null);
  const changes: WireDemographicChange[] = serverChanges ?? flow?.demographicsToApply ?? [];
  /* A patient on file: acceptance is owed when the link will change anything. The counter: when ABDM's
     name, birth or gender differ from what the form holds (the form will take ABDM's). */
  const needsAcceptance = patientId !== null
    ? changes.length > 0
    : (comparison ?? []).some((c) => c.result === "differs" && c.field !== "mobile");
  const canFinish = (!needsAcceptance || accepted) && elsewhere === null;
  const needsAadhaar = mode === "create" || mode === "find_aadhaar";
  const resendAt = flow?.resend === null || flow?.resend === undefined ? null : Date.parse(flow.resend.availableAt);
  const resendWait = resendAt === null ? 0 : Math.max(0, Math.ceil((resendAt - now) / 1000));
  const resendsLeft = flow?.resend?.left ?? 0;

  const title = mode === "create" ? "abdm.create.title" : mode === "find_aadhaar" ? "abdm.find.title" : "abdm.verify.title";

  return (
    <div className="box" data-testid="abdm-flow" style={{ padding: 14, marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <b style={{ fontSize: 14 }}>{t(title)}</b>
        <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("abdm.verify.subtitle")}</span>
        <button type="button" className="sec" style={{ marginLeft: "auto" }} data-testid="abdm-close" onClick={onClose}>{t("abdm.verify.close")}</button>
      </div>

      {elsewhere !== null ? (
        <p role="alert" data-testid="abdm-linked-elsewhere" style={{ color: "var(--red)", fontWeight: 700, fontSize: 12.5, marginTop: 10 }}>
          {elsewhere.uhid === null ? t("abdm.verify.linkedElsewhereHidden") : t("abdm.verify.linkedElsewhere", { uhid: elsewhere.uhid })}
        </p>
      ) : null}

      {linked ? (
        <p data-testid="abdm-linked" style={{ color: "var(--green)", fontWeight: 700, marginTop: 10 }}>{t("abdm.verify.linked")}</p>
      ) : flow === null ? (
        /* ── step 1 ── */
        needsAadhaar ? (
          <div style={{ marginTop: 10 }}>
            <div className="tag" style={{ marginBottom: 5 }}>{t("abdm.create.aadhaar")}</div>
            <AadhaarField value={aadhaar} onChange={setAadhaar} testId="abdm-aadhaar" />
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, marginTop: 9, lineHeight: "16px" }}>
              <input type="checkbox" data-testid="abdm-consent" checked={consented} onChange={(e) => setConsented(e.target.checked)} />
              <span>{t(mode === "create" ? "abdm.create.consent" : "abdm.find.consent")}</span>
            </label>
            <button
              type="button" className="pri" data-testid="abdm-send-otp" style={{ marginTop: 10 }}
              disabled={busy || !consented || aadhaarDigits(aadhaar).length !== 12}
              onClick={() => { void start(); }}
            >
              {t("abdm.create.sendOtp")}
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            <div className="tag" style={{ marginBottom: 5 }}>{t("abdm.verify.identifier")}</div>
            <input className="in mo" data-testid="abdm-identifier" placeholder="12-3456-7890-1234 · name@abdm · 98XXXXXXXX" value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
            <div className="tag" style={{ margin: "10px 0 5px" }}>{t("abdm.verify.method")}</div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              {(["aadhaar_otp", "mobile_otp"] as const).map((m) => (
                <button
                  key={m} type="button" data-testid={`abdm-method-${m === "aadhaar_otp" ? "aadhaar" : "mobile"}`}
                  className={method === m ? "pill on" : "pill"} aria-pressed={method === m}
                  onClick={() => setMethod(m)}
                >
                  {t(m === "aadhaar_otp" ? "abdm.verify.methodAadhaar" : "abdm.verify.methodMobile")}
                </button>
              ))}
            </div>
            <p style={{ fontSize: 11, color: "var(--dim)", margin: "6px 0 0" }}>{t("abdm.verify.mobileHint")}</p>
            <button type="button" className="pri" data-testid="abdm-send-otp" style={{ marginTop: 10 }} disabled={busy || identifier.trim() === ""} onClick={() => { void start(); }}>
              {t("abdm.verify.sendOtp")}
            </button>
          </div>
        )
      ) : flow.stage === "otp_sent" ? (
        /* ── step 2 ── */
        <div style={{ marginTop: 10 }}>
          {flow.message !== null ? <p data-testid="abdm-otp-message" style={{ fontSize: 12, color: "var(--dim)", margin: "0 0 8px" }}>{flow.message}</p> : null}
          <div className="tag" style={{ marginBottom: 5 }}>{t("abdm.verify.otp")}</div>
          <input
            className="in mo" data-testid="abdm-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          {mode === "create" ? (
            <>
              <div className="tag" style={{ margin: "10px 0 5px" }}>{t("abdm.create.mobile")}</div>
              <input className="in mo" data-testid="abdm-mobile" inputMode="numeric" value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))} />
            </>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button" className="pri" data-testid="abdm-verify-otp"
              disabled={busy || otp.length !== 6 || (mode === "create" && mobile.length !== 10)}
              onClick={() => { void confirmOtp(); }}
            >
              {t("abdm.verify.confirmOtp")}
            </button>
            {/* CRT_ABHA_106 / VRFY_ABHA_305 / 405 — after 60 s, at most twice. */}
            {flow.resendNeedsAadhaar && resendWait === 0 && resendsLeft > 0 ? (
              <span style={{ width: 170 }}><AadhaarField value={aadhaar} onChange={setAadhaar} testId="abdm-resend-aadhaar" /></span>
            ) : null}
            <button
              type="button" className="sec" data-testid="abdm-resend"
              disabled={busy || resendWait > 0 || resendsLeft === 0 || (flow.resendNeedsAadhaar && aadhaarDigits(aadhaar).length !== 12)}
              onClick={() => { void resend(); }}
            >
              {resendsLeft === 0 ? t("abdm.verify.resendNone") : resendWait > 0 ? t("abdm.verify.resendIn", { s: resendWait }) : t("abdm.verify.resend", { left: resendsLeft })}
            </button>
            <button type="button" className="sec" data-testid="abdm-restart" onClick={() => { setFlow(null); setOtp(""); }}>{t("abdm.verify.restart")}</button>
          </div>
        </div>
      ) : flow.stage === "choose_account" ? (
        /* ── step 3: VRFY_ABHA_303 / 404 ── */
        <div style={{ marginTop: 10 }} data-testid="abdm-accounts">
          <p style={{ fontSize: 12, margin: "0 0 6px" }}>{t("abdm.verify.chooseAccount")}</p>
          {(flow.accounts ?? []).map((a) => (
            <div key={a.abhaNumber ?? a.abhaAddress ?? ""} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12.5, padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
              <b>{a.name ?? "—"}</b>
              <span className="mo">{a.abhaNumber ?? ""}</span>
              <span className="mo" style={{ color: "var(--dim)" }}>{a.abhaAddress ?? ""}</span>
              {a.abhaNumber !== null ? (
                <button type="button" className="sec" style={{ marginLeft: "auto" }} data-testid={`abdm-choose-${a.abhaNumber}`} disabled={busy} onClick={() => { void choose(a.abhaNumber!); }}>
                  {t("abdm.verify.choose")}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        /* ── step 4 ── */
        <div style={{ marginTop: 10 }} data-testid="abdm-profile">
          {flow.purpose === "create" ? (
            <p style={{ fontSize: 12, margin: "0 0 8px" }}>{t(flow.isNew === false ? "abdm.create.existing" : "abdm.create.created")}</p>
          ) : null}
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12.5 }}>
            <span className="tag">{t("abdm.profile.abhaNumber")}</span><span className="mo" data-testid="abdm-profile-number">{profile?.abhaNumber ?? "—"}</span>
            <span className="tag">{t("abdm.profile.abhaAddress")}</span><span className="mo" data-testid="abdm-profile-address">{profile?.abhaAddress ?? "—"}</span>
          </div>

          {/* ── creation extras ── */}
          {flow.purpose === "create" && (flow.mobileVerification === "required" || flow.mobileVerification === "otp_sent") ? (
            <div className="box" data-testid="abdm-mobile-check" style={{ padding: 9, marginTop: 9, background: "var(--wash)" }}>
              <p style={{ fontSize: 12, margin: 0 }}>{t("abdm.create.mobileNotAadhaar", { mobile })}</p>
              {flow.mobileVerification === "otp_sent" ? (
                <div style={{ display: "flex", gap: 8, marginTop: 7 }}>
                  <input className="in mo" data-testid="abdm-mobile-otp" style={{ width: 120 }} inputMode="numeric" value={mobileOtp} onChange={(e) => setMobileOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} />
                  <button type="button" className="pri" data-testid="abdm-mobile-verify" disabled={busy || mobileOtp.length !== 6} onClick={() => { void verifyMobile(); }}>{t("abdm.verify.confirmOtp")}</button>
                  <button type="button" className="sec" data-testid="abdm-mobile-resend" disabled={busy} onClick={() => { void sendMobile(); }}>{t("abdm.create.mobileResend")}</button>
                </div>
              ) : (
                <button type="button" className="sec" data-testid="abdm-mobile-send" style={{ marginTop: 7 }} disabled={busy} onClick={() => { void sendMobile(); }}>{t("abdm.create.mobileSend")}</button>
              )}
            </div>
          ) : null}
          {flow.purpose === "create" && flow.mobileVerification === "verified" ? (
            <p data-testid="abdm-mobile-verified" style={{ fontSize: 12, color: "var(--green)", margin: "8px 0 0" }}>{t("abdm.create.mobileVerified")}</p>
          ) : null}
          {flow.purpose === "create" ? (
            <div data-testid="abdm-address-block" style={{ marginTop: 9 }}>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" className="sec" data-testid="abdm-address-suggest" disabled={busy} onClick={() => { void suggest(); }}>{t("abdm.create.suggest")}</button>
                {(flow.addressSuggestions ?? []).map((a) => (
                  <button key={a} type="button" className="pill" data-testid={`abdm-address-pick-${a}`} disabled={busy} onClick={() => { void makeAddress(a); }}>{a}</button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 7, marginTop: 7 }}>
                <input className="in mo" data-testid="abdm-address-input" style={{ width: 200 }} placeholder="name.1234" value={address} onChange={(e) => setAddress(e.target.value.trim())} />
                <button type="button" className="sec" data-testid="abdm-address-create" disabled={busy || address === ""} onClick={() => { void makeAddress(address); }}>{t("abdm.create.makeAddress")}</button>
              </div>
              <p style={{ fontSize: 11, color: "var(--dim)", margin: "4px 0 0" }}>{t("abdm.create.addressRule")}</p>
            </div>
          ) : null}

          {comparison !== null ? (
            <table style={{ width: "100%", marginTop: 10, fontSize: 12.5, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--dim)" }}>
                  <th />
                  <th>{t("abdm.profile.abdmSays")}</th>
                  <th>{t("abdm.profile.hospitalSays")}</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((c) => (
                  <tr
                    key={c.field} data-testid={`abdm-compare-${c.field}`} data-result={c.result}
                    style={c.result === "differs" ? { background: "var(--red-soft, #fdecea)", color: "var(--red)" } : undefined}
                  >
                    <td className="tag">{t(`abdm.profile.field.${c.field}`)}</td>
                    <td>{c.abdm ?? "—"}</td>
                    <td>{c.hospital ?? "—"}{c.result === "differs" ? ` · ${t("abdm.profile.differs")}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {patientId !== null && changes.length > 0 ? (
            <ul data-testid="abdm-will-update" style={{ fontSize: 12, margin: "8px 0 0", paddingLeft: 18 }}>
              {changes.map((c) => (
                <li key={c.field}>{t("abdm.profile.willUpdate", { field: t(`abdm.profile.field.${c.field}`), from: c.from ?? "—", to: c.to })}</li>
              ))}
            </ul>
          ) : null}
          {needsAcceptance ? (
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, marginTop: 10, lineHeight: "16px" }}>
              <input type="checkbox" data-testid="abdm-accept" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              <span>{t("abdm.profile.accept")}</span>
            </label>
          ) : null}
          <p style={{ fontSize: 11.5, color: "var(--dim)", margin: "8px 0 0" }}>{t("abdm.profile.authoritative")}</p>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            {patientId !== null ? (
              <button type="button" className="pri" data-testid="abdm-link" disabled={busy || !canFinish} onClick={() => { void link(); }}>{t("abdm.verify.link")}</button>
            ) : (
              <button type="button" className="pri" data-testid="abdm-use" disabled={busy || !canFinish} onClick={() => { onUse?.(flow, accepted || !needsAcceptance); }}>{t("abdm.verify.use")}</button>
            )}
            <button type="button" className="sec" data-testid="abdm-card-show" disabled={busy} onClick={() => { void showCard(); }}>{t("abdm.verify.showCard")}</button>
            <button type="button" className="sec" data-testid="abdm-card-download" disabled={busy} onClick={() => { void saveCard(); }}>{t("abdm.verify.downloadCard")}</button>
          </div>
          {card !== null ? <img data-testid="abdm-card" src={card} alt={t("abdm.verify.cardAlt")} style={{ maxWidth: "100%", marginTop: 10, border: "1px solid var(--line)", borderRadius: 6 }} /> : null}
        </div>
      )}

      {error !== null ? (
        <p role="alert" data-testid="abdm-error" style={{ color: "var(--red)", fontSize: 12, marginTop: 9 }}>{error}</p>
      ) : null}
    </div>
  );
}
