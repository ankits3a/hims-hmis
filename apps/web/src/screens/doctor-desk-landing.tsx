import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { fetchLanding } from "../lib/doctor-desk-api";

/**
 * DD-0.1 (#626) — owner R5, 2026-09-18: *"The first screen after login is a control tower."*
 *
 * `/` sends a doctor of a unit (they hold `opd.consult` AND a parent clinical-unit membership today,
 * the server's answer) to `/doctor-desk` ONCE per browser session. DECIDED: once, so ◆ DESK ONE —
 * the frame's way back to `/` — still reaches the Desk home and its cards; a doctor in no unit
 * (visiting faculty) and everybody else simply get the Desk. While the question is in flight the Desk
 * renders as before; nothing waits on it.
 */
export const LANDED_KEY = "hmis.doctorDesk.landed";

function landedAlready(): boolean {
  try { return sessionStorage.getItem(LANDED_KEY) === "1"; } catch { return true; }
}

export function DoctorLanding({ children }: { children: React.ReactNode }): React.ReactElement {
  const { can, actor } = useAuth();
  const router = useRouter({ warn: false });
  const ask = actor !== null && can("opd.consult") && !landedAlready();
  const q = useQuery({ queryKey: ["doctor-desk", "landing", actor?.id ?? ""], queryFn: fetchLanding, enabled: ask, retry: false, staleTime: Infinity });
  useEffect(() => {
    if (!ask || q.data === undefined) return;
    try { sessionStorage.setItem(LANDED_KEY, "1"); } catch { /* storage closed: land once per load */ }
    if (q.data.tower && router !== undefined) void router.navigate({ to: "/doctor-desk", replace: true });
  }, [ask, q.data, router]);
  return <>{children}</>;
}
