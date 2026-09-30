import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import { events, imagingDefinitions } from "../../kernel/db/schema";
import { approveRequest } from "../../kernel/approvals/decisions";
import { requestApproval } from "../../kernel/approvals/requests";
import { withTx } from "../../kernel/db/client";
import { registerRadiologyApprovalTypes } from "./approval-types";
import { approvalGrantedConsumer } from "./approval-consumer";
import { checkIn } from "./checkin";
import { gateState, requireStudyGate } from "./gates";
import { decideGateOverride, requestGateOverride } from "./override-requests";
import { scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { DispatchedEvent } from "../../kernel/events/subscriptions";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS10 T3 — **a grant given in the kernel's `/approvals` inbox applies the gate override**
 * (RS5 moved it here: before, only radiology's own decide route applied a grant). The consumer is
 * handed the REAL `approval.granted` row the kernel appended, projected the way the dispatcher
 * projects it.
 */
describe("the approval.granted consumer applies an inbox grant (18-S RS10 T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let seq = 0;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    const { actor: activator } = await mkUser(db, "owner.two", ["owner"]);
    await registerRadiologyApprovalTypes(db, activator);
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  const arrive = async (): Promise<string> => {
    seq += 1;
    const s = await placeAndCreateStudy(db, fx, "USG-ABDO", `grant${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000));
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: s.studyId, deviceResourceId: fx.devices.usg!, scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: s.studyId, now: NOW }));
    return s.studyId;
  };

  /** The newest `approval.granted` row, as the dispatcher hands it to a consumer. */
  const grantedEvents = async (): Promise<DispatchedEvent[]> => {
    const rows = await db.select().from(events).where(eq(events.name, "approval.granted"));
    return rows.map((r) => ({
      seq: Number(r.seq), eventId: r.eventId, name: r.name, payload: r.payload,
      patientId: r.patientId, correlationId: r.correlationId, occurredAt: r.occurredAt,
    }));
  };
  const overriddenEvents = async (): Promise<number> => (await db.select().from(events)
    .where(eq(events.name, "imaging.gate_evaluated")))
    .filter((e) => (e.payload as { outcome: string }).outcome === "overridden").length;

  it("an inbox grant leaves the gate open until the consumer runs; the consumer overrides it with the approver's note, once", async () => {
    const studyId = await arrive();
    const gate = await requireStudyGate(db, studyId, "identity_two_factor");
    const { approvalId } = await withTx(db, (tx) => requestGateOverride(tx, fx.radiographer, {
      studyId, kind: "identity_two_factor", note: "wristband printed with the old UHID; photo ID seen",
    }));
    // Granted in the KERNEL inbox (not radiology's decide route): nothing applied yet.
    await approveRequest(db, fx.radiologist, { approvalId, note: "photo ID matches; proceed" });
    expect(await gateState(db, gate.id)).toBe("open");

    const handler = approvalGrantedConsumer(db);
    const [granted] = await grantedEvents();
    await handler(granted!);
    expect(await gateState(db, gate.id)).toBe("overridden");
    const before = await overriddenEvents();
    expect(before).toBe(1);

    // At-least-once: the same event again changes nothing.
    await handler(granted!);
    expect(await overriddenEvents()).toBe(before);
  });

  it("the radiology route and the consumer both arriving override once", async () => {
    const studyId = await arrive();
    const { approvalId } = await withTx(db, (tx) => requestGateOverride(tx, fx.radiographer, {
      studyId, kind: "identity_two_factor", note: "second identifier disputed",
    }));
    await decideGateOverride(db, fx.radiologist, { approvalId, verdict: "grant", reason: "identity confirmed by photo ID" });
    const [granted] = await grantedEvents();
    await approvalGrantedConsumer(db)(granted!);
    expect(await overriddenEvents()).toBe(1);
  });

  it("a never-override kind stays refused, and a note carrying a §5(2) term is not applied — both without throwing", async () => {
    // The side is asked of this study type (the RS5 suite's own book edit).
    await db.update(imagingDefinitions).set({ body: { types: [
      studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg", laterality_applicable: true }),
      studyTypeRow({ code: "XR-CHEST", service_id: fx.services["XR-CHEST"]!, modality: "xray", ionising: true }),
      studyTypeRow({ code: "CT-HEAD", service_id: fx.services["CT-HEAD"]!, modality: "ct", ionising: true }),
      studyTypeRow({ code: "MRI-BRAIN", service_id: fx.services["MRI-BRAIN"]!, modality: "mri" }),
    ] } }).where(eq(imagingDefinitions.kind, "study_types"));
    const studyId = await arrive();
    const side = await requireStudyGate(db, studyId, "laterality_confirm");
    // Filed straight on the kernel (the radiology route refuses to file it): the grant must still not override the side.
    const { approvalId } = await withTx(db, (tx) => requestApproval(tx, fx.radiographer, {
      typeKey: "imaging_gate_override", subject: { type: "imaging_gate", id: side.id }, patientId: fx.patientId,
      requestNote: "please",
    }));
    await approveRequest(db, fx.radiologist, { approvalId, note: "ok" });
    const identity = await requireStudyGate(db, studyId, "identity_two_factor");
    const second = await withTx(db, (tx) => requestGateOverride(tx, fx.radiographer, {
      studyId, kind: "identity_two_factor", note: "asked",
    }));
    await approveRequest(db, fx.radiologist, { approvalId: second.approvalId, note: "no sex determination here" });

    const handler = approvalGrantedConsumer(db);
    for (const e of await grantedEvents()) await expect(handler(e)).resolves.toBeUndefined();
    expect(await gateState(db, side.id)).toBe("open");
    expect(await gateState(db, identity.id)).toBe("open");
    expect(await overriddenEvents()).toBe(0);
  });

  it("ignores every other approval type", async () => {
    const handler = approvalGrantedConsumer(db);
    await expect(handler({
      seq: 1, eventId: "e1", name: "approval.granted", patientId: null, correlationId: null, occurredAt: NOW,
      payload: {
        approvalId: "ap-x", typeKey: "billing_refund", requesterId: "u1", decidedBy: "u2", note: "ok",
        urgencyClass: "urgent", actedFirst: false,
      },
    } as DispatchedEvent)).resolves.toBeUndefined();
    expect(await overriddenEvents()).toBe(0);
  });
});
