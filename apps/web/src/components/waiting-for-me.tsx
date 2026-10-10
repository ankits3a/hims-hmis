import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { waitingAge, waitingLines } from "../../../../packages/contracts/src/waiting";
import type { WaitingLine, WireWaiting } from "../../../../packages/contracts/src/waiting";

/** `GET /me/waiting` — the same read the phone's home card and Open loops screen make. */
export const fetchWaiting = (): Promise<WireWaiting> => api<WireWaiting>("GET", "/me/waiting");

/**
 * E1.4 / E1.5 (decision 0064) — "WAITING FOR ME" on My day: one line per kind, each a link to the
 * screen where it is worked. The lines are `waitingLines()` over the server's answer, the function
 * the phone draws with too, so the two lists cannot disagree. Counts only — no patient on this strip.
 * Nothing waiting: the strip says so in one line rather than vanishing, so "empty" is an answer.
 */
export function WaitingForMe(): React.ReactElement | null {
  const { t } = useTranslation();
  const { actor } = useAuth();
  const who = actor?.id ?? "";
  const q = useQuery({ queryKey: ["me", "waiting", who], queryFn: fetchWaiting, enabled: who !== "", refetchInterval: 60_000 });
  if (q.isError || q.data === undefined) return null;
  const lines = waitingLines(q.data);
  const now = Date.now();
  return (
    <section className="myd-now myd-waiting" data-testid="waiting-for-me" aria-label={t("waiting.title")}>
      <span className="myd-now-lead">{t("waiting.title")}</span>
      {lines.length === 0 ? <span className="myd-now-calm">{t("waiting.nothing")}</span> : (
        <ul className="myd-waiting-list">
          {lines.map((l) => <WaitingRow key={l.kind} line={l} age={waitingAge(l.oldestAt, now)} />)}
        </ul>
      )}
    </section>
  );
}

function WaitingRow({ line, age }: { line: WaitingLine; age: string | null }): React.ReactElement {
  const { t } = useTranslation();
  const label = t(`waiting.kind.${line.kind}`, { count: line.count });
  const body = (
    <>
      <b>{line.count}</b>
      <span>{label}</span>
      {age === null ? null : <span className="myd-waiting-age">{t("waiting.oldest", { age })}</span>}
    </>
  );
  return (
    <li className={`myd-now-it tone-${line.tone}`} data-kind={line.kind}>
      {line.href === null
        ? <>{body}<span className="myd-waiting-where">{t(`waiting.where.${line.kind}`)}</span></>
        : <a href={line.href} data-testid={`waiting-${line.kind}`}>{body}</a>}
    </li>
  );
}
