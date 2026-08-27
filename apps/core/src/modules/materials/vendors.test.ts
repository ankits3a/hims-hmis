import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { approveRequest } from "../../kernel/approvals/decisions";
import { assignRole } from "../../kernel/auth/permissions";
import { createUser } from "../../kernel/auth/identity";
import { seedSodPairs } from "../../kernel/auth/sod";
import { approvals, events, roles, vendorBankChanges, vendors } from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import { registerMaterialsApprovalTypes } from "./approval-types";
import {
  activateVendor, addVendorDocument, applyBankChange, assertVendorPurchasable, blacklistVendor,
  getBankChange, getVendor, hasValidDocument, listBankChanges, listVendors, registerVendor,
  reinstateVendor, requestBankChange, suspendVendor, updateVendor,
} from "./vendors";
import type { BankDetails } from "./vendors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 14 T4 — the vendor master.
 *
 * ═══ THE FIXTURES DIFFER ON PURPOSE (§2.102) ═══
 *
 * Two coincidences this task can hide behind, and both are broken below:
 *   · **one document per vendor** — so `activateVendor`'s gate would pass on "any document at all".
 *     The fixtures carry GST + PAN, and the drug-licensed vendor carries four.
 *   · **`valid_to` null everywhere** — so A16's expiry half would never be exercised. The
 *     `hasValidDocument` legs use a window that has CLOSED and one that has not yet OPENED.
 *
 * ═══ THE CLOCK IS INJECTED EVERYWHERE, AND A5 IS WHY ═══
 *
 * `blacklistVendor`, `reinstateVendor` and `applyBankChange` all take a `now`. A5's discriminating
 * input is a reinstatement at `blacklist_until − 1 day` and again at `+ 1 day`; a function reading
 * `new Date()` internally could not be asked that question at all, and the boundary would go
 * untested for three years.
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const T0 = new Date("2026-08-27T06:00:00Z");
const DAY = 86_400_000;

const ACCOUNT: BankDetails = {
  accountNo: "123456789012", ifsc: "HDFC0001234", bankName: "HDFC Bank",
  branch: "Sector 62", accountHolder: "Acme Pharma Pvt Ltd",
};

async function eventsNamed(db: Db, name: string): Promise<{ payload: unknown }[]> {
  return db.select({ payload: events.payload }).from(events).where(eq(events.name, name));
}

describe("the vendor master (Plan 14 T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  /** A vendor in `draft`, with no paperwork. */
  async function draftVendor(code = "ACME"): Promise<string> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, HEAD, {
      code, legalName: "Acme Pharma Pvt Ltd", tradeName: "Acme",
      gstin: "09AAACA1234A1Z5", pan: "AAACA1234A", paymentTermsDays: 45,
    }));
    return vendorId;
  }

  /** …with the base paperwork on file and open-ended, so `activateVendor` passes. */
  async function activeVendor(code = "ACME"): Promise<string> {
    const vendorId = await draftVendor(code);
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, {
      type: "gst_certificate", number: "09AAACA1234A1Z5", validFrom: "2020-01-01",
    }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, {
      type: "pan", number: "AAACA1234A",
    }));
    await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0));
    return vendorId;
  }

  /**
   * A real user holding `owner` at hospital scope — **O-6's approver, and it must be a real row**:
   * `approveRequest` enforces the approver role through `rolesHeldBy`, and `role_assignments.role_key`
   * carries a foreign key into `roles`. A fabricated id would fail at the FK, and a user with no
   * assignment would fail the role check — which is the property being relied on, so it is built
   * rather than stubbed.
   */
  async function mkOwner(): Promise<string> {
    await db.insert(roles).values({ key: "owner", title: "owner" }).onConflictDoNothing();
    const { id } = await createUser(db, {
      username: `owner-${newId().slice(0, 10)}`, fullName: "Owner", password: "correct horse battery",
    });
    await assignRole(db, { userId: id, roleKey: "owner", scopeType: "hospital" });
    return id;
  }

  // ══════════════════════════ A5 — THE BLACKLIST CLOCK ══════════════════════════

  /**
   * **A5, and the two legs are the whole assertion.** A reinstate that checks only
   * `status === 'blacklisted'` either refuses both (if it also refuses on a date it never reads) or
   * accepts both (if it just flips status) — and only running BOTH separates it from the shipped
   * code, which fails the first and passes the second. The plan says so in as many words: *"A single
   * 'reinstate immediately' leg does not discriminate the always-refuse mutant."*
   */
  it("A5: reinstatement is REFUSED before blacklist_until and ALLOWED after it", async () => {
    const vendorId = await activeVendor();
    const { blacklistUntil } = await withTx(db, (tx) =>
      blacklistVendor(tx, HEAD, vendorId, "quality_failure", T0));

    // O-11: three years.
    expect(blacklistUntil.getUTCFullYear()).toBe(T0.getUTCFullYear() + 3);
    expect((await getVendor(db, vendorId))?.status).toBe("blacklisted");
    expect((await getVendor(db, vendorId))?.blacklistReason).toBe("quality_failure");

    // LEG 1 — one day BEFORE the clock runs out. Refused.
    const dayBefore = new Date(blacklistUntil.getTime() - DAY);
    await expect(withTx(db, (tx) => reinstateVendor(tx, HEAD, vendorId, dayBefore)))
      .rejects.toThrow(/may not be reinstated before/);
    try {
      await withTx(db, (tx) => reinstateVendor(tx, HEAD, vendorId, dayBefore));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("blacklist_active");
    }
    expect((await getVendor(db, vendorId))?.status).toBe("blacklisted");

    // LEG 2 — one day AFTER. Allowed.
    const dayAfter = new Date(blacklistUntil.getTime() + DAY);
    await withTx(db, (tx) => reinstateVendor(tx, HEAD, vendorId, dayAfter));
    const after = await getVendor(db, vendorId);
    // …to `suspended`, NOT to `active`: three years of sanction do not end in a vendor you may buy
    // from without re-checking a drug licence that has certainly expired meanwhile.
    expect(after?.status).toBe("suspended");
    expect(after?.blacklistUntil).toBeNull();
    expect(after?.blacklistReason).toBeNull();
  });

  it("A5 boundary: reinstatement AT blacklist_until exactly is allowed, not refused", async () => {
    const vendorId = await activeVendor();
    const { blacklistUntil } = await withTx(db, (tx) =>
      blacklistVendor(tx, HEAD, vendorId, "regulatory_breach", T0));
    // The comparison is `now < until`, so the instant itself is out of the window. A `<=` would
    // extend every sanction by an unspecified amount and nobody would notice for three years.
    await withTx(db, (tx) => reinstateVendor(tx, HEAD, vendorId, new Date(blacklistUntil.getTime())));
    expect((await getVendor(db, vendorId))?.status).toBe("suspended");
  });

  it("a blacklist reason outside O-11's four is refused — a sanction class is a ruling", async () => {
    const vendorId = await activeVendor();
    await expect(withTx(db, (tx) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blacklistVendor(tx, HEAD, vendorId, "we didn't like them" as any, T0)))
      .rejects.toThrow(/not one of the ruled blacklist triggers/);
  });

  it("reinstating a vendor that is not blacklisted refuses with a DIFFERENT code", async () => {
    const vendorId = await activeVendor();
    try {
      await withTx(db, (tx) => reinstateVendor(tx, HEAD, vendorId, T0));
      throw new Error("expected a refusal");
    } catch (e) {
      // `vendor_not_active`, not `blacklist_active` — "there is nothing to reinstate" and "the
      // clock has not run out" are different problems with different next steps.
      expect((e as MaterialsError).code).toBe("vendor_not_active");
    }
  });

  // ══════════════════════════ A6 — ONLY ONE PATH WRITES `bank` ══════════════════════════

  /**
   * **A6, and it has two legs because the mutant has two shapes.** One is an `updateVendor` that
   * spreads its input over the row with `bank` included; the other is an `applyBankChange` that
   * checks `approval_id IS NOT NULL` rather than the approval's STATUS — and `approval_id` is never
   * null, so that second mutant applies every change the instant it is requested.
   */
  it("A6: updateVendor cannot write `bank`, however the caller shapes its argument", async () => {
    const vendorId = await activeVendor();
    expect((await getVendor(db, vendorId))?.bank).toBeNull();

    // The plan's input: a legitimate field beside a `bank` the caller should not be able to set.
    // `updateVendor` builds its update FIELD BY FIELD rather than spreading, so the extra key is
    // inert even when the type is bypassed the way a JSON controller would bypass it.
    await withTx(db, (tx) => updateVendor(tx, HEAD, vendorId, {
      legalName: "Acme Pharmaceuticals Pvt Ltd",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ bank: ACCOUNT } as any),
    }));
    const after = await getVendor(db, vendorId);
    expect(after?.legalName).toBe("Acme Pharmaceuticals Pvt Ltd");
    expect(after?.bank).toBeNull();
    // …and the row itself, read raw, still holds nothing.
    const raw = await db.select({ bank: vendors.bank }).from(vendors).where(eq(vendors.id, vendorId));
    expect(raw[0]?.bank).toBeNull();
  });

  it("A6: applyBankChange on a PENDING approval refuses; on a GRANTED one it applies", async () => {
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const vendorId = await activeVendor();

    // O-6: the approver is the OWNER, always. A real user holding that role decides.
    const ownerId = await mkOwner();

    const { changeId, approvalId } = await withTx(db, (tx) =>
      requestBankChange(tx, HEAD, vendorId, ACCOUNT, "new account on letterhead"));

    // PENDING — refused, and the vendor is untouched.
    try {
      await withTx(db, (tx) => applyBankChange(tx, HEAD, changeId, T0));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("approval_not_granted");
    }
    expect((await getVendor(db, vendorId))?.bank).toBeNull();
    expect((await getVendor(db, vendorId))?.firstPaymentAllowedAt).toBeNull();

    // GRANTED — applied.
    await approveRequest(db, { type: "user", id: ownerId }, { approvalId, note: "verified by call-back" });
    const { coolingOffUntil } = await withTx(db, (tx) => applyBankChange(tx, HEAD, changeId, T0));

    const after = await getVendor(db, vendorId);
    expect(after?.bank).not.toBeNull();
    // O-6: seven days, stamped from the GRANT instant.
    expect(after?.firstPaymentAllowedAt?.getTime()).toBe(coolingOffUntil.getTime());
    const change = await getBankChange(db, changeId);
    expect(change?.status).toBe("applied");
    expect(change?.coolingOffUntil?.getTime()).toBe(coolingOffUntil.getTime());
    // **EXACTLY seven days after the DECISION**, read from the approvals row rather than derived.
    // The first draft of this leg compared against `appliedAt` and failed by ten hours, because
    // `appliedAt` is the INJECTED clock (`T0`) and the grant is a real recorded instant — which is
    // the whole point: the window must not be movable by whoever calls `applyBankChange`.
    const decided = (await db.select({ decidedAt: approvals.decidedAt }).from(approvals)
      .where(eq(approvals.id, approvalId)))[0]?.decidedAt;
    expect(decided).toBeInstanceOf(Date);
    expect(coolingOffUntil.getTime()).toBe((decided?.getTime() ?? 0) + 7 * DAY);

    // Applying a second time is refused — the change is no longer `pending`.
    await expect(withTx(db, (tx) => applyBankChange(tx, HEAD, changeId, T0)))
      .rejects.toThrow(/already "applied"/);
  });

  /**
   * The cooling-off is stamped from the GRANT, not from the REQUEST (O-6). A request that sat
   * unapproved for a month must not shorten the window it exists to create — and a mutant that used
   * the request timestamp would produce a `first_payment_allowed_at` already in the past.
   */
  it("A6: the cooling-off runs from the GRANT instant, not the request instant", async () => {
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const vendorId = await activeVendor();
    const ownerId = await mkOwner();

    const { changeId, approvalId } = await withTx(db, (tx) =>
      requestBankChange(tx, HEAD, vendorId, ACCOUNT));
    await approveRequest(db, { type: "user", id: ownerId }, { approvalId, note: "ok" });
    const { coolingOffUntil } = await withTx(db, (tx) => applyBankChange(tx, HEAD, changeId, T0));

    const change = await getBankChange(db, changeId);
    const decided = (await db.select({ decidedAt: approvals.decidedAt }).from(approvals)
      .where(eq(approvals.id, approvalId)))[0]?.decidedAt;
    // The window opens SEVEN DAYS after the DECISION — not after the request, and not after the
    // caller-supplied `now`. A mutant using the request timestamp would produce a window that had
    // already begun for any change approved more than a week after it was filed.
    expect(coolingOffUntil.getTime()).toBe((decided?.getTime() ?? 0) + 7 * DAY);
    expect(coolingOffUntil.getTime()).toBeGreaterThan(change?.createdAt.getTime() ?? 0);
    // …and `applied_at` is the caller's clock, which is a DIFFERENT instant and deliberately so:
    // when the change was applied and when the window opens are two facts, not one.
    expect(change?.appliedAt?.getTime()).toBe(T0.getTime());
  });

  it("a bank change against an unknown id refuses with `unknown_document`", async () => {
    try {
      await withTx(db, (tx) => applyBankChange(tx, HEAD, newId(), T0));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("unknown_document");
    }
  });

  // ══════════════════════════ A7 — MASKING ══════════════════════════

  /**
   * **A7, with the plan's own input: an account number `'123456789012'`.** The response must
   * contain `'9012'` and must NOT contain `'12345678'`. Trivial to build, and listed by the plan
   * because a reviewer would otherwise have to supply it.
   */
  it("A7: no read path returns more than the last four of an account number", async () => {
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const vendorId = await activeVendor();
    const ownerId = await mkOwner();
    const { changeId, approvalId } = await withTx(db, (tx) =>
      requestBankChange(tx, HEAD, vendorId, ACCOUNT));
    await approveRequest(db, { type: "user", id: ownerId }, { approvalId, note: "ok" });
    await withTx(db, (tx) => applyBankChange(tx, HEAD, changeId, T0));

    const one = JSON.stringify(await getVendor(db, vendorId));
    expect(one).toContain("9012");
    expect(one).not.toContain("12345678");
    expect(one).not.toContain("123456789012");
    // The list path is a SEPARATE mapper in most codebases and is where masking is forgotten.
    const many = JSON.stringify(await listVendors(db));
    expect(many).toContain("9012");
    expect(many).not.toContain("12345678");
    // …and so is the change LIST, which carries `newBank` in the row and must not return it.
    const changes = JSON.stringify(await listBankChanges(db, vendorId));
    expect(changes).toContain("9012");
    expect(changes).not.toContain("12345678");

    // The ONE reader that legitimately holds the full object — guarded by `materials.vendors.manage`.
    expect(JSON.stringify(await getBankChange(db, changeId))).toContain("123456789012");

    // The EVENT carries no bank values at all — `changed: ["bank"]` and nothing else (DD12).
    const updated = await eventsNamed(db, "vendor.updated");
    const bankEvents = updated.filter((e) => (e.payload as { changed: string[] }).changed.includes("bank"));
    expect(bankEvents).toHaveLength(1);
    expect(JSON.stringify(bankEvents)).not.toContain("9012");
    expect(JSON.stringify(bankEvents)).not.toContain("HDFC0001234");
  });

  it("a short account number leaks NOTHING rather than most of itself", async () => {
    // `slice(-4)` on a 3-character string returns the whole string. The guard is the length check,
    // and this is the leg that says so: a "1234"-length account masks to nothing at all.
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const vendorId = await activeVendor();
    const ownerId = await mkOwner();
    const { changeId, approvalId } = await withTx(db, (tx) => requestBankChange(tx, HEAD, vendorId, {
      accountNo: "789", ifsc: "HDFC0001234",
    }));
    await approveRequest(db, { type: "user", id: ownerId }, { approvalId, note: "ok" });
    await withTx(db, (tx) => applyBankChange(tx, HEAD, changeId, T0));
    expect((await getVendor(db, vendorId))?.bank?.accountNo).toBe("••••");
  });

  // ══════════════════════════ documents, and the O-8 read T6 uses ══════════════════════════

  /**
   * `hasValidDocument` is A16's subject one task early. Its `valid_to` half is what a mutant would
   * drop, so the legs below use a window that has CLOSED and one that has not yet OPENED — a
   * document with `valid_to: null` could not distinguish them.
   */
  it("hasValidDocument honours BOTH bounds, and a NULL bound is open-ended", async () => {
    const vendorId = await draftVendor();
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, {
      type: "consignment_agreement", number: "CA/2026/1",
      validFrom: "2026-01-01", validTo: "2026-08-26",
    }));
    // Inside the window.
    expect(await hasValidDocument(db, vendorId, "consignment_agreement", "2026-06-01")).toBe(true);
    // The last day is INCLUSIVE.
    expect(await hasValidDocument(db, vendorId, "consignment_agreement", "2026-08-26")).toBe(true);
    // **EXPIRED YESTERDAY** — A16's discriminating input, one day past `valid_to`.
    expect(await hasValidDocument(db, vendorId, "consignment_agreement", "2026-08-27")).toBe(false);
    // NOT YET IN FORCE — the other bound, which a `valid_to`-only check would also miss.
    expect(await hasValidDocument(db, vendorId, "consignment_agreement", "2025-12-31")).toBe(false);
    // A type the vendor has none of.
    expect(await hasValidDocument(db, vendorId, "drug_licence_20b", "2026-06-01")).toBe(false);

    // An OPEN-ENDED document (a PAN certificate) is valid for ever, and treating null as expired
    // would refuse every vendor who ever filed one.
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "pan", number: "AAACA1234A" }));
    expect(await hasValidDocument(db, vendorId, "pan", "2099-01-01")).toBe(true);
  });

  it("activateVendor REFUSES without the base paperwork, and demands more of a drug vendor", async () => {
    const vendorId = await draftVendor();
    // Nothing on file at all.
    try {
      await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("documents_incomplete");
      expect((e as MaterialsError).message).toContain("gst_certificate");
      expect((e as MaterialsError).message).toContain("pan");
    }
    // ONE document is not enough — the coincidence §2.102 warns about, made a leg.
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, {
      type: "gst_certificate", number: "09AAACA1234A1Z5",
    }));
    await expect(withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0)))
      .rejects.toThrow(/no valid pan on file/);
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "pan", number: "AAACA1234A" }));
    await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0));
    expect((await getVendor(db, vendorId))?.status).toBe("active");

    // A DRUG-LICENSED vendor needs both halves of the wholesale licence on top.
    const drugVendorId = await draftVendor("MEDSUP");
    await withTx(db, (tx) => updateVendor(tx, HEAD, drugVendorId, { classFlags: { drugLicensed: true } }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, drugVendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, drugVendorId, { type: "pan", number: "p" }));
    await expect(withTx(db, (tx) => activateVendor(tx, HEAD, drugVendorId, T0)))
      .rejects.toThrow(/drug_licence_20b/);
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, drugVendorId, {
      type: "drug_licence_20b", number: "20B/123", validTo: "2027-12-31",
    }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, drugVendorId, {
      type: "drug_licence_21b", number: "21B/123", validTo: "2027-12-31",
    }));
    await withTx(db, (tx) => activateVendor(tx, HEAD, drugVendorId, T0));
    expect((await getVendor(db, drugVendorId))?.status).toBe("active");
  });

  it("an EXPIRED drug licence does not activate a vendor today", async () => {
    const vendorId = await draftVendor("EXPIRED");
    await withTx(db, (tx) => updateVendor(tx, HEAD, vendorId, { classFlags: { drugLicensed: true } }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, {
      type: "drug_licence_20b", number: "20B/old", validTo: "2026-08-26", // yesterday
    }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, {
      type: "drug_licence_21b", number: "21B/ok", validTo: "2027-12-31",
    }));
    await expect(withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0)))
      .rejects.toThrow(/drug_licence_20b/);
  });

  // ══════════════════════════ lifecycle events, and the purchasable gate ══════════════════════════

  it("vendor.status_changed fires ONCE per transition and names both ends", async () => {
    const vendorId = await activeVendor();
    await withTx(db, (tx) => suspendVendor(tx, HEAD, vendorId, "under review"));
    await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0));
    await withTx(db, (tx) => blacklistVendor(tx, HEAD, vendorId, "integrity_breach", T0));

    const transitions = await eventsNamed(db, "vendor.status_changed");
    expect(transitions.map((e) => {
      const p = e.payload as { fromStatus: string; toStatus: string };
      return `${p.fromStatus}->${p.toStatus}`;
    })).toEqual(["draft->active", "active->suspended", "suspended->active", "active->blacklisted"]);
    // The blacklist carries its trigger code; the others carry null or free text.
    const last = transitions[3]?.payload as { reason: string | null };
    expect(last.reason).toBe("integrity_breach");

    // A re-activation of an already-active vendor is a NO-OP, not a second event.
    await withTx(db, (tx) => reinstateVendor(tx, HEAD, vendorId, new Date(T0.getTime() + 4 * 365 * DAY)));
    await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0));
    await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0));
    expect(await eventsNamed(db, "vendor.status_changed")).toHaveLength(6);
  });

  it("assertVendorPurchasable admits only `active`, and distinguishes blacklisted from draft", async () => {
    const draftId = await draftVendor("DRAFT1");
    try {
      await assertVendorPurchasable(db, draftId);
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("vendor_not_active");
    }
    const activeId = await activeVendor("LIVE1");
    expect((await assertVendorPurchasable(db, activeId)).code).toBe("LIVE1");

    await withTx(db, (tx) => blacklistVendor(tx, HEAD, activeId, "chronic_non_supply", T0));
    try {
      await assertVendorPurchasable(db, activeId);
      throw new Error("expected a refusal");
    } catch (e) {
      // A DIFFERENT code from `vendor_not_active`: the remedy for a blacklist is a three-year wait
      // and a reinstatement, not "activate it".
      expect((e as MaterialsError).code).toBe("vendor_blacklisted");
    }
  });

  it("a blacklisted vendor cannot be activated straight out of the sanction", async () => {
    const vendorId = await activeVendor();
    await withTx(db, (tx) => blacklistVendor(tx, HEAD, vendorId, "quality_failure", T0));
    await expect(withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0)))
      .rejects.toThrow(/blacklisted/);
  });

  it("registers with `draft`, refuses a duplicate code, and emits vendor.registered once", async () => {
    const vendorId = await draftVendor();
    expect((await getVendor(db, vendorId))?.status).toBe("draft");
    expect(await eventsNamed(db, "vendor.registered")).toHaveLength(1);
    try {
      await draftVendor("acme");
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("duplicate_code");
    }
    expect(await getVendor(db, newId())).toBeUndefined();
  });
});
