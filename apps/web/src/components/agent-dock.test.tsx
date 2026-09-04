import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDock, logged } from "./agent-dock";
import type { AgentLine } from "./agent-dock";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-23 — THE DESK AGENT, WHEREVER IT IS MOUNTED
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner ruling 2026-09-04: *"redesign /opd/appointments and /patients/ screens aligned to /counter
 * UI and UX. Remember to add AI agent/Co-pilot into it as well."*
 *
 * Desk One's dock was bound to `useDesk()` and could not be reused anywhere. This is the same bar
 * driven by props, and these pin the two properties that make it honest rather than decorative: it
 * says something BEFORE it is asked (so a clerk knows what it can see), and its log holds results.
 */

function line(text: string, kind: AgentLine["kind"] = "did"): AgentLine {
  return { at: "14:05", text, kind };
}

describe("AgentDock", () => {
  it("says what it can see before it is asked — an agent with no stated scope invites the wrong question", () => {
    render(
      <AgentDock answer={null} log={[]} onAsk={() => undefined} placeholder="ask" idle="I read this screen only." />,
    );
    expect(screen.getByTestId("agent-ticker")).toHaveTextContent("I read this screen only.");
  });

  it("tickers the newest thing that happened, with its time", () => {
    render(
      <AgentDock
        answer={null}
        log={[line("booked Asha Devi at 10:30", "ok"), line("older")]}
        onAsk={() => undefined}
        placeholder="ask"
        idle="idle"
      />,
    );
    expect(screen.getByTestId("agent-ticker")).toHaveTextContent("14:05 booked Asha Devi at 10:30");
  });

  it("hands the question over and clears the box, so a second question is not a duplicate of the first", async () => {
    const asked: string[] = [];
    render(
      <AgentDock answer={null} log={[]} onAsk={(q) => asked.push(q)} placeholder="ask" idle="idle" />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByTestId("agent-ask"), "which doctor?{Enter}");
    expect(asked).toEqual(["which doctor?"]);
    expect(screen.getByTestId("agent-ask")).toHaveValue("");
  });

  it("the log opens on demand and carries every line, not only the newest", async () => {
    render(
      <AgentDock
        answer="Dr Verma, for 2026-09-05."
        log={[line("moved a booking", "ok"), line("booking REFUSED — no slot", "err")]}
        onAsk={() => undefined}
        placeholder="ask"
        idle="idle"
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("agent-log-toggle"));

    expect(screen.getByText("moved a booking")).toBeInTheDocument();
    expect(screen.getByText("booking REFUSED — no slot")).toBeInTheDocument();
    expect(screen.getByText("Dr Verma, for 2026-09-05.")).toBeInTheDocument();
  });

  /*
    Newest first and capped. An unbounded log on a counter machine that stays open all day is a leak
    the clerk never sees until the tab is unusable.
  */
  it("logged prepends and caps at forty", () => {
    let log: AgentLine[] = [];
    for (let i = 0; i < 45; i++) log = logged(log, `line ${String(i)}`);
    expect(log).toHaveLength(40);
    expect(log[0]!.text).toBe("line 44");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-23 CLOSE REVIEW — THE `F2` KEYCAP HAD TO BECOME TRUE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The bar drew an `F2` keycap on both screens that mount it (`/opd/appointments`, `/patients/:id`)
 * and nothing bound the key: `lib/keyboard.tsx` leaves `F2` deliberately unbound globally, and
 * neither host screen registered a listener. A clerk pressed it and the browser ate it. Desk One's
 * own dock states the rule this broke, verbatim: *"Every keycap ON the screen shows what is
 * actually bound. A keycap that lies is worse than none: a clerk presses it, the browser eats it,
 * and they learn the screen is broken."*
 *
 * BOUND rather than deleted, because the owner already ruled what this key is for: *"CTRL + N
 * should replace F2. F2 will be dedicated to pull agent."* This bar IS the agent surface, so the
 * key does here what it does on Desk One — focus the ask box. The binding is LOCAL, so
 * `lib/keyboard.tsx`'s reservation comment and its "F2 navigates nowhere" row both still stand.
 */
describe("AgentDock — the F2 keycap says what the key does", () => {
  it("F2 focuses the ask box", () => {
    render(
      <AgentDock answer={null} log={[]} onAsk={() => undefined} placeholder="ask" idle="idle" />,
    );
    const ask = screen.getByTestId("agent-ask");
    expect(document.activeElement).not.toBe(ask);

    fireEvent.keyDown(window, { key: "F2" });

    // THE KILL — unbound, focus never moves and the keycap advertises nothing.
    expect(document.activeElement).toBe(ask);
  });

  it("binds the key it draws, and no other function key", () => {
    render(
      <AgentDock answer={null} log={[]} onAsk={() => undefined} placeholder="ask" idle="idle" />,
    );
    expect(screen.getByText("F2")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "F7" });
    expect(document.activeElement).not.toBe(screen.getByTestId("agent-ask"));
  });
});
