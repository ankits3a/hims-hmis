import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { withTx } from "../src/kernel/db/client";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import {
  assignRole, createRole, grantPermissionToRole, syncPermissions,
} from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { buildSubscriptionBus } from "../src/kernel/worker/jobs";
import { workerConsumers } from "../src/kernel/worker/worker.module";
import { runDispatchCycle } from "../src/kernel/events/dispatcher";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { registerEncounterResolver } from "../src/kernel/episodes/encounter-resolvers";
import {
  activateDefinition, approveDefinition, createDraft,
} from "../src/kernel/workflow/definitions";
import { createResource } from "../src/kernel/resources/registry";
import { aerbManifest, fileLicence } from "../src/modules/aerb";
import { recordSecondFactor } from "../src/kernel/auth/totp";
import {
  events, imagingDefinitions, imagingStudies, opdEncounters, orderItems, orders, patients,
  phiAccessLog, registrationConfig, resources, services as servicesTable,
} from "../src/kernel/db/schema";
import {
  RADIOLOGY_RESOURCE_KINDS, RADIOLOGY_WORKFLOW_DEFINITIONS,
} from "../src/modules/radiology";
import { collectOrderKinds } from "../src/kernel/orders/kinds";
import { studyTypeRow } from "./helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 18a T9 — **THE WHOLE DEPARTMENT, THROUGH THE REAL MANIFEST, OVER HTTP.**
 *
 * ═══ WHAT THIS PROVES THAT EIGHT GREEN UNIT SUITES DO NOT ═══
 *
 * Every task from T3 on has its own tests, and every one of them calls a FUNCTION. This file calls
 * ROUTES: the zod schemas, the `@RequirePermission` guards, the param binding, the error mapper,
 * and — the point of the exercise — `collectOrderKinds(registry)` resolving `imaging` off the
 * manifest that is actually installed in `ALL_MANIFESTS` rather than off a decl a fixture handed
 * in. Plan 13's own e2e header states the general form: *"every one of those is a way a green unit
 * suite can sit behind a broken endpoint."*
 *
 * ═══ TWO STUDIES, AND THE SECOND ONE IS THE ACT ═══
 *
 *   1. **A CT abdomen with contrast on a woman of 30.** Placed → study created with an `X`
 *      accession → scheduled → checked in (five gates open) → every gate cleared → ready →
 *      started (the device goes `in_use`) → acquired with a dose and contrast → the device is
 *      `available` again → drafted → signed under a FRESH second factor → published → the envelope
 *      item `completed`.
 *   2. **An obstetric ultrasound on the same patient.** `restricted` at placement, a `form_f` gate
 *      at check-in, and **`recordAcquired` REFUSED until the Form F is recorded** — the statutory
 *      control, end to end, through the routes a console calls.
 */
describe("radiology, end to end, through the real manifest (18a T9)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  let unregister: () => void;

  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! } as NodeJS.ProcessEnv);
  const SEED: Actor = { type: "user", id: "seed-admin" };
  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const PATIENT = "01PATIENT0000000000000001";
  const VISIT = "V2608310001";

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 120_000);

  afterAll(async () => { unregister?.(); await app.close(); await teardown(); });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];

  /** A user with exactly these permissions and a live session token. */
  async function staff(permissions: string[], label: string): Promise<{ id: string; token: string; sessionId: string }> {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const suffix = `${label}${Math.random().toString(36).slice(2, 7)}`;
    const { id } = await createUser(db, { username: suffix, fullName: label, password: "correct horse battery" });
    const roleKey = `role_${suffix}`;
    await createRole(db, roleKey, label);
    for (const p of permissions) await grantPermissionToRole(db, registry, roleKey, p);
    await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    const { token, sessionId } = await createSession(db, cfg, id);
    return { id, token, sessionId };
  }

  let doctor: { id: string; token: string; sessionId: string };
  let radiographer: { id: string; token: string; sessionId: string };
  let radiologist: { id: string; token: string; sessionId: string };
  let counter: { id: string; token: string; sessionId: string };
  /** 18b T1 — the machine account on the PACS host that pulls the modality worklist. */
  let bridge: { id: string; token: string; sessionId: string };
  let services: Record<string, string>;
  let devices: Record<string, string>;
  /** PLAN 18c — the Radiological Safety Officer: the AERB registers' only writer. */
  let rso: { id: string; token: string; sessionId: string };

  beforeEach(async () => {
    await truncateAll(db);

    await db.insert(registrationConfig)
      .values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female",
      administrativeGender: "female", dob: new Date(Date.UTC(1996, 0, 1)),
      createdBy: "t", updatedBy: "t",
    });
    await db.insert(opdEncounters).values({
      id: "01ENC00000000000000000001", visitNo: VISIT, patientId: PATIENT, status: "registered",
      workflowInstanceId: "01WFI00000000000000000001", serviceDate: DAY, visitType: "new",
      openedBy: "t", updatedBy: "t",
    });
    unregister?.();
    unregister = registerEncounterResolver("V", async () => ({ patientId: PATIENT, intendedPayer: "self" }));

    const specs = [["CT-ABDO-CONTRAST", "ct"], ["USG-OBS-ANOMALY", "usg"]] as const;
    services = {};
    for (const [code] of specs) {
      const id = `01SVC${code.replace(/[^A-Z]/g, "").slice(0, 18).padEnd(20, "0")}`;
      services[code] = id;
      await db.insert(servicesTable).values({
        id, code: `RAD-${code}`, name: `Imaging ${code}`, category: "investigation",
        createdBy: "t", updatedBy: "t",
      });
    }

    /** The governed book, published — the department is inert until it exists (T4). */
    await db.insert(imagingDefinitions).values({
      id: "01DEF00000000000000000001", kind: "study_types", version: 1, status: "active",
      draftedBy: "e2e", publishedBy: "e2e", publishedAt: NOW,
      body: {
        types: [
          studyTypeRow({
            code: "CT-ABDO-CONTRAST", service_id: services["CT-ABDO-CONTRAST"]!, modality: "ct",
            body_part: "abdomen", ionising: true, contrast_option: "required",
          }),
          studyTypeRow({
            code: "USG-OBS-ANOMALY", service_id: services["USG-OBS-ANOMALY"]!, modality: "usg",
            body_part: "obstetric", pcpndt_applicable: true, chaperone_required: true,
          }),
        ],
      },
    });

    // 18b T3 / D5 — the viewer is a published book, not an environment variable.
    await db.insert(imagingDefinitions).values({
      id: "01DEF00000000000000000002", kind: "pacs_settings", version: 1, status: "active",
      draftedBy: "e2e", publishedBy: "e2e", publishedAt: NOW,
      body: { viewer_url_template: "https://pacs.example.org/viewer?AccessionNumber={accessionNo}", enabled: true },
    });
    doctor = await staff(["orders.place", "radiology.orders.place", "radiology.reports.read"], "doc");
    radiographer = await staff([
      "radiology.schedule", "radiology.checkin", "radiology.gates.satisfy", "radiology.acquire",
      "radiology.worklist.read", "pcpndt.form_f.write", "pcpndt.form_f.read",
      "pcpndt.registrations.manage", "orders.read.restricted",
    ], "rt");
    radiologist = await staff([
      "radiology.gates.override", "radiology.reports.write", "radiology.reports.sign",
      "radiology.reports.amend", "radiology.reports.read", "radiology.worklist.read",
      "orders.read.restricted",
    ], "rad");
    counter = await staff(["radiology.bill_decisions.manage"], "csh");
    bridge = await staff(["radiology.mwl.read"], "mwl");

    /** The two Class-A workflow definitions, activated the way the go-live runbook does it. */
    await seedSodPairs(db);
    const owner = await staff([], "own");
    const ms = await staff([], "ms");
    await createRole(db, "owner", "Owner");
    await createRole(db, "medical_superintendent", "MS");
    await assignRole(db, { userId: owner.id, roleKey: "owner", scopeType: "hospital" });
    await assignRole(db, { userId: ms.id, roleKey: "medical_superintendent", scopeType: "hospital" });
    const ownerActor: Actor = { type: "user", id: owner.id };
    for (const definition of RADIOLOGY_WORKFLOW_DEFINITIONS) {
      const draft = await createDraft(db, SEED, definition);
      await approveDefinition(db, ownerActor, { definitionId: draft.definitionId, roleKey: "owner", note: "e2e" });
      await approveDefinition(db, { type: "user", id: ms.id }, {
        definitionId: draft.definitionId, roleKey: "medical_superintendent", note: "e2e",
      });
      await activateDefinition(db, ownerActor, draft.definitionId);
    }
    /** The radiographer performs the scans, so they hold the transition roles too. */
    await createRole(db, "radiographer", "Radiographer");
    await createRole(db, "radiologist", "Radiologist");
    await assignRole(db, { userId: radiographer.id, roleKey: "radiographer", scopeType: "hospital" });
    await assignRole(db, { userId: radiologist.id, roleKey: "radiologist", scopeType: "hospital" });

    devices = {};
    for (const modality of ["ct", "usg"]) {
      const { resourceId } = await withTx(db, (tx) => createResource(tx, ownerActor, RADIOLOGY_RESOURCE_KINDS, {
        kind: "device", code: `DEV-${modality.toUpperCase()}`, name: `${modality} machine`,
        // 18b T1 — an AE title is what puts a device on the modality worklist export (D2).
        attributes: { modality, aeTitle: `${modality.toUpperCase()}1` },
      }));
      devices[modality] = resourceId;
    }

    /**
     * ═══ PLAN 18c T1 / D3 — THE CT'S AERB LICENCE, AND THE WALK NEEDS IT ═══
     *
     * STUDY ONE is an ionising examination, so from this phase forward it cannot be acquired — nor
     * even offered on the modality worklist — on a machine with no active AERB licence. Filing one
     * here is not a workaround: it is what the walk is now supposed to prove, and a hospital
     * running a CT without this row is a hospital that must be stopped. The ultrasound gets none,
     * because AERB licences no ultrasound machine and STUDY TWO must pass without one.
     */
    rso = await staff([...aerbManifest.permissions], "rso");
    await withTx(db, (tx) => fileLicence(tx, { type: "user", id: rso.id }, {
      deviceResourceId: devices.ct!, licenceType: "licence", licenceNo: "AERB/CT/2026/E2E",
      eloraRef: "ELORA-E2E", validFrom: "2020-01-01", validTo: "2099-12-31",
      rsoUserId: rso.id,
    }));
  }, 120_000);

  /**
   * ═══ THE CONSUMER RUNS IN THE WORKER, AND THIS FILE IS THE API ═══
   *
   * `order.placed` is APPENDED by the placement route and DISPATCHED by the worker process, so an
   * HTTP-only e2e sees the order and never the study. Driving one dispatch cycle here is what makes
   * the chain end-to-end rather than end-to-middle — and it drives it through
   * `buildSubscriptionBus(registry, workerConsumers(db))`, the REAL wiring, rather than by calling
   * `handleOrderPlaced` directly. A direct call would prove the handler and not the subscription,
   * and the subscription is the half that has been wrong before (§2.54's boot-error specimen).
   */
  const pump = async (): Promise<number> => {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    const bus = buildSubscriptionBus(registry, workerConsumers(db));
    return await runDispatchCycle(db, bus, { now: new Date() });
  };

  const post = (path: string, token: string, body: unknown = {}) =>
    request(server()).post(path).set("Authorization", `Bearer ${token}`).send(body as object);
  const get = (path: string, token: string) =>
    request(server()).get(path).set("Authorization", `Bearer ${token}`);

  /* ══════════════════════════════════════════════════════════════════════════════════════ */

  /**
   * 18b T5 — THIS IS THE PHASE'S FINISH LINE. One study, over HTTP, through every DICOM seam:
   * ordered → scheduled → on the worklist export (T1) → acquired with the UID the worklist offered
   * (T2) → images opened and the view recorded (T3) → drafted by the offline drafter with
   * provenance (T4) → signed by a human → published. Every row is read back below.
   */
  it("STUDY ONE — a contrast CT from order to published report, over HTTP, through the DICOM seams (18b T5)", async () => {
    /** ── PLACEMENT. The kind resolves off the REAL manifest, not off a fixture's decl. ── */
    const placed = await post("/radiology/orders", doctor.token, {
      patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY,
      orderingClinicianId: doctor.id, indication: "abdominal pain, ?abscess",
      items: [{ serviceId: services["CT-ABDO-CONTRAST"] }],
    });
    expect([placed.status, typeof placed.body.orderNo]).toEqual([201, "string"]);
    expect(await pump()).toBeGreaterThan(0);

    /** The consumer creates the study with an `X` accession, 11 characters and DICOM-safe. */
    const [study] = await db.select().from(imagingStudies).where(eq(imagingStudies.patientId, PATIENT));
    expect(study!.accessionNo).toMatch(/^X\d{10}$/);
    expect(study!.status).toBe("scheduled");

    /** ── SCHEDULE ── */
    const scheduled = await post(`/radiology/studies/${study!.id}/schedule`, radiographer.token, {
      deviceResourceId: devices.ct, scheduledAt: "2026-08-31T09:00:00.000Z",
    });
    expect(scheduled.status).toBe(201);

    /**
     * ── 18b T1 — THE MOMENT THE SLOT IS TAKEN THE STUDY IS ON THE MODALITY'S WORKLIST. ──
     * The JSON a screen reads, the dcmtk dump the bridge feeds to `dump2dcm`, and a 403 for a
     * reader without the machine permission. The UID here is the one acquisition writes (T2).
     */
    const mwl = await get(`/radiology/mwl?date=${DAY}&deviceResourceId=${devices.ct}`, bridge.token);
    expect([mwl.status, mwl.body.withheld, mwl.body.rows.length]).toEqual([200, 0, 1]);
    expect([mwl.body.rows[0].accessionNo, mwl.body.rows[0].aeTitle, mwl.body.rows[0].modality])
      .toEqual([study!.accessionNo, "CT1", "CT"]);
    const dump = await get(`/radiology/mwl?date=${DAY}&format=dump`, bridge.token);
    expect([dump.status, dump.headers["content-type"]]).toEqual([200, expect.stringMatching(/text\/plain/)]);
    expect(dump.text).toContain(`(0008,0050) SH [${study!.accessionNo}]`);
    expect(dump.text).toContain("(0040,0001) AE [CT1]");
    expect((await get(`/radiology/mwl?date=${DAY}`, doctor.token)).status).toBe(403);

    /** ── CHECK-IN: five gates open from the type's flags and the patient's own facts (T5 A1). ── */
    const checked = await post(`/radiology/studies/${study!.id}/check-in`, radiographer.token);
    expect(checked.status).toBe(201);
    expect(checked.body.gates.sort()).toEqual([
      "contrast_consent", "identity_two_factor", "pregnancy_screen", "prior_contrast_reaction",
      "renal_function",
    ]);

    /** ── THE GATES, each with the evidence its kind computes from ── */
    const satisfy = (kind: string, evidence: unknown) =>
      post(`/radiology/studies/${study!.id}/gates/${kind}/satisfy`, radiographer.token, evidence);

    expect((await satisfy("identity_two_factor", { secondIdentifier: "uhid", value: "HMS-00000001-5" })).status).toBe(201);
    expect((await satisfy("pregnancy_screen", {
      declared: true, lmpDate: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    })).status).toBe(201);
    expect((await satisfy("renal_function", {
      creatinineUmolL: 72, sampledAt: new Date().toISOString(), source: "internal",
    })).status).toBe(201);
    expect((await satisfy("prior_contrast_reaction", {})).status).toBe(201);
    const consent = await satisfy("contrast_consent", {
      procedureCode: "CT-ABDO-CONTRAST", templateVersion: "rad-contrast-v3", language: "hi",
      signer: "patient", conversionCovered: false, laterality: null,
      signedAt: new Date().toISOString(),
    });
    expect([consent.status, consent.body.study.state]).toEqual([201, "ready"]);

    /** ── ACQUISITION. `stat` so DD12a authorises without a cashier; the device goes `in_use`. ── */
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study!.id));
    /**
     * F52 — the start route no longer takes `onDate`. It used to decide whether the machine's
     * PCPNDT registration was live, from a string the CLIENT chose; the server derives its own IST
     * day now, and `startBody` is `.strict()` so a client still sending one gets a 400 rather than
     * being silently believed.
     */
    const started = await post(`/radiology/studies/${study!.id}/acquisition/start`, radiographer.token, {});
    expect([started.status, started.body.authorisedBy]).toEqual([201, "stat"]);

    const acquired = await post(`/radiology/studies/${study!.id}/acquisition/acquired`, radiographer.token, {
      imageSource: "pacs", doseCtdivol: 6.4, doseDlp: 320.5,
      contrastGiven: true, contrastAgent: "Iohexol", contrastVolumeMl: 80,
    });
    expect(acquired.status).toBe(201);

    const [afterAcq] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study!.id));
    /** 18b T2 — the UID acquisition wrote is the one the worklist offered the modality (D3). */
    expect(afterAcq!.studyInstanceUid).toBe(mwl.body.rows[0].studyInstanceUid);
    expect(acquired.body.studyInstanceUid).toBe(afterAcq!.studyInstanceUid);
    /**
     * 18b T3 — the referring doctor opens the images: the URL names the accession, a view row and
     * an `imaging.image_viewed` event exist BEFORE the URL came back, and the study view lists it.
     * The receptionist's counter role holds no `radiology.reports.read`, so the door is 403 to it.
     */
    const opened = await post(`/radiology/studies/${study!.id}/images/open`, doctor.token);
    expect([opened.status, opened.body.url]).toEqual([201, `https://pacs.example.org/viewer?AccessionNumber=${study!.accessionNo}`]);
    expect((await post(`/radiology/studies/${study!.id}/images/open`, counter.token)).status).toBe(403);
    const viewed = await get(`/radiology/studies/${study!.id}`, radiologist.token);
    expect(viewed.body.study.views.map((v: { viewerId: string }) => v.viewerId)).toEqual([doctor.id]);
    /** F18 — `ionising` is SNAPSHOTTED, which is what makes M4's dose CHECK mean anything. */
    expect([afterAcq!.status, afterAcq!.ionising, afterAcq!.contrastGiven]).toEqual(["acquired", true, true]);

    /** ── THE REPORT: drafted, then signed under a FRESH second factor (T8 A1) ── */
    /**
     * 18b T4 — the drafter proposes first: technique from the recorded facts, findings and
     * impression EMPTY, provenance on the row. The human's draft below supersedes it in the chain.
     */
    const proposed = await post(`/radiology/studies/${study!.id}/reports/propose`, radiologist.token);
    expect([proposed.status, proposed.body.templateKey, proposed.body.provenance.drafter]).toEqual([201, "ct", "offline_template"]);
    const proposedView = await get(`/radiology/reports/${proposed.body.reportId}`, radiologist.token);
    expect(proposedView.body.report.body.technique).toContain("80.00 ml Iohexol"); // numeric(8,2), as recorded
    expect([proposedView.body.report.body.findings, proposedView.body.report.impression]).toEqual(["", null]);
    expect(proposedView.body.report.provenance).toMatchObject({ drafter: "offline_template", inputs: { requestedBy: radiologist.id } }); // C14
    expect(proposed.body.body).toEqual(proposedView.body.report.body); // C4 — the answer carries the body
    const drafted = await post(`/radiology/studies/${study!.id}/reports/draft`, radiologist.token, {
      body: { technique: "Portal venous phase.", findings: "No collection." },
      impression: "No intra-abdominal abscess.",
    });
    expect(drafted.status).toBe(201);

    /** The session's factor is stamped by the SERVER; the body cannot carry it. */
    await recordSecondFactor(db, radiologist.sessionId);
    /** Close review B2 — even under a fresh factor the machine's proposal is not signable; the human's draft is. */
    const signProposal = await post(`/radiology/studies/${study!.id}/reports/sign`, radiologist.token, { reportId: proposed.body.reportId });
    expect([signProposal.status, signProposal.body.code]).toEqual([422, "machine_draft_not_signable"]);
    const signed = await post(`/radiology/studies/${study!.id}/reports/sign`, radiologist.token, {
      reportId: drafted.body.reportId,
    });
    expect([signed.status, signed.body.version]).toEqual([201, drafted.body.version + 1]);
    /** 18b T4 / §6.8 — the signed version carries no provenance; only the machine's draft does. */
    expect((await get(`/radiology/reports/${signed.body.reportId}`, radiologist.token)).body.report.provenance).toBeNull();
    const chain = (await get(`/radiology/studies/${study!.id}`, radiologist.token)).body.study.reports;
    expect(chain.map((v: { version: number; machineDrafted: boolean }) => [v.version, v.machineDrafted]))
      .toEqual([[3, false], [2, false], [1, true]]);

    /** ── PUBLICATION: the envelope closes, and money never gated it (T8 A6) ── */
    const published = await post(`/radiology/studies/${study!.id}/reports/publish`, radiologist.token);
    expect([published.status, published.body.notified]).toEqual([201, false]);

    const [final] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study!.id));
    expect(final!.status).toBe("published");
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, final!.orderItemId));
    expect(item!.status).toBe("completed");

    /** ── THE EVENTS, IN ORDER ── */
    const all = await db.select().from(events).orderBy(events.seq); // C13 — the dispatcher's own order
    const names = all.map((e) => e.name);
    for (const expected of [
      "order.placed", "imaging.study_scheduled", "imaging.gate_evaluated", "imaging.study_acquired",
      "imaging.image_viewed", "imaging.report_published",
    ]) {
      expect(names).toContain(expected);
    }
    expect(names.indexOf("imaging.study_scheduled")).toBeLessThan(names.indexOf("imaging.study_acquired"));
    expect(names.indexOf("imaging.study_acquired")).toBeLessThan(names.indexOf("imaging.image_viewed"));
    expect(names.indexOf("imaging.image_viewed")).toBeLessThan(names.indexOf("imaging.report_published"));
    /** 18b T5 — the payload 18b-ii's reconciliation will join on, pinned: accession, source, UID. */
    const acquiredEvent = all.find((e) => e.name === "imaging.study_acquired")!;
    expect(acquiredEvent.payload).toMatchObject({
      accessionNo: study!.accessionNo, imageSource: "pacs", studyInstanceUid: afterAcq!.studyInstanceUid,
      deviceResourceId: devices.ct,
    });
    expect(all.find((e) => e.name === "imaging.image_viewed")!.payload)
      .toEqual({ studyId: study!.id, viewerId: doctor.id, via: "external_pacs" });

    /** ── AND EVERY READER LEFT A PHI ROW ── */
    expect((await get(`/radiology/studies/${study!.id}`, radiologist.token)).status).toBe(200);
    expect((await get(`/radiology/reports/${signed.body.reportId}`, radiologist.token)).status).toBe(200);
    const phiRows = await db.select().from(phiAccessLog);
    // 18b T1 — the worklist pulls above are the third surface, and every one of them is the bridge's.
    expect(new Set(phiRows.map((r) => r.surface))).toEqual(new Set(["imaging.study", "imaging.report", "imaging.worklist"]));
    const pulls = phiRows.filter((r) => r.surface === "imaging.worklist");
    expect(pulls).toHaveLength(2); // C15 — one patient, two authorised pulls: exactly two
    expect(new Set(pulls.map((r) => r.actorId))).toEqual(new Set([bridge.id]));
  }, 120_000);

  /* ══════════════════════════════════════════════════════════════════════════════════════ */

  it("STUDY TWO — an obstetric USG: restricted, gated, and refused until the Form F is RECORDED", async () => {
    const placed = await post("/radiology/orders", doctor.token, {
      patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY,
      orderingClinicianId: doctor.id, indication: "anomaly scan at 19 weeks",
      items: [{ serviceId: services["USG-OBS-ANOMALY"] }],
    });
    expect(placed.status).toBe(201);
    expect(await pump()).toBeGreaterThan(0);

    const [study] = await db.select().from(imagingStudies).where(eq(imagingStudies.patientId, PATIENT));
    /** DD14 — the applicability rule ran at PLACEMENT and froze the consequence on both rows. */
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, study!.orderItemId));
    expect([item!.restricted, study!.formFRequired]).toEqual([true, true]);

    /** The register must exist before the scan: no registration, no Form F, no scan. */
    const reg = await post("/pcpndt/registrations", radiographer.token, {
      site: "Main hospital", registrationNo: "PNDT/MH/2026/0001",
      validFrom: "2026-01-01", validTo: "2027-12-31",
    });
    expect(reg.status).toBe(201);
    await post(`/pcpndt/registrations/${reg.body.registrationId}/machines`, radiographer.token, {
      deviceResourceId: devices.usg, make: "GE", model: "Voluson S10", serial: "SN-99001",
    });
    await post(`/pcpndt/registrations/${reg.body.registrationId}/persons`, radiographer.token, {
      userId: radiographer.id, qualification: "MD Radiodiagnosis",
    });

    await post(`/radiology/studies/${study!.id}/schedule`, radiographer.token, {
      deviceResourceId: devices.usg, scheduledAt: "2026-08-31T11:00:00.000Z",
    });
    const checked = await post(`/radiology/studies/${study!.id}/check-in`, radiographer.token);
    /** THE STATUTORY GATE IS AMONG THEM, opened from the study's frozen flag. */
    expect(checked.body.gates.sort()).toEqual(["chaperone_present", "form_f", "identity_two_factor"]);

    /** The Form F gate reads the REGISTER and takes no evidence from the caller (T6). */
    const tooSoon = await post(`/radiology/studies/${study!.id}/gates/form_f/satisfy`, radiographer.token, {});
    expect([tooSoon.status, tooSoon.body.code]).toEqual([422, "form_f_missing"]);

    const opened = await post("/pcpndt/form-f", radiographer.token, {
      studyId: study!.id, patientId: PATIENT, deviceResourceId: devices.usg,
      personUserId: radiographer.id, indicationCode: "anomaly-scan",
      /**
       * F52's sibling — `onDate` decides the SERIAL YEAR and is now bounded against the server's
       * own clock, so this e2e stops choosing one. The server uses today, which is what a scan
       * happening now actually is.
       */
      applicability: "pregnant",
    });
    expect([opened.status, opened.body.serialNo]).toEqual([201, 1]);

    expect((await post(`/radiology/studies/${study!.id}/gates/form_f/satisfy`, radiographer.token, {})).status).toBe(201);
    expect((await post(`/radiology/studies/${study!.id}/gates/identity_two_factor/satisfy`, radiographer.token, {
      secondIdentifier: "uhid", value: "HMS-00000001-5",
    })).status).toBe(201);
    const last = await post(`/radiology/studies/${study!.id}/gates/chaperone_present/satisfy`, radiographer.token, {
      chaperoneUserId: radiologist.id,
    });
    expect(last.body.study.state).toBe("ready");

    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study!.id));
    expect((await post(`/radiology/studies/${study!.id}/acquisition/start`, radiographer.token, {})).status).toBe(201);

    /**
     * ═══ THE ACT, END TO END: THE EXPOSURE IS REFUSED UNTIL THE DECLARATION IS SIGNED ═══
     *
     * The gate passed on an OPEN form — the sonologist has started the paperwork. The REGISTER
     * demands a RECORDED one, and H8 is the difference: a form filled in after the scan is a form
     * written to match what was found.
     */
    const refused = await post(`/radiology/studies/${study!.id}/acquisition/acquired`, radiographer.token, {
      imageSource: "no_pacs_images",
    });
    expect([refused.status, refused.body.code]).toEqual([422, "form_f_missing"]);

    const recorded = await post(`/pcpndt/form-f/${opened.body.formFId}/record`, radiographer.token, {
      sections: { A: "Dr Referrer", F: "anomaly scan at 19 weeks" },
      declaration: { signature_kind: "signature" },
      referral: { self_referral: false },
      gestationWeeks: 19,
    });
    expect(recorded.status).toBe(201);

    const lands = await post(`/radiology/studies/${study!.id}/acquisition/acquired`, radiographer.token, {
      imageSource: "no_pacs_images",
    });
    expect(lands.status).toBe(201);

    /**
     * ═══ F45 (CLOSE REVIEW, OWNER RULING) — A8's E2E ASSERTED THE DEFECT OVER HTTP ═══
     *
     * This asserted that a reader holding ONLY `radiology.worklist.read` cannot see the restricted
     * obstetric study, and that the "cleared" radiographer can. **The seeded `radiographer` holds
     * exactly `radiology.worklist.read` and nothing more** — this suite's own fixture grants it
     * three extra permissions (`orders.read.restricted`, `pcpndt.form_f.write`,
     * `pcpndt.registrations.manage`) that no seeded role has, so the end-to-end proof of the
     * statutory flow was performed by a role that does not exist in the hospital. In a real
     * deployment BOTH readers here are `noClearance`, and the obstetric study was invisible to the
     * entire department.
     *
     * `radiology.worklist.read` IS the departmental clearance now. The row is visible and carries
     * `restricted: true` as a label. What still holds it out is the KERNEL's own order reader, on
     * the ward's route — a different reader that this suite does not exercise and `read.test.ts`
     * now pins directly.
     */
    const noClearance = await staff(["radiology.worklist.read"], "nc");
    const held = await get("/radiology/worklist?view=all", noClearance.token);
    const heldRow = held.body.rows.find((r: { studyId: string }) => r.studyId === study!.id);
    expect(heldRow).toBeDefined();
    expect(heldRow.restricted).toBe(true);
    const cleared = await get("/radiology/worklist?view=all", radiographer.token);
    expect(cleared.body.rows.map((r: { studyId: string }) => r.studyId)).toContain(study!.id);

    /** ── A6/J1: the Form F carries the REAL name, and the read is logged ── */
    await db.update(patients).set({ isConfidential: true, alias: "Priya M." })
      .where(eq(patients.id, PATIENT));
    const form = await get(`/pcpndt/studies/${study!.id}/form-f`, radiographer.token);
    expect([form.status, form.body.form.patientName]).toEqual([200, "Asha Devi"]);
    expect((await db.select().from(phiAccessLog)).some((r) => r.surface === "pcpndt.form_f")).toBe(true);
  }, 120_000);

  /* ══════════════════════════════════════════════════════════════════════════════════════ */

  it("the guards are real: 401 unauthenticated and 403 for the wrong permission", async () => {
    for (const path of ["/radiology/worklist", "/radiology/bill-decisions"]) {
      expect((await request(server()).get(path)).status).toBe(401);
    }
    /** `counter` holds `radiology.bill_decisions.manage` and NOT the worklist read. */
    expect((await get("/radiology/worklist", counter.token)).status).toBe(403);
    expect((await get("/radiology/bill-decisions", counter.token)).status).toBe(200);
    /** …and the radiographer, who holds the worklist, cannot touch the counter's queue. */
    expect((await get("/radiology/bill-decisions", radiographer.token)).status).toBe(403);
  }, 60_000);

  it("the `imaging` order kind resolves off the REAL manifest, not off a fixture decl", async () => {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    expect(collectOrderKinds(registry).map((k) => k.kind).sort()).toContain("imaging");
  });

  /**
   * ═══ PLAN 18c T5 — THE PHASE'S FINISH LINE, OVER HTTP AND THROUGH THE REAL MANIFEST ═══
   *
   * §1's sentence, walked: the CT carries a live AERB licence or it cannot be acquired; a failed QA
   * record BLOCKS the machine and a pass releases it; the acquired study writes a dose row compared
   * against a published reference level; a quarterly badge reading over the investigation level
   * raises the RSO's row; and one date range comes back as the inspector's file.
   *
   * It is one `it` deliberately: five registers that each pass alone and do not add up is exactly
   * what a phase-closing walk exists to catch, and the state each step leaves is the next step's
   * precondition.
   */
  it("THE AERB WALK — licence, QA lockout and release, dose against a DRL, a badge flag, and the file", async () => {
    /** ── 1. THE LICENCE. Filed in the fixture; the register shows it and names no gap. ── */
    const licences = await get("/aerb/licences", rso.token);
    expect(licences.status).toBe(200);
    expect((licences.body as { rows: { licenceNo: string }[] }).rows.map((r) => r.licenceNo))
      .toContain("AERB/CT/2026/E2E");

    const gaps = await get(`/aerb/licences/gaps?onDate=${DAY}`, rso.token);
    expect(gaps.status).toBe(200);
    /** The USG is not licensable and the CT is licensed, so nothing is unaccounted for. */
    expect((gaps.body as { rows: unknown[] }).rows).toEqual([]);

    /** ── 2. THE QA LOCKOUT. A failure stops the machine — through the resource registry. ── */
    const failed = await post("/aerb/qa", rso.token, {
      deviceResourceId: devices.ct, qaType: "AERB annual QA", result: "fail",
      performedBy: "S. Iyer, medical physicist", performedOn: DAY,
      values: { outputRepeatabilityPct: 12.4 }, nextDueOn: "2027-08-31",
    });
    expect(failed.status).toBe(201);
    expect((failed.body as { blocked: boolean }).blocked).toBe(true);

    const blocked = await db.select().from(resources).where(eq(resources.id, devices.ct!));
    expect(blocked[0]!.status).toBe("qa_blocked");

    /** ── 3. THE RELEASE. A pass returns it, and names the record it released. ── */
    const passed = await post("/aerb/qa", rso.token, {
      deviceResourceId: devices.ct, qaType: "AERB annual QA", result: "pass",
      performedBy: "S. Iyer, medical physicist", performedOn: DAY, nextDueOn: "2027-08-31",
    });
    expect(passed.status).toBe(201);
    expect((passed.body as { releasedRecordId: string | null }).releasedRecordId)
      .toBe((failed.body as { recordId: string }).recordId);
    const released = await db.select().from(resources).where(eq(resources.id, devices.ct!));
    expect(released[0]!.status).toBe("available");

    /**
     * ── 4. THE DOSE. A CT walked from order to acquisition, against a PUBLISHED reference level. ──
     *
     * The DRL book is published as an active definition rather than drafted through the approval
     * ceremony, which `definitions.test.ts` owns; what this walk is about is that the level the
     * book carries reaches the register row the acquisition writes.
     */
    await db.insert(imagingDefinitions).values({
      id: "01DEF00000000000000000003", kind: "dose_reference_levels", version: 1, status: "active",
      draftedBy: "e2e", publishedBy: "e2e", publishedAt: NOW,
      body: { levels: [{ study_type_code: "CT-ABDO-CONTRAST", quantity: "dlp", value: 1000, source: "ICRP 135" }] },
    });

    const placed = await post("/radiology/orders", doctor.token, {
      patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY,
      orderingClinicianId: doctor.id, indication: "abdominal pain, ?abscess",
      items: [{ serviceId: services["CT-ABDO-CONTRAST"] }],
    });
    expect(placed.status).toBe(201);
    expect(await pump()).toBeGreaterThan(0);
    const [study] = await db.select().from(imagingStudies).where(eq(imagingStudies.patientId, PATIENT));

    expect((await post(`/radiology/studies/${study!.id}/schedule`, radiographer.token, {
      deviceResourceId: devices.ct, scheduledAt: "2026-08-31T09:00:00.000Z",
    })).status).toBe(201);
    expect((await post(`/radiology/studies/${study!.id}/check-in`, radiographer.token)).status).toBe(201);

    const satisfy = (kind: string, evidence: unknown) =>
      post(`/radiology/studies/${study!.id}/gates/${kind}/satisfy`, radiographer.token, evidence);
    await satisfy("identity_two_factor", { secondIdentifier: "uhid", value: "HMS-00000001-5" });
    await satisfy("pregnancy_screen", { declared: true, lmpDate: new Date(Date.now() - 5 * 86_400_000).toISOString() });
    await satisfy("renal_function", { creatinineUmolL: 72, sampledAt: new Date().toISOString(), source: "internal" });
    await satisfy("prior_contrast_reaction", {});
    await satisfy("contrast_consent", {
      procedureCode: "CT-ABDO-CONTRAST", templateVersion: "rad-contrast-v3", language: "hi",
      signer: "patient", conversionCovered: false, laterality: null, signedAt: new Date().toISOString(),
    });

    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study!.id));
    expect((await post(`/radiology/studies/${study!.id}/acquisition/start`, radiographer.token, {})).status).toBe(201);
    expect((await post(`/radiology/studies/${study!.id}/acquisition/acquired`, radiographer.token, {
      imageSource: "pacs", doseCtdivol: 6.4, doseDlp: 1200.5,
      contrastGiven: true, contrastAgent: "Iohexol", contrastVolumeMl: 80,
    })).status).toBe(201);

    const doses = await get("/aerb/doses", rso.token);
    expect(doses.status).toBe(200);
    const doseRows = (doses.body as {
      rows: { procedureCode: string; overDrl: boolean | null; drlValue: string | null; doseDlp: string | null }[];
    }).rows;
    expect(doseRows).toHaveLength(1);
    /** 1200.5 mGy·cm against a published 1000 — the comparison the book made, stored on the row. */
    expect(doseRows[0]).toMatchObject({ procedureCode: "CT-ABDO-CONTRAST", overDrl: true, drlValue: "1000.000" });
    expect(doseRows[0]!.doseDlp).toBe("1200.500");

    /** And the disclosure was logged on its own surface, one row for the one patient shown. */
    const doseLog = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "aerb.dose_register"));
    expect(doseLog).toHaveLength(1);
    expect(doseLog[0]!.patientId).toBe(PATIENT);

    /** The radiologist's cumulative nudge reads the same register, and NEVER refuses. */
    const cumulative = await get(`/aerb/doses/patient/${PATIENT}`, rso.token);
    expect(cumulative.status).toBe(200);
    expect((cumulative.body as { studyCount: number; overDrlCount: number }).studyCount).toBe(1);
    expect((cumulative.body as { overDrlCount: number }).overDrlCount).toBe(1);

    /** ── 5. THE BADGE. A quarterly reading over the pro-rated level raises the RSO's row. ── */
    const issued = await post("/aerb/badges", rso.token, {
      userId: radiographer.id, badgeNo: "TLD-E2E-001", issuedOn: "2026-01-01",
    });
    expect(issued.status).toBe(201);
    const badgeId = (issued.body as { badgeId: string }).badgeId;

    const reading = await post("/aerb/badges/reads", rso.token, {
      badgeId, periodStart: "2026-05-01", periodEnd: "2026-07-31",
      hp10Msv: 4.2, hp007Msv: 4.9, reportedOn: "2026-08-20", labRef: "TLD/2026/Q2",
    });
    expect(reading.status).toBe(201);
    expect((reading.body as { investigation: boolean }).investigation).toBe(true);

    const book = await get("/aerb/badges", rso.token);
    expect(book.status).toBe(200);
    const badgeBody = book.body as {
      rows: { badgeNo: string; workerYtdMsv: string; worstYear: string | null; worstYearMsv: string; lastInvestigation: boolean | null }[];
      limits: { annualMsv: number };
    };
    const mine = badgeBody.rows.find((r) => r.badgeNo === "TLD-E2E-001");
    expect(mine!.lastInvestigation).toBe(true);
    /**
     * Close review — the cumulative is the WORKER's, across every badge they have ever worn.
     *
     * PASS 2 — this used to read `workerYtdMsv`, which is THIS calendar year off the wall clock,
     * against a fixture reading that ends 2026-07-31: green all through 2026 and red on 1 January
     * 2027. Eight lines below, this file cites F28 for exactly that. `worstYear` and its total are
     * facts about the reading rather than about the day the suite runs.
     */
    expect(mine!.worstYear).toBe("2026");
    expect(Number(mine!.worstYearMsv)).toBeCloseTo(4.2, 3);
    /** The screen never states a limit the server did not send. */
    expect(badgeBody.limits.annualMsv).toBe(30);

    /**
     * ── 6. THE FILE. One read, and it carries what every register above just produced. ──
     *
     * `onDate` is the fixture's own DAY rather than the wall clock, so this walk asserts the same
     * thing on every morning it is run — F28's lesson, which cost five radiology suites a day.
     */
    const file = await get(`/aerb/calendar?includeOk=true&onDate=${DAY}`, rso.token);
    expect(file.status).toBe(200);
    const rows = (file.body as { rows: { kind: string; state: string; detail: string }[] }).rows;
    expect(rows.some((r) => r.kind === "licence" && r.detail === "AERB/CT/2026/E2E")).toBe(true);
    expect(rows.some((r) => r.kind === "qa" && r.detail === "AERB annual QA")).toBe(true);
    /**
     * The badge was read for the quarter that ended a month ago, so it is NOT a gap — and this is
     * the assertion that the file says what is TRUE rather than what is convenient. A reading
     * entered for a period that closed six months ago would put the row back.
     */
    expect(rows.some((r) => r.kind === "badge")).toBe(false);

    /**
     * ── 7. THE DOORS, AND D2's SEPARATION IS THE POINT OF THEM ──
     *
     * `aerb.doses.read` is a THIRD permission rather than part of `aerb.registers.read`, because
     * the cumulative-dose nudge belongs on a radiologist's study screen and the licence file, the
     * QA book and the badge register do not. A reader holding exactly that one string proves it:
     * the dose register opens, every other AERB route is 403.
     */
    const doseReader = await staff(["aerb.doses.read"], "dosr");
    for (const path of ["/aerb/licences", "/aerb/qa", "/aerb/badges", "/aerb/calendar", "/aerb/persons"]) {
      expect([path, (await get(path, doseReader.token)).status]).toEqual([path, 403]);
    }
    expect((await get("/aerb/doses", doseReader.token)).status).toBe(200);

    /** And the radiographer who acquires holds none of it at all — not even the doses. */
    expect((await get("/aerb/doses", radiographer.token)).status).toBe(403);
    expect((await get("/aerb/licences", "")).status).toBe(401);

    /**
     * ── 8. PLAN 18c T6 — THE PEN, AND THE BOOK THAT SAYS WHO IS HOLDING IT ──
     *
     * `aerb.registers.read` buys the book and `aerb.registers.manage` buys the pen, and until T6
     * the client had no way to learn which of the two it held short of posting and being refused.
     * 18b's close review (MAJOR B4) settled that one register over: the console must be TOLD.
     *
     * The quality manager below is the exact person the split exists for — they can show an
     * inspector every register and cannot write a word in any of them.
     */
    const bookReader = await staff(["aerb.registers.read"], "qmgr");
    for (const path of ["/aerb/licences", "/aerb/qa", "/aerb/badges", "/aerb/persons"]) {
      const res = await get(path, bookReader.token);
      expect([path, res.status]).toEqual([path, 200]);
      expect([path, (res.body as { canManage: boolean }).canManage]).toEqual([path, false]);
    }
    for (const path of ["/aerb/licences", "/aerb/qa", "/aerb/badges", "/aerb/persons"]) {
      expect([path, ((await get(path, rso.token)).body as { canManage: boolean }).canManage])
        .toEqual([path, true]);
    }

    /**
     * The pickers are behind the PEN, not the book: an inspector reading the file needs no dropdown
     * of machines, and the staff roster is not part of what the register discloses to a reader.
     * They exist because the RSO holds neither `resources.read` nor `auth.users.manage` — a form
     * built on those doors would render empty for the one person the screen is for.
     */
    expect((await get("/aerb/pickers", bookReader.token)).status).toBe(403);
    const pickers = await get("/aerb/pickers", rso.token);
    expect(pickers.status).toBe(200);
    const picked = pickers.body as {
      devices: { resourceId: string; code: string; licensable: boolean }[];
      users: { userId: string; fullName: string }[];
    };
    /**
     * `licensable` is the SERVER's answer, from the same list the gap check reads. The CT is
     * licensable; the ultrasound emits no ionising radiation and never appears on an eLORA licence.
     * A screen deriving this from the modality string would be the copy that drifted.
     */
    const ct = picked.devices.find((d) => d.resourceId === devices.ct);
    const usg = picked.devices.find((d) => d.resourceId === devices.usg);
    expect([ct?.licensable, usg?.licensable]).toEqual([true, false]);
    /** The RSO can be named as the RSO on a licence, so the RSO is in the staff list. */
    expect(picked.users.map((u) => u.userId)).toContain(rso.id);
  }, 60_000);
});
