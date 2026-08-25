/**
 * PLAN 11h T9 — THE ONE CHOKE MODULE FOR EVERY OUTBOUND AI CALL.
 *
 * Deferred note 5 (owner, 2026-08-25) requires that the LLM router AND the voice path land behind
 * a SINGLE module which becomes Plan 12a's `InferenceClient` — never scattered call sites. So this
 * directory is the only place in the codebase that will ever hold an outbound AI credential, make
 * an outbound AI request, or need a kill switch. Two typed methods, one config, one audit point.
 *
 * `transcribe` exists now because voice is the first thing that needs it. `complete` is NOT
 * declared here as a placeholder: 12a owns that half, and a stub interface written a phase early is
 * a guess about somebody else's contract.
 */
export type TranscribeInput = {
  /** Raw audio bytes. Never persisted — see the controller. */
  audio: Buffer;
  /** BCP-47-ish hint from the caller's own i18n preference. */
  language: "hi" | "en";
};

export type TranscribeResult = {
  /** The transcript, and nothing else. No confidence, no alternatives, no audio echoed back. */
  text: string;
};

export class SpeechUnavailable extends Error {
  constructor(readonly reason: "not_configured" | "provider_failed") {
    super(reason);
    this.name = "SpeechUnavailable";
  }
}

export type SpeechClient = {
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
};
