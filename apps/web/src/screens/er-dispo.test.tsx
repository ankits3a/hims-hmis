import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
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
