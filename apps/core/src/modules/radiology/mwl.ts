import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { IST_UTC_OFFSET_MINUTES } from "../../kernel/approvals/cumulative";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { orders } from "../../kernel/db/schema/orders";
import { patients } from "../../kernel/db/schema/patients";
import { resources } from "../../kernel/db/schema/resources";
import { displayName } from "../patients";
import { activeRegistrationFor } from "../pcpndt";
import { activeLicenceFor } from "../aerb";
import { activeStudyTypes } from "./study-types";
import { RadiologyError } from "./errors";
import { DEVICE_MODALITY_ATTRIBUTE } from "./kinds";
import { mintStudyInstanceUid } from "./uid";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18b T1 — **THE MODALITY WORKLIST, AS A PULL.**
 *
 * ═══ D1 — A ROUTE THE BRIDGE PULLS, NOT A FILE A CONSUMER WRITES ═══
 *
 * Orthanc's worklist plugin reads DICOM `.wl` files from a directory on ITS host. That host does
 * not exist until the owner rules on R1, and a worker consumer that wrote files into a volume
 * would need the volume, a shared mount, and an edit to `worker.module.ts` — a hub file — for a
 * machine that has not been bought. So the export is a GET: the day's schedulable studies for the
 * devices that carry an AE title, in JSON for a screen and in dcmtk `dump2dcm` text for the bridge
 * (`curl … | dump2dcm`, runbook). A re-pull is idempotent because the UID is minted from the study
 * (D3) and everything else is read from the row.
 *
 * ═══ D2 — A FORM F STUDY IS OFFERED ONLY TO A REGISTERED MACHINE ═══
 *
 * `recordAcquired` refuses a PCPNDT-applicable scan on a device that is not on an active §19
 * registration (`assertMachineRegistered`). A worklist that offered the same scan to that device
 * would be the statute's refusal arriving AFTER the images exist. The row is withheld here, with
 * the same reader, and the response COUNTS what it withheld so an empty worklist is never silent.
 *
 * ═══ D4 — THE WORKLIST CARRIES THE ADMINISTRATIVE MARKERS AND THE ALIAS ═══
 *
 * `(0010,0040)` is `administrative_gender`, never `patients.sex`: the tag is administrative, and
 * `sex` is the clinical marker 18a reads to decide whether the Act applies — it stays inside. The
 * name is `displayName`'s answer for THIS reader, so a confidential patient's alias is what the
 * console shows, exactly as the department's own worklist does. One PHI row per patient per pull
 * (F42); a bridge that pulls every five seconds writes a bounded, pruned log and that is the price
 * of an answerable one.
 */

export const MWL_READ = "radiology.mwl.read";
export const DEVICE_AE_TITLE_ATTRIBUTE = "aeTitle";
/** The statuses a modality may still start. `in_acquisition` is already on the console. */
export const MWL_STATUSES = ["scheduled", "checked_in", "ready"] as const;

/** PS3.3 C.7.3.1.1.1 — the modality codes the five house modalities map to. */
export const DICOM_MODALITY: Readonly<Record<string, string>> = {
  xray: "DX", usg: "US", ct: "CT", mri: "MR", mammography: "MG",
};

/**
 * The hospital clock, DERIVED from the kernel's one export and never a twelfth literal copy —
 * `test/ist-clock-parity.test.ts` pins the census of copies (09a close, ledger §2.105), and this
 * file moved it before it was told (18b close, F9).
 */
const IST_OFFSET_MS = IST_UTC_OFFSET_MINUTES * 60_000;

/**
 * PS3.5 AE — 1–16 characters of the default repertoire, no backslash, no control characters, not
 * only spaces. `]` is excluded too (pass 2 A2): the dump's value closer, which `v()` would rewrite
 * to a space, so JSON and dump would name two different titles.
 */
export const AE_TITLE_RE = /^(?=.*[^ ])[\x20-\x5b\x5e-\x7e]{1,16}$/;

export type MwlRow = {
  studyId: string;
  patientId: string;
  accessionNo: string;
  studyInstanceUid: string;
  status: string;
  priority: "STAT" | "HIGH" | "ROUTINE";
  patient: { uhid: string; personName: string; birthDate: string | null; sex: "M" | "F" | "O" };
  /** An id, not a name: `(0008,0090)` is left EMPTY on the dump (close review A4). */
  orderingClinicianId: string | null;
  procedureCode: string;
  modality: string;
  deviceResourceId: string;
  aeTitle: string;
  scheduledDate: string;
  scheduledTime: string;
};

export type MwlExport = {
  date: string;
  rows: MwlRow[];
  /** Form F studies not offered because the device is on no active §19 registration (D2). */
  withheld: number;
  /** Devices whose `aeTitle` is not a legal AE title; their studies are absent, and this says why. */
  malformedAeTitle: string[];
};

/** The IST calendar day `date` as a half-open UTC window. */
export function istDayWindow(date: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const midnightUtc = m === null ? NaN : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Close review A5 — `Date.UTC(2026, 1, 30)` rolls over to 2 March in silence; refuse the day that is not one.
  if (m === null || new Date(midnightUtc).toISOString().slice(0, 10) !== date) {
    throw new RadiologyError("invalid_date", `not a calendar day: ${date}`, { date });
  }
  const start = new Date(midnightUtc - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/**
 * PS3.5 PN — `family^given`. Indian names carry no reliable family token, so the LAST token is the
 * family component and the rest are given, which is what every Indian RIS in the field does and
 * what a console will search on. Control characters and the PN delimiters are stripped.
 */
export function toPersonName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f^=\\]/g, " ").trim();
  const tokens = clean.split(/\s+/).filter((t) => t.length > 0);
  // PS3.5 PN — each component ≤ 64; a longer one is truncated rather than refused (close review A2).
  const cap = (s: string) => s.slice(0, 64);
  if (tokens.length <= 1) return cap(tokens[0] ?? "");
  const family = tokens[tokens.length - 1]!;
  return `${cap(family)}^${cap(tokens.slice(0, -1).join(" "))}`;
}

function dicomSex(administrativeGender: string): "M" | "F" | "O" {
  if (administrativeGender === "male") return "M";
  if (administrativeGender === "female") return "F";
  return "O";
}

/** A DATE column (DOB): the calendar day as stored, no zone. */
function dicomDate(d: Date): string { return d.toISOString().slice(0, 10).replace(/-/g, ""); }
/**
 * ═══ CLOSE REVIEW A1 (CRITICAL) — THE SPS DATE AND TIME ARE THE SAME CLOCK ═══
 * The first version rendered the date in UTC and the time in IST, so a 01:30 IST slot went out
 * as yesterday's date with today's time and a modality filtering its C-FIND by today's date never
 * saw it — 18a F52's window, on the export that exists for the night CT. Both are IST now, and the
 * test pins the 01:30 slot by DATE.
 */
function dicomDateIst(d: Date): string { return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, ""); }
function dicomTimeIst(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(11, 19).replace(/:/g, "");
}

function priorityOf(p: string): MwlRow["priority"] {
  if (p === "stat") return "STAT";
  if (p === "urgent") return "HIGH";
  return "ROUTINE";
}

export async function mwlExport(
  db: Db,
  actor: Actor,
  opts: { date: string; deviceResourceId?: string },
): Promise<MwlExport> {
  if (actor.type !== "user") {
    throw new RadiologyError("forbidden", `a ${actor.type} actor may not pull the modality worklist`);
  }
  if (!(await hasPermission(db, actor.id, MWL_READ, "hospital"))) {
    throw new RadiologyError("forbidden", `${actor.id} does not hold ${MWL_READ}`);
  }
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
  const { start, end } = istDayWindow(opts.date);

  const rows = await db
    .select({
      studyId: imagingStudies.id, accessionNo: imagingStudies.accessionNo,
      status: imagingStudies.status, priority: imagingStudies.priority,
      studyTypeCode: imagingStudies.studyTypeCode, scheduledAt: imagingStudies.scheduledAt,
      deviceResourceId: imagingStudies.deviceResourceId, formFRequired: imagingStudies.formFRequired,
      patientId: imagingStudies.patientId,
      orderingClinicianId: orders.orderingClinicianId,
      uhid: patients.uhid, name: patients.name, alias: patients.alias,
      isConfidential: patients.isConfidential, dob: patients.dob,
      administrativeGender: patients.administrativeGender,
      attributes: resources.attributes,
    })
    .from(imagingStudies)
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .innerJoin(resources, eq(resources.id, imagingStudies.deviceResourceId))
    .where(and(
      inArray(imagingStudies.status, [...MWL_STATUSES]),
      gte(imagingStudies.scheduledAt, start),
      lt(imagingStudies.scheduledAt, end),
      ...(opts.deviceResourceId === undefined ? [] : [eq(imagingStudies.deviceResourceId, opts.deviceResourceId)]),
    ))
    .orderBy(asc(imagingStudies.scheduledAt), asc(imagingStudies.accessionNo));

  /**
   * PLAN 18c T1 — the active study-type book, read ONCE for the whole export rather than per row.
   * A worklist is a hot path a bridge pulls every few seconds; a definition read per study would
   * make the export's cost linear in the day's list for a fact that cannot change inside one pull.
   */
  const types = new Map((await activeStudyTypes(db)).map((t) => [t.code, t]));

  const out: MwlRow[] = [];
  let withheld = 0;
  const malformed = new Set<string>();
  for (const r of rows) {
    const aeTitle = r.attributes[DEVICE_AE_TITLE_ATTRIBUTE];
    if (typeof aeTitle !== "string" || aeTitle.length === 0) continue; // not a DICOM device: not an error
    // Close review A2 — a 17-character or backslashed AE title matches no console; say so, never export it.
    if (!AE_TITLE_RE.test(aeTitle)) { malformed.add(r.deviceResourceId!); continue; }
    // D2 — the same reader acquisition uses, before the row is offered.
    if (r.formFRequired && (await activeRegistrationFor(db, r.deviceResourceId!, opts.date)) === null) {
      withheld += 1;
      continue;
    }
    /**
     * PLAN 18c T1 / D3 — and the same argument for the other statute. Offering an ionising study to
     * an unlicensed console is the AERB refusal arriving after the images exist. Withheld, counted
     * in the same number, and for the same reason it is a COUNT rather than a silence: an empty
     * worklist that says nothing sends a radiographer to look for a network fault.
     *
     * ═══ THE FACT COMES FROM THE STUDY TYPE, NOT FROM `imaging_studies.ionising` (F2) ═══
     *
     * The obvious read is the study's own column, and it is WRONG HERE: 18a's F18 writes that
     * column at `recordAcquired`, so on a SCHEDULED study — which is every row a worklist carries —
     * it still holds its `false` default. A gate keyed on it therefore never fires, and the export
     * offers the unlicensed CT anyway. It is the study TYPE that knows whether an examination emits,
     * which is the source `startAcquisition` reads for the same decision.
     *
     * Not the device's modality either: a device list would have to be maintained in two places and
     * would refuse the wrong machine the day somebody adds one.
     */
    const ionising = types.get(r.studyTypeCode)?.ionising === true;
    if (ionising && (await activeLicenceFor(db, r.deviceResourceId!, opts.date)) === null) {
      withheld += 1;
      continue;
    }
    const modalityAttr = r.attributes[DEVICE_MODALITY_ATTRIBUTE];
    out.push({
      studyId: r.studyId, patientId: r.patientId, accessionNo: r.accessionNo,
      studyInstanceUid: mintStudyInstanceUid(r.studyId),
      status: r.status, priority: priorityOf(r.priority),
      patient: {
        uhid: r.uhid,
        personName: toPersonName(displayName(
          { name: r.name, alias: r.alias, isConfidential: r.isConfidential }, canSeeConfidential,
        )),
        birthDate: r.dob === null ? null : dicomDate(r.dob),
        sex: dicomSex(r.administrativeGender),
      },
      orderingClinicianId: r.orderingClinicianId,
      procedureCode: r.studyTypeCode.slice(0, 64),
      modality: typeof modalityAttr === "string" ? (DICOM_MODALITY[modalityAttr] ?? "OT") : "OT",
      deviceResourceId: r.deviceResourceId!, aeTitle,
      scheduledDate: dicomDateIst(r.scheduledAt!), scheduledTime: dicomTimeIst(r.scheduledAt!),
    });
  }

  const scope = opts.deviceResourceId === undefined ? "" : ` device ${opts.deviceResourceId}`;
  // Close review A3 — one row per patient DISCLOSED: a withheld or AE-less study left the process as nothing.
  const reason = `modality worklist ${opts.date}${scope}, ${String(out.length)} rows`;
  for (const patientId of new Set(out.map((r) => r.patientId))) {
    await recordPhiAccess(db, { actor, patientId, surface: "imaging.worklist", reason });
  }
  return { date: opts.date, rows: out, withheld, malformedAeTitle: [...malformed] };
}

/**
 * One worklist item in dcmtk's dump syntax — the text `dump2dcm` turns into a `.wl` file. The
 * Scheduled Procedure Step sequence has exactly one item; the identifiers are the accession so a
 * DICOM study coming back from the modality carries the join key on its face.
 */
/** Pass 2 A2 — the dump is what the bridge pulls, so the dump names the malformed devices too. */
export function renderMwlDumpHeader(out: MwlExport): string {
  return `# HMIS modality worklist ${out.date} — ${String(out.rows.length)} items, ${String(out.withheld)} withheld`
    + (out.malformedAeTitle.length === 0 ? "" : `, malformed AE title on device(s): ${out.malformedAeTitle.join(",")}`)
    + "\n";
}

export function renderMwlDump(row: MwlRow): string {
  // dump2dcm: `\` separates values and `]` closes one; neither may ride inside a value (close review A2).
  const v = (s: string | null): string => `[${(s ?? "").replace(/[\u0000-\u001f\\\]]/g, " ")}]`;
  return [
    "# Dicom-File-Format",
    `# HMIS modality worklist item — study ${row.studyId}`,
    "(0008,0005) CS [ISO_IR 192]",
    `(0008,0050) SH ${v(row.accessionNo)}`,
    "(0008,0090) PN []",
    `(0010,0010) PN ${v(row.patient.personName)}`,
    `(0010,0020) LO ${v(row.patient.uhid)}`,
    `(0010,0030) DA ${v(row.patient.birthDate)}`,
    `(0010,0040) CS ${v(row.patient.sex)}`,
    `(0020,000d) UI ${v(row.studyInstanceUid)}`,
    `(0032,1060) LO ${v(row.procedureCode)}`,
    `(0040,1001) SH ${v(row.accessionNo)}`,
    `(0040,1003) CS ${v(row.priority)}`,
    "(0040,0100) SQ (Sequence with explicit length #=1)",
    "  (fffe,e000) na (Item with explicit length #=6)",
    `    (0008,0060) CS ${v(row.modality)}`,
    `    (0040,0001) AE ${v(row.aeTitle)}`,
    `    (0040,0002) DA ${v(row.scheduledDate)}`,
    `    (0040,0003) TM ${v(row.scheduledTime)}`,
    `    (0040,0007) LO ${v(row.procedureCode)}`,
    `    (0040,0009) SH ${v(row.accessionNo)}`,
    "  (fffe,e00d) na (ItemDelimitationItem)",
    "(fffe,e0dd) na (SequenceDelimitationItem)",
    "",
  ].join("\n");
}
