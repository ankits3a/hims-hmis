import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { events, imagingBillDecisions } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  authorisationOf, hasBillDecision, openBillDecisions, raiseBillDecision, resolveBillDecision,
} from "./money";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T7 — Assertion Book row **A4** (the authorisation rule) and **A5**'s queue half.
 *
 * A4's matrix is walked WITHOUT a database, for `applicability.ts`'s reason: a rule that decides
 * whether a hospital gets paid should be walkable at every boundary rather than at whichever payer
 * the e2e fixture happens to carry. A4's mutant — *"treat a null payer as authorised"* — is one
 * line in the pure block and would cost a whole fixture in the second.
 */
describe("DD12a — why a scan was allowed to start (18a T7 A4)", () => {
  const study = (over: Partial<Parameters<typeof authorisationOf>[0]> = {}) => ({
    invoiceLineId: null, priority: "routine", encounterNo: "V2608310001", ...over,
  });

  /* ═══════════════════ A4's four stated rows ═══════════════════ */

  /**
   * A4's first row, and its mutant's whole harm: a self-pay routine OPD scan with no line is NOT
   * authorised. `null` here becomes `payment_required` (402) — the one refusal a receptionist
   * resolves by taking money, which is why it has its own status.
   */
  it("A4: OPD + self-pay + routine + no invoice line ⇒ NOT authorised", () => {
    expect(authorisationOf(study(), { intendedPayer: "self" })).toBeNull();
  });

  it("A4: the same scan as `stat` starts, and the record says WHY it did (D3)", () => {
    expect(authorisationOf(study({ priority: "stat" }), { intendedPayer: "self" })).toBe("stat");
  });

  it.each(["tpa", "pmjay", "corporate"])("A4: a %s payer starts as `payer_branch`", (payer) => {
    expect(authorisationOf(study(), { intendedPayer: payer })).toBe("payer_branch");
  });

  it("A4: a `D…` day-care encounter starts as `daycare` — its discharge bill composes the scan", () => {
    expect(authorisationOf(study({ encounterNo: "D2608310001" }), { intendedPayer: "self" })).toBe("daycare");
  });

  it("money actually taken is `invoice`, and it outranks everything", () => {
    expect(authorisationOf(study({ invoiceLineId: "IL-1" }), { intendedPayer: "self" })).toBe("invoice");
    expect(authorisationOf(
      study({ invoiceLineId: "IL-1", encounterNo: "D2608310001", priority: "stat" }),
      { intendedPayer: "tpa" },
    )).toBe("invoice");
  });

  /* ═══════════════════ the precedence, which is a ruling and not a preference ═══════════════════ */

  /**
   * `stat` is LAST on purpose. A stat scan on a TPA patient is `payer_branch`, because the payer is
   * who gets billed and the urgency did not change that — and reading `stat` earlier would hide
   * every other answer behind it, leaving a register in which every emergency looks unfunded.
   */
  it("`stat` is the authorisation of LAST resort, not the first one read", () => {
    expect(authorisationOf(study({ priority: "stat" }), { intendedPayer: "tpa" })).toBe("payer_branch");
    expect(authorisationOf(study({ priority: "stat", encounterNo: "D2608310001" }), { intendedPayer: "self" }))
      .toBe("daycare");
  });

  it("`urgent` is not `stat` — only the top priority band skips the cashier", () => {
    expect(authorisationOf(study({ priority: "urgent" }), { intendedPayer: "self" })).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("DD12b — the counter's queue (18a T7 A5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    /** The counter's permission. `doctor` is the fixture's stand-in for a billing_manager here. */
    const registry = new ModuleRegistry();
    registry.install({
      key: "radiology", title: "Rad", menu: [], permissions: ["radiology.bill_decisions.manage"],
      subscriptions: [],
    });
    await syncPermissions(db, registry);
    await grantPermissionToRole(db, registry, "doctor", "radiology.bill_decisions.manage");
  });
  afterEach(() => { fx.unregister(); });

  /** A real study row, so the FK holds and the queue is about something. */
  let seq = 0;
  const aStudy = async () => {
    seq += 1;
    return (await placeAndCreateStudy(
      db, fx, "USG-ABDO", `m${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
    )).studyId;
  };

  it("raises a decision, events it, and puts it on the open queue", async () => {
    const studyId = await aStudy();
    const { billDecisionId } = await withTx(db, (tx) => raiseBillDecision(tx, fx.radiographer, {
      studyId, kind: "contrast_not_given", detail: { serviceId: "S1" },
    }));

    const open = await openBillDecisions(db);
    expect(open.map((d) => [d.id, d.kind])).toEqual([[billDecisionId, "contrast_not_given"]]);

    const emitted = (await db.select().from(events)).filter((e) => e.name === "imaging.bill_decision_raised");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({ studyId, kind: "contrast_not_given" });
  });

  it("a resolved decision leaves the queue, and carries WHO, WHEN and WHAT", async () => {
    const studyId = await aStudy();
    const { billDecisionId } = await withTx(db, (tx) => raiseBillDecision(tx, fx.radiographer, {
      studyId, kind: "acquired_unbilled", detail: null,
    }));
    await withTx(db, (tx) => resolveBillDecision(tx, fx.doctor, {
      billDecisionId, resolution: "charged on invoice INV-441",
    }));

    expect(await openBillDecisions(db)).toEqual([]);
    const [row] = await db.select().from(imagingBillDecisions);
    expect([row!.resolvedBy, row!.resolution]).toEqual([fx.doctor.id, "charged on invoice INV-441"]);
    expect(row!.resolvedAt).toBeInstanceOf(Date);
  });

  it("refuses a blank resolution — a queue is cleared with a word, not a click", async () => {
    const studyId = await aStudy();
    const { billDecisionId } = await withTx(db, (tx) => raiseBillDecision(tx, fx.radiographer, {
      studyId, kind: "acquired_unbilled",
    }));
    await expect(withTx(db, (tx) => resolveBillDecision(tx, fx.doctor, { billDecisionId, resolution: "   " })))
      .rejects.toMatchObject({ code: "reason_required" });
  });

  it("refuses a SECOND resolution rather than overwriting the first", async () => {
    const studyId = await aStudy();
    const { billDecisionId } = await withTx(db, (tx) => raiseBillDecision(tx, fx.radiographer, {
      studyId, kind: "repeat_no_charge",
    }));
    await withTx(db, (tx) => resolveBillDecision(tx, fx.doctor, { billDecisionId, resolution: "credit note CN-9" }));
    await expect(withTx(db, (tx) => resolveBillDecision(tx, fx.doctor, { billDecisionId, resolution: "again" })))
      .rejects.toMatchObject({ code: "already_acquired" });
  });

  it("refuses a resolver without `radiology.bill_decisions.manage` — the technologist decides no money", async () => {
    const studyId = await aStudy();
    const { billDecisionId } = await withTx(db, (tx) => raiseBillDecision(tx, fx.radiographer, {
      studyId, kind: "acquired_unbilled",
    }));
    await expect(withTx(db, (tx) => resolveBillDecision(tx, fx.radiographer, {
      billDecisionId, resolution: "waived",
    }))).rejects.toMatchObject({ code: "payment_required" });
  });

  it("`hasBillDecision` is the redelivery guard — it sees a kind already raised for a study", async () => {
    const studyId = await aStudy();
    expect(await hasBillDecision(db, studyId, "repeat_no_charge")).toBe(false);
    await withTx(db, (tx) => raiseBillDecision(tx, fx.radiographer, { studyId, kind: "repeat_no_charge" }));
    expect(await hasBillDecision(db, studyId, "repeat_no_charge")).toBe(true);
    expect(await hasBillDecision(db, studyId, "contrast_not_given")).toBe(false);
  });
});
