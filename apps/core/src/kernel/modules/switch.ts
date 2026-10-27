import { z } from "zod";
import { loadEnv } from "../config";

/**
 * ═══ DECISION 0085 — THE MODULE SWITCH: THE IPD/ER STACK SHIPS TO MAIN DARK ═══
 *
 * The inpatient and emergency stack (#742–#894) lands on main before the hospital switches it on. These ten modules
 * are DARK unless `HMIS_MODULES_ON` names them (a comma list; empty by default, which is production). A dark module:
 *
 *   · answers no route — its Nest module is not imported (`liveModules`, `app.module.ts` / `worker.module.ts`);
 *   · adds no menu item, Now card, search hit, copilot tool or intent, or order kind — every collector reads
 *     `ModuleRegistry.live()`, and `/auth/me` drops its permissions, so the web shell draws none of its links;
 *   · sends no message and changes nothing from the worker — `buildSubscriptionBus` skips its subscriptions and its
 *     jobs run a no-op body (the scheduler still heartbeats them, so `absent()` stays quiet).
 *
 * Its TABLES AND PERMISSIONS STILL EXIST: migrations run whatever the switch says, and `registry.all()` (what
 * `syncPermissions` and the seed-roles counts walk) keeps every manifest, so turning a module on is an env change and
 * a restart, never a migration or a re-seed.
 *
 * Any module key not in this list is always on: the switch can hide only these ten.
 */
export const DARK_MODULE_KEYS = [
  "tasks", "ipd", "bmw", "linen", "housekeeping", "maintenance", "passes", "transport", "diet", "emergency",
  // ICU IC-1 (#984) — the ICU core rides the IPD train dark (decision 0090 builds on 0085).
  "icu",
] as const;
export type DarkModuleKey = (typeof DARK_MODULE_KEYS)[number];

const DARK = new Set<string>(DARK_MODULE_KEYS);

/** `HMIS_MODULES_ON` — comma list of dark module keys, spaces ignored; a key outside the ten is a boot error. */
export const modulesOnSchema = z
  .string()
  .default("")
  .transform((raw) => raw.split(",").map((s) => s.trim()).filter((s) => s !== ""))
  .pipe(z.array(z.enum(DARK_MODULE_KEYS)))
  .transform((keys): ReadonlySet<DarkModuleKey> => new Set(keys));

/** The dark modules switched on by this environment. Throws on a key the switch does not know (a typo stays dark loudly). */
export function modulesOn(env: NodeJS.ProcessEnv = process.env): ReadonlySet<DarkModuleKey> {
  if (env === process.env) loadEnv();
  return modulesOnSchema.parse(env.HMIS_MODULES_ON);
}

/** True for every module outside the ten; for one of the ten, true only when `HMIS_MODULES_ON` names it. */
export function isModuleOn(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !DARK.has(key) || modulesOn(env).has(key as DarkModuleKey);
}

/** The predicate `ModuleRegistry` filters `live()` with — injectable so a test proves both states without the env. */
export type ModuleSwitch = (key: string) => boolean;
export const envModuleSwitch: ModuleSwitch = (key) => isModuleOn(key);
/** A switch fixed to one list — for tests and scripts (`switchOf([])` is production's). */
export function switchOf(on: readonly DarkModuleKey[]): ModuleSwitch {
  const set = new Set<string>(on);
  return (key) => !DARK.has(key) || set.has(key);
}

/**
 * The Nest modules to import, given each dark one's key: an off module is left out of `imports`, so none of its
 * controllers is mounted and none of its providers is built. Read at decoration time from `process.env`.
 */
export function liveModules<T>(entries: readonly (readonly [DarkModuleKey, T])[], isOn: ModuleSwitch = envModuleSwitch): T[] {
  return entries.filter(([key]) => isOn(key)).map(([, mod]) => mod);
}

/**
 * #833 — a dark module's scheduled job. It REGISTERS whatever the switch says (so `alerts.yml` names it and the census
 * tests count it) and the scheduler heartbeats every tick, on or off, so `absent()` stays quiet; while its module is
 * off the body is never called and the tick changes nothing. `job` names the registration (for the census spies).
 */
export async function runIfModuleOn(
  job: string, key: DarkModuleKey, body: () => Promise<unknown>, isOn: ModuleSwitch = envModuleSwitch,
): Promise<"ran" | "off"> {
  void job;
  if (!isOn(key)) return "off";
  await body();
  return "ran";
}
