import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";
import type { PrintDocument } from "./enqueue";

/**
 * ═══ THE PRINT RAIL'S LEAF: WHAT A MODULE NEEDS TO DRAW ITS OWN PAPER, AND NOTHING ELSE ═══
 *
 * Split out of `render.ts` (which re-exports all of it) because `render.ts` draws the OPD documents
 * and so imports billing, opd and patients. A module that registers a renderer imported those with
 * it. For the roster that closed a load cycle: tariff → kernel/workflow → modules/roster →
 * render → billing, and billing reads `DISCOUNT_CATEGORIES` from tariff at load time while tariff is
 * still half-loaded — every suite whose first import was tariff died before running (CI on #484,
 * 2026-10-04; pinned by `modules/roster/load-order.test.ts`). This file imports only types.
 */

/** A rendered document, ready for the relay to convert and print. */
export type RenderedDocument = {
  /** Self-contained HTML: inline CSS, no external fetch, no font CDN. The relay may be offline. */
  html: string;
  /** For the operator's log and the relay's own sanity check. */
  title: string;
  /**
   * ═══ THE PAGE GEOMETRY, AND WHY IT TRAVELS AS DATA RATHER THAN LIVING ONLY IN THE CSS ═══
   *
   * **MEASURED, NOT ASSUMED: Chromium SILENTLY IGNORES `@page { size: 72mm auto }`.** A first cut of
   * this phase relied on the CSS alone and produced a US-Letter PDF — 215.9 × 279.4 mm — with the
   * slip stranded in the corner of a sheet. `preferCSSPageSize: true` does not rescue it either;
   * only an EXPLICIT height is honoured (`size: 72mm 200mm` renders exactly 72.0 × 200.1 mm).
   *
   * A thermal roll is continuous, so there is no explicit height to write: the slip is as long as
   * the job needs. So the geometry travels to the relay, which has the browser, and the relay
   * MEASURES the laid-out document before printing when `heightMm` is null.
   *
   * The `@page` rules in the CSS below STAY. They are the correct declaration of intent for any
   * renderer that honours them, and they keep the template readable — but they are not what makes
   * the paper the right size, and a future reader should not believe they are.
   */
  page: { widthMm: number; heightMm: number | null };
};

/** Escapes text for HTML. Everything interpolated below goes through it — patient names included. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * ═══ EVERY FIELD HERE IS PRE-ESCAPED AND INTERPOLATED RAW ═══
 *
 * `name` and `nameTitleCase` carry `&amp;` as an ENTITY, so putting them through `esc()` prints the
 * literal `&amp;` on the paper. That is a trap the next reader will step in exactly once; it is
 * written down here rather than discovered on a printed sheet.
 */
export const HOSPITAL = {
  name: "CRK MEDICAL COLLEGE &amp; HOSPITAL",
  /**
   * The SAME establishment, title-cased, for the prescription letterhead's footer.
   *
   * NOT a unification of the line above, and deliberately so: the thermal slips print the name in
   * caps, and a SECOND, unescaped copy of the same string lives at `modules/opd/config.ts` behind
   * seven tests across four modules. Folding three spellings into one is a cross-module change with
   * its own review — it is not something a layout change may quietly do on the way past.
   */
  nameTitleCase: "CRK Medical College &amp; Hospital",
  address: "Chaurasia Chowk, Hajipur — 844101, Bihar",
  contact: "Hotline +91 77648 88189 · Emergency 1068",
  /* FD-29 — split out of `contact` for the prescription footer, which labels them separately. */
  hotline: "+91 77648 88189",
  emergency: "1068",
  email: "info@crkmch.com",
  website: "www.crkmch.com",
};

/**
 * ═══ PHARMACY P1 — A MODULE DRAWS ITS OWN PAPER ═══
 *
 * The OPD documents are drawn in this file because the kernel already reads the encounter. A
 * pharmacy bill is the pharmacy's rows (the dispense, its merged bill rows, its labels), and this
 * file importing the pharmacy module would make the kernel depend on a leaf. So a module registers a
 * renderer for a document it declared in `PrintDocument`, from its Nest module's `onModuleInit` —
 * the `registerFeeStatusHook` shape. Keyed, so a second init replaces rather than doubles.
 *
 * A document with neither a case below nor a registration renders null, which the relay reports
 * failed: advisory, per R7, exactly as before.
 */
export type DocumentRenderer = (
  db: Db, params: Record<string, unknown>, now: Date, requester: Actor | null,
) => Promise<RenderedDocument | null>;

const MODULE_RENDERERS = new Map<string, DocumentRenderer>();

export function registerDocumentRenderer(document: PrintDocument, renderer: DocumentRenderer): () => void {
  MODULE_RENDERERS.set(document, renderer);
  return () => { if (MODULE_RENDERERS.get(document) === renderer) MODULE_RENDERERS.delete(document); };
}

/** The renderer a module registered for a document, if any — `renderDocument`'s default case. */
export function registeredRenderer(document: string): DocumentRenderer | undefined {
  return MODULE_RENDERERS.get(document);
}
