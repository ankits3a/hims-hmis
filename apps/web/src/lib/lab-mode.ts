import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useAuth } from "./auth";

/**
 * OWNER 2026-10-12 — the lab runs QUICK (counter → collect → bench → reports) or FULL (desk →
 * collection → bench → verify → report centre), never both: the other mode's menus are hidden and the
 * server refuses its work routes (`lab_mode_off`). Switched by the lab's administrator.
 */
export type LabMode = "quick" | "full";

export const fetchLabMode = (): Promise<{ mode: LabMode }> => api("GET", "/lab/desk/mode");
export const saveLabMode = (mode: LabMode): Promise<{ mode: LabMode }> => api("PUT", "/lab/desk/mode", { mode });

/** The grants the server reads the mode on — any lab seat. */
export const LAB_MODE_READERS = [
  "lab.catalogue.read", "lab.desk.operate", "lab.worklist.read", "lab.results.enter", "lab.reports.print", "lab.collection.operate",
] as const;

/**
 * The lab's mode, or `null` while it is unknown (not yet read, or this seat holds no lab grant) —
 * an unknown mode hides nothing, so a failed read never locks a lab out of its own screens.
 */
export function useLabMode(): LabMode | null {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ["lab", "mode"], queryFn: fetchLabMode, enabled: LAB_MODE_READERS.some((p) => can(p)),
    staleTime: 60_000, retry: false,
  });
  return q.data?.mode ?? null;
}

/** A menu entry tagged with a mode shows only while the lab runs that mode; `never` is off every menu. */
export function shownInMode(tag: LabMode | "never" | undefined, mode: LabMode | null): boolean {
  if (tag === undefined) return true;
  if (tag === "never") return false;
  return mode === null || tag === mode;
}
