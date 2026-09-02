import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { events, imagingDefinitions, imagingImageViews, imagingStudies, phiAccessLog } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { draftDefinition, parseDefinitionBody } from "./definitions";
import { studyView } from "./read";
import { IMAGES_READ, openImages, renderViewerUrl } from "./views";
import { mintStudyInstanceUid } from "./uid";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18b T3 — the viewer door. The assertion book's three: a `pacs` study with an active
 * `pacs_settings` returns the templated URL and writes ONE view row, ONE event, ONE PHI row
 * (mutant: record before the refusal — a `no_pacs_images` study must leave no row); no active
 * `pacs_settings` → `pacs_not_configured` and zero rows; a bad template cannot be published.
 */
describe("the viewer door and image.viewed (18b T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let reader: Actor;
  let nobody: Actor;
  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T03:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const TEMPLATE = "https://pacs.example.org/ohif/viewer?AccessionNumber={accessionNo}&StudyInstanceUIDs={studyInstanceUid}";
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    seq = 0;
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: [IMAGES_READ], subscriptions: [] });
    await syncPermissions(db, registry);
    for (const role of ["rad_reader", "nobody"]) await ensureRole(db, role);
    await grantPermissionToRole(db, registry, "rad_reader", IMAGES_READ);
    ({ actor: reader } = await mkUser(db, "reader.one", ["rad_reader"]));
    ({ actor: nobody } = await mkUser(db, "no.body", ["nobody"]));
  });
  afterEach(() => { fx.unregister(); });

  const publishPacs = async (body: unknown) => {
    const { definitionId } = await withTx(db, (tx) => draftDefinition(tx, fx.radiologist, { kind: "pacs_settings", body }));
    await db.update(imagingDefinitions).set({ status: "active", publishedBy: "t", publishedAt: NOW })
      .where(eq(imagingDefinitions.id, definitionId));
  };
  const acquired = async (imageSource: "pacs" | "no_pacs_images") => {
    seq += 1;
    const study = await acquireStudy(db, fx, { serviceCode: "XR-CHEST", deviceKey: "xray", idemKey: `v${String(seq)}`, now: NOW, slot: new Date(SLOT.getTime() + seq * 60_000), dose: true });
    // `acquireStudy` records `no_pacs_images` (M1's portable). A PACS acquisition is the T2 write
    // — source `pacs` and the minted UID — applied to the row directly, so this suite measures the
    // door and not acquisition.
    if (imageSource === "pacs") {
      await db.update(imagingStudies).set({ imageSource: "pacs", studyInstanceUid: mintStudyInstanceUid(study.studyId) })
        .where(eq(imagingStudies.id, study.studyId));
    }
    return study;
  };

  it("renders the template with URL-encoded values and nothing else", () => {
    expect(renderViewerUrl(TEMPLATE, { accessionNo: "X 26/1", studyInstanceUid: "2.25.7" }))
      .toBe("https://pacs.example.org/ohif/viewer?AccessionNumber=X%2026%2F1&StudyInstanceUIDs=2.25.7");
  });

  it("a `pacs` study with an enabled viewer: the URL, ONE view row, ONE event, ONE PHI row — and the study view lists it", async () => {
    await publishPacs({ viewer_url_template: TEMPLATE, enabled: true });
    const study = await acquired("pacs");
    const out = await withTx(db, (tx) => openImages(tx, reader, { studyId: study.studyId, now: NOW }));
    expect(out.url).toBe(`https://pacs.example.org/ohif/viewer?AccessionNumber=${study.accessionNo}&StudyInstanceUIDs=${mintStudyInstanceUid(study.studyId)}`);
    const views = await db.select().from(imagingImageViews);
    expect(views).toHaveLength(1);
    expect([views[0]!.studyId, views[0]!.viewerId, views[0]!.via, views[0]!.urlHost])
      .toEqual([study.studyId, reader.id, "external_pacs", "pacs.example.org"]);
    const evs = await db.select().from(events).where(eq(events.name, "imaging.image_viewed"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({ studyId: study.studyId, viewerId: reader.id, via: "external_pacs" });
    const phi = await db.select().from(phiAccessLog).where(eq(phiAccessLog.actorId, reader.id));
    expect(phi.map((r) => r.surface)).toEqual(["imaging.study"]);

    const registry = new ModuleRegistry();
    registry.install({ key: "r2", title: "R", menu: [], permissions: ["radiology.worklist.read"], subscriptions: [] });
    await syncPermissions(db, registry);
    await grantPermissionToRole(db, registry, "rad_reader", "radiology.worklist.read");
    const view = await studyView(db, reader, study.studyId);
    expect(view!.views.map((v) => v.viewerId)).toEqual([reader.id]);
  });

  it("refuses `no_images` for a study recorded without DICOM, and leaves NO row behind", async () => {
    await publishPacs({ viewer_url_template: TEMPLATE, enabled: true });
    const study = await acquired("no_pacs_images");
    await expect(withTx(db, (tx) => openImages(tx, reader, { studyId: study.studyId })))
      .rejects.toMatchObject({ code: "no_images" });
    expect(await db.select().from(imagingImageViews)).toHaveLength(0);
    expect(await db.select().from(events).where(eq(events.name, "imaging.image_viewed"))).toHaveLength(0);
  });

  it("refuses `pacs_not_configured` with no active book, and again when the book is published but disabled", async () => {
    const study = await acquired("pacs");
    await expect(withTx(db, (tx) => openImages(tx, reader, { studyId: study.studyId })))
      .rejects.toMatchObject({ code: "pacs_not_configured", detail: { published: false } });
    await publishPacs({ viewer_url_template: TEMPLATE, enabled: false });
    await expect(withTx(db, (tx) => openImages(tx, reader, { studyId: study.studyId })))
      .rejects.toMatchObject({ code: "pacs_not_configured", detail: { published: true } });
    expect(await db.select().from(imagingImageViews)).toHaveLength(0);
  });

  it("refuses a reader without the permission, before touching anything", async () => {
    await publishPacs({ viewer_url_template: TEMPLATE, enabled: true });
    const study = await acquired("pacs");
    await expect(withTx(db, (tx) => openImages(tx, nobody, { studyId: study.studyId })))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(await db.select().from(imagingImageViews)).toHaveLength(0);
  });

  it("D5 — the book refuses http://, an unknown placeholder and a template with no placeholder", () => {
    expect(() => parseDefinitionBody("pacs_settings", { viewer_url_template: "http://pacs/v?acc={accessionNo}", enabled: true }))
      .toThrow(/https/);
    expect(() => parseDefinitionBody("pacs_settings", { viewer_url_template: "https://pacs/v?p={patientName}", enabled: true }))
      .toThrow(/placeholder|nothing else/);
    expect(() => parseDefinitionBody("pacs_settings", { viewer_url_template: "https://pacs/viewer", enabled: true }))
      .toThrow(/at least one/);
    expect(parseDefinitionBody("pacs_settings", { viewer_url_template: TEMPLATE, enabled: true }).enabled).toBe(true);
  });
});
