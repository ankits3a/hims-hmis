import { and, count, eq } from "drizzle-orm";
import { ER_AGE_BAND_INFO, ER_INTENTS, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { erBands, patients } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { computerAlive, getComputer } from "../../kernel/printing/computers";
import { displayNameFor, listAllergies, resolvePatientId } from "../patients";
import { ageWords, aliasHiOf, lockEpisode, onceEr, provenanceOf, requireErPermission, yearsOld } from "./core";
import { ErRefusal } from "./errors";
import { erBandPrinted, erBandVoided } from "./events";
import { ER_ARRIVAL_REGISTER } from "./names";
import type { Actor, ErAgeBand, ErBandPayload, ErIntentName } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { EpisodeRow } from "./core";

type Input<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["input"]>;
type Output<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["output"]>;
type Opts = { now?: Date };
type BandSize = ErBandPayload["size"];
type BandSite = ErBandPayload["site"];

/**
 * ER lane 1 (#808) — THE ER BAND (IPD's band, for an ER episode; spec §4.1: "Band printed at arrival (IPD band code;
 * serial `<ER no>-<n>`)").
 *
 * White band, every alert printed IN WORDS (colour alone is not an identifier). The barcode and the QR carry the band's
 * SERIAL; a scanner resolves the serial against `er_bands`, so a voided band no longer identifies anyone. One live band
 * per episode; a reprint voids the old one with its reason. An unidentified patient's band prints the alias and
 * "Allergy: unknown" (spec §4.3: allergy unknown is said in words); after the identity merge the reprint prints the
 * true name. Prints from the desk's browser at the band's size until the thermal relay has an ER band kind (decision
 * 0045's fallback; IPD's band is in the same position).
 */
const BAND_STATES = new Set(["arrived", "triaged", "in_treatment", "disposition_decided"]);
const IST = (d: Date): string => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
}).format(d);
const SEX_LETTER: Record<string, string> = { male: "M", female: "F", other: "O", unknown: "U" };

export async function checkPrinter(db: Db, printerId: string | undefined, at: Date): Promise<void> {
  if (printerId === undefined) return;
  const c = await getComputer(db, printerId);
  if (c === null || !computerAlive(c, at)) throw new ErRefusal("printer_offline", { printerId });
}

/** The patient as the band names them NOW: through the merge chain, read in the caller's transaction. */
export async function bandPerson(tx: Db | Tx, patientId: string): Promise<{
  id: string; uhid: string; name: string; dob: Date | null; sex: string; unidentified: boolean; alias: string | null; isConfidential: boolean;
}> {
  const canonical = (await resolvePatientId(tx, patientId)) ?? patientId;
  const p = (await tx.select({
    id: patients.id, uhid: patients.uhid, name: patients.name, dob: patients.dob, sex: patients.sex, identityStatus: patients.identityStatus,
    alias: patients.alias, isConfidential: patients.isConfidential,
  }).from(patients).where(eq(patients.id, canonical)))[0];
  if (p === undefined) throw new ErRefusal("patient_not_found");
  return {
    id: p.id, uhid: p.uhid, name: p.name, dob: p.dob, sex: p.sex, unidentified: p.identityStatus === "unidentified",
    alias: p.alias, isConfidential: p.isConfidential,
  };
}

/** Band size from the age: a recorded DOB under 14, or a paediatric age band, takes the paediatric band. */
export function defaultBandSize(dob: Date | null, band: ErAgeBand | null, at: Date): BandSize {
  const years = yearsOld(dob, at);
  if (years !== null) return years < 14 ? "paediatric" : "adult";
  return band !== null && ER_AGE_BAND_INFO[band].paediatric ? "paediatric" : "adult";
}

async function payloadOf(
  db: Db, tx: Tx, actor: Actor, e: EpisodeRow, serial: string, size: BandSize | undefined, site: BandSite, at: Date,
): Promise<ErBandPayload> {
  const p = await bandPerson(tx, e.patientId);
  // ER review (2026-10-15, DECIDED): a sealed patient's band (and the response that carries it) shows the alias unless
  // the reader holds `patients.confidential.read` — the patients module's one rule (`displayNameFor`).
  const name = await displayNameFor(tx, actor, p);
  const band = (e.ageBand ?? null) as ErAgeBand | null;
  const allergies = p.unidentified ? [] : await listAllergies(db, p.id);
  const live = allergies.filter((r) => r.status === "active");
  const allergyWords = p.unidentified ? ["Allergy: unknown"]
    : live.length === 0 ? ["Allergy: none recorded"]
      : live.map((r) => `Allergy: ${r.substance}${r.severity === null ? "" : ` (${r.severity})`}`);
  const alertWords: string[] = [];
  if (p.unidentified) alertWords.push("Unidentified");
  if (e.returnedWithin24h) alertWords.push("Returned within 24 h");
  return {
    name, nameHi: p.unidentified ? aliasHiOf(e.alias) : null, uhid: p.uhid,
    ageSex: `${ageWords(yearsOld(p.dob, at), band)} ${SEX_LETTER[p.sex] ?? "U"}`,
    episodeNo: e.episodeNo, arrivedOn: IST(e.arrivedAt), allergyWords, alertWords,
    size: size ?? defaultBandSize(p.dob, band, at), site, barcode: serial, qr: `ERBAND1|${serial}|${p.uhid}`,
  };
}

async function nextSerial(tx: Tx, e: EpisodeRow): Promise<string> {
  const [row] = await tx.select({ n: count() }).from(erBands).where(eq(erBands.episodeId, e.id));
  return `${e.episodeNo}-${String(Number(row?.n ?? 0) + 1)}`;
}

async function liveBand(tx: Tx, episodeId: string) {
  return (await tx.select().from(erBands).where(and(eq(erBands.episodeId, episodeId), eq(erBands.status, "printed"))).for("update"))[0];
}

/** Mints a band in the caller's transaction (the arrival intents print at arrival; `print_er_band` after). */
export async function mintBandIn(
  db: Db, tx: Tx, actor: Actor, e: EpisodeRow, choice: { size?: BandSize; site: BandSite; printerId?: string }, at: Date,
): Promise<Output<"print_er_band">> {
  const serial = await nextSerial(tx, e);
  const band = await payloadOf(db, tx, actor, e, serial, choice.size, choice.site, at);
  const bandId = newId();
  await tx.insert(erBands).values({
    id: bandId, episodeId: e.id, serial, size: band.size, site: band.site, printerId: choice.printerId ?? null,
    status: "printed", payload: band, printedBy: actor.id, printedAt: at,
  });
  await appendEvent(tx, erBandPrinted.make({
    payload: { episodeId: e.id, bandId, serial, provenance: provenanceOf(actor) },
    actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
  }));
  return { bandId, bandSerial: serial, printedAt: at.toISOString(), band };
}

export async function printErBand(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"print_er_band">> {
  const input: Input<"print_er_band"> = ER_INTENTS.print_er_band.input.parse(raw);
  await requireErPermission(db, actor, ER_ARRIVAL_REGISTER);
  const at = opts.now ?? new Date();
  await checkPrinter(db, input.printerId, at);
  return onceEr(db, actor, "print_er_band", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await lockEpisode(tx, input.episodeId);
    if (!BAND_STATES.has(e.state)) throw new ErRefusal("episode_wrong_state");
    const live = await liveBand(tx, e.id);
    if (live !== undefined) throw new ErRefusal("band_already_printed", { bandId: live.id, serial: live.serial });
    return mintBandIn(db, tx, actor, e, { size: input.size, site: input.site, printerId: input.printerId }, at);
  }), at);
}

/** Damaged, unreadable, details changed, an allergy added or the identity confirmed: the old band is voided first. */
export async function reprintErBand(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"reprint_er_band">> {
  const input: Input<"reprint_er_band"> = ER_INTENTS.reprint_er_band.input.parse(raw);
  await requireErPermission(db, actor, ER_ARRIVAL_REGISTER);
  const at = opts.now ?? new Date();
  await checkPrinter(db, input.printerId, at);
  return onceEr(db, actor, "reprint_er_band", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await lockEpisode(tx, input.episodeId);
    if (!BAND_STATES.has(e.state)) throw new ErRefusal("episode_wrong_state");
    const old = await liveBand(tx, e.id);
    if (old === undefined) throw new ErRefusal("no_band_to_reprint");
    await tx.update(erBands).set({ status: "void", voidReason: input.reason, voidedBy: actor.id, voidedAt: at }).where(eq(erBands.id, old.id));
    await appendEvent(tx, erBandVoided.make({
      payload: { episodeId: e.id, bandId: old.id, serial: old.serial, reason: input.reason, provenance: provenanceOf(actor) },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    // The size follows the patient (a merged true record may carry a DOB); the site stays unless asked.
    const printed = await mintBandIn(db, tx, actor, e, {
      size: input.size, site: input.site ?? (old.site as BandSite), printerId: input.printerId,
    }, at);
    return { ...printed, voidedBandId: old.id };
  }), at);
}
