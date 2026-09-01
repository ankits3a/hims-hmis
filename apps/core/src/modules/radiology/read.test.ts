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
import { listOrdersForPatient } from "../../kernel/orders/read";
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
   * ═══ F45 (CLOSE REVIEW, OWNER RULING) — THIS TEST PROVED THE DESIGN WITH A ROLE THAT DOES NOT EXIST ═══
   *
   * It asserted that the obstetric USG is held out of the technologist's list and visible to
   * `rad_reader` — a role this suite INVENTS and grants `orders.read.restricted`. **No seeded role
   * holds that permission**: `seed-roles.ts` parks it in `NOT_YET_MODELLED` as a Class-A grant for
   * the owner, and its reason names *"the PCPNDT-class USG"* in as many words. So in a real
   * hospital there is no `rad_reader`, every one of the three seeded radiology roles is a
   * `rad_tech`, and this assertion described a department that could not see — and therefore could
   * not schedule, check in, gate, acquire or report — any of the three study types the Act covers.
   * The reception screen renders `rows ?? []`, so the desk saw an empty list and no error.
   *
   * **The ruling: `radiology.worklist.read` IS the departmental clearance.** The department that
   * performs the scan sees its own work. What still holds the row out is the KERNEL's
   * `listOrdersForPatient` — a WARD's pending list, a different reader on a different route, which
   * DD11's argument was actually about and which is untouched.
   *
   * `restricted` is still returned on every row, as a LABEL the screen badges.
   */
  it("F45: the DEPARTMENT sees its own restricted study, and the row still says it is restricted", async () => {
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

    /** The technologist holds NEITHER clearance, and is the department. She sees both. */
    const techList = await worklist(db, tech, { view: "all" });
    expect(techList.map((r) => r.studyId).sort()).toEqual([obstetric.studyId, plain.studyId].sort());
    expect(techList.find((r) => r.studyId === obstetric.studyId)?.restricted).toBe(true);
    expect(techList.find((r) => r.studyId === plain.studyId)?.restricted).toBe(false);

    /** And so does a reader who holds both clearances — the answer no longer depends on them. */
    const readerList = await worklist(db, reader, { view: "all" });
    expect(readerList.map((r) => r.studyId).sort()).toEqual([obstetric.studyId, plain.studyId].sort());

    /** THE SURFACE THAT STILL HOLDS IT OUT: the kernel's own order reader, for a ward. */
    const wardView = await listOrdersForPatient(db, tech, fx.patientId);
    const wardItems = wardView.orders.flatMap((o) => o.items.map((i) => i.id));
    expect(wardItems).toContain(plain.itemId);
    expect(wardItems).not.toContain(obstetric.itemId);
  });

  /**
   * F45 — the ordering-clinician leg was the hold-out's escape hatch and it was UNREACHABLE: the
   * seeded `doctor` role does not hold `radiology.worklist.read`, so the permission check threw
   * before the exemption could apply. It is kept as a test because a clinician granted the worklist
   * permission is a configuration a hospital may choose, and the answer must still be yes.
   */
  it("F45: the ordering clinician granted the worklist permission sees the study", async () => {
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

  /**
   * F45 — the two rules no longer COMPOSE on this surface, and that is the ruling rather than a
   * regression: `restricted` is a label here and `confidential` is still a rename. What this now
   * pins is that the confidentiality clearance changes the NAME and nothing else.
   */
  it("F45: `patients.confidential.read` changes the name and not the membership of the list", async () => {
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
    expect(list.map((r) => r.studyId)).toContain(obstetric.studyId);
    /** The clearance was granted above, so the real name shows; the row was never in question. */
    expect(list.map((r) => r.patientName)).toEqual(["Asha Devi"]);
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

  /**
   * F45 — `studyView` returning `null` for a restricted study is what printed "unknown study" on
   * the console for every obstetric scan, while the readiness route underneath rendered the whole
   * gate list with working buttons. Both readers now answer for the department.
   */
  it("F45: `studyView` opens a restricted study for the department", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", pcpndt_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const obstetric = await place("USG-ABDO");
    const asTech = await studyView(db, tech, obstetric.studyId);
    expect(asTech).not.toBeNull();
    expect([asTech?.restricted, asTech?.formFRequired]).toEqual([true, true]);
    expect(await studyView(db, reader, obstetric.studyId)).not.toBeNull();
    /** An id that names nothing is still `null` — the hold-out is gone, the not-found is not. */
    expect(await studyView(db, tech, "01NOSUCHSTUDY000000000001")).toBeNull();
  });

  it("the `unread` view is the radiologist's list and the `floor` view is the technologist's", async () => {
    const acquired = await acquireStudy(db, fx, { idemKey: "u1", now: NOW, slot: SLOT });
    const scheduled = await place("XR-CHEST");

    expect((await worklist(db, reader, { view: "unread" })).map((r) => r.studyId)).toEqual([acquired.studyId]);
    expect((await worklist(db, reader, { view: "floor" })).map((r) => r.studyId)).toEqual([scheduled.studyId]);
  });

  it("refuses a reader without `radiology.worklist.read`, and a non-user actor outright", async () => {
    /**
     * F41 — these were `unknown_study` (**404**): an authorisation refusal answering not-found. It
     * escaped notice only because the controller guard returns 403 first, so an internal caller saw
     * the wrong answer and any route added later would have shipped it. `forbidden` is 403.
     *
     * The RESTRICTED hold-out deliberately did NOT move with them: a row a reader may not see still
     * answers exactly as a row that does not exist, because a distinguishable refusal there would
     * rebuild the oracle the hold-out removes.
     */
    const { actor: nobody } = await mkUser(db, "nobody.one", []);
    await expect(worklist(db, nobody, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(worklist(db, { type: "system", id: "worker" }, {}))
      .rejects.toMatchObject({ code: "forbidden" });
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
