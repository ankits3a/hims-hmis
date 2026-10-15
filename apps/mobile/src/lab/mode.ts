import { useEffect, useState } from "react";
import type { LabMode } from "../seats";
import { useSession } from "../session";
import { quickLabApi } from "./api";

/**
 * THE LAB'S MODE (owner 2026-10-12) — Quick or Full, never both; the server refuses the other mode's
 * routes (`lab_mode_off`). Read once when the home screen loads or a seat opens, and only by a person
 * who holds a lab grant (the route admits any of them). `null` while unknown, and after a failed read:
 * an unknown mode hides nothing, and a quick route's 409 is then shown as a short note.
 */
export const LAB_MODE_READERS = [
  "lab.catalogue.read", "lab.desk.operate", "lab.worklist.read", "lab.results.enter", "lab.reports.print", "lab.collection.operate",
] as const;

/** The last answer, so a seat opened from home does not flash the screens the home just hid. */
let last: { user: string; mode: LabMode } | null = null;

export function _forgetLabModeForTests(): void { last = null; }

export function useLabMode(): LabMode | null {
  const { state, call } = useSession();
  const user = state.status === "signedIn" ? state.me.actor.id : "";
  const reads = state.status === "signedIn" && LAB_MODE_READERS.some((p) => state.me.permissions.hospital.includes(p));
  const [mode, setMode] = useState<LabMode | null>(() => (last !== null && last.user === user ? last.mode : null));
  useEffect(() => {
    if (!reads) return;
    let gone = false;
    quickLabApi(call).mode().then(
      (r) => {
        if (gone || (r.mode !== "quick" && r.mode !== "full")) return;
        last = { user, mode: r.mode };
        setMode(r.mode);
      },
      () => { if (!gone) { last = null; setMode(null); } },
    );
    return () => { gone = true; };
  }, [reads, call, user]);
  return reads ? mode : null;
}
