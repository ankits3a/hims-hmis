/**
 * ═══ HSN FOR GOODS, SAC FOR SERVICES (walk 2026-11-13, spec #1046) ═══
 *
 * A GST invoice names each line's tariff code, and the code's NAME follows what was supplied: goods carry an HSN
 * code (a strip of medicine: 3004), services a Services Accounting Code (a consultation: 999312). Every SAC sits in
 * chapter 99, which the HSN leaves to services, so the code itself says which it is — no second field to drift.
 * The walk-in bill printed "SAC 3004" under "Service" while the desk's printed "HSN 3004"; both now ask this.
 *
 * Shared by the server's printed bill and the browser's invoice (the web reads it from source). No imports.
 */
export type GstCodeKind = "HSN" | "SAC";

/** "HSN" for a goods code, "SAC" for a services code (chapter 99); null when there is no code to name. */
export function gstCodeKind(code: string | null | undefined): GstCodeKind | null {
  const c = (code ?? "").trim();
  if (c === "") return null;
  return c.startsWith("99") ? "SAC" : "HSN";
}
