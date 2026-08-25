import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  dismissMatchItem, fetchReconcileQueue, membershipErrorMessage, resolveMatchItem,
} from "../lib/membership-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { WireMatchQueueItem } from "../lib/membership-api";

/**
 * PLAN 09 T5 — THE RECONCILE QUEUE: everything the holder-book import refused to guess.
 *
 * ═══ THE SCREEN IS BUILT SO THAT LINKING IS A DECISION, NOT A DEFAULT ═══
 *
 * The importer never links a card to a patient, whatever the similarity score, because a wrong
 * link is a clinical record attached to the wrong person and it is invisible to the person it
 * happened to. A screen can undo that ruling in one line — a pre-selected radio button, a "link
 * best match" bulk action, a candidate list of exactly one with an obvious button — so this one
 * does none of those things:
 *
 * · NOTHING IS PRE-SELECTED. Every candidate is a separate explicit action, and the score is shown
 *   as the number the server measured rather than as "strong"/"weak", because a band invites a
 *   click and a number invites a look.
 * · THE SCORE IS NEVER THE ONLY THING SHOWN. Name and UHID are beside it, so the person deciding
 *   is comparing PEOPLE and not comparing arithmetic.
 * · DISMISS NEEDS A REASON. Deciding that a resemblance is a coincidence is as much a decision as
 *   linking, and the next person to see this holder needs to know it was made.
 *
 * The three reasons the queue can carry look different because they ARE different work: a fuzzy
 * match needs a person identified, a cap overflow needs a partner telephoned, and a lapsed restore
 * (DD9/C5) is a fact to notice rather than an item to clear — it has no candidates and no buttons,
 * because nothing on this screen can act on it.
 *
 * NO SALES FIGURE ANYWHERE (E-32), the same rule the counter's recognition screen carries: not a
 * price, not a commission, not a cap in rupees. Nothing on the wire shape carries one.
 */
const REASONS = new Set(["fuzzy_match", "merge_duplicate", "cap_overflow", "lapsed_restore"]);

function reasonLabel(t: (k: string) => string, reason: string): string {
  return REASONS.has(reason) ? t(`instrumentReconcile.reason.${reason}`) : reason;
}

export function InstrumentReconcile(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const queue = useQuery({ queryKey: ["membership", "reconcile"], queryFn: fetchReconcileQueue });

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ["membership", "reconcile"] });
  };

  const link = useMutation({
    mutationFn: resolveMatchItem,
    onSuccess: async () => { setError(null); await invalidate(); },
    onError: (e: unknown) => { setError(membershipErrorMessage(e)); },
  });

  const dismiss = useMutation({
    mutationFn: dismissMatchItem,
    onSuccess: async () => { setError(null); setDismissing(null); setNote(""); await invalidate(); },
    onError: (e: unknown) => { setError(membershipErrorMessage(e)); },
  });

  const items: WireMatchQueueItem[] = queue.data?.items ?? [];
  const lapsed = queue.data?.lapsedRestores ?? [];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4">
      <h1 className="text-lg font-semibold">{t("instrumentReconcile.title")}</h1>
      <p className="text-sm text-muted-foreground" data-testid="never-links">
        {t("instrumentReconcile.neverLinks")}
      </p>

      {error !== null && (
        <p role="alert" data-testid="reconcile-error" className="text-sm text-red-600">{error}</p>
      )}

      <section className="flex flex-col gap-4" data-testid="worklist">
        {queue.data !== undefined && items.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("instrumentReconcile.empty")}</p>
        )}

        {items.map((item) => (
          <article key={item.id} data-testid={`item-${item.cardCode}`} className="rounded border p-3">
            <header className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{item.cardCode}</span>
              <span>{item.holderName}</span>
              <span className="text-sm text-muted-foreground">{item.planTitle}</span>
              <Badge data-testid={`reason-${item.cardCode}`}>{reasonLabel(t, item.reason)}</Badge>
            </header>

            {item.note !== null && (
              <p data-testid={`note-${item.cardCode}`} className="mt-1 text-sm">{item.note}</p>
            )}

            {item.candidates.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">{t("instrumentReconcile.noCandidates")}</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {item.candidates.map((c) => (
                  <li key={c.patientId} className="flex flex-wrap items-center gap-2" data-testid={`candidate-${c.patientId}`}>
                    <span>{c.patientName}</span>
                    <span className="text-sm text-muted-foreground">{c.uhid}</span>
                    {/* The measured number, not a band: a band invites a click, a number invites a look. */}
                    <span className="text-sm" data-testid={`score-${c.patientId}`}>
                      {t("instrumentReconcile.score", { score: c.score.toFixed(2) })}
                    </span>
                    <Button
                      onClick={() => link.mutate({ queueItemId: item.id, patientId: c.patientId })}
                      disabled={link.isPending}
                    >
                      {t("instrumentReconcile.link")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {dismissing === item.id ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="text-sm" htmlFor={`note-${item.id}`}>{t("instrumentReconcile.dismissNote")}</label>
                <input
                  id={`note-${item.id}`}
                  className="rounded border px-2 py-1"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button
                  onClick={() => dismiss.mutate({ queueItemId: item.id, note })}
                  disabled={note.trim() === "" || dismiss.isPending}
                >
                  {t("instrumentReconcile.confirmDismiss")}
                </Button>
              </div>
            ) : (
              <Button
                className="mt-2"
                variant="outline"
                onClick={() => { setDismissing(item.id); setNote(""); }}
              >
                {t("instrumentReconcile.dismiss")}
              </Button>
            )}
          </article>
        ))}
      </section>

      <section className="flex flex-col gap-2" data-testid="lapsed-restores">
        <h2 className="text-base font-semibold">{t("instrumentReconcile.lapsedTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("instrumentReconcile.lapsedWhy")}</p>
        {lapsed.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("instrumentReconcile.lapsedEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {lapsed.map((l) => (
              <li key={l.movementId} data-testid={`lapsed-${l.cardCode}`} className="text-sm">
                {l.cardCode} · {l.holderName} · {l.benefitKey}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
