import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getMode } from "../lib/ops-api";
import { useAuth } from "../lib/auth";
import type { OperatingMode } from "../lib/ops-api";

/**
 * PLAN 11c T5 / D8 — THE OPERATOR'S FIRST SIGNAL THAT THE HOSPITAL IS NOT RUNNING NORMALLY.
 *
 * Polls `GET /ops/mode` at the `AlertsBell` cadence (15 s, `alerts-bell.tsx:25` `POLL_MS`) and
 * renders NOTHING on `normal` — every other mode (`commissioning`, `ramp`, `degraded`, `downtime`)
 * gets a full-width tinted banner naming the mode and its note, so a duty manager who opens any
 * screen sees it without having to visit the mode desk.
 *
 * THE ABSENCE ON `normal` IS THE BEHAVIOUR THIS COMPONENT EXISTS TO GET RIGHT, not an
 * afterthought: a banner that also renders on `normal` (even blank) would be permanent chrome
 * nobody reads, and the one time it says something real would be lost in the noise. Mirrored in
 * `mode-banner.test.tsx`: absence-on-`normal` and presence-on-everything-else are both asserted
 * by execution, never presence-only.
 *
 * `enabled: actor !== null` and the null return before the actor resolves are the `AlertsBell`
 * precedent verbatim — no identity, no route to call, nothing to show.
 */
const POLL_MS = 15_000;

/** Tailwind classes per mode — `normal` is never looked up (the component returns null for it). */
const MODE_TONE: Record<Exclude<OperatingMode, "normal">, string> = {
  commissioning: "border-amber-300 bg-amber-100 text-amber-900",
  ramp: "border-amber-300 bg-amber-100 text-amber-900",
  degraded: "border-orange-300 bg-orange-100 text-orange-900",
  downtime: "border-red-300 bg-red-100 text-red-900",
};

export function ModeBanner(): React.ReactElement | null {
  const { t } = useTranslation();
  const { actor } = useAuth();

  const mode = useQuery({
    queryKey: ["ops", "mode"],
    queryFn: getMode,
    enabled: actor !== null,
    refetchInterval: POLL_MS,
  });

  if (actor === null) return null;

  const data = mode.data;
  if (data === undefined) return null;
  if (data.mode === "normal") return null;

  return (
    <div
      data-testid="mode-banner"
      data-mode={data.mode}
      role="status"
      className={`no-print w-full border-b px-4 py-2 text-sm font-medium ${MODE_TONE[data.mode]}`}
    >
      <span data-testid="mode-banner-word">{t(`opsMode.mode.${data.mode}`)}</span>
      {data.note !== null && data.note !== "" && (
        <span data-testid="mode-banner-note"> — {data.note}</span>
      )}
    </div>
  );
}
