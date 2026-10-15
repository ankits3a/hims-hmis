import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { approveRequest } from "../../kernel/approvals/decisions";
import { ipdPayerClaims, ipdSchemePackages, ipdTpaDocuments, patientDocuments } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkDischargeWorld } from "../../../test/helpers/ipd";
import { mkTpaDesk } from "../../../test/helpers/ipd-payer";
import { lockAdmission } from "./admission-core";
import {
  IpdError, IpdRefusal, askBillVoid, attachTpaDocument, confirmCharges, declareFit, importSchemePackages, postNightlyIpdCharges,
  prepareFinalBill, prepareSupplementaryBill, readTpaPanel, recordClaimSettlement, recordPayerAuth, recordTpaQuery, removeSchemePackage, saveSummaryDraft, selectSchemePackage,
  settleFinalBill, settleSupplementaryBill, signSummary, submitClaim, voidBill,
} from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DischargeWorld } from "../../../test/helpers/ipd";

/**
 * #604 review — the claim's money guards: one scheme package is claimed once across a stay's bills, a typed amount never
 * exceeds what the bill or the packages allow, packages freeze once a claim is filed, a bill whose claim is with the payer
 * is not voided, and a final-bill document attached before the bill existed does not file the claim. Explicit IST instants.
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = (): string => randomUUID();
const SAMPLE = join(__dirname, "..", "..", "..", "scripts", "data", "nha-hbp-sample.csv");

async function refusal(p: Promise<unknown>): Promise<IpdRefusal | IpdError> {
  try { await p; } catch (e) { if (e instanceof IpdRefusal || e instanceof IpdError) return e; throw e; }
  throw new Error("expected a refusal");
}

describe("#604 review — TPA claim money guards", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: DischargeWorld;
  let tpa: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkDischargeWorld(db); tpa = await mkTpaDesk(db); });

  const doc = async (patientId: string) => {
    const id = newId();
    await db.insert(patientDocuments).values({
      id, patientId, kind: "outside_report", mimeType: "application/pdf", byteSize: 10, storageKey: `2026/03/${id}.pdf`, sha256: "0".repeat(64),
      capturedBy: tpa.id,
    });
    return id;
  };
  const attach = async (admissionId: string, patientId: string, claimId?: string, kinds: readonly ("discharge_summary" | "final_bill")[] = ["discharge_summary", "final_bill"]) => {
    for (const kind of kinds) {
      await attachTpaDocument(db, tpa, {
        idempotencyKey: key(), admissionId, stage: "claim", kind, patientDocumentId: await doc(patientId), ...(claimId === undefined ? {} : { claimId }),
      });
    }
  };
  const fitAndReady = async (admissionId: string) => {
    await declareFit(db, w.doctor, { idempotencyKey: key(), admissionId, when: "today", disposition: "home" }, { now: ist("2026-03-12T08:00:00") });
    await confirmCharges(db, w.duty, { idempotencyKey: key(), admissionId, department: "ward" }, { now: ist("2026-03-12T08:05:00") });
    await confirmCharges(db, w.cashier, { idempotencyKey: key(), admissionId, department: "billing" }, { now: ist("2026-03-12T08:06:00") });
    const d = await saveSummaryDraft(db, w.doctor, { idempotencyKey: key(), admissionId, expectedVersion: 0, content: { diagnosis: { text: "Fever" } } }, { now: ist("2026-03-12T08:07:00") });
    await signSummary(db, w.doctor, { idempotencyKey: key(), admissionId, draftId: d.summaryId, draftVersion: d.version }, { now: ist("2026-03-12T08:08:00") });
  };
  const settleFinal = async (admissionId: string, at: Date) => {
    const b = await prepareFinalBill(db, w.cashier, admissionId, { now: at });
    return settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: b.billVersion, patientPayablePaise: b.patientPaise,
      ...(b.balancePaise > 0 ? { settlement: "paid", payments: [{ tender: "cash", amountPaise: b.balancePaise }] } : { settlement: "refund_due", payments: [] }),
    }, { now: at });
  };
  const claimsOf = (admissionId: string) => db.select().from(ipdPayerClaims).where(eq(ipdPayerClaims.admissionId, admissionId))
    .orderBy(asc(ipdPayerClaims.createdAt), asc(ipdPayerClaims.id));
  const submit = (claimId: string, at: string, claimedPaise?: number) => submitClaim(db, tpa, {
    idempotencyKey: key(), claimId, submittedAt: ist(at).toISOString(), ...(claimedPaise === undefined ? {} : { claimedPaise }),
  }, { now: ist(at) });

  /** A PM-JAY stay with the ₹30,000 package, final bill settled at 09:30 on the 12th. */
  const schemeStay = async () => {
    await importSchemePackages(db, tpa, { scheme: "pmjay", csv: readFileSync(SAMPLE, "utf8"), apply: true });
    const pk = (await db.select().from(ipdSchemePackages).where(eq(ipdSchemePackages.code, "SMP-SG01A")))[0]!;
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    await recordPayerAuth(db, tpa, {
      idempotencyKey: key(), admissionId, payerKind: "pmjay", entry: "initial", status: "approved", approvedAmountPaise: 3_000_000,
      provisionalCashlessSigned: true, preAuthNumber: "PA-FAKE-2",
    }, { now: ist("2026-03-10T10:00:00") });
    const sel = await selectSchemePackage(db, tpa, { idempotencyKey: key(), admissionId, packageId: pk.id }, { now: ist("2026-03-10T10:05:00") });
    await fitAndReady(admissionId);
    await settleFinal(admissionId, ist("2026-03-12T09:30:00"));
    return { admissionId, patientId, selectionId: sel.selectionId };
  };

  it("a package stay with a supplementary bill claims the package once, not once per bill", async () => {
    const { admissionId, patientId } = await schemeStay();
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    await postNightlyIpdCharges(db, ist("2026-03-14T00:05:00"));
    const supp = await prepareSupplementaryBill(db, w.cashier, admissionId, { now: ist("2026-03-14T09:05:00") });
    await settleSupplementaryBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: supp.billVersion, patientPayablePaise: supp.patientPaise, settlement: "refund_due", payments: [],
    }, { now: ist("2026-03-14T09:10:00") });
    const [first, second] = await claimsOf(admissionId);
    expect(second).toBeDefined();
    await attach(admissionId, patientId);
    expect((await submit(first!.id, "2026-03-15T10:00:00")).claimedPaise).toBe(3_000_000);
    // The second bill's default is what the packages still leave: nothing.
    const panel = await readTpaPanel(db, tpa, admissionId, ist("2026-03-15T11:00:00"));
    expect(panel.claims.find((c) => c.id === second!.id)?.defaultClaimPaise).toBe(0);
    expect((await refusal(submit(second!.id, "2026-03-15T10:10:00"))).code).toBe("claim_exceeds_claimable");
    expect((await refusal(submit(second!.id, "2026-03-15T10:10:00", 100))).code).toBe("claim_exceeds_claimable");
  });

  it("a typed claim above the bill's payer portion refuses", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    await recordPayerAuth(db, tpa, {
      idempotencyKey: key(), admissionId, payerKind: "insurance_cashless", entry: "initial", status: "approved", approvedAmountPaise: 1_000_000,
      provisionalCashlessSigned: true, preAuthNumber: "PA-FAKE-1",
    }, { now: ist("2026-03-10T10:00:00") });
    await fitAndReady(admissionId);
    await recordPayerAuth(db, tpa, {
      idempotencyKey: key(), admissionId, payerKind: "insurance_cashless", entry: "final", status: "final_approved", approvedAmountPaise: 1_000_000,
      provisionalCashlessSigned: true, preAuthNumber: "PA-FAKE-1",
    }, { now: ist("2026-03-12T09:00:00") });
    await settleFinal(admissionId, ist("2026-03-12T09:30:00"));
    const [claim] = await claimsOf(admissionId);
    await attach(admissionId, patientId);
    const r = await refusal(submit(claim!.id, "2026-03-13T10:00:00", claim!.claimPaise + 1));
    expect([r.code, r.detail?.capPaise]).toEqual(["claim_exceeds_claimable", claim!.claimPaise]);
    expect((await submit(claim!.id, "2026-03-13T10:00:00", claim!.claimPaise)).claimedPaise).toBe(claim!.claimPaise);
  });

  it("packages freeze once a claim is filed", async () => {
    const { admissionId, patientId, selectionId } = await schemeStay();
    const [claim] = await claimsOf(admissionId);
    await attach(admissionId, patientId);
    await submit(claim!.id, "2026-03-12T10:00:00");
    const r = await refusal(removeSchemePackage(db, tpa, { idempotencyKey: key(), admissionId, selectionId, reason: "wrong package" }, { now: ist("2026-03-12T10:30:00") }));
    expect(r.code).toBe("package_claim_filed");
  });

  it("a bill whose claim is with the payer is not voided (its settlement could never be recorded)", async () => {
    const { admissionId, patientId } = await schemeStay();
    const [claim] = await claimsOf(admissionId);
    await attach(admissionId, patientId);
    await submit(claim!.id, "2026-03-12T10:00:00");
    const asked = await askBillVoid(db, w.cashier, { admissionId, billId: claim!.finalBillId, reason: "wrong room class billed" });
    await approveRequest(db, w.billingManager, { approvalId: asked.approvalId, note: "checked" });
    const r = await refusal(voidBill(db, w.cashier, { idempotencyKey: key(), admissionId, billId: claim!.finalBillId, approvalId: asked.approvalId, reason: "x" }, { now: ist("2026-03-12T11:00:00") }));
    expect(r.code).toBe("payer_claim_filed");
  });

  it("a final-bill document attached before the claim's bill existed does not file it", async () => {
    await importSchemePackages(db, tpa, { scheme: "pmjay", csv: readFileSync(SAMPLE, "utf8"), apply: true });
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    await recordPayerAuth(db, tpa, {
      idempotencyKey: key(), admissionId, payerKind: "pmjay", entry: "initial", status: "approved", approvedAmountPaise: 3_000_000,
      provisionalCashlessSigned: true, preAuthNumber: "PA-FAKE-2",
    }, { now: ist("2026-03-10T10:00:00") });
    // Attached on the 11th: no bill exists yet.
    for (const kind of ["discharge_summary", "final_bill"] as const) {
      await attachTpaDocument(db, tpa, { idempotencyKey: key(), admissionId, stage: "claim", kind, patientDocumentId: await doc(patientId) }, { now: ist("2026-03-11T10:00:00") });
    }
    await fitAndReady(admissionId);
    await settleFinal(admissionId, ist("2026-03-12T09:30:00"));
    const [claim] = await claimsOf(admissionId);
    const r = await refusal(submit(claim!.id, "2026-03-12T10:00:00"));
    expect([r.code, r.detail?.missing]).toEqual(["claim_documents_missing", ["final_bill"]]);
  });

  it("an attach racing another in-flight attach of the same document answers that attachment, not a 500", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    const d = await doc(patientId);
    // Deterministic race: a first attach holds its transaction open (as the intent does: admission lock, then the row)
    // while the second attach runs; the first then commits.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let inserted!: () => void;
    const ready = new Promise<void>((r) => { inserted = r; });
    const firstId = newId();
    const first = db.transaction(async (tx) => {
      await lockAdmission(tx, admissionId);
      await tx.insert(ipdTpaDocuments).values({
        id: firstId, admissionId, claimId: null, stage: "preauth", kind: "investigations", patientDocumentId: d, attachedBy: tpa.id, attachedAt: new Date(),
      });
      inserted();
      await gate;
    });
    await ready;
    const second = attachTpaDocument(db, tpa, { idempotencyKey: key(), admissionId, stage: "preauth", kind: "investigations", patientDocumentId: d });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await first;
    expect((await second).attachmentId).toBe(firstId);
  });

  it("a query or a document on a withdrawn claim refuses", async () => {
    const { admissionId, patientId } = await schemeStay();
    const [claim] = await claimsOf(admissionId);
    const asked = await askBillVoid(db, w.cashier, { admissionId, billId: claim!.finalBillId, reason: "wrong room class billed" });
    await approveRequest(db, w.billingManager, { approvalId: asked.approvalId, note: "checked" });
    await voidBill(db, w.cashier, { idempotencyKey: key(), admissionId, billId: claim!.finalBillId, approvalId: asked.approvalId, reason: "x" }, { now: ist("2026-03-12T11:00:00") });
    expect((await claimsOf(admissionId))[0]!.status).toBe("withdrawn");
    const q = await refusal(recordTpaQuery(db, tpa, {
      idempotencyKey: key(), admissionId, stage: "claim", claimId: claim!.id, raisedAt: ist("2026-03-12T11:30:00").toISOString(), queryText: "Send the bill",
    }, { now: ist("2026-03-12T11:35:00") }));
    expect(q.code).toBe("claim_wrong_state");
    const d = await refusal(attachTpaDocument(db, tpa, {
      idempotencyKey: key(), admissionId, stage: "claim", kind: "final_bill", patientDocumentId: await doc(patientId), claimId: claim!.id,
    }, { now: ist("2026-03-12T11:40:00") }));
    expect(d.code).toBe("claim_wrong_state");
  });

  it("a settlement dated after today in IST refuses; today in IST is accepted even while UTC is still on yesterday", async () => {
    const { admissionId, patientId } = await schemeStay();
    const [claim] = await claimsOf(admissionId);
    await attach(admissionId, patientId);
    await submit(claim!.id, "2026-03-12T10:00:00");
    const settle = (settledOn: string, at: string) => recordClaimSettlement(db, tpa, {
      idempotencyKey: key(), claimId: claim!.id, netPaidPaise: 2_700_000, tdsPaise: 300_000, deductions: [], utrRef: "UTR-FAKE-2", settledOn,
    }, { now: ist(at) });
    expect((await refusal(settle("2026-03-14", "2026-03-13T23:00:00"))).code).toBe("time_in_future");
    // 02:00 IST on the 13th is still the 12th in UTC: the 13th is today, not the future.
    await expect(settle("2026-03-13", "2026-03-13T02:00:00")).resolves.toMatchObject({ outcome: "settled" });
  });
});
