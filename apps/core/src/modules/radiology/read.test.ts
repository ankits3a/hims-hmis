import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  acquireStudy, placeAndCreateStudy, setupRadiologyFixture, studyTypeRow,
} from "../../../test/helpers/radiology";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { imagingDefinitions, orderItems, orders, patients, phiAccessLog } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { draftReport, signReport } from "./reports";
import { reportView, studyView, worklist } from "./read";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { StudyType } from "./definitions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T8 — Assertion Book row **A8**, and it is about TWO rules that look like one.
 *
 * ═══ RESTRICTED IS A HOLD-OUT; CONFIDENTIAL IS A RENAME ═══
 *
 * A8's mutant conflates them — *"show restricted rows with the alias"* — and the reason it is the
 * natural mistake is that one filter and one rendering feels tidier than two. It is a disclosure:
 * the ROW says a named ward has an obstetric ultrasound booked at 14:30, and an alias on top of it
 * hides nothing that matters. Phase 0's T5 A1 draws the same line one door over.
 */
describe("the radiology reads, and the two confidentiality rules (18a T8 A8)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let tech: Actor;
  let reader: Actor;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const FRESH = new Date(NOW.getTime() - 60_000);

  const RAD_PERMS = [
    "radiology.worklist.read", "radiology.reports.read",
    "orders.read.restricted", "patients.confidential.read",
  ];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;

    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: RAD_PERMS, subscriptions: [] });
    await syncPermissions(db, registry);
    for (const role of ["rad_tech", "rad_reader"]) await ensureRole(db, role);

    /** THE TECHNOLOGIST — reads the worklist, and holds NEITHER clearance. */
    for (const p of ["radiology.worklist.read", "radiology.reports.read"]) {
      await grantPermissionToRole(db, registry, "rad_tech", p);
    }
    /** THE READER — the radiologist who is a registered person: both clearances. */
    for (const p of RAD_PERMS) await grantPermissionToRole(db, registry, "rad_reader", p);

    ({ actor: tech } = await mkUser(db, "tech.one", ["rad_tech"]));
    ({ actor: reader } = await mkUser(db, "rad.one", ["rad_reader"]));
  });
  afterEach(() => { fx.unregister(); });

  let seq = 0;
  const rewriteBook = async (types: StudyType[]) => {
    await db.update(imagingDefinitions).set({ body: { types } })
      .where(eq(imagingDefinitions.kind, "study_types"));
  };
  const bookRow = (code: string, over: Partial<StudyType>) =>
    studyTypeRow({ code, service_id: fx.services[code]!, ...over });

  const place = async (code = "USG-ABDO") => {
    seq += 1;
    return await placeAndCreateStudy(db, fx, code, `w${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000));
  };
  const confidential = () => db.update(patients)
    .set({ isConfidential: true, alias: "Priya M." }).where(eq(patients.id, fx.patientId));

  /* ═══════════════════════ A8 — THE TWO RULES ═══════════════════════ */

  /**
   * A8's central row. The obstetric USG is `restricted` (the PCPNDT rule set it at placement), so it
   * is HELD OUT of the technologist's list entirely — not shown under an alias.
   */
  it("A8: a RESTRICTED study is omitted from the list of a reader without the clearance", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", pcpndt_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const obstetric = await place("USG-ABDO");
    const plain = await place("XR-CHEST");

    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, obstetric.itemId));
    expect(item!.restricted).toBe(true);

    const techList = await worklist(db, tech, { view: "all" });
    expect(techList.map((r) => r.studyId)).toEqual([plain.studyId]);

    /** …and the radiologist sees BOTH on the same list. */
    const readerList = await worklist(db, reader, { view: "all" });
    expect(readerList.map((r) => r.studyId).sort()).toEqual([obstetric.studyId, plain.studyId].sort());
  });

  /**
   * The other half of the rule, and the one that keeps the hold-out from being a blanket ban: the
   * ORDERING CLINICIAN sees their own restricted order even without the clearance. The kernel's
   * `visibleItems` says so and this is the same rule projected onto a department's day.
   */
  it("A8: the ORDERING CLINICIAN sees their own restricted study without holding the clearance", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", pcpndt_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const obstetric = await place("USG-ABDO");
    /**
     * The shared fixture places under a LITERAL `orderingClinicianId` ("dr-consultant"), so the
     * order is named to nobody in particular. This assertion is about the clinician who ordered it,
     * so the row is pointed at a real user first — otherwise the test would be asserting that a
     * string nobody holds is not a match, which is true and worthless.
     */
    await db.update(orders).set({ orderingClinicianId: fx.doctor.id })
      .where(eq(orders.id, obstetric.orderId));

    /** Give the ordering doctor the worklist permission and NEITHER clearance. */
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: RAD_PERMS, subscriptions: [] });
    await grantPermissionToRole(db, registry, "doctor", "radiology.worklist.read");

    const own = await worklist(db, fx.doctor, { view: "all" });
    expect(own.map((r) => r.studyId)).toContain(obstetric.studyId);
  });

  /**
   * CONFIDENTIAL is the other rule and it behaves differently: the row IS shown, under the alias.
   * A8's mutant would have shown the restricted row this way too.
   */
  it("A8: a CONFIDENTIAL patient's row shows the ALIAS to a reader without the clearance, and the name to one with it", async () => {
    await confidential();
    const study = await place("XR-CHEST");

    const techList = await worklist(db, tech, { view: "all" });
    expect(techList.map((r) => [r.studyId, r.patientName])).toEqual([[study.studyId, "Priya M."]]);

    const readerList = await worklist(db, reader, { view: "all" });
    expect(readerList.map((r) => r.patientName)).toEqual(["Asha Devi"]);
  });

  /** The two rules compose: a restricted row is held out even from somebody who could see the name. */
  it("A8: holding `patients.confidential.read` does NOT unlock a restricted row", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", pcpndt_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    await confidential();
    const obstetric = await place("USG-ABDO");

    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: RAD_PERMS, subscriptions: [] });
    await grantPermissionToRole(db, registry, "rad_tech", "patients.confidential.read");

    const list = await worklist(db, tech, { view: "all" });
    expect(list.map((r) => r.studyId)).not.toContain(obstetric.studyId);
  });

  /* ═══════════════════════ the views, and the PHI log ═══════════════════════ */

  it("the three views are three PHI surfaces, and every accepted read writes one", async () => {
    const study = await acquireStudy(db, fx, { idemKey: "v1", now: NOW, slot: SLOT });
    const { reportId } = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: study.studyId, body: { findings: "Normal." }, impression: "Normal.",
    }));
    const signed = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: study.studyId, reportId, secondFactorAt: FRESH, now: NOW,
    }));

    await worklist(db, reader, { view: "all" });
    await studyView(db, reader, study.studyId);
    await reportView(db, reader, signed.reportId);

    const surfaces = (await db.select().from(phiAccessLog)).map((r) => r.surface).sort();
    expect(surfaces).toEqual(["imaging.report", "imaging.study", "imaging.worklist"]);
  });

  it("`studyView` and `reportView` HOLD OUT a restricted study entirely — the same answer as unknown", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", pcpndt_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const obstetric = await place("USG-ABDO");
    expect(await studyView(db, tech, obstetric.studyId)).toBeNull();
    expect(await studyView(db, reader, obstetric.studyId)).not.toBeNull();
  });

  it("the `unread` view is the radiologist's list and the `floor` view is the technologist's", async () => {
    const acquired = await acquireStudy(db, fx, { idemKey: "u1", now: NOW, slot: SLOT });
    const scheduled = await place("XR-CHEST");

    expect((await worklist(db, reader, { view: "unread" })).map((r) => r.studyId)).toEqual([acquired.studyId]);
    expect((await worklist(db, reader, { view: "floor" })).map((r) => r.studyId)).toEqual([scheduled.studyId]);
  });

  it("refuses a reader without `radiology.worklist.read`, and a non-user actor outright", async () => {
    const { actor: nobody } = await mkUser(db, "nobody.one", []);
    await expect(worklist(db, nobody, {})).rejects.toMatchObject({ code: "unknown_study" });
    await expect(worklist(db, { type: "system", id: "worker" }, {}))
      .rejects.toMatchObject({ code: "unknown_study" });
  });

  it("`reportView` needs `radiology.reports.read`, which the treating doctor holds and the worklist is separate from", async () => {
    const study = await acquireStudy(db, fx, { idemKey: "rv1", now: NOW, slot: SLOT });
    const { reportId } = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: study.studyId, body: { findings: "Normal." },
    }));
    const signed = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: study.studyId, reportId, secondFactorAt: FRESH, now: NOW,
    }));
    const view = await reportView(db, reader, signed.reportId);
    expect([view?.status, view?.version, view?.accessionNo])
      .toEqual(["signed", signed.version, study.accessionNo]);
  });
});
