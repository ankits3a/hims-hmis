import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { withTx } from "../../kernel/db/client";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { opdEncounterDiagnoses, opdEncounters } from "../../kernel/db/schema";
import { OPENAI_SPEECH_MODELS } from "../../kernel/inference/openai-speech";
import { listRxSets, retireRxSet, saveRxSet, signRxSet } from "./rx-sets";
import {
  loadVoiceSettings, recordVoiceKept, saveVoiceSettings, transcribeConsultNote, voiceMeter, voiceStatus,
} from "./consult-voice";
import { doctorForUser } from "./masters";
import { parsed, toHttp } from "./opd-masters.controller";
import type { RxSet } from "./rx-sets";
import type { TranscribeNoteResult, VoiceMeter, VoiceSettings, VoiceStatus } from "./consult-voice";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

/**
 * PHONE CONSULT (decision 0048, owner 2026-10-07) — what the doctor's phone needed that the
 * consultation routes did not already give: sets, the doctor's own most-used diagnoses, and the
 * spoken note. Everything else the phone does (note, pre-check, issue, complete) is the web
 * consultation's own routes, unchanged.
 *
 * `opd.consult` throughout — the doctor already writing the note — for the reason the advice
 * library and the CDS reads carry no permission of their own. The two owner-side routes (the voice
 * meter and its switches) ride `opd.masters.read` / `opd.masters.manage`, the grants that already
 * mean "sees and sets how the OPD is configured".
 */
const setBody = z.object({
  id: z.string().min(1).max(64).nullish(),
  scope: z.enum(["doctor", "department"]),
  departmentId: z.string().min(1).max(64).nullish(),
  name: z.string().min(1).max(60),
  body: z.unknown(),
});
const voiceBody = z.object({
  /** base64, held in memory for one request and written nowhere. */
  audio: z.string().min(1).max(1_000_000),
  mimeType: z.string().min(3).max(40),
  seconds: z.number().positive().max(120),
});
const keptBody = z.object({ changedChars: z.number().int().nonnegative().max(100_000), keptChars: z.number().int().nonnegative().max(100_000) });
const settingsBody = z.object({
  enabled: z.boolean().optional(),
  model: z.enum(OPENAI_SPEECH_MODELS).optional(),
  dailyMinutesCap: z.number().int().min(0).max(6000).optional(),
});

export type MyDiagnosis = { text: string; icd10Code: string | null; uses: number };

@Controller("opd")
export class OpdPhoneConsultController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ——— sets ———

  @RequirePermission("opd.consult", "hospital")
  @Get("rx-sets")
  async sets(@CurrentActor() actor: Actor): Promise<{ items: RxSet[]; headOf: string[]; departmentId: string | null }> {
    try {
      return await listRxSets(this.db, actor);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("rx-sets")
  async saveSet(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ setId: string }> {
    const b = parsed(setBody, body);
    try {
      return await withTx(this.db, (tx) => saveRxSet(tx, actor, { id: b.id ?? null, scope: b.scope, departmentId: b.departmentId ?? null, name: b.name, body: b.body }));
    } catch (e) {
      toHttp(e);
    }
  }

  /** The unit head's signature on a starter set — checked in the service against the roster, not by a grant. */
  @RequirePermission("opd.consult", "hospital")
  @Post("rx-sets/:id/sign")
  async signSet(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ ok: true }> {
    try {
      await withTx(this.db, (tx) => signRxSet(tx, actor, id));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Delete("rx-sets/:id")
  async retireSet(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ ok: true }> {
    try {
      await withTx(this.db, (tx) => retireRxSet(tx, actor, id));
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— the doctor's own most-used diagnoses ———

  /**
   * What THIS doctor has diagnosed most, off their own completed visits — counts of words and
   * codes, no patient. The actor decides whose habits; there is no parameter to ask for another's.
   */
  @RequirePermission("opd.consult", "hospital")
  @Get("consult/my-diagnoses")
  async myDiagnoses(@CurrentActor() actor: Actor): Promise<{ items: MyDiagnosis[] }> {
    const doctor = actor.type === "user" ? await doctorForUser(this.db, actor.id) : null;
    if (doctor === null) return { items: [] };
    const uses = sql<number>`count(*)::int`;
    const rows = await this.db
      .select({ text: opdEncounterDiagnoses.text, icd10Code: opdEncounterDiagnoses.icd10Code, uses })
      .from(opdEncounterDiagnoses)
      .innerJoin(opdEncounters, eq(opdEncounters.id, opdEncounterDiagnoses.encounterId))
      .where(eq(opdEncounters.doctorId, doctor.id))
      .groupBy(opdEncounterDiagnoses.text, opdEncounterDiagnoses.icd10Code)
      .orderBy(desc(uses), opdEncounterDiagnoses.text)
      .limit(8);
    return { items: rows.map((r) => ({ text: r.text, icd10Code: r.icd10Code, uses: Number(r.uses) })) };
  }

  // ——— the spoken note ———

  @RequirePermission("opd.consult", "hospital")
  @Get("consult/voice/status")
  async status(): Promise<VoiceStatus> {
    return voiceStatus(this.db, this.cfg.openaiKeyFile);
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/consult/voice")
  async voice(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<TranscribeNoteResult> {
    const b = parsed(voiceBody, body);
    try {
      return await transcribeConsultNote(this.db, this.cfg.openaiKeyFile, actor, id, {
        audio: Buffer.from(b.audio, "base64"), mimeType: b.mimeType, seconds: b.seconds,
      });
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("consult/voice/:voiceId/kept")
  async kept(@CurrentActor() actor: Actor, @Param("voiceId") voiceId: string, @Body() body: unknown): Promise<{ ok: true }> {
    const b = parsed(keptBody, body);
    try {
      await recordVoiceKept(this.db, actor, voiceId, b);
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.masters.read", "hospital")
  @Get("consult/voice/meter")
  async meter(): Promise<VoiceMeter> {
    return voiceMeter(this.db, this.cfg.openaiKeyFile);
  }

  @RequirePermission("opd.masters.manage", "hospital")
  @Put("consult/voice/settings")
  async settings(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<VoiceSettings> {
    const b = parsed(settingsBody, body);
    try {
      const patch: Partial<VoiceSettings> = {};
      if (b.enabled !== undefined) patch.enabled = b.enabled;
      if (b.model !== undefined) patch.model = b.model;
      if (b.dailyMinutesCap !== undefined) patch.dailyMinutesCap = b.dailyMinutesCap;
      return Object.keys(patch).length === 0 ? await loadVoiceSettings(this.db) : await saveVoiceSettings(this.db, actor, patch);
    } catch (e) {
      toHttp(e);
    }
  }
}
