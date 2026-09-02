import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyStudy } from "./radiology-study";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => ({ studyId: "S1" }),
}));

/**
 * PLAN 18a T9 — the study console.
 *
 * **The assertion that carries the weight is the waive button.** It is rendered from the row's OWN
 * `waivable` flag, which the server snapshotted at check-in from `gates.ts`'s constant. A
 * client-side list of waivable kinds would be a second copy of a statutory rule, and `form_f` is
 * the entry somebody would eventually add to it — so the test proves the button follows the server
 * and appears on one kind and not the other.
 */
type Reply = { status: number; body: unknown };
const calls: string[] = [];
/** 18b T2 — the bodies posted, keyed like `calls`, so a test can read what the console sent. */
const bodies: Record<string, unknown[]> = {};

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    calls.push(key);
    if (typeof init?.body === "string") (bodies[key] ??= []).push(JSON.parse(init.body));
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

const STUDY = {
  studyId: "S1", accessionNo: "X2608310001", status: "checked_in", priority: "routine",
  studyTypeCode: "USG-OBS-ANOMALY", scheduledAt: null, deviceResourceId: "D1",
  encounterNo: "V2608310001", patientId: "P1", patientName: "Asha Devi",
  formFRequired: true, restricted: true, ionising: false, contrastGiven: false,
  acquiredAt: null, authorisedBy: null, reports: [],
  studyInstanceUid: null, imageSource: null, mintedStudyInstanceUid: "2.25.42", views: [],
};

const READINESS = {
  state: "checked_in", ready: false,
  gates: [
    { id: "g1", kind: "form_f", state: "open", waivable: false },
    { id: "g2", kind: "chaperone_present", state: "open", waivable: true },
  ],
  open: ["chaperone_present", "form_f"],
};

beforeEach(() => { setToken("t"); calls.length = 0; for (const k of Object.keys(bodies)) delete bodies[k]; });
afterEach(() => { vi.unstubAllGlobals(); });

it("renders a WAIVE control only where the SERVER said the gate is waivable", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: STUDY } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: READINESS },
  });
  renderWithProviders(<RadiologyStudy />);

  const chaperone = await screen.findByTestId("gate-chaperone_present");
  expect(chaperone.textContent).toContain("Waive");
  /** `form_f` is not waivable, and the client learned that from the row rather than from a list. */
  const formF = screen.getByTestId("gate-form_f");
  expect(formF.textContent).not.toContain("Waive");
});

/**
 * ═══ F49 (CLOSE REVIEW) — THE FLAG IS NOW A WAY IN, AND THAT IS THE ASSERTION ═══
 *
 * This used to assert a BADGE reading "Form F". The badge was accurate and useless: nothing in the
 * application navigated to `/pcpndt/form-f/$studyId`, so the screen told the technologist a
 * statutory form was required and offered no control that opened one, while `recordAcquired`
 * refused the scan without it. A test for the badge could not tell a working path from a dead end,
 * because the badge is identical either way — so the assertion is on the CONTROL now.
 */
it("F49: the Form F flag is a control that opens the form, not a badge that names a dead end", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: STUDY } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: READINESS },
  });
  renderWithProviders(<RadiologyStudy />);
  const open = await screen.findByRole("button", { name: /form f/i });
  expect(open).toBeInTheDocument();
});

/**
 * The refusal is the product. `form_f_missing` tells a technologist to go and open the register;
 * a re-worded "could not proceed" tells them to press the button again.
 */
it("shows a gate refusal verbatim, with its code", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: STUDY } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: READINESS },
    "POST /api/radiology/studies/S1/gates/form_f/satisfy": {
      status: 422,
      body: {
        statusCode: 422, code: "form_f_missing",
        message: "no Form F has been opened for this study — the PCPNDT register is the only way past this gate",
      },
    },
  });
  renderWithProviders(<RadiologyStudy />);
  const formF = await screen.findByTestId("gate-form_f");
  await userEvent.click(formF.querySelector("button")!);
  expect(await screen.findByRole("alert"))
    .toHaveTextContent(/the PCPNDT register is the only way past this gate.*form_f_missing/);
});

it("says the study is ready when the server reports no open gates", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: { ...STUDY, status: "ready" } } },
    "GET /api/radiology/studies/S1/readiness": {
      status: 200,
      body: { state: "ready", ready: true, gates: [{ id: "g1", kind: "form_f", state: "satisfied", waivable: false }], open: [] },
    },
  });
  renderWithProviders(<RadiologyStudy />);
  expect(await screen.findByRole("status")).toHaveTextContent(/ready/i);
});

/**
 * 18b T2 / D3 / D8 — the console sends the SERVER's minted UID for a PACS acquisition (the value
 * the worklist offered the modality) and sends no UID at all when there are no DICOM images. A
 * client that minted its own would hand the PACS a second identity for one study.
 */
it("18b T2: pre-fills the minted Study Instance UID for a PACS acquisition and omits it for no images", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: { ...STUDY, status: "in_acquisition" } } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: { state: "in_acquisition", ready: true, gates: [], open: [] } },
    "POST /api/radiology/studies/S1/acquisition/acquired": { status: 201, body: { studyId: "S1", accessionNo: "X2608310001", studyInstanceUid: "2.25.42", billDecisionIds: [] } },
  });
  renderWithProviders(<RadiologyStudy />);
  const field = await screen.findByLabelText(/study instance uid/i);
  expect(field).toHaveValue("2.25.42");
  await userEvent.click(screen.getByRole("button", { name: /record acquired/i }));
  expect(bodies["POST /api/radiology/studies/S1/acquisition/acquired"]?.[0])
    .toEqual({ imageSource: "pacs", studyInstanceUid: "2.25.42" });

  await userEvent.click(screen.getByLabelText(/no dicom images/i));
  expect(screen.queryByLabelText(/study instance uid/i)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /record acquired/i }));
  expect(bodies["POST /api/radiology/studies/S1/acquisition/acquired"]?.[1]).toEqual({ imageSource: "no_pacs_images" });
});

it("18b T2: once acquired, the recorded UID is shown and the source choice is gone", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: { ...STUDY, status: "acquired", imageSource: "pacs", studyInstanceUid: "1.2.826.0.1.3680043.9.7.1" } } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: { state: "acquired", ready: true, gates: [], open: [] } },
  });
  renderWithProviders(<RadiologyStudy />);
  expect(await screen.findByTestId("study-uid-recorded")).toHaveTextContent("1.2.826.0.1.3680043.9.7.1");
  expect(screen.queryByLabelText(/study instance uid/i)).not.toBeInTheDocument();
});

/**
 * 18b T3 / D6 — the console asks the SERVER for the viewer URL and opens what comes back; it never
 * builds the link, because the row, the event and the PHI line are written on the way.
 */
it("18b T3: opening the images posts to the door and opens the URL the server returned, in a new tab", async () => {
  const opened = vi.fn();
  vi.stubGlobal("open", opened);
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: { ...STUDY, status: "acquired", imageSource: "pacs", studyInstanceUid: "2.25.42", views: [{ id: "v1", viewerId: "dr.rao", via: "external_pacs", viewedAt: "2026-08-31T09:00:00.000Z" }] } } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: { state: "acquired", ready: true, gates: [], open: [] } },
    "POST /api/radiology/studies/S1/images/open": { status: 201, body: { url: "https://pacs.example.org/viewer?AccessionNumber=X2608310001", viewId: "v2", studyInstanceUid: "2.25.42" } },
  });
  renderWithProviders(<RadiologyStudy />);
  expect(await screen.findByTestId("image-views")).toHaveTextContent(/1.*dr\.rao/);
  await userEvent.click(screen.getByRole("button", { name: /open images/i }));
  expect(calls).toContain("POST /api/radiology/studies/S1/images/open");
  expect(opened).toHaveBeenCalledWith("https://pacs.example.org/viewer?AccessionNumber=X2608310001", "_blank", "noopener,noreferrer");
});

it("18b T3: a refusal from the door is shown with its code, and nothing opens", async () => {
  const opened = vi.fn();
  vi.stubGlobal("open", opened);
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: { ...STUDY, status: "acquired", imageSource: "pacs", studyInstanceUid: "2.25.42" } } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: { state: "acquired", ready: true, gates: [], open: [] } },
    "POST /api/radiology/studies/S1/images/open": { status: 409, body: { statusCode: 409, code: "pacs_not_configured", message: "no viewer is published" } },
  });
  renderWithProviders(<RadiologyStudy />);
  await userEvent.click(await screen.findByRole("button", { name: /open images/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/no viewer is published.*pacs_not_configured/);
  expect(opened).not.toHaveBeenCalled();
});
