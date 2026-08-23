import { asc, eq, gt, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import { downtimeFormCounters, downtimeKitRanges, events } from "../db/schema";
import { kitGenerated } from "./events";
import {
  DOWNTIME_FORM_KINDS, DowntimeKitError, KIT_QR_PREFIX, LOCK_ORDER, generateDowntimeKit,
  getKitPrintPayload, listDowntimeKits, verifyKitSerial,
} from "./downtime-kit";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";
import type { DowntimeFormKind, DowntimeKitRange, DowntimeKitRequest } from "./downtime-kit";

/**
 * PLAN 11c T4 — THE DOWNTIME KIT (D7 + D9).
 *
 * Book rows proved here: **V13** (concurrent generations yield pairwise DISJOINT ranges — the
 * MEASURED race, GC7 / §3.22), **V14** (sequential kits are contiguous: no gap, no overlap, and
 * the counters advance by exactly the total) and **V15** (a tampered QR fails verification, with
 * an untampered control that parses).
 *
 * EVERY INSTANT DERIVES FROM `NOW` (GC8 / §3.31). No fixture reads the wall clock and there is no
 * sleep anywhere in this file — V13's race is measured by running real concurrent transactions,
 * never by timing them.
 *
 * THE SIGNING KEY IS A FIXED TEST BUFFER, not the environment's. `getKitPrintPayload` takes the
 * key as an argument precisely so a test can choose one (see its own comment), and V15's
 * wrong-key leg needs two keys that are different by construction rather than by configuration.
 */
const NOW = new Date("2026-08-23T11:00:00.000Z");
const DUTY: Actor = { type: "user", id: "01HDUTYMANAGER000000000004" };
const KEY = Buffer.alloc(32, 0xa7);
const OTHER_KEY = Buffer.alloc(32, 0x5c);

const kit = (
  desks: { desk: string; counts: Partial<Record<DowntimeFormKind, number>> }[],
  note: string | null = null,
): DowntimeKitRequest => ({ note, desks });

describe("kernel ops — the downtime kit (11c D7/D9)", () => {
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

  const generate = (req: DowntimeKitRequest, now: Date = NOW) =>
    withTx(db, (tx) => generateDowntimeKit(tx, DUTY, req, now));

  const counters = async (): Promise<Record<string, number>> => {
    const rows = await db.select().from(downtimeFormCounters).orderBy(asc(downtimeFormCounters.formKind));
    return Object.fromEntries(rows.map((r) => [r.formKind, r.nextSerial]));
  };

  const rangeOf = (ranges: DowntimeKitRange[], desk: string, formKind: DowntimeFormKind): DowntimeKitRange => {
    const found = ranges.find((r) => r.desk === desk && r.formKind === formKind);
    if (found === undefined) throw new Error(`the kit carries no ${formKind} range for desk "${desk}"`);
    return found;
  };

  const eventHighWater = async (): Promise<number> => {
    const rows = await db.select({ seq: sql<number>`coalesce(max(${events.seq}), 0)` }).from(events);
    return Number(rows[0]?.seq ?? 0);
  };

  // ───────────────────────────── the counter is the kit's OWN (D7) ─────────────────────────────

  it("the counters are the kit's own three, keyed by form kind, and they start at 1", async () => {
    // The fixture proof (§3.14/§2.6): the table is EMPTY before the first generation, so the
    // serials below are allocated by this call and not inherited from a seed. If this stopped
    // holding, every boundary assertion in this file would be measuring something else.
    expect(await counters()).toEqual({});

    const a = await generate(kit([{ desk: "front-desk", counts: { registration: 3, consultation: 2, receipt: 1 } }]));

    expect(a.ranges.map((r) => [r.formKind, r.startSerial, r.endSerial])).toEqual([
      ["consultation", 1, 2],
      ["receipt", 1, 1],
      ["registration", 1, 3],
    ]);
    expect(await counters()).toEqual({ consultation: 3, receipt: 2, registration: 4 });
  });

  it("the lock order is a total order over the form_kind COLUMN, not the presentation constant", () => {
    // `DOWNTIME_FORM_KINDS` is presentation order (a desk uses registration first); `LOCK_ORDER`
    // is the sorted column values. Asserting they DIFFER is what makes this a real statement — if
    // somebody re-sorted the constant, the lock order must not move with it.
    expect([...DOWNTIME_FORM_KINDS]).toEqual(["registration", "consultation", "receipt"]);
    expect([...LOCK_ORDER]).toEqual(["consultation", "receipt", "registration"]);
    expect([...LOCK_ORDER]).toEqual([...LOCK_ORDER].sort());
  });

  it("the locks are taken in LOCK_ORDER whatever order the request names the kinds in", async () => {
    // Two requests whose `counts` objects are written in opposite key orders. Both produce ranges
    // in LOCK_ORDER, which is the observable half of "the lock order does not follow the request"
    // — the deadlock-freedom half is V13's concurrent run below, which spans all three counters.
    const a = await generate(kit([{ desk: "d1", counts: { receipt: 1, registration: 1, consultation: 1 } }]));
    const b = await generate(kit([{ desk: "d2", counts: { registration: 1, consultation: 1, receipt: 1 } }]));
    expect(a.ranges.map((r) => r.formKind)).toEqual(["consultation", "receipt", "registration"]);
    expect(b.ranges.map((r) => r.formKind)).toEqual(["consultation", "receipt", "registration"]);
  });

  // ───────────────────────────────────────── V14 ─────────────────────────────────────────────

  it("V14: kit B starts at kit A's end + 1 — no gap, no overlap, and the counter advanced by exactly the total", async () => {
    const a = await generate(kit([{ desk: "front-desk", counts: { registration: 10, receipt: 4 } }], "kit A"));
    const b = await generate(kit([{ desk: "billing-desk", counts: { registration: 6 } }], "kit B"));

    const aReg = rangeOf(a.ranges, "front-desk", "registration");
    const bReg = rangeOf(b.ranges, "billing-desk", "registration");

    // THE BOUNDARY, STATED AS ONE ARRAY so a failure prints both sides of it: [aStart, aEnd,
    // bStart, bEnd]. An off-by-one in either direction moves exactly one of these numbers.
    expect([aReg.startSerial, aReg.endSerial, bReg.startSerial, bReg.endSerial]).toEqual([1, 10, 11, 16]);
    expect(bReg.startSerial).toBe(aReg.endSerial + 1); // no gap AND no overlap, said directly
    expect([aReg.count, bReg.count]).toEqual([10, 6]);

    // The counter advanced by exactly the total handed out and not one serial more. `receipt`
    // moved by 4 and `consultation` was never touched, so it has no row at all.
    expect(await counters()).toEqual({ registration: 17, receipt: 5 });
  });

  it("V14's companion: within ONE kit, two desks carve the same block contiguously", async () => {
    const k = await generate(
      kit([
        { desk: "front-desk", counts: { registration: 3 } },
        { desk: "billing-desk", counts: { registration: 2 } },
      ]),
    );
    const front = rangeOf(k.ranges, "front-desk", "registration");
    const billing = rangeOf(k.ranges, "billing-desk", "registration");
    expect([front.startSerial, front.endSerial, billing.startSerial, billing.endSerial]).toEqual([1, 3, 4, 5]);
    expect(await counters()).toEqual({ registration: 6 });
  });

  it("the rows are what the ranges say — the kit is the DATABASE's record, not the return value", async () => {
    const k = await generate(kit([{ desk: "front-desk", counts: { registration: 2, receipt: 2 } }], "UPS failure"));

    const rows = await db
      .select()
      .from(downtimeKitRanges)
      .where(eq(downtimeKitRanges.kitId, k.id))
      .orderBy(asc(downtimeKitRanges.seq));
    expect(rows.map((r) => [r.desk, r.formKind, r.startSerial, r.endSerial])).toEqual([
      ["front-desk", "receipt", 1, 2],
      ["front-desk", "registration", 1, 2],
    ]);

    const listed = await listDowntimeKits(db);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: k.id, note: "UPS failure", generatedBy: DUTY.id, totalForms: 4 });
    expect(listed[0]!.generatedAt).toBe(NOW.toISOString());
  });

  it("listDowntimeKits is newest-first by seq — the kit generated during THIS outage, not the last drill", async () => {
    const first = await generate(kit([{ desk: "d1", counts: { receipt: 1 } }], "drill"));
    const second = await generate(kit([{ desk: "d2", counts: { receipt: 1 } }], "the outage"));
    expect((await listDowntimeKits(db)).map((k) => k.id)).toEqual([second.id, first.id]);
  });

  // ───────────────────────────────── the event (downtime.kit_generated) ────────────────────────

  it("downtime.kit_generated is appended once, carries the per-kind blocks, and names no patient", async () => {
    const before = await eventHighWater();
    const k = await generate(
      kit([
        { desk: "front-desk", counts: { registration: 5, receipt: 5 } },
        { desk: "billing-desk", counts: { receipt: 3 } },
      ]),
      NOW,
    );

    const rows = await db.select().from(events).where(gt(events.seq, before)).orderBy(asc(events.seq));
    expect(rows.map((r) => r.name)).toEqual(["downtime.kit_generated"]);
    expect(kitGenerated.name).toBe("downtime.kit_generated");
    expect(kitGenerated.module).toBe("ops");
    expect(rows[0]!.eventId).toBe(k.eventId);
    expect(rows[0]!.patientId).toBeNull(); // GC6 — a kit is issued to a DESK
    expect(rows[0]!.payload).toEqual({
      kitId: k.id,
      note: null,
      deskCount: 2,
      totalForms: 13,
      // Per-KIND blocks, in LOCK_ORDER — the whole kit's reservation, not the per-desk carve-up.
      blocks: [
        { formKind: "receipt", startSerial: 1, endSerial: 8, count: 8 },
        { formKind: "registration", startSerial: 1, endSerial: 5, count: 5 },
      ],
    });
  });

  // ───────────────────────────────────── the two refusals ──────────────────────────────────────

  it("a kit that reserves nothing is refused, and no counter moves", async () => {
    await expect(generate(kit([{ desk: "front-desk", counts: {} }]))).rejects.toMatchObject({
      code: "downtime_kit_empty",
    });
    await expect(generate(kit([{ desk: "front-desk", counts: { registration: 0 } }]))).rejects.toBeInstanceOf(
      DowntimeKitError,
    );
    expect(await counters()).toEqual({});
  });

  it("the same desk twice in one kit is refused BEFORE any counter moves", async () => {
    await expect(
      generate(
        kit([
          { desk: "front-desk", counts: { registration: 2 } },
          { desk: "front-desk", counts: { receipt: 2 } },
        ]),
      ),
    ).rejects.toMatchObject({ code: "downtime_kit_duplicate_desk" });
    // The refusal is cheap AND clean: the transaction never advanced a counter, so a mistyped
    // request costs no serials even though a rollback would also have undone them.
    expect(await counters()).toEqual({});
  });

  it("getKitPrintPayload refuses an unknown kit rather than returning an empty one", async () => {
    await expect(getKitPrintPayload(db, KEY, "01HNOSUCHKIT00000000000000")).rejects.toMatchObject({
      code: "downtime_kit_not_found",
    });
  });

  // ───────────────────────────────────────── V15 ─────────────────────────────────────────────

  describe("V15 — the signed QR (D9)", () => {
    it("V15: flipping one serial digit fails verification; the untampered control parses to the triple", async () => {
      const k = await generate(kit([{ desk: "front-desk", counts: { registration: 4 } }]));
      const payload = await getKitPrintPayload(db, KEY, k.id);

      const reg = payload.ranges.find((r) => r.formKind === "registration")!;
      expect(reg.forms.map((f) => f.serial)).toEqual([1, 2, 3, 4]);

      // THE CONTROL, FIRST (§2.6): this exact string verifies, so whatever the tampered one does
      // below is caused by the tampering and not by a payload that never verified at all.
      const good = reg.forms[0]!;
      expect(good.qr.startsWith(`${KIT_QR_PREFIX}.${k.id}.registration.1.`)).toBe(true);
      expect(verifyKitSerial(KEY, good.qr)).toEqual({ kitId: k.id, formKind: "registration", serial: 1 });

      // THE TAMPER: one digit of the serial, changed to a serial THAT REALLY EXISTS in this kit
      // and this kind. Nothing about the value is out of range, unknown, or malformed — the only
      // thing wrong with the sheet is that the signature was made over a different number. A
      // verifier that parsed the fields and skipped `hmacVerify` would return serial 4 here.
      const parts = good.qr.split(".");
      const tampered = [parts[0], parts[1], parts[2], "4", parts[4]].join(".");
      expect(tampered).not.toBe(good.qr);
      expect(verifyKitSerial(KEY, tampered)).toBeNull();

      // …and the signature the tamper KEPT is still the real one for serial 1: the fourth form's
      // own QR verifies to serial 4, so "serial 4 cannot verify" is not what was proved above.
      expect(verifyKitSerial(KEY, reg.forms[3]!.qr)).toEqual({ kitId: k.id, formKind: "registration", serial: 4 });
    });

    it("V15's neighbours: a swapped form kind, a swapped kit id, a foreign key and a malformed string all fail", async () => {
      const k = await generate(kit([{ desk: "front-desk", counts: { registration: 2, receipt: 2 } }]));
      const payload = await getKitPrintPayload(db, KEY, k.id);
      const reg = payload.ranges.find((r) => r.formKind === "registration")!.forms[0]!;
      const rcp = payload.ranges.find((r) => r.formKind === "receipt")!.forms[0]!;

      // Both are serial 1 of the same kit — the counters are PER KIND, so this collision is real
      // and the form kind is the only thing separating the two sheets.
      expect([reg.serial, rcp.serial]).toEqual([1, 1]);
      const swapKind = reg.qr.replace(".registration.", ".receipt.");
      expect(swapKind).not.toBe(reg.qr);
      expect(verifyKitSerial(KEY, swapKind)).toBeNull();

      const swapKit = reg.qr.replace(k.id, "01HNOSUCHKIT00000000000000");
      expect(verifyKitSerial(KEY, swapKit)).toBeNull();

      // A perfectly well-formed sheet signed by somebody else's key.
      expect(verifyKitSerial(OTHER_KEY, reg.qr)).toBeNull();

      for (const bad of ["", "dtk1", `${reg.qr}.extra`, reg.qr.replace("dtk1.", "dtk2."), reg.qr.slice(0, -1)]) {
        expect([bad, verifyKitSerial(KEY, bad)]).toEqual([bad, null]);
      }
    });

    it("every sheet in a kit carries its own verifiable QR — the whole print run, not a sample", async () => {
      const k = await generate(
        kit([
          { desk: "front-desk", counts: { registration: 3, consultation: 2 } },
          { desk: "billing-desk", counts: { receipt: 4 } },
        ]),
      );
      const payload = await getKitPrintPayload(db, KEY, k.id);
      expect(payload.totalForms).toBe(9);

      const seen: string[] = [];
      for (const range of payload.ranges) {
        expect(range.forms).toHaveLength(range.count);
        for (const form of range.forms) {
          expect(verifyKitSerial(KEY, form.qr)).toEqual({
            kitId: k.id,
            formKind: range.formKind,
            serial: form.serial,
          });
          seen.push(`${range.formKind}#${form.serial}`);
        }
      }
      // Nine sheets, nine DISTINCT (kind, serial) pairs — a print run that repeated a serial would
      // be two sheets nobody can tell apart at the reconciliation desk.
      expect(seen).toHaveLength(9);
      expect(new Set(seen).size).toBe(9);
    });
  });

  // ───────────────────────────────────────── V13 ─────────────────────────────────────────────

  describe("V13 — the measured race (GC7, §3.22)", () => {
    /**
     * THE RUN COUNT IS A FLOOR, NOT A TARGET (§3.22 / GC7). Fifteen rounds of five concurrent
     * generations, each spanning all three counters, is 75 real transactions contending for three
     * rows; the observed rate is reported by the final assertion as a FRACTION so a partial
     * failure prints as `[k, 15]` rather than as a bare boolean.
     *
     * WHAT MAKES THE FIX SOUND IS THE ROW LOCK, NOT THE RUN COUNT. §3.22's asymmetry is that a
     * harness reproduces a race less readily than the wild does, so a clean run is WEAK evidence
     * on its own — it is the `UPDATE … RETURNING` that makes the ranges disjoint, and this test
     * exists to catch the day somebody replaces it with a read-then-write.
     *
     * NOTHING IS TRUNCATED BETWEEN ROUNDS, deliberately: disjointness is asserted over EVERY range
     * ever allocated in this test, not merely within one round, and each later round therefore
     * starts from a non-zero counter — which is the state a real hospital's second outage is in.
     */
    const ROUNDS = 15;
    const CONCURRENCY = 5;

    it("V13: concurrent generations yield pairwise DISJOINT ranges, and the counters advance by exactly the total", async () => {
      const allocated: Record<DowntimeFormKind, { start: number; end: number; kitId: string }[]> = {
        registration: [],
        consultation: [],
        receipt: [],
      };
      let disjointRounds = 0;
      let totalPerKind = 0;

      for (let round = 0; round < ROUNDS; round += 1) {
        const results = await Promise.all(
          Array.from({ length: CONCURRENCY }, (_, i) =>
            generate(
              kit([{ desk: `desk-${round}-${i}`, counts: { registration: 2, consultation: 2, receipt: 2 } }]),
              new Date(NOW.getTime() + round * 60_000),
            ),
          ),
        );
        totalPerKind += CONCURRENCY * 2;

        for (const result of results) {
          for (const range of result.ranges) {
            allocated[range.formKind].push({ start: range.startSerial, end: range.endSerial, kitId: result.id });
          }
        }

        // Pairwise disjointness, per form kind, over EVERYTHING allocated so far.
        const overlaps: string[] = [];
        for (const formKind of DOWNTIME_FORM_KINDS) {
          const blocks = [...allocated[formKind]].sort((x, y) => x.start - y.start);
          for (let i = 1; i < blocks.length; i += 1) {
            const prev = blocks[i - 1]!;
            const here = blocks[i]!;
            if (here.start <= prev.end) {
              overlaps.push(
                `${formKind}: [${prev.start},${prev.end}] (kit ${prev.kitId}) overlaps [${here.start},${here.end}] (kit ${here.kitId})`,
              );
            }
          }
        }
        if (overlaps.length === 0) disjointRounds += 1;
        else {
          // The diagnosis is printed on the FIRST failing round and the loop stops: a lost update
          // corrupts every later round's arithmetic, so 14 more rounds of noise would bury it.
          expect([round, overlaps]).toEqual([round, []]);
        }
      }

      // THE OBSERVED RATE, AS A FRACTION (§3.22: report it, never engineer the window).
      expect([disjointRounds, ROUNDS]).toEqual([ROUNDS, ROUNDS]);

      // THE INVARIANT, PREFERRED OVER ANY LOSER'S DIAGNOSIS (§3.13): the counters advanced by
      // exactly the number of forms handed out, across every kind. A lost update shows up here as
      // a counter that is BEHIND the paper — the arithmetic statement of "two desks were issued
      // the same serials".
      const after = await counters();
      expect(after).toEqual({
        registration: totalPerKind + 1,
        consultation: totalPerKind + 1,
        receipt: totalPerKind + 1,
      });

      // …and every kind's blocks tile the whole allocation with no hole either: the union of the
      // ranges is exactly [1, total]. Disjoint-and-complete is a stronger statement than disjoint.
      for (const formKind of DOWNTIME_FORM_KINDS) {
        const serials = allocated[formKind].flatMap((b) =>
          Array.from({ length: b.end - b.start + 1 }, (_, i) => b.start + i),
        );
        expect([formKind, serials.length, new Set(serials).size]).toEqual([formKind, totalPerKind, totalPerKind]);
        expect([formKind, Math.min(...serials), Math.max(...serials)]).toEqual([formKind, 1, totalPerKind]);
      }
    }, 120_000);
  });
});
