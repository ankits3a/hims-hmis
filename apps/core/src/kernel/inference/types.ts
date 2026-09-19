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
 *
 * ═══ FD-COPILOT 2026-09-17 — `complete` IS DECLARED NOW, BECAUSE IT HAS ITS FIRST REAL CALLER ═══
 *
 * The paragraph above was right to refuse a placeholder, and it is left standing as the reason. What
 * changed is that the guess is gone: the desk copilot needs exactly one thing from a model — route a
 * MASKED question to one of a closed set of tool names — and a contract written against a caller
 * that exists is not a guess about somebody else's.
 *
 * It is deliberately NARROWER than a general completion API. No streaming, no message history, no
 * tool-calling protocol, no temperature knob: each of those would invite a second caller to use this
 * for something the DPIA has not been asked about. One system prompt, one user string, text back.
 *
 * Note for whoever writes 12a proper: `modules/opd/triage.ts` still makes its own `fetch` to
 * `/chat/completions` with its own `TRIAGE_API_KEY`, which contradicts this file's first paragraph
 * today. It predates this declaration and is the obvious first migration onto `complete`. It is NOT
 * done here — triage is a live path with measured cache and in-flight coalescing behaviour, and
 * moving it belongs in a change whose tests are about triage rather than about the copilot.
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

/**
 * What a caller may put in front of a model. The narrowness is the safety property — see the
 * header. `user` is the only part that ever carries anything the operator typed, and every current
 * caller masks it before it arrives here.
 */
export type CompleteInput = {
  /** The task and the closed menu of permitted answers. Built by the caller, never by the operator. */
  system: string;
  /** The operator's own words, already de-identified by the caller. */
  user: string;
  /**
   * A hard ceiling on the reply — a runaway guard, and it must leave room to THINK. A routing answer
   * is a dozen tokens, but a reasoning model (`gpt-oss-120b`) spends 62-74 before writing them, and
   * a ceiling below that returns `finish_reason: "length"` with empty content: measured 2026-09-19.
   */
  maxTokens?: number;
};

export type CompleteResult = {
  /** The reply, and nothing else. No usage block, no logprobs, no echo of what was sent. */
  text: string;
};

export class InferenceUnavailable extends Error {
  constructor(readonly reason: "not_configured" | "provider_failed" | "timeout") {
    super(reason);
    this.name = "InferenceUnavailable";
  }
}

export type InferenceClient = {
  complete(input: CompleteInput): Promise<CompleteResult>;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `choose()` — NARROWER STILL: THE MODEL RETURNS A MEMBER OF OUR SET, AND NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-19: *"keep typesafe as priority and the groq as fallback"*. `complete()` asks a
 * chat model for text and then parses a member of a closed menu OUT of it; `choose()` hands a
 * classifier the menu itself, and the only thing that can come back is one of its keys and how sure
 * the model is. There is no text in the result at all — the narrowness `complete()`'s header argues
 * for, taken to its end.
 *
 * Same law as everything else in this directory: `state` is de-identified by the caller and has
 * been through `assertNoIdentifiers` before it arrives. Several questions may share one `state`
 * because the provider evaluates them together in one request — asking "which tool" and "which
 * patient" costs one round trip, not two.
 */
export type ChoiceQuestion = {
  /** What is being chosen. Written by the caller, never by the operator. */
  instructions: string;
  /** Option key → what it means (a sentence, or an object such as `{ what, not_for, examples }`). */
  options: Record<string, unknown>;
};

export type ChooseInput = {
  /** The de-identified text the questions are about, by name — `{ question: "<<P1>> ka bill…" }`. */
  state: Record<string, string>;
  questions: Record<string, ChoiceQuestion>;
};

export type ChoiceAnswer = {
  /** Always one of the keys the question offered — the client refuses anything else. */
  choice: string;
  /** 0..1, the provider's own summary of how peaked its distribution was. */
  confidence: number;
  /**
   * The whole distribution, option key → 0..1, so a caller can RANK rather than only take the top
   * (triage offers up to three departments). Every key is one the question offered.
   */
  probabilities: Record<string, number>;
};

export type ChooseResult = {
  answers: Record<string, ChoiceAnswer>;
  /** The VERSIONED model that answered, so a log can say which one a threshold was tuned against. */
  model: string;
};

export type ChoiceClient = {
  choose(input: ChooseInput): Promise<ChooseResult>;
};
