import { SpeechUnavailable } from "./types";
import type { SpeechClient, TranscribeInput, TranscribeResult } from "./types";

const MODEL = "@cf/openai/whisper-large-v3-turbo";

/**
 * PLAN 11h T9 — Cloudflare Workers AI, the owner's chosen provider (2026-08-25).
 *
 * ═══ `vad_filter` IS NOT A TUNING KNOB, IT IS THE HALLUCINATION DEFENCE ═══
 * MEASURED against the live endpoint 2026-08-25 with a three-second PURE TONE — no speech in it at
 * all:
 *     without vad_filter →  text: "झाल झाल"   (two words invented from a sine wave)
 *     with    vad_filter →  text: ""           (correctly, nothing)
 * A microphone open at a busy counter hears trolleys, other people's conversations and the ward
 * announcement system. Without this flag that noise becomes a QUERY — a phantom search, against
 * real patient data, attributed to whoever held the button. It is set on every request and it is
 * not a caller option.
 *
 * ═══ WHAT IS SENT AND WHAT IS KEPT ═══
 * Audio out, transcript back, nothing stored. Cloudflare's published position is that Workers AI
 * inputs and outputs are not used for training and are not retained unless the caller writes them
 * into a storage product; this code writes them nowhere. `language` comes from the caller's own
 * i18n preference rather than being auto-detected, because a desk that has chosen Hindi should not
 * have its Hindi guessed at.
 */
export function workersAiSpeechClient(accountId: string, apiToken: string): SpeechClient {
  return {
    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            audio: input.audio.toString("base64"),
            task: "transcribe",
            language: input.language,
            vad_filter: true, // see the header — measured, load-bearing
          }),
        },
      );
      if (!res.ok) throw new SpeechUnavailable("provider_failed");
      const body = (await res.json()) as { success?: boolean; result?: { text?: string } };
      if (body.success !== true) throw new SpeechUnavailable("provider_failed");
      return { text: (body.result?.text ?? "").trim() };
    },
  };
}
