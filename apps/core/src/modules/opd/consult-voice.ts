import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { opdDepartments, opdPrescriptions, opdVitals, opdVoiceSettings, opdVoiceUsage, users } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { OPENAI_SPEECH_MODELS, OpenAiSpeechFailed, SPEECH_MIME_TYPES, openAiKeyFromFile, openAiTranscribe } from "../../kernel/inference/openai-speech";
import { getPatient } from "../patients";
import { searchMedicines } from "../formulary";
import { requireTreatingDoctor } from "./consultation";
import { guardHits, recordMisses, romanise, signalsMeter } from "./consult-guards";
import type { SignalsMeter } from "./consult-guards";
import { getEncounter } from "./encounters";
import { consultVoiceTranscribed } from "./events";
import { OpdError } from "./errors";
import { istDate } from "./time";
import type { OpenAiSpeechModel } from "../../kernel/inference/openai-speech";
import type { Db } from "../../kernel/db/client";

/**
 * PHONE CONSULT (decision 0048) — THE DOCTOR'S SPOKEN NOTE.
 *
 * Owner, 2026-10-07: *"Voice typing for notes: I would like to have it. Any audio model that
 * understands north indian languages and slangs in hinglish."* · *"I am open to go with OpenAI but
 * never with Sarvam. Yes, I am comfortable with consultation audio being sent to an outside speech
 * service, with the audio not stored but patient name must not be sent to openAI. Age, gender,
 * vitals could be sent."* · *"I don't have sample voice notes so let's skip the trial. let's go
 * ahead without it."*
 *
 * ═══ WHAT LEAVES THE HOSPITAL ═══
 * The clip, and a hint text built HERE from: an age BAND, the sex, today's vitals, the department's
 * name, the medicine names this doctor prescribes most, the test names this hospital advises most,
 * and a fixed list of Hinglish clinic words. `hintFor` takes no name, UHID, phone or address — it
 * is not given the patient row at all, only the four facts above — so there is nothing to forget
 * to leave out. NO NAME IS SENT AS DATA. A NAME THE DOCTOR SPEAKS TRAVELS IN THE AUDIO — the owner
 * accepted that on 2026-10-07 (decision 0049) and it is said in those words everywhere: the app's
 * notice, the privacy assessment, the owner's panel. "Avoid saying the name" is good practice the
 * screen asks for; it is not a safeguard and nothing here detects or blocks a spoken name.
 *
 * ═══ WHAT IS KEPT ═══
 * No audio, anywhere: the Buffer lives for one request. No transcript: it is returned to the phone
 * and is not written to a table, an event or a log. The meter row (`opd_voice_usage`) holds seconds
 * and character COUNTS; the event names the doctor and the seconds. The words reach the record
 * only if the doctor reads them and saves the note — the ordinary note route, in their name.
 *
 * ═══ MEASURED IN USE, IN PLACE OF A TRIAL ═══
 * `recordVoiceKept` stores how many characters the doctor changed before saving. Per doctor per
 * week, that is the evidence the model setting is switched on.
 */
export const VOICE_MAX_SECONDS = 60;
/**
 * The app records speech at 32 kbit/s mono: 60 s is ~240 kB. The ceiling is set by the API's own
 * 1 MB JSON body limit (`app.bootstrap.ts`) — 700 kB of audio is ~935 kB of base64 — and is not raised for this.
 */
export const VOICE_MAX_BYTES = 700_000;
export const VOICE_DEFAULTS = { enabled: true, suggestionsEnabled: true, model: "gpt-4o-transcribe" as OpenAiSpeechModel, dailyMinutesCap: 120 };

/**
 * TWO SWITCHES, both a setting and neither a deploy: `enabled` stops every clip at the door;
 * `suggestionsEnabled` stops "did you mean", the most-used diagnoses and the suggested tests while
 * the spoken note itself keeps working. The owner turns either off from the web in one tap.
 */
export type VoiceSettings = { enabled: boolean; suggestionsEnabled: boolean; model: OpenAiSpeechModel; dailyMinutesCap: number };
export type VoiceStatus = VoiceSettings & {
  /** The key file is readable — set by the owner on the server, never through this API. */
  configured: boolean; maxSeconds: number; usedSecondsToday: number;
  /** Why a clip would be refused right now, or null when one would be taken. */
  why: "not_configured" | "switched_off" | "cap_reached" | null;
};

export async function loadVoiceSettings(db: Db): Promise<VoiceSettings> {
  const rows = await db.select().from(opdVoiceSettings).where(eq(opdVoiceSettings.id, "main"));
  const row = rows[0];
  if (row === undefined) return { ...VOICE_DEFAULTS };
  const model = (OPENAI_SPEECH_MODELS as readonly string[]).includes(row.model) ? row.model as OpenAiSpeechModel : VOICE_DEFAULTS.model;
  return { enabled: row.enabled, suggestionsEnabled: row.suggestionsEnabled, model, dailyMinutesCap: row.dailyMinutesCap };
}

export async function saveVoiceSettings(db: Db, actor: Actor, patch: Partial<VoiceSettings>, now: Date = new Date()): Promise<VoiceSettings> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "voice settings are set by a person");
  const next = { ...(await loadVoiceSettings(db)), ...patch };
  if (!(OPENAI_SPEECH_MODELS as readonly string[]).includes(next.model)) throw new OpdError("invalid_config", "unknown speech model");
  if (!Number.isInteger(next.dailyMinutesCap) || next.dailyMinutesCap < 0 || next.dailyMinutesCap > 6000) throw new OpdError("invalid_config", "the daily cap is 0 to 6000 minutes");
  await db.insert(opdVoiceSettings).values({ id: "main", ...next, updatedBy: actor.id, updatedAt: now })
    .onConflictDoUpdate({ target: opdVoiceSettings.id, set: { ...next, updatedBy: actor.id, updatedAt: now } });
  return next;
}

async function usedSecondsOn(db: Db, day: string): Promise<number> {
  const rows = await db.select({ s: sql<number>`coalesce(sum(${opdVoiceUsage.seconds}), 0)::int` }).from(opdVoiceUsage).where(eq(opdVoiceUsage.day, day));
  return Number(rows[0]?.s ?? 0);
}

export async function voiceStatus(db: Db, keyFile: string | null, now: Date = new Date()): Promise<VoiceStatus> {
  const settings = await loadVoiceSettings(db);
  const configured = openAiKeyFromFile(keyFile, now.getTime()) !== null;
  const used = await usedSecondsOn(db, istDate(now));
  const why = !configured ? "not_configured" : !settings.enabled ? "switched_off" : used >= settings.dailyMinutesCap * 60 ? "cap_reached" : null;
  return { ...settings, configured, maxSeconds: VOICE_MAX_SECONDS, usedSecondsToday: used, why };
}

/** Words a clinic says that a general model spells three ways. Fixed text; no patient ever touches it. */
export const HINGLISH_LEXICON = [
  "bukhar", "khansi", "sardi", "zukam", "badan dard", "sir dard", "pet dard", "ulti", "dast", "kabz", "chakkar", "kamzori",
  "saans phoolna", "sujan", "khujli", "jalan", "gala kharab", "peshab mein jalan", "bhookh nahi lagti", "neend nahi aati",
  "din mein teen baar", "subah shaam", "khali pet", "khane ke baad", "sote samay", "BP", "sugar", "thyroid",
  "OD", "BD", "TDS", "QID", "HS", "SOS", "tablet", "capsule", "syrup", "injection", "ointment", "drops",
];

export type VoiceContext = { ageBand: string | null; sex: string | null; vitals: string | null; department: string | null };

export function ageBandOf(dob: Date | null, now: Date): string | null {
  if (dob === null) return null;
  const years = Math.floor((now.getTime() - dob.getTime()) / (365.25 * 24 * 3600 * 1000));
  if (years < 0) return null;
  if (years < 1) return "infant";
  if (years < 5) return "child under 5";
  if (years < 13) return "child 5-12";
  if (years < 18) return "adolescent";
  const lo = Math.min(Math.floor(years / 10) * 10, 80);
  return lo >= 80 ? "80 or older" : `${String(lo)}-${String(lo + 9)} years`;
}

/**
 * The hint. PURE, and given ONLY what may leave: it has no parameter a name could arrive through.
 * Kept short on purpose — a prompt is a bias, and a long one makes the model recite it.
 */
export function hintFor(ctx: VoiceContext, medicines: readonly string[], tests: readonly string[]): string {
  const who = [ctx.ageBand, ctx.sex, ctx.department === null ? null : `${ctx.department} OPD`].filter((x): x is string => x !== null && x !== "").join(", ");
  const parts = [
    "A doctor in a north Indian hospital OPD dictates a consultation note in Hindi and English mixed (Hinglish). Write it as spoken, Hindi words in Roman letters, medicine names and doses exact. Do not translate.",
    who === "" ? null : `Patient: ${who}.`,
    ctx.vitals === null ? null : `Vitals today: ${ctx.vitals}.`,
    medicines.length === 0 ? null : `Medicines often named: ${medicines.slice(0, 60).join(", ")}.`,
    tests.length === 0 ? null : `Tests often named: ${tests.slice(0, 40).join(", ")}.`,
    `Common words: ${HINGLISH_LEXICON.join(", ")}.`,
  ];
  return parts.filter((x): x is string => x !== null).join(" ").slice(0, 3500);
}

async function doctorsMedicines(db: Db, doctorId: string): Promise<string[]> {
  const rows = await db.select({ lines: opdPrescriptions.lines }).from(opdPrescriptions)
    .where(eq(opdPrescriptions.doctorId, doctorId)).orderBy(desc(opdPrescriptions.issuedAt)).limit(200);
  const n = new Map<string, number>();
  for (const r of rows) {
    for (const l of (Array.isArray(r.lines) ? r.lines : []) as { drug?: unknown }[]) {
      const d = typeof l.drug === "string" ? l.drug.trim() : "";
      if (d !== "" && d.length <= 80) n.set(d, (n.get(d) ?? 0) + 1);
    }
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 60).map((e) => e[0]);
}

async function hospitalTests(db: Db, since: string): Promise<{ serviceId: string; code: string; name: string; pricePaise: number }[]> {
  const res = await db.execute(sql`
    select t->>'serviceId' as "serviceId", t->>'code' as code, t->>'name' as name, max((t->>'pricePaise')::int) as "pricePaise", count(*)::int as n
      from opd_encounters e cross join lateral jsonb_array_elements(e.advised_tests) t
     where e.service_date >= ${since} and jsonb_typeof(e.advised_tests) = 'array'
     group by 1, 2, 3 order by n desc, 3 asc limit 40`);
  return (res.rows as { serviceId: string | null; code: string | null; name: string | null; pricePaise: number | null }[])
    .filter((r) => r.serviceId !== null && r.name !== null)
    .map((r) => ({ serviceId: r.serviceId!, code: r.code ?? "", name: r.name!, pricePaise: Number(r.pricePaise ?? 0) }));
}

const STOP = new Set(("the a an and or of to in on for with is are was were has have had not no yes hai hain tha thi the ko ka ki ke se me mein par aur ya bhi nahi nahin ho raha rahi rahe din raat subah shaam baar teen do ek char paanch chal chalu khali pet khane baad pehle sote samay "
  + "patient fever cough cold pain tablet capsule syrup injection daily days day week weeks month after before food twice thrice once morning evening night mg ml tab cap bukhar khansi dard badan sir gala laal chest clear sugar dawa").split(/\s+/));

export type VoiceSuggestion =
  | { kind: "medicine"; heard: string; medicineId: string; name: string; form: string; strength: string | null; drugClass: string | null; lasa: string | null }
  | { kind: "test"; heard: string; serviceId: string; code: string; name: string; pricePaise: number };

/**
 * "Pan 40" → Pantoprazole 40 mg, OFFERED. Words in what was heard are looked up in the hospital's
 * own catalogue (a medicine NAME that starts with the word, the next number riding along as the
 * strength) and in the tests the hospital advises. Nothing here is added to anything: a suggestion
 * becomes a medicine line only when the doctor taps it, and then it is checked like any other line.
 */
export async function suggestFromTranscript(
  db: Db, text: string, tests: readonly { serviceId: string; code: string; name: string; pricePaise: number }[],
): Promise<{ suggestions: VoiceSuggestion[]; missed: string[] }> {
  const tokens = text.split(/[^A-Za-z0-9.+-]+/).filter((t) => t !== "");
  const out: VoiceSuggestion[] = [];
  const seenMed = new Set<string>();
  // A word with a strength after it ("Zerodol 100") that the catalogue could not answer: a medicine
  // was very likely meant. Logged as the term alone, for the alias tool.
  const missed: string[] = [];
  const asked = new Set<string>();
  for (let i = 0; i < tokens.length && asked.size < 12; i++) {
    const w = tokens[i]!;
    if (!/^[A-Za-z][A-Za-z-]{2,}$/.test(w) || STOP.has(w.toLowerCase())) continue;
    const next = tokens[i + 1];
    const phrase = next !== undefined && /^\d{1,4}(\.\d+)?$/.test(next) ? `${w} ${next}` : w;
    const key = phrase.toLowerCase();
    if (asked.has(key)) continue;
    asked.add(key);
    const found = (await searchMedicines(db, phrase, 3)).find((h) => h.prefix);
    if (found === undefined) { if (phrase !== w) missed.push(phrase); continue; }
    if (!seenMed.has(found.id)) {
      seenMed.add(found.id);
      const hit = (await guardHits(db, [found]))[0]!;
      out.push({ kind: "medicine", heard: phrase, medicineId: hit.id, name: hit.name, form: hit.form, strength: hit.strength, drugClass: hit.drugClass, lasa: hit.lasa });
    }
  }
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (const t of tests) {
    const code = t.code.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const name = t.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const heard = name.length >= 3 && lower.includes(` ${name} `) ? t.name : code.length >= 3 && lower.includes(` ${code} `) ? t.code : null;
    if (heard !== null) out.push({ kind: "test", heard, serviceId: t.serviceId, code: t.code, name: t.name, pricePaise: t.pricePaise });
  }
  return { suggestions: out.slice(0, 10), missed: missed.slice(0, 8) };
}

export type TranscribeNoteInput = { audio: Buffer; mimeType: string; seconds: number };
export type TranscribeNoteResult = { voiceId: string; text: string; suggestions: VoiceSuggestion[]; model: string };

export async function transcribeConsultNote(
  db: Db, keyFile: string | null, actor: Actor, encounterId: string, input: TranscribeNoteInput,
  deps: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<TranscribeNoteResult> {
  const now = deps.now ?? new Date();
  const enc = await getEncounter(db, encounterId);
  if (!enc) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const doctor = await requireTreatingDoctor(db, actor, enc);
  if (enc.status !== "in_consultation") throw new OpdError("encounter_state_conflict", `a spoken note needs in_consultation, not ${enc.status}`);
  if (!SPEECH_MIME_TYPES.includes(input.mimeType)) throw new OpdError("invalid_voice_clip", "unknown audio type");
  if (input.audio.length === 0) throw new OpdError("invalid_voice_clip", "empty clip");
  if (input.audio.length > VOICE_MAX_BYTES || !Number.isFinite(input.seconds) || input.seconds <= 0 || input.seconds > VOICE_MAX_SECONDS + 2) {
    throw new OpdError("invalid_voice_clip", `a spoken note is at most ${String(VOICE_MAX_SECONDS)} seconds`);
  }
  const status = await voiceStatus(db, keyFile, now);
  if (status.why !== null) throw new OpdError("voice_unavailable_state_conflict", `voice is not available: ${status.why}`, { why: status.why });
  const key = openAiKeyFromFile(keyFile, now.getTime())!;

  // Only these four facts are read off the patient and the visit. `hintFor` cannot be handed more.
  const got = actor.type === "user" ? await getPatient(db, actor, enc.patientId) : null;
  const vit = (await db.select().from(opdVitals).where(eq(opdVitals.encounterId, enc.id)).orderBy(desc(opdVitals.recordedAt)).limit(1))[0];
  const dept = enc.departmentId === null ? undefined : (await db.select({ name: opdDepartments.name }).from(opdDepartments).where(eq(opdDepartments.id, enc.departmentId)))[0];
  const g = got?.patient.administrativeGender ?? null;
  const ctx: VoiceContext = {
    ageBand: ageBandOf(got?.patient.dob ?? null, now),
    sex: g === "male" || g === "female" ? g : null,
    vitals: vit === undefined ? null : [
      vit.sbp !== null && vit.dbp !== null ? `BP ${String(vit.sbp)}/${String(vit.dbp)}` : null,
      vit.pulse !== null ? `pulse ${String(vit.pulse)}` : null, vit.spo2 !== null ? `SpO2 ${String(vit.spo2)}` : null,
      vit.tempC !== null ? `temp ${String(vit.tempC)} C` : null, vit.weightKg !== null ? `weight ${String(vit.weightKg)} kg` : null,
      vit.glucoseMgDl !== null ? `glucose ${String(vit.glucoseMgDl)} mg/dL (${(vit.glucoseTiming ?? "untimed").replace("_", " ")})` : null,
    ].filter((x): x is string => x !== null).join(", ") || null,
    department: dept?.name ?? null,
  };
  const since = istDate(new Date(now.getTime() - 180 * 24 * 3600 * 1000));
  const [medicines, tests] = await Promise.all([doctorsMedicines(db, doctor.id), hospitalTests(db, since)]);
  const prompt = hintFor(ctx, medicines, tests.map((t) => t.name));

  const seconds = Math.max(1, Math.round(input.seconds));
  const voiceId = newId();
  let text = "";
  let ok = true;
  try {
    ({ text } = await openAiTranscribe({ key, model: status.model, audio: input.audio, mimeType: input.mimeType, prompt, ...(deps.fetcher === undefined ? {} : { fetcher: deps.fetcher }) }));
  } catch (e) {
    if (!(e instanceof OpenAiSpeechFailed)) throw e;
    ok = false;
  }
  // The meter and the event: WHO, HOW LONG, WHICH MODEL. Never what was said.
  await withTx(db, async (tx) => {
    await tx.insert(opdVoiceUsage).values({
      id: voiceId, userId: actor.type === "user" ? actor.id : "", day: istDate(now), model: status.model,
      seconds: ok ? seconds : 0, transcriptChars: text.length, ok, createdAt: now,
    });
    await appendEvent(tx, consultVoiceTranscribed.make({
      actor, payload: { doctorId: doctor.id, seconds, model: status.model, ok },
    }));
  });
  if (!ok) throw new OpdError("voice_provider_failed", "the speech service did not answer — type the note, or try again");
  // One script: whatever the model wrote, the doctor reads Roman and the catalogue is matched in Roman.
  const roman = romanise(text);
  if (roman === "" || !status.suggestionsEnabled) return { voiceId, text: roman, suggestions: [], model: status.model };
  const { suggestions, missed } = await suggestFromTranscript(db, roman, tests);
  if (actor.type === "user") await recordMisses(db, actor.id, missed.map((term) => ({ kind: "medicine" as const, term, stage: "voice" as const })), now);
  return { voiceId, text: roman, suggestions, model: status.model };
}

/** What the doctor did with what was heard: characters changed before saving, and how long the kept text is. Counts only. */
export async function recordVoiceKept(db: Db, actor: Actor, voiceId: string, input: { changedChars: number; keptChars: number }): Promise<void> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "a spoken note is a doctor's");
  const done = await db.update(opdVoiceUsage)
    .set({ changedChars: Math.max(0, Math.round(input.changedChars)), keptChars: Math.max(0, Math.round(input.keptChars)) })
    .where(and(eq(opdVoiceUsage.id, voiceId), eq(opdVoiceUsage.userId, actor.id))).returning({ id: opdVoiceUsage.id });
  if (done.length === 0) throw new OpdError("unknown_voice_note", `unknown spoken note ${voiceId}`);
}

export type VoiceMeterRow = {
  userId: string; name: string; weekStart: string; notes: number; minutes: number;
  /** Share of the heard text the doctor changed before saving, 0..1, over the notes they saved; null when none were saved. */
  changedShare: number | null;
};
export type VoiceMeter = { status: VoiceStatus; days: { day: string; minutes: number; notes: number }[]; doctors: VoiceMeterRow[]; signals: SignalsMeter };

/** The owner's panel: minutes per day, and per doctor per week how much they had to correct. */
export async function voiceMeter(db: Db, keyFile: string | null, now: Date = new Date()): Promise<VoiceMeter> {
  const from = istDate(new Date(now.getTime() - 55 * 24 * 3600 * 1000));
  const to = istDate(now);
  const rows = await db.select().from(opdVoiceUsage).where(and(gte(opdVoiceUsage.day, from), lte(opdVoiceUsage.day, to), eq(opdVoiceUsage.ok, true)));
  const names = new Map<string, string>();
  if (rows.length > 0) {
    const ids = [...new Set(rows.map((r) => r.userId))];
    for (const u of await db.select({ id: users.id, fullName: users.fullName, username: users.username }).from(users)) {
      if (ids.includes(u.id)) names.set(u.id, u.fullName === "" ? u.username : u.fullName);
    }
  }
  const dayMap = new Map<string, { s: number; n: number }>();
  const docMap = new Map<string, { userId: string; weekStart: string; n: number; s: number; heard: number; changed: number }>();
  for (const r of rows) {
    const d = dayMap.get(r.day) ?? { s: 0, n: 0 };
    d.s += r.seconds; d.n += 1; dayMap.set(r.day, d);
    const dt = new Date(`${r.day}T00:00:00Z`);
    const monday = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const k = `${r.userId}|${monday}`;
    const m = docMap.get(k) ?? { userId: r.userId, weekStart: monday, n: 0, s: 0, heard: 0, changed: 0 };
    m.n += 1; m.s += r.seconds;
    if (r.changedChars !== null) { m.heard += Math.max(r.transcriptChars, 1); m.changed += Math.min(r.changedChars, Math.max(r.transcriptChars, r.keptChars ?? 0, 1)); }
    docMap.set(k, m);
  }
  return {
    status: await voiceStatus(db, keyFile, now),
    signals: await signalsMeter(db, now),
    days: [...dayMap.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 14).map(([day, v]) => ({ day, minutes: Math.round(v.s / 6) / 10, notes: v.n })),
    doctors: [...docMap.values()].sort((a, b) => (a.weekStart === b.weekStart ? (a.userId < b.userId ? -1 : 1) : a.weekStart < b.weekStart ? 1 : -1))
      .map((m) => ({ userId: m.userId, name: names.get(m.userId) ?? m.userId, weekStart: m.weekStart, notes: m.n, minutes: Math.round(m.s / 6) / 10, changedShare: m.heard === 0 ? null : Math.round((m.changed / m.heard) * 100) / 100 })),
  };
}
