import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * PHASE 11i T3 (§2b row 22) — WHICH BOX IS THIS.
 *
 * UAT runs the PRODUCTION image against a different database, on the same host, behind a Caddy
 * serving the same SPA. Two browser tabs, identical in every pixel, one of which must never hold a
 * real person. The failure this exists for is a receptionist in training who registers the patient
 * standing in front of them into the wrong hospital — and nothing on either screen would have told
 * them.
 *
 * ═══ THREE THINGS ABOUT HOW IT IS DRAWN, EACH OF THEM MEASURED FROM AN EARLIER SCAR ═══
 *
 * 1. **It is `pointer-events: none`.** FD-11 found the application shell alive and TABBABLE
 *    underneath Desk One — a layer nobody could see and everybody could hit. A warning that can
 *    swallow a click on the screen it is warning about would be that defect, wearing a label.
 * 2. **It sits above Desk One.** `.d1` is `position: fixed; inset: 0; z-index: 40` and its command
 *    palette is 60: a desk that covers the viewport would cover this too, and the seat where a
 *    trainee is most likely to type a real name is exactly Desk One. `z-index: 9000`.
 * 3. **It renders before login.** `/health` is `@Public()`, so the strip is on the login screen —
 *    which is the first moment a person can tell the two tabs apart, and the last moment it is
 *    free to.
 *
 * ON PRODUCTION IT RENDERS NOTHING AND FETCHES ONCE. `HMIS_ENVIRONMENT_LABEL` is unset there and
 * `deploy-parity.test.ts` pins that the production environment template does not carry the key.
 * The banner is not something production turns off; it is something only a non-production
 * deployment can turn on, which is the only direction that fails safe.
 */
type HealthPayload = { environment?: string | null };

/** A data-URI favicon: a filled square in the banner's colour with the label's first letter. A
 *  browser tab is often all a person can see of a window they are not looking at. */
function faviconFor(label: string): string {
  const letter = label.trim().slice(0, 1).toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="6" fill="#b45309"/>` +
    `<text x="16" y="23" font-family="sans-serif" font-size="20" font-weight="700" ` +
    `text-anchor="middle" fill="#fff">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function EnvironmentBanner(): React.ReactElement | null {
  const health = useQuery({
    queryKey: ["health", "environment"],
    // Never retried and never refetched: the answer is a property of the deployment, not of the
    // hour. A failed fetch renders nothing, which is production's own appearance — the safe
    // direction, and the only one a network blip may produce.
    queryFn: () => api<HealthPayload>("GET", "/health"),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const label = typeof health.data?.environment === "string" ? health.data.environment.trim() : "";

  useEffect(() => {
    if (label === "") return;
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']") ?? document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = faviconFor(label);
    if (link.parentNode === null) document.head.appendChild(link);
    document.title = `${label} · HMIS`;
  }, [label]);

  if (label === "") return null;

  return (
    <div className="env-banner" role="status" aria-live="polite" data-environment={label}>
      <span className="env-banner__label">{label}</span>
      <span className="env-banner__note">not the hospital's live system — do not enter a real patient</span>
    </div>
  );
}
