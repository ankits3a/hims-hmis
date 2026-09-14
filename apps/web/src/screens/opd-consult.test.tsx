import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { todayIst } from "../lib/opd-api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import { renderWithProviders, stubFetch } from "../test-utils";
import { OpdConsult } from "./opd-consult";

/**
 * PLAN 07d T6 — the screen gained ONE router component (`<Link to="/my-day">`), and a `<Link>`
 * needs a `RouterProvider` that `renderWithProviders` does not build. The house convention is to
 * mock `@tanstack/react-router` down to exactly what the screen uses — and the factory returns ONLY
 * what it lists, which is why this is the one entry and why adding a second router import to this
 * screen means adding it here too.
 *
 * A plain `<a href>` would have avoided the mock and was rejected: it is a full browser page load,
 * and reloading the whole bundle mid-consultation to look at a brief is a worse trade than one line
 * of test scaffolding (11g / DD1 records the same reasoning for the shell's own nav).
 */
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

// 2026-08-18T04:00:00.000Z + 5:30 = 2026-08-18 09:30 IST (the T12/T13/T14 pin).
const NOW_ISO = "2026-08-18T04:00:00.000Z";
const TODAY = "2026-08-18";

/**
 * jsdom ships no WebSocket a test can drive (flag ⑮), so the transport is replaced by this fake and
 * restored in afterEach. Copied deliberately from the opd-desk / opd-vitals precedent — a test file
 * is self-contained and never imports another *.test.tsx.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  simulateMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

// ——— fixtures ———

const DOCTOR = {
  id: "doc-1", userId: "u-1", displayName: "Dr Meera Rao", registrationNo: "BMC/12345", departmentId: "dep-1",
  specialty: "General", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
};

const CONFIG = {
  slotMinutes: 10, followUpDefaultDays: 7, followUpExtensionDays: [15, 21, 30],
  extensionCapPerDoctorPerMonth: 2, maxSkipsBeforeLeft: 3, perkEveryNth: null, dangerRanges: {},
  letterhead: { name: "CRK MEDICAL COLLEGE & HOSPITAL", addressLines: ["CHAURASIA CHOWK, HAJIPUR, BIHAR 844101"] },
};

const SESSION = {
  id: "sess-1", doctorId: "doc-1", serviceDate: TODAY, roomId: "room-1", status: "in",
  nextToken: 8, callsMade: 1, openedAt: NOW_ISO, closedAt: null, createdAt: NOW_ISO,
};

function summary(id: string, uhid: string, name: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestedId: id, id, uhid, name, alias: null, restricted: false, administrativeGender: "female", dob: "1992-03-04", ...over };
}

function entry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "qe-1", seq: 1, sessionId: "sess-1", encounterId: "enc-1", tokenNo: 5, kind: "walk_in",
    appointmentAt: null, status: "waiting", danger: false, reEntry: false, perk: false,
    eligibleAt: null, calledAt: null, callCount: 0, skips: 0, doneAt: null, createdAt: NOW_ISO,
    parkedAt: null, parkedBy: null, skipReason: null, skipNote: null, skippedAt: null,
    position: 1, queueClass: 3,
    encounter: { id: "enc-1", patientId: "p-1", visitType: "new", dangerFlagged: true, status: "waiting" },
    patient: summary("p-1", "HMS0000000020", "Asha Devi"),
    ...over,
  };
}

const CURRENT = entry({
  id: "qe-cur", tokenNo: 5, status: "called", position: null, queueClass: null, calledAt: NOW_ISO, callCount: 1,
});
const WAIT_A = entry({
  id: "qe-a", seq: 2, encounterId: "enc-2", tokenNo: 6, position: 1, queueClass: 3,
  encounter: { id: "enc-2", patientId: "p-2", visitType: "new", dangerFlagged: false, status: "waiting" },
  patient: summary("p-2", "HMS0000000030", "Ram Prasad"),
});
const WAIT_B = entry({
  id: "qe-b", seq: 3, encounterId: "enc-3", tokenNo: 7, position: 2, queueClass: 1, danger: true, reEntry: true,
  encounter: { id: "enc-3", patientId: "p-3", visitType: "revisit", dangerFlagged: true, status: "waiting" },
  patient: summary("p-3", "HMS0000000040", "Sita Devi"),
});

const QUEUE_VIEW = {
  session: SESSION, doctor: DOCTOR, ordered: [WAIT_A, WAIT_B], current: CURRENT, inConsult: [], left: [],
  waitingVitals: 0, counts: { waiting: 2, called: 1, inConsult: 0, done: 0, left: 0 },
};

/** The same queue, but the called patient is a confidential record the OPD module only aliases. */
const CURRENT_HIDDEN = entry({
  ...CURRENT,
  patient: summary("p-1", "HMS0000000020", null, { restricted: true, alias: "Patient C" }),
});
const QUEUE_VIEW_HIDDEN = { ...QUEUE_VIEW, current: CURRENT_HIDDEN };

const ENCOUNTER = {
  id: "enc-1", patientId: "p-1", type: "opd_visit", status: "in_consultation", workflowInstanceId: "wf-1",
  departmentId: "dep-1", doctorId: "doc-1", appointmentId: null, serviceDate: TODAY, visitType: "new",
  intendedPayer: "self", referralSource: null, referrerName: null,
  chiefComplaint: null, diagnosis: null, icd10Code: null, advice: null,
  admissionAdvised: false, referralTo: null, referralNote: null,
  followUpDays: null, followUpExtended: false, dangerFlagged: true,
  consultStartedAt: NOW_ISO, consultCompletedAt: null, abandonedAt: null, abandonReason: null,
  openedBy: "u-1", openedAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
};

function vitals(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "vit-1", encounterId: "enc-1", patientId: "p-1",
    heightCm: 162, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, rr: 16, spo2: 98, tempC: 37,
    notes: null, ageYearsAtRecord: 34, band: "adult", dangerFlags: [],
    recordedBy: "u-2", recordedAt: "2026-08-18T04:20:00.000Z",
    ...over,
  };
}
const VITALS_FIRST = vitals({});
const VITALS_LATEST = vitals({
  id: "vit-2", sbp: 190, recordedAt: "2026-08-18T04:40:00.000Z",
  dangerFlags: [{ vital: "sbp", value: 190, bound: "max", limit: 180 }],
});

const VISIT = {
  encounter: ENCOUNTER, queueEntries: [CURRENT], vitals: [VITALS_FIRST, VITALS_LATEST], prescriptions: [],
  /* The CODED diagnoses. `encounter.diagnosis` is a display string and carries no codes. */
  diagnoses: [] as { text: string; icd10Code: string | null }[],
  patient: summary("p-1", "HMS0000000020", "Asha Devi"),
};

/** `GET /opd/cds/complete/diagnosis` — real rows from the ICD-10-CM tabular list. */
const ICD10_HITS = {
  items: [
    { code: "J06.9", description: "Acute upper respiratory infection, unspecified", chapterNo: 10, codeMatch: false },
    { code: "J06.0", description: "Acute laryngopharyngitis", chapterNo: 10, codeMatch: false },
  ],
};

const PATIENT_DETAIL = {
  patient: { uhid: "HMS0000000020", name: "Asha Devi", alias: null, dob: "1992-03-04", administrativeGender: "female" },
  resolvedFrom: null,
};
/* The provenance columns were always on the wire — `listAllergies` selects the whole row. */
const ALLERGIES = [
  {
    id: "al-1", substance: "Penicillin", severity: "severe", status: "active",
    source: "consult", recordedAt: "2026-08-17T04:05:00.000Z", correctionReason: null,
  },
  {
    id: "al-2", substance: "Sulfa", severity: "mild", status: "entered_in_error",
    source: "registration", recordedAt: "2026-08-17T03:00:00.000Z", correctionReason: "wrong patient",
  },
];
const TIMELINE = [
  {
    encounterId: "enc-0", serviceDate: "2026-07-10", openedAt: "2026-07-10T04:00:00.000Z", status: "completed",
    visitType: "new", doctorId: "doc-1", doctorName: "Dr Meera Rao", departmentId: "dep-1",
    departmentName: "General medicine", diagnosis: "Acute gastritis", icd10Code: "K29.7",
    prescriptionLineCount: 2, dangerFlagged: false,
  },
];

const PRINT_DATA = {
  letterhead: CONFIG.letterhead,
  patient: { uhid: "HMS0000000020", name: "Asha Devi", alias: null, restricted: false, ageYears: 34, administrativeGender: "female" },
  doctor: { displayName: "Dr Meera Rao", registrationNo: "BMC/12345", departmentName: "General medicine" },
  encounter: {
    id: "enc-1", serviceDate: TODAY, diagnosis: "Acute pharyngitis", icd10Code: "J02.9",
    advice: "warm fluids", followUpDays: 7, chiefComplaint: "fever 3d",
    // PLAN 07d T5 — the wire shape gained `advisedTests`. The renderer tolerates its absence
    // (a tab open across a deploy), but a fixture should be the shape the server actually sends.
    advisedTests: [],
  },
  vitals: VITALS_LATEST,
  lines: [{
    drug: "Tab Penicillin V", dose: "1 tab", route: "oral", frequency: "TDS",
    durationDays: 5, instructions: "after food", noSubstitution: false,
  }],
  qrPayload: "rx1.RX0000000000000000000001.EN0000000000000000000001.1.c2lnbmF0dXJlLWJ5dGVz",
  version: 1,
  issuedAt: "2026-08-18T05:12:00.000Z",
};

const ALLERGY_CONFLICT = {
  statusCode: 409,
  message: "prescription conflicts with a recorded allergy",
  code: "allergy_conflict",
  detail: { matches: [{ lineIndex: 0, substance: "Penicillin" }] },
};

// ——— a custom fetch mock for the tests that need a REAL non-200: stubFetch always answers 200 ———

type Handler = { status: number; body: unknown } | (() => { status: number; body: unknown });

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const path = raw.split("?")[0]!;
      const key = `${init?.method ?? "GET"} ${path}`;
      const h = handlers[key];
      if (h === undefined) return new Response("{}", { status: 404 });
      const { status, body } = typeof h === "function" ? h() : h;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

/** Every read the screen makes on the happy path, so each test only declares what it is about. */
function baseRoutes(): Record<string, Handler> {
  return {
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
    "GET /api/opd/me/doctor": { status: 200, body: DOCTOR },
    "GET /api/opd/config": { status: 200, body: CONFIG },
    "GET /api/opd/queues": { status: 200, body: QUEUE_VIEW },
    "GET /api/opd/visits/enc-1": { status: 200, body: VISIT },
    "GET /api/patients/p-1": { status: 200, body: PATIENT_DETAIL },
    "GET /api/patients/p-1/allergies": { status: 200, body: { items: ALLERGIES } },
    "GET /api/opd/patients/p-1/timeline": { status: 200, body: { items: TIMELINE } },
    // Nest's DEFAULT 201 — the erratum-E5 status the real controller returns (stubFetch cannot make one).
    "POST /api/opd/visits/enc-1/consult/start": { status: 201, body: { encounter: ENCOUNTER, queueEntry: CURRENT } },
  };
}

/**
 * ═══ THE DIAGNOSIS FIELD — TAGS, AND A CODE THAT STAYS MARRIED TO ITS OWN WORDS ═══
 *
 * Owner, 2026-09-14, chose several tags over one value and a real ICD-10 catalogue over completing
 * from the eight syndromes. The field is `TagField` with the same keystroke contract as the
 * complaint, so a doctor learns Enter once; what is new is that a TAPPED row brings a code with it.
 */
describe("OpdConsult — the diagnosis tags and their ICD-10 codes", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("N1: tapping a suggestion takes its words AND its code, and the note PUTs both", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/cds/complete/diagnosis": { status: 200, body: ICD10_HITS },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    const diagnosis = await screen.findByLabelText("Diagnosis");
    await user.click(diagnosis);
    await user.type(diagnosis, "acute upper");
    await user.click(await screen.findByText("Acute upper respiratory infection, unspecified"));
    await user.click(screen.getByRole("heading", { name: "Consultation" }));

    await waitFor(() => {
      const body = bodiesOf("PUT", "/api/opd/visits/enc-1/consult/note").at(-1) as { diagnoses: unknown };
      expect(body.diagnoses).toEqual([
        { text: "Acute upper respiratory infection, unspecified", icd10Code: "J06.9" },
      ]);
    });
  });

  it("N2: the doctor's own words stay uncoded beside a picked one, in the order written", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/cds/complete/diagnosis": { status: 200, body: ICD10_HITS },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    const diagnosis = await screen.findByLabelText("Diagnosis");
    await user.click(diagnosis);
    /* Enter commits verbatim — including the comma, which is why " · " is the separator. */
    await user.type(diagnosis, "?dengue, review in 48h{Enter}");
    await user.type(diagnosis, "acute upper");
    await user.click(await screen.findByText("Acute upper respiratory infection, unspecified"));
    await user.click(screen.getByRole("heading", { name: "Consultation" }));

    await waitFor(() => {
      const body = bodiesOf("PUT", "/api/opd/visits/enc-1/consult/note").at(-1) as { diagnoses: unknown };
      expect(body.diagnoses).toEqual([
        { text: "?dengue, review in 48h", icd10Code: null },
        { text: "Acute upper respiratory infection, unspecified", icd10Code: "J06.9" },
      ]);
    });
  });

  it("N3: REOPENING a coded note and editing something else does not strip the codes", async () => {
    /*
      ═══ THE SEAM, AND IT IS THE ONE THIS FEATURE WOULD HAVE LOST DATA ON ═══

      `encounter.diagnosis` is the display string and carries no codes. A screen that loaded only
      that, then saved after the doctor touched the ADVICE box, would send back uncoded tags and
      replace the coded rows with uncoded ones. Both ends individually correct, the coding gone on
      an ordinary edit, and nothing anywhere saying so. The visit read returns the coded rows and
      the screen seeds its map from them; this is the test that fails if either half is removed.
    */
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/visits/enc-1": { status: 200, body: {
        ...VISIT,
        encounter: { ...ENCOUNTER, diagnosis: "Acute upper respiratory infection, unspecified", icd10Code: "J06.9" },
        diagnoses: [{ text: "Acute upper respiratory infection, unspecified", icd10Code: "J06.9" }],
      } },
      "GET /api/opd/cds/complete/diagnosis": { status: 200, body: ICD10_HITS },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    const advice = await screen.findByLabelText("Advice");
    await user.click(advice);
    await user.type(advice, "steam inhalation");
    await user.click(screen.getByRole("heading", { name: "Consultation" }));

    await waitFor(() => {
      const body = bodiesOf("PUT", "/api/opd/visits/enc-1/consult/note").at(-1) as { diagnoses: unknown };
      expect(body.diagnoses).toEqual([
        { text: "Acute upper respiratory infection, unspecified", icd10Code: "J06.9" },
      ]);
    });
  });

  it("N6: a held backspace cannot cost a coded diagnosis its ICD-10 code", async () => {
    /*
      The complaint field's held-backspace defect (F5b) is worse here and the same component causes
      both. Losing "Acute upper respiratory infection, unspecified" does not merely lose words — it
      loses J06.9 with them, and the doctor has to find the code through the typeahead again. This
      is the reason the rule is "Enter commits, × removes" rather than a guard on `e.repeat`.
    */
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/cds/complete/diagnosis": { status: 200, body: ICD10_HITS },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    const diagnosis = await screen.findByLabelText("Diagnosis");
    await user.click(diagnosis);
    await user.type(diagnosis, "acute upper");
    await user.click(await screen.findByText("Acute upper respiratory infection, unspecified"));

    await user.type(diagnosis, "typ");
    await user.keyboard("{Backspace>20/}");
    await user.click(screen.getByRole("heading", { name: "Consultation" }));

    await waitFor(() => {
      const body = bodiesOf("PUT", "/api/opd/visits/enc-1/consult/note").at(-1) as { diagnoses: unknown };
      expect(body.diagnoses).toEqual([
        { text: "Acute upper respiratory infection, unspecified", icd10Code: "J06.9" },
      ]);
    });
  });

  it("N4: the ICD-10 box is a READING of the tags, not a second place to type", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/cds/complete/diagnosis": { status: 200, body: ICD10_HITS },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    const icd10 = await screen.findByTestId("note-icd10");
    expect(icd10).toHaveAttribute("readonly");
    expect(icd10).toHaveValue("");

    const diagnosis = screen.getByLabelText("Diagnosis");
    await user.click(diagnosis);
    await user.type(diagnosis, "acute upper");
    await user.click(await screen.findByText("Acute upper respiratory infection, unspecified"));

    // A code typed here and a code carried by a tag would be two statements of one fact.
    await waitFor(() => { expect(screen.getByTestId("note-icd10")).toHaveValue("J06.9"); });
  });

  it("N5: a note coded BEFORE this table existed still shows its code", async () => {
    /* No diagnosis rows, an `icd10Code` on the encounter. Showing an empty box would report a
       coded note as uncoded — the fallback is the honest rendering of an older record. */
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/visits/enc-1": { status: 200, body: {
        ...VISIT,
        encounter: { ...ENCOUNTER, diagnosis: "Acute pharyngitis", icd10Code: "J02.9" },
        diagnoses: [],
      } },
      "GET /api/opd/cds/complete/diagnosis": { status: 200, body: { items: [] } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await waitFor(() => { expect(screen.getByTestId("note-icd10")).toHaveValue("J02.9"); });
  });
});

/**
 * ═══ THE ALLERGY FIELD, WHICH IS A GUARD AND NOT A CONVENIENCE ═══
 *
 * The prescription block matches a recorded allergy on word tokens of five letters or more, so a
 * misspelt substance matches no rule and the block goes silent for the life of the record. Picking
 * records the CLASS and fires the rule by identity; typing still saves, and now says so.
 */
const ALLERGEN_HITS = {
  items: [
    {
      term: "Penicillins / Beta-Lactams", kind: "class", allergenClass: "Penicillins / Beta-Lactams",
      saltId: null, blocks: ["Amoxicillin", "Ampicillin", "Cephalexin"],
    },
    { term: "Penicillin", kind: "moiety", allergenClass: null, saltId: "S1", blocks: [] },
  ],
  known: true,
};

describe("OpdConsult — recording an allergy in the room", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("R1: picking an allergen posts its CLASS, so a block cannot be lost to spelling", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/cds/complete/allergen": { status: 200, body: ALLERGEN_HITS },
      "POST /api/patients/p-1/allergies": { status: 201, body: { allergyId: "al-9" } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(await screen.findByTestId("allergy-add"));
    await user.type(screen.getByLabelText("Allergy — substance"), "pencil");
    await user.click(await screen.findByTestId("allergy-hit-Penicillins / Beta-Lactams"));
    await user.click(screen.getByTestId("allergy-save"));

    await waitFor(() => {
      expect(bodiesOf("POST", "/api/patients/p-1/allergies").at(-1)).toEqual({
        substance: "Penicillins / Beta-Lactams", severity: "moderate", source: "consult",
        saltId: null, allergenClass: "Penicillins / Beta-Lactams",
      });
    });
  });

  it("R2: editing after a pick DROPS the code — it belonged to the old words", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/cds/complete/allergen": { status: 200, body: ALLERGEN_HITS },
      "POST /api/patients/p-1/allergies": { status: 201, body: { allergyId: "al-9" } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(await screen.findByTestId("allergy-add"));
    await user.type(screen.getByLabelText("Allergy — substance"), "pencil");
    await user.click(await screen.findByTestId("allergy-hit-Penicillin"));
    /*
      A code left behind after the words changed is a block recorded against a substance nobody
      named — the same defect the drug field's `medicineId` had and fixed.

      TWO INDEPENDENT DEFENCES ENFORCE THIS, and neither mutant kills this test on its own:
      `onChange` clears the pick, AND `addAllergy` refuses a pick whose term is not the text being
      saved. Measured — removing either leaves R2 green, removing BOTH turns it red and nothing
      else. That is not a weak test; it is a test of the BEHAVIOUR over two mechanisms that each
      suffice. Worth writing down because a surviving mutant usually means the opposite, and the
      next person to run one here should not go looking for the hole.
    */
    await user.type(screen.getByLabelText("Allergy — substance"), " (child only)");
    await user.click(screen.getByTestId("allergy-save"));

    await waitFor(() => {
      expect(bodiesOf("POST", "/api/patients/p-1/allergies").at(-1)).toEqual({
        substance: "Penicillin (child only)", severity: "moderate", source: "consult",
      });
    });
  });

  it("R3: free text the guard knows no rule for WARNS, and still saves", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/cds/complete/allergen": { status: 200, body: { items: [], known: false } },
      "POST /api/patients/p-1/allergies": { status: 201, body: { allergyId: "al-9" } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(await screen.findByTestId("allergy-add"));
    await user.type(screen.getByLabelText("Allergy — substance"), "the red syrup");

    // It WARNS — a doctor told nothing has no way to know the check will stay quiet.
    expect(await screen.findByTestId("allergy-unknown")).toBeInTheDocument();

    // ...and it never REFUSES. Free text is legal on this field and always was.
    await user.click(screen.getByTestId("allergy-save"));
    await waitFor(() => {
      expect(bodiesOf("POST", "/api/patients/p-1/allergies").at(-1)).toEqual({
        substance: "the red syrup", severity: "moderate", source: "consult",
      });
    });
  });

  it("R4: a suggester that is DOWN leaves a plain box that saves, and warns about nothing", async () => {
    /* Design law 1 at the transport layer. A field that started warning about every allergy
       because a route returned 500 would teach a doctor to ignore the warning. */
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/cds/complete/allergen": { status: 500, body: { message: "boom" } },
      "POST /api/patients/p-1/allergies": { status: 201, body: { allergyId: "al-9" } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(await screen.findByTestId("allergy-add"));
    await user.type(screen.getByLabelText("Allergy — substance"), "penicillin");
    await waitFor(() => { expect(screen.queryByTestId("allergy-hits")).toBeNull(); });
    expect(screen.queryByTestId("allergy-unknown")).toBeNull();

    await user.click(screen.getByTestId("allergy-save"));
    await waitFor(() => { expect(callsTo("POST", "/api/patients/p-1/allergies")).toHaveLength(1); });
  });
});

/**
 * ═══ THE ADVICE LIBRARY — TWO BUTTONS PER TEMPLATE, AND THE SCRIPT IS THE DOCTOR'S CHOICE ═══
 *
 * This is the one field the patient reads. `rx-print.tsx` prints `encounter.advice` VERBATIM, so a
 * translated label above English prose gives a Devanagari reader nothing — the script has to be in
 * the stored value. Owner ruling, 2026-09-14: the doctor picks the language per template.
 */
const ADVICE_TEMPLATES = {
  items: [
    {
      id: "adv_mine", title: "My asthma advice", mine: true, keyword: ";asth",
      textEn: "Use the inhaler as shown.", textHi: "इनहेलर बताए अनुसार लें।",
    },
    {
      id: "adv_seed_rest_fluids", title: "Rest and fluids", mine: false, keyword: null,
      textEn: "Take rest. Drink plenty of fluids.", textHi: "आराम करें। खूब तरल पिएं।",
    },
    { id: "adv_en_only", title: "English only", mine: false, keyword: null, textEn: "Only English here.", textHi: null },
    {
      id: "adv_rx", title: "Review with weight", mine: true, keyword: ";rev",
      textEn: "For {name}, {weight} kg. Take {?one tablet} {?} after food. Review on {date+7}.",
      textHi: null,
    },
  ],
};

describe("OpdConsult — the advice library", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("W1: tapping the Hindi button stores the DEVANAGARI, which is what prints", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/advice-templates": { status: 200, body: ADVICE_TEMPLATES },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(await screen.findByTestId("advice-tpl-adv_seed_rest_fluids-hi"));
    await user.click(screen.getByRole("heading", { name: "Consultation" }));

    await waitFor(() => {
      const body = bodiesOf("PUT", "/api/opd/visits/enc-1/consult/note").at(-1) as { advice: string };
      expect(body.advice).toBe("आराम करें। खूब तरल पिएं।");
    });
  });

  it("W2: the English button on the SAME template stores English — one row, two choices", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/advice-templates": { status: 200, body: ADVICE_TEMPLATES },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(await screen.findByTestId("advice-tpl-adv_seed_rest_fluids-en"));
    await user.click(screen.getByRole("heading", { name: "Consultation" }));

    await waitFor(() => {
      const body = bodiesOf("PUT", "/api/opd/visits/enc-1/consult/note").at(-1) as { advice: string };
      expect(body.advice).toBe("Take rest. Drink plenty of fluids.");
    });
  });

  it("W3: tapping APPENDS — a doctor builds advice out of several, and never loses typing", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/advice-templates": { status: 200, body: ADVICE_TEMPLATES },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    const advice = await screen.findByLabelText("Advice");
    await user.click(advice);
    await user.type(advice, "Review Friday.");
    await user.click(screen.getByTestId("advice-tpl-adv_seed_rest_fluids-en"));
    await user.click(screen.getByTestId("advice-tpl-adv_mine-hi"));
    await user.click(screen.getByRole("heading", { name: "Consultation" }));

    await waitFor(() => {
      const body = bodiesOf("PUT", "/api/opd/visits/enc-1/consult/note").at(-1) as { advice: string };
      expect(body.advice).toBe("Review Friday.\nTake rest. Drink plenty of fluids.\nइनहेलर बताए अनुसार लें।");
    });
  });

  it("W4: a template with only one script offers only one button", async () => {
    mockRoutes({ ...baseRoutes(), "GET /api/opd/advice-templates": { status: 200, body: ADVICE_TEMPLATES } });
    const user = userEvent.setup();
    await openPanel(user);

    await screen.findByTestId("advice-tpl-adv_en_only-en");
    // Half a row beats no row; what it must not do is offer a Hindi button that inserts nothing.
    expect(screen.queryByTestId("advice-tpl-adv_en_only-hi")).toBeNull();
  });

  it("W5: saving DEVANAGARI advice files it as Hindi, not under an English button", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/advice-templates": { status: 200, body: ADVICE_TEMPLATES },
      "POST /api/opd/advice-templates": { status: 201, body: { templateId: "adv-new" } },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    const advice = await screen.findByLabelText("Advice");
    await user.click(advice);
    await user.type(advice, "रोज़ टहलें।");
    await user.click(screen.getByTestId("advice-save-open"));
    await user.type(screen.getByLabelText("Template name"), "Walking");
    await user.click(screen.getByTestId("advice-save"));

    await waitFor(() => {
      expect(bodiesOf("POST", "/api/opd/advice-templates").at(-1)).toEqual({
        /* `keyword: null` — this template is TAPPED, not typed. A snippet keyword is optional. */
        title: "Walking", keyword: null, textEn: null, textHi: "रोज़ टहलें।",
      });
    });
  });

  it("W6: there is nothing to save while the box is empty", async () => {
    mockRoutes({ ...baseRoutes(), "GET /api/opd/advice-templates": { status: 200, body: ADVICE_TEMPLATES } });
    const user = userEvent.setup();
    await openPanel(user);

    await screen.findByTestId("advice-library");
    expect(screen.queryByTestId("advice-save-open")).toBeNull();
  });
});

/**
 * ═══ A WRONG ALLERGY, AND WHY REMOVING IT IS NOT DELETING IT ═══
 *
 * Owner, 2026-09-14: *"I added a wrong allergy to the patient. Now I cannot delete it."* The route
 * has existed since E-8 and lives on `patient-detail.tsx`; what was missing was the button on the
 * screen where the mistake is MADE. The asymmetry arrived with "record an allergy in the room" —
 * the writer shipped without its corrector.
 *
 * It stays a CORRECTION. `patient-detail.tsx` already rules it: allergies are append-only. The
 * doctor loses nothing by that — a struck row stops warning at once — and the record keeps what a
 * later clinician would need if the patient turns out to have reacted after all.
 */
describe("OpdConsult — removing an allergy recorded in error", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("Y1: removing posts the E-8 correction with the reason — it never DELETEs", async () => {
    mockRoutes({
      ...baseRoutes(),
      "POST /api/patients/p-1/allergies/al-1/entered-in-error": { status: 201, body: { ok: true } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(await screen.findByTestId("allergy-strike-al-1"));
    await user.type(screen.getByLabelText("Reason"), "wrong patient — meant the next chart");
    await user.click(screen.getByTestId("allergy-strike-confirm"));

    await waitFor(() => {
      expect(bodiesOf("POST", "/api/patients/p-1/allergies/al-1/entered-in-error").at(-1)).toEqual({
        reason: "wrong patient — meant the next chart",
      });
    });
    /* Not a DELETE anywhere. A clinical safety record that can vanish tells the next clinician
       nothing; one that was claimed and withdrawn tells them a great deal. */
    expect(fetchCalls().filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("Y2: the reason is mandatory — the button will not act without one", async () => {
    mockRoutes({
      ...baseRoutes(),
      "POST /api/patients/p-1/allergies/al-1/entered-in-error": { status: 201, body: { ok: true } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(await screen.findByTestId("allergy-strike-al-1"));
    const confirm = screen.getByTestId("allergy-strike-confirm");
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(callsTo("POST", "/api/patients/p-1/allergies/al-1/entered-in-error")).toHaveLength(0);

    // Whitespace is not a reason either — the server refuses it and the button agrees.
    await user.type(screen.getByLabelText("Reason"), "   ");
    expect(screen.getByTestId("allergy-strike-confirm")).toBeDisabled();
  });

  it("Y3: the confirmation names WHERE the allergy came from", async () => {
    /* Undoing your own mis-tap and striking a contrast reaction radiology recorded from a real
       administration are different acts, and only this line tells them apart. */
    mockRoutes({ ...baseRoutes() });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(await screen.findByTestId("allergy-strike-al-1"));
    expect(screen.getByTestId("allergy-strike-provenance")).toHaveTextContent(/this consultation/);
  });

  it("Y5: struck allergies are hidden but reachable, with the reason they were struck", async () => {
    /* Default-hidden keeps the chip row clean; reachable stops the next person re-recording the
       same wrong allergy having no way to know it was considered and withdrawn. */
    mockRoutes({ ...baseRoutes() });
    const user = userEvent.setup();
    await openPanel(user);

    await screen.findByTestId("allergy-chips");
    expect(screen.queryByTestId("allergy-corrected")).toBeNull();
    expect(screen.queryByTestId("allergy-chip-al-2")).toBeNull();

    await user.click(screen.getByTestId("allergy-corrected-toggle"));
    expect(await screen.findByTestId("allergy-corrected-al-2")).toHaveTextContent(/Sulfa/);
    expect(screen.getByTestId("allergy-corrected-al-2")).toHaveTextContent(/wrong patient/);
  });
});

/**
 * ═══ SNIPPETS ON THE ADVICE BOX ═══
 *
 * Owner, 2026-09-14, asked for Raycast-style snippets: a keyword, auto-expansion, Tab, and a
 * reference of the placeholder vocabulary. The part that is not Raycast is where the values come
 * from — the patient in the chair rather than the machine.
 *
 * Nothing with braces is ever stored: expansion happens at insert time, and what the note carries
 * is ordinary text. That is what keeps the print path, the e-Rx and the relay out of this feature.
 */
describe("OpdConsult — snippets in the advice box", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  const snippetRoutes = (): Record<string, Handler> => ({
    ...baseRoutes(),
    "GET /api/opd/advice-templates": { status: 200, body: ADVICE_TEMPLATES },
    "POST /api/opd/advice-templates": { status: 201, body: { templateId: "adv-new" } },
    "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
  });

  it("T1: typing a keyword expands it in place, filled from THIS patient", async () => {
    mockRoutes(snippetRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    const advice = await screen.findByLabelText("Advice");
    await user.click(advice);
    await user.type(advice, ";asth");

    // The keyword is gone and the template is in its place — no Enter, no menu, no click.
    await waitFor(() => { expect(advice).toHaveValue("Use the inhaler as shown."); });
  });

  it("T2: placeholders resolve from the record — the name and the charted weight", async () => {
    mockRoutes(snippetRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    const advice = await screen.findByLabelText("Advice");
    await user.click(advice);
    await user.type(advice, ";rev");

    /* VITALS_LATEST is the chart this panel already shows — 60 kg — and the snippet reads that
       same number rather than a second one from anywhere else. */
    await waitFor(() => {
      expect(String((advice as HTMLTextAreaElement).value)).toContain("For Asha Devi, 60 kg.");
    });
    // And no placeholder survives into the field — braces never reach the record or the slip.
    expect(String((advice as HTMLTextAreaElement).value)).not.toContain("{");
  });

  it("T3: Tab walks the blanks the snippet left, and the last one LEAVES the field", async () => {
    mockRoutes(snippetRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    const advice = await screen.findByLabelText("Advice");
    await user.click(advice);
    await user.type(advice, ";rev");
    await screen.findByTestId("advice-stops");

    /* The first blank arrives SELECTED, so typing replaces its default rather than appending. */
    await user.keyboard("2 tablets");
    expect(String((advice as HTMLTextAreaElement).value)).toContain("Take 2 tablets");

    await user.tab();
    await user.keyboard("twice daily");
    expect(String((advice as HTMLTextAreaElement).value)).toContain("Take 2 tablets twice daily after food");

    /* Blanks exhausted: the next Tab is NOT swallowed, so a keyboard user is never stranded. */
    await user.tab();
    await waitFor(() => { expect(screen.queryByTestId("advice-stops")).toBeNull(); });
    expect(advice).not.toHaveFocus();
  });

  it("T4: Escape abandons the blanks and gives Tab straight back", async () => {
    mockRoutes(snippetRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    const advice = await screen.findByLabelText("Advice");
    await user.click(advice);
    await user.type(advice, ";rev");
    await screen.findByTestId("advice-stops");

    await user.keyboard("{Escape}");
    await waitFor(() => { expect(screen.queryByTestId("advice-stops")).toBeNull(); });
    await user.tab();
    expect(advice).not.toHaveFocus();
  });

  it("T5: a TAPPED template resolves its placeholders the same way a typed one does", async () => {
    /* One engine for both paths. A template that behaved differently depending on how it was
       reached is a difference nobody discovers until a slip is wrong. */
    mockRoutes(snippetRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(await screen.findByTestId("advice-tpl-adv_rx-en"));
    const advice = screen.getByLabelText("Advice");
    await waitFor(() => { expect(String((advice as HTMLTextAreaElement).value)).toContain("For Asha Devi, 60 kg."); });
    expect(String((advice as HTMLTextAreaElement).value)).not.toContain("{");
  });

  it("T6: the saved note is plain text — no placeholder is ever stored", async () => {
    mockRoutes(snippetRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    const advice = await screen.findByLabelText("Advice");
    await user.click(advice);
    await user.type(advice, ";asth");
    await user.click(screen.getByRole("heading", { name: "Consultation" }));

    await waitFor(() => {
      const body = bodiesOf("PUT", "/api/opd/visits/enc-1/consult/note").at(-1) as { advice: string };
      expect(body.advice).toBe("Use the inhaler as shown.");
      expect(body.advice).not.toContain("{");
    });
  });

  it("T7: a keyword that would fire inside a word is refused before it can be saved", async () => {
    mockRoutes(snippetRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    const advice = await screen.findByLabelText("Advice");
    await user.click(advice);
    await user.type(advice, "Take rest.");
    await user.click(screen.getByTestId("advice-save-open"));
    await user.type(screen.getByLabelText("Template name"), "Rest");
    await user.type(screen.getByLabelText("Keyword"), "rest");

    expect(await screen.findByTestId("advice-keyword-problem")).toBeInTheDocument();
    expect(screen.getByTestId("advice-save")).toBeDisabled();
    expect(callsTo("POST", "/api/opd/advice-templates")).toHaveLength(0);

    await user.clear(screen.getByLabelText("Keyword"));
    await user.type(screen.getByLabelText("Keyword"), ";rest");
    expect(screen.queryByTestId("advice-keyword-problem")).toBeNull();
    await user.click(screen.getByTestId("advice-save"));

    await waitFor(() => {
      expect(bodiesOf("POST", "/api/opd/advice-templates").at(-1)).toMatchObject({
        title: "Rest", keyword: ";rest", textEn: "Take rest.",
      });
    });
  });

  it("T8: the reference is built FROM the resolver, and previews this patient", async () => {
    /* A panel hand-written beside the engine drifts from it. This one renders the same list the
       resolver runs, and shows what each token would produce right now. */
    mockRoutes(snippetRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(await screen.findByTestId("snippet-ref-toggle"));
    const ref = await screen.findByTestId("snippet-ref");
    expect(within(ref).getByTestId("snippet-ref-weight")).toHaveTextContent("→ 60");
    expect(within(ref).getByTestId("snippet-ref-name")).toHaveTextContent("→ Asha Devi");
    expect(within(ref).getByTestId("snippet-ref-bp")).toHaveTextContent("→ 190/80");
  });
});

/**
 * ═══ THE SLIP IN THE DOCTOR'S HISTORY ═══
 *
 * Owner, 2026-09-14: *"can the doctor see the old prescription inside the history tab?"* Now yes —
 * the desk outside the room photographs it and it lands here.
 *
 * The two requests are the design, not an accident: the LIST is metadata, and OPENING one fetches
 * the bytes. Scrolling past a list of slips and reading a patient's prescription are different acts
 * and the access log is kept to answer which happened, so they are different surfaces on the server
 * and different requests from here.
 */
const DOCUMENTS = {
  items: [
    {
      id: "doc-1", encounterId: "enc-1", kind: "outside_prescription", mimeType: "image/jpeg",
      byteSize: 290_114, note: "brought from Medanta", capturedBy: "u-desk",
      capturedAt: "2026-08-18T05:10:00.000Z",
    },
    {
      id: "doc-2", encounterId: null, kind: "outside_report", mimeType: "application/pdf",
      byteSize: 88_010, note: null, capturedBy: "u-desk", capturedAt: "2026-08-17T09:00:00.000Z",
    },
  ],
};
const ONE_PIXEL = "/9j/4AAQSkZJRg==";

describe("OpdConsult — the slips a desk photographed", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  const docRoutes = (): Record<string, Handler> => ({
    ...baseRoutes(),
    "GET /api/patients/p-1/documents": { status: 200, body: DOCUMENTS },
    "GET /api/patients/documents/doc-1": { status: 200, body: { mimeType: "image/jpeg", imageBase64: ONE_PIXEL } },
  });

  async function openSlips(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await openPanel(user);
    /* The view toggle lives inside the History TAB, so that is opened first. */
    await user.click(await screen.findByRole("tab", { name: "History" }));
    await user.click(await screen.findByRole("button", { name: "Slips" }));
  }

  it("Z1: the history lists what was photographed, newest first, WITHOUT fetching any bytes", async () => {
    mockRoutes(docRoutes());
    const user = userEvent.setup();
    await openSlips(user);

    expect(await screen.findByTestId("document-doc-1")).toHaveTextContent("Outside prescription");
    expect(screen.getByTestId("document-doc-1")).toHaveTextContent("brought from Medanta");
    expect(screen.getByTestId("document-doc-2")).toHaveTextContent("Outside report");

    /* A doctor scanning for "did they bring the outside prescription" must not pull four megabytes
       of JPEG for every visit — and the bytes are a second PHI read that has not happened yet. */
    expect(callsTo("GET", "/api/patients/documents/doc-1")).toHaveLength(0);
  });

  it("Z2: opening one fetches the bytes and renders the photograph", async () => {
    mockRoutes(docRoutes());
    const user = userEvent.setup();
    await openSlips(user);

    await user.click(await screen.findByTestId("document-open-doc-1"));
    const img = await screen.findByTestId("document-image-doc-1");
    expect(img).toHaveAttribute("src", `data:image/jpeg;base64,${ONE_PIXEL}`);
    expect(callsTo("GET", "/api/patients/documents/doc-1")).toHaveLength(1);
  });

  it("Z3: a slip whose bytes no longer match its hash SAYS SO — it does not render blank", async () => {
    /*
      The server refuses with `document_corrupt` rather than handing back whatever is on disk. A
      blank image would read as a bad photograph; this reads as a broken record, which is what it is,
      and tells the doctor who can do something about it.
    */
    mockRoutes({
      ...docRoutes(),
      "GET /api/patients/documents/doc-1": { status: 409, body: { message: "hash mismatch", code: "document_corrupt" } },
    });
    const user = userEvent.setup();
    await openSlips(user);

    await user.click(await screen.findByTestId("document-open-doc-1"));
    expect(await screen.findByTestId("document-error-doc-1")).toHaveTextContent(/cannot be opened/);
    expect(screen.queryByTestId("document-image-doc-1")).toBeNull();
  });

  it("Z4: a PDF is offered as a link rather than jammed into an <img>", async () => {
    mockRoutes({
      ...docRoutes(),
      "GET /api/patients/documents/doc-2": { status: 200, body: { mimeType: "application/pdf", imageBase64: "JVBERi0=" } },
    });
    const user = userEvent.setup();
    await openSlips(user);

    await user.click(await screen.findByTestId("document-open-doc-2"));
    expect(await screen.findByTestId("document-pdf-doc-2")).toHaveAttribute("href", "data:application/pdf;base64,JVBERi0=");
    expect(screen.queryByTestId("document-image-doc-2")).toBeNull();
  });

  it("Z5: a patient with no slips says so, rather than rendering an empty strip", async () => {
    mockRoutes({ ...docRoutes(), "GET /api/patients/p-1/documents": { status: 200, body: { items: [] } } });
    const user = userEvent.setup();
    await openSlips(user);

    expect(await screen.findByTestId("no-documents")).toBeInTheDocument();
  });
});

function fetchCalls(): { url: string; path: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const url = String(input);
    return {
      url, path: url.split("?")[0]!, method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    };
  });
}
function callsTo(method: string, path: string): ReturnType<typeof fetchCalls> {
  return fetchCalls().filter((c) => c.method === method && c.path === path);
}
function bodiesOf(method: string, path: string): Record<string, unknown>[] {
  return callsTo(method, path).map((c) => JSON.parse(c.body === "" ? "{}" : c.body) as Record<string, unknown>);
}

/** Boot the screen and start the called patient's consultation — the entry state of tests 3-6. */
async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  renderWithProviders(<OpdConsult />);
  await screen.findByTestId("queue-row-qe-cur");
  await user.click(screen.getByRole("button", { name: "Start consultation" }));
  await screen.findByTestId("patient-panel");
}

describe("OpdConsult", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    FakeWebSocket.reset();
    resetRealtimeClientForTests();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setToken(null);
    localStorage.clear();
  });

  it("boots on GET /opd/me/doctor — a 404 is the domain answer 'not a doctor' and NO queue read follows; with a profile it renders the queue (position, token, class, danger, re-entry) with the called token highlighted plus the session control, and a queue.called frame refetches", async () => {
    // The clock is pinned so `todayIst()` — which both the screen and this test call — is TODAY.
    expect(todayIst()).toBe(TODAY);

    // (a) erratum E3: 404 from /opd/me/doctor is a DOMAIN answer, not a transport failure.
    mockRoutes({
      "GET /api/opd/me/doctor": {
        status: 404,
        body: { statusCode: 404, message: "no OPD doctor profile for this user", code: "not_a_doctor" },
      },
      "GET /api/opd/config": { status: 200, body: CONFIG },
    });
    renderWithProviders(<OpdConsult />);
    expect(await screen.findByTestId("not-a-doctor")).toBeInTheDocument();
    // the mechanism: the queue read is GATED on having a doctor profile — not merely hidden from view.
    expect(callsTo("GET", "/api/opd/queues")).toHaveLength(0);
    expect(screen.queryByTestId("consult-queue")?.textContent ?? "").toBe("");
    cleanup();
    vi.unstubAllGlobals();

    // (b) with a doctor profile: the queue, keyed on my own doctor id and today.
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("tok-1");
    let queueCalls = 0;
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-1" } },
      "GET /api/opd/me/doctor": DOCTOR,
      "GET /api/opd/config": CONFIG,
      "GET /api/opd/queues": () => {
        queueCalls += 1;
        return QUEUE_VIEW;
      },
    });
    renderWithProviders(<OpdConsult />);

    const currentRow = await screen.findByTestId("queue-row-qe-cur");
    const url = callsTo("GET", "/api/opd/queues").at(-1)!.url;
    expect(url).toContain("doctorId=doc-1");
    expect(url).toContain(`serviceDate=${TODAY}`);

    // the called token is highlighted; the two waiting rows are not
    expect(currentRow).toHaveAttribute("aria-current", "true");
    expect(within(currentRow).getByTestId("queue-token-qe-cur")).toHaveTextContent("5");
    const rowA = screen.getByTestId("queue-row-qe-a");
    const rowB = screen.getByTestId("queue-row-qe-b");
    expect(rowA).not.toHaveAttribute("aria-current");
    expect(rowB).not.toHaveAttribute("aria-current");

    // position, token, class badge, danger flag and the re-entry marker, per row
    expect(within(rowA).getByTestId("queue-position-qe-a")).toHaveTextContent("#1");
    expect(within(rowA).getByTestId("queue-token-qe-a")).toHaveTextContent("6");
    expect(within(rowA).getByText("Walk-in")).toBeInTheDocument();
    expect(within(rowA).queryByTestId("queue-danger-qe-a")).toBeNull();
    expect(within(rowA).queryByTestId("queue-reentry-qe-a")).toBeNull();
    expect(within(rowB).getByTestId("queue-position-qe-b")).toHaveTextContent("#2");
    expect(within(rowB).getByText("Returned with results")).toBeInTheDocument();
    expect(within(rowB).getByTestId("queue-danger-qe-b")).toBeInTheDocument();
    expect(within(rowB).getByTestId("queue-reentry-qe-b")).toBeInTheDocument();

    // the session status control reflects the session the server returned
    expect(screen.getByLabelText("Session")).toHaveValue("in");

    // D6: a queue.called frame on MY topic is a hint to re-read. Real timers here, so the 15 s poll
    // cannot fire inside this test — the frame is the only mechanism that can move this counter.
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.simulateOpen();
    });
    await act(async () => {
      ws.simulateMessage({ type: "authed", userId: "u-1" });
    });
    const before = queueCalls;
    await act(async () => {
      ws.simulateMessage({
        type: "event", topic: `queue:doc-1:${TODAY}`, name: "queue.called", seq: 9, occurredAt: NOW_ISO,
        payload: { doctorId: "doc-1", serviceDate: TODAY, tokenNo: 5 },
      });
    });
    await waitFor(() => expect(queueCalls).toBeGreaterThan(before));
  });

  /**
   * CHANGED 2026-09-13 — SKIP NO LONGER POSTS AN EMPTY BODY, and that was the defect rather than the
   * assertion: the owner asked for a reason, so the button opens the dialog and the post carries the
   * coded reason the server now requires. Call next and Start still post bare, and this test still
   * exists to pin that each control hits its OWN route and that a 409 lands inline.
   */
  it("Call next and Start post to their own routes with no body, Skip posts its reason, Start opens the patient panel — and a stubbed 409 call_conflict renders inline", async () => {
    let callNextCalls = 0;
    mockRoutes({
      ...baseRoutes(),
      "POST /api/opd/queues/sess-1/call-next": () => {
        callNextCalls += 1;
        return callNextCalls === 1
          ? { status: 201, body: { entry: CURRENT, encounter: ENCOUNTER } }
          : {
            status: 409,
            body: { statusCode: 409, message: "another patient is already called", code: "call_conflict" },
          };
      },
      "POST /api/opd/queues/entries/qe-cur/skip": { status: 201, body: { entry: { ...CURRENT, status: "waiting" } } },
    });
    renderWithProviders(<OpdConsult />);
    const user = userEvent.setup();
    await screen.findByTestId("queue-row-qe-cur");

    await user.click(screen.getByRole("button", { name: "Call next" }));
    await waitFor(() => expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")).toHaveLength(1));
    expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")[0]!.body).toBe("");

    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(await screen.findByTestId("skip-confirm"));
    await waitFor(() => expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/opd/queues/entries/qe-cur/skip")[0]).toEqual({ reason: "absent", note: null });

    await user.click(screen.getByRole("button", { name: "Start consultation" }));
    await waitFor(() => expect(callsTo("POST", "/api/opd/visits/enc-1/consult/start")).toHaveLength(1));
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/start")[0]!.body).toBe("");
    expect(await screen.findByTestId("patient-panel")).toBeInTheDocument();

    // Calling next AGAIN, and this time the server refuses: a 409 call_conflict is rendered where
    // the doctor reads it. Through the button, deliberately — the signed-off keymap gives Enter to
    // "the obvious next thing" and with a consultation already open the obvious next thing is
    // nothing, so there is no key for this and the control is the only road.
    await user.click(screen.getByRole("button", { name: "Call next" }));
    await waitFor(() => expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")).toHaveLength(2));
    const refusal = await screen.findByText("another patient is already called");
    expect(refusal).toHaveAttribute("role", "alert");
  });

  it("the patient panel loads the patient, the ACTIVE allergies as red chips, the OPD timeline and the LATEST vitals with its danger flag — and a 404 from GET /patients/:id renders restricted mode with the UHID only", async () => {
    mockRoutes(baseRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    expect(await screen.findByTestId("panel-patient-name")).toHaveTextContent("Asha Devi");
    expect(screen.getByTestId("panel-uhid")).toHaveTextContent("HMS0000000020");
    expect(screen.getByTestId("panel-patient-age")).toHaveTextContent("34 years · female");
    expect(screen.getByTestId("panel-visit-type")).toHaveTextContent("New");

    // active allergies only, and rendered as red chips
    const chip = await screen.findByTestId("allergy-chip-al-1");
    expect(chip).toHaveTextContent("Penicillin");
    /*
      THE CHIP IS `.pill rd` — the design system's brick pill — not a Tailwind red. The assertion
      moved with the paint because it is the same claim: an allergy is shown in the danger colour,
      not merely listed.
    */
    expect(chip).toHaveClass("pill", "rd");
    expect(screen.queryByTestId("allergy-chip-al-2")).toBeNull();
    expect(screen.getByTestId("allergy-chips")).not.toHaveTextContent("Sulfa");

    // the LATEST vitals row wins (the fixture's first row carries sbp 120, the latest 190) and its
    // danger flag is highlighted — a screen reading vitals[0] would show 120 and no flag.
    await waitFor(() => expect(screen.getByTestId("panel-vitals")).toHaveTextContent("BP 190/80"));
    expect(screen.getByTestId("panel-vitals")).not.toHaveTextContent("BP 120/80");
    expect(screen.getByTestId("vitals-danger-sbp")).toHaveTextContent("190");

    // the OPD timeline: date, department, doctor, diagnosis
    await user.click(screen.getByRole("tab", { name: "History" }));
    const row = await screen.findByTestId("timeline-row-enc-0");
    expect(row).toHaveTextContent("2026-07-10");
    expect(row).toHaveTextContent("General medicine");
    expect(row).toHaveTextContent("Dr Meera Rao");
    expect(row).toHaveTextContent("Acute gastritis");

    cleanup();
    vi.unstubAllGlobals();

    // §14 / D-37: a hidden confidential record answers 404 — restricted mode, UHID only, no crash.
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/queues": { status: 200, body: QUEUE_VIEW_HIDDEN },
      "GET /api/patients/p-1": {
        status: 404, body: { statusCode: 404, message: "unknown patient p-1", error: "Not Found" },
      },
      "GET /api/patients/p-1/allergies": {
        status: 404, body: { statusCode: 404, message: "unknown patient p-1", error: "Not Found" },
      },
    });
    const user2 = userEvent.setup();
    await openPanel(user2);

    expect(await screen.findByTestId("restricted-banner")).toBeInTheDocument();
    expect(screen.getByTestId("panel-uhid")).toHaveTextContent("HMS0000000020");
    expect(screen.queryByTestId("panel-patient-name")).toBeNull();
    expect(screen.queryByText("Asha Devi")).toBeNull();
    expect(screen.queryByTestId("allergy-chips")).toBeNull();
  });

  it("the note autosaves with PUT /opd/visits/:id/consult/note on BLUR — never on keystroke — and a blur that changed nothing sends nothing", async () => {
    mockRoutes({ ...baseRoutes(), "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } } });
    const user = userEvent.setup();
    await openPanel(user);
    const path = "/api/opd/visits/enc-1/consult/note";

    /* DIAGNOSIS IS A TAG FIELD SINCE 2026-09-14 and its keystroke contract is the complaint's:
       typing holds a draft, Enter commits the doctor's own words verbatim as a tag. */
    const diagnosis = await screen.findByLabelText("Diagnosis");
    await user.click(diagnosis);
    await user.type(diagnosis, "Acute pharyngitis");
    // typing is NOT the trigger — a screen saving on change would already have posted here
    expect(callsTo("PUT", path)).toHaveLength(0);
    await user.type(diagnosis, "{Enter}");

    const chief = screen.getByLabelText("Chief complaint");
    await user.click(chief);
    await user.type(chief, "fever 3d{Enter}");
    const advice = screen.getByLabelText("Advice");
    await user.click(advice);
    await user.type(advice, "warm fluids");
    await user.click(screen.getByRole("heading", { name: "Consultation" }));

    /*
      `diagnoses`, and NO `diagnosis` / `icd10Code`. The server derives both display columns from
      this list, so the screen sends the fact once instead of three times in shapes that can
      disagree. `icd10Code` is null because these are the doctor's own words — a tag only carries a
      code when it came from the catalogue, which the ICD-10 tests below cover.
    */
    await waitFor(() => expect(bodiesOf("PUT", path).at(-1)).toEqual({
      chiefComplaint: "fever 3d",
      diagnoses: [{ text: "Acute pharyngitis", icd10Code: null }],
      advice: "warm fluids",
    }));
    expect(await screen.findByTestId("note-saved")).toBeInTheDocument();

    // an unchanged blur is not a save: focus in and straight back out again writes nothing
    const saves = callsTo("PUT", path).length;
    await user.click(screen.getByLabelText("Advice"));
    await user.click(screen.getByRole("heading", { name: "Consultation" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("PUT", path)).toHaveLength(saves);
  });

  it("K48: Issue & print posts the lines with durationDays as a NUMBER; a 409 allergy_conflict opens the override dialog, an empty reason sends nothing, and the confirmed re-post carries `overrides` with a reason per match — then the e-Rx prints", async () => {
    let rxCalls = 0;
    mockRoutes({
      ...baseRoutes(),
      "POST /api/opd/visits/enc-1/prescriptions": () => {
        rxCalls += 1;
        return rxCalls === 1
          ? { status: 409, body: ALLERGY_CONFLICT }
          : {
            status: 201,
            body: { prescriptionId: "rx-1", version: 1, qrPayload: PRINT_DATA.qrPayload, allergyOverrideCount: 1 },
          };
      },
      "GET /api/opd/prescriptions/rx-1/print": { status: 200, body: PRINT_DATA },
    });
    const user = userEvent.setup();
    await openPanel(user);
    const path = "/api/opd/visits/enc-1/prescriptions";

    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(await screen.findByLabelText("Drug"), "Tab Penicillin V");
    await user.type(screen.getByLabelText("Dose"), "1 tab");
    await user.selectOptions(screen.getByLabelText("Frequency"), "TDS");
    await user.selectOptions(screen.getByLabelText("Route"), "oral");
    await user.type(screen.getByLabelText("Days"), "5");
    await user.type(screen.getByLabelText("Instructions"), "after food");
    await user.click(screen.getByRole("button", { name: "Issue & print" }));

    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(1));
    const first = bodiesOf("POST", path)[0]!;
    expect(first).toEqual({
      lines: [{
        drug: "Tab Penicillin V", dose: "1 tab", route: "oral", frequency: "TDS",
        durationDays: 5, instructions: "after food", noSubstitution: false,
        // PLAN 16a T6 / DD9 — a typed line carries `medicineId: null`, and the assertion is
        // `toEqual` so a field appearing in the body without a decision fails here. It did.
        medicineId: null,
      }],
    });
    // §3.19: the form hands back "5"; the BODY must carry the number
    expect(typeof (first.lines as { durationDays: unknown }[])[0]!.durationDays).toBe("number");
    expect("overrides" in first).toBe(false);

    // the hard-warning dialog: one reason field per matched line, naming the substance
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Line 1: Penicillin")).toBeInTheDocument();

    // the reason is the rule: confirming with it blank sends NOTHING (the button is deliberately live)
    await user.click(within(dialog).getByRole("button", { name: "Override and issue" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", path)).toHaveLength(1);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("A reason is required for every conflict");

    await user.type(within(dialog).getByLabelText("Line 1: Penicillin"), "tolerated previously, benefit outweighs");
    await user.click(within(dialog).getByRole("button", { name: "Override and issue" }));

    // K48 — the re-post carries the overrides array, a reason per match, and the SAME lines
    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(2));
    const second = bodiesOf("POST", path)[1]!;
    expect(second.overrides).toEqual([
      { lineIndex: 0, substance: "Penicillin", reason: "tolerated previously, benefit outweighs" },
    ]);
    expect(second.lines).toEqual(first.lines);

    // the e-Rx is fetched and printed — and exactly ONE .print-doc is mounted anywhere in the document
    await waitFor(() => expect(callsTo("GET", "/api/opd/prescriptions/rx-1/print")).toHaveLength(1));
    await waitFor(() => expect(document.querySelectorAll(".print-doc")).toHaveLength(1));
    expect(document.querySelector(".print-doc")).toHaveTextContent("CRK MEDICAL COLLEGE & HOSPITAL");
    expect(screen.getByRole("button", { name: "Print prescription" })).toBeInTheDocument();
  });

  /**
   * PLAN 16a T6 — the formulary picker and the two new hard warnings.
   *
   * The four acceptance points, in order: picking fills the drug NAME and the `medicineId` with it;
   * a severe interaction needs a reason before the submit proceeds; a soft notice never blocks; and
   * the "not in formulary" hint is COVERAGE-GATED, absent even for an unresolved line while
   * coverage is low.
   */
  /**
   * THE PICKER IS A TYPEAHEAD, AND 16a's `<select>` FIXTURE IS GONE WITH THE CONTROL.
   *
   * 16a's picker was a `<select>` fed by the whole medicine table. That control cannot mount a
   * catalogue of 103,383 rows, so the screen asks for ten rows per prefix instead and no test here
   * mocks `/formulary/medicines` any more.
   *
   * #186 landed a SECOND picker — `DrugCombobox` over `/formulary/suggest`, the NRCeS generic tier,
   * which fills the name and deliberately leaves `medicineId` null. It is not wired into this
   * screen and its own suite (`drug-combobox.test.tsx`) covers it; the fixture for it lives there,
   * not here. What this screen renders is `DrugField`, whose pick carries an id — see the header on
   * the drug field in `opd-consult.tsx` for why the owner's ruling points that way.
   */
  /* The typeahead's own shape — ten rows for a prefix, not the catalogue. */
  const DRUG_HITS = {
    items: [
      { id: "m-warf", name: "Warf 5", form: "Oral tablet", strength: "5 mg", code: "D0001", routeClass: "systemic", salts: ["Warfarin sodium"], prefix: true },
    ],
  };
  const SEVERE_HIT = {
    severity: "severe", lineIndex: 0, note: "bleeding risk — avoid or monitor INR closely",
    // C5 — the client echoes this on the override so the server knows which hit was cleared.
    saltPair: ["s-asa", "s-warf"],
    against: { scope: "prior", prescriptionId: "rx-old", issuedAt: "2026-08-08T04:00:00.000Z", assumedCurrent: false },
  };

  it("16a: the picker fills the name AND the id, and a severe interaction needs a reason before it will issue", async () => {
    let rxCalls = 0;
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/medicines/search": { status: 200, body: DRUG_HITS },
      "GET /api/formulary/coverage": { status: 200, body: { coverage: 0.92, noticeEnabled: true } },
      "POST /api/opd/visits/enc-1/rx-precheck": {
        status: 201,
        body: { allergyMatches: [], interactions: [SEVERE_HIT], duplicates: [], notices: [], unresolvedLineIndexes: [] },
      },
      "POST /api/opd/visits/enc-1/prescriptions": () => {
        rxCalls += 1;
        return {
          status: 201,
          body: {
            prescriptionId: "rx-1", version: 1, qrPayload: PRINT_DATA.qrPayload,
            allergyOverrideCount: 0, interactionOverrideCount: 1, duplicateOverrideCount: 0, notices: [],
          },
        };
      },
      "GET /api/opd/prescriptions/rx-1/print": { status: 200, body: PRINT_DATA },
    });
    const user = userEvent.setup();
    await openPanel(user);
    const path = "/api/opd/visits/enc-1/prescriptions";

    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await screen.findByLabelText("Drug");

    /* THE PICKER IS A TYPEAHEAD SINCE 2026-09-14 — a `<select>` of the whole catalogue became
       103,383 options once the owner's bundle landed. Three letters, then tap the row. */
    await user.type(screen.getByLabelText("Drug"), "warf");
    await user.click(await screen.findByTestId("rx-drug-0-hit-m-warf"));
    expect(screen.getByLabelText("Drug")).toHaveValue("Warf 5");
    await user.type(screen.getByLabelText("Dose"), "1 tab");
    await user.click(screen.getByRole("button", { name: "Issue & print" }));

    // The pre-check opened the dialog, and NOTHING was posted to the issue route.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/bleeding risk/)).toBeInTheDocument();
    // The prior-scope label, which is the honest half: it names when, not just what.
    expect(within(dialog).getByText(/prescribed \d+ days ago/)).toBeInTheDocument();
    expect(callsTo("POST", path)).toHaveLength(0);

    // A blank reason sends nothing — the same rule the allergy dialog has always had.
    await user.click(within(dialog).getByRole("button", { name: "Override and issue" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", path)).toHaveLength(0);
    expect(within(dialog).getByText("A reason is required for every conflict")).toBeInTheDocument();

    await user.type(within(dialog).getByTestId("interaction-reason-0"), "cardiology advised dual therapy");
    await user.click(within(dialog).getByRole("button", { name: "Override and issue" }));

    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(1));
    const body = bodiesOf("POST", path)[0]! as {
      lines: { medicineId: string | null }[];
      interactionOverrides: { lineIndex: number; reason: string }[];
    };
    /*
     * DD9 INVERTED, DELIBERATELY, AND THIS LINE IS THE RECORD OF IT.
     *
     * It read `toBe("m-warf")`: picking carried the medicine id to the server. A pick now carries
     * THE ID, and #186 asserted `null` here on a premise that has since been measured away.
     *
     * Its reasoning was sound and its mechanism is still real: an id is what tells every downstream
     * guard the line was checked, so setting one on a row nothing can check makes `getCoverage`
     * report a working formulary over lines no interaction, duplicate or allergy rule can read.
     * What it rested on was *"the catalogue it picks from is 97.7% uncurated"*. Measured on the
     * imported catalogue, 2026-09-14: **103,375 of 103,383 active medicines carry a moiety, and 8
     * do not.**
     *
     * So the property is kept where it cannot rot, instead of by refusing the id: `searchMedicines`
     * no longer OFFERS a row with no moiety (`search.test.ts` S1, mutation-checked). Every id this
     * field can hand back is therefore one the safety layer can reason about, which is what makes
     * picking worth more than typing — and what the owner asked for on 2026-09-14: one drug list,
     * one safety layer. A hand-typed line still carries `null`, pinned two tests below.
     */
    expect(body.lines[0]!.medicineId).toBe("m-warf");
    expect(body.interactionOverrides).toEqual([{
      lineIndex: 0, reason: "cardiology advised dual therapy", saltPair: ["s-asa", "s-warf"],
    }]);
    expect("duplicateOverrides" in body).toBe(false);
    expect(rxCalls).toBe(1);
  });

  /**
   * C7 (independent review) — 16a's STATE MUST NOT OUTLIVE THE PATIENT IT BELONGS TO.
   *
   * `resetPanel` cleared the shipped allergy state and none of the seven fields T6 added. The
   * dangerous one is the dialog: its `open` reads `matches !== null || interactionHits.length > 0
   * || duplicateHits.length > 0`, and nulling `matches` alone left it OPEN across a patient change
   * — where confirming would post patient A's overrides against patient B's lines.
   */
  it("16a: starting the next patient clears every trace of the last one's checks", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/medicines/search": { status: 200, body: DRUG_HITS },
      "GET /api/formulary/coverage": { status: 200, body: { coverage: 0.92, noticeEnabled: true } },
      "POST /api/opd/visits/enc-1/rx-precheck": {
        status: 201,
        body: {
          allergyMatches: [], interactions: [SEVERE_HIT], duplicates: [], notices: [],
          unresolvedLineIndexes: [0],
        },
      },
      "POST /api/opd/visits/enc-1/consult/complete": { status: 201, body: { ok: true } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    /* THE PICKER IS A TYPEAHEAD SINCE 2026-09-14 — a `<select>` of the whole catalogue became
       103,383 options once the owner's bundle landed. Three letters, then tap the row. */
    await user.type(screen.getByLabelText("Drug"), "warf");
    await user.click(await screen.findByTestId("rx-drug-0-hit-m-warf"));
    await user.type(screen.getByLabelText("Dose"), "1 tab");
    await user.click(screen.getByRole("button", { name: "Issue & print" }));

    // Patient A's override dialog is open, holding A's hit.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/bleeding risk/)).toBeInTheDocument();

    /**
     * The doctor moves on with the keyboard — Ctrl+Enter completes the consultation, and the
     * handler is WINDOW-LEVEL, so it fires while the modal is open. That is not a contrivance to
     * reach a blocked button: it is the reviewer's actual scenario, and it is why a stale dialog
     * was dangerous rather than merely untidy. `complete()` calls `resetPanel()`, which is the
     * function that used to clear the allergy state and none of 16a's.
     *
     * ═══ CLOSE PASS 1 — THE MECHANISM CHANGED AND THE CLAIM DID NOT ═══
     *
     * This drove the completion with Ctrl+Enter THROUGH the open dialog, which was possible because
     * the screen's window handler ran straight past the modal. Pass 1 found that to be a CRITICAL in
     * its own right — a doctor typing an override reason and pressing the chord their own keycap row
     * advertises completed the visit, discarded the prescription and showed no error — so the screen
     * now stands down while a `role="dialog"` is mounted.
     *
     * The route to the same state is therefore the dialog's own Escape, then the Complete button.
     * What is asserted below is unchanged and is the whole point: `resetPanel` must leave NO trace of
     * patient A's checks behind for patient B. Rewriting the mechanism rather than weakening the
     * assertion, because the assertion was never about the keyboard.
     */
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Complete consultation" }));

    /**
     * THE DIALOG IS GONE — not merely emptied of allergy matches. Before the fix `resetPanel` nulled
     * `matches` and left `interactionHits` populated, so the dialog stayed open with patient A's hit
     * in it while the panel moved on; confirming there would have posted A's overrides against B's
     * lines. The panel itself closes on completion, which is why nothing below reaches for the rx
     * tab: there is no active patient until the next one is started, and that is the point.
     */
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByTestId("rx-notices")).toBeNull();
    expect(screen.queryByTestId("rx-uncovered-0")).toBeNull();
    expect(screen.queryByTestId("patient-panel")).toBeNull();
  });

  it("16a: a soft notice never blocks, and the uncovered-line hint stays silent until coverage says otherwise", async () => {
    const SOFT = {
      moiety: "paracetamol", lineIndex: 0, hard: false,
      against: { scope: "prior", prescriptionId: "rx-old", issuedAt: "2026-08-08T04:00:00.000Z", assumedCurrent: true },
    };
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/medicines/search": { status: 200, body: DRUG_HITS },
      // T8 is not deployed in this scenario: a 404 means the hint stays OFF, which is also the
      // correct long-term degrade (DD5).
      "GET /api/formulary/coverage": { status: 404, body: { message: "not found" } },
      "POST /api/opd/visits/enc-1/rx-precheck": {
        status: 201,
        body: {
          allergyMatches: [], interactions: [], duplicates: [SOFT], notices: [SOFT],
          unresolvedLineIndexes: [0],
        },
      },
      "POST /api/opd/visits/enc-1/prescriptions": {
        status: 201,
        body: {
          prescriptionId: "rx-1", version: 1, qrPayload: PRINT_DATA.qrPayload,
          allergyOverrideCount: 0, interactionOverrideCount: 0, duplicateOverrideCount: 0, notices: [SOFT],
        },
      },
      "GET /api/opd/prescriptions/rx-1/print": { status: 200, body: PRINT_DATA },
    });
    const user = userEvent.setup();
    await openPanel(user);
    const path = "/api/opd/visits/enc-1/prescriptions";

    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(await screen.findByLabelText("Drug"), "Some Ayurvedic Tonic");
    await user.type(screen.getByLabelText("Dose"), "10 ml");
    await user.click(screen.getByRole("button", { name: "Issue & print" }));

    // A soft hit posts straight through: no dialog, no gate.
    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "Allergy conflict" })).toBeNull();

    const panel = await screen.findByTestId("rx-notices");
    expect(within(panel).getByTestId("rx-notice-0")).toHaveTextContent("already contains paracetamol");
    // The assumed-currency label, and the in-system-only honesty line (design law 10).
    expect(within(panel).getByText(/may no longer be current/)).toBeInTheDocument();
    expect(within(panel).getByText("Checked against in-system prescriptions only")).toBeInTheDocument();

    // THE COVERAGE GATE. The line is unresolved and the server said so — and the hint is still
    // absent, because coverage is unknown. Below the threshold it would fire on nearly every line.
    expect(screen.queryByTestId("rx-uncovered-0")).toBeNull();

    // The e-Rx print dialog is open on top after a successful issue — the notices are BEHIND it,
    // which is the real order of events: the doctor prints, closes, and then reads what was noted.
    // Dismissing while a modal is open is not a state a user can reach, so the test does not fake one.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(within(await screen.findByTestId("rx-notices")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("rx-notices")).toBeNull();
  });

  it("K49: completing with the DEFAULT follow-up OMITS followUpDays from the posted key set; an extension travels as a number, a stubbed 409 extension_cap_reached renders inline and keeps the form, and a real 201 closes the panel and refetches the queue", async () => {
    let completeCalls = 0;
    let queueCalls = 0;
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/queues": () => {
        queueCalls += 1;
        return { status: 200, body: QUEUE_VIEW };
      },
      "POST /api/opd/visits/enc-1/consult/complete": () => {
        completeCalls += 1;
        return completeCalls === 1
          ? {
            status: 409,
            body: {
              statusCode: 409, message: "follow-up extension cap reached for this month",
              code: "extension_cap_reached",
            },
          }
          // Nest's DEFAULT 201 (erratum E5) — the screen must treat any 2xx as success, never an exact 200.
          : { status: 201, body: { encounter: { ...ENCOUNTER, status: "completed" } } };
      },
    });
    const user = userEvent.setup();
    await openPanel(user);
    const path = "/api/opd/visits/enc-1/consult/complete";

    // (a) an extension plus the outcome controls — refused by the server, and the form survives it
    await user.selectOptions(screen.getByLabelText("Follow-up"), "15");
    await user.click(screen.getByLabelText("Tests ordered — patient returns today"));
    await user.click(screen.getByLabelText("Admission advised"));
    await user.type(screen.getByLabelText("Referred to"), "AIIMS Patna");
    await user.type(screen.getByLabelText("Referral note"), "cardiac eval");
    await user.click(screen.getByRole("button", { name: "Complete consultation" }));

    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(1));
    const refused = bodiesOf("POST", path)[0]!;
    expect(refused).toEqual({
      note: {
        /* An empty diagnosis field is an empty LIST, not a null string — the server reads `[]` as
           "the doctor cleared it" and writes null to both display columns from that one fact. */
        chiefComplaint: null, diagnoses: [], advice: null,
        admissionAdvised: true, referralTo: "AIIMS Patna", referralNote: "cardiac eval",
      },
      testsOrderedReturnToday: true,
      followUpDays: 15,
    });
    expect(typeof refused.followUpDays).toBe("number");

    const refusal = await screen.findByText("follow-up extension cap reached for this month");
    expect(refusal).toHaveAttribute("role", "alert");
    // the form state is preserved: nothing was cleared by the refusal
    expect(screen.getByTestId("patient-panel")).toBeInTheDocument();
    expect(screen.getByLabelText("Follow-up")).toHaveValue("15");
    expect(screen.getByLabelText("Referred to")).toHaveValue("AIIMS Patna");
    expect(screen.getByLabelText("Admission advised")).toBeChecked();

    // (b) back to the DEFAULT window — K49: the key is ABSENT, so the server's own default applies
    await user.selectOptions(screen.getByLabelText("Follow-up"), "");
    const queueBefore = queueCalls;
    await user.click(screen.getByRole("button", { name: "Complete consultation" }));

    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(2));
    const completed = bodiesOf("POST", path)[1]!;
    expect("followUpDays" in completed).toBe(false);
    expect(Object.keys(completed).sort()).toEqual(["note", "testsOrderedReturnToday"]);

    // the real 201 is a success: the panel closes and the queue is re-read
    await waitFor(() => expect(screen.queryByTestId("patient-panel")).toBeNull());
    await waitFor(() => expect(queueCalls).toBeGreaterThan(queueBefore));
  });

  /**
   * ——— THE SIGNED-OFF KEYMAP, absorbing K44 / Plan 08 T15 ———
   *
   * Plan 07 shipped this screen with FOUR local Alt handlers and asserted ONE of them. Its gate
   * mutant `gateX4` — a copy of the screen with the other three handlers stripped — SURVIVED the
   * whole suite, which is the definition of an untested lane: the doctor's fastest three keys were
   * held up by nothing. Plan 08 absorbed them as required-DIED (W-8).
   *
   * FD-25 replaces the CHORDS and keeps the DISCIPLINE. The keyboard artboard is signed off and
   * contains no Alt chord at all — FD-5 parked them — so these tests now describe the keys this
   * screen actually binds. Each still asserts THE POSTED CALL rather than a rendered state, because
   * a rendered state can be reached with a mouse and would not tell the two apart.
   */
  it("the keymap: Enter with nobody called CALLS NEXT, and does not start or skip anybody", async () => {
    mockRoutes({
      ...baseRoutes(),
      /* Nobody is in the chair — this is the state where "the obvious next thing" is to call. */
      "GET /api/opd/queues": { status: 200, body: { ...QUEUE_VIEW, current: null } },
      "POST /api/opd/queues/sess-1/call-next": { status: 201, body: { entry: CURRENT, encounter: ENCOUNTER } },
    });
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-a");

    await user.keyboard("{Enter}");

    await waitFor(() => expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")).toHaveLength(1));
    expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")[0]!.body).toBe("");
    /* One key, one lane: Enter is "the obvious next thing", not "do everything". */
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/start")).toHaveLength(0);
    expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")).toHaveLength(0);
  });

  /**
   * THE SAME KEY, THE OTHER STATE. This is the half that makes Enter worth binding at all: a doctor
   * presses one key twice to go from an empty chair to an open consultation, and never has to know
   * which of two commands they are issuing. A binding that always called next would leave the
   * patient standing; one that always started would post `consult/start` against nobody.
   */
  it("the keymap: Enter with a patient CALLED starts the consultation instead", async () => {
    mockRoutes(baseRoutes());
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");

    await user.keyboard("{Enter}");

    await waitFor(() => expect(callsTo("POST", "/api/opd/visits/enc-1/consult/start")).toHaveLength(1));
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/start")[0]!.body).toBe("");
    expect(await screen.findByTestId("patient-panel")).toBeInTheDocument();
    expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")).toHaveLength(0);
  });

  it("the keymap: Ctrl+Enter completes the open consultation — the same body the button posts, with the default follow-up window OMITTED", async () => {
    mockRoutes({
      ...baseRoutes(),
      "POST /api/opd/visits/enc-1/consult/complete": {
        status: 201, body: { encounter: { ...ENCOUNTER, status: "completed" } },
      },
    });
    const user = userEvent.setup();
    await openPanel(user);
    const path = "/api/opd/visits/enc-1/consult/complete";

    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => expect(callsTo("POST", path)).toHaveLength(1));
    // K49's rule holds through the keyboard too: the key is ABSENT, so the OPD config's own
    // `followUpDefaultDays` applies rather than a number this screen invented.
    const body = bodiesOf("POST", path)[0]!;
    expect(Object.keys(body).sort()).toEqual(["note", "testsOrderedReturnToday"]);
    expect(body.testsOrderedReturnToday).toBe(false);
    await waitFor(() => expect(screen.queryByTestId("patient-panel")).toBeNull());
  });

  /**
   * ESCAPE IS TWO-STAGE, AND THE FIRST PRESS MUST NOT RELEASE ANYBODY.
   *
   * The Keymap's words are "once back to the search box, twice clear the desk" — on this seat, once
   * back to the queue and twice release the patient. The reason it is two presses rather than one
   * with a confirm dialog is that a doctor learns to dismiss a dialog: the second press IS the
   * confirmation, and it costs nothing to reach.
   *
   * This screen had no Escape at all before FD-25, which is why the assertion is written from both
   * sides — the panel SURVIVES the first press and is gone after the second.
   */
  it("the keymap: Escape once leaves the field, Escape twice releases the patient", async () => {
    mockRoutes(baseRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    await user.keyboard("{Escape}");
    /* Still in hand. A single press that released the patient would lose a half-written note. */
    expect(screen.getByTestId("patient-panel")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("patient-panel")).toBeNull());
    /* Releasing is a SCREEN act, not a server one — nothing about the encounter changed. */
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/complete")).toHaveLength(0);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * CLOSE PASS 2, CRITICAL — THE MODAL GUARD MADE THE DISARM UNREACHABLE
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Pass 1 fixed a real defect: Ctrl+Enter fired straight through the override dialog and completed
   * the visit. The fix was an early return at the top of the handler whenever a `role="dialog"` is
   * mounted — and that return sits ABOVE `escArmed = false`, the line every non-Escape key reaches.
   *
   * So the two-stage Escape's memory, a closure variable, stopped being cleared by typing. Arm it
   * before a dialog opens and it is still armed after the dialog closes:
   *
   *   1. Esc once — "let me look at the queue".            escArmed = true   (correct)
   *   2. Issue the prescription; the server refuses; the override dialog opens.
   *   3. Type the override reason.                          every keystroke returns at the guard
   *   4. Confirm. The dialog closes.
   *   5. Esc ONCE, meaning "back to the queue".             THE PATIENT IS RELEASED
   *
   * Pass 1's own scenario — two presses with nothing between — was genuinely fixed. This is the same
   * failure moved one press EARLIER, and the existing tests could not see it because none of them
   * puts a keystroke inside a dialog and an Escape outside one.
   *
   * A fix aimed at an instance closes the instance. This is what pass 2 is for.
   */
  /**
   * ═══ CLOSE PASS 2 — THE MODAL GUARD ITSELF HAD NOTHING WATCHING IT ═══
   *
   * Pass 1 fixed a CRITICAL: Ctrl+Enter fired through the override dialog, completing the visit and
   * discarding the prescription with no error. The 16a test used to travel that road, and rewriting
   * its mechanism (correctly — the road is now closed) left the guard itself unasserted. A revert
   * pair run at `efc10dd` in an isolated worktree measured it: delete the guard and all 25 consult
   * tests still pass.
   *
   * This is that test. The chord must do NOTHING while the dialog is up.
   */
  it("CLOSE PASS 2: Ctrl+Enter does not complete the visit while the override dialog is open", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/medicines/search": { status: 200, body: DRUG_HITS },
      "POST /api/opd/visits/enc-1/prescriptions": {
        status: 409,
        body: { statusCode: 409, code: "allergy_conflict", message: "allergy", detail: { matches: [{ lineIndex: 0, substance: "Penicillin" }] } },
      },
      "POST /api/opd/visits/enc-1/consult/complete": { status: 201, body: { encounter: ENCOUNTER } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(await screen.findByLabelText("Drug"), "Tab Penicillin V");
    await user.type(screen.getByLabelText("Dose"), "1 tab");
    await user.click(screen.getByRole("button", { name: "Issue & print" }));
    await screen.findByRole("dialog");

    /* The doctor reaches for the chord their own keycap row advertises, mid-override. */
    await user.keyboard("{Control>}{Enter}{/Control}");
    await act(async () => { await Promise.resolve(); });

    /*
      NOTHING WAS POSTED and the dialog is still up. Before the guard this completed the visit, ran
      `resetPanel()` — clearing `matches`, `interactionHits` and the whole prescription form — and
      showed no error, because nothing had failed.
    */
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/complete")).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("patient-panel")).toBeInTheDocument();
  });

  it("CLOSE PASS 2: typing inside a dialog disarms the two-stage Escape — one press afterwards does not release the patient", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/medicines/search": { status: 200, body: DRUG_HITS },
      "POST /api/opd/visits/enc-1/prescriptions": {
        status: 409,
        body: { statusCode: 409, code: "allergy_conflict", message: "allergy", detail: { matches: [{ lineIndex: 0, substance: "Penicillin" }] } },
      },
    });
    const user = userEvent.setup();
    await openPanel(user);

    /*
      (1) The prescription is written FIRST. Order matters and it is the whole reason this defect is
      reachable: typing disarms, so the arming press has to be the last KEYSTROKE before the dialog.
      Everything after it is a CLICK, and a click never reaches a keydown handler.
    */
    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(await screen.findByLabelText("Drug"), "Tab Penicillin V");
    await user.type(screen.getByLabelText("Dose"), "1 tab");

    /* (2) The doctor glances at the queue before issuing. Stage one, exactly as designed. */
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("patient-panel")).toBeInTheDocument();

    /* (3) Issues with the mouse; the server refuses; the override dialog opens. */
    await user.click(screen.getByRole("button", { name: "Issue & print" }));
    const dialog = await screen.findByRole("dialog");

    /* (4) The doctor types a reason. Every one of these keystrokes must disarm. */
    await user.type(within(dialog).getByLabelText(/Penicillin/), "documented tolerance");

    /* (5) Escape dismisses the dialog — and is consumed by it. */
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    /*
      (6) THE ASSERTION. One Escape, meaning "back to the queue". The patient must still be in hand:
      a doctor who has typed into a dialog has given this screen no instruction to drop anybody.
    */
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("patient-panel")).toBeInTheDocument();

    /* And the stage machine is not broken — from a clean start, two presses still release. */
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("patient-panel")).toBeNull());
  });

  /**
   * ═══ NOT OVER-BROAD (§3.44) — THE GUARD THAT KEEPS A BOUND KEY OUT OF A FIELD ═══
   *
   * Binding bare Enter is the risky half of the signed-off keymap, and this is the test that makes
   * it safe. `inField()` is new in FD-25 and it is the only thing standing between "Enter does the
   * obvious next thing" and "Enter in the middle of a chief complaint calls the next patient while
   * this one is still talking".
   *
   * Ctrl+Enter is deliberately NOT guarded that way — a commit chord must work from wherever the
   * cursor happens to be, which is the whole reason the Keymap made it a chord — so this asserts
   * both halves: the bare key stands down inside a field and the chord does not.
   */
  it("NOT OVER-BROAD (§3.44): a key this screen does not bind fires nothing, bare Enter inside the note is TEXT and not a command, Ctrl+Enter is a chord that commits from anywhere, and a form's own submit is not doubled by this screen", async () => {
    mockRoutes({
      ...baseRoutes(),
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
      "POST /api/opd/queues/entries/qe-cur/skip": { status: 201, body: { entry: CURRENT } },
      "POST /api/opd/visits/enc-1/consult/complete": { status: 201, body: { encounter: ENCOUNTER } },
      "POST /api/opd/visits/enc-1/prescriptions": {
        status: 201,
        body: { prescriptionId: "rx-1", version: 1, qrPayload: PRINT_DATA.qrPayload, allergyOverrideCount: 0 },
      },
      "GET /api/opd/prescriptions/rx-1/print": { status: 200, body: PRINT_DATA },
    });
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");

    // (a) a key this screen does not bind reaches none of its lanes
    await user.keyboard("{Alt>}x{/Alt}");
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")).toHaveLength(0);
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/start")).toHaveLength(0);
    expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")).toHaveLength(0);

    // (b) BARE ENTER WHERE A DOCTOR ACTUALLY TYPES IT. Since the complaint became a tag field it
    // COMMITS A TAG there — a local act — and it must still reach none of this screen's lanes.
    // `inField()` covers INPUT, which is what the tag field's editor is.
    await user.click(screen.getByRole("button", { name: "Start consultation" }));
    await screen.findByTestId("patient-panel");
    await user.type(screen.getByLabelText("Chief complaint"), "ks");
    await user.keyboard("{Enter}");
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")).toHaveLength(0);
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/complete")).toHaveLength(0);
    expect(callsTo("POST", "/api/opd/queues/sess-1/call-next")).toHaveLength(0);
    // The keystroke was TEXT: it made a tag and cleared the editor, and no lane fired.
    expect(screen.getByTestId("note-chief-tag-0")).toHaveTextContent("ks");
    expect(screen.getByLabelText("Chief complaint")).toHaveValue("");

    // (b2) THE CHORD IS NOT GUARDED THE SAME WAY, and that is the point of it being a chord: the
    // cursor is still inside the note, and Ctrl+Enter commits from there.
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(callsTo("POST", "/api/opd/visits/enc-1/consult/complete")).toHaveLength(1));
    /* Completing closes the panel, so the prescription half below re-opens one. */
    await waitFor(() => expect(screen.queryByTestId("patient-panel")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Start consultation" }));
    await screen.findByTestId("patient-panel");

    // (c) the FormKit prescription form keeps its OWN submit chord, and this screen adds nothing to
    // it. Exactly ONE prescription is posted — a screen-level handler on the same keystroke would
    // issue the e-Rx twice from one press, which is a duplicate prescription and not a UI glitch.
    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(await screen.findByLabelText("Drug"), "Tab Paracetamol");
    await user.type(screen.getByLabelText("Dose"), "500 mg");
    await user.selectOptions(screen.getByLabelText("Route"), "oral");
    await user.selectOptions(screen.getByLabelText("Frequency"), "TDS");
    await user.type(screen.getByLabelText("Days"), "3");
    await user.keyboard("{Alt>}s{/Alt}");

    await waitFor(() => expect(document.querySelectorAll(".print-doc")).toHaveLength(1));
    expect(callsTo("POST", "/api/opd/visits/enc-1/prescriptions")).toHaveLength(1);
  });
});

/**
 * PLAN 07d T1/T2/T6 — **THE PAST RECORD, WHICH THE DOCTOR HAS NEVER BEEN ABLE TO READ.**
 *
 * Before this task the history tab was one line per past visit and there was NO way to read a prior
 * prescription at all — the only cross-encounter prescription query in the tree was private to the
 * interaction checker. These assertions are about the three things that makes true: that the two
 * new views exist and render the server's rows, that they are fetched ONLY when opened (each is a
 * PHI read that writes an access-log row, and a read nobody looked at should not be recorded as
 * one), and that an empty one says so rather than spinning.
 */
const RX_HISTORY = {
  items: [
    {
      prescriptionId: "rx-2", encounterId: "enc-9", serviceDate: "2026-07-02", issuedAt: NOW_ISO,
      doctorId: "doc-1", doctorName: "Dr Meera Rao", status: "active", version: 1,
      lines: [{ drug: "Tab Amoxicillin 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null }],
    },
    {
      prescriptionId: "rx-1", encounterId: "enc-8", serviceDate: "2026-03-11", issuedAt: NOW_ISO,
      doctorId: "doc-2", doctorName: "Dr A Left", status: "superseded", version: 1,
      lines: [{ drug: "Tab Metformin 500 mg", dose: "1 tab", route: "oral", frequency: "BD", durationDays: null, instructions: null }],
    },
  ],
};
const VITALS_HISTORY = {
  items: [
    { vitalsId: "v-1", encounterId: "enc-8", serviceDate: "2026-03-11", recordedAt: NOW_ISO, sbp: 124, dbp: 82, pulse: 78, rr: 16, spo2: 98, tempC: 36.8, band: "adult", dangerFlags: [] },
    { vitalsId: "v-2", encounterId: "enc-9", serviceDate: "2026-07-02", recordedAt: NOW_ISO, sbp: 168, dbp: 104, pulse: 92, rr: 18, spo2: 96, tempC: 37.1, band: "adult", dangerFlags: [{ vital: "sbp", value: 168, bound: "max", limit: 160 }] },
  ],
};

describe("07d T1 — the past-record panel", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    FakeWebSocket.reset();
    resetRealtimeClientForTests();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    setToken("t-1");
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  /** The file's own harness, reused rather than duplicated — `baseRoutes` already reaches the panel. */
  function withHistory(over: Record<string, Handler> = {}): Record<string, Handler> {
    return {
      ...baseRoutes(),
      "GET /api/opd/patients/p-1/prescriptions": { status: 200, body: RX_HISTORY },
      "GET /api/opd/patients/p-1/vitals": { status: 200, body: VITALS_HISTORY },
      ...over,
    };
  }

  const asked = (path: string): boolean => fetchCalls().some((c) => c.path.includes(path));

  async function openHistoryTab(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await openPanel(user);
    await user.click(screen.getByRole("tab", { name: "History" }));
    await screen.findByTestId("timeline");
  }

  it("T2: the queue's DEPTH is shown, not only its rows — a doctor should not have to count", async () => {
    mockRoutes(withHistory());
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");

    expect(screen.getByTestId("queue-depth")).toHaveTextContent("2 waiting");
  });

  /** T6 — 07c built the brief; a doctor who must navigate to it from the front door will not. */
  it("T6: the doctor's own day is one click from the cockpit", async () => {
    mockRoutes(withHistory());
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");

    expect(screen.getByRole("link", { name: "My day" })).toHaveAttribute("href", "/my-day");
  });

  /**
   * THE LAZY FETCH IS A PRIVACY PROPERTY, NOT A PERFORMANCE ONE. Each history read writes a row
   * into the PHI access log, so firing both on every consult render — or even on opening the tab —
   * would fill the DPDP register with reads nobody performed.
   */
  it("T1: neither history is read until its own view is opened", async () => {
    mockRoutes(withHistory());
    await openHistoryTab(userEvent.setup());

    expect(asked("/opd/patients/p-1/prescriptions")).toBe(false);
    expect(asked("/opd/patients/p-1/vitals")).toBe(false);
  });

  it("T1: the prescription history renders every past prescription, and LABELS a superseded one", async () => {
    mockRoutes(withHistory());
    const user = userEvent.setup();
    await openHistoryTab(user);

    await user.click(screen.getByRole("button", { name: "Prescriptions" }));

    expect(await screen.findByText(/Tab Amoxicillin 500 mg/)).toBeInTheDocument();
    // A superseded version is SHOWN and labelled, never hidden: "what was this patient actually
    // given in March" may well be the superseded row.
    expect(screen.getByText(/Tab Metformin 500 mg/)).toBeInTheDocument();
    expect(screen.getByText("Superseded")).toBeInTheDocument();
    // E-7 — a prescription from a doctor who has left is readable; authorship is history.
    expect(screen.getByText("Dr A Left")).toBeInTheDocument();
  });

  it("T1: the vitals history renders OLDEST first, so it reads as a trend, and flags a danger row", async () => {
    mockRoutes(withHistory());
    const user = userEvent.setup();
    await openHistoryTab(user);

    await user.click(screen.getByRole("button", { name: "Vitals" }));

    const panel = await screen.findByTestId("vitals-history");
    const text = panel.textContent ?? "";
    expect(text.indexOf("2026-03-11")).toBeLessThan(text.indexOf("2026-07-02"));
    expect(text).toContain("168/104");
    expect(within(panel).getByText("flagged")).toBeInTheDocument();
  });

  /**
   * T7 — §1.3 guarantees several panels are empty on day one (zero medicines are seeded and the
   * `pharmacy` role has no holders), so a spinner that never resolves is the worst answer available.
   */
  it("T7: an empty history says so in a sentence rather than spinning", async () => {
    mockRoutes(withHistory({ "GET /api/opd/patients/p-1/prescriptions": { status: 200, body: { items: [] } } }));
    const user = userEvent.setup();
    await openHistoryTab(user);

    await user.click(screen.getByRole("button", { name: "Prescriptions" }));
    expect(await screen.findByText(/No prescription has been issued to this patient/i)).toBeInTheDocument();
  });
});

/**
 * PLAN 07d T5 / DD4 — **ADVISED INVESTIGATIONS ARE ADVICE, AND EVERY SURFACE SAYS SO.**
 *
 * There is no lab or radiology module in this system — no order table, no result table, no
 * accession (measured, §2). So the one thing these assertions defend above all others is that
 * nothing here implies a pipeline that does not exist: the screen says it, the printed slip says
 * it, and the price is a snapshot the counter re-confirms rather than a promise.
 */
const PRICE_LIST = {
  items: [
    { serviceId: "svc-usg", code: "USG-ABD", name: "Ultrasound abdomen", category: "procedure", pricePaise: 120000 },
    { serviceId: "svc-cbc", code: "LAB-CBC", name: "Complete blood count", category: "procedure", pricePaise: 35000 },
  ],
};

describe("07d T5 — advised investigations", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    FakeWebSocket.reset();
    resetRealtimeClientForTests();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    setToken("t-1");
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
    return {
      ...baseRoutes(),
      "GET /api/tariff/price-list": { status: 200, body: PRICE_LIST },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
      ...over,
    };
  }

  it("says on the SCREEN that this creates no order — before a doctor assumes one exists", async () => {
    mockRoutes(routes());
    await openPanel(userEvent.setup());

    const panel = await screen.findByTestId("advised-tests");
    expect(within(panel).getByText(/create no order and book no sample/i)).toBeInTheDocument();
    expect(within(panel).getByText("No investigation advised.")).toBeInTheDocument();
  });

  it("searches the priced catalogue and shows the price beside each service", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    await openPanel(user);

    await user.type(screen.getByLabelText("Search the priced service catalogue"), "ultra");

    expect(await screen.findByText("Ultrasound abdomen — ₹1,200.00")).toBeInTheDocument();
    // A two-character floor: a catalogue search that fires on one letter is a list of everything.
    expect(screen.queryByText(/Complete blood count/)).not.toBeInTheDocument();
  });

  /**
   * The selection is SAVED through the consult-note route, which is what makes it free of new
   * authority: that route already requires the encounter's own treating doctor and an
   * `in_consultation` state.
   */
  it("advising a test saves it on the consult note, with the price as a SNAPSHOT", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    await openPanel(user);

    await user.type(screen.getByLabelText("Search the priced service catalogue"), "ultra");
    await user.click(await screen.findByRole("button", { name: /Ultrasound abdomen/ }));

    await waitFor(() => {
      expect(within(screen.getByTestId("advised-chosen")).getByText("Ultrasound abdomen")).toBeInTheDocument();
    });
    const put = fetchCalls().filter((c) => c.method === "PUT" && c.path.endsWith("/consult/note")).at(-1);
    expect(put?.body).toContain('"serviceId":"svc-usg"');
    // The PRICE travels with it — a reference resolved later would make the printed slip a promise
    // about today's tariff rather than a quotation from this afternoon (E-9).
    expect(put?.body).toContain('"pricePaise":120000');
  });

  it("an advised test can be taken back off, and the removal is saved too", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    await openPanel(user);

    await user.type(screen.getByLabelText("Search the priced service catalogue"), "ultra");
    await user.click(await screen.findByRole("button", { name: /Ultrasound abdomen/ }));
    await screen.findByTestId("advised-chosen");

    await user.click(screen.getByRole("button", { name: "Remove Ultrasound abdomen" }));

    await waitFor(() => { expect(screen.getByText("No investigation advised.")).toBeInTheDocument(); });
    const put = fetchCalls().filter((c) => c.method === "PUT" && c.path.endsWith("/consult/note")).at(-1);
    expect(put?.body).toContain('"advisedTests":[]');
  });

  /** E-10 — a service the hospital has withdrawn never appears; the catalogue is the source. */
  it("a catalogue with nothing matching says why, rather than showing an empty box", async () => {
    mockRoutes(routes({ "GET /api/tariff/price-list": { status: 200, body: { items: [] } } }));
    const user = userEvent.setup();
    await openPanel(user);

    await user.type(screen.getByLabelText("Search the priced service catalogue"), "ultra");
    expect(await screen.findByText(/The catalogue is curated in the tariff, not here/i)).toBeInTheDocument();
  });

});

/**
 * ═══ THE PARKED PATIENT (owner report, 2026-09-13) ═══
 *
 * *"I select call next patient and click on Start consultation … in between the patient decide to
 * stop and he gets outside for 15 minutes … Since I don't have hold/park patient option/button, I
 * simply clicked on call next button. Now the issue is that old patient gets invisible in the
 * dashboard … The patient is kicked out even from the 'My Queue' section."*
 *
 * `inConsult` was on this wire the whole time and the rail rendered `current` and `ordered` only,
 * so a patient the doctor had half-seen was on the server, in the queue view the screen had
 * already fetched, and on no screen in the building. The first test here is that defect exactly:
 * it fails against the shipped rail, which renders two rows and knows nothing of the third.
 */
describe("OpdConsult — parking a patient and picking them up again", () => {
  /** Fifteen minutes ago, measured from the wall clock the row renders against. */
  const PARKED_AT = new Date(Date.now() - 15 * 60_000).toISOString();

  const PARKED = entry({
    id: "qe-park", seq: 4, encounterId: "enc-9", tokenNo: 3, status: "in_consult",
    position: null, queueClass: null, calledAt: NOW_ISO, callCount: 1,
    parkedAt: PARKED_AT, parkedBy: "u-1",
    encounter: { id: "enc-9", patientId: "p-9", visitType: "new", dangerFlagged: false, status: "in_consultation" },
    patient: summary("p-9", "HMS0000000090", "Gita Kumari"),
  });
  const SEATED = entry({
    id: "qe-seat", seq: 5, encounterId: "enc-8", tokenNo: 4, status: "in_consult",
    position: null, queueClass: null, calledAt: NOW_ISO, callCount: 1,
    encounter: { id: "enc-8", patientId: "p-8", visitType: "new", dangerFlagged: false, status: "in_consultation" },
    patient: summary("p-8", "HMS0000000080", "Hari Shankar"),
  });

  const VISIT_9 = {
    encounter: { ...ENCOUNTER, id: "enc-9", patientId: "p-9", status: "in_consultation" },
    queueEntries: [PARKED], vitals: [], prescriptions: [], patient: summary("p-9", "HMS0000000090", "Gita Kumari"),
  };
  const PATIENT_9 = {
    patient: { uhid: "HMS0000000090", name: "Gita Kumari", alias: null, dob: "1990-01-01", administrativeGender: "female" },
    resolvedFrom: null,
  };

  function withInConsult(rows: Record<string, unknown>[], over: Record<string, Handler> = {}): Record<string, Handler> {
    return {
      ...baseRoutes(),
      "GET /api/opd/queues": {
        status: 200,
        body: { ...QUEUE_VIEW, inConsult: rows, counts: { ...QUEUE_VIEW.counts, inConsult: rows.length } },
      },
      "GET /api/opd/visits/enc-9": { status: 200, body: VISIT_9 },
      "GET /api/patients/p-9": { status: 200, body: PATIENT_9 },
      "GET /api/patients/p-9/allergies": { status: 200, body: { items: [] } },
      "GET /api/opd/patients/p-9/timeline": { status: 200, body: { items: [] } },
      ...over,
    };
  }

  it("W1: a patient held mid-consultation is ON the rail, with how long they have been held", async () => {
    mockRoutes(withInConsult([PARKED]));
    renderWithProviders(<OpdConsult />);

    const row = await screen.findByTestId("queue-row-qe-park");
    expect(within(row).getByTestId("queue-token-qe-park")).toHaveTextContent("3");
    expect(within(row).getByText("Gita Kumari")).toBeInTheDocument();
    expect(within(row).getByTestId("queue-parked-qe-park")).toHaveTextContent("Parked 15 min");
    // and the called token and the waiting tokens are still exactly where they were
    expect(screen.getByTestId("queue-row-qe-cur")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("queue-row-qe-a")).toBeInTheDocument();
  });

  it("W2: Resume puts the held patient back in the chair — one POST, and the panel is theirs", async () => {
    mockRoutes(withInConsult([PARKED], {
      "POST /api/opd/visits/enc-9/consult/resume": { status: 201, body: { encounter: VISIT_9.encounter, queueEntry: PARKED } },
    }));
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);

    await user.click(await screen.findByTestId("queue-open-qe-park"));

    await waitFor(() => { expect(callsTo("POST", "/api/opd/visits/enc-9/consult/resume")).toHaveLength(1); });
    expect(await screen.findByTestId("panel-patient-name")).toHaveTextContent("Gita Kumari");
    // NOT a second consultation: the screen never re-starts a visit it is resuming.
    expect(callsTo("POST", "/api/opd/visits/enc-9/consult/start")).toHaveLength(0);
  });

  it("W3: Park empties the chair without ending the visit, and the patient is still on the rail", async () => {
    let parked = false;
    mockRoutes({
      ...baseRoutes(),
      "GET /api/opd/queues": () => ({
        status: 200,
        body: parked
          ? { ...QUEUE_VIEW, current: null, inConsult: [{ ...CURRENT, status: "in_consult", parkedAt: new Date().toISOString(), parkedBy: "u-1" }] }
          : QUEUE_VIEW,
      }),
      "POST /api/opd/visits/enc-1/consult/park": () => {
        parked = true;
        return { status: 201, body: { encounter: ENCOUNTER, queueEntry: CURRENT } };
      },
    });
    const user = userEvent.setup();
    await openPanel(user);

    await user.click(screen.getByRole("button", { name: "Park patient" }));

    await waitFor(() => { expect(callsTo("POST", "/api/opd/visits/enc-1/consult/park")).toHaveLength(1); });
    // the chair is empty…
    expect(await screen.findByText("Nobody is in the chair")).toBeInTheDocument();
    expect(screen.queryByTestId("patient-panel")).toBeNull();
    // …and the visit was NOT completed to get there
    expect(callsTo("POST", "/api/opd/visits/enc-1/consult/complete")).toHaveLength(0);
    // …and they are on the rail, held, with the way back
    expect(await screen.findByTestId("queue-parked-qe-cur")).toBeInTheDocument();
    expect(screen.getByTestId("queue-open-qe-cur")).toHaveTextContent("Resume");
  });

  /**
   * The report's own sequence: no park button existed, so the doctor pressed Call next. That
   * patient is `in_consult` and NOT parked — the row still has to be a door back in, and it must
   * not claim they are held when nobody said so.
   */
  it("W4: a patient left behind by Call next is on the rail as in consultation, and opens without a resume", async () => {
    mockRoutes(withInConsult([SEATED], {
      "GET /api/opd/visits/enc-8": {
        status: 200,
        body: {
          encounter: { ...ENCOUNTER, id: "enc-8", patientId: "p-8", status: "in_consultation" },
          queueEntries: [SEATED], vitals: [], prescriptions: [], patient: summary("p-8", "HMS0000000080", "Hari Shankar"),
        },
      },
      "GET /api/patients/p-8": {
        status: 200,
        body: { patient: { uhid: "HMS0000000080", name: "Hari Shankar", alias: null, dob: "1985-01-01", administrativeGender: "male" }, resolvedFrom: null },
      },
      "GET /api/patients/p-8/allergies": { status: 200, body: { items: [] } },
      "GET /api/opd/patients/p-8/timeline": { status: 200, body: { items: [] } },
    }));
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);

    const row = await screen.findByTestId("queue-row-qe-seat");
    expect(within(row).queryByTestId("queue-parked-qe-seat")).toBeNull();
    await user.click(within(row).getByTestId("queue-open-qe-seat"));

    expect(await screen.findByTestId("panel-patient-name")).toHaveTextContent("Hari Shankar");
    expect(callsTo("POST", "/api/opd/visits/enc-8/consult/resume")).toHaveLength(0);
  });

  /** A refusal is rendered where the doctor reads it, like every other act on this screen. */
  it("W5: a resume the server refuses is shown on the rail, and the chair stays empty", async () => {
    mockRoutes(withInConsult([PARKED], {
      "POST /api/opd/visits/enc-9/consult/resume": {
        status: 409,
        body: { statusCode: 409, message: "this patient is not parked", code: "queue_entry_state_conflict" },
      },
    }));
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);

    await user.click(await screen.findByTestId("queue-open-qe-park"));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("patient-panel")).toBeNull();
  });
});

/**
 * ═══ THE SKIP: A REASON, AND A WAY BACK (owner report, 2026-09-13) ═══
 *
 * *"When as a doctor, I clicked 'Skip' by mistake and that patient is no where to be seen in my
 * dashboard to undo my mistake. … doctors do not have any input box or pre-identified reason to
 * select as a reason to why the doctor has to skip the patient?"*
 *
 * The shipped button posted immediately with an empty body and the row it skipped went back among
 * the waiting unmarked — or, at the third skip, into `left`, which this screen rendered nowhere at
 * all. These five run against that screen and fail on it.
 */
describe("OpdConsult — skipping a token, and taking it back", () => {
  const LEFT_ROW = entry({
    id: "qe-left", seq: 9, encounterId: "enc-7", tokenNo: 2, status: "left", position: null, queueClass: null,
    skips: 3, skipReason: "absent", skipNote: null, skippedAt: NOW_ISO, calledAt: NOW_ISO, callCount: 3,
    encounter: { id: "enc-7", patientId: "p-7", visitType: "new", dangerFlagged: false, status: "waiting" },
    patient: summary("p-7", "HMS0000000070", "Sonali Sri"),
  });
  const SKIPPED_WAITING = entry({
    id: "qe-a", seq: 2, encounterId: "enc-2", tokenNo: 6, position: 2, queueClass: 3,
    skips: 1, skipReason: "at_billing", skipNote: "counter 2", skippedAt: NOW_ISO,
    encounter: { id: "enc-2", patientId: "p-2", visitType: "new", dangerFlagged: false, status: "waiting" },
    patient: summary("p-2", "HMS0000000030", "Ram Prasad"),
  });

  function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
    return { ...baseRoutes(), ...over };
  }

  it("K1: Skip asks WHY before it posts anything — six reasons, and the default is the common one", async () => {
    mockRoutes(routes({ "POST /api/opd/queues/entries/qe-cur/skip": { status: 201, body: { entry: CURRENT } } }));
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");

    await user.click(screen.getByRole("button", { name: "Skip" }));

    const dialog = await screen.findByTestId("skip-dialog");
    expect(within(dialog).getByTestId("skip-reason-absent")).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByTestId("skip-reason-at_billing")).toBeInTheDocument();
    // NOTHING has been posted by opening the dialog — the old screen had already skipped by now
    expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")).toHaveLength(0);

    await user.click(within(dialog).getByTestId("skip-reason-at_investigation"));
    await user.type(within(dialog).getByLabelText("Note (optional)"), "sent for X-ray");
    await user.click(within(dialog).getByTestId("skip-confirm"));

    await waitFor(() => { expect(callsTo("POST", "/api/opd/queues/entries/qe-cur/skip")).toHaveLength(1); });
    expect(bodiesOf("POST", "/api/opd/queues/entries/qe-cur/skip")[0])
      .toEqual({ reason: "at_investigation", note: "sent for X-ray" });
  });

  it("K2: 'Other' cannot be sent without saying what it was", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");
    await user.click(screen.getByRole("button", { name: "Skip" }));

    const dialog = await screen.findByTestId("skip-dialog");
    await user.click(within(dialog).getByTestId("skip-reason-other"));
    expect(within(dialog).getByTestId("skip-confirm")).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Say what the reason was (required)"), "doctor called away");
    expect(within(dialog).getByTestId("skip-confirm")).toBeEnabled();
  });

  it("K3: a token still carrying a skip says so on the rail, and offers the way back", async () => {
    mockRoutes(routes({
      "GET /api/opd/queues": { status: 200, body: { ...QUEUE_VIEW, ordered: [SKIPPED_WAITING, WAIT_B] } },
      "POST /api/opd/queues/entries/qe-a/undo-skip": { status: 201, body: { entry: SKIPPED_WAITING } },
    }));
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);

    const row = await screen.findByTestId("queue-row-qe-a");
    expect(within(row).getByTestId("queue-skipped-qe-a")).toHaveTextContent("At the billing counter");
    expect(within(row).getByTestId("queue-skipnote-qe-a")).toHaveTextContent("counter 2");

    await user.click(within(row).getByTestId("queue-undoskip-qe-a"));
    await waitFor(() => { expect(callsTo("POST", "/api/opd/queues/entries/qe-a/undo-skip")).toHaveLength(1); });
  });

  /**
   * THE MEASURED CASE. Three skips and the token is `left` — and `left` was rendered by no screen in
   * this application, so the patient was gone from the building while her visit stayed open.
   */
  it("K4: a patient who fell out of the queue is named on the rail, with the button that brings her back", async () => {
    mockRoutes(routes({
      "GET /api/opd/queues": { status: 200, body: { ...QUEUE_VIEW, left: [LEFT_ROW], counts: { ...QUEUE_VIEW.counts, left: 1 } } },
      "POST /api/opd/queues/entries/qe-left/undo-skip": { status: 201, body: { entry: LEFT_ROW } },
    }));
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);

    expect(await screen.findByTestId("left-queue-title")).toHaveTextContent("Left the queue (1)");
    const row = within(screen.getByTestId("left-queue")).getByTestId("queue-row-qe-left");
    expect(within(row).getByText("Sonali Sri")).toBeInTheDocument();
    expect(within(row).getByTestId("queue-skipped-qe-left")).toHaveTextContent("Not at the door when called");

    await user.click(within(row).getByTestId("queue-undoskip-qe-left"));
    await waitFor(() => { expect(callsTo("POST", "/api/opd/queues/entries/qe-left/undo-skip")).toHaveLength(1); });
  });

  /**
   * THE RAW-KEY SCAN, and it is here because the BROWSER found it and jsdom did not: the dialog's
   * cancel button read `common.cancel` on screen — a key that does not exist in the bundle, in the
   * one namespace this screen does not own. A test that never asserts a label cannot see a missing
   * one, so this one reads the dialog's own text and refuses anything shaped like a key.
   */
  it("K6: every label in the skip dialog is translated — no raw i18n keys reach the screen", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");
    await user.click(screen.getByRole("button", { name: "Skip" }));

    const dialog = await screen.findByTestId("skip-dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    /*
      THE NAMESPACES, not "anything with a dot in it". The first draft of this line was
      `/\b[a-z][a-zA-Z]*\.[a-zA-Z]/`, which matched the dialog's own English: the rendered text
      concatenates across elements, so "…on the visit's record." + "Not at the door…" reads as
      `record.Not`. A raw key is always one of this app's namespaces followed by a key name, and
      that is a thing prose cannot accidentally be.
    */
    expect(dialog.textContent ?? "").not.toMatch(/\b(common|opdConsult|opd|vitalsBay)\.[a-zA-Z]/);
  });

  it("K5: a server refusal lands on the rail and the dialog closes rather than trapping the doctor", async () => {
    mockRoutes(routes({
      "POST /api/opd/queues/entries/qe-cur/skip": {
        status: 409,
        body: { statusCode: 409, message: "a skip needs a called entry", code: "queue_entry_state_conflict" },
      },
    }));
    const user = userEvent.setup();
    renderWithProviders(<OpdConsult />);
    await screen.findByTestId("queue-row-qe-cur");
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click((await screen.findByTestId("skip-dialog")).querySelector('[data-testid="skip-confirm"]')!);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => { expect(screen.queryByTestId("skip-dialog")).toBeNull(); });
  });
});

/**
 * ═══ THE CO-PILOT ON THE DESK (owner, 2026-09-14) ═══
 *
 * *"when doctor starts to write chief complaints, he don't need to type much, just tap and select
 * … automatically highlight dangers … if the patient is a child, pregnant or has an allergy."*
 */
describe("OpdConsult — the clinical co-pilot", () => {
  const HITS = {
    items: [
      { key: "SYN_URI_01", name: "Acute Upper Respiratory Infection (URI)", icd10: "J06.9", score: 4, matched: ["fever", "sore throat"] },
      { key: "SYN_BRONCH_04", name: "Acute Bronchitis", icd10: "J20.9", score: 1, matched: ["cough"] },
    ],
  };
  const line = (over: Record<string, unknown>) => ({
    band: "pediatric", seq: 1, drugLabel: "Paracetamol Oral Suspension 250mg/5ml", purpose: "Antipyresis",
    sig: "3.5 mL (for 14kg: 12.5 mg/kg) Every 6h SOS", duration: "3 Days",
    dose: { state: "computed", mg: 87.5, ml: 2, basis: "12.5 mg/kg per dose × 7 kg ÷ 50 mg/mL" },
    rx: { drug: "Paracetamol Oral Suspension 250mg/5ml", dose: "2 mL (87.5 mg)", route: "oral", frequency: "SOS", durationDays: 3, instructions: "3.5 mL example · Antipyresis", noSubstitution: false },
    ...over,
  });
  const REGIMEN = {
    regimen: {
      syndrome: { key: "SYN_URI_01", name: "Acute Upper Respiratory Infection (URI)", icd10: "J06.9" },
      band: "pediatric",
      lines: [
        line({}),
        line({
          seq: 2, drugLabel: "Azithromycin Oral Suspension 100mg/5ml", substitutedFor: "Amoxicillin and Clavulanate Syrup",
          dose: { state: "needs_review", basis: "substituted for Penicillin allergy", example: "7 mL Day 1" },
          rx: { drug: "Azithromycin Oral Suspension 100mg/5ml", dose: "— dose needs review", route: "oral", frequency: "OD", durationDays: 5, instructions: "substituted for Penicillin allergy", noSubstitution: false },
        }),
      ],
      appliedConditions: ["Penicillin"],
    },
    cards: [
      { kind: "allergy", severity: "red", title: "Allergy on file — 1 line(s) changed", detail: "Amoxicillin and Clavulanate Syrup → Azithromycin Oral Suspension 100mg/5ml", drugs: ["Amoxicillin and Clavulanate Syrup"], alternatives: [], ruleKeys: ["Penicillin"] },
      { kind: "pregnancy_unknown", severity: "info", title: "Is she pregnant?", detail: "This hospital records no pregnancy status.", drugs: [], alternatives: [], ruleKeys: ["NO_PREGNANCY_FIELD"] },
    ],
    facts: { weightKg: 7, ageYears: 1, allergies: ["Penicillin"], pregnant: null },
  };

  function cdsRoutes(over: Record<string, Handler> = {}): Record<string, Handler> {
    return {
      ...baseRoutes(),
      "GET /api/opd/cds/suggest": { status: 200, body: HITS },
      "GET /api/opd/cds/regimen": { status: 200, body: REGIMEN },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
      ...over,
    };
  }

  it("Y4: the co-pilot's danger cards are recomputed, never left naming a struck allergy", async () => {
    /*
      THE SEAM `addAllergy` ALREADY HAD. The cards are computed FROM the allergy list, so a strike
      that did not re-ask would leave a red card on screen naming an allergy the record no longer
      holds — and the doctor would read it as current.
    */
    mockRoutes({
      ...cdsRoutes(),
      "POST /api/patients/p-1/allergies/al-1/entered-in-error": { status: 201, body: { ok: true } },
    });
    const user = userEvent.setup();
    await openPanel(user);

    /* The syndrome read fires on COMMITTED tags, so the complaint has to be entered first. */
    await user.type(screen.getByLabelText("Chief complaint"), "fever and sore throat{Enter}");
    await user.click(await screen.findByTestId("cds-hit-SYN_URI_01"));
    await screen.findByTestId("cds-regimen");
    const before = callsTo("GET", "/api/opd/cds/regimen").length;

    await user.click(screen.getByTestId("allergy-strike-al-1"));
    await user.type(screen.getByLabelText("Reason"), "not penicillin, it was a rash from something else");
    await user.click(screen.getByTestId("allergy-strike-confirm"));

    await waitFor(() => {
      expect(callsTo("GET", "/api/opd/cds/regimen").length).toBeGreaterThan(before);
    });
  });

  it("P1: typing the complaint offers syndromes — and three characters is the floor, so it is not called per keystroke", async () => {
    mockRoutes(cdsRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    /* A DRAFT IS NOT A COMPLAINT. The syndrome read fires on the tags the doctor has COMMITTED —
       typing alone must not send anything, which is also what keeps it off the network per key. */
    await user.type(screen.getByLabelText("Chief complaint"), "fever and sore throat");
    await waitFor(() => { expect(callsTo("GET", "/api/opd/cds/suggest")).toHaveLength(0); });

    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("cds-hit-SYN_URI_01")).toHaveTextContent("Acute Upper Respiratory Infection");
    // the complaint travels; the patient does NOT — this read sees no PHI
    const url = callsTo("GET", "/api/opd/cds/suggest").at(-1)!.url;
    expect(url).toContain("complaint=");
    expect(url).not.toContain("enc-1");
  });

  it("P2: tapping a syndrome shows the dose computed for THIS child, with the weight it used on screen", async () => {
    mockRoutes(cdsRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    await user.type(screen.getByLabelText("Chief complaint"), "fever and sore throat{Enter}");
    await user.click(await screen.findByTestId("cds-hit-SYN_URI_01"));

    const card = await screen.findByTestId("cds-regimen");
    expect(within(card).getByTestId("cds-band")).toHaveTextContent("Child regimen");
    expect(within(card).getByTestId("cds-facts")).toHaveTextContent("7 kg");
    expect(within(card).getByTestId("cds-dose-1")).toHaveTextContent("2 mL (87.5 mg)");
    // the syndrome and the encounter travel; a WEIGHT never does
    const url = callsTo("GET", "/api/opd/cds/regimen").at(-1)!.url;
    expect(url).toContain("syndromeKey=SYN_URI_01");
    expect(url).toContain("encounterId=enc-1");
    expect(url).not.toMatch(/weight/i);
  });

  it("P3: the allergy danger is an ALERT and names the swap; the pregnancy question can be answered on the card", async () => {
    mockRoutes(cdsRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    await user.type(screen.getByLabelText("Chief complaint"), "fever and sore throat{Enter}");
    await user.click(await screen.findByTestId("cds-hit-SYN_URI_01"));

    const allergy = await screen.findByTestId("cds-card-allergy");
    expect(allergy).toHaveAttribute("role", "alert");
    expect(allergy).toHaveTextContent("→ Azithromycin");
    expect(screen.getByTestId("cds-swap-2")).toBeInTheDocument();

    await user.click(screen.getByTestId("cds-pregnant-yes"));
    await waitFor(() => {
      expect(callsTo("GET", "/api/opd/cds/regimen").at(-1)!.url).toContain("pregnant=true");
    });
  });

  it("P4: one tap fills the prescription form and moves to it — and issues nothing", async () => {
    mockRoutes(cdsRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    await user.type(screen.getByLabelText("Chief complaint"), "fever and sore throat{Enter}");
    await user.click(await screen.findByTestId("cds-hit-SYN_URI_01"));
    await user.click(await screen.findByTestId("cds-fill"));

    // the form is now the Rx tab, carrying both lines
    const drugs = await screen.findAllByLabelText("Drug");
    expect(drugs).toHaveLength(2);
    expect((drugs[0] as HTMLInputElement).value).toContain("Paracetamol");
    expect((drugs[1] as HTMLInputElement).value).toContain("Azithromycin");
    // NOTHING was prescribed by filling
    expect(callsTo("POST", "/api/opd/visits/enc-1/prescriptions")).toHaveLength(0);
  });

  /** The line the server refused to dose must arrive as the REASON, never as a number. */
  it("P5: a dose that needs review fills the reason into the form, not a millilitre", async () => {
    mockRoutes(cdsRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    await user.type(screen.getByLabelText("Chief complaint"), "fever and sore throat{Enter}");
    await user.click(await screen.findByTestId("cds-hit-SYN_URI_01"));
    expect(screen.getByTestId("cds-dose-2")).toHaveTextContent("— dose needs review");

    await user.click(screen.getByTestId("cds-fill"));
    const doses = await screen.findAllByLabelText("Dose");
    expect((doses[1] as HTMLInputElement).value).toBe("— dose needs review");
    expect((doses[1] as HTMLInputElement).value).not.toMatch(/\d\s*m[lg]/i);
  });
});

/**
 * ═══ THE FIELDS THE DOCTOR ALREADY HAS, SHARPENED (owner, 2026-09-14) ═══
 *
 * *"The doctor must have the fields that he already have now. Doctor must be able to add ALLERGIES
 * if there's no allergy already recorded … if doctor start writing 'fev' and auto suggestion will
 * appear as 'fever' … If doctor types 'fever' and presses enter, 'fever' will be added a tag
 * exactly as the doctor wrote. The doctor could simply click on 'x' cross to delete the tag."*
 */
describe("OpdConsult — the complaint tags and the allergy the doctor learns in the room", () => {
  function fieldRoutes(over: Record<string, Handler> = {}): Record<string, Handler> {
    return {
      ...baseRoutes(),
      "GET /api/opd/cds/complete/complaint": { status: 200, body: { items: [{ term: "fever", from: "syndrome" }, { term: "high grade fever", from: "symptom" }], ghost: "er" } },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
      "POST /api/patients/p-1/allergies": { status: 201, body: { allergyId: "al-9" } },
      ...over,
    };
  }

  it("F1: typing 'fev' offers 'fever' and ghosts the remainder — the input still holds only what was typed", async () => {
    mockRoutes(fieldRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    await user.type(screen.getByLabelText("Chief complaint"), "fev");

    expect(await screen.findByTestId("note-chief-ghost")).toHaveTextContent("er");
    expect(screen.getByTestId("note-chief-suggest-fever")).toBeInTheDocument();
    expect(screen.getByLabelText("Chief complaint")).toHaveValue("fev");
  });

  it("F2: → accepts the ghost into the input, and does NOT commit it — the doctor keeps typing", async () => {
    mockRoutes(fieldRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    const input = screen.getByLabelText("Chief complaint");

    await user.type(input, "fev");
    await screen.findByTestId("note-chief-ghost");
    await user.keyboard("{ArrowRight}");

    expect(input).toHaveValue("fever");
    expect(screen.queryByTestId("note-chief-tag-0")).toBeNull();
  });

  /** THE RULE: Enter commits the doctor's own words, whatever the suggestion list is showing. */
  it("F3: Enter commits EXACTLY what was typed, even when it is nothing the vocabulary knows", async () => {
    mockRoutes(fieldRoutes());
    const user = userEvent.setup();
    await openPanel(user);

    await user.type(screen.getByLabelText("Chief complaint"), "fever since 3 days, worse at night{Enter}");

    expect(screen.getByTestId("note-chief-tag-0")).toHaveTextContent("fever since 3 days, worse at night");
    expect(screen.getByLabelText("Chief complaint")).toHaveValue("");
  });

  it("F4: many tags, a tap adds the suggestion, × removes one, and the stored value is what the note PUTs", async () => {
    mockRoutes(fieldRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    const input = screen.getByLabelText("Chief complaint");

    await user.type(input, "fever{Enter}");
    await user.type(input, "dry cough{Enter}");
    await user.type(input, "fev");
    await user.click(await screen.findByTestId("note-chief-suggest-high grade fever"));
    expect(screen.getAllByTestId(/note-chief-tag-\d/)).toHaveLength(3);

    await user.click(screen.getByTestId("note-chief-remove-1"));
    expect(screen.getAllByTestId(/note-chief-tag-\d/)).toHaveLength(2);

    await user.click(screen.getByRole("heading", { name: "Consultation" }));
    await waitFor(() => {
      expect(bodiesOf("PUT", "/api/opd/visits/enc-1/consult/note").at(-1)?.chiefComplaint)
        .toBe("fever · high grade fever");
    });
  });

  /**
   * ═══ BACKSPACE EDITS WHAT IS BEING TYPED. IT NEVER TAKES BACK WHAT WAS COMMITTED ═══
   *
   * Owner, 2026-09-14: *"if the backspace is pressed for little longer the earlier chip also gets
   * removed. This is not good. Because of this doctor has to retype again and again."*
   *
   * This test asserted the OPPOSITE until then — "the standard chip gesture", as Gmail does it with
   * recipient chips. It is the wrong borrowing. A recipient chip is `bob@x.com` and costs three
   * seconds to retype; a chip here is *"fever since 3 days, worse at night"*, and on the diagnosis
   * field it carries an ICD-10 code that has to be found through the typeahead again.
   *
   * The mechanism is the part worth keeping in mind: there was no `e.repeat` guard, so ONE held key
   * deleted the draft character by character and then — with no pause and no boundary — kept firing
   * into the committed tags at the keyboard's repeat rate. Deleting text you are typing and
   * deleting data you committed are different acts, and auto-repeat walked from one to the other.
   *
   * The rule now has one meaning per gesture: **Enter commits, × removes.**
   */
  it("F5: backspace on an empty input leaves the committed tags alone", async () => {
    mockRoutes(fieldRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    const input = screen.getByLabelText("Chief complaint");

    await user.type(input, "fever{Enter}");
    await user.type(input, "cough{Enter}");
    await user.keyboard("{Backspace}");

    expect(screen.getAllByTestId(/note-chief-tag-\d/)).toHaveLength(2);
    expect(screen.getByTestId("note-chief-tag-1")).toHaveTextContent("cough");
  });

  it("F5b: a HELD backspace clears the draft and stops dead at the chips", async () => {
    mockRoutes(fieldRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    const input = screen.getByLabelText("Chief complaint");

    await user.type(input, "fever since 3 days{Enter}");
    await user.type(input, "worse at night{Enter}");
    /* A draft, then the key held down long past the end of it — the doctor's actual gesture. */
    await user.type(input, "coug");
    await user.keyboard("{Backspace>20/}");

    expect(input).toHaveValue("");
    expect(screen.getAllByTestId(/note-chief-tag-\d/)).toHaveLength(2);
    expect(screen.getByTestId("note-chief-tag-0")).toHaveTextContent("fever since 3 days");
    expect(screen.getByTestId("note-chief-tag-1")).toHaveTextContent("worse at night");
  });

  it("F5c: × still removes a tag, and it is reachable without the mouse", async () => {
    /* The one thing the new rule costs is a keyboard path to removal — and it does not, because the
       × is a real button sitting before the input in tab order. Shift+Tab reaches the last one. */
    mockRoutes(fieldRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    const input = screen.getByLabelText("Chief complaint");

    await user.type(input, "fever{Enter}");
    await user.type(input, "cough{Enter}");

    await user.tab({ shift: true });
    expect(screen.getByTestId("note-chief-remove-1")).toHaveFocus();
    /*
      SPACE, not Enter, and the reason is the test environment rather than the product: a real
      browser activates a focused button on either key, and jsdom implements only Space. Asserting
      Enter here would be asserting jsdom's gap rather than what the doctor's keyboard does.
    */
    await user.keyboard(" ");

    expect(screen.getAllByTestId(/note-chief-tag-\d/)).toHaveLength(1);
    expect(screen.getByTestId("note-chief-tag-0")).toHaveTextContent("fever");
  });

  /** The allergy panel could only ever SHOW. It is the one fact every guardrail on this screen reads. */
  it("F6: with nothing on file the doctor can record an allergy, and it posts as learnt AT THE CONSULT", async () => {
    let allergies: Record<string, unknown>[] = [];
    mockRoutes(fieldRoutes({
      "GET /api/patients/p-1/allergies": () => ({ status: 200, body: { items: allergies } }),
      "POST /api/patients/p-1/allergies": () => {
        allergies = [{ id: "al-9", substance: "Penicillin", severity: "severe", status: "active" }];
        return { status: 201, body: { allergyId: "al-9" } };
      },
    }));
    const user = userEvent.setup();
    await openPanel(user);

    expect(await screen.findByText("No allergy recorded")).toBeInTheDocument();
    await user.click(screen.getByTestId("allergy-add"));
    await user.type(screen.getByLabelText("Allergy — substance"), "Penicillin");
    await user.selectOptions(screen.getByLabelText("Severity"), "severe");
    await user.click(screen.getByTestId("allergy-save"));

    await waitFor(() => { expect(callsTo("POST", "/api/patients/p-1/allergies")).toHaveLength(1); });
    expect(bodiesOf("POST", "/api/patients/p-1/allergies")[0])
      .toEqual({ substance: "Penicillin", severity: "severe", source: "consult" });
    // and the chip the guardrails read is on screen without a reload
    expect(await screen.findByTestId("allergy-chip-al-9")).toHaveTextContent("Penicillin");
  });
});

/**
 * ═══ THE DRUG FIELD (owner, 2026-09-14) ═══
 *
 * *"even though the doctor doesn't enable AI suggestion in the prescription tab, auto complete will
 * work if doctor starts to type drug name … 'par' → Paracetamol …"*
 */
describe("OpdConsult — the drug typeahead", () => {
  const PAR = {
    items: [
      { id: "m-pcm500", name: "Paracetamol 500 mg oral capsule", form: "Oral capsule", strength: "500 mg", code: "D7611", routeClass: "systemic", salts: ["Paracetamol"], prefix: true },
      { id: "m-pcm1g", name: "Paracetamol 1 g oral tablet", form: "Oral tablet", strength: "1 g", code: "D10146", routeClass: "systemic", salts: ["Paracetamol"], prefix: true },
    ],
  };
  function drugRoutes(over: Record<string, Handler> = {}): Record<string, Handler> {
    return {
      ...baseRoutes(),
      "GET /api/formulary/medicines/search": { status: 200, body: PAR },
      "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
      ...over,
    };
  }

  it("D1: three letters fetch the catalogue — two do not, so it is not called per keystroke", async () => {
    mockRoutes(drugRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(screen.getByRole("tab", { name: "Prescription" }));

    await user.type(screen.getByLabelText("Drug"), "pa");
    await waitFor(() => { expect(callsTo("GET", "/api/formulary/medicines/search")).toHaveLength(0); });

    await user.type(screen.getByLabelText("Drug"), "r");
    expect(await screen.findByTestId("rx-drug-0-hits")).toBeInTheDocument();
    expect(callsTo("GET", "/api/formulary/medicines/search").at(-1)!.url).toContain("q=par");
  });

  it("D2: the row shows the moiety, strength and the hospital's own code — not just a name", async () => {
    mockRoutes(drugRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(screen.getByLabelText("Drug"), "par");

    const row = await screen.findByTestId("rx-drug-0-hit-m-pcm500");
    expect(row).toHaveTextContent("Paracetamol 500 mg oral capsule");
    expect(row).toHaveTextContent("Paracetamol · 500 mg · D7611");
    expect(row).toHaveTextContent("Oral capsule");
  });

  it("D3: tapping a row fills the name AND the id — which is what makes the line checkable", async () => {
    mockRoutes(drugRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(screen.getByLabelText("Drug"), "par");
    await user.click(await screen.findByTestId("rx-drug-0-hit-m-pcm1g"));

    expect(screen.getByLabelText("Drug")).toHaveValue("Paracetamol 1 g oral tablet");
    // the list closes, and the id rides the line into the prescription POST
    expect(screen.queryByTestId("rx-drug-0-hits")).toBeNull();
    await user.type(screen.getByLabelText("Dose"), "1 tab");
    await user.click(screen.getByRole("button", { name: "Issue & print" }));
    await waitFor(() => { expect(callsTo("POST", "/api/opd/visits/enc-1/prescriptions").length).toBeGreaterThan(0); });
    const body = bodiesOf("POST", "/api/opd/visits/enc-1/prescriptions")[0] as { lines: { medicineId: string | null }[] };
    expect(body.lines[0]!.medicineId).toBe("m-pcm1g");
  });

  /** 16a design law 1: free typing is always legal, and typing over a pick un-links it. */
  it("D4: typing over a chosen drug clears its id — the line stops claiming to be that medicine", async () => {
    mockRoutes(drugRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(screen.getByLabelText("Drug"), "par");
    await user.click(await screen.findByTestId("rx-drug-0-hit-m-pcm500"));
    await user.clear(screen.getByLabelText("Drug"));
    await user.type(screen.getByLabelText("Drug"), "Tab Crocin 650 (hand written)");

    await user.type(screen.getByLabelText("Dose"), "1 tab");
    await user.click(screen.getByRole("button", { name: "Issue & print" }));
    await waitFor(() => { expect(callsTo("POST", "/api/opd/visits/enc-1/prescriptions").length).toBeGreaterThan(0); });
    const body = bodiesOf("POST", "/api/opd/visits/enc-1/prescriptions")[0] as { lines: { drug: string; medicineId: string | null }[] };
    expect(body.lines[0]!.drug).toBe("Tab Crocin 650 (hand written)");
    expect(body.lines[0]!.medicineId).toBeNull();
  });

  it("D5: the screen no longer fetches the whole catalogue — 103,383 rows is not a dropdown", async () => {
    mockRoutes(drugRoutes());
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(screen.getByLabelText("Drug"), "par");
    await screen.findByTestId("rx-drug-0-hits");

    expect(callsTo("GET", "/api/formulary/medicines")).toHaveLength(0);
  });
});
