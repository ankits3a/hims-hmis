/**
 * ═══ ABDM S1 — ONE SHAPE FOR THE THREE WAYS ABDM DESCRIBES A PERSON, AND THE COMPARISON WITH OURS ═══
 *
 * ABDM hands the counter a person in three different spellings:
 *
 *   · `GET /v3/profile/account` (a verified login) — `ABHANumber`, `preferredAbhaAddress`, `name` /
 *     `firstName`…, `yearOfBirth`/`monthOfBirth`/`dayOfBirth` as strings, `gender` `M|F|O`, `mobile`,
 *     `address`, `districtName`, `stateName`, `pincode`;
 *   · `ABHAProfile` from an Aadhaar enrolment — the same, but `dob` (`DD-MM-YYYY`), `pinCode`, and
 *     `phrAddress[]` for the address;
 *   · `profile.patient` of a scan-and-share — `abhaNumber` (may be null), `abhaAddress`, `name`,
 *     birth fields as strings, `address{line, district, state, pincode}`, `phoneNumber`.
 *
 * `readAbdmProfile` reads all three; everything downstream sees `AbdmProfile` only.
 *
 * THE COMPARISON NEVER WRITES. `compareWithPatient` says, field by field, whether ABDM and the
 * hospital agree on name, date (or year) of birth, gender and mobile. A difference is SHOWN to the
 * clerk; it never overwrites a demographic, because ABDM's spelling of a name is not more right than
 * the one the patient gave at the window — it is a second opinion, and the patient is the one to ask.
 */
export type AbdmGender = "male" | "female" | "other" | "unknown";

export type AbdmProfile = {
  abhaNumber: string | null;
  abhaAddress: string | null;
  name: string | null;
  gender: AbdmGender | null;
  yearOfBirth: number | null;
  monthOfBirth: number | null;
  dayOfBirth: number | null;
  /** `YYYY-MM-DD` when ABDM gave the whole date; null otherwise. */
  dob: string | null;
  mobile: string | null;
  addressLine: string | null;
  district: string | null;
  stateName: string | null;
  pincode: string | null;
};

const s = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};
const n = (v: unknown): number | null => {
  const t = s(v);
  if (t === null || !/^\d{1,4}$/.test(t)) return null;
  const x = Number(t);
  return x === 0 ? null : x;
};
const o = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** ABDM's gender letters (share spec: M/F/O/D/T/U) → the hospital's four values. */
export function abdmGender(v: unknown): AbdmGender | null {
  const g = s(v)?.toUpperCase() ?? null;
  if (g === null) return null;
  if (g === "M" || g === "MALE") return "male";
  if (g === "F" || g === "FEMALE") return "female";
  if (g === "O" || g === "T" || g === "OTHER") return "other";
  return "unknown";
}

/** The dashed ABHA number, or null when the value is not fourteen digits. */
export function dashedAbhaNumber(v: unknown): string | null {
  const t = s(v);
  if (t === null) return null;
  const d = t.replace(/\D/g, "");
  return d.length === 14 ? `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6, 10)}-${d.slice(10)}` : null;
}

function pad2(x: number): string {
  return String(x).padStart(2, "0");
}

export function readAbdmProfile(raw: unknown): AbdmProfile {
  const r = o(raw);
  const addr = o(r.address);
  const nameParts = [s(r.firstName), s(r.middleName), s(r.lastName)].filter((p): p is string => p !== null);
  let year = n(r.yearOfBirth);
  let month = n(r.monthOfBirth);
  let day = n(r.dayOfBirth);
  const dobText = s(r.dob);
  if (year === null && dobText !== null) {
    const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(dobText);
    const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dobText);
    if (dmy) { day = Number(dmy[1]); month = Number(dmy[2]); year = Number(dmy[3]); }
    else if (ymd) { year = Number(ymd[1]); month = Number(ymd[2]); day = Number(ymd[3]); }
    else if (/^\d{4}$/.test(dobText)) year = Number(dobText);
  }
  const phr = Array.isArray(r.phrAddress) ? r.phrAddress.map(s).find((x): x is string => x !== null) ?? null : null;
  const mobile = s(r.mobile) ?? s(r.phoneNumber);
  return {
    abhaNumber: dashedAbhaNumber(r.ABHANumber ?? r.abhaNumber ?? r.healthIdNumber),
    abhaAddress: s(r.preferredAbhaAddress) ?? s(r.abhaAddress) ?? phr,
    name: s(r.name) ?? (nameParts.length > 0 ? nameParts.join(" ") : null),
    gender: abdmGender(r.gender),
    yearOfBirth: year,
    monthOfBirth: month,
    dayOfBirth: day,
    dob: year !== null && month !== null && day !== null ? `${year}-${pad2(month)}-${pad2(day)}` : null,
    mobile: mobile === null ? null : mobile.replace(/[^\d*Xx]/g, "").slice(-10),
    addressLine: typeof r.address === "string" ? s(r.address) : s(addr.line),
    district: s(r.districtName) ?? s(addr.district),
    stateName: s(r.stateName) ?? s(addr.state),
    pincode: s(r.pincode) ?? s(r.pinCode) ?? s(addr.pincode) ?? s(addr.pinCode),
  };
}

export type ProfileField = "name" | "dob" | "gender" | "mobile";
export type FieldComparison = {
  field: ProfileField;
  abdm: string | null;
  hospital: string | null;
  /** `same` · `differs` · `unknown` (one side has nothing to compare). */
  result: "same" | "differs" | "unknown";
};

/** The hospital side of the comparison — what a patient row, or the counter's unsaved form, says. */
export type HospitalDemographics = {
  name: string | null;
  /** `YYYY-MM-DD`, or null. */
  dob: string | null;
  dobEstimated: boolean;
  gender: string | null;
  phone: string | null;
};

/** Case, punctuation, spacing and the counter's honorifics do not make two names different. */
export function normaliseName(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-zऀ-ॿ ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "" && !["mr", "mrs", "ms", "miss", "smt", "shri", "sri", "dr", "kumari", "master", "baby"].includes(w))
    .join(" ");
}

export function compareWithPatient(p: AbdmProfile, h: HospitalDemographics): FieldComparison[] {
  const out: FieldComparison[] = [];
  const cmp = (field: ProfileField, abdm: string | null, hospital: string | null, same: (a: string, b: string) => boolean): void => {
    out.push({ field, abdm, hospital, result: abdm === null || hospital === null ? "unknown" : same(abdm, hospital) ? "same" : "differs" });
  };
  cmp("name", p.name, h.name, (a, b) => normaliseName(a) === normaliseName(b));

  // DATE OF BIRTH — the whole date when both sides have one and ours is not an estimate from an
  // age; the YEAR otherwise. An estimated dob (a counter typed an age) is compared a year either way,
  // because "about 40" was never a claim about a particular year.
  const hospitalYear = h.dob === null ? null : Number(h.dob.slice(0, 4));
  if (p.dob !== null && h.dob !== null && !h.dobEstimated) {
    cmp("dob", p.dob, h.dob, (a, b) => a === b);
  } else {
    const abdmYear = p.yearOfBirth === null ? null : String(p.yearOfBirth);
    const ours = hospitalYear === null ? null : String(hospitalYear);
    cmp("dob", abdmYear, ours, (a, b) => (h.dobEstimated ? Math.abs(Number(a) - Number(b)) <= 1 : a === b));
  }

  cmp("gender", p.gender, h.gender === "" ? null : h.gender, (a, b) => a === b);

  // MOBILE — ABDM often masks it (`******0903`); a masked number is compared on the digits it shows.
  cmp("mobile", p.mobile, h.phone, (a, b) => {
    const shown = a.replace(/[^\d]/g, "");
    const ours = b.replace(/\D/g, "");
    if (/[*Xx]/.test(a)) return shown.length >= 4 && ours.endsWith(shown);
    return shown.slice(-10) === ours.slice(-10);
  });
  return out;
}

export function mismatches(c: FieldComparison[]): FieldComparison[] {
  return c.filter((x) => x.result === "differs");
}

/**
 * ═══ ABDM S1 — WHAT LINKING WILL TAKE FROM ABDM (DECIDED: ABDM-verified demographics are authoritative) ═══
 *
 * NHA's M1 workbook: after verification name, date of birth and gender come from ABHA and are
 * non-editable. So a link writes ABDM's values wherever they differ from the record — shown to the
 * clerk FIRST (`demographicsToApply`), and a link with any change needs the clerk's acceptance.
 *
 *   · name — ABDM's spelling, whenever it differs at all (trimmed). A cosmetic difference is still a
 *     change to a Class I field, so it is shown and accepted like any other.
 *   · birth — ABDM's full date replaces ours (and clears "estimated"); a YEAR only replaces ours only
 *     when the year differs, as the 1st of January marked estimated — a year is all ABDM said.
 *   · gender — ABDM's, unless ABDM says unknown/undisclosed, which is not a value to overwrite with.
 *   · mobile and address are never taken: they stay the hospital's to keep current.
 */
export type HospitalIdentity = { name: string; dob: Date | null; dobEstimated: boolean; administrativeGender: string };
export type DemographicChange = { field: "name" | "dob" | "gender"; from: string | null; to: string };

export function abdmDemographicsPatch(p: AbdmProfile, h: HospitalIdentity): {
  patch: { name?: string; dob?: Date; dobEstimated?: boolean; administrativeGender?: "male" | "female" | "other" };
  changes: DemographicChange[];
} {
  const patch: { name?: string; dob?: Date; dobEstimated?: boolean; administrativeGender?: "male" | "female" | "other" } = {};
  const changes: DemographicChange[] = [];
  const ourDob = h.dob === null ? null : h.dob.toISOString().slice(0, 10);

  if (p.name !== null && p.name.trim() !== h.name.trim()) {
    patch.name = p.name.trim();
    changes.push({ field: "name", from: h.name, to: patch.name });
  }
  if (p.dob !== null) {
    if (ourDob !== p.dob || h.dobEstimated) {
      patch.dob = new Date(`${p.dob}T00:00:00.000Z`);
      patch.dobEstimated = false;
      changes.push({ field: "dob", from: ourDob, to: p.dob });
    }
  } else if (p.yearOfBirth !== null && (ourDob === null || Number(ourDob.slice(0, 4)) !== p.yearOfBirth)) {
    const to = `${String(p.yearOfBirth).padStart(4, "0")}-01-01`;
    patch.dob = new Date(`${to}T00:00:00.000Z`);
    patch.dobEstimated = true;
    changes.push({ field: "dob", from: ourDob, to: String(p.yearOfBirth) });
  }
  if (p.gender !== null && p.gender !== "unknown" && p.gender !== h.administrativeGender) {
    patch.administrativeGender = p.gender;
    changes.push({ field: "gender", from: h.administrativeGender, to: p.gender });
  }
  return { patch, changes };
}
