import { eq } from "drizzle-orm";
import { z } from "zod";
import { opdConfig } from "../../kernel/db/schema";
import { OpdError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

export const VITAL_KEYS = ["heightCm", "weightKg", "sbp", "dbp", "pulse", "rr", "spo2", "tempC"] as const;
export type VitalKey = (typeof VITAL_KEYS)[number];
export const BAND_KEYS = ["infant", "child_1_5", "child_6_12", "adult"] as const;
export type BandKey = (typeof BAND_KEYS)[number];

const rangeSchema = z.object({ min: z.number().optional(), max: z.number().optional() });
const bandSchema = z.object({
  key: z.enum(BAND_KEYS),
  upToAgeYears: z.number().int().positive().nullable(), // EXCLUSIVE upper bound in whole years; null = the adult tail
  required: z.array(z.enum(VITAL_KEYS)),
  ranges: z.object({ sbp: rangeSchema, dbp: rangeSchema, pulse: rangeSchema, rr: rangeSchema, spo2: rangeSchema, tempC: rangeSchema }).partial(),
});
export const dangerRangesSchema = z
  .object({ weightRequiredUnderYears: z.number().int().nonnegative(), bands: z.array(bandSchema).min(1) })
  .refine((v) => v.bands[v.bands.length - 1]!.upToAgeYears === null, { message: "the last band must be the adult tail (upToAgeYears: null)" })
  .refine((v) => v.bands.slice(0, -1).every((b, i, arr) => b.upToAgeYears !== null && (i === 0 || arr[i - 1]!.upToAgeYears! < b.upToAgeYears)), {
    message: "bands must be ascending by upToAgeYears with only the last one open",
  });
export type DangerRangesConfig = z.infer<typeof dangerRangesSchema>;
export type BandConfig = z.infer<typeof bandSchema>;

export const letterheadSchema = z.object({ name: z.string().min(1), addressLines: z.array(z.string()) });
export type Letterhead = z.infer<typeof letterheadSchema>;

export type OpdConfig = {
  slotMinutes: number;
  followUpDefaultDays: number;
  followUpExtensionDays: number[];
  extensionCapPerDoctorPerMonth: number;
  maxSkipsBeforeLeft: number;
  perkEveryNth: number | null;
  dangerRanges: DangerRangesConfig;
  letterhead: Letterhead;
};

/** India-standard first values (owner decision 2026-08-15: clinical staff revise at UAT — data, not code). */
export const DEFAULT_DANGER_RANGES: DangerRangesConfig = {
  weightRequiredUnderYears: 18, // §11.8: pediatric dose ranges use the vitals-desk weight
  bands: [
    { key: "infant", upToAgeYears: 1, required: ["weightKg", "tempC", "spo2", "pulse"],
      ranges: { sbp: { min: 65, max: 120 }, dbp: { min: 40, max: 80 }, pulse: { min: 90, max: 180 }, rr: { min: 25, max: 60 }, spo2: { min: 90 }, tempC: { min: 35.0, max: 38.5 } } },
    { key: "child_1_5", upToAgeYears: 6, required: ["heightCm", "weightKg", "tempC", "spo2", "pulse"],
      ranges: { sbp: { min: 75, max: 130 }, dbp: { min: 45, max: 85 }, pulse: { min: 70, max: 150 }, rr: { min: 20, max: 40 }, spo2: { min: 90 }, tempC: { min: 35.0, max: 39.5 } } },
    { key: "child_6_12", upToAgeYears: 13, required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"],
      ranges: { sbp: { min: 80, max: 140 }, dbp: { min: 50, max: 90 }, pulse: { min: 60, max: 130 }, rr: { min: 14, max: 30 }, spo2: { min: 90 }, tempC: { min: 35.0, max: 39.5 } } },
    { key: "adult", upToAgeYears: null, required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"],
      ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35.0, max: 39.5 } } },
  ],
};

/** Owner's sample letterhead (dev placeholder — hospital identity is owner-gated at go-live). */
export const DEFAULT_LETTERHEAD: Letterhead = {
  name: "CRK MEDICAL COLLEGE & HOSPITAL",
  addressLines: ["CHAURASIA CHOWK, HAJIPUR, BIHAR 844101"],
};

export const DEFAULT_FOLLOW_UP_EXTENSION_DAYS = [15, 21, 30]; // spec §11.1

/** Standard medical-college OPD list — dev placeholders, edited in the admin screen before go-live (owner decision). */
export const DEFAULT_DEPARTMENTS: { code: string; name: string }[] = [
  { code: "MED", name: "General Medicine" }, { code: "SUR", name: "General Surgery" }, { code: "PED", name: "Paediatrics" },
  { code: "OBG", name: "Obstetrics & Gynaecology" }, { code: "ORT", name: "Orthopaedics" }, { code: "ENT", name: "ENT" },
  { code: "OPH", name: "Ophthalmology" }, { code: "DER", name: "Dermatology" }, { code: "PSY", name: "Psychiatry" },
  { code: "CAR", name: "Cardiology" }, { code: "DEN", name: "Dental" }, { code: "PHY", name: "Physiotherapy" },
];

/** Role KEYS the opd_visit definition and its escalation ladder name (roles are Plan 02 data; the seed creates them, never assigns). */
export const OPD_ROLE_KEYS: { key: string; title: string }[] = [
  { key: "front_office", title: "Front Office (registration / OPD desk)" },
  { key: "front_office_supervisor", title: "Front-Office Supervisor" },
  { key: "vitals_desk", title: "Vitals-Desk Assistant" },
  { key: "nurse", title: "Nurse" },
  { key: "doctor", title: "Doctor (OPD consultant)" },
  { key: "opd_admin", title: "OPD Masters Administrator" },
  { key: "display", title: "Token Display Board" },
  { key: "duty_manager", title: "Duty Manager" },
  { key: "owner", title: "Owner" },
  { key: "medical_superintendent", title: "Medical Superintendent" },
];

const extensionDaysSchema = z.array(z.number().int().positive()).min(1);

export async function loadOpdConfig(db: Db | Tx): Promise<OpdConfig> {
  const rows = await db.select().from(opdConfig).where(eq(opdConfig.id, "main"));
  const row = rows[0];
  if (!row) throw new OpdError("opd_not_configured", "opd_config row 'main' is missing — run seed:opd");
  const ranges = dangerRangesSchema.safeParse(row.dangerRanges);
  if (!ranges.success) throw new OpdError("opd_config_invalid", "danger_ranges: " + ranges.error.issues.map((i) => i.message).join("; "));
  const letterhead = letterheadSchema.safeParse(row.letterhead);
  if (!letterhead.success) throw new OpdError("opd_config_invalid", "letterhead invalid");
  const ext = extensionDaysSchema.safeParse(row.followUpExtensionDays);
  if (!ext.success) throw new OpdError("opd_config_invalid", "follow_up_extension_days invalid");
  return {
    slotMinutes: row.slotMinutes,
    followUpDefaultDays: row.followUpDefaultDays,
    followUpExtensionDays: ext.data,
    extensionCapPerDoctorPerMonth: row.extensionCapPerDoctorPerMonth,
    maxSkipsBeforeLeft: row.maxSkipsBeforeLeft,
    perkEveryNth: row.perkEveryNth,
    dangerRanges: ranges.data,
    letterhead: letterhead.data,
  };
}
