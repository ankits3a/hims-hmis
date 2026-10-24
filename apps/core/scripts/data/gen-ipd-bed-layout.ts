import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BED_LAYOUT_COLUMNS } from "../../src/modules/ipd";
import type { BedLayoutColumn } from "../../src/modules/ipd";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/data/gen-ipd-bed-layout.ts` — writes
 * `scripts/data/ipd-bed-layout.planning.csv`.
 *
 * PLANNING LAYOUT from the confirmed bed split; the hospital's real room list replaces it.
 *
 * Owner 2026-10-12 confirmed split: general and specialty wards ~720; critical care ~240; NICU/SNCU ~50;
 * labour LDR ~20; day care ~60; emergency ~60 — 1,150 beds (the rest of the 1,200 capacity is dialysis
 * stations and theatres, which are not beds). The breakdown below is DECIDED (E0.3, issue #715):
 *
 *   wards 720 = general 432 (male and female halls per specialty, bays of 6; OBG female only; paediatrics
 *               one hall, gender "paediatric") + semi_private 144 (twin rooms, "any", 24 per floor F03–F08)
 *               + private 108 (single rooms, floor F09) + deluxe 24 and suite 12 (floor F10);
 *   critical care 240 = MICU 40, SICU 30, CCU 30, CTVS_ICU 24, NEURO_ICU 24, ONCO_ICU 16, BURNS 10 (class
 *               icu), PICU 20 (class picu), HDU 46 (class hdu); each adult ICU except burns has two
 *               single airborne-isolation rooms with negative pressure; burns beds are contact isolation;
 *   NICU 40 + SNCU 10 (class nicu); LDR 20 single rooms (class ldr, female); day care 60 (class daycare);
 *   emergency 60 (class emergency).
 *
 * Floors: F00 ground = emergency + day care; F01 = adult ICUs and HDU; F02 = NICU, SNCU, LDR, PICU;
 * F03–F08 specialty wards; F09 private; F10 deluxe and suites. Codes read off a door: floor `F05`, ward
 * `F05-ORT-M`, room `F05-ORT-M-BAY2`, bed `F05-ORT-M-B12`.
 *
 * Deterministic: no clock, no randomness. `test/ipd-bed-layout-planning.test.ts` regenerates it and
 * compares it to the committed file byte for byte.
 */

type Row = Record<BedLayoutColumn, string>;

const ICU_EQUIPMENT = "monitor;ventilator_ready;oxygen_point;suction;infusion_pumps";
const HDU_EQUIPMENT = "monitor;oxygen_point;suction;infusion_pumps";
const WARD_EQUIPMENT = "oxygen_point";

const FLOOR_NAMES: Record<string, string> = {
  F00: "Ground floor", F01: "First floor", F02: "Second floor", F03: "Third floor", F04: "Fourth floor",
  F05: "Fifth floor", F06: "Sixth floor", F07: "Seventh floor", F08: "Eighth floor", F09: "Ninth floor",
  F10: "Tenth floor",
};

type Ward = {
  floor: string; code: string; name: string; kind: "ward" | "hall"; department: string; unitType: string;
};

type BedSpec = {
  cls: string; gender: string; isolation?: string; negativePressure?: boolean; icu?: boolean;
  equipment?: string; daycare?: boolean;
};

const rows: Row[] = [];

function yn(b: boolean | undefined): string {
  return b === true ? "yes" : "no";
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** One ward's beds: `rooms` is a list of [room suffix, room name, beds in it, bed spec]. */
function addWard(w: Ward, rooms: [string, string, number, BedSpec][]): void {
  const total = rooms.reduce((s, r) => s + r[2], 0);
  const width = total > 99 ? 3 : 2;
  let n = 0;
  const wardCode = `${w.floor}-${w.code}`;
  for (const [suffix, roomName, beds, spec] of rooms) {
    for (let i = 0; i < beds; i += 1) {
      n += 1;
      rows.push({
        floor_code: w.floor, floor_name: FLOOR_NAMES[w.floor]!, ward_code: wardCode, ward_name: w.name, ward_kind: w.kind,
        department: w.department, unit_type: w.unitType, room_code: `${wardCode}-${suffix}`, room_name: roomName,
        bed_code: `${wardCode}-B${pad(n, width)}`, bed_class: spec.cls, gender_rule: spec.gender,
        isolation: spec.isolation ?? "none", negative_pressure: yn(spec.negativePressure), icu: yn(spec.icu),
        equipment: spec.equipment ?? "", daycare: yn(spec.daycare), overflow: "no",
      });
    }
  }
}

/** `count` beds in bays of `size` (the last bay takes the remainder). */
function bays(count: number, size: number, spec: BedSpec, label = "Bay"): [string, string, number, BedSpec][] {
  const out: [string, string, number, BedSpec][] = [];
  for (let b = 1, left = count; left > 0; b += 1, left -= size) {
    out.push([`BAY${String(b)}`, `${label} ${String(b)}`, Math.min(size, left), spec]);
  }
  return out;
}

/** `count` rooms of `perRoom` beds each, numbered R01… */
function roomsOf(count: number, perRoom: number, spec: BedSpec, label: string): [string, string, number, BedSpec][] {
  const width = count > 99 ? 3 : 2;
  return Array.from({ length: count }, (_, i) => [`R${pad(i + 1, width)}`, `${label} ${pad(i + 1, width)}`, perRoom, spec]);
}

// ── F00 — emergency and day care ──────────────────────────────────────────────────────────────
addWard({ floor: "F00", code: "ER", name: "Emergency", kind: "hall", department: "CAS", unitType: "ER" },
  bays(60, 10, { cls: "emergency", gender: "any", equipment: "monitor;oxygen_point;suction" }));
addWard({ floor: "F00", code: "DC", name: "Day care", kind: "hall", department: "MULTI", unitType: "DAYCARE" },
  bays(60, 10, { cls: "daycare", gender: "any", daycare: true, equipment: WARD_EQUIPMENT }));

// ── F01 — adult critical care ─────────────────────────────────────────────────────────────────
const ADULT_ICUS: [string, string, string, number][] = [
  ["MICU", "Medical ICU", "MED", 40], ["SICU", "Surgical ICU", "SUR", 30], ["CCU", "Coronary care unit", "CARD", 30],
  ["CTVS_ICU", "Cardiothoracic ICU", "CTVS", 24], ["NEURO_ICU", "Neuro ICU", "NEURO", 24], ["ONCO_ICU", "Oncology ICU", "ONCO", 16],
];
const ICU_BED: BedSpec = { cls: "icu", gender: "any", icu: true, equipment: ICU_EQUIPMENT };
for (const [unit, name, dept, count] of ADULT_ICUS) {
  const iso: BedSpec = { ...ICU_BED, isolation: "airborne", negativePressure: true };
  addWard({ floor: "F01", code: unit.replace("_ICU", "ICU"), name, kind: "ward", department: dept, unitType: unit }, [
    ["ISO1", "Isolation room 1", 1, iso], ["ISO2", "Isolation room 2", 1, iso], ...bays(count - 2, 10, ICU_BED),
  ]);
}
addWard({ floor: "F01", code: "BURNS", name: "Burns unit", kind: "ward", department: "PLAS", unitType: "BURNS" },
  roomsOf(10, 1, { ...ICU_BED, isolation: "contact" }, "Burns cubicle"));
addWard({ floor: "F01", code: "HDU", name: "High dependency unit", kind: "ward", department: "MED", unitType: "HDU" },
  bays(46, 10, { cls: "hdu", gender: "any", equipment: HDU_EQUIPMENT }));

// ── F02 — newborn, labour and paediatric critical care ────────────────────────────────────────
const NEWBORN: BedSpec = { cls: "nicu", gender: "paediatric", icu: true, equipment: ICU_EQUIPMENT };
addWard({ floor: "F02", code: "NICU", name: "Neonatal ICU", kind: "ward", department: "PED", unitType: "NICU" }, bays(40, 10, NEWBORN));
addWard({ floor: "F02", code: "SNCU", name: "Sick newborn care unit", kind: "ward", department: "PED", unitType: "SNCU" }, bays(10, 10, NEWBORN));
addWard({ floor: "F02", code: "LDR", name: "Labour, delivery and recovery", kind: "ward", department: "OBG", unitType: "LDR" },
  roomsOf(20, 1, { cls: "ldr", gender: "female", equipment: "monitor;oxygen_point;suction" }, "LDR room"));
addWard({ floor: "F02", code: "PICU", name: "Paediatric ICU", kind: "ward", department: "PED", unitType: "PICU" },
  bays(20, 10, { cls: "picu", gender: "paediatric", icu: true, equipment: ICU_EQUIPMENT }));

// ── F03–F08 — specialty general halls, and a twin-sharing wing on each floor ──────────────────
type Specialty = { code: string; name: string; beds: number; halls: "mf" | "f" | "paed" };
const SPECIALTY_FLOORS: [string, Specialty[]][] = [
  ["F03", [{ code: "MED", name: "Medicine", beds: 60, halls: "mf" }, { code: "PULM", name: "Pulmonology", beds: 24, halls: "mf" }]],
  ["F04", [{ code: "SUR", name: "General surgery", beds: 48, halls: "mf" }, { code: "GAST", name: "Gastroenterology", beds: 24, halls: "mf" }]],
  ["F05", [
    { code: "ORT", name: "Orthopaedics", beds: 36, halls: "mf" }, { code: "NEURO", name: "Neurology and neurosurgery", beds: 24, halls: "mf" },
    { code: "ENT", name: "ENT", beds: 12, halls: "mf" },
  ]],
  ["F06", [{ code: "OBG", name: "Obstetrics and gynaecology", beds: 36, halls: "f" }, { code: "PED", name: "Paediatrics", beds: 30, halls: "paed" }]],
  ["F07", [
    { code: "CARD", name: "Cardiology", beds: 30, halls: "mf" }, { code: "NEPH", name: "Nephrology", beds: 24, halls: "mf" },
    { code: "URO", name: "Urology", beds: 24, halls: "mf" },
  ]],
  ["F08", [
    { code: "ONCO", name: "Oncology", beds: 24, halls: "mf" }, { code: "OPH", name: "Ophthalmology", beds: 12, halls: "mf" },
    { code: "PSY", name: "Psychiatry", beds: 24, halls: "mf" },
  ]],
];
const GENERAL = (gender: string): BedSpec => ({ cls: "general", gender, equipment: WARD_EQUIPMENT });
for (const [floor, specialties] of SPECIALTY_FLOORS) {
  for (const s of specialties) {
    const hall = (suffix: string, label: string, beds: number, gender: string): void => {
      addWard({ floor, code: `${s.code}${suffix}`, name: `${s.name} — ${label}`, kind: "hall", department: s.code, unitType: "WARD" },
        bays(beds, 6, GENERAL(gender)));
    };
    if (s.halls === "mf") { hall("-M", "male general ward", s.beds / 2, "male"); hall("-F", "female general ward", s.beds / 2, "female"); }
    if (s.halls === "f") hall("-F", "female general ward", s.beds, "female");
    if (s.halls === "paed") hall("", "children's general ward", s.beds, "paediatric");
  }
  addWard({ floor, code: "SPVT", name: "Twin-sharing rooms", kind: "ward", department: "MULTI", unitType: "WARD" },
    roomsOf(12, 2, { cls: "semi_private", gender: "any", equipment: WARD_EQUIPMENT }, "Twin room"));
}

// ── F09 — private rooms; F10 — deluxe rooms and suites ────────────────────────────────────────
addWard({ floor: "F09", code: "PVT", name: "Private rooms", kind: "ward", department: "MULTI", unitType: "WARD" },
  roomsOf(108, 1, { cls: "private", gender: "any", equipment: WARD_EQUIPMENT }, "Private room"));
addWard({ floor: "F10", code: "DLX", name: "Deluxe rooms", kind: "ward", department: "MULTI", unitType: "WARD" },
  roomsOf(24, 1, { cls: "deluxe", gender: "any", equipment: WARD_EQUIPMENT }, "Deluxe room"));
addWard({ floor: "F10", code: "STE", name: "Suites", kind: "ward", department: "MULTI", unitType: "WARD" },
  roomsOf(12, 1, { cls: "suite", gender: "any", equipment: WARD_EQUIPMENT }, "Suite"));

function csvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, "\"\"")}"` : v;
}

/** The planning workbook as CSV text, header first, one row per bed. */
export function planningBedLayoutCsv(): string {
  const lines = [BED_LAYOUT_COLUMNS.join(","), ...rows.map((r) => BED_LAYOUT_COLUMNS.map((c) => csvField(r[c])).join(","))];
  return `${lines.join("\n")}\n`;
}

export const PLANNING_BED_LAYOUT_FILE = "ipd-bed-layout.planning.csv";

if (require.main === module) {
  const out = join(__dirname, PLANNING_BED_LAYOUT_FILE);
  writeFileSync(out, planningBedLayoutCsv());
  console.log(`wrote ${out} — ${String(rows.length)} beds`);
}
