import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { vendorBankChanges, vendorDocuments, vendors } from "../../kernel/db/schema";
import { BANK_CHANGE_COOLING_OFF_DAYS, BLACKLIST_REASONS, BLACKLIST_YEARS } from "./config";
import { VENDOR_BANK_CHANGE_APPROVAL_TYPE } from "./approval-types";
import { MaterialsError } from "./errors";
import { vendorRegistered, vendorStatusChanged, vendorUpdated } from "./events";
import type { BlacklistReason } from "./config";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

export type VendorRow = typeof vendors.$inferSelect;
export type VendorDocumentRow = typeof vendorDocuments.$inferSelect;
export type VendorBankChangeRow = typeof vendorBankChanges.$inferSelect;

/** What a bank account looks like everywhere OUTSIDE `vendor_bank_changes`. */
export type BankDetails = {
  accountNo: string;
  ifsc: string;
  bankName?: string;
  branch?: string;
  accountHolder?: string;
};

/** The masked form. `accountNo` is the LAST FOUR and nothing else, for ever. */
export type MaskedBank = Omit<BankDetails, "accountNo"> & { accountNo: string };

/** A vendor as every read path outside `vendor_bank_changes` returns it. */
export type VendorView = Omit<VendorRow, "bank"> & { bank: MaskedBank | null };

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

/**
 * PLAN 14 T4 — the vendor master: documents, lifecycle, blacklist, and the bank change.
 *
 * ═══ WHY THIS IS NOT `counterparties` (DD4) ═══
 *
 * `counterparties.payee_class` is a CLOSED CHECK over three commission classes
 * (`channel_partner | staff_internal | external_rmp`), its agreements are attribution and payout
 * terms, and its SoD pairs are payout-preparer/approver. A supplier of gloves is none of those
 * things: its pairs are PO-approver/GRN-receiver and custodian/counter, its documents are drug
 * licences and Udyam certificates, and its lifecycle has `blacklisted`. Forcing one table to carry
 * both would be `patient_merge_requests.approval_id` again — a column meaning two things.
 *
 * ═══ MASKING IS A PROPERTY OF THE READ PATH, NOT OF THE CALLER'S DISCRETION (A7) ═══
 *
 * `getVendor` and `listVendors` do not return `bank`. They return `mask(bank)`, and there is no
 * flag to turn it off. The full object exists in exactly one place — a `vendor_bank_changes` row —
 * and `getBankChange` is the only reader of it. That is doc 09 §7's DPDP class
 * (financial-sensitive, masked in UI, change-controlled) built as a shape rather than as a rule
 * somebody has to remember, because a rule somebody has to remember is a rule that gets forgotten
 * in the first hurried controller.
 *
 * The event stream is the second leak and it is closed the same way: the bank change emits
 * `vendor.updated { changed: ["bank"] }` and **no bank values at all** (DD4/DD12, and the payload
 * schema in `events.ts` makes it structural). Events are replayed into projections and dumped into
 * logs; an account number in one is an account number in all of them, for ever.
 *
 * ═══ THREE CLOCKS, AND ALL THREE ARE INJECTED ═══
 *
 * `blacklistVendor`, `reinstateVendor` and `applyBankChange` each take a `now`. That is not test
 * convenience: **A5's discriminating input is a reinstatement one day before `blacklist_until` and
 * one day after**, and a function reading `new Date()` internally cannot be asked that question at
 * all. A guard whose clock cannot be moved is a guard whose boundary is never tested.
 */

/** The last four, and nothing else. Total for anything shorter — a 3-digit "account" leaks nothing. */
function mask(bank: unknown): MaskedBank | null {
  if (bank === null || bank === undefined || typeof bank !== "object") return null;
  const b = bank as Partial<BankDetails>;
  const accountNo = typeof b.accountNo === "string" ? b.accountNo : "";
  const lastFour = accountNo.length > 4 ? accountNo.slice(-4) : "";
  return {
    ...b,
    accountNo: `••••${lastFour}`,
  } as MaskedBank;
}

/** The public view. The ONLY way a vendor row leaves this module. */
function view(row: VendorRow): VendorView {
  const { bank, ...rest } = row;
  return { ...rest, bank: mask(bank) };
}

async function requireVendor(tx: Tx | Db, vendorId: string): Promise<VendorRow> {
  const rows = await tx.select().from(vendors).where(eq(vendors.id, vendorId));
  const row = rows[0];
  if (row === undefined) throw new MaterialsError("unknown_vendor", `vendor ${vendorId} not found`);
  return row;
}

/** One transition, one event, one place. Every lifecycle function below routes through it. */
async function transition(
  tx: Tx,
  actor: Actor,
  vendor: VendorRow,
  toStatus: string,
  patch: Partial<typeof vendors.$inferInsert>,
  reason: string | null,
): Promise<void> {
  await tx.update(vendors)
    .set({ ...patch, status: toStatus, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(vendors.id, vendor.id));
  await appendEvent(tx, vendorStatusChanged.make({
    payload: { vendorId: vendor.id, fromStatus: vendor.status, toStatus, reason },
    actor, correlationId: vendor.id,
  }));
}

// ═══════════════════════════════════ REGISTRATION AND PATCHING ═══════════════════════════════════

export async function registerVendor(
  tx: Tx,
  actor: Actor,
  input: {
    code: string; legalName: string; tradeName?: string | null; gstin?: string | null;
    pan?: string | null; msmeUdyamNo?: string | null; msmeClass?: string | null;
    paymentTermsDays?: number | null; classFlags?: Record<string, boolean>;
  },
): Promise<{ vendorId: string }> {
  const vendorId = newId();
  try {
    await tx.insert(vendors).values({
      id: vendorId, code: input.code, legalName: input.legalName,
      tradeName: input.tradeName ?? null, gstin: input.gstin ?? null, pan: input.pan ?? null,
      msmeUdyamNo: input.msmeUdyamNo ?? null, msmeClass: input.msmeClass ?? null,
      paymentTermsDays: input.paymentTermsDays ?? null,
      classFlags: input.classFlags ?? {},
      // `draft`, ALWAYS. A vendor becomes purchasable only through `activateVendor`, which checks
      // the paperwork — registering straight into `active` would make the document gate optional.
      status: "draft",
      createdBy: actor.id, updatedBy: actor.id,
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new MaterialsError("duplicate_code", `a vendor with code "${input.code}" already exists`);
    }
    throw e;
  }
  await appendEvent(tx, vendorRegistered.make({
    payload: { vendorId, code: input.code, legalName: input.legalName, gstin: input.gstin ?? null },
    actor, correlationId: vendorId,
  }));
  return { vendorId };
}

/**
 * **THIS FUNCTION CANNOT TOUCH `bank`, AND THE TYPE IS THE FIRST LINE OF THAT DEFENCE (A6).**
 *
 * `bank` is absent from the patch type, so a caller passing it does not compile. That is not
 * sufficient on its own — a controller receiving JSON and spreading it would defeat any type — so
 * the SECOND line is that this function builds its update from named fields rather than spreading
 * its input. A6's mutant is precisely `updateVendor` spreading its input over the row with `bank`
 * included, which writes a new account with no approval, no cooling-off and no audit row.
 *
 * `status` is absent for the same reason: it moves only through the lifecycle functions, each of
 * which emits `vendor.status_changed`. A patch that could set it would be a transition with no event.
 */
export async function updateVendor(
  tx: Tx,
  actor: Actor,
  vendorId: string,
  patch: {
    legalName?: string; tradeName?: string | null; gstin?: string | null;
    gstinVerifiedAt?: Date | null; pan?: string | null; msmeUdyamNo?: string | null;
    msmeClass?: string | null; paymentTermsDays?: number | null;
    classFlags?: Record<string, boolean>;
  },
): Promise<void> {
  await requireVendor(tx, vendorId);
  // Built field by field, NEVER spread — see the docstring. A field absent from this list cannot
  // be written by this path however the caller shapes its argument.
  const next: Partial<typeof vendors.$inferInsert> = {};
  if (patch.legalName !== undefined) next.legalName = patch.legalName;
  if (patch.tradeName !== undefined) next.tradeName = patch.tradeName;
  if (patch.gstin !== undefined) next.gstin = patch.gstin;
  if (patch.gstinVerifiedAt !== undefined) next.gstinVerifiedAt = patch.gstinVerifiedAt;
  if (patch.pan !== undefined) next.pan = patch.pan;
  if (patch.msmeUdyamNo !== undefined) next.msmeUdyamNo = patch.msmeUdyamNo;
  if (patch.msmeClass !== undefined) next.msmeClass = patch.msmeClass;
  if (patch.paymentTermsDays !== undefined) next.paymentTermsDays = patch.paymentTermsDays;
  if (patch.classFlags !== undefined) next.classFlags = patch.classFlags;

  const changed = Object.keys(next);
  if (changed.length === 0) return;
  await tx.update(vendors)
    .set({ ...next, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(vendors.id, vendorId));
  await appendEvent(tx, vendorUpdated.make({
    payload: { vendorId, changed }, actor, correlationId: vendorId,
  }));
}

// ═══════════════════════════════════ DOCUMENTS ═══════════════════════════════════

export async function addVendorDocument(
  tx: Tx,
  actor: Actor,
  vendorId: string,
  input: {
    type: string; number: string; validFrom?: string | null; validTo?: string | null;
    fileRef?: string | null;
  },
): Promise<{ documentId: string }> {
  await requireVendor(tx, vendorId);
  const documentId = newId();
  await tx.insert(vendorDocuments).values({
    id: documentId, vendorId, type: input.type, number: input.number,
    validFrom: input.validFrom ?? null, validTo: input.validTo ?? null,
    fileRef: input.fileRef ?? null, createdBy: actor.id,
  });
  await appendEvent(tx, vendorUpdated.make({
    payload: { vendorId, changed: ["documents"] }, actor, correlationId: vendorId,
  }));
  return { documentId };
}

/**
 * **THE READ T6's O-8 GATE USES, AND `valid_to` IS THE HALF THAT MATTERS (A16).**
 *
 * A document is valid on `onDate` when its window CONTAINS that date, and a NULL bound is OPEN —
 * a PAN certificate has no expiry, and treating null as "expired" would refuse every vendor who
 * ever filed one. A16's mutant checks existence and ignores `valid_to` altogether; its
 * discriminating input is a consignment agreement whose `valid_to` is the day BEFORE the challan
 * date. A vendor with no document at all cannot tell the two apart.
 *
 * `onDate` is an IST calendar date string (`YYYY-MM-DD`), matching the `date` columns it compares
 * against, so no timezone arithmetic happens here — the challan date has already been resolved to
 * the hospital's day by its caller, and re-deriving it from an instant would be a second piece of
 * code that might disagree about the offset (`series.ts`'s rule, same reasoning).
 */
export async function hasValidDocument(
  db: Db | Tx,
  vendorId: string,
  type: string,
  onDate: string,
): Promise<boolean> {
  const rows = await db.select({ id: vendorDocuments.id }).from(vendorDocuments)
    .where(and(
      eq(vendorDocuments.vendorId, vendorId),
      eq(vendorDocuments.type, type),
      or(isNull(vendorDocuments.validFrom), sql`${vendorDocuments.validFrom} <= ${onDate}`),
      or(isNull(vendorDocuments.validTo), sql`${vendorDocuments.validTo} >= ${onDate}`),
    ))
    .limit(1);
  return rows.length > 0;
}

export async function listVendorDocuments(db: Db | Tx, vendorId: string): Promise<VendorDocumentRow[]> {
  return db.select().from(vendorDocuments).where(eq(vendorDocuments.vendorId, vendorId))
    .orderBy(asc(vendorDocuments.type));
}

// ═══════════════════════════════════ LIFECYCLE ═══════════════════════════════════

/** The minimum paperwork any vendor class needs before it may be purchased from. */
const BASE_DOCUMENT_TYPES = ["gst_certificate", "pan"] as const;
/** …and what a `drugLicensed` vendor needs on top of it. */
const DRUG_DOCUMENT_TYPES = ["drug_licence_20b", "drug_licence_21b"] as const;

/**
 * `draft | suspended` → `active`, and the document gate is what makes the `draft` default mean
 * something. A vendor with neither a GST certificate nor a PAN on file is a vendor nobody has
 * identified; a `drugLicensed` one additionally needs BOTH halves of the wholesale licence (20B
 * for allopathic, 21B for the restricted schedule) because receiving drugs without one is the
 * offence, not the paperwork.
 *
 * Validity is checked as of `now`'s IST date — a licence that expired last month does not activate
 * a vendor today, which is the same rule `hasValidDocument` serves to T6.
 */
export async function activateVendor(
  tx: Tx,
  actor: Actor,
  vendorId: string,
  now: Date,
): Promise<void> {
  const vendor = await requireVendor(tx, vendorId);
  if (vendor.status === "blacklisted") {
    throw new MaterialsError(
      "vendor_blacklisted",
      `vendor ${vendor.code} is blacklisted — reinstate it first (O-11)`,
    );
  }
  if (vendor.status === "active") return;

  const onDate = now.toISOString().slice(0, 10);
  const required: string[] = [...BASE_DOCUMENT_TYPES];
  if (vendor.classFlags.drugLicensed === true) required.push(...DRUG_DOCUMENT_TYPES);
  const missing: string[] = [];
  for (const type of required) {
    if (!(await hasValidDocument(tx, vendorId, type, onDate))) missing.push(type);
  }
  if (missing.length > 0) {
    throw new MaterialsError(
      "documents_incomplete",
      `vendor ${vendor.code} cannot be activated: no valid ${missing.join(", ")} on file as of ${onDate}`,
      { missing, onDate },
    );
  }
  await transition(tx, actor, vendor, "active", {}, null);
}

export async function suspendVendor(
  tx: Tx, actor: Actor, vendorId: string, reason: string,
): Promise<void> {
  const vendor = await requireVendor(tx, vendorId);
  if (vendor.status === "blacklisted") {
    throw new MaterialsError("vendor_blacklisted", `vendor ${vendor.code} is blacklisted, not merely suspended`);
  }
  await transition(tx, actor, vendor, "suspended", {}, reason);
}

/**
 * **O-11 RULED 2026-08-27 — three years, and the reason comes from a closed list.**
 *
 * Free text was the alternative and it is the wrong one: a blacklist is a three-year commercial
 * sanction with a legal tail, 14b's scorecard needs to count them by kind, and "poor quality"
 * written forty ways counts as forty things. See `config.ts` for the four codes.
 */
export async function blacklistVendor(
  tx: Tx,
  actor: Actor,
  vendorId: string,
  reason: BlacklistReason,
  now: Date,
): Promise<{ blacklistUntil: Date }> {
  const vendor = await requireVendor(tx, vendorId);
  if (!(BLACKLIST_REASONS as readonly string[]).includes(reason)) {
    throw new MaterialsError(
      "vendor_blacklisted",
      `"${reason}" is not one of the ruled blacklist triggers (${BLACKLIST_REASONS.join(", ")}) — ` +
        "a new sanction class is a ruling, not a free-text field (O-11)",
      { reason, allowed: BLACKLIST_REASONS },
    );
  }
  const blacklistUntil = new Date(now);
  blacklistUntil.setUTCFullYear(blacklistUntil.getUTCFullYear() + BLACKLIST_YEARS);
  await transition(tx, actor, vendor, "blacklisted", {
    blacklistUntil, blacklistReason: reason,
  }, reason);
  return { blacklistUntil };
}

/**
 * **A5 LIVES HERE.** Reinstatement before `blacklist_until` is REFUSED; on or after it, allowed.
 *
 * A5's mutant checks `status === 'blacklisted'` and ignores the date, and the plan names the
 * discriminating input exactly: blacklist, then reinstate at `blacklist_until − 1 day` and again at
 * `+ 1 day`. **A single "reinstate immediately" leg cannot discriminate** — an always-refusing
 * mutant and the shipped code both refuse it, and only the two-leg pair separates them.
 *
 * The vendor returns to `suspended`, NOT to `active`: three years of sanction do not end in a
 * vendor you may immediately buy from without re-checking a drug licence that has certainly
 * expired in the meantime. `activateVendor` is the next step and it runs the document gate.
 */
export async function reinstateVendor(
  tx: Tx,
  actor: Actor,
  vendorId: string,
  now: Date,
): Promise<void> {
  const vendor = await requireVendor(tx, vendorId);
  if (vendor.status !== "blacklisted") {
    throw new MaterialsError(
      "vendor_not_active",
      `vendor ${vendor.code} is "${vendor.status}", not blacklisted — there is nothing to reinstate`,
      { status: vendor.status },
    );
  }
  const until = vendor.blacklistUntil;
  if (until !== null && now.getTime() < until.getTime()) {
    throw new MaterialsError(
      "blacklist_active",
      `vendor ${vendor.code} is blacklisted until ${until.toISOString()} and may not be reinstated ` +
        `before then (O-11: ${String(BLACKLIST_YEARS)} years)`,
      { blacklistUntil: until.toISOString(), reason: vendor.blacklistReason },
    );
  }
  await transition(tx, actor, vendor, "suspended", {
    blacklistUntil: null, blacklistReason: null,
  }, null);
}

// ═══════════════════════════════════ THE BANK CHANGE (DD10, O-6) ═══════════════════════════════════

/**
 * Files the OWNER approval and records a `pending` change row holding the new account.
 *
 * `payeeId = vendorId` because the engine's C-12 aggregation needs a target and this is the honest
 * one: a bank change carries no amount and no patient (DD10). The subject is
 * `{ type: 'vendor_bank_change', id }` so the worklist can open the row the decision is about.
 */
export async function requestBankChange(
  tx: Tx,
  actor: Actor,
  vendorId: string,
  newBank: BankDetails,
  note?: string,
): Promise<{ changeId: string; approvalId: string }> {
  const vendor = await requireVendor(tx, vendorId);
  if (typeof newBank.accountNo !== "string" || newBank.accountNo.trim() === "") {
    throw new MaterialsError("unknown_document", "a bank change must carry an account number");
  }
  const changeId = newId();
  const { approvalId } = await requestApproval(tx, actor, {
    typeKey: VENDOR_BANK_CHANGE_APPROVAL_TYPE,
    subject: { type: "vendor_bank_change", id: changeId },
    payeeId: vendorId,
    requestNote: note,
  });
  await tx.insert(vendorBankChanges).values({
    id: changeId, vendorId,
    oldMasked: mask(vendor.bank)?.accountNo ?? null,
    newMasked: mask(newBank)?.accountNo ?? "••••",
    newBank,
    requestedBy: actor.id,
    approvalId,
    status: "pending",
  });
  return { changeId, approvalId };
}

/**
 * **THE ONLY PATH THAT WRITES `vendors.bank` (A6), AND IT REQUIRES A GRANTED APPROVAL.**
 *
 * A6's second leg is `applyBankChange` on a `pending` change: the shipped code refuses
 * `approval_not_granted`; a mutant that checked `approval_id IS NOT NULL` rather than the
 * approval's STATUS would apply it — and `approval_id` is never null, so that mutant applies
 * every change the moment it is requested, which is the whole cooling-off period defeated by one
 * missing word.
 *
 * **The cooling-off is stamped from the GRANT instant, not the request instant** (O-6). A request
 * that sat unapproved for a month must not shorten the window it exists to create. `granted_at`
 * is the approval's `decided_at`; `now` is only the fallback for an approval whose row carries no
 * decision timestamp, which the engine does not produce.
 *
 * **Nothing in this phase pays anyone, so nothing here ENFORCES the cooling-off** (DD10). 14c's
 * payment run refuses a payee whose `first_payment_allowed_at` is in the future; the column exists
 * now so that phase READS the date rather than re-deriving it.
 */
export async function applyBankChange(
  tx: Tx,
  actor: Actor,
  changeId: string,
  now: Date,
): Promise<{ coolingOffUntil: Date }> {
  const rows = await tx.select().from(vendorBankChanges).where(eq(vendorBankChanges.id, changeId));
  const change = rows[0];
  if (change === undefined) {
    throw new MaterialsError("unknown_document", `bank change ${changeId} not found`);
  }
  if (change.status !== "pending") {
    throw new MaterialsError(
      "already_received",
      `bank change ${changeId} is already "${change.status}"`,
      { status: change.status },
    );
  }
  const approval = await getApproval(tx as unknown as Db, change.approvalId);
  if (approval === null || approval.status !== "granted") {
    throw new MaterialsError(
      "approval_not_granted",
      `bank change ${changeId} needs a GRANTED ${VENDOR_BANK_CHANGE_APPROVAL_TYPE} approval; its ` +
        `approval is "${approval?.status ?? "missing"}" (O-6: owner approval always)`,
      { approvalStatus: approval?.status ?? null },
    );
  }

  const grantedAt = approval.decidedAt ?? now;
  const coolingOffUntil = new Date(grantedAt.getTime() + BANK_CHANGE_COOLING_OFF_DAYS * 86_400_000);

  await tx.update(vendors)
    .set({
      bank: change.newBank,
      firstPaymentAllowedAt: coolingOffUntil,
      updatedBy: actor.id, updatedAt: new Date(),
    })
    .where(eq(vendors.id, change.vendorId));
  await tx.update(vendorBankChanges)
    .set({ status: "applied", coolingOffUntil, appliedAt: now })
    .where(eq(vendorBankChanges.id, changeId));

  // `changed: ["bank"]` and NO BANK VALUES — see the file header, and the payload schema in
  // `events.ts` that makes it structural rather than a convention.
  await appendEvent(tx, vendorUpdated.make({
    payload: { vendorId: change.vendorId, changed: ["bank"] },
    actor, correlationId: change.vendorId,
  }));
  return { coolingOffUntil };
}

// ═══════════════════════════════════════ READS ═══════════════════════════════════════

/** MASKED. There is no unmasked read of a vendor anywhere in this module (A7). */
export async function getVendor(db: Db | Tx, vendorId: string): Promise<VendorView | undefined> {
  const rows = await db.select().from(vendors).where(eq(vendors.id, vendorId));
  const row = rows[0];
  return row === undefined ? undefined : view(row);
}

/** MASKED, all of them. */
export async function listVendors(
  db: Db | Tx,
  filter: { status?: string; search?: string } = {},
): Promise<VendorView[]> {
  const clauses = [];
  if (filter.status !== undefined) clauses.push(eq(vendors.status, filter.status));
  if (filter.search !== undefined && filter.search.trim() !== "") {
    const needle = `%${filter.search.trim().toLowerCase()}%`;
    clauses.push(sql`(lower(${vendors.legalName}) like ${needle} or lower(${vendors.code}) like ${needle})`);
  }
  const q = db.select().from(vendors).orderBy(asc(vendors.code));
  const rows = clauses.length === 0 ? await q : await q.where(and(...clauses));
  return rows.map(view);
}

/**
 * The change rows for a vendor, MASKED. The full `newBank` object never leaves this module through
 * a list — `getBankChange` is the single reader of it and the controller guards that route on
 * `materials.vendors.manage`.
 */
export async function listBankChanges(
  db: Db | Tx, vendorId: string,
): Promise<Omit<VendorBankChangeRow, "newBank">[]> {
  const rows = await db.select().from(vendorBankChanges)
    .where(eq(vendorBankChanges.vendorId, vendorId))
    .orderBy(asc(vendorBankChanges.createdAt));
  // Built by OMISSION rather than by destructuring-and-discarding: the lint rule forbids an
  // unused binding, and more to the point a named-but-unused variable holding an account number is
  // exactly the shape a later edit "tidies" into a return value.
  return rows.map((r) => ({
    id: r.id, vendorId: r.vendorId, oldMasked: r.oldMasked, newMasked: r.newMasked,
    requestedBy: r.requestedBy, approvalId: r.approvalId, status: r.status,
    coolingOffUntil: r.coolingOffUntil, appliedAt: r.appliedAt, createdAt: r.createdAt,
  }));
}

/** THE ONE READER OF AN UNMASKED ACCOUNT NUMBER. Guarded by `materials.vendors.manage` (T8). */
export async function getBankChange(
  db: Db | Tx, changeId: string,
): Promise<VendorBankChangeRow | undefined> {
  const rows = await db.select().from(vendorBankChanges).where(eq(vendorBankChanges.id, changeId));
  return rows[0];
}

/**
 * The gate T6 calls before accepting a challan: only an `active` vendor may be received from, and a
 * blacklisted one refuses differently from a merely-draft one because the remedy differs.
 */
export async function assertVendorPurchasable(tx: Tx | Db, vendorId: string): Promise<VendorRow> {
  const vendor = await requireVendor(tx, vendorId);
  if (vendor.status === "blacklisted") {
    throw new MaterialsError(
      "vendor_blacklisted",
      `vendor ${vendor.code} is blacklisted${vendor.blacklistReason === null ? "" : ` (${vendor.blacklistReason})`}`,
      { blacklistUntil: vendor.blacklistUntil?.toISOString() ?? null },
    );
  }
  if (vendor.status !== "active") {
    throw new MaterialsError(
      "vendor_not_active",
      `vendor ${vendor.code} is "${vendor.status}" — only an active vendor may be received from`,
      { status: vendor.status },
    );
  }
  return vendor;
}
