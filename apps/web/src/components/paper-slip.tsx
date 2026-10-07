import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getPatientDocument, listPatientDocuments } from "../lib/patients-api";
import { fmtIst } from "../lib/format";
import "./paper-slip.css";

/**
 * ═══ THE DOCTOR'S PAPER, BESIDE WHAT WAS TYPED FROM IT (owner ruling 2026-10-06) ═══
 *
 * The signed paper is the original; what the desk typed is a copy of it. So every seat that reads
 * the copy — the scribe typing it, the doctor glancing at it, the lab billing from it — can put the
 * photograph next to it. One component, because three private copies of "show the slip" would
 * disagree about which page is the newest within a month.
 *
 * It shows the `consult_prescription` pages photographed against THIS visit, oldest first (page 1
 * is the first page the desk filed), with a zoom that needs no mouse wheel.
 *
 * Opening a page writes a PHI-access row on the server against the reader — so a page is fetched
 * only when it is the one on show, never the whole set in advance.
 */
export type SlipPage = { id: string; capturedAt: string };

export function usePaperSlipPages(patientId: string | null, encounterId: string | null, known?: SlipPage[]): {
  pages: SlipPage[]; pending: boolean; failed: boolean;
} {
  const docs = useQuery({
    queryKey: ["patients", "documents", patientId ?? ""],
    queryFn: () => listPatientDocuments(patientId!),
    enabled: known === undefined && patientId !== null && encounterId !== null,
    retry: false,
  });
  if (known !== undefined) return { pages: known, pending: false, failed: false };
  const pages = (docs.data ?? [])
    .filter((d) => d.encounterId === encounterId && d.kind === "consult_prescription")
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .map((d) => ({ id: d.id, capturedAt: d.capturedAt }));
  return { pages, pending: docs.isPending && patientId !== null, failed: docs.isError };
}

const ZOOMS = [1, 1.5, 2, 3] as const;

export function PaperSlipPane({ patientId, encounterId, pages: known, emptyHint }: {
  patientId: string | null;
  encounterId: string | null;
  /** When the caller already holds the visit's page list (the paper-consult rows carry it), no second read. */
  pages?: SlipPage[];
  /** What to say when nothing is filed — the scribe's seat says "type from the paper in your hand". */
  emptyHint?: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const { pages, pending, failed } = usePaperSlipPages(patientId, encounterId, known);
  const [at, setAt] = useState(0);
  const [zoom, setZoom] = useState(0);
  /* A new visit, or a page filed while this pane is open: show the NEWEST page, unzoomed. */
  const newest = pages.length - 1;
  useEffect(() => { setAt(Math.max(0, newest)); setZoom(0); }, [encounterId, newest]);
  const page = pages[at];
  const image = useQuery({
    queryKey: ["patients", "document", page?.id ?? ""],
    queryFn: () => getPatientDocument(page!.id),
    enabled: page !== undefined,
    retry: false,
  });
  const scale = ZOOMS[zoom] ?? 1;

  return (
    <section className="pslip" data-testid="paper-slip" aria-label={t("paper.slip.title")}>
      <header className="pslip-h">
        <span className="tag">{t("paper.slip.title")}</span>
        {pages.length > 1 && (
          <span className="pslip-pages" role="group" aria-label={t("paper.slip.pages")}>
            {pages.map((p, i) => (
              <button
                key={p.id} type="button" className={i === at ? "pslip-pg on" : "pslip-pg"} aria-pressed={i === at}
                onClick={() => { setAt(i); setZoom(0); }}
              >{String(i + 1)}</button>
            ))}
          </span>
        )}
        <span className="pslip-grow" />
        {page !== undefined && (
          <span className="pslip-zoom" role="group" aria-label={t("paper.slip.zoom")}>
            <button type="button" className="pslip-pg" aria-label={t("paper.slip.zoomOut")} disabled={zoom === 0} onClick={() => { setZoom((z) => Math.max(0, z - 1)); }}>−</button>
            <span className="mo" data-testid="paper-slip-zoom">{String(Math.round(scale * 100))}%</span>
            <button type="button" className="pslip-pg" aria-label={t("paper.slip.zoomIn")} disabled={zoom === ZOOMS.length - 1} onClick={() => { setZoom((z) => Math.min(ZOOMS.length - 1, z + 1)); }}>+</button>
          </span>
        )}
      </header>
      <div className="pslip-body" data-zoomed={zoom > 0 ? "true" : undefined}>
        {pending || (page !== undefined && image.isPending) ? (
          <p className="pslip-say">{t("paper.slip.loading")}</p>
        ) : failed || image.isError ? (
          <p className="pslip-say" role="status">{t("paper.slip.unreadable")}</p>
        ) : page === undefined ? (
          <p className="pslip-say" role="status" data-testid="paper-slip-none">{emptyHint ?? t("paper.slip.none")}</p>
        ) : image.data !== undefined ? (
          <img
            alt={t("paper.slip.alt", { n: at + 1 })}
            src={`data:${image.data.mimeType};base64,${image.data.imageBase64}`}
            style={{ width: `${String(scale * 100)}%`, maxWidth: "none" }}
          />
        ) : null}
      </div>
      {page !== undefined && (
        <footer className="pslip-f">{t("paper.slip.filedAt", { at: fmtIst(page.capturedAt), n: at + 1, of: pages.length })}</footer>
      )}
    </section>
  );
}

/** The same pane as a sheet, for a seat that has no room to keep the paper on screen all the time. */
export function PaperSlipSheet({ patientId, encounterId, pages, onClose }: {
  patientId: string; encounterId: string; pages?: SlipPage[]; onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); };
  }, [onClose]);
  return (
    <div className="pslip-ovl" role="dialog" aria-modal="true" aria-label={t("paper.slip.title")} onClick={onClose}>
      <div className="pslip-sheet" onClick={(e) => { e.stopPropagation(); }}>
        <PaperSlipPane patientId={patientId} encounterId={encounterId} {...(pages === undefined ? {} : { pages })} />
        <div className="pslip-sheet-f">
          <span>{t("paper.slip.rule")}</span>
          <button type="button" className="sec" onClick={onClose} data-testid="paper-slip-close">{t("paper.slip.close")} <span className="kb">Esc</span></button>
        </div>
      </div>
    </div>
  );
}
