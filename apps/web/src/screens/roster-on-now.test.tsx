import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { isoToDmy } from "../components/dmy-date-input";
import { RosterOnNow, answerFromBoard } from "./roster-on-now";
import type { WireAsItStoodBoard, WireDeclarationsView, WireOnNowBoard } from "../lib/roster-api";

/** 02:40 IST on Tuesday 6 October — Monday's unit is still on take until 08:00. */
const AT = "2026-10-05T21:10:00.000Z";

const BOARD: WireOnNowBoard = {
  at: AT, resolverEnabled: true,
  you: { name: "Dr. Anand Rao", grade: "associate_professor", positionKey: "unit_head", unitName: "General Medicine Unit I", departmentName: "General Medicine" },
  departments: [
    {
      departmentId: "d-med", code: "MED", name: "General Medicine", units: 5, source: "published", skeleton: false,
      unitOnTake: { teamId: "u1", code: "MED-U1", name: "General Medicine Unit I", startsAt: "2026-10-05T02:30:00.000Z", endsAt: "2026-10-06T02:30:00.000Z" },
      backupUnit: { teamId: "u5", code: "MED-U5", name: "General Medicine Unit V", startsAt: "2026-10-05T02:30:00.000Z", endsAt: "2026-10-06T02:30:00.000Z" },
      inTheBuilding: [
        { userId: "sr", name: "Dr. Aditi Deshmukh", positionKey: "unit_sr", positionLabel: "Unit senior resident", cadre: "senior_resident", phone: "9876543210" },
        { userId: "jr", name: "Dr. Yusuf Qureshi", positionKey: "ward_jr", positionLabel: "Ward junior resident", cadre: "junior_resident", phone: null },
      ],
      facultyOnCall: [{ userId: "fac", name: "Dr. S. P. Tripathi", positionKey: "faculty_on_call", positionLabel: "Faculty on call", callTier: 1 }],
    },
    {
      departmentId: "d-sur", code: "SUR", name: "General Surgery", units: 5, source: "static", skeleton: true,
      unitOnTake: null, backupUnit: null, inTheBuilding: [], facultyOnCall: [],
    },
  ],
  services: [
    { positionKey: "duty_manager", positionLabel: "Duty manager", cadre: "admin", source: "published", people: [{ userId: "dm", name: "Mr. Alok Srivastava", departmentId: "d-admn" }] },
    { positionKey: "casualty_mo", positionLabel: "Casualty medical officer", cadre: "medical_officer", source: "static", people: [] },
  ],
  holes: [
    {
      kind: "absent_on_duty", departmentId: "d-med", departmentName: "General Medicine", from: "2026-10-05T14:30:00.000Z", to: "2026-10-06T02:30:00.000Z",
      positionKey: "ward_jr", positionLabel: "Ward junior resident", userId: "jr2", name: "Dr. Tanvi Shah", count: null,
    },
    {
      kind: "no_take_cycle", departmentId: "d-sur", departmentName: "General Surgery", from: AT, to: "2026-10-06T21:10:00.000Z",
      positionKey: null, positionLabel: null, userId: null, name: null, count: null,
    },
  ],
};

/** 20-U I1/I5 — what `/roster/declarations` answers; a plain reader may declare nothing. */
const NO_DECLARE: WireDeclarationsView = {
  from: "2026-10-06", to: "2026-11-05", holidays: [], modes: [], departments: [],
  youMay: { holiday: false, hospitalSkeleton: false, departmentSkeleton: false },
};
const MS_DECLARE: WireDeclarationsView = {
  ...NO_DECLARE,
  departments: [{ departmentId: "d-med", code: "MED", name: "General Medicine" }, { departmentId: "d-sur", code: "SUR", name: "General Surgery" }],
  holidays: [{ istDate: "2026-10-20", kind: "gazetted", pattern: "as_sunday", declaredByName: "Dr. Sunita Mishra", declaredAt: AT }],
  modes: [{
    declarationId: "m1", departmentId: "d-sur", departmentName: "General Surgery", mode: "skeleton", istDate: "2026-10-06",
    reason: "Residents' strike from 08:00", declaredByName: "Dr. Sunita Mishra", declaredAt: AT,
    withdrawnAt: null, withdrawnByName: null, withdrawReason: null,
  }],
  youMay: { holiday: true, hospitalSkeleton: true, departmentSkeleton: true },
};

/** 20-U I23 — the board as it stood at 03:10 on Tuesday 29 September, and the correction made since. */
const STOOD: WireAsItStoodBoard = {
  ...BOARD, at: "2026-09-28T21:40:00.000Z", knownAt: "2026-09-28T21:40:00.000Z", holes: [],
  departments: BOARD.departments.map((d) => ({ ...d, inTheBuilding: d.inTheBuilding.map((p) => ({ ...p, phone: null })) })),
  changes: [{
    kind: "correction", periodId: "p1", departmentId: "d-med", departmentName: "General Medicine", at: "2026-10-03T06:30:00.000Z",
    afterTheFact: true, byName: "Dr. Anand Rao", version: 1,
    removed: [{ userId: "jr", name: "Dr. Yusuf Qureshi", positionKey: "ward_jr", positionLabel: "Ward junior resident", startsAt: "2026-09-28T14:30:00.000Z", endsAt: "2026-09-29T02:30:00.000Z" }],
    added: [{ userId: "jr3", name: "Dr. Meera Iyer", positionKey: "ward_jr", positionLabel: "Ward junior resident", startsAt: "2026-09-28T14:30:00.000Z", endsAt: "2026-09-29T02:30:00.000Z" }],
  }],
};

describe("RosterOnNow (20-U U5a)", () => {
  const asked: string[] = [];
  const posted: { url: string; body: unknown }[] = [];
  let declarations: WireDeclarationsView = NO_DECLARE;
  beforeEach(() => {
    setToken("t");
    asked.length = 0;
    posted.length = 0;
    declarations = NO_DECLARE;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      asked.push(raw);
      if (init?.method === "POST" && !raw.endsWith("/copilot/ask")) posted.push({ url: raw, body: JSON.parse(String(init.body ?? "{}")) });
      const body = raw.includes("/roster/declarations") || raw.includes("/roster/holidays") || raw.includes("/roster/modes") ? declarations
        : raw.includes("/roster/as-it-stood") ? STOOD
        : raw.endsWith("/auth/me")
        ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["roster.read"], scoped: { department: {}, floor: {} } } }
        : raw.endsWith("/ops/mode") ? { mode: "normal", since: null, note: null, reportId: null }
          : raw.endsWith("/copilot/ask") ? { answer: { key: "copilot.answer.notUnderstood", params: {} }, source: "none", intent: null }
            : BOARD;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a published department shows its unit on take as the board writes it, the people in the building and the faculty on call", async () => {
    renderWithProviders(<RosterOnNow />);
    const med = await screen.findByTestId("dept-MED");
    // "Unit I" under its department, as OnNow.dc.html draws it — not "General Medicine Unit I".
    expect(med).toHaveTextContent("Unit I");
    expect(med).not.toHaveTextContent("General Medicine Unit I");
    expect(med).toHaveTextContent("Monday's take · till 08:00");
    // Two whole pieces, so the unit column breaks between them and never inside one.
    expect([...screen.getByTestId("till-MED").querySelectorAll(".ro-nowrap")].map((e) => e.textContent?.trim())).toEqual(["Monday's take ·", "till 08:00"]);
    expect(med).toHaveTextContent("SRDr. Aditi Deshmukh");
    expect(med).toHaveTextContent("JRDr. Yusuf Qureshi");
    expect(med).toHaveTextContent("Dr. S. P. Tripathi");
    expect(med).toHaveTextContent("at home · comes in when called");
    expect(med).toHaveTextContent("Unit V is the backup unit");
    expect(within(med).queryByRole("note")).toBeNull();
    // 02:40 — the clock line and its note: the night still belongs to Monday's units.
    expect(screen.getByTestId("on-now-clock")).toHaveTextContent("Tuesday 6 October, 02:40");
    expect(screen.getByTestId("on-now-note")).toHaveTextContent("It is past midnight, and Monday's units are still on take. They hand over at 08:00, not at 12.");
    expect(asked.some((u) => u.endsWith("/api/roster/on-now"))).toBe(true);
  });

  it("D6 — a call button for a person in the building with a number on file, and none without one", async () => {
    renderWithProviders(<RosterOnNow />);
    const med = await screen.findByTestId("dept-MED");
    expect(within(med).getByRole("link", { name: "Call Dr. Aditi Deshmukh" })).toHaveAttribute("href", "tel:9876543210");
    expect(within(med).queryByRole("link", { name: "Call Dr. Yusuf Qureshi" })).toBeNull();
  });

  it("a department with no take cycle says so in plain words, instead of an empty, staffed-looking row", async () => {
    renderWithProviders(<RosterOnNow />);
    const sur = await screen.findByTestId("dept-SUR");
    expect(within(sur).getByRole("note")).toHaveTextContent("General Surgery has no take cycle, so no unit is named as admitting and nobody is listed.");
    expect(sur).toHaveTextContent("No take cycle");
    expect(sur).toHaveTextContent("SKELETON");
    expect(sur).toHaveTextContent("No backup unit is named");
    expect(screen.getByTestId("service-casualty_mo")).toHaveTextContent("No published roster");
    expect(screen.getByTestId("service-duty_manager")).toHaveTextContent("Mr. Alok Srivastava");
  });

  it("is drawn in the Doctor Desk frame, whose menu lists only screens that exist", async () => {
    renderWithProviders(<RosterOnNow />);
    await screen.findByTestId("dept-MED");
    const menu = screen.getByTestId("desk-menu");
    await vi.waitFor(() => expect(within(menu).getByTestId("desk-menu-roster")).toHaveAttribute("href", "/roster/month"));
    expect(within(menu).getByTestId("desk-menu-onNow")).toHaveAttribute("aria-current", "page");
    // My OPD needs opd.consult, which this person does not hold; nothing else is listed.
    expect(within(menu).queryByTestId("desk-menu-myOpd")).toBeNull();
    expect(within(menu).getAllByRole("link")).toHaveLength(2);
    expect(screen.getByTestId("desk-context")).toHaveTextContent("Who is on now");
    // The person's full name and grade, with initials from the name — never the login name or a dot.
    expect(screen.getByTestId("desk-user")).toHaveTextContent("ARDr. Anand Rao · Assoc. Prof");
    expect(screen.getByTestId("desk-user")).not.toHaveTextContent("·Dr");
  });

  it("while the board is loading the header shows a neutral skeleton, not a placeholder glyph", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    renderWithProviders(<RosterOnNow />);
    expect(await screen.findByTestId("desk-user-loading")).toBeInTheDocument();
    expect(screen.getByTestId("desk-user-loading")).toHaveTextContent("");
    expect(screen.queryByTestId("desk-user")).toBeNull();
  });

  it("the paper copy names every department, the people in the building with their numbers, and when it was printed", async () => {
    renderWithProviders(<RosterOnNow />);
    const sheet = await screen.findByTestId("on-now-print");
    expect(sheet).toHaveTextContent("SR Dr. Aditi Deshmukh · 9876543210");
    expect(sheet).toHaveTextContent("General Surgery");
    expect(sheet).toHaveTextContent(/Printed /);
    // The card says what is true: printing is by hand; it does not claim a copy was printed.
    expect(screen.getByTestId("on-now-dark")).toHaveTextContent("It does not print itself yet");
    expect(screen.getByTestId("on-now-dark")).not.toHaveTextContent(/Last printed/);
  });

  it("the ask bar answers from the board when the hospital copilot does not understand", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RosterOnNow />);
    await screen.findByTestId("dept-MED");
    await user.type(screen.getByLabelText("Ask the copilot"), "medicine mein on call kaun hai?{Enter}");
    expect(await screen.findByTestId("desk-ask-answer")).toHaveTextContent("General Medicine: Unit I is on take till 08:00. In the building: SR Dr. Aditi Deshmukh, JR Dr. Yusuf Qureshi. Faculty on call: Dr. S. P. Tripathi.");
    expect(asked.some((u) => u.endsWith("/api/copilot/ask"))).toBe(true);
  });

  it("the board's own answerer: a service by name, and nothing for a question it cannot place", () => {
    const t = (k: string, o?: Record<string, unknown>): string => `${k}${o === undefined ? "" : JSON.stringify(o)}`;
    expect(answerFromBoard("who is the duty manager", BOARD, t)).toContain("rosterOnNow.answer.service");
    expect(answerFromBoard("what is the weather", BOARD, t)).toBeNull();
  });

  it("lists the holes in the next 24 hours as sentences", async () => {
    renderWithProviders(<RosterOnNow />);
    const holes = await screen.findByTestId("on-now-holes");
    expect(holes).toHaveTextContent("General Medicine: Dr. Tanvi Shah (Ward junior resident) is rostered 20:00–08:00 and is on approved leave.");
    expect(holes).toHaveTextContent("General Surgery has no published take cycle");
  });

  it("asks for eight hours ahead when the desk taps it", async () => {
    renderWithProviders(<RosterOnNow />);
    await screen.findByTestId("dept-MED");
    await userEvent.click(screen.getByRole("button", { name: "In 8 hours" }));
    await vi.waitFor(() => expect(asked.some((u) => u.includes("/api/roster/on-now?at="))).toBe(true));
  });

  it("a pinned instant is asked for as given, with no clock buttons", async () => {
    renderWithProviders(<RosterOnNow at={AT} />);
    await screen.findByTestId("dept-MED");
    expect(asked.some((u) => u.includes(`at=${encodeURIComponent(AT)}`))).toBe(true);
    expect(screen.queryByRole("button", { name: "In 8 hours" })).toBeNull();
  });
  it("a plain reader sees no declare card", async () => {
    renderWithProviders(<RosterOnNow />);
    await screen.findByTestId("dept-MED");
    await vi.waitFor(() => expect(asked.some((u) => u.endsWith("/api/roster/declarations"))).toBe(true));
    expect(screen.queryByTestId("declare-card")).toBeNull();
  });

  it("I1 — the medical superintendent declares tomorrow a holiday: day, kind and what closes, in one act", async () => {
    declarations = MS_DECLARE;
    const user = userEvent.setup();
    renderWithProviders(<RosterOnNow />);
    const card = await screen.findByTestId("declare-card");
    // Collapsed: what is already declared, in words.
    expect(card).toHaveTextContent("SKELETON General Surgery");
    expect(card).toHaveTextContent("Residents' strike from 08:00 · Dr. Sunita Mishra");
    expect(card).toHaveTextContent("Gazetted runs as a Sunday");
    await user.click(within(card).getByTestId("declare-open"));
    // The day in Indian order: typed DD-MM-YYYY, sent as YYYY-MM-DD.
    expect(within(card).getByTestId("holiday-day")).toHaveAttribute("placeholder", "DD-MM-YYYY");
    await user.clear(within(card).getByTestId("holiday-day"));
    await user.type(within(card).getByTestId("holiday-day"), "02-10-2099");
    expect(within(card).getByTestId("holiday-day-words")).toHaveTextContent("Fri 2 Oct");
    await user.selectOptions(within(card).getByTestId("holiday-kind"), "declared");
    await user.click(within(card).getByTestId("holiday-pattern-opd_short"));
    await user.click(within(card).getByTestId("holiday-declare"));
    await vi.waitFor(() => expect(posted.map((p) => p.url.replace(/^.*\/api/, ""))).toEqual(["/roster/holidays"]));
    expect(posted[0]!.body).toMatchObject({ kind: "declared", pattern: "opd_short" });
    expect((posted[0]!.body as { istDate: string }).istDate).toBe("2099-10-02");
    expect(await within(card).findByTestId("declare-done")).toHaveTextContent("is declared a holiday.");
  });

  it("I5 — skeleton cover needs a reason, names its department, and can be withdrawn", async () => {
    declarations = MS_DECLARE;
    const user = userEvent.setup();
    renderWithProviders(<RosterOnNow />);
    const card = await screen.findByTestId("declare-card");
    await user.click(within(card).getByTestId("declare-open"));
    await user.click(within(card).getByTestId("declare-tab-skeleton"));
    expect(within(card).getByTestId("skeleton-declare")).toBeDisabled();
    await user.selectOptions(within(card).getByTestId("skeleton-dept"), "d-med");
    expect(within(card).getByTestId("skeleton-declare")).toBeDisabled();
    await user.click(within(card).getByTestId("skeleton-tomorrow"));
    await user.type(within(card).getByTestId("skeleton-reason"), "Residents' strike");
    await user.click(within(card).getByTestId("skeleton-declare"));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.url).toMatch(/\/api\/roster\/modes$/);
    expect(posted[0]!.body).toMatchObject({ departmentId: "d-med", reason: "Residents' strike" });
    await user.click(within(card).getByTestId("withdraw-m1"));
    await user.click(within(card).getByTestId("withdraw-yes-m1"));
    await vi.waitFor(() => expect(posted.map((p) => p.url.replace(/^.*\/api/, ""))).toContain("/roster/modes/m1/withdraw"));
  });

  it("I5 — a strike day's holes are one line per department", async () => {
    const strike: WireOnNowBoard = { ...BOARD, holes: [{
      kind: "skeleton_short", departmentId: "d-sur", departmentName: "General Surgery", from: "2026-10-06T02:30:00.000Z", to: "2026-10-06T14:30:00.000Z",
      positionKey: null, positionLabel: null, userId: null, name: null, count: 14,
    }] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = raw.includes("/roster/declarations") ? NO_DECLARE : raw.endsWith("/auth/me")
        ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["roster.read"], scoped: { department: {}, floor: {} } } }
        : raw.endsWith("/ops/mode") ? { mode: "normal", since: null, note: null, reportId: null } : strike;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderWithProviders(<RosterOnNow />);
    const holes = await screen.findByTestId("on-now-holes");
    expect(holes).toHaveTextContent("General Surgery · skeleton cover — 14 duties uncovered, 08:00–20:00.");
  });

  it("I23 — as it stood: a past instant asked in IST, a historical banner, and the changes since listed beside it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RosterOnNow />);
    await screen.findByTestId("dept-MED");
    await user.click(screen.getByTestId("stood-open"));
    const picker = screen.getByTestId("stood-picker");
    // Owner 2026-10-03: a day is typed and read DD-MM-YYYY, the time 24-hour — never the browser's locale.
    expect(within(picker).getByTestId("stood-day")).toHaveAttribute("placeholder", "DD-MM-YYYY");
    expect(within(picker).getByTestId("stood-day")).toHaveValue(isoToDmy(new Date(Date.now() + 330 * 60_000 - 86_400_000).toISOString().slice(0, 10)));
    expect(within(picker).getByTestId("stood-time")).toHaveAttribute("placeholder", "HH:MM");
    await user.clear(within(picker).getByTestId("stood-day"));
    await user.type(within(picker).getByTestId("stood-day"), "29-09-2026");
    await user.clear(within(picker).getByTestId("stood-time"));
    await user.type(within(picker).getByTestId("stood-time"), "03:10");
    await user.click(within(picker).getByTestId("stood-show"));
    await vi.waitFor(() => expect(asked.some((u) => u.includes(`/api/roster/as-it-stood?at=${encodeURIComponent("2026-09-29T03:10:00+05:30")}`))).toBe(true));
    expect(await screen.findByTestId("stood-banner")).toHaveTextContent("HISTORICAL VIEW");
    expect(screen.getByTestId("stood-banner")).toHaveTextContent("1 change made since is listed under “Changed since” — not applied.");
    expect(screen.getByTestId("on-now-clock")).toHaveTextContent("As it stood: Tuesday 29 September, 03:10");
    // The published version: Dr. Qureshi, as it stood — and no call buttons for a past instant (D6).
    const med = screen.getByTestId("dept-MED");
    expect(med).toHaveTextContent("Dr. Yusuf Qureshi");
    expect(within(med).queryByRole("link")).toBeNull();
    const change = screen.getByTestId("stood-change");
    expect(change).toHaveTextContent("Correction");
    expect(change).toHaveTextContent("AFTER THE FACT");
    expect(change).toHaveTextContent("Off: Dr. Yusuf Qureshi · Ward junior resident · 20:00\u2060–\u206008:00");
    expect(change).toHaveTextContent("On: Dr. Meera Iyer");
    expect(change).toHaveTextContent("Approved by Dr. Anand Rao");
    expect(screen.queryByTestId("on-now-holes")).toBeNull();
    await user.click(screen.getByTestId("stood-close"));
    expect(screen.queryByTestId("stood-banner")).toBeNull();
    expect(await screen.findByTestId("on-now-holes")).toBeInTheDocument();
  });
});
