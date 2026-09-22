import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getPatientDocument, listPatientDocuments } from "../../lib/patients-api";
import type { WireDispense } from "../../lib/pharmacy-api";

/**
 * ═══ PD-8 — WHAT THE SCRIBE PHOTOGRAPHED (`S`) ═══
 *
 * A prescription typed from the doctor's paper (FD-31) is the hospital's record; the paper is what
 * the doctor signed. The pharmacist cross-confirms one against the other before the money
 * (`slip_not_confirmed` refuses billing), and this sheet is where the paper is looked at: the
 * `consult_prescription` document photographed against THIS visit at `/opd/slips`, newest first.
 *
 * ═══ E30 — THE PHOTOGRAPH MAY NOT EXIST ANYWHERE ═══
 *
 * `DOCUMENT_STORE_PATH` is set on no deployment today (`app.module.ts`), so a slip may never have
 * been filed, or may be listed and unreadable. Either way the sheet says so in a sentence and the
 * pharmacist confirms against the paper in the patient's hand — never an error box in place of a
 * picture. Opening a document writes a PHI-access row on the server; the sheet says that too.
 */
export function SlipSheet({ dispense, onClose }: { dispense: WireDispense; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const docs = useQuery({
    queryKey: ["patients", "documents", dispense.patient.id],
    queryFn: () => listPatientDocuments(dispense.patient.id),
    retry: false,
  });
  const slip = (docs.data ?? [])
    .filter((d) => d.encounterId === dispense.encounterId && d.kind === "consult_prescription")
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
  const image = useQuery({
    queryKey: ["patients", "document", slip?.id],
    queryFn: () => getPatientDocument(slip!.id),
    enabled: slip !== undefined,
    retry: false,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const unreadable = docs.error !== null || image.error !== null;
  return (
    <div className="ovl" role="dialog" aria-modal="true" aria-label={t("pharmacyDesk.slip.title")} onClick={onClose}>
      <div className="box" style={{ width: 620, maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 70px rgba(19,36,32,.35)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "15px 18px", borderBottom: "1px solid var(--line2)" }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, flexGrow: 1 }}>{t("pharmacyDesk.slip.title")}</h2>
          {dispense.transcribedByName != null ? <span className="pill">{t("pharmacyDesk.slip.typedBy", { name: dispense.transcribedByName })}</span> : null}
          <button className="pill" onClick={onClose}>{t("pharmacyDesk.close")} <span className="kb">Esc</span></button>
        </div>
        <div style={{ padding: 18, overflowY: "auto" }} data-testid="slip-body">
          {docs.isPending || (slip !== undefined && image.isPending) ? (
            <p style={{ margin: 0, color: "var(--dim)", fontSize: 12.5 }}>{t("pharmacyDesk.slip.loading")}</p>
          ) : unreadable ? (
            <p role="status" style={{ margin: 0, fontSize: 12.5, lineHeight: "18px" }}>{t("pharmacyDesk.slip.unreadable")}</p>
          ) : slip === undefined ? (
            <p role="status" style={{ margin: 0, fontSize: 12.5, lineHeight: "18px" }}>{t("pharmacyDesk.slip.none")}</p>
          ) : image.data !== undefined ? (
            <>
              <img
                alt={t("pharmacyDesk.slip.alt")}
                src={`data:${image.data.mimeType};base64,${image.data.imageBase64}`}
                style={{ display: "block", maxWidth: "100%", borderRadius: 6, border: "1px solid var(--line)" }}
              />
              {/* Said only beside a photograph that was actually opened — with none, no row was written. */}
              <p style={{ margin: "12px 0 0 0", fontSize: 11.5, color: "var(--dim)", lineHeight: "17px" }}>{t("pharmacyDesk.slip.rule")}</p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
