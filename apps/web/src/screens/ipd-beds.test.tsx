import { act, screen, waitFor, within } from "@testing-library/react";
import i18next from "i18next";
import userEvent from "@testing-library/user-event";
import { ApiError, setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdBeds as IpdBedsUnderTest } from "./ipd-beds";
import type { IpdBedBoard, IpdBoardBed } from "@hmis/contracts";

/*
  E1.1 (#718) — the Beds capacity board. Every value is synthetic: ids are `01FAKE…`, names are invented, the
  board is a fixture shaped by the contract (`packages/contracts/src/ipd/bed-board.ts`).
*/

const api = vi.hoisted(() => ({
  getBedBoard: vi.fn(),
  markBedClean: vi.fn(),
  assignBed: vi.fn(),
  reserveBed: vi.fn(),
}));
vi.mock("../lib/ipd-beds-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-beds-api")>();
  return { ...real, getBedBoard: api.getBedBoard, markBedClean: api.markBedClean, assignBed: api.assignBed, reserveBed: api.reserveBed };
});

/** The socket under test: `connected` is what the realtime client says; pongs are what the heartbeat hears. */
const rt = vi.hoisted(() => ({ connected: true, pongs: new Set<() => void>(), pinged: 0, answer: true }));
vi.mock("../lib/realtime", () => ({
  useRealtime: () => ({ connected: rt.connected }),
  realtimeClient: () => ({
    ping: () => { rt.pinged += 1; if (rt.answer) for (const l of rt.pongs) l(); },
    onPong: (l: () => void) => { rt.pongs.add(l); return () => { rt.pongs.delete(l); }; },
  }),
  resetRealtimeClientForTests: () => {},
}));

const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;
let seq = 100;
function bed(code: string, over: Partial<IpdBoardBed> = {}): IpdBoardBed {
  seq += 1;
  return {
    id: id(seq), code, roomCode: null, class: "general", genderRule: "female", isolation: "none", icu: false, overflow: false,
    inCensus: true, status: "available", since: null, occupant: null, reservation: null, block: null, ...over,
  };
}

function boardOf(wall: boolean): IpdBedBoard {
  const name = (n: string): string | null => (wall ? null : n);
  const beds = [
    bed("F05-MED-F-B01", { status: "occupied", occupant: { initials: "S.D.", name: name("Sunita Devi") } }),
    bed("F05-MED-F-B02", { status: "cleaning", since: "2026-01-01T03:00:00.000Z" }),
    bed("F05-MED-F-B03"),
    bed("F05-MED-F-B04", { status: "incumbent", occupant: { initials: "IN", name: null } }),
  ];
  const daycare = [bed("F05-DC-01", { class: "daycare", inCensus: false, genderRule: "any", status: "occupied", occupant: { initials: "R.K.", name: name("Ram Kumar") } })];
  return {
    asOf: "2026-01-01T05:00:00.000Z", wall,
    totals: {
      census: { occupied: 2, total: 4 }, free: 1, freeByClass: { general: 1 }, reserved: 0, cleaning: 1, cleaningOver60: 1,
      blocked: 0, blockedPastReturn: 0, incumbent: 1, overflow: { occupied: 0, total: 1 }, outsideCensus: { occupied: 1, total: 1 },
      dischargesToday: 3, waiting: { count: 0, longestMinutes: null },
    },
    waiting: [],
    floors: [{
      id: id(1), code: "F05", name: "Floor 5 · Medicine", census: { occupied: 2, total: 4 },
      wards: [
        { id: id(2), code: "F05-MED-F", name: "5B Female", kind: "hall", department: "MED", unitType: "WARD", inCensus: true,
          counts: { total: 4, occupied: 1, incumbent: 1, available: 1, reserved: 0, cleaning: 1, blocked: 0 }, beds },
        { id: id(3), code: "F05-DC", name: "Day care", kind: "ward", department: "MED", unitType: "DAYCARE", inCensus: false,
          counts: { total: 1, occupied: 1, incumbent: 0, available: 0, reserved: 0, cleaning: 0, blocked: 0 }, beds: daycare },
      ],
    }],
    next24h: { cleaningOver60: [{ bedId: beds[1]!.id, bedCode: "F05-MED-F-B02", wardName: "5B Female", minutes: 75 }], blockedPastReturn: [] },
  };
}

function stubAuth(perms: string[]): void {
  setToken("stub-token");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (raw.startsWith("/api/auth/me")) {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }));
}

beforeEach(() => {
  rt.connected = true; rt.answer = true; rt.pinged = 0; rt.pongs.clear();
  api.getBedBoard.mockReset().mockImplementation(async (wall: boolean) => boardOf(wall));
  api.markBedClean.mockReset();
  api.assignBed.mockReset();
  api.reserveBed.mockReset();
  stubAuth(["ipd.beds.view", "ipd.beds.manage", "ipd.beds.clean"]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setToken(null); });

describe("Beds capacity board (E1.1)", () => {
  it("renders the strip, the floor's wards with a WORD for every dot, the census rules and the live footer", async () => {
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    await screen.findByTestId("ipd-beds-floor");
    expect(api.getBedBoard).toHaveBeenCalledWith(false);
    expect(screen.getByText("Occupied", { selector: ".lbl" })).toBeInTheDocument();
    expect(screen.getByText("50.0 % · 0 reserved")).toBeInTheDocument();
    expect(screen.getByText("Overflow 0 / 1 · not capacity")).toBeInTheDocument();
    expect(screen.getByText("1 over 60 min")).toBeInTheDocument();
    // status in words, never colour alone
    expect(screen.getByRole("img", { name: "F05-MED-F-B02 · Cleaning" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "F05-MED-F-B04 · Incumbent" })).toBeInTheDocument();
    // day care is outside the census and says so
    expect(within(screen.getByTestId("ipd-ward-F05-DC")).getByText(/Not in census/)).toBeInTheDocument();
    expect(screen.getByText("Forecast comes later")).toBeInTheDocument();
    expect(screen.getByText("F05-MED-F-B02 · 75 min")).toBeInTheDocument();
    expect(await screen.findByTestId("ipd-beds-live")).toBeInTheDocument();
  });

  it("the waiting column is the shell with an empty state until admissions arrive", async () => {
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    expect(await screen.findByTestId("ipd-beds-waiting-empty")).toHaveTextContent("No one waiting");
  });

  it("E1.2 — the waiting column lists open admission requests, oldest first, each opening the Admit sheet", async () => {
    const b = boardOf(false);
    api.getBedBoard.mockResolvedValue({
      ...b, totals: { ...b.totals, waiting: { count: 1, longestMinutes: 42 } },
      waiting: [{
        admissionId: id(77), state: "reserved", source: "opd_advice", initials: "R.K.", name: "Ramesh Kumar", requestedClass: "general",
        isolation: "none", icu: false, requestedAt: "2030-01-01T04:30:00.000Z", waitMinutes: 42, reservedBedCode: "F05-MED-F-B03",
      }],
    });
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    const card = await screen.findByTestId("ipd-beds-waiting-card");
    expect(card).toHaveTextContent("Ramesh Kumar");
    expect(card).toHaveTextContent("OPD advice");
    expect(card).toHaveTextContent("42 min");
    expect(card).toHaveTextContent("Held · F05-MED-F-B03");
    expect(screen.queryByTestId("ipd-beds-waiting-empty")).toBeNull();
  });

  describe("E5.2 — Bed Flow's proposal on a waiting card", () => {
    const NEED = { requestedClass: "general" as const, isolation: "none" as const, icu: false };
    const flowBoard = (flow: unknown, wall = false): IpdBedBoard => {
      const b = boardOf(wall);
      return {
        ...b, totals: { ...b.totals, waiting: { count: 1, longestMinutes: 35 } },
        waiting: [{
          admissionId: id(80), state: "requested", source: "direct", initials: "M.S.", name: wall ? null : "Meera Singh", requestedClass: "general",
          isolation: "none", icu: false, requestedAt: "2030-01-01T04:30:00.000Z", waitMinutes: 35, reservedBedCode: null,
          uhid: wall ? "" : "UH-SYN-0080", ...(wall ? {} : { flow }),
        }],
      } as IpdBedBoard;
    };
    const proposal = {
      proposalId: id(81), admissionId: id(80), patientId: id(82), need: NEED, bedId: id(83), bedCode: "F05-MED-F-B03", wardName: "5B Female",
      class: "general", reasons: ["class_requested", "gender_female_bay", "own_department"], department: "MED", freeMinutes: 125,
      proposedAt: "2030-01-01T04:35:00.000Z",
    };

    it("shows the bed, its reasons and the UHID; Confirm calls reserve_bed with the proposal's bed, patient and need", async () => {
      const user = userEvent.setup();
      api.getBedBoard.mockResolvedValue(flowBoard(proposal));
      api.reserveBed.mockResolvedValue({ state: "reserved" });
      renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
      const card = await screen.findByTestId("ipd-beds-flow");
      expect(card).toHaveTextContent("Bed Flow");
      expect(card).toHaveTextContent("F05-MED-F-B03");
      const why = within(card).getByRole("list", { name: "Why this bed" });
      // Codes, worded by the client; "free" is the server's read-time minutes.
      expect(within(why).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Class as requested", "Female bay", "MED ward", "Free 125 min"]);
      expect(screen.getByTestId("ipd-beds-waiting-card")).toHaveTextContent("UH-SYN-0080");
      await user.click(screen.getByRole("button", { name: "Confirm F05-MED-F-B03" }));
      expect(api.reserveBed).toHaveBeenCalledWith({ admissionId: id(80), bedId: id(83), patientId: id(82), need: NEED });
    });

    it("a refused Confirm words the refusal CODE from the locale (never the server's English) and refetches", async () => {
      const user = userEvent.setup();
      api.getBedBoard.mockResolvedValue(flowBoard(proposal));
      api.reserveBed.mockRejectedValue(new ApiError(409, {
        statusCode: 409, code: "bed_not_available", message: "SERVER ENGLISH", bedRule: "SERVER ENGLISH", rule: "SERVER ENGLISH.", fix: "Pick another bed",
      }));
      renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
      await user.click(await screen.findByRole("button", { name: "Confirm F05-MED-F-B03" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Bed just taken — pick another");
      expect(alert).not.toHaveTextContent("SERVER ENGLISH");
      await waitFor(() => expect(api.getBedBoard.mock.calls.length).toBeGreaterThan(1));
    });

    it("an unknown refusal code falls back to the generic line", async () => {
      const user = userEvent.setup();
      api.getBedBoard.mockResolvedValue(flowBoard(proposal));
      api.reserveBed.mockRejectedValue(new ApiError(409, { statusCode: 409, code: "something_new", message: "SERVER ENGLISH", bedRule: "SERVER ENGLISH", rule: "x", fix: "y" }));
      renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
      await user.click(await screen.findByRole("button", { name: "Confirm F05-MED-F-B03" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not hold the bed — try again");
    });

    it("no Confirm without ipd.beds.manage; no proposal says so; the wall shows neither", async () => {
      stubAuth(["ipd.beds.view"]);
      api.getBedBoard.mockResolvedValue(flowBoard(proposal));
      const { unmount } = renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
      await screen.findByTestId("ipd-beds-flow");
      expect(screen.queryByTestId("ipd-beds-flow-confirm")).toBeNull();
      unmount();
      api.getBedBoard.mockResolvedValue(flowBoard(null));
      const second = renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
      expect(await screen.findByTestId("ipd-beds-flow-none")).toHaveTextContent("No free bed passes every rule");
      second.unmount();
      api.getBedBoard.mockImplementation(async (wall: boolean) => flowBoard(proposal, wall));
      renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds?wall=1");
      await screen.findByTestId("ipd-beds-waiting-card");
      expect(screen.queryByTestId("ipd-beds-flow")).toBeNull();
      expect(screen.queryByTestId("ipd-beds-flow-confirm")).toBeNull();
    });
  });

  it("wall mode asks the server for initials only and shows no name and no act", async () => {
    const user = userEvent.setup();
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds?wall=1");
    await screen.findByTestId("ipd-beds-floor");
    expect(api.getBedBoard).toHaveBeenCalledWith(true);
    await user.click(screen.getByTestId("ipd-ward-F05-MED-F"));
    const drawer = await screen.findByTestId("ipd-ward-drawer");
    expect(within(drawer).getByText("S.D.")).toBeInTheDocument();
    expect(screen.queryByText("Sunita Devi")).toBeNull();
    await user.click(within(drawer).getByTestId("ipd-bed-F05-MED-F-B02"));
    expect(within(drawer).queryByRole("button", { name: "Mark clean" })).toBeNull();
  });

  it("WM-1 (#982): on a ward with a live shift map a tile shows its nurse's initials, and red words when nobody holds it", async () => {
    const user = userEvent.setup();
    api.getBedBoard.mockReset().mockImplementation(async (wall: boolean) => {
      const b = boardOf(wall);
      const beds = b.floors[0]!.wards[0]!.beds;
      beds[0] = { ...beds[0]!, nurse: null, nurseMissing: true };
      beds[3] = { ...beds[3]!, nurse: { initials: "A. K." }, nurseMissing: false };
      return b;
    });
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    await user.click(await screen.findByTestId("ipd-ward-F05-MED-F"));
    const drawer = await screen.findByTestId("ipd-ward-drawer");
    const red = await within(drawer).findByTestId("ipd-bed-F05-MED-F-B01");
    expect(red).toHaveClass("no-nurse");
    expect(within(red).getByTestId("ipd-bed-nonurse-F05-MED-F-B01")).toHaveTextContent("No nurse");
    expect(within(drawer).getByTestId("ipd-bed-F05-MED-F-B04")).toHaveTextContent("A. K.");
    expect(within(drawer).getByTestId("ipd-bed-F05-MED-F-B03")).not.toHaveClass("no-nurse");
  });

  it("off the wall the tile carries the name the server sent", async () => {
    const user = userEvent.setup();
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    await user.click(await screen.findByTestId("ipd-ward-F05-MED-F"));
    expect(within(await screen.findByTestId("ipd-ward-drawer")).getByText("Sunita Devi")).toBeInTheDocument();
  });

  it("a refusal shows the bed's rule, the rule sentence and the fix as a button — no dead end", async () => {
    const user = userEvent.setup();
    api.assignBed.mockRejectedValue(new ApiError(409, {
      statusCode: 409, code: "bed_gender_mismatch", message: "Female-only bed", bedRule: "Female-only bed",
      rule: "The bed's gender rule does not admit this patient.", fix: "Pick another bed",
    }));
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    await user.click(await screen.findByTestId("ipd-ward-F05-MED-F"));
    const drawer = await screen.findByTestId("ipd-ward-drawer");
    await waitFor(() => expect(within(drawer).getByTestId("ipd-bed-F05-MED-F-B03")).toBeInTheDocument());
    await user.click(within(drawer).getByTestId("ipd-bed-F05-MED-F-B03"));
    await user.click(await within(drawer).findByRole("button", { name: "Assign" }));
    await user.type(within(drawer).getByLabelText("Patient ID"), id(9));
    await user.type(within(drawer).getByLabelText("Admission ref"), id(8));
    await user.click(within(drawer).getAllByRole("button", { name: "Assign" })[0]!);
    const refusal = await within(drawer).findByTestId("ipd-bed-refusal");
    expect(refusal).toHaveTextContent("Female-only bed");
    expect(refusal).toHaveTextContent("The bed's gender rule does not admit this patient.");
    expect(within(refusal).getByRole("button", { name: "Pick another bed" })).toBeInTheDocument();
    expect(api.assignBed).toHaveBeenCalledWith(expect.objectContaining({
      patientId: id(9), admissionId: id(8), need: { requestedClass: "general", isolation: "none", icu: false },
    }));
  });

  it("says Offline with the last update time when the socket drops", async () => {
    rt.connected = false;
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    await screen.findByTestId("ipd-beds-floor");
    expect(await screen.findByTestId("ipd-beds-offline")).toHaveTextContent(/^Offline · last update \d\d:\d\d$/);
    expect(screen.queryByTestId("ipd-beds-live")).toBeNull();
  });

  it("says Offline within 5 s when the socket stays 'open' but no pong comes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    await screen.findByTestId("ipd-beds-live");
    rt.answer = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(6_500); });
    expect(screen.getByTestId("ipd-beds-offline")).toBeInTheDocument();
  });
});

describe("Beds board — housekeeping's cleaning clocks (E1.4)", () => {
  const CLEAN_BED = "F05-MED-F-B02";
  function withCleans(perms: string[], clean: Record<string, unknown>): { posted: string[]; reads: { n: number } } {
    const posted: string[] = [];
    const reads = { n: 0 };
    const bedId = boardOf(false).floors[0]!.wards[0]!.beds[1]!.id;
    setToken("stub-token");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (raw.startsWith("/api/auth/me")) {
        return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
      }
      if (raw.includes("/housekeeping/bed-cleans")) {
        reads.n += 1;
        return new Response(JSON.stringify({ serverNow: new Date().toISOString(), cleans: [{
          bedId, taskId: "01FAKETASK0000000000000001", kind: "bed_clean_routine", terminal: false, state: "in_progress",
          raisedAt: new Date().toISOString(), dueAt: new Date().toISOString(), minutes: 72, late: true, assigneeInitials: "A. K.",
          escalatedRung: 1, version: 4, ...clean,
        }] }), { status: 200 });
      }
      if (init?.method === "POST") posted.push(raw);
      return new Response(JSON.stringify({ id: "x", state: "verified", version: 5 }), { status: 200 });
    }));
    return { posted, reads };
  }

  it("a cleaning bed says its clock and who has it, and the blockers list nudges housekeeping", async () => {
    // The board's fixture is built from `bed()`, whose ids move with every call: read the ids the screen will see.
    const user = userEvent.setup();
    const fixture = boardOf(false);
    api.getBedBoard.mockReset().mockImplementation(async () => fixture);
    const bedId = fixture.floors[0]!.wards[0]!.beds[1]!.id;
    const { posted, reads } = withCleans(["ipd.beds.view", "ipd.beds.manage", "ipd.beds.clean"], { bedId });
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    expect(await screen.findByRole("img", { name: `${CLEAN_BED} · Cleaning · 72 min · assigned to A. K. · late` })).toBeInTheDocument();
    const slow = await screen.findByTestId("ipd-beds-slow-cleans");
    expect(slow).toHaveTextContent(`${CLEAN_BED} · 72 min · A. K. · late`);
    const before = reads.n;
    await user.click(within(slow).getByRole("button", { name: "Nudge housekeeping" }));
    // The nudge bumped the task's version: the board reads the clocks again.
    await waitFor(() => expect(reads.n).toBeGreaterThan(before));
    expect(posted).toEqual(["/api/housekeeping/cleans/01FAKETASK0000000000000001/nudge"]);
  });

  it("a cleaned bed waiting for its check offers Verify clean (not the hand tap) and frees the bed", async () => {
    const user = userEvent.setup();
    const fixture = boardOf(false);
    api.getBedBoard.mockReset().mockImplementation(async () => fixture);
    const bedId = fixture.floors[0]!.wards[0]!.beds[1]!.id;
    const { posted } = withCleans(["ipd.beds.view", "ipd.beds.clean"], { bedId, state: "done", late: false });
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    await user.click(await screen.findByTestId("ipd-ward-F05-MED-F"));
    const drawer = await screen.findByTestId("ipd-ward-drawer");
    await user.click(within(drawer).getByTestId(`ipd-bed-${CLEAN_BED}`));
    expect(await within(drawer).findByTestId("ipd-bed-clean")).toHaveTextContent("Cleaned · waiting for check");
    expect(within(drawer).queryByRole("button", { name: "Mark clean" })).toBeNull();
    await user.click(within(drawer).getByRole("button", { name: "Verify clean" }));
    expect(await within(drawer).findByText("✓ Clean checked · bed free")).toBeInTheDocument();
    expect(posted).toEqual(["/api/housekeeping/cleans/01FAKETASK0000000000000001/verify"]);
  });
});

describe("Beds board — repair tickets (E1.5)", () => {
  it("a bed blocked by a repair says so in words, offers no hand Unblock, and a fixed repair is confirmed from the drawer", async () => {
    const user = userEvent.setup();
    const blocked = bed("F05-MED-F-B09", {
      status: "blocked", block: { id: id(900), reason: "maintenance", note: "Repair #123: Bed", expectedReturnAt: "2026-01-02T05:00:00.000Z", onRelease: false },
    });
    api.getBedBoard.mockImplementation(async () => {
      const b = boardOf(false);
      b.floors[0]!.wards[0]!.beds.push(blocked);
      return b;
    });
    const posted: string[] = [];
    setToken("stub-token");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") { posted.push(raw); return new Response(JSON.stringify({ id: "k", number: 123, state: "closed", version: 3 }), { status: 200 }); }
      if (raw.startsWith("/api/auth/me")) {
        return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["ipd.beds.view", "ipd.beds.manage", "ipd.beds.clean", "maintenance.raise"], scoped: { department: {}, floor: {} } } }), { status: 200 });
      }
      if (raw.endsWith("/maintenance/bed-tickets")) {
        return new Response(JSON.stringify({ serverNow: "2026-01-01T05:00:00.000Z", tickets: [
          { bedId: blocked.id, ticketId: "k", number: 123, state: "fixed", urgency: "urgent", itemKind: "bed", taskId: "t", blockOnRelease: false },
        ] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    expect(await screen.findByRole("img", { name: "F05-MED-F-B09 · Blocked · repair #123 · fixed, waiting nurse" })).toBeInTheDocument();
    await user.click(screen.getByTestId("ipd-ward-F05-MED-F"));
    await user.click(await screen.findByTestId("ipd-bed-F05-MED-F-B09"));
    const acts = screen.getByTestId("ipd-bed-acts");
    expect(within(acts).getByTestId("ipd-bed-repair")).toHaveTextContent("Blocked · repair #123 · fixed, waiting nurse · Bed · Urgent");
    expect(within(acts).queryByRole("button", { name: "Unblock" })).toBeNull();
    expect(within(acts).getByRole("button", { name: "Report a fault" })).toBeInTheDocument();
    await user.click(within(acts).getByRole("button", { name: "Confirm repair" }));
    expect(await within(acts).findByText(/Repair confirmed/)).toBeInTheDocument();
    expect(posted).toEqual(["/api/maintenance/tickets/k/confirm"]);
  });
});

/*
  IPD walk 2026-10-14 — the board's date was hard-coded en-IN ("Wed, 14 Oct" on a Hindi screen), and the ground floor,
  which holds only day care and emergency, read "0 / 0 beds" above 120 beds marked "Not in census".
*/
describe("Beds — the walk's words", () => {
  afterEach(async () => { await act(async () => { await i18next.changeLanguage("en"); }); });

  it("writes the date in the reader's language", async () => {
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    await screen.findByTestId("ipd-beds-floor");
    const title = (): string => screen.getByRole("heading", { level: 1 }).parentElement!.textContent ?? "";
    expect(title()).toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/);
    await act(async () => { await i18next.changeLanguage("hi"); });
    await waitFor(() => expect(title()).not.toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/));
    expect(title()).toMatch(/(सोम|मंगल|बुध|गुरु|शुक्र|शनि|रवि)/);
  });

  it("says a floor's census beds and its beds outside the census, each by name", async () => {
    const b = boardOf(false);
    const ground = { ...b.floors[0]!, id: id(90), code: "F00", name: "Ground floor", census: { occupied: 0, total: 0 }, wards: [b.floors[0]!.wards[1]!] };
    api.getBedBoard.mockReset().mockResolvedValue({ ...b, floors: [ground, b.floors[0]!] });
    renderWithRouter(<IpdBedsUnderTest />, "/ipd/beds");
    const g = await screen.findByTestId(`ipdb-floorhead-${id(90)}`);
    expect(g).toHaveTextContent("Not in census 1 / 1");
    expect(g).not.toHaveTextContent("0 / 0");
    expect(screen.getByTestId(`ipdb-floorhead-${id(1)}`)).toHaveTextContent("In census 2 / 4 · Not in census 1 / 1");
  });
});
