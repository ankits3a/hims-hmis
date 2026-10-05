/**
 * CRKMCH OPD doctor list, October 2026 — the data `setup:units` reads (see `../setup-units.ts`).
 *
 * A TypeScript module, not a .json, so `tsc` compiles it into the server image: the build copies no
 * non-JS file (`test/scripts-data-compiles.test.ts`). Was `crkmch-units-2026-10.json` until 2026-10-05.
 */
import type { UnitsData } from "../setup-units";

export const CRKMCH_UNITS_2026_10: UnitsData = {
  title: "CRKMCH OPD doctor list, October 2026 — the hospital's real units",
  source:
    'Photo of the printed OPD DOCTOR LIST (header "OPD TIMING-9AM - 3PM"), /opt/hmis-context/roster-ux-tools/crkmch-opd-doctor-list-2026-10.jpg, plus the owner\'s designations given 2026-10-04.',
  asOf: "2026-10-04",
  ownerSaid:
    "We only have 1 unit per department right now which is active. We are yet to hire more doctors. Some departments do not even have any single doctor so we don't have units there. No other department is currently active other than OPD.",
  opdWindow: {
    start: "09:00",
    end: "17:00",
    notes:
      'Owner 2026-10-04: the DEFAULT OPD time is 09:00-17:00 (not the sheet header\'s 9-3), and that is the unit\'s OPD window on the calendar. Time notation on the sheet: "2-5" = 14:00-17:00, "10-3" = 10:00-15:00, "9-11" = 09:00-11:00. A doctor\'s own hours stay in that doctor\'s OPD schedule; the unit window says only WHICH UNIT\'s day it is.',
  },
  notes: [
    "Every department listed has ONE active unit (Unit I) or none. Units II-V of the seeded establishment stay unconfirmed: they are not real yet.",
    "Unit membership is faculty and senior residents on the hospital's rolls. Guest / visiting faculty sit in the OPD but belong to no unit (owner).",
    "DECIDED: where an Assistant Professor is the only faculty in the unit, they are the unit in-charge (position unit_head, role head). That is the standard Indian teaching-hospital reading: the senior-most faculty of a unit is its in-charge whatever the cadre.",
    "A unit's OPD weekdays are the union of its members' sheet days. Its take runs every day, by call (a one-unit department is on take every day).",
    "Rows 12 (Dr. Rajesh Kumar, Ophthalmology) and 13 (Dr. Nadia Imam, Obs & Gynae) are STRUCK OFF the sheet and are omitted.",
  ],
  doctors: [
    {
      sl: 1,
      name: "Dr. S.I Raza",
      sheetName: "Dr. S I Raza",
      aliases: [],
      department: "MED",
      sheetDepartment: "General Medicine",
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      hours: "09:00-16:00",
      designation: "Guest Faculty",
      place: "guest_faculty",
      notes:
        'Sheet: "Mon To Sat (9am-4pm)". Owner: Visiting / Guest Faculty — stored as "Guest Faculty", the owner\'s term. Sits in the Medicine OPD, in no unit.',
    },
    {
      sl: 2,
      name: "Dr. Sunny",
      sheetName: "Dr. Sunny",
      aliases: [],
      department: "CAS",
      sheetDepartment: "EMO",
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      hours: "09:00-17:00",
      designation: "Emergency Medical Officer",
      place: "casualty_mo",
      notes:
        'Sheet department "EMO" = emergency medical officer, i.e. Casualty (org department CAS). Not a unit member; rostered as position casualty_mo through a Casualty duty roster, which this script does not write. Only a first name on the sheet: matching is on "Sunny" alone and is reported if ambiguous.',
    },
    {
      sl: 3,
      name: "Dr. Nitish Kumar Jha",
      sheetName: "Dr. Nitesh Kumar Jha",
      aliases: [],
      department: "COMM",
      sheetDepartment: "Community Medicine",
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      hours: "09:00-17:00",
      designation: "Assistant Professor",
      place: "no_unit",
      notes:
        "Owner spells Nitish; the sheet spells Nitesh — both are matched. Owner 2026-10-04: Community Medicine WILL get an OPD department (another lane adds the OPD master and links org COMM to it), and he sits in it Mon-Sat 09:00-17:00. It still has NO unit: NMC gives Community Medicine no clinical units or beds. This script does not create OPD masters; until that lane lands it reports the clinic as missing.",
    },
    {
      sl: 4,
      name: "Dr. Sonam Kumari",
      sheetName: "Dr. Sonam Kumari",
      aliases: ["Dr. Sonam Kumar"],
      department: "ENT",
      sheetDepartment: "ENT",
      days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
      hours: "10:00-15:00",
      designation: "Assistant Professor",
      place: "unit_head",
      notes:
        'Owner corrected 2026-10-04: Dr. Sonam KUMARI (as the sheet has it). Sheet "Mon To Fri (10am-3pm)" = 10:00-15:00. Matching folds Kumari/Kumar, so either spelling in the database is found. Only faculty in ENT: in-charge of ENT Unit I.',
    },
    {
      sl: 5,
      name: "Dr. Chandan",
      sheetName: "Dr. Chandan",
      aliases: [],
      department: "MED",
      sheetDepartment: "Gen. Medicine",
      days: ["Mon", "Tue", "Wed"],
      hours: "09:00-16:00",
      designation: "Assistant Professor & Deputy Superintendent",
      place: "unit_head",
      notes:
        'Sheet: "Mon, Tues, Wed, (9am-4pm)" with "Vacant days- Thurs, Fri, Sat" STRUCK THROUGH by hand — read as Mon-Wed only, the strike removing the vacant-days note, not adding days. Only faculty in Medicine\'s unit: in-charge of General Medicine Unit I. Only a first name on the sheet.',
    },
    {
      sl: 6,
      name: "Dr. Ritu Kumari",
      sheetName: "Dr. Rutu Mam",
      aliases: ["Dr. Ritu"],
      department: "OBG",
      sheetDepartment: "Obs & Gynae",
      days: ["Mon", "Tue", "Wed"],
      hours: "09:00-16:00",
      designation: "Assistant Professor",
      place: "unit_head",
      notes:
        'Sheet writes "Dr. Rutu Mam" (an honorific, no surname); the owner names her Dr. Ritu Kumari. Sheet: "Mon, Tues, Wed, (9am-4pm) Vacant days- Thurs, Fri, Sat". Only faculty in OBG: in-charge of Obstetrics & Gynaecology Unit I.',
    },
    {
      sl: 7,
      name: "Dr. Shishir Jha",
      sheetName: "Dr. Shishir Jha",
      aliases: [],
      department: "SUR",
      sheetDepartment: "Gen. Surgery",
      days: ["Mon", "Tue"],
      hours: "09:00-16:00",
      designation: "Guest Faculty",
      place: "guest_faculty",
      notes:
        'Sheet: "Mon, Tues (9am-4pm) Vacant days- Wed, Thurs, Fri, Sat". Guest faculty: sits in the Surgery OPD on Mon/Tue, in no unit — so Surgery\'s unit does not hold the OPD on those days.',
    },
    {
      sl: 8,
      name: "Dr. Kishore Kunal",
      sheetName: "Dr. Kishore Kunal",
      aliases: [],
      department: "ORT",
      sheetDepartment: "Orthopaedics",
      days: ["Tue", "Wed", "Thu", "Sat"],
      hours: "09:00-11:00,14:00-17:00",
      designation: "Assistant Professor",
      place: "unit_head",
      notes:
        'Sheet: "Tue, Wed, Tues, Sat (9am-11am) (2pm-5pm) Vacant days- Mon, Fri". "Tues" written twice. CONFIRMED by the owner 2026-10-04: Tue, Wed, Thu, Sat; sessions 09:00-11:00 and 14:00-17:00. Only faculty in Ortho: in-charge of Orthopaedics Unit I.',
    },
    {
      sl: 9,
      name: "Dr. Yash Vardhan",
      sheetName: "Dr. Yash Vardhan",
      aliases: [],
      department: "MED",
      sheetDepartment: "General Medicine",
      days: ["Thu", "Fri", "Sat"],
      hours: "09:00-17:00",
      designation: "Senior Resident",
      place: "unit_sr",
      notes:
        'Sheet: "Thurs, Fri, Sat (9am-5pm)". Senior resident of General Medicine Unit I.',
    },
    {
      sl: 10,
      name: "Dr. Suryendru Kumar",
      sheetName: "Dr. Suryendru Kumar",
      aliases: [],
      department: "PED",
      sheetDepartment: "Paediatrics",
      days: ["Thu", "Fri", "Sat"],
      hours: "09:00-17:00",
      designation: "Guest Faculty",
      place: "guest_faculty",
      notes:
        'Sheet: "Thurs, Fri, Sat (9am-5pm) Vavant days- Mon, Tues, Wed". Paediatrics has guest faculty only, so it has NO unit: its seeded units stay unconfirmed.',
    },
    {
      sl: 11,
      name: "Dr. Saurabh Ranjan",
      sheetName: "Dr. Saurabh Ranjan",
      aliases: [],
      department: "SUR",
      sheetDepartment: "Neurosurgeon (Gen. Surgery)",
      days: ["Fri", "Sat"],
      hours: "09:00-16:00",
      designation: "Assistant Professor",
      place: "unit_head",
      notes:
        'Sheet: "Fri - Sat (9am-4pm) Vacant days - None" ("None" read as: no vacant days noted, not as every day). A neurosurgeon on the General Surgery rolls; the only non-guest faculty in Surgery: in-charge of General Surgery Unit I.',
    },
  ],
  omitted: [
    {
      sl: 12,
      name: "Dr. Rajesh Kumar",
      department: "OPH",
      reason: "struck off the sheet: not current",
    },
    {
      sl: 13,
      name: "Dr. Nadia Imam",
      department: "OBG",
      reason: "struck off the sheet: not current",
    },
  ],
};
