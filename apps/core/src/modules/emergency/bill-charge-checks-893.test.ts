import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { IPD_CHARGE_COMPONENTS, IPD_CHARGE_SOURCES } from "@hmis/contracts";
import { ipdChargeExceptions, ipdChargeLines } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkChargesWorld } from "../../../test/helpers/ipd";
import type { Db } from "../../kernel/db/client";

/**
 * #893 — two lanes (ER lane 6 `er_bill`, IPD drug bill `ipd_drugbill`) each rebuild the running bill's three CHECKs
 * (`ipd_charge_lines_source_ck`, `ipd_charge_lines_component_ck`, `ipd_charge_exceptions_component_ck`) with only their
 * own values. Whichever reaches main second must carry the union, or the database refuses the other lane's lines. This
 * pins the agreement on a migrated database: every source and component the contracts declare is accepted by the CHECKs,
 * and every source the code writes or reads is one the contracts declare.
 */
jest.setTimeout(240_000);

const CHECKS = ["ipd_charge_lines_source_ck", "ipd_charge_lines_component_ck", "ipd_charge_exceptions_component_ck"];

/** The constraint a refused insert names, or the message when it names none. */
const refusal = (e: unknown): string => {
  const c = (e as { cause?: { constraint?: string; message?: string } }).cause ?? (e as { constraint?: string; message?: string });
  return c.constraint ?? c.message ?? String(e);
};

describe("#893 — the IPD charge CHECKs accept every value the contracts declare", () => {
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
    // ipd-stage integration: ipd-drugbill's ipd_charge_lines_pharmacy_ck — a pharmacy line names its issue, batch,
    // dose sequence and order (stage only; the ER lanes do not carry ipd-drugbill).
    ...(source === "ipd.pharmacy" ? { issueId: randomUUID(), batchId: randomUUID(), drugSeq: 0 } : {}),
    orderItemId: source === "ipd.order" ? randomUUID() : null,
    visitSeq: source === "ipd.visit" ? 0 : null,
    consultantUserId: source === "ipd.visit" ? postedBy : null,
    reversalOf: source === "ipd.reversal" ? randomUUID() : null,
    reason: source === "ipd.reversal" ? "Synthetic reversal" : null,
    erChargeLineId: source === "ipd.er" ? randomUUID() : null,
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

  it("each source the code writes or reads on a charge line is one IPD_CHARGE_SOURCES declares", () => {
    // Every non-test file that touches the charge-line table; on it, every `"ipd.<word>"` on a line naming `source`.
    const src = join(__dirname, "../..");
    const files = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("acceptance") && !f.startsWith(join("kernel", "db")))
      .map((f) => readFileSync(join(src, f), "utf8"))
      .filter((text) => text.includes("ipdChargeLines"));
    const used = new Set<string>();
    for (const text of files) {
      for (const l of text.split("\n")) {
        if (!/\bsource\b/i.test(l)) continue;
        for (const m of l.matchAll(/"(ipd\.[a-z_]+)"/g)) used.add(m[1]!);
      }
    }
    // The scan must see the writers it is meant to see — an empty set would pass for the wrong reason.
    expect([...used]).toEqual(expect.arrayContaining(["ipd.nightly", "ipd.visit", "ipd.order", "ipd.reversal", "ipd.er"]));
    expect([...used].filter((s) => !(IPD_CHARGE_SOURCES as readonly string[]).includes(s))).toEqual([]);
  });

  it("names the three CHECKs it guards (a renamed CHECK must move this test with it)", async () => {
    const rows = await db.execute<{ conname: string }>(
      sql`select conname from pg_constraint where conname in (${sql.join(CHECKS.map((c) => sql`${c}`), sql`, `)}) order by conname`,
    );
    expect(rows.rows.map((r) => r.conname)).toEqual([...CHECKS].sort());
  });
});
