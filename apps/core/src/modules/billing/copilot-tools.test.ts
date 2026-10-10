import { and, eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  issueDuesInvoice, issuePaidInvoice, mkBillingManager, mkCashier, openSessionFor, seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { ROLE_MODEL } from "../../../scripts/seed-roles";
import { approveRequest } from "../../kernel/approvals/decisions";
import { requestApproval } from "../../kernel/approvals/requests";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { collectCopilotTools, permissionCheckFor, runTool } from "../../kernel/copilot/catalog";
import { withTx } from "../../kernel/db/client";
import { invoiceLines, phiAccessLog, registrationConfig, roles } from "../../kernel/db/schema";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { formatPaise } from "../../kernel/report/money";
import { isValidUhid, registerPatient } from "../patients";
import { billingCopilotTools } from "./copilot-tools";
import { issueCreditNote } from "./credit-notes";
import { patientBalance, recordReceipt } from "./receipts";
import { issueRefundVoucher, REFUND_APPROVAL_SUBJECT, REFUND_APPROVAL_TYPE } from "./refunds";
import type { CopilotAnswer, CopilotToolCtx, CopilotToolDecl } from "../../kernel/copilot/types";
import type { Db } from "../../kernel/db/client";

/**
 * E1.6 (decision 0064, spec /opt/hmis-context/SPEC-copilot-dues-2026-10-11.md, owner yes 2026-10-11)
 * — "U00110012 ka kitna baaki hai?" answered with the figure the billing counter shows.
 *
 * The counter's figure is `patientBalance(...).outstandingPaise` (the `dues-total` the counter rail
 * prints from `GET /billing/patients/:id/balance`). The fixture is built so the right number is not
 * the naive one: a part payment AND a credit note on the open bill, a credit note on a paid bill
 * (surplus that must not mask the open one), and an advance that was part refunded (money that is
 * not dues at all). Owner Q1 answer: dues only — no advance in the answer.
 */
describe("the billing copilot tool: patient dues (E1.6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  });

  const GATES = ["billing.dues.patient.read", "billing.invoice.read"] as const;

  /**
   * A user holding a role whose dues-gate permissions are EXACTLY what the production role model
   * (`scripts/seed-roles.ts` ROLE_MODEL) grants that role — so "the doctor is refused" is a fact
   * about the real doctor role, not about a role this test made up.
   */
  async function userInModelRole(roleKey: string): Promise<Actor> {
    const model = ROLE_MODEL.find((r) => r.roleKey === roleKey);
    if (model === undefined) throw new Error(`no role ${roleKey} in ROLE_MODEL`);
    const held = GATES.filter((p) => model.permissions.includes(p));
    const registry = new ModuleRegistry();
    registry.install({ key: "billing", title: "Billing", menu: [], permissions: [...GATES], subscriptions: [] });
    await syncPermissions(db, registry);
    await db.insert(roles).values({ key: roleKey, title: roleKey }).onConflictDoNothing();
    for (const p of held) await grantPermissionToRole(db, registry, roleKey, p);
    const { id } = await createUser(db, { username: `u-${roleKey}`, fullName: roleKey, password: "p1234567" });
    await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    return { type: "user", id };
  }

  async function mkPatient(name: string): Promise<{ id: string; uhid: string }> {
    const clerk: Actor = { type: "user", id: "dues-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { name, sex: "female", ageYears: 40 }));
    return { id: patient.id, uhid: patient.uhid };
  }

  async function lineOf(invoiceId: string): Promise<string> {
    const rows = await db.select({ id: invoiceLines.id }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    return rows[0]!.id;
  }

  const tool = (): CopilotToolDecl => billingCopilotTools.find((t) => t.intent === "patient_dues")!;
  const ask = (actor: Actor, subject: string | null): Promise<CopilotAnswer> => {
    const c: CopilotToolCtx = { db, actor, subject, serviceDate: "2026-10-11", question: "<<P1>> ka kitna baaki hai" };
    return runTool(tool(), c, permissionCheckFor(c));
  };

  /** Bill A open (part paid + credit note), bill B paid then credited, an advance part refunded. */
  async function seedLedger(patientId: string): Promise<{ billANo: string }> {
    const cashier = await mkCashier(db, "dues-cashier");
    const manager = await mkBillingManager(db, "dues-manager");
    await openSessionFor(db, cashier, 100_000);

    // Bill A: 3 × ₹500 exempt consult = ₹1,500; ₹400 paid at the window; one unit credited (₹500).
    const billA = await issueDuesInvoice(db, cashier, {
      patientId, serviceId: base.consultNewServiceId, qty: 3, receiptPaise: 40_000,
    });
    await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId: billA.invoiceId, reason: "one consult not given",
      lines: [{ invoiceLineId: await lineOf(billA.invoiceId), qty: 1 }],
    });

    // Bill B: 2 × ₹500 paid in full, then one unit credited — a surplus that must not mask bill A.
    const billB = await issuePaidInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, qty: 2 });
    await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId: billB.invoiceId, reason: "one consult refunded",
      lines: [{ invoiceLineId: await lineOf(billB.invoiceId), qty: 1 }],
    });

    // An advance of ₹300, ₹100 of it refunded by voucher — advance money, never dues.
    await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 30_000 }] });
    const filed = await withTx(db, (tx) =>
      requestApproval(tx, cashier.actor, {
        typeKey: REFUND_APPROVAL_TYPE,
        subject: { type: REFUND_APPROVAL_SUBJECT, id: patientId },
        patientId, amountPaise: 10_000, requestNote: "part of the advance back",
      }),
    );
    await approveRequest(db, manager.actor, { approvalId: filed.approvalId, note: "ok (test)" });
    await issueRefundVoucher(db, cashier.actor, {
      kind: "advance_refund", patientId, amountPaise: 10_000, reasonClass: "genuine",
      reason: "part of the advance back", approvalId: filed.approvalId, method: "cash",
    });
    return { billANo: billA.invoiceNo };
  }

  it("D1 — says the counter's own figure: ₹600 on one bill, equal to patientBalance on the same database", async () => {
    const p = await mkPatient("Dues Patient");
    const { billANo } = await seedLedger(p.id);
    const cashier = await userInModelRole("cashier");

    const counter = await patientBalance(db, cashier, p.id);
    expect(counter.outstandingPaise).toBe(60_000);
    expect(counter.dues).toHaveLength(1);

    const a = await ask(cashier, p.uhid);
    expect(a).toEqual({
      key: "copilot.answer.duesOwed",
      params: {
        uhid: p.uhid,
        amount: formatPaise(counter.outstandingPaise),
        count: 1,
        billNo: billANo,
        date: counter.dues[0]!.serviceDay,
      },
    });
    expect(a.params.amount).toBe("₹600.00");
    // Owner Q1: dues only — the ₹200 advance still held is never in the answer (`toEqual` above
    // pins the params exactly); the counter does hold it, so its absence is a choice, not an accident.
    expect(counter.advancePaise).toBeGreaterThan(0);
  });

  it("D1 — the disclosure is logged on its own PHI surface", async () => {
    const p = await mkPatient("Logged Patient");
    const fd = await userInModelRole("front_office");
    await ask(fd, p.uhid);
    const rows = await db.select().from(phiAccessLog)
      .where(and(eq(phiAccessLog.patientId, p.id), eq(phiAccessLog.surface, "copilot.patient_dues")));
    expect(rows).toHaveLength(1);
  });

  it("D2 — nothing owed, a bad check digit, an unknown UHID, a visit number and no subject are five different answers", async () => {
    const p = await mkPatient("Clear Patient");
    const other = await mkPatient("Other Patient");
    const fd = await userInModelRole("front_office");

    expect(await ask(fd, p.uhid.toLowerCase())).toEqual({ key: "copilot.answer.duesNone", params: { uhid: p.uhid } });

    const last = Number(p.uhid.slice(-1));
    const badDigit = `${p.uhid.slice(0, -1)}${String((last + 1) % 10)}`;
    expect(await ask(fd, badDigit)).toEqual({ key: "copilot.answer.uhidCheckFailed", params: { uhid: badDigit } });

    // A well-formed UHID (valid check digit) that was never issued.
    const prefix = p.uhid.replace(/\d+$/, "");
    let unissued = "";
    for (let n = 99_999_999; unissued === ""; n -= 1) {
      const c = `${prefix}${String(n)}`;
      if (isValidUhid(c) && c !== p.uhid && c !== other.uhid) unissued = c;
    }
    expect(await ask(fd, unissued)).toEqual({ key: "copilot.answer.visitUnknownPatient", params: {} });

    expect(await ask(fd, "OPD-2610110004")).toEqual({ key: "copilot.answer.duesNeedUhid", params: {} });
    expect(await ask(fd, null)).toEqual({ key: "copilot.answer.needSubject", params: {} });
  });

  it("D3 — the doctor role is refused before the tool runs; front desk and cashier both get the figure", async () => {
    const p = await mkPatient("Gate Patient");
    await seedLedger(p.id);
    const doctor = await userInModelRole("doctor");
    const fd = await userInModelRole("front_office");
    const cashier = await userInModelRole("cashier");

    expect(await ask(doctor, p.uhid)).toEqual({ key: "copilot.answer.notPermitted", params: {} });
    const logged = await db.select().from(phiAccessLog)
      .where(and(eq(phiAccessLog.actorId, doctor.id), eq(phiAccessLog.surface, "copilot.patient_dues")));
    expect(logged).toHaveLength(0);

    expect((await ask(fd, p.uhid)).params.amount).toBe("₹600.00");
    expect((await ask(cashier, p.uhid)).params.amount).toBe("₹600.00");
  });

  it("D4 — the shipped catalog claims patient_dues, so the question no longer answers noTool", () => {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    const tools = collectCopilotTools(registry);
    expect(tools.filter((t) => t.intent === "patient_dues")).toHaveLength(1);
  });
});
