import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { cumulativeAmount, istDayWindow, IST_UTC_OFFSET_MINUTES } from "./cumulative";
import { approvals, approvalTypes, workflowDefinitions, workflowInstances } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";

describe("istDayWindow (pure)", () => {
  it("is the fixed IST offset, not config", () => {
    expect(IST_UTC_OFFSET_MINUTES).toBe(330);
  });

  it("maps a UTC evening into the NEXT IST calendar day", () => {
    // 2026-08-13T19:45Z = 2026-08-14T01:15 IST → window = IST Aug 14
    const { start, end } = istDayWindow(new Date("2026-08-13T19:45:00.000Z"));
    expect(start.toISOString()).toBe("2026-08-13T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-08-14T18:30:00.000Z");
  });

  it("maps a UTC morning into the SAME IST calendar day", () => {
    // 2026-08-13T10:00Z = 2026-08-13T15:30 IST → window = IST Aug 13
    const { start, end } = istDayWindow(new Date("2026-08-13T10:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-08-12T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-08-13T18:30:00.000Z");
  });

  it("treats IST midnight as the start of its own day", () => {
    const { start } = istDayWindow(new Date("2026-08-13T18:30:00.000Z")); // exactly 00:00 IST Aug 14
    expect(start.toISOString()).toBe("2026-08-13T18:30:00.000Z");
  });
});

describe("cumulativeAmount (C-12)", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  const DEF_JSON = {
    key: "approval_discount_override", title: "Discount Override", changeClass: "C",
    initialState: "pending",
    states: [
      { name: "pending", sla: { minutes: 45, alerting: "active" } },
      { name: "granted", terminal: true },
      { name: "rejected", terminal: true },
    ],
    transitions: [
      { from: "pending", to: "granted", roles: ["billing_head"] },
      { from: "pending", to: "rejected", roles: ["billing_head"] },
    ],
  };

  let seq = 0;
  async function seedApproval(row: {
    typeKey?: string; status?: string; patientId?: string; payeeId?: string;
    amountPaise: number; requestedAt: Date;
  }): Promise<void> {
    seq += 1;
    const typeKey = row.typeKey ?? "discount_override";
    const instanceId = `01HINST${String(seq).padStart(19, "0")}`;
    await db.insert(workflowDefinitions).values({
      id: "01HDEF000000000000000000A", defKey: "approval_discount_override", version: 1,
      title: "Discount Override", changeClass: "C", definition: DEF_JSON, draftedBy: "u1",
    }).onConflictDoNothing();
    await db.insert(approvalTypes).values({
      typeKey, title: typeKey, defKey: `approval_${typeKey}`,
      approverRole: "billing_head", createdBy: "u1",
    }).onConflictDoNothing();
    await db.insert(workflowInstances).values({
      id: instanceId, definitionId: "01HDEF000000000000000000A",
      defKey: "approval_discount_override", currentState: "pending",
      subjectType: "invoice", subjectId: `inv${seq}`, stateEnteredAt: new Date(),
    });
    await db.insert(approvals).values({
      id: `01HAP${String(seq).padStart(21, "0")}`, typeKey, instanceId,
      requesterId: "u1", approverRole: "billing_head", urgencyClass: "routine",
      subjectType: "invoice", subjectId: `inv${seq}`,
      patientId: row.patientId, payeeId: row.payeeId,
      amountPaise: row.amountPaise, status: row.status ?? "pending",
      requestedAt: row.requestedAt,
    });
  }

  const PAT = "01HPAT000000000000000000A";
  const OTHER_PAT = "01HPAT000000000000000000B";
  const PAYEE = "01HPAYEE00000000000000000";
  const IN = new Date("2026-08-13T10:00:00.000Z");     // inside the IST Aug 13 window
  const BEFORE = new Date("2026-08-12T17:00:00.000Z"); // IST Aug 12 — outside
  const WINDOW = istDayWindow(IN);

  it("sums pending + granted for the same patient, same type, same IST day — rejected excluded", async () => {
    await seedApproval({ patientId: PAT, amountPaise: 50_000, requestedAt: IN });
    await seedApproval({ patientId: PAT, amountPaise: 30_000, requestedAt: IN, status: "granted" });
    await seedApproval({ patientId: PAT, amountPaise: 999_999, requestedAt: IN, status: "rejected" });
    await seedApproval({ patientId: OTHER_PAT, amountPaise: 11_111, requestedAt: IN });
    await seedApproval({ patientId: PAT, amountPaise: 77_777, requestedAt: BEFORE });
    await seedApproval({ typeKey: "other_type", patientId: PAT, amountPaise: 44_444, requestedAt: IN });
    const total = await withTx(db, (tx) =>
      cumulativeAmount(tx, { typeKey: "discount_override", patientId: PAT, window: WINDOW }),
    );
    expect(typeof total).toBe("number"); // SUM arrives as text from pg — must be forced to number
    expect(total).toBe(80_000);
  });

  it("aggregates by payee independently of patient", async () => {
    await seedApproval({ payeeId: PAYEE, amountPaise: 20_000, requestedAt: IN });
    await seedApproval({ payeeId: PAYEE, amountPaise: 25_000, requestedAt: IN, status: "granted" });
    await seedApproval({ patientId: PAT, amountPaise: 90_000, requestedAt: IN });
    const total = await withTx(db, (tx) =>
      cumulativeAmount(tx, { typeKey: "discount_override", payeeId: PAYEE, window: WINDOW }),
    );
    expect(total).toBe(45_000);
  });

  it("window boundaries: start inclusive, end exclusive", async () => {
    await seedApproval({ patientId: PAT, amountPaise: 1_000, requestedAt: WINDOW.start });
    await seedApproval({ patientId: PAT, amountPaise: 2_000, requestedAt: WINDOW.end });
    const total = await withTx(db, (tx) =>
      cumulativeAmount(tx, { typeKey: "discount_override", patientId: PAT, window: WINDOW }),
    );
    expect(total).toBe(1_000);
  });

  it("returns 0 (a real number) when nothing matches", async () => {
    const total = await withTx(db, (tx) =>
      cumulativeAmount(tx, { typeKey: "discount_override", patientId: PAT, window: WINDOW }),
    );
    expect(total).toBe(0);
    expect(typeof total).toBe("number");
  });

  it("requires exactly one of patientId / payeeId", async () => {
    await expect(
      withTx(db, (tx) =>
        cumulativeAmount(tx, { typeKey: "discount_override", window: WINDOW }),
      ),
    ).rejects.toMatchObject({ code: "invalid_cumulative_query" });
    await expect(
      withTx(db, (tx) =>
        cumulativeAmount(tx, {
          typeKey: "discount_override", patientId: PAT, payeeId: PAYEE, window: WINDOW,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_cumulative_query" });
  });
});
