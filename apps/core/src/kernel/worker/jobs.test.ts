import { eq } from "drizzle-orm";
import { buildSubscriptionBus, registerAllJobs, type JobIntervals } from "./jobs";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { notifications, patients, events } from "../db/schema";
import { ModuleRegistry } from "../modules/loader";
import { authManifest } from "../auth/manifest";
import { workflowManifest } from "../workflow/manifest";
import { approvalsManifest } from "../approvals/manifest";
import { patientsManifest } from "../../modules/patients";
import { tariffManifest } from "../../modules/tariff";
import { opdManifest } from "../../modules/opd";
import { billingManifest } from "../../modules/billing";
import type { Handler, SubscriptionBus } from "../events/subscriptions";
import type { ModuleManifest } from "../modules/manifest";
import type { JobSpec, Scheduler } from "./scheduler";
import type { Db } from "../db/client";

// Flattens a bus into (consumer, event) pairs for comparison. A consumer may in principle
// carry more than one event name (SubscriptionBus.on adds to the same entry), so this is a
// proper flatMap, not an assumption of one event per consumer.
function busPairs(bus: SubscriptionBus): [string, string][] {
  return bus.consumers().flatMap((c) => c.events.map((e): [string, string] => [c.consumer, e]));
}

const noopHandler: Handler = async () => {};

describe("buildSubscriptionBus (amendment 6 seam)", () => {
  // Leg (a) — THE DISCRIMINATING LEG. Spike question D measured that all seven shipped
  // manifests declare `subscriptions: []` today, so an assertion against the real registry
  // alone is `[] === []` and proves nothing (EXECUTION-LESSONS 3.14's class). A synthetic
  // manifest with a matching stub handler gives the bus something non-empty to get wrong.
  it("wires exactly the registry's declared subscriptions to their handlers", () => {
    const registry = new ModuleRegistry();
    const synthetic: ModuleManifest = {
      key: "synthetic",
      title: "Synthetic",
      menu: [],
      permissions: [],
      subscriptions: [{ event: "synthetic.happened", consumer: "synthetic.consumer" }],
    };
    registry.install(synthetic);

    const bus = buildSubscriptionBus(registry, { "synthetic.consumer": noopHandler });

    expect(busPairs(bus)).toEqual([["synthetic.consumer", "synthetic.happened"]]);
  });

  it("throws — a boot error, not a silent skip — when a declared subscription has no matching handler", () => {
    const registry = new ModuleRegistry();
    const synthetic: ModuleManifest = {
      key: "synthetic2",
      title: "Synthetic2",
      menu: [],
      permissions: [],
      subscriptions: [{ event: "synthetic.happened", consumer: "synthetic.consumer" }],
    };
    registry.install(synthetic);

    expect(() => buildSubscriptionBus(registry, {})).toThrow(/synthetic\.consumer/);
  });

  // Leg (b) — the honest empty pin, AND A CORRECTED CLAIM ABOUT ITSELF. This leg used to say
  // it would become load-bearing "once amendment 6's alertsManifest joins this same registry".
  // IT NEVER COULD: "this same registry" is a literal list inside this test file, so nothing
  // that happens to the WORKER's registry can ever change what this assertion sees. That is
  // precisely how a worker that installed no alerts manifest — and therefore dispatched
  // `escalation.triggered` to nobody — passed six tasks and two gates with a green suite:
  // `jobs.test.ts`, `alerts/consumer.test.ts` and `worker-runtime.e2e.test.ts` each built a
  // PRIVATE ModuleRegistry, so no assertion anywhere read the one production builds.
  //
  // The assertion that CAN see it boots the worker context and reads `MODULE_REGISTRY` out of
  // it: `test/worker-runtime.e2e.test.ts`, "(a) the worker's OWN registry". This leg keeps its
  // real job — pinning that the seven non-alerts manifests declare nothing, so leg (a)'s
  // synthetic manifest is what gives the seam its teeth here (EXECUTION-LESSONS 3.14: shipping
  // only this leg would be an assertion that starts and ends at `[] === []`).
  it("the real registry's union equals the real bus — EMPTY for the seven non-alerts manifests (all declare subscriptions: [])", () => {
    const registry = new ModuleRegistry();
    registry.install(authManifest);
    registry.install(workflowManifest);
    registry.install(approvalsManifest);
    registry.install(patientsManifest);
    registry.install(tariffManifest);
    registry.install(opdManifest);
    registry.install(billingManifest);

    const bus = buildSubscriptionBus(registry, {});

    expect(busPairs(bus)).toEqual([]);
  });
});

/**
 * ASSERTION BOOK R2 (Plan 11a Phase 0, R0-2) — `NOTIFY_STUCK_AFTER_MS` REACHES THE PUMP, and it
 * reaches it THROUGH THE PRODUCTION REGISTRATION.
 *
 * The key was dead for a whole plan: `config.ts:62` parsed it, `config.ts:101` exposed
 * `cfg.notifyStuckAfterMs`, and nothing read it, because the registration said
 * `runNotifyPump(db, { now })` and the pump fell back to its own `DEFAULT_STUCK_AFTER_MS`
 * (plan-10 gate report §7.2). What made that survivable for so long is the shape of the test
 * that looked like protection: `config.test.ts:38-43` asserts these keys PARSE. Parsing was
 * never in doubt. So this test asserts the only thing that was: that the value TAKES EFFECT.
 *
 * The discriminator is arithmetic, not a wait. The row is two minutes stale. At the registered
 * `notifyStuckAfterMs: 1000` the cutoff is `now - 1 s`, the row is older than it, and the D2
 * sweep flips it to `undeliverable(stuck_sending)`. At the module fallback of 300 000 the cutoff
 * is `now - 5 min`, the row is NEWER than it, and it stays `sending` — which is exactly what the
 * gate report executed against production's call shape. Time is a parameter here (Global
 * Constraint 9/10): nothing below sleeps or measures a clock.
 */
describe("registerAllJobs threads NOTIFY_STUCK_AFTER_MS to the pump (Book R2)", () => {
  const NOON = new Date("2026-08-21T06:00:00.000Z");
  const PATIENT = "01HR02JOBSPATIENT00000001";
  const STUCK_ROW = "01HR02JOBSSTUCKROW0000001";

  /**
   * `Scheduler` is a class with `private` members, so it is compared NOMINALLY and a structural
   * recorder cannot be passed to `registerAllJobs` without this cast (AGENT-RULES §2.61). The
   * cast buys the thing the real class cannot give: `Scheduler.jobs()` returns `string[]`, so a
   * real instance hands back job NAMES and never the `run` closure this assertion has to invoke.
   * `registerAllJobs` itself is the REAL production function — that is what is under test.
   */
  function recordingScheduler(specs: JobSpec[]): Scheduler {
    return {
      register(spec: JobSpec): void {
        specs.push(spec);
      },
    } as unknown as Scheduler;
  }

  /** The three D9 cadences plus the pump's, with the stuck window set to a DISTINCT value. */
  const INTERVALS: JobIntervals = {
    workerDispatchIntervalMs: 2000,
    workerTimersIntervalMs: 20_000,
    workerTempRolesIntervalMs: 60_000,
    workerNotifyIntervalMs: 5000,
    // 1 000, chosen so it cannot be confused with the pump's own 300 000 fallback: if this test
    // passes, no fallback could have produced the result.
    notifyStuckAfterMs: 1000,
  };

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female",
      phone: "9876500001", createdBy: "u1", updatedBy: "u1",
    });
    await db.insert(notifications).values({
      id: STUCK_ROW, audience: "patient", patientId: PATIENT, templateKey: "patient_welcome",
      params: { uhid: "HMS-00000001-5" }, dedupeKey: "n:r2:stuck:1", occurredAt: NOON,
      expiresAt: new Date(NOON.getTime() + 24 * 3600_000), status: "sending",
      updatedAt: new Date(NOON.getTime() - 2 * 60_000), // claimed two minutes ago
    });
  });

  const registeredPump = (): JobSpec => {
    const specs: JobSpec[] = [];
    registerAllJobs(recordingScheduler(specs), db, new ModuleRegistry(), {}, INTERVALS);
    const pump = specs.find((s) => s.name === "runNotifyPump");
    if (pump === undefined) throw new Error("registerAllJobs registered no runNotifyPump job");
    return pump;
  };

  const stuckRow = async (): Promise<typeof notifications.$inferSelect> =>
    (await db.select().from(notifications).where(eq(notifications.id, STUCK_ROW)))[0]!;

  it("a 'sending' row two minutes stale flips under the job's OWN run(now) — the operator's key takes effect", async () => {
    expect((await stuckRow()).status).toBe("sending"); // the precondition, not an assumption

    await registeredPump().run(NOON);

    const row = await stuckRow();
    // Reachable ONLY through the registered value: at the 300 000 fallback this row is younger
    // than the cutoff and is left alone. This single assertion is what the dead key failed.
    expect(row.status).toBe("undeliverable");
    expect(row.sentAt).toBeNull();

    const failed = await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.name, "notification.failed"));
    expect(failed).toHaveLength(1);
    expect((failed[0]!.payload as { reason: string }).reason).toBe("stuck_sending");
  });

  it("registers the pump on its own cadence — the widened Pick did not disturb the seventh job", () => {
    const pump = registeredPump();
    expect(pump).toEqual(expect.objectContaining({ name: "runNotifyPump", every: 5000 }));
  });
});
