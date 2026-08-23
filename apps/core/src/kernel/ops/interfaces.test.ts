import { asc, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, interfaces } from "../db/schema";
import {
  INTERFACE_STALE_AFTER_DEFAULT_MS,
  InterfaceError,
  deactivateInterface,
  listInterfaces,
  recordHeartbeat,
  registerInterface,
  sweepInterfaceHeartbeats,
} from "./interfaces";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";
import type { InterfaceView } from "./interfaces";

/** A device agent, not a person. 12a's agent grants are the future tightening (D6 / the route comment). */
const DEVICE: Actor = { type: "agent", id: "01HDEVICEAGENT0000000000001" };
const OPERATOR: Actor = { type: "user", id: "01HOPSOPERATOR000000000001" };

/** Every instant in this suite is derived from this pin — nothing reads the wall clock (§3.31). */
const NOW = new Date("2026-08-23T09:00:00.000Z");
const MINUTE = 60_000;
const before = (ms: number): Date => new Date(NOW.getTime() - ms);

describe("kernel ops — interface heartbeats, the tenth job (11c D6)", () => {
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
  });

  /** Register, then force the row into an arbitrary observed state — the fixture, stated in SQL. */
  const seed = async (input: {
    name: string;
    staleAfterMs?: number;
    status?: "unknown" | "up" | "down";
    lastSeenAt?: Date | null;
    active?: boolean;
  }): Promise<InterfaceView> => {
    const view = await registerInterface(
      db,
      {
        kind: "printer",
        name: input.name,
        location: "opd-desk-1",
        staleAfterMs: input.staleAfterMs ?? INTERFACE_STALE_AFTER_DEFAULT_MS,
      },
      NOW,
    );
    if (input.status !== undefined || input.lastSeenAt !== undefined || input.active !== undefined) {
      await db
        .update(interfaces)
        .set({
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.lastSeenAt === undefined ? {} : { lastSeenAt: input.lastSeenAt }),
          ...(input.active === undefined ? {} : { active: input.active }),
        })
        .where(eq(interfaces.id, view.id));
    }
    return view;
  };

  const rowOf = async (id: string): Promise<typeof interfaces.$inferSelect> =>
    (await db.select().from(interfaces).where(eq(interfaces.id, id)))[0]!;

  const eventsNamed = async (
    name: "interface.down" | "interface.restored",
  ): Promise<{ payload: Record<string, unknown> }[]> =>
    (await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.name, name))
      .orderBy(asc(events.seq))) as { payload: Record<string, unknown> }[];

  // ───────────────────────────── registration — the seam's front door ─────────────────────────

  it("registers a device as `unknown` with NO sighting and NO event — a registration is not a liveness fact", async () => {
    const view = await registerInterface(
      db,
      { kind: "scanner", name: "Front-desk scanner", location: null, staleAfterMs: 30_000 },
      NOW,
    );

    expect(view).toEqual(
      expect.objectContaining({
        kind: "scanner",
        name: "Front-desk scanner",
        location: null,
        staleAfterMs: 30_000,
        status: "unknown",
        lastSeenAt: null,
        active: true,
      }),
    );
    // The catalog's no-per-run-noise rule: the two names this plan adds are the LIVENESS EDGES.
    expect(await eventsNamed("interface.down")).toEqual([]);
    expect(await eventsNamed("interface.restored")).toEqual([]);
  });

  it("lists in `seq` order and deactivation is a population change, never a status rewrite", async () => {
    const a = await seed({ name: "A", status: "up", lastSeenAt: before(MINUTE) });
    const b = await seed({ name: "B" });

    expect((await listInterfaces(db)).map((i) => i.name)).toEqual(["A", "B"]);

    const retired = await deactivateInterface(db, a.id);
    expect(retired.active).toBe(false);
    // `up` SURVIVES retirement: rewriting it would either invent an outage or erase a real one.
    expect(retired.status).toBe("up");
    expect((await rowOf(b.id)).active).toBe(true);

    await expect(deactivateInterface(db, "01HNOSUCHINTERFACE000000001")).rejects.toBeInstanceOf(
      InterfaceError,
    );
  });

  // ───────────────────────────────────── V9 — the sweep ─────────────────────────────────────

  it("V9: downs ONLY the stale `up` row, against ITS OWN stale_after_ms, and events exactly that one", async () => {
    // BOTH rows were last seen at the SAME instant, ten minutes ago. The only thing separating
    // them is their own window — so an implementation that compared against any global constant,
    // or that dropped the comparison altogether, cannot produce this result.
    const stale = await seed({
      name: "Label printer",
      staleAfterMs: 3 * MINUTE,
      status: "up",
      lastSeenAt: before(10 * MINUTE),
    });
    const patient = await seed({
      name: "Lab analyser",
      staleAfterMs: 60 * MINUTE,
      status: "up",
      lastSeenAt: before(10 * MINUTE),
    });

    const downed = await sweepInterfaceHeartbeats(db, NOW);

    expect(downed.map((d) => d.interfaceId)).toEqual([stale.id]);
    expect((await rowOf(stale.id)).status).toBe("down");
    expect((await rowOf(patient.id)).status).toBe("up");
    // The sighting is NOT erased by the down: it is the instant the outage is measured from.
    expect((await rowOf(stale.id)).lastSeenAt).toEqual(before(10 * MINUTE));

    const appended = await eventsNamed("interface.down");
    expect(appended).toHaveLength(1);
    expect(appended[0]!.payload).toEqual({
      interfaceId: stale.id,
      kind: "printer",
      name: "Label printer",
      lastSeenAt: before(10 * MINUTE).toISOString(),
      staleAfterMs: 3 * MINUTE,
    });
  });

  it("V9: the comparison is STRICT — a device seen exactly `stale_after_ms` ago is not yet late", async () => {
    const edge = await seed({
      name: "Edge printer",
      staleAfterMs: 5 * MINUTE,
      status: "up",
      lastSeenAt: before(5 * MINUTE),
    });

    expect(await sweepInterfaceHeartbeats(db, NOW)).toEqual([]);
    expect((await rowOf(edge.id)).status).toBe("up");

    // One millisecond further and it is late — the boundary is where it is claimed to be.
    expect(
      (await sweepInterfaceHeartbeats(db, new Date(NOW.getTime() + 1))).map((d) => d.interfaceId),
    ).toEqual([edge.id]);
  });

  it("V9: a retired device is not an outage, and an already-`down` device is not downed twice", async () => {
    const retired = await seed({
      name: "Retired printer",
      staleAfterMs: MINUTE,
      status: "up",
      lastSeenAt: before(60 * MINUTE),
      active: false,
    });
    const already = await seed({
      name: "Already down",
      staleAfterMs: MINUTE,
      status: "down",
      lastSeenAt: before(60 * MINUTE),
    });

    expect(await sweepInterfaceHeartbeats(db, NOW)).toEqual([]);
    expect((await rowOf(retired.id)).status).toBe("up");
    expect((await rowOf(already.id)).status).toBe("down");
    // A second sweep over an already-down device would otherwise re-alert on every 60 s tick.
    expect(await eventsNamed("interface.down")).toEqual([]);
  });

  // ──────────────────────────── V10 — never seen is never downed ────────────────────────────

  it("V10: a registered-but-NEVER-SEEN device stays `unknown` forever and appends nothing", async () => {
    const virgin = await seed({ name: "Never plugged in", staleAfterMs: 30_000 });
    // The fixture proof (§2.6): the field that would have made it appear is genuinely absent.
    expect((await rowOf(virgin.id)).lastSeenAt).toBeNull();
    expect((await rowOf(virgin.id)).status).toBe("unknown");

    // Hours past any window. `unknown` is not `down`: nothing has been lost, so nothing is said.
    const hoursLater = new Date(NOW.getTime() + 6 * 60 * MINUTE);
    expect(await sweepInterfaceHeartbeats(db, hoursLater)).toEqual([]);

    expect((await rowOf(virgin.id)).status).toBe("unknown");
    expect((await rowOf(virgin.id)).lastSeenAt).toBeNull();
    expect(await eventsNamed("interface.down")).toEqual([]);
  });

  // ───────────────────── V11 — the heartbeat, and which edge is loud ─────────────────────

  it("V11: a heartbeat on a DOWN device restores it to `up` and appends exactly one interface.restored", async () => {
    const printer = await seed({
      name: "Label printer",
      staleAfterMs: 3 * MINUTE,
      status: "up",
      lastSeenAt: before(10 * MINUTE),
    });
    // Forced down through the SHIPPED sweep, not by hand — the fixture is the real edge.
    expect((await sweepInterfaceHeartbeats(db, NOW)).map((d) => d.interfaceId)).toEqual([printer.id]);
    expect((await rowOf(printer.id)).status).toBe("down");

    const seenAt = new Date(NOW.getTime() + MINUTE);
    const result = await recordHeartbeat(db, DEVICE, printer.id, seenAt);

    // BOTH columns, deliberately: the killing mutant for this row moves `last_seen_at` and leaves
    // `status` alone, and a test that asserted only the timestamp would never see it.
    expect(result).toEqual(
      expect.objectContaining({ interfaceId: printer.id, status: "up", restored: true }),
    );
    expect(result.eventId).not.toBeNull();
    const row = await rowOf(printer.id);
    expect(row.status).toBe("up");
    expect(row.lastSeenAt).toEqual(seenAt);

    const restored = await eventsNamed("interface.restored");
    expect(restored).toHaveLength(1);
    expect(restored[0]!.payload).toEqual({
      interfaceId: printer.id,
      kind: "printer",
      name: "Label printer",
      seenAt: seenAt.toISOString(),
      downSince: before(10 * MINUTE).toISOString(),
    });
  });

  it("V11 control: `unknown → up` is SILENT, and so is `up → up`", async () => {
    const fresh = await seed({ name: "Newly commissioned" });

    const first = await recordHeartbeat(db, DEVICE, fresh.id, NOW);
    expect(first).toEqual(
      expect.objectContaining({ status: "up", restored: false, eventId: null }),
    );
    expect((await rowOf(fresh.id)).status).toBe("up");
    expect((await rowOf(fresh.id)).lastSeenAt).toEqual(NOW);

    const again = new Date(NOW.getTime() + MINUTE);
    expect(await recordHeartbeat(db, DEVICE, fresh.id, again)).toEqual(
      expect.objectContaining({ status: "up", restored: false, eventId: null }),
    );
    expect((await rowOf(fresh.id)).lastSeenAt).toEqual(again);

    // The whole point of the control: neither edge is an event, so a device that is simply
    // working does not append one row per minute per device forever.
    expect(await eventsNamed("interface.restored")).toEqual([]);
    expect(await eventsNamed("interface.down")).toEqual([]);
  });

  it("V11: a heartbeat for an id that does not exist is a refusal, not a silent no-op", async () => {
    await expect(
      recordHeartbeat(db, OPERATOR, "01HNOSUCHINTERFACE000000001", NOW),
    ).rejects.toBeInstanceOf(InterfaceError);
    expect(await db.select().from(interfaces)).toEqual([]);
  });

  it("V9+V11: down and back again — the full outage cycle leaves one event of each name", async () => {
    const printer = await seed({
      name: "Ward printer",
      staleAfterMs: 2 * MINUTE,
      status: "up",
      lastSeenAt: before(5 * MINUTE),
    });

    await sweepInterfaceHeartbeats(db, NOW);
    await recordHeartbeat(db, DEVICE, printer.id, new Date(NOW.getTime() + MINUTE));
    // A sweep immediately after the restore finds it fresh and says nothing.
    expect(await sweepInterfaceHeartbeats(db, new Date(NOW.getTime() + MINUTE))).toEqual([]);

    expect(await eventsNamed("interface.down")).toHaveLength(1);
    expect(await eventsNamed("interface.restored")).toHaveLength(1);
    expect((await rowOf(printer.id)).status).toBe("up");
  });

  // ───────── V20 / V21 (11d T6, D10) — the heartbeat/sweep race, and §3.44's control ─────────
  //
  // THE DEFECT THE NEW TERM CLOSES. `sweepInterfaceHeartbeats` chooses its candidates OUTSIDE any
  // transaction and then claims each one INSIDE its own, and between those two moments a live
  // device can say "I am here". `recordHeartbeat` takes `FOR UPDATE`, so the two DO serialise —
  // they simply serialised on a predicate (`status = 'up'`) that a heartbeat does not disturb, so
  // the claim still matched after the wait and a WORKING printer was marked `down` with a false
  // `interface.down`. The fix is one term: `last_seen_at` must still be the instant the candidate
  // read saw, so a moved sighting loses the claim exactly as a moved status already does.
  //
  // The two tests below are the pair §3.44 asks for, and they are not interchangeable:
  //   V20 — the refusal HAPPENS (measured, a floor of rounds, never an engineered window).
  //   V21 — the refusal happens to NOTHING ELSE. It is a REQUIRED GREEN, not a mutant: a
  //         predicate one term too wide would leave every stale printer `up` for ever and would
  //         still pass every other row in this file, because they exercise the defect's own path.
  //
  // MINOR only for as long as `interface.down` has no subscriber. Plan 11b puts real printers on
  // this seam, which is why the fix lands now rather than on a deferred list.

  const downsFor = async (id: string): Promise<{ payload: Record<string, unknown> }[]> =>
    (await eventsNamed("interface.down")).filter((e) => e.payload.interfaceId === id);

  const restoresFor = async (id: string): Promise<{ payload: Record<string, unknown> }[]> =>
    (await eventsNamed("interface.restored")).filter((e) => e.payload.interfaceId === id);

  it("V20: a heartbeat landing mid-sweep is never overwritten by a false interface.down", async () => {
    // A FLOOR, NOT A TARGET (§3.22 / GC8). THE WINDOW IS NOT ENGINEERED: the sweep is started and
    // the heartbeat is started, in that order, in the same tick, on two pool connections, and
    // whatever those two then do to each other is what is measured. No barrier, no injected
    // delay, no instrumented seam. Each round's outcome is CLASSIFIED and the split is printed,
    // because "zero false downs" over a race that never raced would be a green worth nothing.
    const ROUNDS = 15;
    const outcomes: string[] = [];

    for (let i = 0; i < ROUNDS; i += 1) {
      const target = await seed({
        name: `Racing printer ${i}`,
        staleAfterMs: 3 * MINUTE,
        status: "up",
        lastSeenAt: before(10 * MINUTE),
      });
      // The row nobody heard from — same sweep, same arithmetic, no heartbeat. §3.44's control,
      // carried by EVERY round rather than by one test at the end.
      const silent = await seed({
        name: `Silent printer ${i}`,
        staleAfterMs: 3 * MINUTE,
        status: "up",
        lastSeenAt: before(10 * MINUTE),
      });

      const seenAt = new Date(NOW.getTime() + 1);
      const sweeping = sweepInterfaceHeartbeats(db, NOW);
      const beating = recordHeartbeat(db, DEVICE, target.id, seenAt);
      const [downed] = await Promise.all([sweeping, beating]);

      // The legitimate path, asserted inside the race rather than beside it: a predicate one
      // term too wide fails HERE, on round 1, and no mutant in the Book would have caught it.
      expect(downed.map((d) => d.interfaceId)).toContain(silent.id);
      expect((await rowOf(silent.id)).status).toBe("down");
      expect(await downsFor(silent.id)).toHaveLength(1);

      // §2.6 — the field that would make a false down APPEAR is confirmed present: the heartbeat
      // really landed, and it really moved the sighting. Without this the round could be green
      // because nothing happened at all.
      const row = await rowOf(target.id);
      expect(row.lastSeenAt).toEqual(seenAt);

      const downs = await downsFor(target.id);
      const restores = await restoresFor(target.id);
      if (row.status === "down") {
        // Alive, heard from, and marked down anyway. This is the defect and it is the only
        // outcome the fix forbids.
        outcomes.push("FALSE-DOWN");
      } else if (downs.length === 0 && restores.length === 0) {
        outcomes.push("heartbeat-kept-it-up");
      } else if (downs.length === 1 && restores.length === 1) {
        // The sweep genuinely won the ordering: at the instant it claimed, nothing had been heard
        // from this device for ten minutes, so `interface.down` was TRUE when it was appended and
        // the heartbeat that followed restored it and said so. Correct, not a defect — which is
        // why this test asserts the row is never LEFT down rather than that no event ever appends.
        outcomes.push("sweep-won-then-restored");
      } else {
        outcomes.push(`UNCLASSIFIED status=${row.status} downs=${downs.length} restores=${restores.length}`);
      }
    }

    const tally = (label: string): number => outcomes.filter((o) => o.startsWith(label)).length;
    const observed = {
      rounds: outcomes.length,
      falseDown: tally("FALSE-DOWN"),
      heartbeatKeptItUp: tally("heartbeat-kept-it-up"),
      sweepWonThenRestored: tally("sweep-won-then-restored"),
      unclassified: tally("UNCLASSIFIED"),
    };
    // The OBSERVED rate, printed on green as well as red — a measured row whose measurement is
    // only visible when it fails is not a measurement (the perf suites' convention).
    console.log(`V20 heartbeat/sweep race: ${JSON.stringify(observed)}`);

    expect({ rounds: observed.rounds, falseDown: observed.falseDown, unclassified: observed.unclassified })
      .toEqual({ rounds: ROUNDS, falseDown: 0, unclassified: 0 });

    // ANTI-VACUITY, and it is not an assertion about the fix: if the heartbeat never once got
    // ahead of the sweep's claim, this test has stopped racing and its green means nothing.
    expect(observed.heartbeatKeptItUp).toBeGreaterThan(0);
    // A PER-TEST BUDGET, DERIVED RATHER THAN CHOSEN (D11's discipline, not its number, and NEVER a
    // change to `jest.config.cjs`): fifteen rounds MEASURED at 864 ms on the build host, and D11
    // measured CI running the same kind of database walk ~13× slower — so the workspace default of
    // 15 000 ms would leave this row with almost no margin on CI, and every round here additionally
    // waits on a real row lock. 60 s is ~5× the CI-extrapolated figure and still short enough that
    // a genuine hang is a minute, not two.
  }, 60_000);

  it("V21 (§3.44's not-over-broad control — a REQUIRED GREEN, not a mutant): a device whose sighting has NOT moved is still downed, exactly once", async () => {
    // ADJACENT TO THE REFUSAL ON PURPOSE, on the three axes that could make one term too many
    // refuse legitimate work. A comfortably distant fixture — a hand-set timestamp on a lonely
    // row — would pass under a predicate that can never match anything, which is the failure
    // mode this control exists to catch.
    //
    //   1. THE SIGHTING WAS WRITTEN BY THE SHIPPED HEARTBEAT PATH and round-tripped through
    //      Postgres, not set by the fixture's own UPDATE. A term that cannot match a stored
    //      `timestamptz` — precision, timezone, the wrong column — leaves every stale printer
    //      `up` for ever, and a hand-set fixture is the one shape that would hide it. The instant
    //      carries sub-second digits for exactly that reason.
    //   2. THE ROW IS WRITTEN AGAIN IMMEDIATELY BEFORE THE SWEEP — a device agent's retry at the
    //      SAME instant. The row is touched; the SIGHTING is not. The new term keys on the
    //      sighting, so this must STILL be downed: "something wrote the row" is not the question.
    //   3. A NEIGHBOUR IS GENUINELY ALIVE in the same sweep, so the decision is being made across
    //      a real candidate set rather than on one row in isolation.
    const staleSeenAt = new Date(NOW.getTime() - 10 * MINUTE + 123);

    const quiet = await seed({ name: "Ward printer", staleAfterMs: 3 * MINUTE });
    await recordHeartbeat(db, DEVICE, quiet.id, staleSeenAt);
    await recordHeartbeat(db, DEVICE, quiet.id, staleSeenAt); // the retry: same instant, again
    expect((await rowOf(quiet.id)).lastSeenAt).toEqual(staleSeenAt);
    expect((await rowOf(quiet.id)).status).toBe("up");

    const alive = await seed({ name: "Front-desk printer", staleAfterMs: 3 * MINUTE });
    await recordHeartbeat(db, DEVICE, alive.id, NOW);

    const downed = await sweepInterfaceHeartbeats(db, NOW);

    expect(downed.map((d) => d.interfaceId)).toEqual([quiet.id]);
    expect((await rowOf(quiet.id)).status).toBe("down");
    expect((await rowOf(alive.id)).status).toBe("up");

    const appended = await eventsNamed("interface.down");
    expect(appended).toHaveLength(1);
    expect(appended[0]!.payload).toEqual({
      interfaceId: quiet.id,
      kind: "printer",
      name: "Ward printer",
      lastSeenAt: staleSeenAt.toISOString(),
      staleAfterMs: 3 * MINUTE,
    });

    // And the refusal did not turn into a re-alert loop on the other side: the next tick finds it
    // already `down` and says nothing more.
    expect(await sweepInterfaceHeartbeats(db, NOW)).toEqual([]);
    expect(await eventsNamed("interface.down")).toHaveLength(1);
  });
});
