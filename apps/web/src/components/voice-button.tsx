import { VOICE_SEARCH_ENABLED } from "../lib/voice-flag";

/**
 * PLAN 11h T9 — the microphone, which RENDERS NOTHING while `VOICE_SEARCH_ENABLED` is false.
 *
 * NOT a disabled button and NOT a tooltip explaining why: a control that is visible but refuses is
 * an invitation to ask for it, and the answer would have to be a compliance lecture at a busy
 * counter. While voice is off, the palette simply has no microphone in it.
 *
 * When the flag flips, this is where push-to-talk lands — held key only, a visible recording
 * indicator, a hard fifteen-second cap, and the audio buffer discarded the moment the transcript
 * returns. Those are the plan's DD11 controls and they belong in one component, next to each other,
 * rather than spread across whatever mounts a microphone.
 */
export function VoiceButton(): React.ReactElement | null {
  if (!VOICE_SEARCH_ENABLED) return null;
  // The recording UI lands here with the DPIA revision, not before.
  return null;
}
