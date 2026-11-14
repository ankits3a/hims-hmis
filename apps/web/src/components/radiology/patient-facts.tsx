import { fmtIst, dayMonthIst } from "../../lib/format";
import { istDay } from "./desk-time";

/**
 * #1076 — **THE FULL LIST ROW.** Every imaging list names the person, not just a name: the UHID, the age
 * and sex ("HMS-00000001-5 · 30F"), under the name the server chose. The UHID arrives blank for a
 * confidential patient read without clearance (the server's rule, never decided here); a part the
 * server did not send drops out. Rows from an older server carry none of it and render nothing.
 */
export function patientFacts(row: { uhid?: string; ageYears?: number | null; sex?: string }): string {
  const sex = row.sex === undefined || row.sex === "" ? "" : row.sex.slice(0, 1).toUpperCase();
  const ageSex = `${row.ageYears === null || row.ageYears === undefined ? "" : String(row.ageYears)}${sex}`;
  return [row.uhid ?? "", ageSex].filter((part) => part !== "").join(" · ");
}

export function PatientFacts({ row }: { row: { uhid?: string; ageYears?: number | null; sex?: string } }): React.ReactElement | null {
  const text = patientFacts(row);
  if (text === "") return null;
  return <span className="mo block truncate text-xs text-muted-foreground" data-testid="patient-facts">{text}</span>;
}

/** A slot in IST: the clock time today, the day and the time on any other day ("31 Aug 14:30"). */
export function istSlot(iso: string, now: number): string {
  const day = istDay(iso);
  return day === istDay(now) ? fmtIst(iso) : `${dayMonthIst(day)} ${fmtIst(iso)}`;
}
