import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { acknowledgeAlert, listAlerts, markAlertRead } from "../lib/alerts-api";
import type { WireAckInput, WireAlert } from "../lib/alerts-api";
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

/** The bell's one offer. Anything longer is a conversation, not a tap (G5 bounds the repeats). */
const OWN_MINUTES = 30;

/**
 * ═══ THE DEEP LINK, AND WHY IT IS A CLOSED MAP RATHER THAN A TEMPLATE ═══
 *
 * An alert names its subject as `refType` + `refId`, and only SOME ref types have a screen a
 * reader can act on. `approval` does: the inbox can focus one card. `workflow_instance` — the
 * ref every escalation alert carries — does NOT, and a link built by string template would send
 * a reader to a route that renders nothing and leave them believing they had missed something.
 *
 * So the map is explicit and it is the whole of the rule: a ref type absent from it gets no link.
 * Adding a screen means adding a line here, which is the point.
 */
const DEEP_LINKS: Record<string, (refId: string) => { to: string; search: Record<string, string> }> = {
  approval: (refId) => ({ to: "/approvals", search: { focus: refId } }),
};

function deepLinkFor(a: WireAlert): { to: string; search: Record<string, string> } | null {
  if (a.refType === null || a.refId === null) return null;
  const build = DEEP_LINKS[a.refType];
  return build === undefined ? null : build(a.refId);
}

function relativeLabel(iso: string, t: TFunction, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return t("alerts.justNow");
  if (minutes < 60) return t("alerts.minutesAgo", { n: minutes });
  return t("alerts.hoursAgo", { n: Math.floor(minutes / 60) });
}

/**
 * The link to the screen where the thing can actually be done, when there is one. It closes the
 * panel on the way: a bell left hanging over the card it just navigated to is a bell in the way.
 */
function AlertLink({ alert, onFollow, t }: {
  alert: WireAlert;
  onFollow: () => void;
  t: TFunction;
}): React.ReactElement | null {
  const link = deepLinkFor(alert);
  if (link === null) return null;
  return (
    <Link
      data-testid={`alerts-open-${alert.id}`}
      to={link.to}
      search={link.search}
      onClick={onFollow}
      className="text-xs underline underline-offset-2"
    >
      {t("alerts.open")}
    </Link>
  );
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

  const ack = async (id: string, input: WireAckInput, key: string): Promise<void> => {
    await acknowledgeAlert(id, input, key);
    await qc.invalidateQueries({ queryKey: ["alerts"] });
  };

  /**
   * Handover asks for the badge number of whoever is taking it on. `prompt` rather than a picker
   * is deliberate and temporary: T9 ships the picker, and until it does the alternative is a
   * staff directory in the bell (see `acknowledgeAlert`'s note). A cancelled prompt posts nothing.
   */
  const handOver = async (id: string, key: string): Promise<void> => {
    const code = window.prompt(t("alerts.handOverPrompt"));
    if (code === null || code.trim() === "") return;
    await ack(id, { kind: "handed_over", handedToStaffCode: code.trim() }, key);
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
                <li key={a.id} data-testid={`alert-row-${a.id}`} className="flex flex-col gap-1.5 border-b p-2 last:border-b-0">
                  <div className="flex items-start justify-between gap-2">
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
                  </div>

                  {/*
                    THE ANSWER LINE. `read_at` says this panel rendered the row; these three say a
                    human took a position on it, and that is the only thing that stops the
                    obligation spine's respond clock. An alert already answered shows what the
                    answer WAS instead of offering it again — the actions are for the undecided.
                  */}
                  {(a.ackKind ?? null) === null ? (
                    <div className="flex flex-wrap items-center gap-1">
                      <SubmitButton
                        data-testid={`alerts-ack-seen-${a.id}`}
                        variant="ghost"
                        size="sm"
                        onClick={(key) => ack(a.id, { kind: "seen" }, key)}
                      >
                        {t("alerts.seen")}
                      </SubmitButton>
                      <SubmitButton
                        data-testid={`alerts-ack-own-${a.id}`}
                        variant="ghost"
                        size="sm"
                        onClick={(key) => ack(a.id, { kind: "owned", untilMinutes: OWN_MINUTES }, key)}
                      >
                        {t("alerts.own", { n: OWN_MINUTES })}
                      </SubmitButton>
                      <SubmitButton
                        data-testid={`alerts-ack-handover-${a.id}`}
                        variant="ghost"
                        size="sm"
                        onClick={(key) => handOver(a.id, key)}
                      >
                        {t("alerts.handOver")}
                      </SubmitButton>
                      <AlertLink alert={a} onFollow={() => { setOpen(false); }} t={t} />
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span data-testid={`alerts-ack-state-${a.id}`} className="text-xs text-neutral-500">
                        {a.ackKind === "owned"
                          ? t("alerts.owned")
                          : a.ackKind === "handed_over"
                            ? t("alerts.handedOver")
                            : t("alerts.acknowledged")}
                      </span>
                      <AlertLink alert={a} onFollow={() => { setOpen(false); }} t={t} />
                    </div>
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
