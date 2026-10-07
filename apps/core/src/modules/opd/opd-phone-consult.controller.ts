import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { withTx } from "../../kernel/db/client";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { opdEncounterDiagnoses, opdEncounters, opdLasaPairs } from "../../kernel/db/schema";
import { OPENAI_SPEECH_MODELS } from "../../kernel/inference/openai-speech";
import { listRxSets, retireRxSet, saveRxSet, signRxSet } from "./rx-sets";
import {
  loadVoiceSettings, recordVoiceKept, saveVoiceSettings, transcribeConsultNote, voiceMeter, voiceStatus,
} from "./consult-voice";
import { SIGNAL_KINDS, SIGNAL_OUTCOMES, SIGNAL_SOURCES, guardedMedicineSearch, recordSignals } from "./consult-guards";
import { OpdError } from "./errors";
import { doctorForUser } from "./masters";
import { parsed, toHttp } from "./opd-masters.controller";
import type { RxSet } from "./rx-sets";
import type { GuardedMedicineHit } from "./consult-guards";
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
const searchQuery = z.object({ q: z.string().max(80), limit: z.coerce.number().int().min(1).max(12).optional() });
const signalsBody = z.object({
  misses: z.array(z.object({ kind: z.enum(SIGNAL_KINDS), term: z.string().min(1).max(200), stage: z.enum(["search", "voice"]) })).max(20).default([]),
  suggestions: z.array(z.object({ kind: z.enum(SIGNAL_KINDS), source: z.enum(SIGNAL_SOURCES), outcome: z.enum(SIGNAL_OUTCOMES) })).max(60).default([]),
});
const lasaBody = z.object({ nameA: z.string().min(3).max(60), nameB: z.string().min(3).max(60) });
const settingsBody = z.object({
  enabled: z.boolean().optional(),
  suggestionsEnabled: z.boolean().optional(),
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
    // The suggestions switch covers this too: off ⇒ the phone offers nothing it worked out.
    if (doctor === null || !(await loadVoiceSettings(this.db)).suggestionsEnabled) return { items: [] };
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

  // ——— the guards round a suggestion ———

  /**
   * The phone's medicine search: the formulary's own search (exact, then trigram — unchanged), each
   * row carrying its class and the look-alike name the phone must ask about before taking the pick.
   */
  @RequirePermission("opd.consult", "hospital")
  @Get("consult/medicines")
  async medicines(@Query() query: unknown): Promise<{ items: GuardedMedicineHit[] }> {
    const q = parsed(searchQuery, query);
    return { items: await guardedMedicineSearch(this.db, q.q, q.limit ?? 8) };
  }

  /** Terms that matched nothing, and what became of each suggestion. Counts and terms — no patient, no visit. */
  @RequirePermission("opd.consult", "hospital")
  @Post("consult/signals")
  async signals(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ misses: number; suggestions: number }> {
    const b = parsed(signalsBody, body);
    try {
      return await recordSignals(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.masters.read", "hospital")
  @Get("consult/lasa")
  async lasa(): Promise<{ items: { id: string; nameA: string; nameB: string; active: boolean; reviewed: boolean; reviewedAt: string | null }[] }> {
    const rows = await this.db.select().from(opdLasaPairs).orderBy(opdLasaPairs.nameA, opdLasaPairs.nameB);
    return { items: rows.map((r) => ({ id: r.id, nameA: r.nameA, nameB: r.nameB, active: r.active, reviewed: r.reviewedBy !== null, reviewedAt: r.reviewedAt?.toISOString() ?? null })) };
  }

  /** A pharmacist's pair. Stored lower-case and in order, so the same pair cannot be entered twice. */
  @RequirePermission("opd.masters.manage", "hospital")
  @Post("consult/lasa")
  async lasaAdd(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ ok: true }> {
    const b = parsed(lasaBody, body);
    try {
      if (actor.type !== "user") throw new OpdError("user_actor_required", "a look-alike pair is entered by a person");
      const [a, z2] = [b.nameA.trim().toLowerCase(), b.nameB.trim().toLowerCase()].sort() as [string, string];
      if (a === z2 || !/^[a-z][a-z -]+$/.test(a) || !/^[a-z][a-z -]+$/.test(z2)) throw new OpdError("invalid_config", "a pair is two different medicine names, letters only");
      const now = new Date();
      await this.db.insert(opdLasaPairs).values({ id: `lasa_${String(now.getTime())}`, nameA: a, nameB: z2, reviewedBy: actor.id, reviewedAt: now })
        .onConflictDoUpdate({ target: [opdLasaPairs.nameA, opdLasaPairs.nameB], set: { active: true, reviewedBy: actor.id, reviewedAt: now } });
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  /** Confirm a pair (the shipped list arrives unreviewed), or switch one off. */
  @RequirePermission("opd.masters.manage", "hospital")
  @Put("consult/lasa/:id")
  async lasaSet(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const b = parsed(z.object({ active: z.boolean() }), body);
    try {
      if (actor.type !== "user") throw new OpdError("user_actor_required", "a look-alike pair is reviewed by a person");
      const now = new Date();
      const done = await this.db.update(opdLasaPairs).set({ active: b.active, reviewedBy: actor.id, reviewedAt: now }).where(eq(opdLasaPairs.id, id)).returning({ id: opdLasaPairs.id });
      if (done.length === 0) throw new OpdError("invalid_config", "unknown pair");
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
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
      if (b.suggestionsEnabled !== undefined) patch.suggestionsEnabled = b.suggestionsEnabled;
      if (b.model !== undefined) patch.model = b.model;
      if (b.dailyMinutesCap !== undefined) patch.dailyMinutesCap = b.dailyMinutesCap;
      return Object.keys(patch).length === 0 ? await loadVoiceSettings(this.db) : await saveVoiceSettings(this.db, actor, patch);
    } catch (e) {
      toHttp(e);
    }
  }
}
