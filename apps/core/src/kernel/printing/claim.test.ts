import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import { printJobs } from "../db/schema";
import { claimPrintJobs, LEASE_SECONDS, MAX_ATTEMPTS, reportFailed, reportPrinted } from "./claim";
import { enqueuePrintJob } from "./enqueue";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-24 T2 — THE CLAIM
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The queue is in Helsinki and the relay is in Hajipur, so every row here is about what happens
 * when that link, or the relay itself, fails at the worst moment.
 */
describe("FD-24 T2: claiming print jobs", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); });

  async function queue(key: string, document: "opd_token_slip" | "opd_prescription" = "opd_token_slip"): Promise<string> {
    const id = await withTx(db, (tx) => enqueuePrintJob(tx, {
      document, params: { encounterId: key }, dedupeKey: key,
    }));
    return id!;
  }

  it("claims due jobs for the destinations this relay serves, oldest first", async () => {
    await queue("a");
    await queue("b");
    const got = await claimPrintJobs(db, { relayId: "relay-1", destinations: ["front_desk_thermal"], limit: 10 });

    expect(got.map((j) => j.params["encounterId"])).toEqual(["a", "b"]);
    expect(got[0]!.document).toBe("opd_token_slip");
  });

  /**
   * A relay that claimed a printer it cannot reach would take the slip OUT of the queue and then
   * fail it, burning an attempt for a reason that has nothing to do with the printer.
   */
  it("never claims a destination the relay does not serve", async () => {
    await queue("rx", "opd_prescription"); // front_desk_a4
    const got = await claimPrintJobs(db, { relayId: "thermal-only", destinations: ["front_desk_thermal"], limit: 10 });

    expect(got).toEqual([]);
    expect((await db.select().from(printJobs))[0]!.status).toBe("queued"); // still waiting for its own relay
  });

  /** Two relays, one slip. `FOR UPDATE SKIP LOCKED` is what makes this a race nobody loses twice. */
  it("two relays claiming at once do not both get the same job", async () => {
    await queue("only-one");
    const [first, second] = await Promise.all([
      claimPrintJobs(db, { relayId: "r1", destinations: ["front_desk_thermal"], limit: 10 }),
      claimPrintJobs(db, { relayId: "r2", destinations: ["front_desk_thermal"], limit: 10 }),
    ]);
    expect(first.length + second.length).toBe(1);
  });

  /**
   * ═══ THE LEASE, WHICH IS THE WHOLE REASON THIS IS NOT `notify`'s PUMP ═══
   *
   * A relay switched off mid-job would otherwise leave the row `claimed` for ever, and the slip
   * nobody is printing is the one nobody notices. The failure mode is a DUPLICATE slip, not a
   * missing one, and that is the right way round: a clerk throws one away, a patient without a
   * token stands at a counter that believes it printed.
   */
  it("a lapsed lease makes the job claimable again — a dead relay strands nothing", async () => {
    await queue("stranded");
    const t0 = new Date();
    const first = await claimPrintJobs(db, { relayId: "dying", destinations: ["front_desk_thermal"], limit: 10, now: t0 });
    expect(first).toHaveLength(1);

    // still held while the lease runs
    const tooSoon = new Date(t0.getTime() + (LEASE_SECONDS - 5) * 1000);
    expect(await claimPrintJobs(db, { relayId: "next", destinations: ["front_desk_thermal"], limit: 10, now: tooSoon })).toEqual([]);

    // THE KILL — without lease recovery this stays empty for ever and the slip never prints
    const after = new Date(t0.getTime() + (LEASE_SECONDS + 5) * 1000);
    const retaken = await claimPrintJobs(db, { relayId: "next", destinations: ["front_desk_thermal"], limit: 10, now: after });
    expect(retaken).toHaveLength(1);
    expect((await db.select().from(printJobs))[0]!.claimedBy).toBe("next");
  });

  it("reports paper, and only the relay that holds the job may", async () => {
    const id = await queue("mine");
    await claimPrintJobs(db, { relayId: "r1", destinations: ["front_desk_thermal"], limit: 10 });

    expect(await reportPrinted(db, id, "somebody-else")).toBe(false); // not yours to report
    expect(await reportPrinted(db, id, "r1")).toBe(true);

    const row = (await db.select().from(printJobs).where(eq(printJobs.id, id)))[0]!;
    expect(row.status).toBe("printed");
    expect(row.printedAt).not.toBeNull();
  });

  /**
   * THE LATE REPORT. A relay whose lease lapsed, whose job another relay then took and printed,
   * comes back and says "done" — or "failed". Neither may overwrite the winner's result.
   */
  it("a relay whose lease lapsed cannot overwrite the result of the relay that took over", async () => {
    const id = await queue("handover");
    const t0 = new Date();
    await claimPrintJobs(db, { relayId: "slow", destinations: ["front_desk_thermal"], limit: 10, now: t0 });
    const after = new Date(t0.getTime() + (LEASE_SECONDS + 5) * 1000);
    await claimPrintJobs(db, { relayId: "fast", destinations: ["front_desk_thermal"], limit: 10, now: after });
    expect(await reportPrinted(db, id, "fast")).toBe(true);

    // the slow relay finally reports — and changes nothing
    expect(await reportFailed(db, id, "slow", "printer offline")).toBe("not_claimed");
    const row = (await db.select().from(printJobs).where(eq(printJobs.id, id)))[0]!;
    expect(row.status).toBe("printed");
    expect(row.lastError).toBeNull();
  });

  /**
   * R7 — a failure is ADVISORY AND TERMINAL at the cap. It retries a couple of times, then stops and
   * lets the screen tell the clerk. Retrying a jammed printer twenty times delays the honest
   * message without making paper appear.
   */
  it("a failure requeues with a backoff, then gives up at the cap and stays given up", async () => {
    const id = await queue("jammed");
    for (let n = 1; n < MAX_ATTEMPTS; n += 1) {
      await claimPrintJobs(db, { relayId: "r1", destinations: ["front_desk_thermal"], limit: 10 });
      expect(await reportFailed(db, id, "r1", `jam ${String(n)}`)).toBe("requeued");
      const mid = (await db.select().from(printJobs).where(eq(printJobs.id, id)))[0]!;
      expect(mid.status).toBe("queued");
      expect(mid.attempts).toBe(n);
      expect(mid.nextAttemptAt).not.toBeNull(); // held back, not hammered
      // clear the backoff so the next claim in this test is due
      await db.update(printJobs).set({ nextAttemptAt: null }).where(eq(printJobs.id, id));
    }

    await claimPrintJobs(db, { relayId: "r1", destinations: ["front_desk_thermal"], limit: 10 });
    expect(await reportFailed(db, id, "r1", "out of paper")).toBe("failed");

    const row = (await db.select().from(printJobs).where(eq(printJobs.id, id)))[0]!;
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe("out of paper");
    expect(row.nextAttemptAt).toBeNull();
    // THE KILL for a `failed` row that is still claimable — it must not loop for ever
    expect(await claimPrintJobs(db, { relayId: "r1", destinations: ["front_desk_thermal"], limit: 10 })).toEqual([]);
  });

  it("a backoff is respected — a requeued job is not claimable until it is due", async () => {
    const id = await queue("held");
    const t0 = new Date();
    await claimPrintJobs(db, { relayId: "r1", destinations: ["front_desk_thermal"], limit: 10, now: t0 });
    await reportFailed(db, id, "r1", "jam", t0);

    expect(await claimPrintJobs(db, { relayId: "r1", destinations: ["front_desk_thermal"], limit: 10, now: t0 })).toEqual([]);
    const later = new Date(t0.getTime() + 31_000);
    expect(await claimPrintJobs(db, { relayId: "r1", destinations: ["front_desk_thermal"], limit: 10, now: later })).toHaveLength(1);
  });
});
