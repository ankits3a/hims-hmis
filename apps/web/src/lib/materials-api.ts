import { api, ApiError } from "./api";
import en from "../locales/en.json";

/**
 * PLAN 14 T9 — the materials wire contract, transcribed from `materials.controller.ts` exactly as
 * `formulary-api.ts` and `membership-api.ts` transcribe theirs: this file DESCRIBES what those
 * routes ship and never re-derives or widens it.
 *
 * ═══ MONEY IS INTEGER PAISE AND QUANTITIES ARE INTEGER BASE UNITS, ALL THE WAY TO THE INPUT ═══
 *
 * DD7 holds on this side of the wire too. `mrpPaise` and `unitCostPaise` are integers; `qtyInUom`
 * is an integer of the pack the storekeeper picked and `qtyBase` never crosses the wire on the way
 * IN at all — the server computes it, once, from the item's own UoM table (A2). A screen that did
 * the multiplication itself would be a second place a multiplier lives.
 *
 * ═══ `bank.accountNo` IS ALWAYS ALREADY MASKED ═══
 *
 * Every vendor read route masks it server-side (T4, A7). The type below says `accountNo: string`
 * because that is what arrives — `"••••9012"` — and there is deliberately no client-side masking
 * helper, because a client that could mask is a client somebody will one day ask to unmask.
 */

export type WireItem = {
  id: string; code: string; name: string; class: string;
  formularyMedicineId: string | null;
  hsnCode: string | null; gstRateBps: number | null;
  baseUom: string; batchTracked: boolean; serialTracked: boolean;
  storageClass: string; shelfLifeDays: number | null;
  abcClass: string | null; vedClass: string | null; active: boolean;
};

export type WireItemUom = {
  id: string; itemId: string; uom: string; toBaseMultiplier: number;
  isPurchaseUom: boolean; isIssueUom: boolean;
};

export type WireItemDetail = WireItem & { uoms: WireItemUom[]; barcodes: { id: string; code: string; packUom: string }[] };

/** MASKED. See the header — `accountNo` is `"••••9012"`, and there is no unmasked shape here. */
export type WireVendor = {
  id: string; code: string; legalName: string; tradeName: string | null;
  gstin: string | null; pan: string | null; msmeClass: string | null;
  paymentTermsDays: number | null; classFlags: Record<string, boolean>;
  bank: { accountNo: string; ifsc?: string; bankName?: string } | null;
  firstPaymentAllowedAt: string | null;
  status: "draft" | "active" | "suspended" | "blacklisted";
  blacklistUntil: string | null; blacklistReason: string | null;
};

export type WireVendorDocument = {
  id: string; vendorId: string; type: string; number: string;
  validFrom: string | null; validTo: string | null;
};

export type WireStore = { id: string; code: string; name: string; status: string };

export type WireGrnLine = {
  id: string; itemId: string; uom: string; qtyInUom: number; qtyBase: number;
  batchNo: string | null; mfgDate: string | null; expiryDate: string | null;
  mrpPaise: number | null; mrpUom: string | null; unitCostPaise: number;
  freeGoods: boolean; qtyAcceptedBase: number; qtyRejectedBase: number;
  /** The RULE CODE that fired, rendered through its locale string — never shown raw (DD16). */
  rejectReason: string | null;
  nearExpiry: boolean; batchId: string | null;
};

export type WireGrn = {
  id: string; grnNo: string; vendorId: string; source: string;
  challanNo: string; challanDate: string; invoiceNo: string | null;
  storeResourceId: string; status: string;
  capturedBy: string; qcBy: string | null; postedAt: string | null; approvalId: string | null;
  lines: WireGrnLine[];
};

export type WireExpiringBatch = {
  batchId: string; itemId: string; batchNo: string; expiryDate: string;
  daysRemaining: number; qtyOnHandTotal: number;
};

export type WireTransfer = {
  id: string; fromResourceId: string; toResourceId: string; status: string;
  issuedAt: string; receivedAt: string | null;
  lines: { id: string; batchId: string; qtyIssued: number; qtyReceived: number | null; discrepancyReason: string | null }[];
};

export type CaptureLineInput = {
  itemId: string; uom: string; qtyInUom: number;
  batchNo?: string | null; mfgDate?: string | null; expiryDate?: string | null;
  mrpPaise?: number | null; mrpUom?: string | null;
  unitCostPaise: number; freeGoods?: boolean;
};

// ─────────────────────────────── items ───────────────────────────────

export async function fetchItems(q: { search?: string; class?: string } = {}): Promise<WireItem[]> {
  const params = new URLSearchParams();
  if (q.search !== undefined && q.search !== "") params.set("search", q.search);
  if (q.class !== undefined && q.class !== "") params.set("class", q.class);
  const qs = params.toString();
  const { items } = await api<{ items: WireItem[] }>("GET", `/materials/items${qs === "" ? "" : `?${qs}`}`);
  return items;
}

export async function fetchItem(id: string): Promise<WireItemDetail> {
  const { item } = await api<{ item: WireItemDetail }>("GET", `/materials/items/${id}`);
  return item;
}

export type CreateItemInput = {
  code: string; name: string; class: string; baseUom: string; batchTracked: boolean;
  formularyMedicineId?: string | null; hsnCode?: string | null; gstRateBps?: number | null;
  shelfLifeDays?: number | null; storageClass?: string;
  uoms?: { uom: string; toBaseMultiplier: number }[];
};

export async function createItem(input: CreateItemInput): Promise<{ itemId: string }> {
  return api<{ itemId: string }>("POST", "/materials/items", input);
}

export async function patchItem(id: string, patch: Partial<CreateItemInput> & { active?: boolean }): Promise<void> {
  await api<{ ok: true }>("PATCH", `/materials/items/${id}`, patch);
}

// ─────────────────────────────── vendors ───────────────────────────────

export async function fetchVendors(q: { search?: string; status?: string } = {}): Promise<WireVendor[]> {
  const params = new URLSearchParams();
  if (q.search !== undefined && q.search !== "") params.set("search", q.search);
  if (q.status !== undefined && q.status !== "") params.set("status", q.status);
  const qs = params.toString();
  const { vendors } = await api<{ vendors: WireVendor[] }>("GET", `/materials/vendors${qs === "" ? "" : `?${qs}`}`);
  return vendors;
}

export async function fetchVendor(id: string): Promise<{ vendor: WireVendor; documents: WireVendorDocument[] }> {
  return api<{ vendor: WireVendor; documents: WireVendorDocument[] }>("GET", `/materials/vendors/${id}`);
}

export async function createVendor(input: {
  code: string; legalName: string; tradeName?: string | null;
  gstin?: string | null; pan?: string | null; paymentTermsDays?: number | null;
  classFlags?: Record<string, boolean>;
}): Promise<{ vendorId: string }> {
  return api<{ vendorId: string }>("POST", "/materials/vendors", input);
}

export async function addVendorDocument(vendorId: string, input: {
  type: string; number: string; validFrom?: string | null; validTo?: string | null;
}): Promise<{ documentId: string }> {
  return api<{ documentId: string }>("POST", `/materials/vendors/${vendorId}/documents`, input);
}

export async function activateVendor(vendorId: string): Promise<void> {
  await api<{ ok: true }>("POST", `/materials/vendors/${vendorId}/activate`, {});
}
export async function suspendVendor(vendorId: string, reason: string): Promise<void> {
  await api<{ ok: true }>("POST", `/materials/vendors/${vendorId}/suspend`, { reason });
}
export async function reinstateVendor(vendorId: string): Promise<void> {
  await api<{ ok: true }>("POST", `/materials/vendors/${vendorId}/reinstate`, {});
}
export async function blacklistVendor(vendorId: string, reason: string): Promise<{ blacklistUntil: string }> {
  return api<{ blacklistUntil: string }>("POST", `/materials/vendors/${vendorId}/blacklist`, { reason });
}

// ─────────────────────────────── stores, stock, the GRN gate ───────────────────────────────

export async function fetchStores(): Promise<WireStore[]> {
  const { stores } = await api<{ stores: WireStore[] }>("GET", "/materials/stores");
  return stores;
}

export async function fetchGrns(): Promise<WireGrn[]> {
  const { grns } = await api<{ grns: WireGrn[] }>("GET", "/materials/grns");
  return grns;
}

export async function fetchGrn(id: string): Promise<WireGrn> {
  const { grn } = await api<{ grn: WireGrn }>("GET", `/materials/grns/${id}`);
  return grn;
}

export async function captureGrn(input: {
  vendorId: string; source: string; storeResourceId: string;
  challanNo: string; challanDate: string; invoiceNo?: string | null;
  lines: CaptureLineInput[];
}): Promise<{ grnId: string; grnNo: string }> {
  return api<{ grnId: string; grnNo: string }>("POST", "/materials/grns", input);
}

export async function runGrnQc(grnId: string): Promise<{ status: string; verdicts: { grnLineId: string; verdict: string; rule?: string }[] }> {
  return api<{ status: string; verdicts: { grnLineId: string; verdict: string; rule?: string }[] }>(
    "POST", `/materials/grns/${grnId}/qc`, {},
  );
}

export async function requestNearExpiry(grnId: string, note?: string): Promise<{ approvalId: string }> {
  return api<{ approvalId: string }>("POST", `/materials/grns/${grnId}/near-expiry-request`, { note });
}

export async function postGrn(grnId: string): Promise<{ status: string; ledgerEntryIds: string[] }> {
  return api<{ status: string; ledgerEntryIds: string[] }>("POST", `/materials/grns/${grnId}/post`, {});
}

export async function fetchExpiring(): Promise<WireExpiringBatch[]> {
  const { batches } = await api<{ batches: WireExpiringBatch[] }>("GET", "/materials/expiring");
  return batches;
}

export async function fetchDiscrepancies(): Promise<WireTransfer[]> {
  const { transfers } = await api<{ transfers: WireTransfer[] }>("GET", "/materials/transfers/discrepancies");
  return transfers;
}

/**
 * The server's own message, never a client-side re-derivation.
 *
 * `materials.controller.ts` maps every `MaterialsError` — and, since finding F13, every
 * `ApprovalError` — to a 4xx carrying `{ message, code }`. The screen shows the MESSAGE, which is
 * the sentence the module wrote about its own refusal; a client that rebuilt the sentence from the
 * code would be a second copy of the error catalogue (§2.54), and it would drift.
 */
export function materialsErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: string; code?: string } | null;
    return body?.message ?? body?.code ?? e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** The refusal's CODE, for a screen that needs to render a locale string rather than the message. */
export function materialsErrorCode(e: unknown): string | null {
  if (e instanceof ApiError) {
    const body = e.body as { code?: string } | null;
    return body?.code ?? null;
  }
  return null;
}

/**
 * ═══ CLOSE REVIEW m6 — WHAT A SCREEN ACTUALLY SHOWS: THE LOCALE STRING, THEN THE MESSAGE ═══
 *
 * `materialsErrorCode` shipped with the docstring above — *"for a screen that needs to render a
 * locale string"* — and **no screen called it.** All three rendered `materialsErrorMessage`, which
 * is the server's sentence and the server's sentence is English. So a Hindi storekeeper got a Hindi
 * form, Hindi buttons, Hindi QC verdicts (`materialsGrn.rule_*`, thirteen keys, both locales — that
 * half was done right), and then an English sentence at the only moment the screen has something
 * urgent to say. T9's acceptance asked for the locale string.
 *
 * The order here is deliberate and it is NOT a fallback chain bolted on for safety:
 *
 *   · **The CODE first**, through `materialsErrors.<code>` — 24 keys, one per member of
 *     `MaterialsErrorCode`, in `en.json` and `hi.json`. This is the sentence a user reads.
 *   · **The server's MESSAGE second**, for anything with no key: an `ApprovalError`, a
 *     `ResourceError` (which only became mappable at all in this same remediation, M1), a
 *     validation refusal from the pipe. A wrong-language sentence beats a blank box or a raw code.
 *
 * Membership is tested against the IMPORTED `en.json` rather than i18next's missing-key behaviour,
 * which is configuration and can change under us. `i18n.test.ts` already asserts `hi` mirrors `en`
 * key-for-key, so one check covers both locales; **`apps/core/src/modules/materials/errors.test.ts`**
 * ("m6: every declared code has a sentence in BOTH locales") then asserts this block against the
 * module's union in both directions, so a code added in `apps/core` cannot reach a screen with no
 * sentence to show for it, and a stale sentence cannot outlive its code.
 *
 * **SECOND-PASS FINDING F2 — that sentence originally named `materials-errors-parity.test.ts`, and
 * no such file exists.** The property was guarded all along, by the file named above; only the
 * citation was invented. It is recorded rather than quietly corrected because of where it happened:
 * this is §2.122's defect — a claim about the test suite, in the file the test would guard —
 * committed **inside the remediation for §2.122**, by the session that wrote the lesson. The
 * mechanical form that entry prescribes (`grep` the sources for every `*.test.ts` string and `find`
 * each one repo-wide) was run against `apps/core/src/modules/materials` and found nothing, because
 * this file is in `apps/web`. **A census scoped to where the defect last appeared is not a census.**
 */
export function materialsErrorText(e: unknown, t: (key: string) => string): string {
  const code = materialsErrorCode(e);
  if (code !== null && Object.prototype.hasOwnProperty.call(en.materialsErrors, code)) {
    return t(`materialsErrors.${code}`);
  }
  return materialsErrorMessage(e);
}
