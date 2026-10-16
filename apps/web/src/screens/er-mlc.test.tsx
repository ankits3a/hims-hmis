import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { ErMlc } from "./er-mlc";
import { ErPatient } from "./er-patient";
import type { ErMlcDesk, ErMlcDetail, ErMlcRow } from "@hmis/contracts";

/**
 * ER lane 4 (#811) — the MLC desk (owed clocks in words, the intimation form, two staff on a belongings list, no money)
 * and the ER patient's "MLC" bar button. Server stubbed.
 */
const NOW = Date.now();
const iso = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const MLC = "01J00000000000000000000M01";
const row: ErMlcRow = {
  mlcId: MLC, mlcNo: "MLC26-000007", episodeId: "01J00000000000000000000E01", episodeNo: "ER26-000101", patientId: "01J00000000000000000000P01",
  patientLabel: "Suresh Yadav", uhid: "HMS0000101", category: "assault", openedAt: iso(-85), openedByRule: false, late: false, freeByLaw: false,
  pocso: false, episodeState: "in_treatment",
  intimation: { dueAt: iso(-25), metAt: null, breached: true },
  countersign: { dueAt: iso(24 * 60 - 85), metAt: null, breached: false },
};
const DESK: ErMlcDesk = { owed: [row], recent: [], serverNow: iso(0) };
const DETAIL: ErMlcDetail = {
  ...row, openedBy: { userId: "d1", name: "Dr Ritu" }, informant: { name: "Ramesh", relation: "brother", words: "Hit with a stick near the market." },
  injuries: [{ site: "left forearm", kind: "contusion" }], originalCategory: "assault", addenda: [], intimationRecord: null, countersignedBy: null,
  custody: [], mortuaryEntryId: null,
};
const ME = { actor: { type: "user", id: "me" }, permissions: { hospital: ["er.board.view", "er.care", "er.mlc"], scoped: { department: {}, floor: {} } } };

describe("ER lane 4 (#811) MLC desk", () => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") { posted.push({ url: raw, body: JSON.parse(String(init.body)) as Record<string, unknown> }); return json({ withinTarget: false, custodyId: "c1", mlcId: MLC, mlcNo: "MLC26-000008", late: false }); }
      if (raw.includes(`/er/mlc/${MLC}`)) return json(DETAIL);
      if (raw.endsWith("/er/mlc")) return json(DESK);
      if (raw.endsWith("/auth/me")) return json(ME);
      return json([]);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists what is owed with both clocks in words, opens the case, and records the intimation — no money anywhere", async () => {
    renderWithRouter(<ErMlc />, "/er/mlc");
    const r = await screen.findByTestId("er-mlc-row");
    expect(within(r).getByTestId("er-mlc-intimation")).toHaveTextContent("Police intimation: overdue 25 min");
    expect(within(r).getByTestId("er-mlc-countersign")).toHaveTextContent("Countersign: due in 22 h");
    expect(r).toHaveTextContent("MLC26-000007");
    await userEvent.click(r);
    const form = await screen.findByTestId("er-mlc-intimation-form");
    expect(screen.getByTestId("er-mlc-case")).toHaveTextContent("Hit with a stick near the market.");
    const save = within(form).getByTestId("er-mlc-intimate");
    expect(save).toBeDisabled();
    await userEvent.type(within(form).getByLabelText("Police station"), "PS Kotwali");
    await userEvent.type(within(form).getByLabelText("Officer"), "HC Ram Singh");
    await userEvent.type(within(form).getByLabelText("GD entry no."), "17");
    await userEvent.click(save);
    expect(posted[0]!.url).toContain("/er/mlc/intimation");
    expect(posted[0]!.body).toMatchObject({ mlcId: MLC, mode: "written", station: "PS Kotwali", receiverName: "HC Ram Singh", gdEntryNo: "17" });
    expect(await screen.findByRole("status")).toHaveTextContent("Intimation recorded (late)");
    expect(document.body.textContent ?? "").not.toMatch(/₹|paid|deposit|bill|price/i);
  });

  it("a belongings list needs a second person's username and PIN before it saves", async () => {
    renderWithRouter(<ErMlc />, `/er/mlc?mlc=${MLC}`);
    const form = await screen.findByTestId("er-mlc-custody-form");
    const save = within(form).getByTestId("er-mlc-belongings-save");
    await userEvent.type(within(form).getByLabelText("Items (one per line)"), "Mobile phone{enter}Wallet");
    await userEvent.type(within(form).getByLabelText("Locker no. or name"), "ER locker 4");
    expect(save).toBeDisabled();
    await userEvent.type(within(form).getByLabelText("Second person (username)"), "er.desk2");
    await userEvent.type(within(form).getByLabelText("Their PIN"), "2468");
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(posted[0]!.url).toContain("/er/mlc/belongings");
    expect(posted[0]!.body).toMatchObject({
      mlcId: MLC, items: [{ description: "Mobile phone", qty: 1 }, { description: "Wallet", qty: 1 }],
      keptIn: { kind: "locker", ref: "ER locker 4" }, secondPerson: { username: "er.desk2", pin: "2468" },
    });
  });
});

describe("ER lane 4 (#811) the ER patient's MLC button", () => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  const EP = "01J00000000000000000000P01";
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") { posted.push({ url: raw, body: JSON.parse(String(init.body)) as Record<string, unknown> }); return json({ mlcId: MLC, mlcNo: "MLC26-000008", late: false }); }
      if (raw.includes("/er/care/")) return json({ episodeId: EP, stabilisedAt: null, allergyWords: [], notes: [], orders: [], meds: [], procedures: [], consents: [], calls: [], criticals: [] });
      if (raw.endsWith("/auth/me")) return json(ME);
      return json([]);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("opens the MLC with a category tap and the informant's own words", async () => {
    renderWithRouter(<ErPatient />, `/er/patient?episode=${EP}`);
    await userEvent.click(await screen.findByTestId("er-patient-bar-mlc"));
    const form = screen.getByTestId("er-patient-mlcform");
    const open = within(form).getByTestId("er-patient-mlc-open");
    expect(open).toBeDisabled();
    await userEvent.click(within(form).getByRole("button", { name: "Road accident" }));
    await userEvent.type(within(form).getByLabelText("Informant"), "Bystander");
    await userEvent.type(within(form).getByLabelText("Relation"), "none");
    await userEvent.type(within(form).getByLabelText("What happened (their words)"), "Truck hit the scooter.");
    await userEvent.click(open);
    expect(posted[0]!.url).toContain("/er/mlc/open");
    expect(posted[0]!.body).toMatchObject({ episodeId: EP, category: "road_accident", informant: { name: "Bystander", relation: "none", words: "Truck hit the scooter." } });
    expect(await screen.findByRole("status")).toHaveTextContent("MLC MLC26-000008 opened");
  });
});
