import { Controller, Inject, Param, Post } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { IMAGES_READ, openImages } from "./views";
import { toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18b T3 — `POST /radiology/studies/:studyId/images/open`. A POST, not a GET, because it
 * WRITES: the view row, the event and the PHI line exist before the URL is returned (D6).
 * `radiology.reports.read` is the permission: the images are read beside the report, and the
 * three roles that read reports (radiologist, radiographer, the referring doctor) are the three
 * that open images; the receptionist, who holds the worklist but no report, does not.
 */
@Controller("radiology/studies")
export class RadiologyImagesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post(":studyId/images/open")
  @RequirePermission(IMAGES_READ, "hospital")
  async open(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return await withTx(this.db, (tx) => openImages(tx, actor, { studyId }));
    } catch (e) { toHttp(e); }
  }
}
