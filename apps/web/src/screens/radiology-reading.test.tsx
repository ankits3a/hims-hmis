import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyReading, structureDictation } from "./radiology-reading";

/**
 * PLAN 18-S RS8a T4/T5 — the reading room: one list sorted by urgency with the TAT clocks; the
 * study in hand with its lane; the checks are the SERVER's dry run and gate the one act in the
 * dock; the second factor is asked only when the sign route says so; the print names the signer.
 */
type Reply = { status: number; body: unknown } | ((body: unknown) => { status: number; body: unknown });
const calls: { key: string; body: unknown }[] = [];

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const body = init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body });
    const h = handlers[key];
    if (key === "GET /api/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-rad" }, permissions: { hospital: ["radiology.reports.write"], scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (h === undefined) return new Response("{}", { status: 404 });
    const reply = typeof h === "function" ? h(body) : h;
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

const NOW = Date.now();
const iso = (minsFromNow: number) => new Date(NOW + minsFromNow * 60_000).toISOString();
const row = (over: Record<string, unknown>) => ({
  studyId: "S1", accessionNo: "X1", status: "acquired", priority: "routine", studyTypeCode: "USG-ABDO",
  studyTypeName: "USG whole abdomen", modality: "usg", bodyPart: "abdomen", patientId: "P1", patientName: "Asha Devi",
  patientSex: "female", patientAge: 30, restricted: false, formFRequired: false, acquiredAt: iso(-60),
  tatClass: "opd", targetMinutes: 1440, dueAt: iso(1380), reportState: "none", readingBy: null, ...over,
});

const CTX = {
  studyId: "S1", accessionNo: "X1", status: "acquired", priority: "stat", studyTypeCode: "USG-THY",
  studyTypeName: "USG thyroid", modality: "usg", laterality: "na", bedsideLocation: null, acquiredAt: iso(-10),
  tatClass: "stat", targetMinutes: 30, dueAt: iso(20), clinicalQuestion: "Neck swelling, left",
  referrer: { doctorCode: "DR-0114", department: "General Surgery" },
  patient: { id: "P1", name: "Asha Devi", uhid: "HMS-00000001-5", sex: "female", age: 30, flags: ["pcpndt"] },
  priors: [{ studyId: "S0", studyTypeName: "USG neck", signedAt: "2026-02-14T06:00:00.000Z", impression: "Normal thyroid.", criticalCategory: null }],
  cumulativeDlp12m: null, canOpenImages: true,
  templates: [{
    key: "usg_thyroid_tirads", name: "USG thyroid (ACR TI-RADS)", governed: true,
    sections: [
      { key: "technique", label: "Technique", normal: "Linear probe." },
      { key: "findings", label: "Findings", normal: "Both lobes normal." },
      { key: "impression", label: "Impression", normal: "Normal thyroid ultrasound." },
      { key: "recommendation", label: "Recommendation", normal: null },
    ],
    macros: [], coded: [{ system: "tirads", required: true }],
  }],
  defaultTemplateKey: "usg_thyroid_tirads", working: null, signed: null, readingBy: null,
};

beforeEach(() => { setToken("t"); calls.length = 0; });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("the worklist: one list sorted by urgency — STAT first — with its clock, the derived lock, and a sort, not filter tabs", async () => {
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [
      row({ studyId: "S1", patientName: "Routine Ram", dueAt: iso(600) }),
      row({ studyId: "S2", patientName: "Stat Sita", priority: "stat", tatClass: "stat", targetMinutes: 30, dueAt: iso(-5), readingBy: { userId: "u2", name: "Dr Mehta", since: iso(-3) } }),
      row({ studyId: "S3", patientName: "Table Tara", acquiredAt: null, dueAt: null }),
    ] } },
  });
  renderWithProviders(<RadiologyReading studyId={null} />);
  const wl = await screen.findByTestId("reading-worklist");
  await waitFor(() => expect(within(wl).getAllByRole("button").length).toBe(3));
  const names = within(wl).getAllByRole("button").map((b) => b.textContent ?? "");
  expect(names[0]).toContain("Stat Sita");
  expect(names[0]).toMatch(/5 min over/);
  expect(names[0]).toContain("Dr Mehta is reading");
  expect(names[1]).toContain("Routine Ram");
  expect(names[2]).toContain("Table Tara");
  expect(names[2]).toContain("images not in yet");
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(screen.getAllByTestId("reading-sort")[0]).toBeInTheDocument();
});

it("the study in hand: the lane shows the clinical question, the referrer as Doctor ID + department, the priors", async () => {
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [row({})] } },
    "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: CTX } },
    "POST /api/radiology/studies/S1/reports/checks": { status: 200, body: { findings: [], signable: true } },
  });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  expect(await screen.findByTestId("clinical-question")).toHaveTextContent("Neck swelling, left");
  expect(screen.getByText(/Referred by DR-0114 · General Surgery/)).toBeInTheDocument();
  expect(within(screen.getByTestId("priors")).getByText("Normal thyroid.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Classic report screen/ })).toHaveAttribute("href", "/radiology/studies/S1/report");
});

it("the checks are the server's dry run: a refusal leaves the dock dead, and the text sent is what is on screen", async () => {
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [row({})] } },
    "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: CTX } },
    "POST /api/radiology/studies/S1/reports/checks": (b) => ({
      status: 200,
      body: (b as { impression?: string }).impression === ""
        ? { findings: [{ code: "impression_required", level: "refuse", words: "The impression is empty." }], signable: false }
        : { findings: [], signable: true },
    }),
  });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  const checks = await screen.findByTestId("checks");
  await waitFor(() => expect(within(checks).getByText(/The impression is empty/)).toBeInTheDocument());
  expect(screen.getByTestId("dock-act")).toBeDisabled();

  await userEvent.click(screen.getByTestId("insert-normal"));
  await waitFor(() => expect(within(screen.getByTestId("checks")).getByTestId("checks-clear")).toBeInTheDocument(), { timeout: 3000 });
  expect(screen.getByTestId("dock-act")).toBeEnabled();
  const last = calls.filter((c) => c.key === "POST /api/radiology/studies/S1/reports/checks").at(-1)!.body as { impression: string; body: Record<string, string> };
  expect(last.impression).toBe("Normal thyroid ultrasound.");
  expect(last.body.findings).toBe("Both lobes normal.");
});

it("a warning must be ticked before the dock signs, and the tick travels as the acknowledgement; sign then publish", async () => {
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [row({})] } },
    "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: { ...CTX, templates: [{ ...CTX.templates[0], coded: [] }] } } },
    "POST /api/radiology/studies/S1/reports/checks": { status: 200, body: { findings: [{ code: "critical_term", level: "warn", words: "Critical terms found: \"pneumothorax\"." }], signable: true } },
    "POST /api/radiology/studies/S1/reports/draft": { status: 201, body: { reportId: "R1", version: 1 } },
    "POST /api/radiology/studies/S1/reports/sign": { status: 201, body: { reportId: "R2", version: 2 } },
    "POST /api/radiology/studies/S1/reports/publish": { status: 201, body: { reportId: "R2", version: 2, notified: false } },
  });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  await screen.findByTestId("ack-critical_term");
  expect(screen.getByTestId("dock-act")).toBeDisabled();
  await userEvent.click(screen.getByTestId("ack-critical_term"));
  await waitFor(() => expect(screen.getByTestId("dock-act")).toBeEnabled());
  await userEvent.click(screen.getByTestId("dock-act"));
  expect(await screen.findByRole("status")).toHaveTextContent("Signed and published.");
  const sign = calls.find((c) => c.key === "POST /api/radiology/studies/S1/reports/sign")!;
  expect(sign.body).toEqual({ reportId: "R1", criticalCategory: null, acknowledgedWarnings: ["critical_term"] });
  expect(calls.map((c) => c.key)).toContain("POST /api/radiology/studies/S1/reports/publish");
});

it("second factor: only when the sign route asks, the dock takes the authenticator code, verifies the SESSION, and signs", async () => {
  let signs = 0;
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [row({})] } },
    "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: { ...CTX, templates: [{ ...CTX.templates[0], coded: [] }] } } },
    "POST /api/radiology/studies/S1/reports/checks": { status: 200, body: { findings: [], signable: true } },
    "POST /api/radiology/studies/S1/reports/draft": { status: 201, body: { reportId: "R1", version: 1 } },
    "POST /api/radiology/studies/S1/reports/sign": () => {
      signs += 1;
      return signs === 1
        ? { status: 403, body: { statusCode: 403, message: "second_factor_required", error: "Forbidden" } }
        : { status: 201, body: { reportId: "R2", version: 2 } };
    },
    "POST /api/auth/totp/verify": { status: 204, body: null },
    "POST /api/radiology/studies/S1/reports/publish": { status: 201, body: { reportId: "R2", version: 2, notified: true } },
  });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  expect(screen.queryByTestId("totp")).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId("dock-act")).toBeEnabled());
  await userEvent.click(screen.getByTestId("dock-act"));
  await userEvent.type(await screen.findByTestId("totp"), "123456");
  await userEvent.click(screen.getByTestId("dock-act"));
  await screen.findByText(/Signed and published — the patient's message is queued/);
  expect(calls.find((c) => c.key === "POST /api/auth/totp/verify")!.body).toEqual({ code: "123456" });
  /** The code never travels with the report. */
  for (const c of calls.filter((x) => x.key.includes("/reports/"))) expect(JSON.stringify(c.body ?? {})).not.toContain("123456");
});

it("the TI-RADS widget adds the ACR points live, and 'Use' records the category with its inputs", async () => {
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [row({})] } },
    "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: CTX } },
    "POST /api/radiology/studies/S1/reports/checks": { status: 200, body: { findings: [], signable: true } },
  });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  const w = await screen.findByTestId("coded-tirads");
  await userEvent.selectOptions(within(w).getByLabelText(/^Echogenicity/), "hypo");
  expect(within(w).getByTestId("tirads-result")).toHaveTextContent("4 points = TR4");
  await userEvent.click(within(w).getByTestId("tirads-use"));
  await waitFor(() => {
    const last = calls.filter((c) => c.key === "POST /api/radiology/studies/S1/reports/checks").at(-1)!.body as { body: { coded?: { tirads?: { value: string } } } };
    expect(last.body.coded?.tirads?.value).toBe("TR4");
  }, { timeout: 3000 });
});

it("the print preview names the signer in full and the referrer by Doctor ID only (ruling 4)", async () => {
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [row({ reportState: "signed" })] } },
    "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: { ...CTX, signed: { reportId: "R2", version: 2, publishedAt: iso(-1) } } } },
    "GET /api/radiology/reports/R2/print": { status: 200, body: { report: {
      reportId: "R2", version: 2, status: "signed", accessionNo: "X1", studyTypeName: "USG thyroid", acquiredAt: iso(-10),
      signedAt: iso(-2), amendmentReason: null, letterhead: { name: "CRK Hospital", addressLines: ["Hajipur"] },
      patient: { name: "Asha Devi", uhid: "HMS-00000001-5", sex: "female", age: 30 },
      referrer: { doctorCode: "DR-0114", department: "General Surgery" },
      sections: [{ key: "findings", label: "Findings", text: "1.6 cm solid hypoechoic nodule, left lobe." }],
      impression: "Left thyroid nodule, TR4.", codedLines: ["ACR TI-RADS TR4 — Moderately suspicious — FNA if ≥ 1.5 cm, follow up if ≥ 1.0 cm"],
      criticalCategory: null, signerId: "u-rad",
      signer: { userId: "u-rad", name: "Dr Anjali Mehta", qualification: "MBBS, MD (Radiodiagnosis)", designation: "Consultant Radiologist", councilRegNo: "JSMC 2014/1187", councilRegSource: "signatories", doctorCode: "DR-0602", signature: { method: "totp_second_factor", secondFactorAt: iso(-3), keyId: "totp:abcd", contentSha256: "f".repeat(64) } },
    } } },
  });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  await userEvent.click(await screen.findByTestId("print-toggle"));
  const signer = await screen.findByTestId("print-signer");
  expect(signer).toHaveTextContent("Dr Anjali Mehta");
  expect(signer).toHaveTextContent("MBBS, MD (Radiodiagnosis) · Consultant Radiologist");
  expect(signer).toHaveTextContent("JSMC 2014/1187");
  expect(signer).toHaveTextContent(/Electronically signed/);
  expect(screen.getByTestId("print-referrer")).toHaveTextContent("DR-0114 · General Surgery");
  expect(screen.getByTestId("print-coded")).toHaveTextContent("ACR TI-RADS TR4");
});

it("dictation is placed by the headings the reader spoke — rule-built, no model", () => {
  expect(structureDictation("Findings: 1.6 cm nodule, left lobe. Impression: TR4 nodule. Recommendation: FNA.", ["findings", "impression", "recommendation"]))
    .toEqual({ findings: "1.6 cm nodule, left lobe.", impression: "TR4 nodule.", recommendation: "FNA." });
  expect(structureDictation("no headings at all", ["findings", "impression"])).toEqual({ findings: "no headings at all" });
});
