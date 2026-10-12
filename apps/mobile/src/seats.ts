/**
 * The phone screens, each behind the SAME permission the web menu uses for it
 * (each module's manifest.ts in apps/core/src/modules). The server still checks every call; this list only
 * decides what the home screen offers. `milestone` is the plan's delivery slot
 * (docs/superpowers/plans/2026-10-05-mobile-staff-app.md).
 */
export type Seat = {
  key: "vitals" | "slips" | "consult" | "counter" | "onNow" | "myDuties" | "qcollect" | "qbench" | "qreports";
  permission: string; milestone: string;
  /** Shown only while the lab runs this mode (owner 2026-10-12): the server refuses the other mode's routes. */
  labMode?: LabMode;
  /** Every route behind the screen checks the grant hospital-wide, so a department-scoped grant opens nothing. */
  hospitalOnly?: boolean;
};
export type LabMode = "quick" | "full";

export const SEATS: readonly Seat[] = [
  { key: "vitals", permission: "opd.vitals.record", milestone: "M1" },
  { key: "slips", permission: "patients.update", milestone: "M2" },
  { key: "consult", permission: "opd.consult", milestone: "M3" },
  { key: "counter", permission: "opd.visits.open", milestone: "M4" },
  { key: "onNow", permission: "roster.read", milestone: "M5" },
  { key: "myDuties", permission: "roster.read", milestone: "M5" },
  // Quick lab (spec 2026-10-12): the web quick chain's three steps, each behind its web menu's grant.
  { key: "qcollect", permission: "lab.worklist.read", milestone: "M7", labMode: "quick", hospitalOnly: true },
  { key: "qbench", permission: "lab.results.enter", milestone: "M7", labMode: "quick", hospitalOnly: true },
  { key: "qreports", permission: "lab.reports.print", milestone: "M7", labMode: "quick", hospitalOnly: true },
];

export type EffectivePermissions = {
  hospital: string[];
  scoped: { department: Record<string, string[]>; floor: Record<string, string[]> };
};

/**
 * A seat shows when its permission is held hospital-wide or in any department/floor scope. A lab
 * seat also needs its lab mode: `labMode` is the server's answer, or `null` while unknown — an
 * unknown mode hides nothing, so a failed read never locks the lab out of its own screens.
 */
export function seatsFor(p: EffectivePermissions, labMode: LabMode | null = null): Seat[] {
  const scoped = new Set<string>([
    ...Object.values(p.scoped.department).flat(),
    ...Object.values(p.scoped.floor).flat(),
  ]);
  return SEATS.filter((s) => (p.hospital.includes(s.permission) || (s.hospitalOnly !== true && scoped.has(s.permission)))
    && (s.labMode === undefined || labMode === null || s.labMode === labMode));
}
