import type { MeProfile } from "../session";
import type { HeaderFacts } from "./load";

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * THE HEADER (app home round 2, decision 0043; the board: "Dr. Chandan Kumar / General Medicine ·
 * Unit I", "Asha Devi / Front desk and cash", "Owner / Hospital · all departments").
 *
 * The NAME is the person's own full name; the username only where the account has none. The LINE is
 * what they are here as: a doctor's department and unit, the hospital for whoever reads all of it,
 * else the role they hold that says most about their day (`ROLE_ORDER`), in words.
 */
const ROLE_ORDER = [
  "owner", "medical_superintendent", "duty_manager", "billing_manager", "front_office_supervisor", "pharmacy_incharge", "ot_incharge",
  "doctor", "cashier", "front_office", "vitals_desk", "opd_slip_desk", "opd_scribe", "nurse", "pharmacy", "pharmacy_assistant", "lab_technician", "radiographer",
] as const;

const words = (key: string): string => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function roleLine(roles: readonly string[], t: T): string | null {
  const known = ROLE_ORDER.filter((r) => roles.includes(r));
  const shown = (known.length > 0 ? known : roles.filter((r) => r !== "admin")).slice(0, 2);
  if (shown.length === 0) return null;
  return shown.map((r) => { const k = `home.role.${r}`; const said = t(k); return said === k ? words(r) : said; }).join(" · ");
}

export function headerOf(profile: MeProfile | null | undefined, username: string, facts: HeaderFacts | null, t: T): { name: string; line: string | null } {
  const name = profile?.fullName ?? facts?.doctor?.displayName ?? (username !== "" ? username : (profile?.username ?? ""));
  if (facts?.doctor != null && (facts.doctor.departmentName !== null || facts.doctor.unit !== null)) {
    return { name, line: [facts.doctor.departmentName, facts.doctor.unit].filter((x) => x !== null && x !== "").join(" · ") };
  }
  if (facts?.hospitalWide === true) return { name, line: t("home.role.hospital") };
  return { name, line: roleLine(profile?.roles ?? [], t) };
}
