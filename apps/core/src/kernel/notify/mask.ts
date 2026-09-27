/**
 * PHARMACY P6 (patient messages) — A NUMBER IN A LOG KEEPS ITS LAST FOUR DIGITS AND NOTHING ELSE.
 *
 * The console sink is what production runs until a provider is contracted, so its line is where every
 * patient's phone would otherwise pile up in clear; a provider's error text lands in
 * `notifications.last_error`, which the desk flag and the office read. Four digits are enough to match
 * a complaint ("the one ending 3210") and not enough to dial. Every digit before them becomes `*`;
 * spaces, `+` and dashes are dropped. Its own file so the adapters and the providers share it without
 * importing each other.
 */
export function maskPhone(to: string): string {
  const digits = to.replace(/\D/g, "");
  if (digits.length <= 4) return "*".repeat(digits.length);
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * ABDM × MSG91 — the same rule for a number buried in PROVIDER PROSE ("Invalid mobile 919876543210"):
 * every run of seven or more digits (spaces, dashes and a leading `+` allowed inside it) keeps its last
 * four. A provider's error text is data we did not write, and it lands in `last_error` and in logs.
 */
export function maskPhonesIn(text: string): string {
  return text.replace(/\+?\d[\d\s-]{5,}\d/g, (m) => maskPhone(m));
}
