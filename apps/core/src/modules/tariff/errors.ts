export type TariffErrorCode =
  | "invalid_paise" | "invalid_qty" | "unknown_service" | "service_inactive" | "duplicate_service_code"
  | "tariff_item_missing" | "regulated_price_missing" | "regulated_bounds_missing"
  | "gst_config_missing" | "gst_config_invalid" | "settings_missing"
  | "unknown_version" | "version_not_active" | "not_draft" | "not_submitted" | "empty_version"
  | "approval_not_granted" | "approval_rejected" | "approval_subject_mismatch" | "sod_drafter_activator" | "effective_from_not_monotone"
  | "unknown_rule" | "invalid_rule_params";

export class TariffError extends Error {
  constructor(readonly code: TariffErrorCode, message?: string) {
    super(message ?? code);
    this.name = "TariffError";
  }
}
