/**
 * STORES S1 (#1111) — every refusal the Stores module makes, one code each. The screen renders a
 * code as a short sentence (`stores.err.<code>` in the locales); the controller maps it to a status.
 */
export const STORES_ERROR_CODES = [
  // ── the item master (decisions 1, 2, 3, 5) ──
  "not_stores_class",
  "patient_billable_refused",
  "category_required",
  "unknown_category",
  "category_too_deep",
  "track_mode_required",
  "unknown_item",
  "not_stores_item",
  "duplicate_code",
  // ── the new-item queue ──
  "unknown_request",
  "request_closed",
  "item_id_required",
  // ── stores and shelves (decision 6) ──
  "unknown_store",
  "not_a_shelf",
  "floor_required",
  "unknown_department",
  "supplier_not_stores",
  // ── acts at a shelf (decisions 7–12, 16) ──
  "not_permitted",
  "bad_quantity",
  "more_than_on_hand",
  "durable_not_used",
  "already_opened",
  "par_on_expensed",
  "not_reversible",
  "already_reversed",
  "not_this_shelf",
] as const;

export type StoresErrorCode = (typeof STORES_ERROR_CODES)[number];

export class StoresError extends Error {
  constructor(
    readonly code: StoresErrorCode,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? `Stores refused: ${code}`);
    this.name = "StoresError";
  }
}

const STATUS: Record<StoresErrorCode, number> = {
  not_stores_class: 422,
  patient_billable_refused: 422,
  category_required: 422,
  unknown_category: 404,
  category_too_deep: 422,
  track_mode_required: 422,
  unknown_item: 404,
  not_stores_item: 422,
  duplicate_code: 409,
  unknown_request: 404,
  request_closed: 409,
  item_id_required: 422,
  unknown_store: 404,
  not_a_shelf: 422,
  floor_required: 422,
  unknown_department: 404,
  supplier_not_stores: 422,
  not_permitted: 403,
  bad_quantity: 422,
  more_than_on_hand: 409,
  durable_not_used: 409,
  already_opened: 409,
  par_on_expensed: 422,
  not_reversible: 409,
  already_reversed: 409,
  not_this_shelf: 422,
};

export function storesHttpStatus(code: StoresErrorCode): number {
  return STATUS[code];
}
