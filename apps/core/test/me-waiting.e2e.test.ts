import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { WAITING_KINDS, newId, waitingLines } from "@hmis/contracts";
import type { WireWaiting } from "@hmis/contracts";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser, testCfg } from "./helpers/opd";
import { acquireStudy, setupRadiologyFixture } from "./helpers/radiology";
import { createSession } from "../src/kernel/auth/sessions";
import { grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { collectDeskProviders } from "../src/kernel/desk/registry";
import { loadWaiting } from "../src/kernel/desk/waiting";
import { requireEnv } from "../src/kernel/config";
import { withTx } from "../src/kernel/db/client";
import { alerts, labReports, orders, userReminders } from "../src/kernel/db/schema";
import { draftReport, publishReport, signReport } from "../src/modules/radiology/reports";
import { stampFirstRead } from "../src/modules/radiology/closed-loop";
import type { RadiologyFixture } from "./helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * E1.4 / E1.5 (decision 0064) — `GET /me/waiting`, OVER REAL HTTP, against the spec's done-means
 * (/opt/hmis-context/SPEC-morning-card-2026-10-11.md):
 *
 *   1. a doctor with 2 returned lab reports and 1 unread imaging report gets exactly those 3;
 *   3. the list the clients draw (`waitingLines`) is the answer, in the fixed order;
 *   4. the answer carries no patient name, UHID or patient id;
 *   5. no kind is money, so a doctor is never handed one.
 *
 * The radiology study runs on the closed-loop suite's fixed instants (the code under test reads no
 * clock for "unread"); the lab reports are placed relative to the REAL clock, because the route
 * reads it for the 24-hour "back" window.
 */
describe("GET /me/waiting — open loops and the morning card (E1.4, E1.5)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let doctorToken: string;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const FRESH = new Date(NOW.getTime() - 60_000);
  let seq = 0;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    await syncPermissions(db, registry);
    for (const p of ["lab.results.read", "radiology.reports.read"]) await grantPermissionToRole(db, registry, "doctor", p);
    for (const p of ["radiology.reports.read", "radiology.reports.write", "radiology.worklist.read"]) {
      await grantPermissionToRole(db, registry, "radiologist", p);
    }
    ({ token: doctorToken } = await createSession(db, testCfg, fx.doctor.id));
  });
  afterEach(() => { fx.unregister(); });

  const get = (token: string) =>
    request(app.getHttpServer()).get("/me/waiting").set("Authorization", `Bearer ${token}`);

  /** A released imaging report on a study whose ordering clinician is `treating`. */
  const releasedStudy = async (treating: string = fx.doctor.id) => {
    seq += 1;
    const study = await acquireStudy(db, fx, {
      idemKey: `mw${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });
    await db.update(orders).set({ orderingClinicianId: treating }).where(eq(orders.id, study.orderId));
    const draft = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: study.studyId, body: { findings: "Liver normal in size." }, impression: "Normal abdomen.",
    }));
    const { reportId } = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: study.studyId, reportId: draft.reportId, secondFactorAt: FRESH, now: NOW,
    }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: study.studyId, now: NOW }));
    return { ...study, reportId };
  };

  /** A published lab report on its own order, `hoursAgo` before the real clock. */
  const labReport = async (hoursAgo: number, clinician: string = fx.doctor.id, status = "published") => {
    seq += 1;
    const at = new Date(Date.now() - hoursAgo * 3_600_000);
    const orderId = newId();
    await db.insert(orders).values({
      id: orderId, orderNo: `L2608319${String(seq).padStart(3, "0")}`, orderGroupId: newId(), kind: "lab",
      patientId: fx.patientId, encounterNo: fx.visitNo, serviceDate: DAY, priority: "routine",
      authority: "clinician", orderedByType: "user", orderedById: clinician, orderingClinicianId: clinician, placedAt: at,
    });
    await db.insert(labReports).values({
      id: newId(), orderId, version: 1, status, snapshot: {}, signedBy: fx.radiologist.id, signedAt: at, publishedAt: at,
    });
    return orderId;
  };

  const waitingOf = (actor: Actor, now = new Date()) =>
    loadWaiting(collectDeskProviders(registry), { db, actor, reader: actor, date: DAY, now });

  it("done-means 1+3: a doctor with 2 reports back and 1 unread study gets exactly those 3, as two lines", async () => {
    await labReport(1);
    await labReport(5);
    await releasedStudy();

    const res = await get(doctorToken).expect(200);
    const body = res.body as WireWaiting;
    expect(body.items.map((i) => [i.kind, i.count])).toEqual([["lab.reportsBack", 2], ["radiology.unreadMine", 1]]);
    expect(body.items.reduce((n, i) => n + i.count, 0)).toBe(3);
    // Every line carries the web screen it opens.
    expect(body.items.map((i) => i.href)).toEqual(["/opd/consult", "/opd/consult"]);
    // The clients draw exactly this, in this order.
    expect(waitingLines(body).map((l) => [l.kind, l.count])).toEqual([["lab.reportsBack", 2], ["radiology.unreadMine", 1]]);
  });

  it("done-means 4: the answer names no patient — no name, no UHID, no patient id, no report id", async () => {
    await labReport(1);
    const s = await releasedStudy();
    const raw = JSON.stringify((await get(doctorToken).expect(200)).body);
    for (const leak of ["Asha Devi", "HMS-00000001-5", fx.patientId, s.reportId, s.studyId, s.accessionNo]) {
      expect(raw).not.toContain(leak);
    }
  });

  it("done-means 5: no kind is money, and a doctor's answer never carries one", async () => {
    expect(WAITING_KINDS.filter((k) => /billing|payment|paise|dues|collect|cash|invoice|refund|money/i.test(k))).toEqual([]);
    await labReport(1);
    const body = (await get(doctorToken).expect(200)).body as WireWaiting;
    expect(body.items.every((i) => (WAITING_KINDS as readonly string[]).includes(i.kind))).toBe(true);
  });

  it("closes the loop: an opened study, an old or superseded report, and another doctor's orders do not count", async () => {
    await labReport(30); // older than a day
    await labReport(2, fx.doctor.id, "superseded");
    await labReport(1, fx.radiologist.id); // somebody else's order
    const s = await releasedStudy();
    expect((await waitingOf(fx.doctor)).items.map((i) => i.kind)).toEqual(["radiology.unreadMine"]);

    await stampFirstRead(db, s.reportId, fx.doctor.id, new Date());
    expect((await waitingOf(fx.doctor)).items).toEqual([]);
  });

  it("a doctor who treats nobody here gets nothing; a person holding no permission gets an empty list, not a refusal", async () => {
    await labReport(1);
    await releasedStudy();
    const other = await mkUser(db, "dr.other", ["doctor"]);
    expect((await get(other.token).expect(200)).body).toEqual({ items: [] });
    const stranger = await mkUser(db, "stranger", []);
    expect((await get(stranger.token).expect(200)).body).toEqual({ items: [] });
  });

  it("the reading room sees studies past their clock; the doctor's lines are not theirs", async () => {
    // Images in at the fixed past instant: the OPD 24-hour clock ran out long ago.
    await acquireStudy(db, fx, { idemKey: "rr1", now: NOW, slot: SLOT });
    const items = (await waitingOf(fx.radiologist)).items;
    expect(items.map((i) => [i.kind, i.count])).toEqual([["radiology.readsOverdue", 1]]);
    // …and not yet, the moment the images arrived.
    expect((await waitingOf(fx.radiologist, new Date(NOW.getTime() + 60_000))).items).toEqual([]);
  });

  it("everyone's own: bell rows not answered (reminders aside) and reminders still to fire today", async () => {
    const now = new Date();
    const alert = (kind: string, ackKind: string | null) => db.insert(alerts).values({
      id: newId(), userId: fx.doctor.id, kind, title: "t", sourceEventId: newId(), createdAt: now, ackKind, acknowledgedAt: ackKind === null ? null : now,
    });
    await alert("lab.critical_overdue", null);
    await alert("lab.critical_overdue", "seen");
    await alert("personal_reminder", null);
    await db.insert(userReminders).values({
      id: newId(), userId: fx.doctor.id, text: "ward round", dueAt: new Date(now.getTime() - 60_000), repeat: "none",
    });
    const items = (await waitingOf(fx.doctor, now)).items;
    expect(items.map((i) => [i.kind, i.count])).toEqual([["alerts.unanswered", 1], ["reminders.today", 1]]);
  });
});
