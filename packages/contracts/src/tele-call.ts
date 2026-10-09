/**
 * ═══ A TELE-CALL APPOINTMENT (owner 2026-10-09) ═══
 *
 * *"For Telecall, any patient booked the slot … from the counter (future appointment, not walkin) …
 * marked clearly that it's a telecall (use icon for telecall and not the text as we have limited
 * screen size)."*
 *
 * `mode` says HOW the patient is seen. It is not `source`, which says who made the booking. A
 * tele-call carries the number the doctor will ring; the server keeps it as ten digits.
 *
 * No imports: the phone app reads this file by path and installs none of the server's packages.
 */
export const APPOINTMENT_MODES = ["in_person", "tele"] as const;
export type AppointmentMode = (typeof APPOINTMENT_MODES)[number];

/**
 * An Indian mobile number as ten digits, or null when what was typed is not one. Spaces, hyphens,
 * dots and brackets are dropped; then ONE prefix — `+91`, `91` or a trunk `0` — is dropped when
 * exactly ten digits are left behind it. Ten digits starting 6–9 is the only answer.
 */
export function telePhoneOf(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const typed = raw.trim();
  if (!/^\+?[\d\s\-.()]+$/.test(typed)) return null;
  let digits = typed.replace(/\D/g, "");
  if (typed.startsWith("+")) {
    if (!digits.startsWith("91")) return null;
    digits = digits.slice(2);
  } else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}
