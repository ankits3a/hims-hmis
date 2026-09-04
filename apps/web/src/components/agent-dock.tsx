import { useState } from "react";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-23 — THE DESK AGENT, ON ANY SCREEN
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner ruling 2026-09-04: *"redesign /opd/appointments and /patients/ screens aligned to /counter
 * UI and UX. Remember to add AI agent/Co-pilot into it as well."*
 *
 * Desk One's dock is bound to `useDesk()` — the whole counter session — so it could not be reused
 * anywhere. This is the same bar with the same rules, driven by props instead: a ticker of what
 * just happened, an ask box, and a pull-up log.
 *
 * ═══ WHAT IT IS AND IS NOT, carried over verbatim because the rules are the point ═══
 *
 * There is NO language model behind it. FD-8 measured the hospital's triage gateway at 22–40 s per
 * synchronous call, which is not an answer a clerk with a queue can wait for, and a browser-side key
 * would put a gateway credential in a bundle every user of the hospital can read. So the ask box
 * answers from what is ALREADY ON THE SCREEN, and each answer names the source it came from. An
 * honest deterministic answer beats a slow uncertain one at a counter.
 *
 * THE LOG IS THE PART THAT EARNS IT. Every line records something that ALREADY HAPPENED on the
 * server — a booking moved, a cancellation recorded, a refusal and its reason. Nothing is written
 * before the request answers, because a log that narrates intentions lies the moment one is refused.
 *
 * "SPEAKS-ON-DARK": the machine only ever talks on pine. There is no light variant of this bar,
 * which is what keeps the rule enforceable rather than conventional.
 */

export type AgentLine = { at: string; text: string; kind: "did" | "ok" | "warn" | "err" };

export function AgentDock(
  { answer, log, onAsk, placeholder, idle }: {
    answer: string | null;
    log: AgentLine[];
    onAsk: (question: string) => void;
    placeholder: string;
    /** What the agent says before it has been asked anything — names what it can actually see. */
    idle: string;
  },
): React.ReactElement {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const latest = log[0];

  return (
    <div data-testid="agent-dock" style={{ flexShrink: 0, background: "var(--agent)", color: "var(--agent-fg)" }}>
      {open ? (
        <div style={{ borderBottom: "1px solid #24413631", maxHeight: 250 }}>
          <div style={{ display: "flex", gap: 26, padding: "16px 18px", maxHeight: 250 }}>
            <div style={{ width: "44%", minWidth: 0 }}>
              <div className="tag" style={{ color: "var(--agent-dim)" }}>desk agent · answer</div>
              <div style={{
                marginTop: 8, fontSize: 12.5, lineHeight: "18px",
                color: answer === null ? "var(--agent-dim)" : "var(--agent-fg)",
              }}>
                {answer ?? idle}
              </div>
            </div>
            <div style={{ flexGrow: 1, minWidth: 0, overflowY: "auto", maxHeight: 216 }}>
              <div className="tag" style={{ color: "var(--agent-dim)" }}>what happened on this screen</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                {log.length === 0 ? (
                  <span style={{ fontSize: 11, color: "var(--agent-dim)" }}>
                    Nothing yet. Every server answer this screen gets lands here with the time it landed.
                  </span>
                ) : log.map((line, i) => (
                  <div key={`${line.at}-${String(i)}`} style={{ display: "flex", gap: 9, fontSize: 11.5 }}>
                    <span className="mo" style={{ color: "var(--agent-dim)", flexShrink: 0 }}>{line.at}</span>
                    <span style={{
                      color: line.kind === "err" ? "#ff9d94" : line.kind === "warn" ? "#f0c26a"
                        : line.kind === "ok" ? "var(--mint)" : "var(--agent-fg)",
                    }}>
                      {line.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "9px 18px" }}>
        <span className="mo" style={{ fontSize: 10.5, color: "var(--mint)", letterSpacing: ".1em", flexShrink: 0 }}>
          DESK AGENT
        </span>
        <span
          data-testid="agent-ticker"
          style={{
            fontSize: 11.5, color: "var(--agent-dim)", flexGrow: 1, minWidth: 0,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {latest === undefined ? idle : `${latest.at} ${latest.text}`}
        </span>
        <form
          style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}
          onSubmit={(e) => { e.preventDefault(); onAsk(draft); setDraft(""); }}
        >
          <input
            data-testid="agent-ask"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); }}
            placeholder={placeholder}
            style={{
              width: 300, height: 28, borderRadius: 6, border: "1px solid #24413655",
              background: "#0c1f1a", color: "var(--agent-fg)", padding: "0 10px", fontSize: 11.5,
            }}
          />
          <span className="kb dk">F2</span>
        </form>
        <button
          className="mo"
          data-testid="agent-log-toggle"
          style={{ flexShrink: 0, fontSize: 10.5, color: "var(--agent-dim)", letterSpacing: ".1em" }}
          onClick={() => { setOpen(!open); }}
        >
          {open ? "▼ LOG" : "▲ LOG"}
        </button>
      </div>
    </div>
  );
}

/** Prepends a line, newest first, capped — the same shape and cap Desk One's own log uses. */
export function logged(prev: AgentLine[], text: string, kind: AgentLine["kind"] = "did"): AgentLine[] {
  const at = new Date().toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return [{ at, text, kind }, ...prev].slice(0, 40);
}
