/**
 * A payload as JSON with every ULID replaced by `<id>`, for word scans such as "no money word in the
 * Tower". A ULID is 26 random Crockford characters, so `01M5FEE5…` or `…PAYER…` turns up by chance and
 * failed `main` on 2026-10-21. The alphabet has no I, L, O or U, so only some words can appear at all.
 */
export function jsonWithoutIds(v: unknown): string {
  return JSON.stringify(v).replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, "<id>");
}
