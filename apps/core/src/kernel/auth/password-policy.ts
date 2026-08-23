/**
 * PLAN 11e D3 — THE PASSWORD POLICY. OWNER RULED 2026-08-23.
 *
 * ONE MODULE, AND EVERY PATH THAT SETS A CREDENTIAL CALLS IT. Before 11e the only floor in the
 * system was `seed:staff`'s own `min(8)`, which apologised for itself in a comment ("a seed-time
 * floor, not an auth policy") because there was nowhere else to put it. There is now.
 *
 * THE RULING, in full and without additions:
 *
 *   - **Minimum 10 characters, no composition rules, no expiry.** Length beats composition rules
 *     people work around: `P@ssw0rd` satisfies every upper/lower/digit/symbol rule ever written
 *     and is on the list below.
 *   - **The username is refused, case-insensitively.**
 *   - **A fixed top-20 common-password list is refused, case-insensitively.**
 *   - **A PIN is 4-6 DIGITS, exactly.**
 *
 * WHERE IT IS ENFORCED (D3): admin user creation, admin password reset, admin PIN reset,
 * self-service change-password, and `seed:staff`'s roster validation. FIVE call sites, and R4
 * asserts the floor at every one of them — a policy module nobody calls is the defect this phase
 * exists to close, restated.
 *
 * WHERE IT IS DELIBERATELY **NOT** ENFORCED, and this is a decision rather than an omission:
 *
 *   - `loginSchema` stays `min(1)` and `pinSwitchSchema` stays `min(4)` (`auth.controller.ts`).
 *     Login VERIFIES a credential that already exists. A floor at login locks out precisely the
 *     users the reset flow exists to save — the person whose eight-character password predates
 *     this file is the person who most needs to be able to sign in and change it.
 *   - `createUser`/`setPassword`/`setPin` (`identity.ts`) take any string. The kernel's writers
 *     stay policy-free so that fixtures and seeds cannot quietly become the place the policy is
 *     not applied; the routes are where a human chooses a credential, so the routes are where the
 *     choosing is judged.
 *
 * ═══ A MEASURED PROPERTY OF THE LIST, STATED RATHER THAN GLOSSED ═══
 *
 * NINETEEN of the twenty entries below are shorter than ten characters, so the length floor
 * already refuses them and the list only bites on `1234567890`. That is not a reason to widen the
 * list — the ruling names a top-20 list and this is one — but it IS the honest description of what
 * the second check buys, and it is recorded here so nobody reads the list as more protection than
 * it is. `password-policy.test.ts` pins the count by execution.
 *
 * ═══ NO CREDENTIAL EVER REACHES A MESSAGE ═══
 *
 * Every message below is a sentence about a RULE, never about the value. `seed-staff.ts`'s GC3
 * discipline ("a password or a PIN must not reach any log, any error message or the report")
 * applies to this module verbatim, because this module is what `seed:staff` now calls.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

/** The PIN surface is a numeric keypad on a shared terminal. 4-6 digits, and nothing else. */
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;
const PIN_RE = /^[0-9]+$/;

/**
 * The twenty most-used passwords in published breach corpora, lowercase. Fixed by the ruling: this
 * list does not grow with fashion, and it is not a dictionary — a dictionary check at this size is
 * theatre, and the length floor is what actually does the work.
 */
export const COMMON_PASSWORDS: readonly string[] = [
  "123456", "123456789", "qwerty", "password", "12345", "qwerty123", "1q2w3e", "12345678",
  "111111", "1234567890", "1234567", "abc123", "password1", "iloveyou", "000000", "monkey",
  "dragon", "letmein", "welcome", "admin",
];

export type CredentialProblemCode =
  | "password_too_short"
  | "password_too_long"
  | "password_is_username"
  | "password_is_common"
  | "pin_not_digits"
  | "pin_wrong_length";

export type CredentialProblem = { code: CredentialProblemCode; message: string };

/**
 * Every way this password breaks the policy, in a stable order. An ARRAY rather than a first
 * failure: a person choosing a credential should be told everything wrong with it in one go,
 * because the alternative is three round-trips at a counter with a queue behind them.
 */
export function checkPassword(password: string, ctx: { username: string }): CredentialProblem[] {
  const problems: CredentialProblem[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push({
      code: "password_too_short",
      message: `must be at least ${PASSWORD_MIN_LENGTH} characters — length is the whole policy, so there are no character-type rules to satisfy`,
    });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push({
      code: "password_too_long",
      message: `must be at most ${PASSWORD_MAX_LENGTH} characters`,
    });
  }
  const lowered = password.toLowerCase();
  if (lowered === ctx.username.toLowerCase()) {
    problems.push({
      code: "password_is_username",
      message: "must not be the username — anyone who can read a rota can read this one",
    });
  }
  if (COMMON_PASSWORDS.includes(lowered)) {
    problems.push({
      code: "password_is_common",
      message: "is one of the twenty most-used passwords in the world and is tried first, always",
    });
  }
  return problems;
}

/** Every way this PIN breaks the policy. Same contract, same ordering discipline. */
export function checkPin(pin: string): CredentialProblem[] {
  const problems: CredentialProblem[] = [];
  if (!PIN_RE.test(pin)) {
    problems.push({
      code: "pin_not_digits",
      message: "must be digits only — the fast-switch surface is a numeric keypad",
    });
  }
  if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
    problems.push({
      code: "pin_wrong_length",
      message: `must be ${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} digits`,
    });
  }
  return problems;
}

/** True when the credential is acceptable. Sugar over the arrays above, for the call sites. */
export const passwordIsAcceptable = (password: string, ctx: { username: string }): boolean =>
  checkPassword(password, ctx).length === 0;
export const pinIsAcceptable = (pin: string): boolean => checkPin(pin).length === 0;
