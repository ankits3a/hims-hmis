import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { Scheduler, type Locks } from "./scheduler";
import { registerAllJobs } from "./jobs";
import { ModuleRegistry } from "../modules/loader";
import { requireEnv } from "../config";
import * as schema from "../db/schema";
import { events, schedulerHeartbeats } from "../db/schema";
import { authManifest } from "../auth/manifest";
import { workflowManifest } from "../workflow/manifest";
import { approvalsManifest } from "../approvals/manifest";
import { patientsManifest } from "../../modules/patients";
import { tariffManifest } from "../../modules/tariff";
import { opdManifest } from "../../modules/opd";
import { billingManifest } from "../../modules/billing";
import * as dispatcherMod from "../events/dispatcher";
import * as timersMod from "../workflow/timers";
import * as tempRolesMod from "../auth/temp-roles";
import * as guardiansMod from "../../modules/patients/guardians";
import * as appointmentsMod from "../../modules/opd/appointments";
import * as dailyCloseMod from "../../modules/billing/daily-close";
import type { Db } from "../db/client";

// D3/halt condition 7: no test in this file ever observes the advisory lock. Every test below
// injects this always-true stub instead — the lock is proven separately (spike B2, quoted in
// the report) and no sweep's correctness depends on it (every sweep is already idempotent and
// multi-process-safe on its own claim).
const stubLocks = (): Locks => ({ tryLock: async () => true, unlock: async () => {} });

/**
 * A dedicated connection to the SAME per-worker test database `setupTestDb()` already
 * migrated, but with `idleTimeoutMillis: 0`. The L14 census test below fakes ALL timers
 * (`setInterval` included, to compress 25 h into a fast advance) — and `pg`'s own Pool runs
 * its idle-connection eviction on a REAL `setTimeout` internally, which jest's fake timers
 * intercept too. Advancing 25 FAKE hours in a few real milliseconds makes that eviction timer
 * think every pooled connection has sat idle for hours and close it — reproduced once as
 * dozens of leaked `Connection terminated` errors on the SHARED pool, fixed by giving this one
 * test its own pool with eviction disabled. The suite's shared `pool`/`db` (used by the other
 * two tests, which run under real timers) is left untouched.
 */
function freshWorkerDb(): { db: Db; pool: Pool; close: () => Promise<void> } {
  const baseUrl = requireEnv("TEST_DATABASE_URL");
  const workerId = process.env.JEST_WORKER_ID ?? "1";
  const parsed = new URL(baseUrl);
  const baseDbName = parsed.pathname.replace(/^\//, "");
  const workerUrl = new URL(parsed.toString());
  workerUrl.pathname = `/${baseDbName}_${workerId}`;
  const dedicatedPool = new Pool({ connectionString: workerUrl.toString(), idleTimeoutMillis: 0 });
  const db = drizzle(dedicatedPool, { schema });
  return { db, pool: dedicatedPool, close: () => dedicatedPool.end() };
}

describe("Scheduler", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, pool, teardown } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll(db);
  });
  afterAll(async () => {
    await teardown();
  });

  it("starts and stops cleanly with no jobs registered", async () => {
    const scheduler = new Scheduler(db, pool, stubLocks());
    expect(scheduler.jobs()).toEqual([]);
    scheduler.start();
    await scheduler.stop();
    expect(scheduler.leakedErrors()).toEqual([]);
  });

  // L14 — the registration census. Global Constraint 3: jest runs sweeps DIRECTLY, never
  // through the scheduler; this test calls the REAL registerAllJobs (proving the wiring: job
  // names, D9 cadences, IST daily semantics, and the amendment-6 bus-building are all real and
  // unmodified) but replaces the six underlying sweep functions with recording stubs via
  // jest.spyOn on their own modules — so no real sweep body ever runs inside jest, only the
  // scheduling machinery around it.
  describe("the registration census (L14)", () => {
    // With the shipped D9 defaults (2 s / 20 s / 60 s), a 25 REAL-fake-hour advance would fire
    // the three "every" jobs tens of thousands of times, EACH doing a real heartbeat write —
    // correct, but far too slow for a unit test (the daily jobs need the full ~25 h span to
    // cross an IST day boundary, so that span cannot shrink). D9's config keys are designed to
    // be env-overridable (flag 8 is about the SERVER/CI .env, not this process's own env), so
    // this override — scoped to this describe block only, restored in afterEach — keeps the
    // exact same registerAllJobs code path while keeping the real-DB heartbeat cost to a few
    // dozen writes instead of tens of thousands.
    //
    // WORKER_DAILY_TICK_MS is overridden TIGHTER, not wider: isDailyDue() gates its (only) DB
    // read behind a cheap in-memory hour/minute check, so the ticker's own cost stays
    // negligible regardless of granularity. A first attempt WIDENED it to 30 min and reliably
    // STEPPED OVER daily-close's due window (23:59 IST is exactly ONE IST minute wide) every
    // time — a coarser grid than the window itself. The shipped 30 s default fixed that (2
    // ticks land inside the 1-minute window), but under `pnpm verify`'s full parallel load one
    // run still missed `runDailyClose` once (782/782 otherwise, not reproduced across 3
    // subsequent full runs) — consistent with 2 ticks being the THINNEST margin of the three
    // daily jobs against a single transient DB hiccup under contention. 5 s gives daily-close
    // ~12 ticks of margin inside the same window instead of 2, at negligible extra cost.
    const OVERRIDE: Record<string, string> = {
      WORKER_DISPATCH_INTERVAL_MS: String(4 * 60 * 60 * 1000),
      WORKER_TIMERS_INTERVAL_MS: String(6 * 60 * 60 * 1000),
      WORKER_TEMP_ROLES_INTERVAL_MS: String(9 * 60 * 60 * 1000),
      WORKER_DAILY_TICK_MS: String(5000),
    };
    const original: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of Object.keys(OVERRIDE)) {
        original[k] = process.env[k];
        process.env[k] = OVERRIDE[k];
      }
    });
    afterEach(() => {
      for (const k of Object.keys(OVERRIDE)) {
        if (original[k] === undefined) delete process.env[k];
        else process.env[k] = original[k];
      }
    });

    it("invokes all six jobs within a faked 25 hours advanced from a pinned instant", async () => {
      const invoked = new Set<string>();
      const spies = [
        jest.spyOn(dispatcherMod, "runDispatchCycle").mockImplementation(async () => {
          invoked.add("runDispatchCycle");
          return 0;
        }),
        jest.spyOn(timersMod, "runDueTimers").mockImplementation(async () => {
          invoked.add("runDueTimers");
          return 0;
        }),
        jest.spyOn(tempRolesMod, "sweepExpiredTempRoles").mockImplementation(async () => {
          invoked.add("sweepExpiredTempRoles");
          return 0;
        }),
        jest.spyOn(guardiansMod, "sweepGuardianMajority").mockImplementation(async () => {
          invoked.add("sweepGuardianMajority");
          return 0;
        }),
        jest.spyOn(appointmentsMod, "sweepAppointmentNoShows").mockImplementation(async () => {
          invoked.add("sweepAppointmentNoShows");
          return 0;
        }),
        jest.spyOn(dailyCloseMod, "runDailyClose").mockImplementation(
          (async () => {
            invoked.add("runDailyClose");
          }) as unknown as typeof dailyCloseMod.runDailyClose,
        ),
      ];

      const registry = new ModuleRegistry();
      registry.install(authManifest);
      registry.install(workflowManifest);
      registry.install(approvalsManifest);
      registry.install(patientsManifest);
      registry.install(tariffManifest);
      registry.install(opdManifest);
      registry.install(billingManifest);

      const fresh = freshWorkerDb();
      jest.useFakeTimers({ now: new Date("2026-08-21T12:00:00.000Z") });
      try {
        const scheduler = new Scheduler(fresh.db, fresh.pool, stubLocks());
        registerAllJobs(scheduler, fresh.db, registry, {});
        expect(scheduler.jobs()).toEqual([
          "runDispatchCycle",
          "runDueTimers",
          "sweepExpiredTempRoles",
          "sweepGuardianMajority",
          "sweepAppointmentNoShows",
          "runDailyClose",
        ]);

        scheduler.start();
        await jest.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
        await scheduler.stop();

        expect(invoked).toEqual(
          new Set([
            "runDispatchCycle",
            "runDueTimers",
            "sweepExpiredTempRoles",
            "sweepGuardianMajority",
            "sweepAppointmentNoShows",
            "runDailyClose",
          ]),
        );
        expect(scheduler.leakedErrors()).toEqual([]);
      } finally {
        jest.useRealTimers();
        for (const s of spies) s.mockRestore();
        await fresh.close();
      }
    });
  });

  // Flag 9 — stop() must await the in-flight run, and no rejection may leak. A deliberately
  // slow stub job (gated on a manually-controlled promise, not a real sleep) so the test
  // controls exactly when the run completes relative to stop().
  // D8/Global Constraint 11: sweep.failed is appended when a run THROWS, and there is NO
  // per-tick event on an ordinary successful run — the heartbeat row is the UPDATE. A stub
  // job that throws on its first invocation and succeeds afterwards proves both halves in one
  // test: exactly one sweep.failed row, never re-appended by the later successful ticks.
  it("appends sweep.failed when a job throws, and nothing per successful tick", async () => {
    const scheduler = new Scheduler(db, pool, stubLocks());
    let attempts = 0;
    scheduler.register({
      name: "throwing-stub",
      every: 5,
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("stub failure for sweep.failed");
      },
    });

    scheduler.start();
    try {
      const deadline = Date.now() + 2000;
      while (attempts < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(attempts).toBeGreaterThanOrEqual(3); // at least one failing tick, then successful ones
    } finally {
      await scheduler.stop();
    }

    const failed = await db.select().from(events).where(eq(events.name, "sweep.failed"));
    expect(failed).toHaveLength(1); // the one throw — NOT one per tick
    const payload = failed[0]!.payload as { job: string; error: string; durationMs: number };
    expect(payload.job).toBe("throwing-stub");
    expect(payload.error).toBe("stub failure for sweep.failed");
    expect(typeof payload.durationMs).toBe("number");

    const [hb] = await db
      .select()
      .from(schedulerHeartbeats)
      .where(eq(schedulerHeartbeats.job, "throwing-stub"));
    expect(hb?.lastOkAt).not.toBeNull(); // a later successful tick cleared the error state
    expect(hb?.lastError).toBeNull();
  });

  it("stop() awaits an in-flight run before resolving, and leaks no rejection", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const scheduler = new Scheduler(db, pool, stubLocks());
    scheduler.register({
      name: "slow-stub",
      every: 5,
      run: async () => {
        order.push("start");
        await gate;
        order.push("end");
      },
    });

    try {
      scheduler.start();

      // Real timers here — no jest.useFakeTimers active in this test. Poll for the tick to
      // have actually started; this is a sequencing wait, not a timing assertion (Global
      // Constraint 10 forbids gating on wall-clock mean/median, not on "has X happened yet").
      const deadline = Date.now() + 2000;
      while (!order.includes("start") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(order).toContain("start");

      let stopped = false;
      const stopPromise = scheduler.stop().then(() => {
        stopped = true;
      });
      await new Promise((r) => setImmediate(r));
      expect(stopped).toBe(false); // the run is still gated — stop() must not have resolved yet

      order.push("release");
      release();
      await stopPromise;

      expect(stopped).toBe(true);
      expect(order).toEqual(["start", "release", "end"]);
      expect(scheduler.leakedErrors()).toEqual([]);
    } finally {
      await scheduler.stop();
    }
  });
});
