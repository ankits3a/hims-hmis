import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { IPD_CHARGE_COMPONENTS, IPD_CHARGE_SOURCES } from "@hmis/contracts";
import { ipdChargeExceptions, ipdChargeLines } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkChargesWorld } from "../../../test/helpers/ipd";
import type { Db } from "../../kernel/db/client";

/**
 * #893 (the charges suite's guard; the ER bill suite carries its twin) — the running bill's three CHECKs
 * (`ipd_charge_lines_source_ck`, `ipd_charge_lines_component_ck`, `ipd_charge_exceptions_component_ck`) are rebuilt by
 * several lanes, and a rebuild that lists only its own values makes the database refuse every other lane's lines. The
 * contracts' `IPD_CHARGE_SOURCES` / `IPD_CHARGE_COMPONENTS` own the lists (the schema derives its CHECK SQL from them),
 * and this pins the agreement on a migrated database: every value they declare is accepted.
 */
jest.setTimeout(240_000);

const CHECKS = ["ipd_charge_lines_source_ck", "ipd_charge_lines_component_ck", "ipd_charge_exceptions_component_ck"];

/** The constraint a refused insert names, or the message when it names none. */
const refusal = (e: unknown): string => {
  const c = (e as { cause?: { constraint?: string; message?: string } }).cause ?? (e as { constraint?: string; message?: string });
  return c.constraint ?? c.message ?? String(e);
};

describe("#893 — the IPD charge CHECKs accept every value the contracts declare (charges suite)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let admissionId: string;
  let patientId: string;
  let postedBy: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    const w = await mkChargesWorld(db);
    ({ admissionId, patientId } = await w.admitAt("general", new Date(Date.now() - 3_600_000)));
    postedBy = w.billDesk.id;
  });

  /** A zero-priced line shaped for its source, so only the source and component CHECKs can refuse it. */
  const line = (source: string, component: string) => ({
    id: randomUUID(), admissionId, patientId, serviceDate: "2026-10-01", component, billedClass: null,
    serviceId: "svc-893", serviceCode: "SVC893", serviceName: "Synthetic check", tariffVersionId: "tv-893",
    qty: 1, unitPaise: 0, grossPaise: 0, discountPaise: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, netPaise: 0,
    gstRateBps: 0, gstExempt: true, source,
    orderId: source === "ipd.order" || source === "ipd.pharmacy" ? randomUUID() : null,
    // ipd-drugbill's ipd_charge_lines_pharmacy_ck — a pharmacy line names its issue, batch, dose sequence and order.
    ...(source === "ipd.pharmacy" ? { issueId: randomUUID(), batchId: randomUUID(), drugSeq: 0 } : {}),
    orderItemId: source === "ipd.order" ? randomUUID() : null,
    visitSeq: source === "ipd.visit" ? 0 : null,
    consultantUserId: source === "ipd.visit" ? postedBy : null,
    reversalOf: source === "ipd.reversal" ? randomUUID() : null,
    reason: source === "ipd.reversal" ? "Synthetic reversal" : null,
    postedBy, postedAt: new Date(),
  });

  const tryInsert = async (write: () => Promise<unknown>): Promise<string> => {
    try { await write(); return "ok"; } catch (e) { return refusal(e); }
  };

  it("every IPD_CHARGE_SOURCES value passes ipd_charge_lines_source_ck", async () => {
    const outcome: Record<string, string> = {};
    for (const s of IPD_CHARGE_SOURCES) outcome[s] = await tryInsert(() => db.insert(ipdChargeLines).values(line(s, "room")));
    expect(outcome).toEqual(Object.fromEntries(IPD_CHARGE_SOURCES.map((s) => [s, "ok"])));
  });

  it("every IPD_CHARGE_COMPONENTS value passes both component CHECKs (lines and exceptions)", async () => {
    const outcome: Record<string, string> = {};
    for (const c of IPD_CHARGE_COMPONENTS) {
      const onLine = await tryInsert(() => db.insert(ipdChargeLines).values(line("ipd.nightly", c)));
      const onException = await tryInsert(() => db.insert(ipdChargeExceptions).values({
        id: randomUUID(), key: `${admissionId}:2026-10-01:${c}`, admissionId, serviceDate: "2026-10-01", component: c,
        reason: "rate_missing", firstSeenAt: new Date(), lastSeenAt: new Date(),
      }));
      outcome[c] = `${onLine} / ${onException}`;
    }
    expect(outcome).toEqual(Object.fromEntries(IPD_CHARGE_COMPONENTS.map((c) => [c, "ok / ok"])));
  });

  it("names the three CHECKs it guards (a renamed CHECK must move this test with it)", async () => {
    const rows = await db.execute<{ conname: string }>(
      sql`select conname from pg_constraint where conname in (${sql.join(CHECKS.map((c) => sql`${c}`), sql`, `)}) order by conname`,
    );
    expect(rows.rows.map((r) => r.conname)).toEqual([...CHECKS].sort());
  });
});
