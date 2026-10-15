import { readFileSync, statSync } from "node:fs";

/**
 * PHONE CONSULT (decision 0048, owner 2026-10-07: "I am open to go with OpenAI but never with
 * Sarvam … comfortable with consultation audio being sent to an outside speech service, with the
 * audio not stored but patient name must not be sent to openAI. Age, gender, vitals could be sent.").
 *
 * ═══ WHAT THIS FILE SENDS, AND IT IS THE WHOLE OF IT ═══
 * One multipart request to `POST /v1/audio/transcriptions` with exactly four parts: `file` (the
 * clip, from memory), `model`, `response_format=json`, and `prompt` (the caller's hint text). There
 * is no fifth part and no header beyond the key. The clip is a Buffer that is never written to a
 * disk, a table or a log by this process; the answer is returned to the caller and kept nowhere.
 *
 * `language` is deliberately NOT sent: the doctors speak Hindi and English in one sentence, and a
 * fixed language makes the model translate the other half. The prompt carries the register instead.
 */
export const OPENAI_SPEECH_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"] as const;
export type OpenAiSpeechModel = (typeof OPENAI_SPEECH_MODELS)[number];

export type OpenAiTranscribeInput = {
  key: string; model: OpenAiSpeechModel; audio: Buffer; mimeType: string; prompt: string;
  fetcher?: typeof fetch; timeoutMs?: number;
};

const EXT: Record<string, string> = {
  "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3",
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/3gpp": "3gp",
};
export const SPEECH_MIME_TYPES = Object.keys(EXT);

export class OpenAiSpeechFailed extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "speech provider unreachable" : `speech provider answered ${String(status)}`);
  }
}

export async function openAiTranscribe(input: OpenAiTranscribeInput): Promise<{ text: string }> {
  const form = new FormData();
  const ext = EXT[input.mimeType] ?? "m4a";
  form.append("file", new Blob([new Uint8Array(input.audio)], { type: input.mimeType }), `note.${ext}`);
  form.append("model", input.model);
  form.append("response_format", "json");
  if (input.prompt !== "") form.append("prompt", input.prompt);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), input.timeoutMs ?? 45_000);
  let res: Response;
  try {
    res = await (input.fetcher ?? fetch)("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { authorization: `Bearer ${input.key}` }, body: form, signal: ctl.signal,
    });
  } catch {
    throw new OpenAiSpeechFailed(null);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new OpenAiSpeechFailed(res.status);
  const body = (await res.json()) as { text?: unknown };
  return { text: typeof body.text === "string" ? body.text.trim() : "" };
}

/**
 * The key, read from its file on use and re-read when the file changes (a key that arrives or is
 * rotated needs no restart — the Firebase key's lesson). Absent, unreadable or empty answers null:
 * voice is then OFF and says so; it is never an error at boot.
 */
const cache = new Map<string, { mtimeMs: number; key: string | null; checkedAt: number }>();
export function openAiKeyFromFile(path: string | null, now: number = Date.now()): string | null {
  if (path === null) return null;
  const had = cache.get(path);
  if (had !== undefined && now - had.checkedAt < 30_000) return had.key;
  let key: string | null = null;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
    if (had !== undefined && had.mtimeMs === mtimeMs) {
      cache.set(path, { ...had, checkedAt: now });
      return had.key;
    }
    const raw = readFileSync(path, "utf8").trim();
    key = /^[A-Za-z0-9_\-]{20,400}$/.test(raw) ? raw : null;
  } catch {
    key = null;
  }
  cache.set(path, { mtimeMs, key, checkedAt: now });
  return key;
}
/** Tests only. */
export function forgetOpenAiKeyCache(): void { cache.clear(); }
