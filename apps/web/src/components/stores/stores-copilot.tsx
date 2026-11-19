import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentDock, logged } from "../agent-dock";
import { useCopilot } from "../../lib/use-copilot";
import type { AgentLine } from "../agent-dock";
import type { CopilotProposal } from "../../lib/copilot-api";
import type { CopilotStoresPlaces, CopilotStoresReorderPick, CopilotStoresTickets } from "@hmis/contracts";

/**
 * #1113 (S3) — THE STORES CONCIERGE, docked on the tower and on a department's shelf.
 *
 * The same copilot every desk asks (`useCopilot`). Seven questions, all routed by the phrasebook; the server
 * answers with keys and numbers from its own reads. Under the answer it shows what the tool handed back:
 * `storesPlaces` (an item's on-hand per place the asker may see), `storesTickets` (the ticket numbers waiting
 * on the asker, one line) and `storesReorderPick` (one option per shelf; tap one, then Send — the one human tap
 * `POST /copilot/confirm` needs). Nothing is written before Send.
 */

const isKind = (p: unknown, kind: string): boolean => typeof p === "object" && p !== null && (p as { kind?: unknown }).kind === kind;

export function StoresCopilot({ variant = "panel" }: { variant?: "panel" | "bar" }): React.ReactElement {
  const { t } = useTranslation();
  const [log, setLog] = useState<AgentLine[]>([]);
  const onNote = useCallback((text: string) => { setLog((l) => logged(l, text)); }, []);
  const terms = useCallback((): string[] => [], []);
  const copilot = useCopilot({ terms, onNote });
  const [chosen, setChosen] = useState<number | null>(null);

  const payload = copilot.payload;
  const places = isKind(payload, "storesPlaces") ? payload as CopilotStoresPlaces : null;
  const tickets = isKind(payload, "storesTickets") ? payload as CopilotStoresTickets : null;
  const pick = isKind(payload, "storesReorderPick") && copilot.proposals !== null ? payload as CopilotStoresReorderPick : null;
  const proposalAt = (i: number): CopilotProposal | undefined => (pick === null ? undefined : copilot.proposals?.[pick.options[i]!.proposal]);
  const btn: React.CSSProperties = {
    minHeight: 36, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--line, #8884)", background: "transparent", color: "inherit",
    fontSize: 13, cursor: "pointer", textAlign: "left", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  };
  const act: React.CSSProperties = { minHeight: 40, padding: "0 14px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent", color: "inherit", fontSize: 14, cursor: "pointer" };
  const send: React.CSSProperties = { ...act, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 700 };
  const linesOf = (o: CopilotStoresReorderPick["options"][number]): string => o.lines.map((l) => `${l.name} ${String(l.qty)}`).join(", ");

  const produced = (
    <>
      {places !== null && (
        <ul className="m-0 list-none space-y-1 p-0 text-xs" data-testid="stores-copilot-places">
          {places.rows.map((r) => (
            <li key={`${r.kind}-${r.place}`} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {r.kind === "transit" ? t("stores.tower.lane.in_transit") : r.place} · {r.qty}
            </li>
          ))}
        </ul>
      )}
      {tickets !== null && tickets.tickets.length > 0 && (
        <p data-testid="stores-copilot-tickets" className="m-0 text-xs" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {tickets.tickets.join(" · ")}
        </p>
      )}
      {pick !== null && !copilot.busy && (
        <div data-testid="stores-copilot-pick" style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          {chosen === null ? pick.options.map((o, i) => (
            <button key={o.shelfId} type="button" style={btn} data-testid={`stores-copilot-option-${String(i)}`} onClick={() => setChosen(i)}>
              <b>{o.shelf}</b> · {linesOf(o)}
            </button>
          )) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              <b style={{ fontSize: 13 }}>{pick.options[chosen]!.shelf}</b>
              <ul className="m-0 list-none p-0 text-xs">
                {pick.options[chosen]!.lines.map((l) => <li key={l.itemId}>{l.name} · {l.qty}</li>)}
              </ul>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" style={send} data-testid="stores-copilot-send" disabled={proposalAt(chosen) === undefined}
                  onClick={() => { const p = proposalAt(chosen); setChosen(null); if (p !== undefined) void copilot.confirm(p); }}>
                  {t("stores.tower.send")}
                </button>
                <button type="button" style={act} onClick={() => setChosen(null)}>{t("copilot.act.cancel")}</button>
              </div>
            </div>
          )}
          <button type="button" style={{ ...act, alignSelf: "flex-start" }} onClick={() => { setChosen(null); copilot.clearPayload(); }}>{t("copilot.act.dismiss")}</button>
        </div>
      )}
    </>
  );

  return (
    <div data-testid="stores-copilot" style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, minWidth: 0, maxWidth: "100%" }}>
      <AgentDock
        variant={variant}
        answer={copilot.answer}
        log={log}
        onAsk={(q) => { setChosen(null); copilot.ask(q); }}
        placeholder={t("stores.tower.askStores")}
        idle={t("stores.tower.askStores")}
        panel={places === null && tickets === null && pick === null ? undefined : produced}
      />
    </div>
  );
}
