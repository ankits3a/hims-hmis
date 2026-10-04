import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RosterAebas } from "./roster-aebas";
import en from "../locales/en.json";
import hi from "../locales/hi.json";
import type { WireAebasItem, WireAebasTodo } from "../lib/roster-api";

/**
 * 20-U U8b — the AEBAS to-do list, on screen. The nodal officer sees what is due TODAY (an item
 * whose first day is tomorrow), what is coming and what slipped; one tap marks an item entered and it
 * leaves the list. HMIS never talks to AEBAS, and the screen says so.
 */
const item = (key: string, over: Partial<WireAebasItem>): WireAebasItem => ({
  key, kind: "absence", what: "CL", firstDay: "2026-11-10", lastDay: "2026-11-11", dueDay: "2026-11-09", state: "due_today",
  person: { userId: "jr", name: "Dr. Sandeep Yadav", departmentName: "General Medicine" }, ...over,
});
const TOMORROW_CL = item("absence:a1", {});
const HOLIDAY = item("holiday:2026-11-10", { kind: "holiday", what: "declared", lastDay: "2026-11-10", person: null });
const DEPUTATION = item("absence:a2", {
  what: "deputation", firstDay: "2026-11-14", lastDay: "2026-11-16", dueDay: "2026-11-13", state: "upcoming",
  person: { userId: "sr", name: "Dr. Meena Joshi", departmentName: "General Medicine" },
});
const YOU = { name: "Dr. R. Prasad", grade: null, positionKey: null, unitName: null, departmentName: null };

describe("RosterAebas (20-U U8b)", () => {
  const posted: string[] = [];
  let state: WireAebasTodo & { you: typeof YOU };
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    state = { today: "2026-11-09", items: [HOLIDAY, TOMORROW_CL, DEPUTATION], recentlyEntered: [], you: YOU };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push(raw);
        const key = raw.includes("/holidays/") ? `holiday:${raw.split("/holidays/")[1]!.split("/")[0]!}` : `absence:${raw.split("/absences/")[1]!.split("/")[0]!}`;
        const done = state.items.find((i) => i.key === key)!;
        state = { ...state, items: state.items.filter((i) => i.key !== key), recentlyEntered: [...state.recentlyEntered, done] };
        return new Response(JSON.stringify({ today: state.today, items: state.items, recentlyEntered: state.recentlyEntered }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = raw.endsWith("/auth/me")
        ? { actor: { type: "user", id: "ms" }, permissions: { hospital: ["roster.read", "roster.periods.publish"], scoped: { department: {}, floor: {} } } }
        : raw.endsWith("/ops/mode") ? { mode: "normal", since: null, note: null, reportId: null } : state;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists what begins tomorrow as due TODAY, and the rest by the day it is due", async () => {
    renderWithProviders(<RosterAebas />);
    const due = await screen.findByTestId("aebas-due");
    expect(due).toHaveTextContent("Enter today");
    expect(within(due).getByTestId("aebas-item-absence:a1")).toHaveTextContent("Dr. Sandeep YadavCasual leave · General Medicine10-11-2026 to 11-11-2026by today");
    expect(within(due).getByTestId("aebas-item-holiday:2026-11-10")).toHaveTextContent("Holiday — everybodyDeclared holiday10-11-2026");
    expect(screen.getByTestId("aebas-upcoming")).toHaveTextContent("Dr. Meena JoshiDeputation · General Medicine14-11-2026 to 16-11-2026by 13-11-2026");
    expect(screen.getByTestId("desk-pill")).toHaveTextContent("2 to enter today");
    expect(screen.getByText(/HMIS does not connect to AEBAS/)).toBeInTheDocument();
  });

  it("one tap marks it entered: it leaves the list and shows under this week's entries", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RosterAebas />);
    await user.click(await screen.findByTestId("aebas-mark-absence:a1"));
    expect(posted).toEqual([expect.stringMatching(/\/roster\/aebas\/absences\/a1\/entered$/) as unknown as string]);
    expect(await screen.findByTestId("aebas-entered")).toHaveTextContent("Dr. Sandeep YadavCasual leave · 10-11-2026");
    expect(screen.queryByTestId("aebas-item-absence:a1")).toBeNull();
    await user.click(screen.getByTestId("aebas-mark-holiday:2026-11-10"));
    expect(posted[1]).toMatch(/\/roster\/aebas\/holidays\/2026-11-10\/entered$/);
    expect(await screen.findByTestId("aebas-upcoming")).toBeInTheDocument();
    expect(screen.queryByTestId("aebas-due")).toBeNull();
  });

  it("says plainly when nothing is left", async () => {
    state = { ...state, items: [] };
    renderWithProviders(<RosterAebas />);
    expect(await screen.findByTestId("aebas-empty")).toHaveTextContent("Nothing to enter.");
  });

  it("its words, in English and Hindi, never say whether anybody was at work", () => {
    const words = JSON.stringify([en.rosterAebas, hi.rosterAebas, en.rosterEvidence, hi.rosterEvidence]);
    expect(words.match(/present|absent|attendance|attended|उपस्थित|अनुपस्थित|हाज़िर|हाजिर|गैरहाजिर/i)).toBeNull();
  });
});
