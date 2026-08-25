import { BadRequestException, Body, Controller, Inject, Post, ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../tokens";
import { CurrentActor } from "../auth/decorators";
import { attachTranscript, recordVoiceEgress } from "../search/audit";
import { workersAiSpeechClient } from "./workers-ai";
import { SpeechUnavailable } from "./types";
import type { SpeechClient } from "./types";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

/** 15 seconds at 16 kHz mono 16-bit ≈ 480 kB; base64 inflates by a third. The cap is on the DECODED size. */
const MAX_AUDIO_BYTES = 600_000;

const body = z.object({
  /** base64 audio, held in memory for the length of one request and never written anywhere. */
  audio: z.string().min(1),
  language: z.enum(["hi", "en"]).default("en"),
});

/**
 * PLAN 11h T9 — `POST /api/speech/transcribe`, SHIPPED INERT.
 *
 * ═══ WHY IT IS OFF ═══
 * Deferred note 5 (owner, 2026-08-25): **voice audio is Class 2 until the DPIA rules otherwise**.
 * Class 2 never enters an inference request under the DPIA's §2, so this route answering anything
 * at all requires a DPIA revision — not a plan ruling and not a code change. It is off by
 * configuration (`SPEECH_PROVIDER` defaults to empty), and the web half renders no microphone at
 * all while `VOICE_SEARCH_ENABLED` is false.
 *
 * ═══ WHY IT IS SERVER-SIDE ═══
 * The browser posts audio HERE and this process calls the provider with a server-held token. A
 * direct browser→provider call would put a credential on every desk machine and would let audio
 * leave without crossing an audit boundary. That is a defect, not an optimisation.
 *
 * ═══ WHAT COMES BACK ═══
 * TEXT ONLY. The transcript is returned to the caller and goes into the palette's ordinary
 * deterministic grammar — the same path a typed query takes. It is never forwarded to a language
 * model: voice adds ONE processor to this system, not two, and note 13's untrusted-content
 * boundary gets its first live instance here.
 */
@Controller("speech")
export class SpeechController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  private client(): SpeechClient {
    if (this.cfg.speechProvider !== "workers-ai" || this.cfg.speechAccountId === "" || this.cfg.speechApiToken === "") {
      throw new SpeechUnavailable("not_configured");
    }
    return workersAiSpeechClient(this.cfg.speechAccountId, this.cfg.speechApiToken);
  }

  @Post("transcribe")
  async transcribe(@CurrentActor() actor: Actor, @Body() raw: unknown): Promise<{ text: string; auditId: string }> {
    const parsed = body.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? "invalid body");

    let client: SpeechClient;
    try {
      client = this.client();
    } catch {
      // A coded 503 rather than a 500: not configured is an operational state, not a bug.
      throw new ServiceUnavailableException("speech_not_configured");
    }

    const audio = Buffer.from(parsed.data.audio, "base64");
    if (audio.length === 0) throw new BadRequestException("empty audio");
    if (audio.length > MAX_AUDIO_BYTES) throw new BadRequestException("audio too long");

    // BEFORE the call. See `recordVoiceEgress` — a log that records only successes cannot answer
    // what left the building.
    const { auditId } = await recordVoiceEgress(this.db, { actor, audioBytes: audio.length });

    let text: string;
    try {
      ({ text } = await client.transcribe({ audio, language: parsed.data.language }));
    } catch {
      throw new ServiceUnavailableException("speech_provider_failed");
    }

    await attachTranscript(this.db, auditId, text);
    return { text, auditId };
  }
}
