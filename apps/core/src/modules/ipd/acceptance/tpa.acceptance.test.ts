import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, isNull } from "drizzle-orm";
import { IPD_INTENTS, newId } from "@hmis/contracts";
import { ROLE_MODEL } from "../../../../scripts/seed-roles";
import { runSchemePackageImport } from "../../../../scripts/import-scheme-packages";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { PERMISSION_KEY } from "../../../kernel/auth/decorators";
import { ipdAdmissions, ipdPayerClaims, ipdSchemePackages, patientDocuments } from "../../../kernel/db/schema";
import { recordReceipt } from "../../billing";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkDischargeWorld } from "../../../../test/helpers/ipd";
import { mkTpaDesk } from "../../../../test/helpers/ipd-payer";
import { ipdManifest } from "../manifest";
import { IpdTpaController } from "../tpa.controller";
import {
  IPD_CLINICAL_ROLES, IpdError, IpdRefusal, answerTpaQuery, askBillVoid, attachTpaDocument, confirmCharges, declareFit,
  importSchemePackages, postNightlyIpdCharges, prepareFinalBill, readInterimBill, readTpaBoard, readTpaPanel, recordClaimRejection,
  recordClaimSettlement, recordPayerAuth, recordTpaQuery, registerIpdReceiptGuard, saveSummaryDraft, selectSchemePackage, settleFinalBill,
  signSummary, submitClaim, tpaDueCard, voidBill,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { DischargeWorld } from "../../../../test/helpers/ipd";

/**
 * #604 (decision 0075) — "DONE MEANS" FOR THE INSURANCE-LITE TPA DESK (SPEC-tpa-desk-2026-10-15, checks i–ix). Every check
 * calls the intents and the reads, never a screen, at EXPLICIT IST instants (nothing reads the clock for a date). Amounts
 * are the fixture's fake rates (general ward ₹2,200 a day: room 1,500 + nursing 500 + RMO 200).
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = (): string => randomUUID();
const SAMPLE = join(__dirname, "..", "..", "..", "..", "scripts", "data", "nha-hbp-sample.csv");

async function refusal(p: Promise<unknown>): Promise<IpdRefusal> {
  try { await p; } catch (e) { if (e instanceof IpdRefusal) return e; throw e; }
  throw new Error("expected a refusal");
}
async function ipdError(p: Promise<unknown>): Promise<IpdError> {
  try { await p; } catch (e) { if (e instanceof IpdError) return e; throw e; }
  throw new Error("expected an IpdError");
}

describe("#604 TPA desk — done means", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: DischargeWorld;
  /** The TPA seat: `ipd.payer.manage`, `ipd.payer.terms`, the bill, patients' read. */
  let tpa: Actor;
  let unregister: (() => void) | null = null;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkDischargeWorld(db); tpa = await mkTpaDesk(db); });
  afterEach(() => { unregister?.(); unregister = null; });

  const auth = (admissionId: string, at: Date, over: Record<string, unknown>) => recordPayerAuth(db, tpa, {
    idempotencyKey: key(), admissionId, payerKind: "insurance_cashless", entry: "initial", status: "requested",
    provisionalCashlessSigned: true, preAuthNumber: "PA-FAKE-1", ...over,
  }, { now: at });
  const rowsOf = async (at: Date) => (await readTpaBoard(db, tpa, at)).rows;
  const doc = async (patientId: string) => {
    const id = newId();
    await db.insert(patientDocuments).values({
      id, patientId, kind: "outside_report", mimeType: "application/pdf", byteSize: 10, storageKey: `2026/03/${id}.pdf`, sha256: "0".repeat(64),
      capturedBy: tpa.id,
    });
    return id;
  };

  it("(i) a pre-auth waits on a visible clock: warn past an hour, hot past two, gone once approved", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    await auth(admissionId, ist("2026-03-10T10:00:00"), {});
    const at = async (t: string) => (await rowsOf(ist(`2026-03-10T${t}`))).filter((r) => r.admissionId === admissionId && r.kind === "preauth_waiting");
    expect((await at("10:30:00"))[0]).toMatchObject({ waitMinutes: 30, dueMinutes: 60, severity: "ok", stage: "preauth", preAuthNumber: "PA-FAKE-1" });
    expect((await at("11:15:00"))[0]).toMatchObject({ waitMinutes: 75, severity: "warn" });
    expect((await at("12:01:00"))[0]).toMatchObject({ waitMinutes: 121, severity: "hot" });
    // The Now card: the admission number, never the name; the clock in words.
    const card = (await tpaDueCard({ db, now: ist("2026-03-10T11:15:00") }))[0]!;
    const adm = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!;
    expect(card.rows![0]).toMatchObject({ title: adm.admissionNo, subtitle: "PA-FAKE-1 · Pre-auth waiting 1 h 15 min", severity: "warn" });
    expect(await tpaDueCard({ db, now: ist("2026-03-10T10:30:00") })).toEqual([]);
    await auth(admissionId, ist("2026-03-10T12:10:00"), { status: "approved", approvedAmountPaise: 5_000_000 });
    expect(await at("12:20:00")).toEqual([]);
  });

  it("(ii) a payer query stops the insurer's clock and starts ours; the answer restarts the insurer's; a stranger's document refuses", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    await auth(admissionId, ist("2026-03-10T10:00:00"), {});
    const { queryId } = await recordTpaQuery(db, tpa, {
      idempotencyKey: key(), admissionId, stage: "preauth", raisedAt: ist("2026-03-10T10:20:00").toISOString(), queryText: "Send the ultrasound report",
    }, { now: ist("2026-03-10T10:25:00") });
    let rows = (await rowsOf(ist("2026-03-10T11:30:00"))).filter((r) => r.admissionId === admissionId);
    expect(rows.map((r) => r.kind)).toEqual(["query_open"]);
    expect(rows[0]).toMatchObject({ queryId, waitMinutes: 70, severity: "warn" });
    await answerTpaQuery(db, tpa, { idempotencyKey: key(), queryId, responseText: "Report attached on the portal" }, { now: ist("2026-03-10T11:40:00") });
    await expect(answerTpaQuery(db, tpa, { idempotencyKey: key(), queryId, responseText: "again" }, { now: ist("2026-03-10T11:41:00") }))
      .rejects.toMatchObject({ code: "query_already_answered" });
    rows = (await rowsOf(ist("2026-03-10T11:50:00"))).filter((r) => r.admissionId === admissionId);
    expect(rows.map((r) => [r.kind, r.waitMinutes, r.since])).toEqual([["preauth_waiting", 10, ist("2026-03-10T11:40:00").toISOString()]]);
    // A document is attached only if it is an active one filed for THIS patient.
    const mine = await doc(patientId);
    const other = await doc(await w.patient("female", 30));
    await attachTpaDocument(db, tpa, { idempotencyKey: key(), admissionId, stage: "preauth", kind: "investigations", patientDocumentId: mine });
    expect((await refusal(attachTpaDocument(db, tpa, { idempotencyKey: key(), admissionId, stage: "preauth", kind: "investigations", patientDocumentId: other }))).code)
      .toBe("tpa_document_invalid");
    expect((await readTpaPanel(db, tpa, admissionId, ist("2026-03-10T11:50:00"))).documents.map((d) => d.patientDocumentId)).toEqual([mine]);
  });

  it("(iii) an enhancement is due once the claimable passes 90 % of the approved amount; asking for it moves the row to the pre-auth clock", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    await auth(admissionId, ist("2026-03-10T10:00:00"), { status: "approved", approvedAmountPaise: 480_000 });
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    const due = async (t: Date) => (await rowsOf(t)).filter((r) => r.admissionId === admissionId && r.kind === "enhancement_due");
    expect(await due(ist("2026-03-11T08:00:00"))).toEqual([]); // ₹2,200 of ₹4,800: 45 %
    await postNightlyIpdCharges(db, ist("2026-03-12T00:05:00"));
    expect((await due(ist("2026-03-12T08:00:00")))[0]).toMatchObject({ claimablePaise: 440_000, approvedTotalPaise: 480_000, severity: "warn" }); // 91 %
    const card = (await tpaDueCard({ db, now: ist("2026-03-12T08:00:00") }))[0]!;
    expect(card.rows!.map((r) => r.subtitle)).toEqual(["PA-FAKE-1 · Enhancement due · 91 % of approved"]);
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    expect((await due(ist("2026-03-13T08:00:00")))[0]).toMatchObject({ claimablePaise: 660_000, severity: "hot" }); // over the approval
    await auth(admissionId, ist("2026-03-13T08:30:00"), { entry: "enhancement", status: "requested" });
    const rows = (await rowsOf(ist("2026-03-13T08:40:00"))).filter((r) => r.admissionId === admissionId);
    expect(rows.map((r) => [r.kind, r.stage, r.waitMinutes])).toEqual([["preauth_waiting", "enhancement", 10]]);
  });

  it("(iv) the package importer: the sample dry-runs to 8 new, applies, re-runs to no change, retires a changed rate, refuses a bad file whole", async () => {
    const csv = readFileSync(SAMPLE, "utf8");
    const dry = await runSchemePackageImport(db, ["--file", SAMPLE, "--scheme", "pmjay", "--by", "tpa.desk"]);
    expect(dry).toMatchObject({ applied: false, rows: 8, added: 8, changed: 0, unchanged: 0 });
    expect(await db.select().from(ipdSchemePackages)).toHaveLength(0);
    await importSchemePackages(db, tpa, { scheme: "pmjay", csv, apply: true }, ist("2026-03-01T10:00:00"));
    expect(await db.select().from(ipdSchemePackages)).toHaveLength(8);
    await expect(importSchemePackages(db, tpa, { scheme: "pmjay", csv, apply: true })).resolves.toMatchObject({ added: 0, changed: 0, unchanged: 8 });
    const raised = csv.replace('"30,000"', '"32,000"');
    await expect(importSchemePackages(db, tpa, { scheme: "pmjay", csv: raised, apply: true })).resolves.toMatchObject({ added: 0, changed: 1, unchanged: 7 });
    const chole = await db.select().from(ipdSchemePackages).where(eq(ipdSchemePackages.code, "SMP-SG01A"));
    expect(chole.map((p) => [p.ratePaise, p.retiredAt === null]).sort()).toEqual([[3_000_000, false], [3_200_000, true]].sort());
    expect(await db.select().from(ipdSchemePackages).where(isNull(ipdSchemePackages.retiredAt))).toHaveLength(8);
    const bad = await ipdError(importSchemePackages(db, tpa, { scheme: "pmjay", csv: csv.replace('"20,000"', "abc"), apply: true }));
    expect(bad.code).toBe("package_import_invalid");
    expect(bad.detail?.problems).toEqual(["line 3: bad rate"]);
    expect(await db.select().from(ipdSchemePackages)).toHaveLength(9);
  });

  it("(v) PM-JAY: two packages make the payer amount ₹40,000; the patient owes ₹0 on every line; a package on a cash stay refuses", async () => {
    unregister = registerIpdReceiptGuard();
    await importSchemePackages(db, tpa, { scheme: "pmjay", csv: readFileSync(SAMPLE, "utf8"), apply: true });
    const pk = new Map((await db.select().from(ipdSchemePackages)).map((p) => [p.code, p.id] as const));
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    await auth(admissionId, ist("2026-03-10T10:00:00"), { payerKind: "pmjay", status: "approved", approvedAmountPaise: 4_000_000 });
    await selectSchemePackage(db, tpa, { idempotencyKey: key(), admissionId, packageId: pk.get("SMP-SG02A")! }, { now: ist("2026-03-10T10:05:00") });
    const two = await selectSchemePackage(db, tpa, { idempotencyKey: key(), admissionId, packageId: pk.get("SMP-SG01A")! }, { now: ist("2026-03-10T10:06:00") });
    expect(two.packageAmountPaise).toBe(4_000_000); // ₹30,000 at 100 % + ₹20,000 at 50 %
    expect((await refusal(selectSchemePackage(db, tpa, { idempotencyKey: key(), admissionId, packageId: pk.get("SMP-SG01A")! }))).code).toBe("package_already_selected");
    const panel = await readTpaPanel(db, tpa, admissionId, ist("2026-03-10T10:10:00"));
    expect(panel.packages.map((p) => [p.code, p.shareBp, p.amountPaise])).toEqual([["SMP-SG01A", 10_000, 3_000_000], ["SMP-SG02A", 5_000, 1_000_000]]);
    expect(panel.packageAmountPaise).toBe(4_000_000);
    await postNightlyIpdCharges(db, ist("2026-03-12T00:05:00"));
    const b = await readInterimBill(db, w.billDesk, admissionId);
    expect(b.payerSplit.lines.length).toBeGreaterThan(0);
    expect(b.payerSplit.lines.every((l) => l.patientPaise === 0)).toBe(true);
    expect(b.payerSplit.totals.patientPaise).toBe(0);
    await expect(recordReceipt(db, w.admitDesk, { patientId, tenders: [{ mode: "cash", amountPaise: 10_000 }] })).rejects.toMatchObject({ code: "receipt_guard_refused" });
    // A cash stay has no scheme package.
    const cash = await w.admitAt("general", ist("2026-03-10T09:30:00"));
    await db.update(ipdAdmissions).set({ payerKind: "cash" }).where(eq(ipdAdmissions.id, cash.admissionId));
    expect((await refusal(selectSchemePackage(db, tpa, { idempotencyKey: key(), admissionId: cash.admissionId, packageId: pk.get("SMP-SG01A")! }))).code)
      .toBe("package_needs_scheme");
  });

  /** An insured stay 10 → 12 March, final approval, settled at 09:30 on the 12th: a claim of ₹4,400 (two days). */
  const settledInsuredStay = async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    await auth(admissionId, ist("2026-03-10T10:00:00"), { status: "approved", approvedAmountPaise: 1_000_000 });
    await declareFit(db, w.doctor, { idempotencyKey: key(), admissionId, when: "today", disposition: "home" }, { now: ist("2026-03-12T08:00:00") });
    await confirmCharges(db, w.duty, { idempotencyKey: key(), admissionId, department: "ward" }, { now: ist("2026-03-12T08:05:00") });
    await confirmCharges(db, w.cashier, { idempotencyKey: key(), admissionId, department: "billing" }, { now: ist("2026-03-12T08:06:00") });
    const d = await saveSummaryDraft(db, w.doctor, { idempotencyKey: key(), admissionId, expectedVersion: 0, content: { diagnosis: { text: "Fever" } } }, { now: ist("2026-03-12T08:07:00") });
    await signSummary(db, w.doctor, { idempotencyKey: key(), admissionId, draftId: d.summaryId, draftVersion: d.version }, { now: ist("2026-03-12T08:08:00") });
    await auth(admissionId, ist("2026-03-12T09:00:00"), { entry: "final", status: "final_approved", approvedAmountPaise: 1_000_000 });
    const b = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:30:00") });
    await settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: b.billVersion, patientPayablePaise: b.patientPaise,
      ...(b.balancePaise > 0 ? { settlement: "paid", payments: [{ tender: "cash", amountPaise: b.balancePaise }] } : { settlement: "refund_due", payments: [] }),
    }, { now: ist("2026-03-12T09:30:00") });
    const claim = (await db.select().from(ipdPayerClaims).where(eq(ipdPayerClaims.admissionId, admissionId)))[0]!;
    expect(claim.claimPaise).toBe(440_000);
    return { admissionId, patientId, claimId: claim.id };
  };
  const attachClaimDocs = async (admissionId: string, patientId: string) => {
    for (const kind of ["discharge_summary", "final_bill"] as const) {
      await attachTpaDocument(db, tpa, { idempotencyKey: key(), admissionId, stage: "claim", kind, patientDocumentId: await doc(patientId) });
    }
  };

  it("(vi, viii) a claim is filed only with summary and bill attached; ageing shows at 30 days; a rejection then resubmission restarts the clock", async () => {
    const { admissionId, patientId, claimId } = await settledInsuredStay();
    let rows = (await rowsOf(ist("2026-03-12T12:00:00"))).filter((r) => r.claimId === claimId);
    expect(rows.map((r) => [r.kind, r.claimedPaise])).toEqual([["claim_to_submit", 440_000]]);
    const missing = await refusal(submitClaim(db, tpa, { idempotencyKey: key(), claimId, submittedAt: ist("2026-03-13T10:00:00").toISOString() }, { now: ist("2026-03-13T10:05:00") }));
    expect([missing.code, missing.detail?.missing]).toEqual(["claim_documents_missing", ["discharge_summary", "final_bill"]]);
    await attachClaimDocs(admissionId, patientId);
    const filed = await submitClaim(db, tpa, { idempotencyKey: key(), claimId, submittedAt: ist("2026-03-13T10:00:00").toISOString(), claimRef: "CL-FAKE-9" }, { now: ist("2026-03-13T10:05:00") });
    expect(filed.claimedPaise).toBe(440_000);
    rows = (await rowsOf(ist("2026-03-13T11:00:00"))).filter((r) => r.claimId === claimId);
    expect(rows.map((r) => [r.kind, r.severity])).toEqual([["claim_with_payer", "ok"]]);
    expect(await tpaDueCard({ db, now: ist("2026-04-11T10:00:00") })).toEqual([]); // 29 days
    const card = (await tpaDueCard({ db, now: ist("2026-04-13T10:01:00") }))[0]!; // 31 days
    expect(card.rows!.map((r) => [r.subtitle, r.severity])).toEqual([["PA-FAKE-1 · Claim with payer 31 days", "warn"]]);
    await recordClaimRejection(db, tpa, { idempotencyKey: key(), claimId, rejectedAt: ist("2026-04-14T10:00:00").toISOString(), reason: "Query not answered in time" }, { now: ist("2026-04-14T10:05:00") });
    const panel = await readTpaPanel(db, tpa, admissionId, ist("2026-04-14T11:00:00"));
    expect(panel.claims[0]).toMatchObject({ state: "rejected", rejectionReason: "Query not answered in time", missingDocuments: [] });
    await submitClaim(db, tpa, { idempotencyKey: key(), claimId, submittedAt: ist("2026-04-15T10:00:00").toISOString() }, { now: ist("2026-04-15T10:05:00") });
    expect(await tpaDueCard({ db, now: ist("2026-04-15T11:00:00") })).toEqual([]);
    expect((await readTpaPanel(db, tpa, admissionId, ist("2026-04-15T11:00:00"))).claims[0]).toMatchObject({ state: "with_payer", ageDays: 0 });
  });

  it("(vii) a settlement must add up; short-paid with two deductions reconciles to ₹0; the settled claim blocks the bill's void", async () => {
    const { admissionId, patientId, claimId } = await settledInsuredStay();
    await attachClaimDocs(admissionId, patientId);
    await submitClaim(db, tpa, { idempotencyKey: key(), claimId, submittedAt: ist("2026-03-13T10:00:00").toISOString() }, { now: ist("2026-03-13T10:05:00") });
    const settle = (deductions: unknown[]) => recordClaimSettlement(db, tpa, {
      idempotencyKey: key(), claimId, netPaidPaise: 300_000, tdsPaise: 44_000, deductions, utrRef: "UTR-FAKE-1", settledOn: "2026-04-02",
    }, { now: ist("2026-04-02T12:00:00") });
    const off = await refusal(settle([{ reason: "non_payable_items", amountPaise: 50_000 }]));
    expect([off.code, off.detail?.gapPaise]).toEqual(["settlement_does_not_add_up", 46_000]);
    const done = await settle([{ reason: "non_payable_items", amountPaise: 50_000 }, { reason: "room_rent_cap", amountPaise: 46_000 }]);
    expect(done).toMatchObject({ outcome: "short_paid", deductionsPaise: 96_000 });
    const c = (await readTpaPanel(db, tpa, admissionId, ist("2026-04-02T13:00:00"))).claims[0]!;
    expect(c).toMatchObject({
      state: "short_paid", billPayerPaise: 440_000, claimedPaise: 440_000, netPaidPaise: 300_000, tdsPaise: 44_000, deductionsPaise: 96_000,
      unexplainedPaise: 0, packageVariancePaise: 0, utrRef: "UTR-FAKE-1",
    });
    expect((await db.select().from(ipdPayerClaims).where(eq(ipdPayerClaims.id, claimId)))[0]!.status).toBe("settled");
    expect((await refusal(settle([]))).code).toBe("claim_wrong_state");
    // The bill whose claim the payer settled cannot be voided (#763).
    const bill = (await readTpaPanel(db, tpa, admissionId)).claims[0]!.finalBillId;
    const asked = await askBillVoid(db, w.cashier, { admissionId, billId: bill, reason: "wrong room class billed" });
    await approveRequest(db, w.billingManager, { approvalId: asked.approvalId, note: "checked" });
    const v = await ipdError(voidBill(db, w.cashier, { idempotencyKey: key(), admissionId, billId: bill, approvalId: asked.approvalId, reason: "x" }, { now: ist("2026-04-03T09:00:00") }));
    expect(v.code).toBe("payer_claim_settled");
  });

  it("(ix) money stays off doctors: no TPA intent names a doctor; no clinical role holds the desk's permissions; a doctor is refused the board", async () => {
    const TPA = ["record_tpa_query", "answer_tpa_query", "attach_tpa_document", "select_scheme_package", "remove_scheme_package", "submit_claim",
      "record_claim_settlement", "record_claim_rejection"] as const;
    for (const n of TPA) expect([n, IPD_INTENTS[n].actors.filter((x) => x === "doctor" || x === "resident" || x === "nurse")]).toEqual([n, []]);
    const desk = new Set(["ipd.payer.manage", "ipd.payer.terms"]);
    for (const name of Object.getOwnPropertyNames(IpdTpaController.prototype)) {
      if (name === "constructor") continue;
      const req = Reflect.getMetadata(PERMISSION_KEY, (IpdTpaController.prototype as unknown as Record<string, object>)[name]!) as { permission: string } | undefined;
      expect([name, desk.has(req?.permission ?? "")]).toEqual([name, true]);
    }
    expect(ipdManifest.desk?.find((d) => d.key === "ipd.tpa_due")?.permission).toBe("ipd.payer.manage");
    expect(ipdManifest.menu?.find((m) => m.path === "/ipd/tpa")?.permission).toBe("ipd.payer.manage");
    for (const role of ROLE_MODEL.filter((r) => IPD_CLINICAL_ROLES.includes(r.roleKey))) {
      expect([role.roleKey, role.permissions.filter((p) => desk.has(p))]).toEqual([role.roleKey, []]);
    }
    expect((await ipdError(readTpaBoard(db, w.doctor, ist("2026-03-10T10:00:00")))).code).toBe("ipd_forbidden");
  });
});
