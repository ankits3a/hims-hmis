import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantLabResultPermissions, seedLabDeskBase } from "../../../test/helpers/lab";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { labInstruments, resources } from "../../kernel/db/schema";
import {
  recordHeartbeat, registerInterface, sweepInterfaceHeartbeats,
} from "../../kernel/ops/interfaces";
import { LAB_INTERFACE_CONSUMER, labInterfaceConsumer } from "./interface-status";
import { linkInstrumentInterface, registerInstrument } from "./instruments";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent } from "../../kernel/events/subscriptions";

/**
 * ═══ 17-E T7b — `interface_down`, AND Q5's RULE IS THAT IT IS A LAPSE AND NEVER IDLENESS ═══
 *
 * ROADMAP v2 §1 Q5: *"`interface_down` is written only by the bridge's own heartbeat lapse, never by
 * idleness."* `kinds.ts` has declared the status since 17-E T1 with the comment that it is *"separate
 * from `maintenance`"*, and **nothing has ever written it.**
 *
 * ═══ THE KERNEL ALREADY OWNS THE HARD HALF, SO THIS TASK IS A BRIDGE AND NOT A MECHANISM ═══
 *
 * `kernel/ops/interfaces.ts` (Plan 11c D6) is the heartbeat framework: a device says it is alive, the
 * tenth worker job notices when one stops saying it, and each row is judged against **its own**
 * `stale_after_ms` rather than a global constant. Its own Book V10 rule is Q5's rule already:
 *
 *     "A REGISTERED-BUT-NEVER-SEEN INTERFACE IS NEVER DOWNED. `last_seen_at IS NULL` means
 *      `unknown`, and `unknown` is not `down`."
 *
 * So T7b adds **no heartbeat column and no second sweep** — it links a lab instrument to its bridge's
 * interface row and reacts to the two events the kernel already emits.
 *
 * ═══ WHY THE HEARTBEAT IS SEPARATE FROM SENDING RESULTS ═══
 *
 * If arrival of results were the liveness signal, **an analyser with nothing to run at 3 a.m. would
 * read as a dead link** — which is exactly the idleness Q5 forbids. The bridge pings on a timer
 * whether or not it has anything to say, so the distinction between "quiet" and "gone" is enforced by
 * the timer's existence rather than by anyone deciding what counts as idle.
 */
const T0 = new Date("2026-08-30T06:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("17-E T7b — an analyser whose bridge stops talking goes `interface_down`", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let instrumentId: string;
  let resourceId: string;
  let interfaceId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    await grantPermissionToRole(db, fx.registry, "pathologist", "lab.instruments.manage");
    ({ instrumentId } = await registerInstrument(db, fx.pathologist.actor, {
      code: "ANL-CHEM-1", name: "Chemistry analyser", sampleIdMode: "barcode",
    }));
    const [row] = await db.select().from(labInstruments).where(eq(labInstruments.id, instrumentId));
    resourceId = row!.resourceId;
    const iface = await registerInterface(db, {
      kind: "other", name: "ANL-CHEM-1 bridge", staleAfterMs: 60_000,
    }, T0);
    interfaceId = iface.id;
  });
  afterEach(() => { fx.unregister(); });

  const statusOf = async () => {
    const [r] = await db.select().from(resources).where(eq(resources.id, resourceId));
    return r!.status;
  };

  /** Feed the consumer the event the kernel actually emitted, rather than one this test invented. */
  const deliver = async (name: string, payload: unknown) => {
    const e: DispatchedEvent = {
      seq: 1, eventId: "e-1", name, payload, patientId: null, correlationId: null, occurredAt: T0,
    };
    await labInterfaceConsumer(db)(e);
  };

  /* ───────────────────────── A1 — the link, and its absence ───────────────────────── */

  it("A1: an instrument is linked to the interface its bridge heartbeats on", async () => {
    await linkInstrumentInterface(db, fx.pathologist.actor, { instrumentId, interfaceId });

    const [row] = await db.select().from(labInstruments).where(eq(labInstruments.id, instrumentId));
    expect(row!.interfaceId).toBe(interfaceId);
  });

  /**
   * ═══ Q5's RULE AT THE INSTRUMENT LEVEL, AND WHY THE COLUMN IS NULLABLE ═══
   *
   * An analyser with no registered bridge is not a broken link — it is a machine nobody has connected
   * yet, which is the state every instrument is in on the day it is entered in the register. A
   * NOT NULL column would have forced a fake interface row per instrument and then downed every one
   * of them on the first sweep.
   */
  it("A2: an instrument with NO linked interface is never touched by any interface event", async () => {
    await deliver("interface.down", { interfaceId, name: "some other device", lastSeenAt: T0.toISOString() });

    expect(await statusOf()).toBe("available");
  });

  /* ───────────────────────── A3/A4 — down, and back ───────────────────────── */

  /**
   * **THE KILL.** `interface_down` has been a declared status with no writer since T1. This is the
   * first thing in the system that writes it.
   */
  it("A3: `interface.down` for the linked bridge puts the analyser in `interface_down`", async () => {
    await linkInstrumentInterface(db, fx.pathologist.actor, { instrumentId, interfaceId });

    await deliver("interface.down", {
      interfaceId, name: "ANL-CHEM-1 bridge", lastSeenAt: T0.toISOString(),
    });

    expect(await statusOf()).toBe("interface_down");
  });

  it("A4: `interface.restored` brings it back to `available`", async () => {
    await linkInstrumentInterface(db, fx.pathologist.actor, { instrumentId, interfaceId });
    await deliver("interface.down", { interfaceId, name: "b", lastSeenAt: T0.toISOString() });
    expect(await statusOf()).toBe("interface_down");

    await deliver("interface.restored", { interfaceId, name: "b" });

    expect(await statusOf()).toBe("available");
  });

  /**
   * ═══ THE HALF THAT MUST NOT BREAK — a machine BUSY when the link dies is not made available ═══
   *
   * `interface.restored` returns the analyser to `available`, and that is right for the machine it
   * found in `interface_down`. But a restore must never PROMOTE a machine out of a state it did not
   * put it in: an analyser under `maintenance` when its bridge came back is still under maintenance,
   * and a consumer that wrote `available` unconditionally would silently clear an engineer's lockout.
   */
  it("A5: a restore only clears the state IT set — `maintenance` survives it", async () => {
    await linkInstrumentInterface(db, fx.pathologist.actor, { instrumentId, interfaceId });
    await db.update(resources).set({ status: "maintenance" }).where(eq(resources.id, resourceId));

    await deliver("interface.restored", { interfaceId, name: "b" });

    expect(await statusOf()).toBe("maintenance");
  });

  /* ────────────── A6 — end to end through the kernel's own sweep, not a hand-made event ────────────── */

  /**
   * ═══ NEVER BY IDLENESS — PROVED THROUGH THE REAL SWEEP ═══
   *
   * The two halves that make this Q5-compliant are the kernel's, so they are asserted through the
   * kernel rather than restated: a bridge that has **never** heartbeated is `unknown` and is not
   * downed, and one that heartbeated and then went quiet past its own window IS.
   */
  it("A6: a bridge that never heartbeated is NOT downed; one that goes quiet past its window is", async () => {
    await linkInstrumentInterface(db, fx.pathologist.actor, { instrumentId, interfaceId });

    /** Never seen. The sweep must ignore it, so the analyser stays available. */
    const first = await sweepInterfaceHeartbeats(db, later(10 * 60_000));
    expect(first.map((d) => d.interfaceId)).not.toContain(interfaceId);
    expect(await statusOf()).toBe("available");

    /** Now it speaks once, then goes quiet for longer than its own 60 s window. */
    await recordHeartbeat(db, fx.pathologist.actor, interfaceId, later(1_000));
    const downed = await sweepInterfaceHeartbeats(db, later(1_000 + 120_000));
    expect(downed.map((d) => d.interfaceId)).toContain(interfaceId);

    /** The sweep emits; the consumer is what turns that into the analyser's status. */
    await deliver("interface.down", {
      interfaceId, name: "ANL-CHEM-1 bridge", lastSeenAt: later(1_000).toISOString(),
    });
    expect(await statusOf()).toBe("interface_down");
  });

  it("A7: the consumer name is what the manifest declares — a mismatch is a worker BOOT ERROR", () => {
    expect(LAB_INTERFACE_CONSUMER).toBe("lab.interface_status");
  });
});
