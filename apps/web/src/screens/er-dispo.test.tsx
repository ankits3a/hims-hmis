import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { ErDesk } from "./er-desk";
import { ErPatient } from "./er-patient";

/**
 * ER lane 5 (#812) — the ER patient's "Disposition" panel: the discharge summary posts with its return-if signs and the
 * decision's reason; "cannot pay" is not a referral reason anyone can pick; a waiting patient's only way out is "left".
 * Server stubbed.
 */
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const EP = "01J00000000000000000000P01";
const ME = { actor: { type: "user", id: "me" }, permissions: { hospital: ["er.board.view", "er.care", "er.disposition"], scoped: { department: {}, floor: {} } } };
const tile = (state: string) => ({
  episodeId: EP, episodeNo: "ER26-000101", label: "Ramesh Prasad", labelHi: null, uhid: "HMS0000101", sex: "male", ageBand: null, ageYears: 52,
  state, arrivalMode: "walk_in", arrivedAt: new Date().toISOString(), triageDueAt: null, chips: [], esi: state === "arrived" ? null : 3, bayCode: "ER-Y2",
  doctor: "Dr Ritu", doctorDueAt: null, retriageDueAt: null, ews: null,
});

describe("ER lane 5 (#812) disposition panel", () => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  let state = "in_treatment";
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    state = "in_treatment";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push({ url: raw, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return json({ episodeId: EP, state: "departed", outcome: "discharged", departedAt: new Date().toISOString(), bayReleased: "b1" });
      }
      if (raw.includes("/er/care/")) return json({ episodeId: EP, stabilisedAt: null, allergyWords: [], notes: [], orders: [], meds: [], procedures: [], consents: [], calls: [], criticals: [] });
      if (raw.includes("/er/episodes/")) return json({ tile: tile(state), ageYears: 52, complaint: null, history: [] });
      if (raw.endsWith("/er/triage-doctors")) return json([{ userId: "d1", name: "Dr Ritu" }]);
      if (raw.endsWith("/auth/me")) return json(ME);
      return json([]);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("discharge needs the reason, the diagnosis, the treatment and at least one return-if sign — then posts the summary", async () => {
    renderWithRouter(<ErPatient />, `/er/patient?episode=${EP}`);
    await userEvent.click(await screen.findByTestId("er-patient-bar-dispo"));
    const form = screen.getByTestId("er-patient-dispoform");
    const go = within(form).getByTestId("er-patient-discharge");
    await userEvent.type(within(form).getByLabelText("Diagnosis"), "Acute gastroenteritis");
    await userEvent.type(within(form).getByLabelText("Treatment given"), "IV fluids");
    await userEvent.type(within(form).getByLabelText("Medicines (one per line)"), "ORS · 1 sachet · after each stool");
    await userEvent.click(within(form).getByRole("button", { name: "Repeated vomiting" }));
    expect(go).toBeDisabled();
    await userEvent.type(within(form).getByLabelText("Why (the decision)"), "Tolerating orally");
    expect(go).toBeEnabled();
    await userEvent.click(go);
    expect(posted[0]!.url).toContain("/er/dispo/discharge");
    expect(posted[0]!.body).toMatchObject({
      episodeId: EP, reason: "Tolerating orally",
      summary: { diagnosis: "Acute gastroenteritis", treatmentGiven: "IV fluids", returnIf: ["repeated_vomiting"], medicines: [{ name: "ORS", dose: "1 sachet", frequency: "after each stool" }] },
    });
    expect(document.body.textContent ?? "").not.toMatch(/₹|paid|deposit|bill|price/i);
  });

  it("'cannot pay' is not a referral reason on the screen", async () => {
    renderWithRouter(<ErPatient />, `/er/patient?episode=${EP}`);
    await userEvent.click(await screen.findByTestId("er-patient-bar-dispo"));
    const form = screen.getByTestId("er-patient-dispoform");
    await userEvent.click(within(form).getByRole("button", { name: "Refer out" }));
    expect(within(form).getByRole("button", { name: "Specialty not here" })).toBeInTheDocument();
    expect(form.textContent ?? "").not.toMatch(/pay/i);
  });

  it("a patient still waiting for triage can only be recorded as having left (or died)", async () => {
    state = "arrived";
    renderWithRouter(<ErPatient />, `/er/patient?episode=${EP}`);
    await userEvent.click(await screen.findByTestId("er-patient-bar-dispo"));
    const form = screen.getByTestId("er-patient-dispoform");
    expect(within(form).queryByRole("button", { name: "Discharge" })).toBeNull();
    expect(within(form).getByTestId("er-patient-lwbs")).toBeInTheDocument();
    expect(within(form).queryByTestId("er-patient-abscond")).toBeNull();
  });
});

describe("ER lane 5 (#812) the ER desk's 'left unseen'", () => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  const row = (state: string, id: string) => ({
    episodeId: id, episodeNo: `ER26-0001${id.slice(-2)}`, patientId: "01J00000000000000000000009", uhid: "HMS0000090", name: `Patient ${id.slice(-2)}`, nameHi: null,
    unidentified: false, sex: "female", ageBand: null, ageYears: 37, state, arrivalMode: "walk_in", arrivedAt: new Date().toISOString(),
    registeredAt: new Date().toISOString(), returnedWithin24h: false, band: null, identity: null,
  });
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") { posted.push({ url: raw, body: JSON.parse(String(init.body)) as Record<string, unknown> }); return json({ outcome: "lwbs" }); }
      if (raw.endsWith("/er/desk")) return json({ generatedAt: new Date().toISOString(), expected: [], episodes: [row("arrived", "01J000000000000000000000E1"), row("in_treatment", "01J000000000000000000000E2")] });
      if (raw.endsWith("/auth/me")) return json({ actor: { type: "user", id: "me" }, permissions: { hospital: ["er.board.view", "er.arrival.register", "er.disposition"], scoped: { department: {}, floor: {} } } });
      return json([]);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a waiting patient can be recorded as left without being seen; a patient with the doctor cannot", async () => {
    renderWithRouter(<ErDesk />, "/er/desk");
    const rows = await screen.findAllByTestId("er-desk-row");
    expect(within(rows[1]!).queryByTestId("er-desk-lwbs-open")).toBeNull();
    await userEvent.click(within(rows[0]!).getByTestId("er-desk-lwbs-open"));
    await userEvent.click(within(rows[0]!).getByTestId("er-desk-lwbs-save"));
    expect(posted[0]!.url).toContain("/er/dispo/lwbs");
    expect(posted[0]!.body).toMatchObject({ episodeId: "01J000000000000000000000E1" });
    expect(typeof posted[0]!.body.lastSeenAt).toBe("string");
  });
});

describe("ER lane 5 (#812) review: abscond asks 'searched?', a lost hand-off retries under the same key", () => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  let lose = 0;
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    lose = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push({ url: raw, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        if (lose > 0) { lose -= 1; throw new TypeError("network"); }
        return json({ episodeId: EP, admissionId: "a1", boarding: true, outcome: "absconded", policeToBeInformed: false });
      }
      if (raw.includes("/er/care/")) return json({ episodeId: EP, stabilisedAt: null, allergyWords: [], notes: [], orders: [], meds: [], procedures: [], consents: [], calls: [], criticals: [] });
      if (raw.includes("/er/episodes/")) return json({ tile: tile("in_treatment"), ageYears: 52, complaint: null, history: [] });
      if (raw.endsWith("/er/triage-doctors")) return json([{ userId: "d1", name: "Dr Ritu" }]);
      if (raw.endsWith("/auth/me")) return json(ME);
      return json([]);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("abscond stays disabled until 'searched?' is answered, and posts the answer", async () => {
    renderWithRouter(<ErPatient />, `/er/patient?episode=${EP}`);
    await userEvent.click(await screen.findByTestId("er-patient-bar-dispo"));
    const form = screen.getByTestId("er-patient-dispoform");
    await userEvent.click(within(form).getByRole("button", { name: "Left" }));
    const when = form.querySelector("input[type='datetime-local']") as HTMLInputElement;
    await userEvent.type(when, "2026-10-15T10:30");
    const btn = within(form).getByTestId("er-patient-abscond");
    expect(btn).toBeDisabled();
    await userEvent.click(within(form).getByRole("button", { name: "Not searched" }));
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(posted[0]!.body).toMatchObject({ episodeId: EP, searched: false });
  });

  it("a hand-off whose request was lost is retried with the same idempotency key", async () => {
    lose = 1;
    renderWithRouter(<ErPatient />, `/er/patient?episode=${EP}`);
    await userEvent.click(await screen.findByTestId("er-patient-bar-dispo"));
    const form = screen.getByTestId("er-patient-dispoform");
    await userEvent.click(within(form).getByRole("button", { name: "Admit" }));
    await userEvent.type(within(form).getByLabelText("Why (the decision)"), "Needs ward");
    await userEvent.selectOptions(within(form).getByLabelText("Admitting consultant"), "d1");
    await userEvent.type(within(form).getByLabelText("Provisional diagnosis"), "CAP");
    const go = within(form).getByTestId("er-patient-admit");
    await userEvent.click(go);
    await userEvent.click(await within(screen.getByTestId("er-patient-dispoform")).findByTestId("er-patient-admit"));
    expect(posted).toHaveLength(2);
    expect(posted[1]!.body.idempotencyKey).toBe(posted[0]!.body.idempotencyKey);
  });
});
