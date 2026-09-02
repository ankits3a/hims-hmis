import { desc, eq } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { appendEvent } from "../../kernel/events/append";
import { newId } from "@hmis/contracts";
import { imagingImageViews, imagingStudies } from "../../kernel/db/schema/radiology";
import { activeDefinitionRow, parseDefinitionBody } from "./definitions";
import { RadiologyError } from "./errors";
import { imagingImageViewed } from "./events";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18b T3 — **THE VIEWER DOOR, AND THE ROW IT LEAVES BEHIND (D5, D6).**
 *
 * ═══ THE URL IS COMPUTED HERE, NOT ON THE CLIENT ═══
 *
 * The screen never sees the template. It asks to open the images, this function decides whether
 * there are any (`image_source = 'pacs'` and a UID), whether a viewer is published
 * (`pacs_settings`, active, enabled), writes the `imaging_image_views` row, emits
 * `imaging.image_viewed`, logs the PHI disclosure on `imaging.study`, and only THEN returns the
 * URL. A client that built the link itself could open the images without any of that happening,
 * which is the negative-space row ("a shift with zero views") reading zero for the wrong reason.
 *
 * The refusals are the product: `no_images` tells a reader the study was recorded with no DICOM
 * (M1's portable, an outside film) rather than that the PACS is down; `pacs_not_configured` tells
 * an administrator to publish the book. Neither is "could not open".
 */

export const IMAGES_READ = "radiology.reports.read";

export function renderViewerUrl(template: string, values: { accessionNo: string; studyInstanceUid: string }): string {
  return template
    .replaceAll("{accessionNo}", encodeURIComponent(values.accessionNo))
    .replaceAll("{studyInstanceUid}", encodeURIComponent(values.studyInstanceUid));
}

export type ImageViewRow = { id: string; viewerId: string; via: string; viewedAt: Date };

export async function openImages(
  tx: Tx,
  actor: Actor,
  input: { studyId: string; now?: Date },
): Promise<{ url: string; viewId: string; studyInstanceUid: string }> {
  if (actor.type !== "user") {
    throw new RadiologyError("forbidden", `a ${actor.type} actor does not look at images`);
  }
  if (!(await hasPermission(tx, actor.id, IMAGES_READ, "hospital"))) {
    throw new RadiologyError("forbidden", `${actor.id} does not hold ${IMAGES_READ}`);
  }
  const [study] = await tx.select({
    id: imagingStudies.id, accessionNo: imagingStudies.accessionNo, patientId: imagingStudies.patientId,
    encounterNo: imagingStudies.encounterNo, imageSource: imagingStudies.imageSource,
    studyInstanceUid: imagingStudies.studyInstanceUid,
  }).from(imagingStudies).where(eq(imagingStudies.id, input.studyId));
  if (!study) throw new RadiologyError("unknown_study", `no study ${input.studyId}`, { studyId: input.studyId });
  if (study.imageSource !== "pacs" || study.studyInstanceUid === null) {
    throw new RadiologyError(
      "no_images",
      study.imageSource === null
        ? `study ${study.accessionNo} has not been acquired — there are no images yet`
        : `study ${study.accessionNo} was recorded as ${study.imageSource} — there is no DICOM study to open`,
      { studyId: study.id, imageSource: study.imageSource },
    );
  }
  const row = await activeDefinitionRow(tx, "pacs_settings");
  const settings = row === undefined ? null : parseDefinitionBody("pacs_settings", row.body);
  if (settings === null || !settings.enabled) {
    throw new RadiologyError(
      "pacs_not_configured",
      "no viewer is published — publish an enabled `pacs_settings` definition (18b D5)",
      { studyId: study.id, published: settings !== null },
    );
  }
  const url = renderViewerUrl(settings.viewer_url_template, {
    accessionNo: study.accessionNo, studyInstanceUid: study.studyInstanceUid,
  });
  const now = input.now ?? new Date();
  const viewId = newId();
  await tx.insert(imagingImageViews).values({
    id: viewId, studyId: study.id, viewerId: actor.id, via: "external_pacs",
    urlHost: new URL(url).host, viewedAt: now,
  });
  await appendEvent(tx, imagingImageViewed.make({
    actor, patientId: study.patientId, encounterId: study.encounterNo,
    payload: { studyId: study.id, viewerId: actor.id, via: "external_pacs" },
    correlationId: study.id, occurredAt: now,
  }));
  await recordPhiAccess(tx, {
    actor, patientId: study.patientId, surface: "imaging.study",
    encounterId: study.encounterNo, reason: `images opened for ${study.accessionNo} via external_pacs`,
  });
  return { url, viewId, studyInstanceUid: study.studyInstanceUid };
}

/** The consumer in the same PR (D6): who opened this study's images, latest first. */
export async function studyImageViews(exec: Db | Tx, studyId: string): Promise<ImageViewRow[]> {
  return await (exec as Db)
    .select({
      id: imagingImageViews.id, viewerId: imagingImageViews.viewerId,
      via: imagingImageViews.via, viewedAt: imagingImageViews.viewedAt,
    })
    .from(imagingImageViews)
    .where(eq(imagingImageViews.studyId, studyId))
    .orderBy(desc(imagingImageViews.viewedAt));
}
