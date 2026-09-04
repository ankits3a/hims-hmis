import { loadConfig } from "../../kernel/config";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-12 — THE ABDM SEAM, AND THE LINE BETWEEN WHAT A COUNTER CAN DO TODAY AND WHAT IT CANNOT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner ruling 2026-09-04: the registration screen gets ABHA fields and buttons, with the ABDM
 * gateway seamed for when credentials exist.
 *
 * THE DISTINCTION THIS FILE EXISTS TO HOLD. Two different things get called "ABHA" at a desk:
 *
 *   1. RECORDING an ABHA the patient already has — they read the fourteen digits off their phone,
 *      or hand over a card. This needs NO gateway, it is ordinary data capture, and it is the
 *      common case in an Indian OPD queue. It lands at `self_declared`, which is exactly what it
 *      is: the hospital's record of what the patient said.
 *   2. CREATING an ABHA, or VERIFYING one by Aadhaar/mobile OTP. Only ABDM can do either. Without
 *      credentials there is no honest local version of it.
 *
 * SO THE SCREEN IS TOLD WHICH WORLD IT IS IN rather than discovering it from a failed request. A
 * button that looks live and then errors is worse at a counter than a button that says why it is
 * not available: the clerk has a patient in front of them and no way to interpret a failure.
 *
 * WHAT MUST NEVER HAPPEN HERE: a locally "verified" ABHA. `abha_verification_status` is a claim
 * about a national registry, and the only thing entitled to move it to `verified` is that registry
 * answering. Faking it to make a button feel complete would put an unverifiable assertion into the
 * identity spine — `abha_number` is a Class I field that a re-rendered document reprints.
 */

export type AbhaCapability = {
  /** True only when every ABDM credential is present. Never inferred from anything else. */
  configured: boolean;
  /** Recording a number the patient gives. Always available — it needs no gateway. */
  canRecord: boolean;
  /** Minting a new ABHA for a patient who has none. Requires ABDM. */
  canCreate: boolean;
  /** Confirming a number against the registry by OTP. Requires ABDM. */
  canVerify: boolean;
  /** Said in the clerk's terms, not the operator's, because the clerk is who reads it. */
  reason: string;
};

export function abhaCapability(env: NodeJS.ProcessEnv = process.env): AbhaCapability {
  const { abdm } = loadConfig(env);
  const configured =
    abdm.baseUrl !== null && abdm.clientId !== null && abdm.clientSecret !== null;
  return {
    configured,
    canRecord: true,
    canCreate: configured,
    canVerify: configured,
    reason: configured
      ? "ABDM is connected — an ABHA can be created and verified here."
      : "This hospital is not connected to ABDM yet, so a new ABHA cannot be created here and a number cannot be verified. An ABHA the patient already has can still be recorded.",
  };
}

/**
 * THE FOURTEEN-DIGIT ABHA NUMBER, normalised the way it is printed: `12-3456-7890-1234`.
 *
 * Patients read it off a phone screen with the hyphens, clerks type it with or without them, and
 * both must reach the same stored value or the number stops being a match key — which is the only
 * thing it is for. Anything that is not fourteen digits is returned as-is rather than mangled: the
 * caller decides whether to refuse it, and silently reshaping a wrong number into a right-looking
 * one would be the worse failure.
 */
export function normaliseAbhaNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 14) return raw.trim();
  return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}`;
}

/** `name@sbx` / `name@abdm` — the PHR address, which is a handle and not a number. */
export function isPlausibleAbhaAddress(raw: string): boolean {
  return /^[a-zA-Z0-9._-]{1,64}@[a-zA-Z][a-zA-Z0-9]{1,20}$/.test(raw.trim());
}
