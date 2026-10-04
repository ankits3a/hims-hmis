import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./auth";
import { fetchDoctorUnits } from "./roster-api";
import { besideName } from "./doctor-label";

/**
 * 2026-10-04 (owner) — "Dr. Chandan · Unit I": the label a staff OPD screen writes beside a doctor's
 * name on `date` (IST), from the roster's unit memberships that day and the doctor's designation.
 * A seat without `roster.read`, or a failed read, gets the designation alone — never an error.
 */
export function useDoctorLabel(date: string): (doctor: { userId: string; designation?: string | null }) => string | null {
  const { can } = useAuth();
  const units = useQuery({
    queryKey: ["roster", "doctor-units", date],
    queryFn: () => fetchDoctorUnits(date),
    enabled: can("roster.read") && /^\d{4}-\d{2}-\d{2}$/.test(date),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const data = units.data;
  return useCallback((doctor) => besideName({
    unit: data?.find((u) => u.userId === doctor.userId)?.short ?? null,
    designation: doctor.designation ?? null,
  }), [data]);
}
