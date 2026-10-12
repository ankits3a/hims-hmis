import { z } from "zod";
import type { IpdRefusalCode } from "./refusals";

/**
 * E0.2 (#714) — THE IPD INTENT LAYER'S SHARED VOCABULARY (spec SPEC-ipd-core §0, §0B; decision 0072).
 *
 * Every IPD act is one intent: a module function with a zod contract here, called alike by screens, voice,
 * the copilot (proposal → confirm → act, decision 0069), devices and later outside agents. The intent re-checks
 * permission and state every time and refuses with a code from `IPD_REFUSALS` (a rule and a fix).
 *
 * Conventions every intent follows:
 * - ids are ULIDs (`newId()` in ids.ts mints every entity id); people are referenced by user id;
 * - money is integer paise, never rupees, never a float;
 * - times are ISO-8601 instants with an offset, stamped by the server's clock (§4.10 edge 18);
 * - every intent that creates or moves something carries `idempotencyKey` (a uuid) — a retried request on a
 *   flaky ward network records once (§4.10 edge 9);
 * - inputs are strict: an unknown field is refused rather than dropped, so a client cannot believe it sent a
 *   value the server ignored.
 */

/** A ULID entity id (patient, admission, bed, order, task …), the grammar `newId()` mints. */
export const IpdIdSchema = z.ulid();
/** A staff user id. Not pinned to ULID: seeded and system identities predate the grammar. */
export const IpdUserRefSchema = z.string().min(1).max(64);
export const IpdInstantSchema = z.iso.datetime({ offset: true });
export const IpdPaiseSchema = z.number().int().nonnegative();
export const IpdPositivePaiseSchema = z.number().int().positive();
export const IpdIdempotencyKeySchema = z.uuid();
export const IpdNoteSchema = z.string().trim().min(1).max(1000);

/** §0B provenance: who or what produced a datum. A draft shows "Draft" until a named person signs it. */
export const IPD_PROVENANCE_SOURCES = ["person", "device", "copilot_draft", "agent", "import", "system"] as const;
export const IpdProvenanceSchema = z.enum(IPD_PROVENANCE_SOURCES);
/**
 * The provenance an act writes. DECIDED (orchestrator, PR #745): a system-driven act — the advice expiry's
 * cancel_admission, the reservation lapse — writes `{ source: "system", actor: "system" }`.
 */
export const IpdProvenanceRecordSchema = z.strictObject({ source: IpdProvenanceSchema, actor: z.string().min(1).max(64) });
export type IpdProvenanceRecord = z.infer<typeof IpdProvenanceRecordSchema>;

/** DECIDED (PR #745): a stamped time may run ahead of the server's clock by at most 2 minutes (device skew). */
export const IPD_CLOCK_SKEW_MS = 2 * 60_000;
/** True when `at` is later than the server's `now` plus the skew allowance: refuse `time_in_future`. */
export function ipdIsInFuture(at: string, now: Date): boolean {
  return new Date(at).getTime() > now.getTime() + IPD_CLOCK_SKEW_MS;
}

/** Who signs a consent or form: the patient, a guardian (minor) or a nominated representative (no capacity). */
export const IpdSignerSchema = z.enum(["patient", "guardian", "representative"]);

/** The tenders a receipt can take (the cash law caps cash; the rest are offered when it bites). */
export const IpdTenderSchema = z.enum(["cash", "upi", "card", "neft", "cheque", "dd"]);

export const IPD_ADMISSION_STATES = [
  "requested", "reserved", "admitted", "transferring", "fit_declared", "discharging",
  "discharged", "lama", "absconded", "deceased", "transferred_out", "cancelled",
] as const;
export type IpdAdmissionState = (typeof IPD_ADMISSION_STATES)[number];
export const IpdAdmissionStateSchema = z.enum(IPD_ADMISSION_STATES);

export const IPD_BED_STATUSES = ["available", "reserved", "occupied", "cleaning", "blocked", "retired"] as const;
export const IpdBedStatusSchema = z.enum(IPD_BED_STATUSES);

/**
 * Role KINDS an intent admits. They are not role keys: the workflow and seed map each kind to the hospital's
 * roles. `device` is a registered machine (wristband printer, monitor, gate scanner); `agent` is an autonomous
 * agent acting at its tier on the §4.11 ladder.
 */
export const IPD_ACTOR_KINDS = [
  "desk", "nurse", "doctor", "resident", "pharmacist", "billing", "supervisor", "duty_manager", "device", "agent",
] as const;
export type IpdActorKind = (typeof IPD_ACTOR_KINDS)[number];

/** §4.11 autonomy ladder: T1 nudges, T2 proposes for a person to confirm, T3 acts with review, T4 acts alone. */
export const IPD_AGENT_TIERS = ["none", "T1", "T2", "T3", "T4"] as const;
export type IpdAgentTier = (typeof IPD_AGENT_TIERS)[number];

/** How an act is taken back: a short undo window, a reversal line, an entered-in-error mark, or never. */
export const IPD_UNDO_KINDS = ["undo_window", "reversal_line", "entered_in_error", "irreversible"] as const;
export type IpdUndoKind = (typeof IPD_UNDO_KINDS)[number];

export type IpdIntentMeta = {
  actors: readonly IpdActorKind[];
  /** A person's copilot may put this act on a proposal card for that person to confirm (decision 0069). */
  copilotProposable: boolean;
  agentTier: IpdAgentTier;
  undo: IpdUndoKind;
  events: readonly string[];
  idempotent: boolean;
};

type Refusals = readonly [IpdRefusalCode, ...IpdRefusalCode[]];

export type IpdIntentDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType, R extends Refusals = Refusals> =
  IpdIntentMeta & {
    input: I;
    output: O;
    refusals: R;
    /** Parses exactly this intent's refusal codes. */
    refusal: z.ZodEnum<{ [K in R[number]]: K }>;
  };

/** Declares one intent; the refusal enum is built from its own code list so the two cannot drift. */
export function ipdIntent<I extends z.ZodType, O extends z.ZodType, const R extends Refusals>(
  spec: IpdIntentMeta & { input: I; output: O; refusals: R },
): IpdIntentDef<I, O, R> {
  return { ...spec, refusal: z.enum(spec.refusals as unknown as [R[number], ...R[number][]]) as never };
}

/** A strict input object that always carries the idempotency key. */
export function ipdInput<S extends z.ZodRawShape>(shape: S) {
  return z.strictObject({ idempotencyKey: IpdIdempotencyKeySchema, ...shape });
}

/**
 * Every object key a schema can carry, walking optional, nullable, default, array, union, intersection,
 * record and pipe wrappers. Used to prove properties of a whole contract, e.g. "no doctor output names money".
 */
export function ipdSchemaKeys(schema: z.ZodType): string[] {
  const keys = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (s: unknown): void => {
    if (s === null || typeof s !== "object" || seen.has(s)) return;
    seen.add(s);
    const def = (s as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def) return;
    switch (def.type) {
      case "object":
        for (const [k, v] of Object.entries(def.shape as Record<string, unknown>)) { keys.add(k); walk(v); }
        return;
      case "array": walk(def.element); return;
      case "tuple": for (const i of def.items as unknown[]) walk(i); walk(def.rest); return;
      case "lazy": walk((def.getter as () => unknown)()); return;
      case "union": for (const o of def.options as unknown[]) walk(o); return;
      case "intersection": walk(def.left); walk(def.right); return;
      case "record": walk(def.valueType); return;
      case "pipe": walk(def.in); walk(def.out); return;
      default:
        if ("innerType" in def) walk(def.innerType);
    }
  };
  walk(schema);
  return [...keys];
}
