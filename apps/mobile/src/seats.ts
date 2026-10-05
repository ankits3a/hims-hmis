/**
 * The phone screens, each behind the SAME permission the web menu uses for it
 * (each module's manifest.ts in apps/core/src/modules). The server still checks every call; this list only
 * decides what the home screen offers. `milestone` is the plan's delivery slot
 * (docs/superpowers/plans/2026-10-05-mobile-staff-app.md).
 */
export type Seat = { key: "vitals" | "slips" | "consult" | "counter" | "onNow" | "myDuties"; permission: string; milestone: string };

export const SEATS: readonly Seat[] = [
  { key: "vitals", permission: "opd.vitals.record", milestone: "M1" },
  { key: "slips", permission: "patients.update", milestone: "M2" },
  { key: "consult", permission: "opd.consult", milestone: "M3" },
  { key: "counter", permission: "opd.visits.open", milestone: "M4" },
  { key: "onNow", permission: "roster.read", milestone: "M5" },
  { key: "myDuties", permission: "roster.read", milestone: "M5" },
];

export type EffectivePermissions = {
  hospital: string[];
  scoped: { department: Record<string, string[]>; floor: Record<string, string[]> };
};

/** A seat shows when its permission is held hospital-wide or in any department/floor scope. */
export function seatsFor(p: EffectivePermissions): Seat[] {
  const scoped = new Set<string>([
    ...Object.values(p.scoped.department).flat(),
    ...Object.values(p.scoped.floor).flat(),
  ]);
  return SEATS.filter((s) => p.hospital.includes(s.permission) || scoped.has(s.permission));
}
