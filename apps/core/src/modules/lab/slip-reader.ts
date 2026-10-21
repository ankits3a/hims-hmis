import { z } from "zod";
import { openAiKeyFromFile } from "../../kernel/inference/openai-speech";

/**
 * ═══ SPEC #934 — WHO READS THE PHOTOGRAPHED ANALYSER SLIP, AND WHAT THEY ARE SENT ═══
 *
 * ONE provider, chosen at boot from configuration (rule 6): a readable `HMIS_GEMINI_KEY_FILE` means
 * Gemini; otherwise a readable `HMIS_OPENROUTER_KEY_FILE` means OpenRouter; otherwise `null` and the
 * bench types as today. There is no switching between vendors at run time: a Gemini outage is a failed
 * scan with Read again, never a quiet retry at another company.
 *
 * WHAT IS SENT (decision 0082) is the slip image as photographed — name and UHID included — and the
 * analyser's name. Nothing else about the patient is ever added: this file is handed bytes, a MIME type
 * and an instrument name, and has no way to reach a patient row. The model's job is transcription; the
 * mapping, the checks and the patient match are deterministic code in `slip-map.ts` and `slips.ts`.
 *
 * OpenRouter is built here rather than by extending `kernel/inference/openai-compatible.ts`: that
 * client is text-only and shared by every kernel caller, and this lane does not own `kernel/`. The
 * request shape follows it (`stream: false`, `temperature: 0`) and adds the image content part.
 */
export const SLIP_PROMPT_VERSION = "lab-slip-v1";

export const SLIP_PROMPT = `You transcribe a photographed printout from a hospital laboratory analyser.
Copy what is printed. Do not interpret, correct, convert, round or calculate anything.

HEADER
Copy Name, Patient ID, Sample ID, Gender and Age exactly as printed. Use null for a field that is blank or absent.
Never guess a field that is not printed.

RESULTS
Return one entry per printed result row, top to bottom, in printed order.
- code: the parameter name exactly as printed, keeping case and the characters # % - (e.g. "Lym#", "Gran%",
  "RDW-CV", "P-LCR"). "Lym#" and "Lym%" are different rows.
- value: the characters of the result exactly as printed (e.g. "3.63", "127", "----"). Never add or drop digits.
- unit: as printed, or null.
- flag: "H" when ↑ or H is printed beside the value, "L" when ↓ or L is printed, otherwise null.
- legible: "clear" when every character of code and value is certain; "unsure" when any character could be
  another (1/7, 3/8, 5/6, 0/8, a faint or missing decimal point); "unreadable" when the value cannot be read
  (then value is null).
Never add a row that is not printed. Never move a value to another row.
Skip histograms, scatter plots, logos, signatures and footer text.

If the image is not an analyser result printout, set slipKind to "not_a_result_slip" and return no rows.
Return only JSON that matches the schema.`;

/** The reply's JSON Schema, sent to the provider; `slipReplySchema` below is its mirror and judges every reply. */
export const SLIP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["slipKind", "analyserText", "header", "rows"],
  properties: {
    slipKind: { enum: ["analyser_result", "not_a_result_slip"] },
    analyserText: { type: ["string", "null"], description: "Model or brand line as printed" },
    header: {
      type: "object",
      additionalProperties: false,
      required: ["name", "patientId", "sampleId", "gender", "age", "printedAt"],
      properties: {
        name: { type: ["string", "null"] },
        patientId: { type: ["string", "null"], description: "As printed; our sample no. or UHID when the bench typed one" },
        sampleId: { type: ["string", "null"] },
        gender: { type: ["string", "null"], description: "As printed: M, F, Male, Female…" },
        age: { type: ["string", "null"], description: "As printed with its unit: 34Y, 8 M, 20 D" },
        printedAt: { type: ["string", "null"], description: "Date/time as printed" },
      },
    },
    rows: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "value", "unit", "flag", "legible"],
        properties: {
          code: { type: "string" },
          value: { type: ["string", "null"] },
          unit: { type: ["string", "null"] },
          flag: { enum: ["H", "L", null] },
          legible: { enum: ["clear", "unsure", "unreadable"] },
        },
      },
    },
  },
} as const;

const nullableText = z.string().max(400).nullable();
export const slipRowSchema = z.object({
  code: z.string().min(1).max(60),
  value: nullableText,
  unit: nullableText,
  flag: z.enum(["H", "L"]).nullable(),
  legible: z.enum(["clear", "unsure", "unreadable"]),
}).strict();
export const slipReplySchema = z.object({
  slipKind: z.enum(["analyser_result", "not_a_result_slip"]),
  analyserText: nullableText,
  header: z.object({
    name: nullableText, patientId: nullableText, sampleId: nullableText, gender: nullableText, age: nullableText, printedAt: nullableText,
  }).strict(),
  rows: z.array(slipRowSchema).max(60),
}).strict();
export type SlipReply = z.infer<typeof slipReplySchema>;
export type SlipReplyRow = z.infer<typeof slipRowSchema>;
export type SlipHeader = SlipReply["header"];

export type SlipProvider = "gemini" | "openrouter";
export type SlipReadInput = { image: Buffer; mimeType: string; analyserName: string };
/** `text` is the model's JSON as a string; `raw` the provider's whole answer, kept verbatim on the scan. */
export type SlipReadResult = { text: string; raw: unknown; tokensIn: number | null; tokensOut: number | null };
export type SlipReader = {
  provider: SlipProvider;
  model: string;
  read(input: SlipReadInput): Promise<SlipReadResult>;
};
export type SlipReaderConfig = {
  geminiKeyFile: string | null; openrouterKeyFile: string | null;
  geminiModel: string; openrouterModel: string; timeoutMs: number;
};

/** Why a read did not produce a reply: the provider refused or broke, or ran out of time. */
export class SlipReadError extends Error {
  constructor(readonly reason: "provider_failed" | "timeout" | "no_key", message: string) {
    super(message);
    this.name = "SlipReadError";
  }
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * The provider waits longer than the request does. The POST answers `reading` after
 * `LAB_SLIP_TIMEOUT_MS` and the phone polls; the read itself may finish a little later and still
 * land. Past this the call is abandoned, well inside the lab sweep's two minutes.
 */
export const SLIP_PROVIDER_ABORT_MS = 100_000;

/** Decision 0082: never an Anthropic model, never a `-latest` alias. Boot refuses both (config.ts); so does this. */
export function assertSlipModelAllowed(provider: SlipProvider, model: string): void {
  if (/-latest$/i.test(model)) throw new Error(`lab slip model must be a pinned version, never a -latest alias: ${model}`);
  if (provider === "openrouter" && /^anthropic\//i.test(model)) throw new Error(`lab slip model may not be an anthropic/ model: ${model}`);
}

const count = (x: unknown): number | null => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null);

async function post(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  // Decision 0082's outer fence: whatever the configuration says, the slip never goes to an Anthropic host.
  if (/anthropic/i.test(new URL(url).host)) throw new SlipReadError("provider_failed", "refusing an Anthropic host");
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, SLIP_PROVIDER_ABORT_MS);
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) throw new SlipReadError("provider_failed", `provider answered ${String(res.status)}`);
    return await res.json();
  } catch (e) {
    if (e instanceof SlipReadError) throw e;
    throw new SlipReadError(e instanceof Error && e.name === "AbortError" ? "timeout" : "provider_failed", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

function geminiReader(keyFile: string, model: string, fetchImpl: typeof fetch): SlipReader {
  return {
    provider: "gemini",
    model,
    async read(input) {
      const key = openAiKeyFromFile(keyFile);
      if (key === null) throw new SlipReadError("no_key", "the Gemini key file is not readable");
      const raw = await post(fetchImpl, `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": key }, {
        systemInstruction: { parts: [{ text: SLIP_PROMPT }] },
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: input.mimeType, data: input.image.toString("base64") } },
            { text: `Analyser: ${input.analyserName}. Return the JSON.` },
          ],
        }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: SLIP_JSON_SCHEMA },
      }) as { candidates?: { content?: { parts?: { text?: unknown }[] } }[]; usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown } };
      const text = (raw.candidates?.[0]?.content?.parts ?? []).map((p) => (typeof p.text === "string" ? p.text : "")).join("");
      return { text, raw, tokensIn: count(raw.usageMetadata?.promptTokenCount), tokensOut: count(raw.usageMetadata?.candidatesTokenCount) };
    },
  };
}

function openRouterReader(keyFile: string, model: string, fetchImpl: typeof fetch): SlipReader {
  return {
    provider: "openrouter",
    model,
    async read(input) {
      const key = openAiKeyFromFile(keyFile);
      if (key === null) throw new SlipReadError("no_key", "the OpenRouter key file is not readable");
      const raw = await post(fetchImpl, OPENROUTER_URL, { Authorization: `Bearer ${key}` }, {
        model,
        stream: false,
        temperature: 0,
        messages: [
          { role: "system", content: SLIP_PROMPT },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${input.mimeType};base64,${input.image.toString("base64")}` } },
              { type: "text", text: `Analyser: ${input.analyserName}. Return the JSON.` },
            ],
          },
        ],
        response_format: { type: "json_schema", json_schema: { name: "lab_slip", strict: true, schema: SLIP_JSON_SCHEMA } },
        // Only endpoints that neither keep nor train on the request (decision 0082).
        provider: { data_collection: "deny", require_parameters: true },
      }) as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
      const content = raw.choices?.[0]?.message?.content;
      return { text: typeof content === "string" ? content : "", raw, tokensIn: count(raw.usage?.prompt_tokens), tokensOut: count(raw.usage?.completion_tokens) };
    },
  };
}

/** The configured reader, or `null` when neither key file is readable — reading is then off. */
export function slipReaderFromConfig(cfg: SlipReaderConfig, fetchImpl: typeof fetch = fetch): SlipReader | null {
  if (cfg.geminiKeyFile !== null && openAiKeyFromFile(cfg.geminiKeyFile) !== null) {
    assertSlipModelAllowed("gemini", cfg.geminiModel);
    return geminiReader(cfg.geminiKeyFile, cfg.geminiModel, fetchImpl);
  }
  if (cfg.openrouterKeyFile !== null && openAiKeyFromFile(cfg.openrouterKeyFile) !== null) {
    assertSlipModelAllowed("openrouter", cfg.openrouterModel);
    return openRouterReader(cfg.openrouterKeyFile, cfg.openrouterModel, fetchImpl);
  }
  return null;
}

/** A provider's text → the reply, or `null` when it is not JSON that matches the schema. */
export function parseSlipReply(text: string): SlipReply | null {
  let json: unknown;
  try { json = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { return null; }
  const r = slipReplySchema.safeParse(json);
  return r.success ? r.data : null;
}

/**
 * Rupees per million tokens, ESTIMATES at ₹88 to the dollar (the copilot meter's rate, `copilot/spend.ts`).
 * A slip read counts toward decision 0064's daily cap; an unknown model is charged as the dearest here.
 */
const SLIP_PRICES_INR: Readonly<Record<string, { in: number; out: number }>> = {
  "gemini-2.5-flash": { in: 26.4, out: 220 },
  "google/gemini-2.5-flash": { in: 26.4, out: 220 },
  "gemini-2.5-pro": { in: 110, out: 880 },
  "google/gemini-2.5-pro": { in: 110, out: 880 },
};
export function slipCostMicroInr(model: string | null, tokensIn: number | null, tokensOut: number | null): number {
  const p = (model === null ? undefined : SLIP_PRICES_INR[model]) ?? { in: 110, out: 880 };
  return Math.round((tokensIn ?? 0) * p.in + (tokensOut ?? 0) * p.out);
}
