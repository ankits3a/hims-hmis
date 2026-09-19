import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { decideAuthorisation, fetchAuthorisation, pharmacyErrorText } from "../lib/pharmacy-api";
import { sigOf } from "./pharmacy-desk/work";
import { ticketLabel } from "./pharmacy-desk/model";

/**
 * ═══ PD-9 — THE PRESCRIBER DECIDES (owner ruling 2026-09-19) ═══
 *
 * "The doctor must authorise dispensing against a recorded allergy." The pharmacy asked THIS doctor —
 * the one who wrote the prescription — about one refusal on one line; this page is where they read
 * it and decide. The server lets nobody else read or decide it, and a decision without a reason is
 * refused: a decision about a patient's safety records why. Reached from the request on the doctor's
 * own desk.
 */
export function PharmacyAuthorise({ authorisationId }: { authorisationId: string }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const detail = useQuery({ queryKey: ["pharmacy", "authorisation", authorisationId], queryFn: () => fetchAuthorisation(authorisationId), retry: false });

  const decide = async (authorise: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await decideAuthorisation(authorisationId, authorise, reason.trim());
      await qc.invalidateQueries({ queryKey: ["pharmacy", "authorisation", authorisationId] });
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  if (detail.isPending) return <p style={{ padding: 24 }}>{t("pharmacyAuthorise.loading")}</p>;
  if (detail.error !== null) return <p role="alert" style={{ padding: 24, color: "var(--red, #b3261e)" }}>{pharmacyErrorText(detail.error, t)}</p>;
  const { authorisation: a, patient, line, dispenseNo, requestedByName } = detail.data;
  const who = patient === null ? "—" : patient.restricted ? (patient.alias ?? patient.uhid) : (patient.name ?? patient.uhid);
  const ready = !busy && reason.trim().length >= 3;

  return (
    <div data-testid="pharmacy-authorise" style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px" }}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{t("pharmacyAuthorise.title")}</h1>
      <p style={{ margin: "6px 0 0 0", fontSize: 13, color: "var(--dim, #5b6b66)" }}>{t("pharmacyAuthorise.lead")}</p>

      <div style={{ marginTop: 18, padding: "14px 16px", border: "1px solid var(--line, #d8e0dc)", borderRadius: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{who}</div>
        <div style={{ fontSize: 12, color: "var(--dim, #5b6b66)", marginTop: 2 }}>
          {[patient?.uhid ?? null, ticketLabel(dispenseNo)].filter((x) => x !== null).join(" · ")}
        </div>
        {line === null ? null : (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{line.drug}</div>
            <div style={{ fontSize: 12, color: "var(--dim, #5b6b66)" }}>{sigOf(line)}{line.instructions === null || line.instructions === "" ? "" : ` · ${line.instructions}`}</div>
          </div>
        )}
        <div style={{ marginTop: 12, fontSize: 13, color: "var(--red, #b3261e)", fontWeight: 600 }}>
          {t(`pharmacyAuthorise.book.${a.book}`)} · {a.book === "drug_disease" ? a.about.split(":").reverse().join(" · ") : a.about}
        </div>
        {a.requestNote === null ? null : (
          <div style={{ marginTop: 8, fontSize: 12.5 }}>{requestedByName ?? t("pharmacyAuthorise.thePharmacist")}: {a.requestNote}</div>
        )}
      </div>

      {a.status === "pending" ? (
        <div style={{ marginTop: 16 }}>
          <label htmlFor="authorise-reason" style={{ display: "block", fontSize: 12, fontWeight: 600 }}>{t("pharmacyAuthorise.reason")}</label>
          <textarea
            id="authorise-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder={t("pharmacyAuthorise.reasonPlaceholder")}
            style={{ width: "100%", marginTop: 6, padding: 8, fontSize: 13, borderRadius: 6, border: "1px solid var(--line, #d8e0dc)", boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button className="pri" disabled={!ready} onClick={() => void decide(true)}>{t("pharmacyAuthorise.authorise")}</button>
            <button className="sec" disabled={!ready} onClick={() => void decide(false)}>{t("pharmacyAuthorise.decline")}</button>
          </div>
          {error !== null ? <p role="alert" style={{ marginTop: 10, fontSize: 12.5, color: "var(--red, #b3261e)" }}>{error}</p> : null}
        </div>
      ) : (
        <p role="status" style={{ marginTop: 16, fontSize: 13.5, fontWeight: 600 }}>
          {a.status === "authorised"
            ? t("pharmacyAuthorise.authorised", { reason: a.decisionReason ?? "" })
            : t("pharmacyAuthorise.declined", { reason: a.decisionReason ?? "" })}
        </p>
      )}
    </div>
  );
}
