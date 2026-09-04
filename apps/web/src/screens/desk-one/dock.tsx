import { useState } from "react";
import { useDesk } from "./session";

/**
 * ═══ THE DOCK — §3: "the agent lives along the bottom" ═══
 *
 * *"a ticker of what it just did, an ask-box (F2), and a pull-up log. Suggestions also step into the
 * page as pine chips exactly where the decision is being made."*
 *
 * ═══ WHAT THIS DOCK IS AND IS NOT ═══
 *
 * It is not a chat window and there is no language model behind it. FD-8 measured the hospital's
 * triage gateway at 22–40 s per synchronous call, which is not an answer a clerk with a queue can
 * wait for, and a browser-side key would put a gateway credential in a bundle every user of the
 * hospital can read. So the ask box answers from what is already on the screen — the queue board,
 * the fee quote, the drawer, the counter lane — and `desk-one.tsx:ask` names its source in each
 * answer. An honest deterministic answer beats a slow uncertain one at a counter.
 *
 * The LOG is the part that earns the dock. §5: *"everything it does lands in the log with a
 * timestamp."* Every line in it records something that ALREADY HAPPENED on the server — an
 * allocated UHID, a token number, an invoice number, a refusal and its reason. Nothing is written
 * before the request answers, because a log that narrates intentions lies the moment one is refused.
 */
export function Dock({ onLogout }: { onLogout: () => void }): React.ReactElement {
  const d = useDesk();
  const { s } = d;
  const [draft, setDraft] = useState("");
  const latest = s.log[0];

  return (
    <div style={{ flexShrink: 0, background: "var(--agent)", color: "var(--agent-fg)" }}>
      {s.drawer ? (
        <div style={{ borderBottom: "1px solid #24413631", maxHeight: 250 }}>
          <div style={{ display: "flex", gap: 26, padding: "16px 18px", maxHeight: 250 }}>
            <div style={{ width: "44%", minWidth: 0 }}>
              <div className="tag" style={{ color: "var(--agent-dim)" }}>desk agent · answer</div>
              <div style={{
                marginTop: 8, fontSize: 12.5, lineHeight: "18px",
                color: s.answer === null ? "var(--agent-dim)" : "var(--agent-fg)",
              }}>
                {s.answer ?? "Ask below. I read the live queue board, the fee quote, your drawer and the counter lane — and I say which one the answer came from."}
              </div>
            </div>
            <div style={{ flexGrow: 1, minWidth: 0, overflowY: "auto", maxHeight: 216 }}>
              <div className="tag" style={{ color: "var(--agent-dim)" }}>what happened at this desk</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                {s.log.length === 0 ? (
                  <span style={{ fontSize: 11, color: "var(--agent-dim)" }}>
                    Nothing yet. Every server answer this desk gets lands here with the time it landed.
                  </span>
                ) : null}
                {s.log.map((line, i) => (
                  <div key={`${line.at}-${String(i)}`} style={{ display: "flex", gap: 9, fontSize: 11, lineHeight: "15px" }}>
                    <span className="mo" style={{ color: "var(--agent-dim)", flexShrink: 0 }}>{line.at}</span>
                    <span style={{
                      width: 5, height: 5, borderRadius: 99, marginTop: 5, flexShrink: 0,
                      background: line.kind === "ok" ? "var(--mint)"
                        : line.kind === "warn" ? "var(--gold)"
                          : line.kind === "err" ? "#e8756a"
                            : line.kind === "you" ? "#fff" : "var(--agent-dim)",
                    }} />
                    <span style={{ color: "var(--agent-fg)" }}>{line.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 13, height: 54, padding: "0 18px" }}>
        <span style={{ position: "relative", width: 9, height: 9, flexShrink: 0 }}>
          <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: "var(--mint)" }} />
          <span style={{ position: "absolute", inset: -3, borderRadius: 99, border: "1px solid var(--mint)", opacity: .35 }} />
        </span>
        <span className="tag" style={{ color: "var(--agent-dim)", flexShrink: 0 }}>desk agent</span>
        <span className="mo" style={{
          fontSize: 11.5, color: "var(--agent-fg)", whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexGrow: 1,
        }}>
          {latest === undefined ? "watching the board — nothing to report yet" : `${latest.at}  ${latest.text}`}
        </span>
        <form
          onSubmit={(e) => { e.preventDefault(); d.ask(draft); setDraft(""); }}
          style={{
            flexShrink: 0, display: "flex", alignItems: "center", gap: 8, width: 360, height: 36,
            border: "1px solid #2c4438", borderRadius: 6, padding: "0 11px", background: "#1c332b",
          }}
        >
          <input
            id="d1-ask"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="ask — “kis line mein kam wait hai?”"
            style={{ border: "none", background: "transparent", color: "var(--agent-fg)", flexGrow: 1, fontSize: 12 }}
          />
          <span className="kb dk">F2</span>
        </form>
        <button
          onClick={() => d.patch({ drawer: !s.drawer })}
          className="mo"
          style={{ flexShrink: 0, fontSize: 10.5, color: "var(--agent-dim)", letterSpacing: ".1em" }}
        >
          {s.drawer ? "▼ HIDE" : "▲ LOG"}
        </button>
        {/*
          The application chrome is not on this screen — Desk One is the whole viewport, which is
          the design. The way out therefore has to be ON it, and the dock is where the desk's own
          controls live. It is deliberately plain text at the far right, not a button that competes
          with anything a clerk is doing.
        */}
        <button
          onClick={onLogout}
          className="mo"
          style={{ flexShrink: 0, fontSize: 10.5, color: "var(--agent-dim)", letterSpacing: ".1em" }}
        >
          SIGN OUT
        </button>
      </div>
    </div>
  );
}
