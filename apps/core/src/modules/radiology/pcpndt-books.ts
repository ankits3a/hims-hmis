import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { istDayString } from "../../kernel/approvals/cumulative";
import { users } from "../../kernel/db/schema/auth";
import {
  pcpndtFormF, pcpndtFormFSerials, pcpndtRegisteredMachines, pcpndtRegistrations,
} from "../../kernel/db/schema/pcpndt";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { resources } from "../../kernel/db/schema/resources";
import { formFMissingFields } from "../pcpndt";
import { imagingDevices } from "./devices";
import { RadiologyError } from "./errors";
import type { FormFField } from "../pcpndt";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS7 T4 — **THE TWO BOOKS THE ACT KEEPS: the Form F register by serial, and the monthly
 * return to the Appropriate Authority.** Both are READ MODELS over rows that already exist
 * (`pcpndt_form_f`, `pcpndt_form_f_serials`, `imaging_studies`); neither writes anything.
 *
 * ═══ NO PATIENT IN EITHER BOOK ═══
 *
 * `pcpndt/manifest.ts`: *"a list of Form F rows is a list of pregnant women by name, and the one
 * thing this register must not become is a searchable surface."* So the register lists SERIALS —
 * machine, number, date, indication, state, who signed, what is missing — and the accession of the
 * study, never a name, a UHID or an age. The name is one click away through `formFForStudy`, which
 * holds its own permission and writes a PHI row per read. DECIDED (RS7): the board's register shows
 * the patient's name in the list; this one does not, because the module's written rule is the law's
 * and the board's column is a convenience. The monthly return is counts.
 *
 * ═══ THE STATES A SERIAL CAN BE IN ═══
 *
 * `open` (minted, nobody signed), `recorded` (the sonologist's declaration signed), `verified` (the
 * in-charge counter-signed), and `cancelled` — which is not a stored status: an OPEN form whose
 * study was cancelled or marked no-show. The serial is never given back (`form-f.ts`: minted at open,
 * irreversible); the book shows it, marked, which is what an inspector counting serials needs.
 */

export type FormFBookState = "open" | "recorded" | "verified" | "cancelled";

export type RegisterRow = {
  formFId: string;
  serial: string;
  serialNo: number;
  serialYear: number;
  deviceResourceId: string;
  deviceCode: string | null;
  openedAt: string;
  state: FormFBookState;
  studyId: string;
  accessionNo: string | null;
  studyStatus: string | null;
  indicationCode: string;
  gestationWeeks: number | null;
  signedByName: string | null;
  verifiedByName: string | null;
  missing: FormFField[];
};

export type SerialBook = {
  deviceResourceId: string;
  deviceCode: string | null;
  year: number;
  /** The highest serial the counter has handed out this year (0 when none). */
  minted: number;
  /** Serials 1..minted with no row. The counter never skips, so any entry here is a finding. */
  gaps: number[];
};

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const IST_OFFSET = "+05:30";

/** The IST month as [start, end) instants, and the month named when none is given (today's, IST). */
export function istMonthWindow(month: string | undefined, now: Date): { month: string; start: Date; end: Date; year: number } {
  const m = month ?? istDayString(now).slice(0, 7);
  const hit = MONTH_RE.exec(m);
  if (!hit) throw new RadiologyError("invalid_date", `month must be YYYY-MM, got "${m}"`);
  const year = Number(hit[1]);
  const mon = Number(hit[2]);
  const next = mon === 12 ? `${String(year + 1)}-01` : `${String(year)}-${String(mon + 1).padStart(2, "0")}`;
  return {
    month: m, year,
    start: new Date(`${m}-01T00:00:00${IST_OFFSET}`),
    end: new Date(`${next}-01T00:00:00${IST_OFFSET}`),
  };
}

export const serialLabel = (code: string | null, year: number, no: number): string =>
  `${code ?? "?"}/${String(year)}/${String(no).padStart(4, "0")}`;

function stateOf(status: string, verifiedAt: Date | null, studyStatus: string | null): FormFBookState {
  if (status === "recorded") return verifiedAt === null ? "recorded" : "verified";
  return studyStatus === "cancelled" || studyStatus === "no_show" ? "cancelled" : "open";
}

const signer = alias(users, "signer");
const verifier = alias(users, "verifier");

/** Every serial opened in the IST month, newest first, and the gap check for the month's year. */
export async function formFRegister(
  db: Db, input: { month?: string; now?: Date },
): Promise<{ month: string; rows: RegisterRow[]; serials: SerialBook[] }> {
  const now = input.now ?? new Date();
  const w = istMonthWindow(input.month, now);
  const rows = await db.select({
    f: pcpndtFormF,
    deviceCode: resources.code,
    accessionNo: imagingStudies.accessionNo,
    studyStatus: imagingStudies.status,
    signedByName: signer.fullName,
    verifiedByName: verifier.fullName,
  })
    .from(pcpndtFormF)
    .leftJoin(resources, eq(resources.id, pcpndtFormF.deviceResourceId))
    .leftJoin(imagingStudies, eq(imagingStudies.id, pcpndtFormF.studyId))
    .leftJoin(signer, eq(signer.id, pcpndtFormF.signedBy))
    .leftJoin(verifier, eq(verifier.id, pcpndtFormF.verifiedBy))
    .where(and(gte(pcpndtFormF.createdAt, w.start), lt(pcpndtFormF.createdAt, w.end)))
    .orderBy(sql`${pcpndtFormF.createdAt} desc`, sql`${pcpndtFormF.serialNo} desc`);

  return {
    month: w.month,
    rows: rows.map((r) => ({
      formFId: r.f.id,
      serial: serialLabel(r.deviceCode, r.f.serialYear, r.f.serialNo),
      serialNo: r.f.serialNo,
      serialYear: r.f.serialYear,
      deviceResourceId: r.f.deviceResourceId,
      deviceCode: r.deviceCode,
      openedAt: r.f.createdAt.toISOString(),
      state: stateOf(r.f.status, r.f.verifiedAt, r.studyStatus),
      studyId: r.f.studyId,
      accessionNo: r.accessionNo,
      studyStatus: r.studyStatus,
      indicationCode: r.f.indicationCode,
      gestationWeeks: r.f.gestationWeeks,
      signedByName: r.signedByName,
      verifiedByName: r.verifiedByName,
      missing: formFMissingFields(r.f),
    })),
    serials: await serialBooks(db, w.year),
  };
}

/** Per machine, the year's counter against the rows it produced. */
export async function serialBooks(db: Db, year: number): Promise<SerialBook[]> {
  const counters = await db.select({
    deviceResourceId: pcpndtFormFSerials.deviceResourceId,
    nextNo: pcpndtFormFSerials.nextNo,
    deviceCode: resources.code,
  })
    .from(pcpndtFormFSerials)
    .leftJoin(resources, eq(resources.id, pcpndtFormFSerials.deviceResourceId))
    .where(eq(pcpndtFormFSerials.year, year))
    .orderBy(resources.code);
  const out: SerialBook[] = [];
  for (const c of counters) {
    const minted = c.nextNo - 1;
    const present = new Set((await db.select({ n: pcpndtFormF.serialNo }).from(pcpndtFormF)
      .where(and(eq(pcpndtFormF.deviceResourceId, c.deviceResourceId), eq(pcpndtFormF.serialYear, year))))
      .map((r) => r.n));
    const gaps: number[] = [];
    for (let n = 1; n <= minted; n += 1) if (!present.has(n)) gaps.push(n);
    out.push({ deviceResourceId: c.deviceResourceId, deviceCode: c.deviceCode, year, minted, gaps });
  }
  return out;
}

/* ═════════════════════════ the monthly return ═════════════════════════ */

export type ReturnMachine = {
  deviceResourceId: string;
  code: string;
  name: string;
  registrationNo: string | null;
  /** Every ultrasound acquired on this machine in the month. */
  scans: number;
  /** Those the Act covers (`form_f_required`) — each needs a recorded Form F. */
  pcpndtScans: number;
  formF: { opened: number; recorded: number; verified: number; open: number; cancelled: number };
  /** PCPNDT scans acquired in the month whose Form F is not recorded. Must be 0. */
  short: number;
};

export type DiscrepancyKind =
  | "scan_without_recorded_form" | "recorded_not_verified" | "open_not_scanned" | "incomplete_form" | "serial_gap";

export type Discrepancy = {
  kind: DiscrepancyKind;
  deviceCode: string | null;
  serial: string | null;
  accessionNo: string | null;
  studyId: string | null;
  missing?: FormFField[];
};

export type MonthlyReturn = {
  month: string;
  /** The 5th of the following month (PCPNDT Rules r.9(8)). */
  dueBy: string;
  today: string;
  daysLeft: number;
  machines: ReturnMachine[];
  totals: Omit<ReturnMachine, "deviceResourceId" | "code" | "name" | "registrationNo">;
  discrepancies: Discrepancy[];
  /** The return as CSV text, for the nodal officer to copy into the state portal's upload. */
  csv: string;
};

function dueByOf(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${String(y + 1)}-01-05` : `${String(y)}-${String(m + 1).padStart(2, "0")}-05`;
}

const csvCell = (v: string | number | null): string => {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function monthlyReturn(db: Db, input: { month?: string; now?: Date }): Promise<MonthlyReturn> {
  const now = input.now ?? new Date();
  const w = istMonthWindow(input.month, now);
  const today = istDayString(now);
  const dueBy = dueByOf(w.month);
  const daysLeft = Math.round((Date.parse(`${dueBy}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

  const usg = (await imagingDevices(db, today, { includeRetired: true })).filter((d) => d.modality === "usg");

  const scans = await db.select({
    studyId: imagingStudies.id,
    accessionNo: imagingStudies.accessionNo,
    deviceResourceId: imagingStudies.deviceResourceId,
    formFRequired: imagingStudies.formFRequired,
    formStatus: pcpndtFormF.status,
    serialNo: pcpndtFormF.serialNo,
    serialYear: pcpndtFormF.serialYear,
  })
    .from(imagingStudies)
    .leftJoin(pcpndtFormF, eq(pcpndtFormF.studyId, imagingStudies.id))
    .where(and(
      gte(imagingStudies.acquiredAt, w.start), lt(imagingStudies.acquiredAt, w.end),
      usg.length === 0 ? sql`false` : inArray(imagingStudies.deviceResourceId, usg.map((d) => d.id)),
    ));

  const register = await formFRegister(db, { month: w.month, now });

  const regs = await db.select({
    deviceResourceId: pcpndtRegisteredMachines.deviceResourceId,
    registrationNo: pcpndtRegistrations.registrationNo,
    active: pcpndtRegisteredMachines.active,
  })
    .from(pcpndtRegisteredMachines)
    .innerJoin(pcpndtRegistrations, eq(pcpndtRegistrations.id, pcpndtRegisteredMachines.registrationId));

  const machines: ReturnMachine[] = usg
    .filter((d) => d.status !== "retired" || scans.some((s) => s.deviceResourceId === d.id)
      || register.rows.some((r) => r.deviceResourceId === d.id))
    .map((d) => {
      const mine = scans.filter((s) => s.deviceResourceId === d.id);
      const forms = register.rows.filter((r) => r.deviceResourceId === d.id);
      const reg = regs.find((r) => r.deviceResourceId === d.id && r.active) ?? regs.find((r) => r.deviceResourceId === d.id);
      return {
        deviceResourceId: d.id, code: d.code, name: d.name, registrationNo: reg?.registrationNo ?? null,
        scans: mine.length,
        pcpndtScans: mine.filter((s) => s.formFRequired).length,
        formF: {
          opened: forms.length,
          recorded: forms.filter((f) => f.state === "recorded" || f.state === "verified").length,
          verified: forms.filter((f) => f.state === "verified").length,
          open: forms.filter((f) => f.state === "open").length,
          cancelled: forms.filter((f) => f.state === "cancelled").length,
        },
        short: mine.filter((s) => s.formFRequired && s.formStatus !== "recorded").length,
      };
    });

  const codeOf = (id: string | null): string | null => usg.find((d) => d.id === id)?.code ?? null;
  const discrepancies: Discrepancy[] = [];
  for (const s of scans) {
    if (s.formFRequired && s.formStatus !== "recorded") {
      discrepancies.push({
        kind: "scan_without_recorded_form", deviceCode: codeOf(s.deviceResourceId),
        serial: s.serialNo === null || s.serialYear === null ? null : serialLabel(codeOf(s.deviceResourceId), s.serialYear, s.serialNo),
        accessionNo: s.accessionNo, studyId: s.studyId,
      });
    }
  }
  for (const r of register.rows) {
    const base = { deviceCode: r.deviceCode, serial: r.serial, accessionNo: r.accessionNo, studyId: r.studyId };
    if (r.state === "recorded") discrepancies.push({ kind: "recorded_not_verified", ...base });
    if (r.state === "open" && r.studyStatus !== "acquired" && r.studyStatus !== "reported" && r.studyStatus !== "published") {
      discrepancies.push({ kind: "open_not_scanned", ...base });
    }
    const missing = r.missing.filter((m) => m !== "sonologist_declaration");
    if ((r.state === "recorded" || r.state === "verified") && missing.length > 0) {
      discrepancies.push({ kind: "incomplete_form", ...base, missing });
    }
  }
  for (const book of register.serials) {
    for (const n of book.gaps) {
      discrepancies.push({
        kind: "serial_gap", deviceCode: book.deviceCode, serial: serialLabel(book.deviceCode, book.year, n),
        accessionNo: null, studyId: null,
      });
    }
  }

  const sum = (f: (m: ReturnMachine) => number): number => machines.reduce((a, m) => a + f(m), 0);
  const totals = {
    scans: sum((m) => m.scans), pcpndtScans: sum((m) => m.pcpndtScans), short: sum((m) => m.short),
    formF: {
      opened: sum((m) => m.formF.opened), recorded: sum((m) => m.formF.recorded), verified: sum((m) => m.formF.verified),
      open: sum((m) => m.formF.open), cancelled: sum((m) => m.formF.cancelled),
    },
  };

  const header = [
    "month", "machine", "registration_no", "ultrasound_scans", "pcpndt_scans", "form_f_opened",
    "form_f_recorded", "form_f_verified", "form_f_open", "form_f_cancelled", "scans_without_recorded_form",
  ];
  const line = (label: string, reg: string | null, m: typeof totals) => [
    w.month, label, reg, m.scans, m.pcpndtScans, m.formF.opened, m.formF.recorded, m.formF.verified,
    m.formF.open, m.formF.cancelled, m.short,
  ].map(csvCell).join(",");
  const csv = [
    header.join(","),
    ...machines.map((m) => line(m.code, m.registrationNo, m)),
    line("TOTAL", null, totals),
  ].join("\n");

  return { month: w.month, dueBy, today, daysLeft, machines, totals, discrepancies, csv };
}
