import { z } from "zod";
import knowledgeJson from "./knowledge.json";

/**
 * ═══ THE CLINICAL KNOWLEDGE IS CODE, NOT A TABLE — AND THAT IS THE SAFETY PROPERTY ═══
 *
 * `knowledge.json` is built once from the owner's bundle by `scripts/build-cds-knowledge.ts` and
 * committed. It is 80 KB: a clinician can read every syndrome, every regimen line and all 136
 * guardrail rules in a pull-request diff, which is the only review that means anything for content
 * that will put a dose in front of a doctor.
 *
 * A database table was the obvious alternative and is worse HERE, for one reason: **what was
 * reviewed must be what is deployed.** Seeded rows drift — a hotfix on one box, a half-applied
 * re-seed, a hospital that edited a regimen at 2 a.m. — and nothing in the running system would
 * say so. Code ships as reviewed or not at all. Per-hospital overrides are a real requirement and
 * they arrive as a LAYER over this (a table of deltas, each with its own approval), never as a
 * replacement for it, so the reviewed baseline stays legible.
 *
 * The schema below is therefore a GATE, not documentation: the module refuses to start on a
 * knowledge file it cannot parse, in the same breath as the rest of the config.
 */
const dosingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stated"), mgPerKg: z.number().positive(), per: z.enum(["dose", "day"]), concentrationMgPerMl: z.number().positive().optional() }),
  z.object({
    kind: z.literal("derived"), mgPerKg: z.number().positive(), per: z.enum(["dose", "day"]),
    concentrationMgPerMl: z.number().positive(),
    from: z.object({ exampleWeightKg: z.number().positive(), exampleVolumeMl: z.number().positive() }),
    /** Literal `false`: a reviewed rate is a `stated` one. There is no third state to forget about. */
    reviewed: z.literal(false),
  }),
  z.object({ kind: z.literal("fixed") }),
  z.object({ kind: z.literal("non_drug") }),
]);

const lineSchema = z.object({
  band: z.enum(["adult", "pediatric"]), seq: z.number().int().positive(),
  drugLabel: z.string().min(1), purpose: z.string().nullable(),
  sig: z.string().min(1), duration: z.string().nullable(),
  dosing: dosingSchema.nullable(),
});

const syndromeSchema = z.object({
  key: z.string().min(1), name: z.string().min(1),
  keywords: z.array(z.string().min(1)), icd10: z.string().nullable(), description: z.string().nullable(),
  lines: z.array(lineSchema),
  substitutions: z.array(z.object({
    condition: z.string().min(1), substituteFor: z.string().nullable(),
    drugAdult: z.string().nullable(), drugChild: z.string().nullable(), reason: z.string().nullable(),
  })),
});

const ruleSchema = z.object({
  domain: z.string().min(1), ruleKey: z.string(),
  subject: z.union([z.string(), z.array(z.string())]).nullable(),
  severity: z.string().nullable(), message: z.string().nullable(),
  action: z.union([z.string(), z.array(z.string())]).nullable(),
  payload: z.record(z.string(), z.unknown()),
});

const knowledgeSchema = z.object({
  source: z.object({ file: z.string(), sha256: z.string().length(64) }),
  builtFrom: z.string(),
  syndromes: z.array(syndromeSchema).min(1),
  rules: z.array(ruleSchema),
});

export type Dosing = z.infer<typeof dosingSchema>;
export type RegimenLine = z.infer<typeof lineSchema>;
export type Syndrome = z.infer<typeof syndromeSchema>;
export type CdsRule = z.infer<typeof ruleSchema>;
export type Knowledge = z.infer<typeof knowledgeSchema>;

/**
 * PARSED ONCE, AT MODULE LOAD. A malformed knowledge file is a boot failure and not a runtime
 * surprise — `boot-check-warn-vs-refuse`'s rule: refuse a CODE defect CI would catch.
 */
export const KNOWLEDGE: Knowledge = knowledgeSchema.parse(knowledgeJson);

export function syndromeByKey(key: string): Syndrome | null {
  return KNOWLEDGE.syndromes.find((s) => s.key === key) ?? null;
}

/** Every rule of one domain, in file order. Domains are the bundle's own section names. */
export function rulesOf(domain: string): CdsRule[] {
  return KNOWLEDGE.rules.filter((r) => r.domain === domain);
}
