import { eq } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";
import type { Db } from "../db/client";
import { withTx } from "../db/client";
import { schedulerHeartbeats } from "../db/schema";
import { appendEvent } from "../events/append";
import { sweepFailed } from "./events";

// D2 (FORK-B, RESOLVED — the advisory-lock interval loop; see the plan's Spike verdicts
// block): two job kinds, `every(ms)` and `dailyIst("HH:MM")`. Every job runs as `run(now)`
// (Global Constraint 9 applied to the scheduler's own contract) behind: a per-job in-process
// re-entrancy guard (the tail's `polling` pattern, so a slow run is never overlapped by its
// own next tick), an advisory lock that is noise-reduction ONLY (D3 — no sweep's correctness
// ever depends on it; every sweep is already idempotent and multi-process-safe on its own),
// and a heartbeat row upserted on start/ok/error. A run that throws appends `sweep.failed`;
// there is NO per-tick event (D7/Global Constraint 11 — the heartbeat is the UPDATE).
export type JobRun = (now: Date) => Promise<void>;

type EverySpec = { name: string; every: number; run: JobRun };
type DailyIstSpec = { name: string; dailyIst: string; run: JobRun };
export type JobSpec = EverySpec | DailyIstSpec;

export type Locks = {
  tryLock(name: string): Promise<boolean>;
  unlock(name: string): Promise<void>;
};

/**
 * D2/D3: noise-reduction only. `pg_try_advisory_lock(hashtext(...))` is proven present,
 * stable and session-scoped on this exact server (spike B2: one winner, the loser returns
 * `false` after ~1 ms without waiting, released by graceful `end()` or by
 * `pg_terminate_backend`). Advisory locks are SESSION-scoped, so the winner holds ONE
 * checked-out client for the lock's whole lifetime — releasing the client back to the pool
 * without unlocking would leave the lock held until that connection happens to close. The
 * loser's client is released immediately; it never waits.
 */
export function pgLocks(pool: Pool): Locks {
  const held = new Map<string, PoolClient>();
  return {
    async tryLock(name: string): Promise<boolean> {
      const client = await pool.connect();
      const { rows } = await client.query<{ won: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)) as won",
        [name],
      );
      if (rows[0]?.won === true) {
        held.set(name, client);
        return true;
      }
      client.release();
      return false;
    },
    async unlock(name: string): Promise<void> {
      const client = held.get(name);
      if (!client) return;
      held.delete(name);
      try {
        await client.query("select pg_advisory_unlock(hashtext($1))", [name]);
      } finally {
        client.release();
      }
    },
  };
}

const WORKER_ACTOR = { type: "system" as const, id: "worker-scheduler" };
const IST_OFFSET_MS = 330 * 60_000; // IST is a fixed UTC+05:30 design-law constant (no DST) — see kernel/approvals/cumulative.ts's istDayWindow for the same fact, kept local here rather than imported so the scheduler carries no dependency on another kernel surface for one constant.
const DAY_MS = 24 * 60 * 60_000;

function istDayIndex(d: Date): number {
  return Math.floor((d.getTime() + IST_OFFSET_MS) / DAY_MS);
}

function istHourMinute(d: Date): { hour: number; minute: number } {
  const minutesOfDay = Math.floor((d.getTime() + IST_OFFSET_MS) / 60_000) % (24 * 60);
  return { hour: Math.floor(minutesOfDay / 60), minute: minutesOfDay % 60 };
}

function parseDailyIst(spec: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(spec);
  if (!m) throw new Error(`invalid dailyIst spec: "${spec}" (expected "HH:MM")`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

type Registered = {
  spec: JobSpec;
  hour?: number;
  minute?: number;
  timer: NodeJS.Timeout | null;
  running: boolean;
  inFlight: Promise<void> | null;
};

export class Scheduler {
  private readonly jobsByName = new Map<string, Registered>();
  private dailyTimer: NodeJS.Timeout | null = null;
  private readonly leaked: unknown[] = [];

  constructor(
    private readonly db: Db,
    pool: Pool,
    private readonly locks: Locks = pgLocks(pool),
    private readonly dailyTickMs: number = 30_000,
  ) {}

  register(spec: JobSpec): void {
    if (this.jobsByName.has(spec.name)) {
      throw new Error(`duplicate job name: ${spec.name}`);
    }
    const entry: Registered = { spec, timer: null, running: false, inFlight: null };
    if ("dailyIst" in spec) {
      const { hour, minute } = parseDailyIst(spec.dailyIst);
      entry.hour = hour;
      entry.minute = minute;
    }
    this.jobsByName.set(spec.name, entry);
  }

  /** The census surface — registered job names, in registration order. */
  jobs(): string[] {
    return [...this.jobsByName.keys()];
  }

  /**
   * Rejections a fire-and-forget tick would otherwise have left UNHANDLED — captured at the
   * source rather than at the process boundary. jest-environment-node gives each test file a
   * sandboxed `process`, so a `process.on("unhandledRejection", …)` a test installs cannot
   * observe what the REAL node process saw (EXECUTION-LESSONS 2.17); this array is read
   * directly instead. Always empty in normal operation — `executeJob` below never rethrows
   * (a thrown run is caught, heartbeated as an error, and reported via `sweep.failed`), and
   * every fire-and-forget call in `start()`/`dailyTick()` is `.catch()`-guarded regardless.
   */
  leakedErrors(): readonly unknown[] {
    return this.leaked;
  }

  start(): void {
    for (const job of this.jobsByName.values()) {
      if ("every" in job.spec) {
        const t = setInterval(() => {
          this.runTick(job).catch((err: unknown) => { this.leaked.push(err); });
        }, job.spec.every);
        t.unref();
        job.timer = t;
      }
    }
    const dt = setInterval(() => {
      this.dailyTick().catch((err: unknown) => { this.leaked.push(err); });
    }, this.dailyTickMs);
    dt.unref();
    this.dailyTimer = dt;
  }

  /** Awaits any in-flight run before resolving (flag 9) — never leaves a sweep mid-write when the caller then closes the pool. */
  async stop(): Promise<void> {
    for (const job of this.jobsByName.values()) {
      if (job.timer) { clearInterval(job.timer); job.timer = null; }
    }
    if (this.dailyTimer) { clearInterval(this.dailyTimer); this.dailyTimer = null; }
    await Promise.all([...this.jobsByName.values()].map((j) => j.inFlight ?? Promise.resolve()));
  }

  private async dailyTick(): Promise<void> {
    const now = new Date();
    for (const job of this.jobsByName.values()) {
      if (!("dailyIst" in job.spec)) continue;
      if (job.running) continue; // cheap skip — the definitive guard is in runTick()
      if (await this.isDailyDue(job, now)) {
        this.runTick(job).catch((err: unknown) => { this.leaked.push(err); });
      }
    }
  }

  // D2: a daily job fires on the first ticker tick where `now` is past today's IST instant
  // AND the freshest successful run's IST day is before today's — the heartbeat row IS the
  // daily memory (self-review item 8: keyed on last_ok_at, never last_started_at, so a
  // FAILED daily run retries on the next tick instead of waiting until tomorrow).
  private async isDailyDue(job: Registered, now: Date): Promise<boolean> {
    const { hour, minute } = istHourMinute(now);
    const pastInstant = hour > job.hour! || (hour === job.hour! && minute >= job.minute!);
    if (!pastInstant) return false;
    const [hb] = await this.db
      .select({ lastOkAt: schedulerHeartbeats.lastOkAt })
      .from(schedulerHeartbeats)
      .where(eq(schedulerHeartbeats.job, job.spec.name));
    if (!hb?.lastOkAt) return true; // never succeeded — always due once past the instant
    return istDayIndex(hb.lastOkAt) < istDayIndex(now);
  }

  private async runTick(job: Registered): Promise<void> {
    if (job.running) return; // per-job re-entrancy guard — a slow run is never overlapped by its own next tick
    job.running = true;
    const run = this.executeJob(job);
    job.inFlight = run;
    try {
      await run;
    } finally {
      job.running = false;
      job.inFlight = null;
    }
  }

  private async executeJob(job: Registered): Promise<void> {
    const lockName = `job:${job.spec.name}`;
    const won = await this.locks.tryLock(lockName);
    if (!won) return; // another process holds this job's lock this tick — skip silently (D3)
    try {
      const startedAt = new Date();
      await this.db
        .insert(schedulerHeartbeats)
        .values({ job: job.spec.name, lastStartedAt: startedAt })
        .onConflictDoUpdate({ target: schedulerHeartbeats.job, set: { lastStartedAt: startedAt } });
      const t0 = Date.now();
      try {
        await job.spec.run(startedAt);
        await this.db
          .update(schedulerHeartbeats)
          .set({ lastOkAt: new Date(), lastDurationMs: Date.now() - t0, lastError: null })
          .where(eq(schedulerHeartbeats.job, job.spec.name));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.db
          .update(schedulerHeartbeats)
          .set({ lastError: message, lastDurationMs: Date.now() - t0 })
          .where(eq(schedulerHeartbeats.job, job.spec.name));
        await withTx(this.db, (tx) => appendEvent(tx, sweepFailed.make({
          actor: WORKER_ACTOR,
          payload: { job: job.spec.name, error: message, durationMs: Date.now() - t0 },
        })));
      }
    } finally {
      await this.locks.unlock(lockName);
    }
  }
}
