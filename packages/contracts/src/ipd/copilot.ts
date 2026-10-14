import { z } from "zod";
import { IpdIdSchema, IpdInstantSchema } from "./common";

/**
 * E5.3 (#740) "Since yesterday" and E5.4 (#741) the SBAR and discharge drafters (spec §0A principle 6, §4.8, §4.9 E,
 * §4.10 edge 13, §4.11). Every line is rendered from records and names them; a model may only reword a line, and a
 * reworded line whose numbers differ from its records is dropped for the record's own line. Nothing here carries money
 * (decision 0058), and nothing here is an act: no dose and no order is ever proposed (autonomy ladder: None).
 */

/** Where a line's facts were read: the chip on the line, and which records it opens. */
export const IPD_COPILOT_SOURCES = ["vitals", "ews", "lab", "imaging", "emar", "note", "io", "consult", "diet", "order", "round", "admission", "assessment"] as const;
export const IpdCopilotSourceSchema = z.enum(IPD_COPILOT_SOURCES);
export type IpdCopilotSource = z.infer<typeof IpdCopilotSourceSchema>;

/** One record behind a line: its id, when it happened, and the record's own words (rendered by the server from the row). */
export const IpdCopilotRecordSchema = z.object({ id: z.string(), at: IpdInstantSchema.nullable(), label: z.string() });
export type IpdCopilotRecord = z.infer<typeof IpdCopilotRecordSchema>;

/** Who wrote the words of a line: `template` = rendered from the records; `model` = reworded by a model and verified. */
export const IpdCopilotBySchema = z.enum(["template", "model"]);

export const IpdSinceLineSchema = z.object({
  /** Stable per fact (`vital:temperatureC`, `emar:exceptions`): the cache and the verifier name a line by it. */
  key: z.string(),
  text: z.string(),
  source: IpdCopilotSourceSchema,
  /** An abnormal line sorts before every other; a stable patient's lines say "No change". */
  abnormal: z.boolean(),
  by: IpdCopilotBySchema,
  /** The records the line was rendered from — what the source chip opens. */
  records: z.array(IpdCopilotRecordSchema),
});
export type IpdSinceLine = z.infer<typeof IpdSinceLineSchema>;

/** Model id and prompt version of the words on screen; null fields when no model wrote any of them. */
export const IpdDraftStampSchema = z.object({
  /** "Draft" until a named person signs (§0B). */
  label: z.literal("Draft"),
  source: IpdCopilotBySchema,
  modelId: z.string().nullable(),
  promptVersion: z.string(),
  builtAt: IpdInstantSchema,
});
export type IpdDraftStamp = z.infer<typeof IpdDraftStampSchema>;

export const IpdSinceYesterdaySchema = z.object({
  admissionId: IpdIdSchema,
  asOf: IpdInstantSchema,
  /** The doctor's last signed round on this patient, else 24 hours before `asOf`. */
  since: IpdInstantSchema,
  sinceBasis: z.enum(["last_round", "24h"]),
  /** `timeline` = the plain timeline (model down, slow, off, halted, or a sealed patient); `model` = some lines reworded. */
  mode: z.enum(["timeline", "model"]),
  lines: z.array(IpdSinceLineSchema),
  stamp: IpdDraftStampSchema.nullable(),
  /** Kinds of record whose list was cut at the read's limit (newest kept): the lines over them are not the whole story. */
  truncated: z.array(z.string()),
  /** The page may ask for a reworded copy (`POST …/since/polish`); false for a sealed patient or with no model. */
  polishable: z.boolean(),
});
export type IpdSinceYesterday = z.infer<typeof IpdSinceYesterdaySchema>;

/** The stamp a signed copy keeps: which draft it was signed from. */
export const IpdDraftProvenanceSchema = z.object({
  draftId: IpdIdSchema,
  source: IpdCopilotBySchema,
  modelId: z.string().nullable(),
  promptVersion: z.string(),
  builtAt: IpdInstantSchema,
  /** Who asked for the draft. The signer is named by the signed record itself and may be another person. */
  builtBy: z.object({ id: z.string(), name: z.string() }),
  /** Whether the signed text differs from the draft's (a shift handover records it; null where it is not recorded). */
  edited: z.boolean().nullable(),
});
export type IpdDraftProvenance = z.infer<typeof IpdDraftProvenanceSchema>;

/** A medicine in a discharge draft or summary that no active order of the stay carries. */
export const IpdMedicineFlagSchema = z.object({
  name: z.string(),
  /** `medicines` = a row of the medicines list (with its index); `course` = named in the free text. */
  where: z.enum(["medicines", "course"]),
  index: z.number().int().nonnegative().nullable(),
  /** `unverified`: a word a model wrote that is in none of its notes, on no order and not a plain summary word. */
  reason: z.enum(["no_active_order", "order_stopped", "model_invented", "unverified"]),
});
export type IpdMedicineFlag = z.infer<typeof IpdMedicineFlagSchema>;

export const IPD_COPILOT_ROUTES = {
  since: "/ipd/rounds/:admissionId/since",
  sincePolish: "/ipd/rounds/:admissionId/since/polish",
  sbarDraft: "/ipd/nursing/admissions/:id/handover-draft",
  dischargeDraft: "/ipd/discharge/:admissionId/summary/draft",
} as const;
