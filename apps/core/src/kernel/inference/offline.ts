import type { SpeechClient, TranscribeInput, TranscribeResult } from "./types";

/**
 * PLAN 11h T9 — the deterministic implementation CI uses, and the reason **CI NEVER CONTACTS A
 * PROVIDER**. It is the same contract the DPIA's §2 enforcement clause names for
 * `InferenceClient`: "the test/dev implementation is deterministic and offline".
 *
 * It returns a transcript derived from the audio's own length, so a test can assert plumbing
 * without asserting anything about speech recognition — which no offline stub could honestly claim.
 */
export function offlineSpeechClient(text = "offline transcript"): SpeechClient {
  return {
    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      return Promise.resolve({ text: `${text} (${input.audio.length}b, ${input.language})` });
    },
  };
}
