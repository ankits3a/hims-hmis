/**
 * PLAN 11h T9 — VOICE SHIPS COMPLETE AND INERT, and this constant is the whole switch.
 *
 * ═══ WHAT MUST BE TRUE BEFORE THIS BECOMES `true` ═══
 *
 * 1. **A DPIA REVISION.** Deferred note 5 (owner, 2026-08-25) rules that **voice audio is Class 2
 *    until the DPIA rules otherwise**, and the DPIA's §2 says Class 2 never enters an inference
 *    request — any stage, any provider, ever. A dictated query carries patient names, and unlike
 *    text, audio cannot be tokenised before it leaves. So this is not a plan ruling to reverse; it
 *    is a compliance artefact to revise, and it names Cloudflare as the processor.
 *
 * 2. **HINGLISH ACCURACY, MEASURED.** The phase's spike Q6 asked the question that actually
 *    decides whether this is worth switching on, and it is not latency — it is whether
 *    "Asha Devi ka pending bill dikhao" transcribes usefully. Latency and mechanics WERE measured
 *    on 2026-08-25 (1.2–1.9 s for a three-second clip, from this host), but accuracy on
 *    code-switched speech needs real recordings from a real counter, which no synthetic clip can
 *    stand in for. If it transcribes poorly, the honest outcome is that this stays `false` and the
 *    carve-out is not worth spending.
 *
 * 3. **SPEECH_PROVIDER / SPEECH_ACCOUNT_ID / SPEECH_API_TOKEN** set on the server. They default to
 *    empty, so the route answers a coded 503 until an operator sets all three — CI sets none of
 *    them, deliberately: **CI never contacts a provider.**
 *
 * The 11g DD5 pattern, deliberately: the feature is not wrong, the authorisation is missing. When
 * it arrives this flips to `true` in one line, with no archaeology.
 */
export const VOICE_SEARCH_ENABLED = false;
