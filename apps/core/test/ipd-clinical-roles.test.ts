import { LOCAL_ROLE_TITLES, ROLE_MODEL } from "../scripts/seed-roles";
import { OPD_ROLE_KEYS } from "../src/modules/opd/config";
import { IPD_ACTOR_ROLE_KEYS, IPD_CLINICAL_ROLES, IPD_DEPOSIT_RECIPIENT_ROLES } from "../src/modules/ipd";

/**
 * E2.3 (#727, review 3; decision 0058) — NO MONEY NOTICE REACHES A CLINICIAN. The deposit ladder drops every holder of a
 * role in `IPD_CLINICAL_ROLES`; this census DERIVES the clinical roles from the role model (every role key `seed:roles`
 * titles, plus the IPD workflow's doctor and resident keys) and fails when the hand list misses one — a new consultant-type
 * role cannot slip onto the money notices by being forgotten.
 */
/** Matched against the role's NAME (its key, and its title before any bracketed note — "Radiology Nurse (… asks the radiologist)" is a nurse). */
const CLINICAL_TITLE = /doctor|consultant|surgeon|anaesthet|resident|radiologist|pathologist|intensivist|physician|superintendent/i;

function allRoleTitles(): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of OPD_ROLE_KEYS) m.set(r.key, r.title);
  for (const [k, t] of Object.entries(LOCAL_ROLE_TITLES)) m.set(k, t);
  for (const r of ROLE_MODEL) if (!m.has(r.roleKey)) m.set(r.roleKey, r.roleKey);
  return m;
}

describe("IPD clinical roles census (decision 0058)", () => {
  it("every clinical role of the role model is on IPD_CLINICAL_ROLES", () => {
    const derived = new Set<string>([...IPD_ACTOR_ROLE_KEYS.doctor, ...IPD_ACTOR_ROLE_KEYS.resident]);
    for (const [key, title] of allRoleTitles()) if (CLINICAL_TITLE.test(title.split("(")[0]!) || CLINICAL_TITLE.test(key)) derived.add(key);
    expect([...derived].filter((k) => !IPD_CLINICAL_ROLES.includes(k)).sort()).toEqual([]);
    // The derivation is not empty by accident: the roles every hospital has are in it.
    for (const k of ["doctor", "surgeon", "anaesthetist", "medical_superintendent", "radiology_resident"]) expect(derived.has(k)).toBe(true);
  });

  it("no deposit notice is addressed to a clinical role", () => {
    for (const roles of Object.values(IPD_DEPOSIT_RECIPIENT_ROLES)) {
      expect(roles.filter((r) => IPD_CLINICAL_ROLES.includes(r))).toEqual([]);
    }
    expect(IPD_DEPOSIT_RECIPIENT_ROLES.escalate).toEqual([...IPD_DEPOSIT_RECIPIENT_ROLES.top_up, "duty_manager", "owner"]);
  });
});
