import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { listAlerts, markAlertRead } from "../lib/alerts-api";
import { useAuth } from "../lib/auth";
import { useRealtime } from "../lib/realtime";
import { SubmitButton } from "./submit-button";
import { Badge } from "@/components/ui/badge";

/**
 * THE FIRST HUMAN-FACING SURFACE OF THE RUNTIME LOOP (Plan 08.5 T5 / D6). An escalation the
 * scheduler raises now has somewhere to land: this bell polls `GET /alerts`, shows the unread
 * count, and lets the signed-in user mark one read.
 *
 * THE REALTIME FRAME IS AN INVALIDATE HINT, NEVER A RENDER SOURCE (D6/the opd-appointments
 * precedent). T4's gate measured the wire frame over WS: `{alertId, userId, kind, refType, refId,
 * sourceEventId}` — no `title`, no patient identity — so there is nothing in the frame this
 * component could render even if it wanted to. A frame on `alerts:<actor.id>` only triggers a
 * re-fetch of the poll below; a missed frame costs the next 15 s tick, never correctness.
 *
 * `alert.read` does not fan out over WS (findings inbox, T4 gate item 6) — a second tab's badge
 * clears on its own next poll, not immediately. By design; not this task's surface to change.
 */
const POLL_MS = 15_000;

function relativeLabel(iso: string, t: TFunction, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return t("alerts.justNow");
  if (minutes < 60) return t("alerts.minutesAgo", { n: minutes });
  return t("alerts.hoursAgo", { n: Math.floor(minutes / 60) });
}

export function AlertsBell(): React.ReactElement | null {
  const { t } = useTranslation();
  const { actor } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: listAlerts,
    enabled: actor !== null,
    refetchInterval: POLL_MS,
  });

  useRealtime(actor === null ? [] : [`alerts:${actor.id}`], () => {
    void qc.invalidateQueries({ queryKey: ["alerts"] });
  });

  // Nothing to show before the actor resolves (no identity, no topic, no route to call).
  if (actor === null) return null;

  const items = alerts.data?.items ?? [];
  const unreadCount = alerts.data?.unreadCount ?? 0;

  const markRead = async (id: string, key: string): Promise<void> => {
    await markAlertRead(id, key);
    await qc.invalidateQueries({ queryKey: ["alerts"] });
  };

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="alerts-bell-toggle"
        aria-label={t("alerts.title")}
        onClick={() => setOpen((o) => !o)}
        className="relative"
      >
        {t("alerts.bellIcon")}
        {unreadCount > 0 && (
          <Badge data-testid="alerts-unread-badge" variant="destructive" className="absolute -top-2 -right-2 px-1">
            {unreadCount > 9 ? "9+" : unreadCount}
          </Badge>
        )}
      </button>
      {open && (
        <div
          data-testid="alerts-panel"
          className="absolute right-0 top-full z-50 mt-2 w-80 rounded border bg-background text-sm shadow-lg"
        >
          {items.length === 0 ? (
            <p className="p-3 text-neutral-500">{t("alerts.empty")}</p>
          ) : (
            <ul>
              {items.map((a) => (
                <li key={a.id} data-testid={`alert-row-${a.id}`} className="flex items-start justify-between gap-2 border-b p-2 last:border-b-0">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{a.title}</p>
                    <p className="text-xs text-neutral-500">{relativeLabel(a.createdAt, t)}</p>
                  </div>
                  {a.readAt === null && (
                    <SubmitButton
                      data-testid={`alerts-mark-read-${a.id}`}
                      variant="ghost"
                      size="sm"
                      onClick={(key) => markRead(a.id, key)}
                    >
                      {t("alerts.markRead")}
                    </SubmitButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
