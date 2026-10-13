import { and, count, eq, isNull } from "drizzle-orm";
import { IPD_INTENTS, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { ipdBands, ipdBedStays, resources } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { computerAlive, getComputer } from "../../kernel/printing/computers";
import { getPatient, listAllergies } from "../patients";
import { lockAdmission, onceIpd, provenanceOf, requireIpdPermission } from "./admission-core";
import { bandPrinted, bandReprinted, bandVoided } from "./admission-events";
import { userNames } from "./admissions";
import { ageInYears } from "./bed-rules";
import { IpdRefusal } from "./errors";
import { IPD_BAND_PRINT } from "./manifest";
import type { Actor, IpdBandPayload, IpdIntentName } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

/**
 * E1.2 (#719) — THE WRISTBAND (§2 answer 4, §4.2 band edge cases).
 *
 * White band; alerts ride as a coloured clip AND are printed in words, because colour alone is not an identifier. The
 * band carries a Code 128 barcode and a QR of its SERIAL; a scanner (eMAR, E3.x) resolves the serial against this
 * register, so a voided band no longer identifies anyone. One live band per admission; a reprint voids the old one
 * and records why.
 *
 * DECIDED (E1.2): the thermal relay has no `ipd_wristband` document kind yet (adding one is a kernel print-outbox edit,
 * owed); the band prints from the desk's browser (decision 0045's fallback) at the band's size. A named print computer
 * (`printerId`) must be enrolled and alive, or the act refuses `printer_offline` and the desk picks the nearest.
 */
const BAND_STATES = new Set(["admitted", "transferring", "fit_declared", "discharging"]);
const IST = (d: Date): string => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(d);

/** Every active allergy in words; "Allergy: none recorded" when there is none (a blank must never read as "none"). */
export function allergyWords(rows: { substance: string; severity: string | null; status: string }[]): string[] {
  const live = rows.filter((r) => r.status === "active");
  if (live.length === 0) return ["Allergy: none recorded"];
  return live.map((r) => `Allergy: ${r.substance}${r.severity === null ? "" : ` (${r.severity})`}`);
}

async function bandPayload(
  db: Db, tx: Tx, actor: Actor, a: AdmissionRow, serial: string, size: IpdBandPayload["size"], site: IpdBandPayload["site"], at: Date,
): Promise<IpdBandPayload> {
  const found = await getPatient(db, actor, a.patientId);
  if (found === null) throw new IpdRefusal("patient_not_found");
  const p = found.patient;
  const age = ageInYears(p.dob, at);
  const sex = p.sex === "male" ? "M" : p.sex === "female" ? "F" : "O";
  const stay = (await tx.select({ code: resources.code }).from(ipdBedStays)
    .innerJoin(resources, eq(resources.id, ipdBedStays.bedId))
    .where(and(eq(ipdBedStays.admissionId, a.id), isNull(ipdBedStays.endedAt))))[0];
  const names = await userNames(db, [a.consultantId]);
  const alertWords: string[] = [];
  if (a.mlc) alertWords.push("MLC");
  if (a.isolation !== "none") alertWords.push(`Isolation: ${a.isolation}`);
  return {
    name: p.name, uhid: p.uhid, ageSex: `${age === null ? "?" : String(age)}${sex}`,
    dob: p.dob === null ? null : new Date(p.dob).toISOString().slice(0, 10),
    admissionNo: a.admissionNo ?? "", admittedOn: a.admittedAt === null ? "" : IST(a.admittedAt),
    bedCode: stay?.code ?? null, consultant: names.get(a.consultantId) ?? a.consultantId,
    allergyWords: allergyWords(await listAllergies(db, a.patientId)), alertWords,
    // Newborn pairing (mother's name on the baby's band) waits for the mother–baby link (owed with labour room).
    motherName: null,
    size, site, barcode: serial, qr: `IPDBAND1|${serial}|${p.uhid}`,
  };
}

async function checkPrinter(db: Db, printerId: string | undefined, at: Date): Promise<void> {
  if (printerId === undefined) return;
  const c = await getComputer(db, printerId);
  if (c === null || !computerAlive(c, at)) throw new IpdRefusal("printer_offline", undefined, { printerId });
}

async function nextSerial(tx: Tx, a: AdmissionRow): Promise<string> {
  const [row] = await tx.select({ n: count() }).from(ipdBands).where(eq(ipdBands.admissionId, a.id));
  return `${a.admissionNo ?? a.id}-${String(Number(row?.n ?? 0) + 1)}`;
}

async function liveBand(tx: Tx, admissionId: string) {
  return (await tx.select().from(ipdBands).where(and(eq(ipdBands.admissionId, admissionId), eq(ipdBands.status, "printed"))).for("update"))[0];
}

export async function printBand(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"print_band">> {
  const input: Input<"print_band"> = IPD_INTENTS.print_band.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_BAND_PRINT);
  const at = opts.now ?? new Date();
  await checkPrinter(db, input.printerId, at);
  return onceIpd(db, actor, "print_band", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!BAND_STATES.has(a.state)) throw new IpdRefusal("admission_wrong_state");
    const live = await liveBand(tx, a.id);
    if (live !== undefined) throw new IpdRefusal("band_already_printed", undefined, { bandId: live.id, serial: live.serial });
    const serial = await nextSerial(tx, a);
    const band = await bandPayload(db, tx, actor, a, serial, input.size, input.site, at);
    const bandId = newId();
    await tx.insert(ipdBands).values({
      id: bandId, admissionId: a.id, serial, size: input.size, site: input.site, printerId: input.printerId ?? null,
      status: "printed", payload: band, printedBy: actor.id, printedAt: at,
    });
    await appendEvent(tx, bandPrinted.make({
      payload: { admissionId: a.id, bandId, serial, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { bandId, bandSerial: serial, printedAt: at.toISOString(), band };
  }), at);
}

/** Damaged, unreadable, an allergy added, details changed or a UHID merge: the old band is voided with the reason. */
export async function reprintBand(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"reprint_band">> {
  const input: Input<"reprint_band"> = IPD_INTENTS.reprint_band.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_BAND_PRINT);
  const at = opts.now ?? new Date();
  await checkPrinter(db, input.printerId, at);
  return onceIpd(db, actor, "reprint_band", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!BAND_STATES.has(a.state)) throw new IpdRefusal("admission_wrong_state");
    const old = await liveBand(tx, a.id);
    if (old === undefined) throw new IpdRefusal("no_band_to_reprint");
    await tx.update(ipdBands).set({ status: "void", voidReason: input.reason, voidedBy: actor.id, voidedAt: at }).where(eq(ipdBands.id, old.id));
    const provenance = provenanceOf(actor);
    await appendEvent(tx, bandVoided.make({
      payload: { admissionId: a.id, bandId: old.id, serial: old.serial, reason: input.reason, provenance },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    const serial = await nextSerial(tx, a);
    const band = await bandPayload(db, tx, actor, a, serial, input.size, input.site, at);
    const bandId = newId();
    await tx.insert(ipdBands).values({
      id: bandId, admissionId: a.id, serial, size: input.size, site: input.site, printerId: input.printerId ?? null,
      status: "printed", payload: band, printedBy: actor.id, printedAt: at,
    });
    await appendEvent(tx, bandReprinted.make({
      payload: { admissionId: a.id, bandId, serial, reason: input.reason, provenance },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { bandId, bandSerial: serial, printedAt: at.toISOString(), band, voidedBandId: old.id };
  }), at);
}
