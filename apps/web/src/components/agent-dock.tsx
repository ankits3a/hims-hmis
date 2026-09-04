import { useEffect, useRef, useState } from "react";

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
  const askRef = useRef<HTMLInputElement>(null);
  const latest = log[0];

  /*
    ═══ FD-23 CLOSE REVIEW — THE `F2` KEYCAP HAD TO BECOME TRUE, AND BINDING IT IS THE OWNER'S RULING ═══

    The bar drew an `F2` keycap on both screens that mount it and nothing bound the key, so a clerk
    pressed it and the browser ate it. Desk One's own dock states the rule this broke, verbatim:
    *"Every keycap ON the screen shows what is actually bound. A keycap that lies is worse than none:
    a clerk presses it, the browser eats it, and they learn the screen is broken."*

    Two ways to make it true — delete the keycap, or bind the key. Bound, because the owner already
    ruled what this key is for: *"CTRL + N should replace F2. F2 will be dedicated to pull agent."*
    This bar IS the agent surface, so the key does here exactly what it does on Desk One — focus the
    ask box. The binding is LOCAL and per-screen, like Desk One's; `lib/keyboard.tsx` keeps `F2`
    unbound globally and its reservation comment and test row stand untouched, because this
    navigates nowhere.
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "F2") return;
      e.preventDefault();
      askRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, []);

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
          /*
            ═══ FD-25 — ASKING OPENS THE PANEL, BECAUSE THE ANSWER LIVES IN IT ═══

            `answer` is rendered ONLY inside the pull-up (`open ? … : null`). So a clerk typed a
            question, pressed Enter, and the screen did nothing visible: the answer existed, in
            state, behind a toggle they had no reason to press. Found by a test asserting the dock
            said something after a question — which it did not, on any of the three screens that
            mount this bar.

            That is precisely the failure this bar's own header warns about ("a dock that renders
            and answers nothing is worse than none") arriving one layer in: it was not that the
            agent had no answer, it was that asking did not show it. Two screens have shipped with
            it since FD-23.

            The panel is not force-closed on submit, only opened — a clerk who opened the log to
            read what happened keeps it open when they ask a follow-up.
          */
          onSubmit={(e) => { e.preventDefault(); onAsk(draft); setDraft(""); setOpen(true); }}
        >
          <input
            ref={askRef}
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
