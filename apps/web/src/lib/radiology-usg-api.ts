import { api } from "./api";

/**
 * PLAN 18-S RS7 — the Ultrasound & PCPNDT station's wire contract, transcribed from
 * `radiology-pcpndt.controller.ts` (the register by serial, the monthly return, the room's Form F
 * gate door) and `pcpndt.controller.ts` (`GET /pcpndt/registrations`, whose first web caller this is).
 * Like `radiology-api.ts`, this file DESCRIBES what those routes ship and decides nothing.
 */

export type FormFBookState = "open" | "recorded" | "verified" | "cancelled";
export type FormFField =
  | "living_children" | "relative_name" | "referral" | "lmp_or_weeks" | "indication"
  | "patient_declaration" | "sonologist_declaration";

/** `pcpndt-books.ts`'s `RegisterRow` — a SERIAL, never a patient. */
export type WireRegisterRow = {
  formFId: string; serial: string; serialNo: number; serialYear: number;
  deviceResourceId: string; deviceCode: string | null; openedAt: string; state: FormFBookState;
  studyId: string; accessionNo: string | null; studyStatus: string | null;
  indicationCode: string; gestationWeeks: number | null;
  signedByName: string | null; verifiedByName: string | null; missing: FormFField[];
};
export type WireSerialBook = { deviceResourceId: string; deviceCode: string | null; year: number; minted: number; gaps: number[] };
export type WireFormFRegister = { month: string; rows: WireRegisterRow[]; serials: WireSerialBook[] };

export type WireReturnCounts = {
  scans: number; pcpndtScans: number; short: number;
  formF: { opened: number; recorded: number; verified: number; open: number; cancelled: number };
};
export type WireReturnMachine = WireReturnCounts & {
  deviceResourceId: string; code: string; name: string; registrationNo: string | null;
};
export type DiscrepancyKind =
  | "scan_without_recorded_form" | "recorded_not_verified" | "open_not_scanned" | "incomplete_form" | "serial_gap";
export type WireDiscrepancy = {
  kind: DiscrepancyKind; deviceCode: string | null; serial: string | null;
  accessionNo: string | null; studyId: string | null; missing?: FormFField[];
};
export type WireMonthlyReturn = {
  month: string; dueBy: string; today: string; daysLeft: number;
  machines: WireReturnMachine[]; totals: WireReturnCounts; discrepancies: WireDiscrepancy[]; csv: string;
};

/** `readRegister`'s book, with the RS7 labels (device code/name, person's full name). */
export type WireRegistrationBook = {
  registration: {
    id: string; site: string; registrationNo: string; validFrom: string; validTo: string;
    inchargeUserId: string | null; status: string;
  };
  machines: {
    id: string; deviceResourceId: string; make: string; model: string; serial: string;
    formBRef: string | null; active: boolean; deviceCode: string | null; deviceName: string | null;
  }[];
  persons: {
    id: string; userId: string; qualification: string; councilRegNo: string | null;
    active: boolean; fullName: string | null;
  }[];
}[];

const q = (month?: string): string => (month === undefined ? "" : `?month=${encodeURIComponent(month)}`);

export const fetchFormFRegister = (month?: string) =>
  api<WireFormFRegister>("GET", `/radiology/pcpndt/register${q(month)}`);

export const fetchMonthlyReturn = (month?: string) =>
  api<WireMonthlyReturn>("GET", `/radiology/pcpndt/monthly-return${q(month)}`);

export const fetchPcpndtRegistrations = () =>
  api<{ registrations: WireRegistrationBook }>("GET", "/pcpndt/registrations");

/** The room's one gate door: closes `form_f` from the register row, then evaluates readiness. */
export const closeFormFGate = (studyId: string) =>
  api<{ state: string; open: string[] }>("POST", `/radiology/pcpndt/studies/${studyId}/form-f-gate`, {});

/**
 * The second factor, fresh, on THIS session (`POST /auth/totp/verify`, 204). Signing reads the
 * session's instant on the server; the code never travels with the signature.
 */
export const verifySecondFactor = (code: string) => api<null>("POST", "/auth/totp/verify", { code });

/** Form F, Section B — the Act's indications for ultrasonography in pregnancy (Rules, Form F, 2014). */
export const FORM_F_INDICATIONS = [
  "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi",
  "xvii", "xviii", "xix", "xx", "xxi", "xxii", "xxiii",
] as const;
