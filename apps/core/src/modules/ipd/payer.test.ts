import { randomUUID } from "node:crypto";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkChargesWorld } from "../../../test/helpers/ipd";
import { recordPayerAuth } from "./index";
import type { Db } from "../../kernel/db/client";
import type { ChargesWorld } from "../../../test/helpers/ipd";

/**
 * E2.2 (#726) — the authorisation record's running total, which the payer split reads. Explicit instants; fake amounts.
 */
jest.setTimeout(120_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);

describe("record_payer_auth — the approved total (E2.2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ChargesWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkChargesWorld(db); });

  it("a requested pre-auth is answered by a second initial; a requested enhancement approves nothing and does not inflate the next", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    let minute = 0;
    const auth = (over: Record<string, unknown>) => {
      minute += 1;
      return recordPayerAuth(db, w.admitDesk, {
        idempotencyKey: randomUUID(), admissionId, payerKind: "insurance_cashless", entry: "initial", status: "requested",
        provisionalCashlessSigned: true, ...over,
      }, { now: new Date(ist("2026-03-10T11:00:00").getTime() + minute * 60_000) });
    };
    await expect(auth({ approvedAmountPaise: 500_000 })).resolves.toMatchObject({ approvedTotalPaise: 0, coversFrom: null });
    await expect(auth({ status: "approved", approvedAmountPaise: 300_000 })).resolves.toMatchObject({ approvedTotalPaise: 300_000 });
    // An answered initial refuses a third.
    await expect(auth({ status: "approved", approvedAmountPaise: 1 })).rejects.toMatchObject({ code: "auth_out_of_order" });
    await expect(auth({ entry: "enhancement", approvedAmountPaise: 200_000 })).resolves.toMatchObject({ approvedTotalPaise: 300_000 });
    await expect(auth({ entry: "enhancement", status: "approved", approvedAmountPaise: 150_000 })).resolves.toMatchObject({ approvedTotalPaise: 450_000 });
  });
});
