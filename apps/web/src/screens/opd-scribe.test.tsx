import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpdScribe } from "./opd-scribe";
import { renderWithProviders, stubFetch } from "../test-utils";
import { setToken } from "../lib/api";

/**
 * ═══ FD-30 — THE OPD DOOR (OWNER RULING 2026-09-12: DRAFT THEN CONFIRM) ═══
 *
 * The seat that types what the doctor wrote in pen. Two claims carry the whole screen and both are
 * executed here rather than argued in a comment:
 *
 *   1. NOTHING IS TYPED AGAINST A VISIT THE SERVER HAS NOT NAMED. The owner asked for the read-back
 *      by name — *"we should have read-back of who and which visit it matched before it files"* —
 *      because a slip filed against the wrong visit is a clinical-record error that is silent
 *      afterwards.
 *   2. WHAT IT SENDS IS A DRAFT. The screen posts to `prescription-draft` and never to
 *      `prescriptions`; the last row asserts that second URL is never called, which is the one
 *      mistake a future edit could make that no type would catch.
 */
const VISIT = {
  encounter: { id: "E-1", visitNo: "V2609120004", serviceDate: "2026-09-12", status: "in_consultation", visitType: "new", doctorId: "D-1" },
  patient: { id: "P-1", uhid: "U00110049", name: "Ankit Kumar", alias: null, restricted: false, administrativeGender: "male", dob: "1991-02-03" },
};

function stub(over: Record<string, unknown> = {}, drop: string[] = []): void {
  const routes: Record<string, unknown> = {
    "GET /api/auth/me": { actor: { type: "user", id: "u-s" }, permissions: { hospital: ["opd.prescription.draft", "opd.visits.read", "patients.read"], scoped: { department: {}, floor: {} } } },
    "GET /api/opd/visits/V2609120004": VISIT,
    "GET /api/opd/visits/E-1/prescription-draft": { draft: null },
    "POST /api/opd/visits/E-1/prescription-draft": (init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as { lines: unknown[] };
      return { id: "DR-1", encounterId: "E-1", patientId: "P-1", lines: b.lines, note: null, status: "pending", draftedBy: "u-s", draftedAt: "2026-09-12T10:00:00.000Z", resolvedBy: null, resolvedAt: null, issuedPrescriptionId: null };
    },
    ...over,
  };
  /* DELETED, not set to undefined: `stubFetch` answers 404 only for a key that is ABSENT, and a key
     present with an undefined value returns 200 with an empty body — which is a resolved visit
     carrying no patient, not the missing one this test means. */
  for (const key of drop) delete routes[key];
  stubFetch(routes);
}
function posted(path: string): Record<string, unknown>[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "POST" && String(input) === path)
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
}

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("FD-30 — the OPD-door scribe", () => {
  it("one box takes the scanned QR or the typed number, the SERVER names the patient, and the slip files as a DRAFT", async () => {
    stub();
    const user = userEvent.setup();
    renderWithProviders(<OpdScribe />);

    /* The QR on the prescription footer encodes exactly the visit number, so a wedge scanner types
       this same string into this same box. One road, not two. */
    await user.type(screen.getByTestId("scribe-visit"), "V2609120004{Enter}");

    await waitFor(() => { expect(screen.getByTestId("scribe-readback")).toBeInTheDocument(); });
    expect(screen.getByTestId("scribe-name")).toHaveTextContent("Ankit Kumar");
    expect(screen.getByTestId("scribe-readback")).toHaveTextContent("U00110049");
    expect(screen.getByTestId("scribe-readback")).toHaveTextContent("V2609120004");

    await user.type(screen.getByTestId("scribe-drug-0"), "Tab Amoxicillin 500 mg");
    await user.type(screen.getByTestId("scribe-dose-0"), "1 tab");
    await user.clear(screen.getByTestId("scribe-freq-0"));
    await user.type(screen.getByTestId("scribe-freq-0"), "TDS");
    await user.type(screen.getByTestId("scribe-days-0"), "5");
    await user.type(screen.getByTestId("scribe-note"), "second line unreadable");
    await user.click(screen.getByTestId("scribe-save"));

    await waitFor(() => { expect(posted("/api/opd/visits/E-1/prescription-draft")).toHaveLength(1); });
    expect(posted("/api/opd/visits/E-1/prescription-draft")[0]).toEqual({
      lines: [{ drug: "Tab Amoxicillin 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false }],
      note: "second line unreadable",
    });

    /* The confirmation the owner asked for, and it says what is and is not true of the slip. */
    expect(await screen.findByTestId("scribe-saved")).toHaveTextContent("waiting for the doctor");

    /*
      AND NEVER THE PRESCRIPTION ROUTE. This seat cannot prescribe; the server refuses it too
      (`requireTreatingDoctor`), but a screen that tried would be a defect no type catches.
    */
    expect(posted("/api/opd/visits/E-1/prescriptions")).toHaveLength(0);
  });

  it("a visit number that resolves to nothing files NOTHING and says so", async () => {
    stub({}, ["GET /api/opd/visits/V2609120004"]);
    const user = userEvent.setup();
    renderWithProviders(<OpdScribe />);

    await user.type(screen.getByTestId("scribe-visit"), "V2609120004{Enter}");
    expect(await screen.findByTestId("scribe-not-found")).toHaveTextContent("V2609120004");
    /* No editor at all — there is nobody to transcribe against, so there is nothing to type into. */
    expect(screen.queryByTestId("scribe-lines")).not.toBeInTheDocument();
    expect(posted("/api/opd/visits/E-1/prescription-draft")).toHaveLength(0);
  });

  it("a line with no medicine on it is not sent, and an empty slip cannot be sent at all", async () => {
    stub();
    const user = userEvent.setup();
    renderWithProviders(<OpdScribe />);
    await user.type(screen.getByTestId("scribe-visit"), "V2609120004{Enter}");
    await waitFor(() => { expect(screen.getByTestId("scribe-readback")).toBeInTheDocument(); });

    /* Nothing typed yet: the button is dark, so an empty slip cannot reach the server to be refused. */
    expect(screen.getByTestId("scribe-save")).toBeDisabled();

    await user.click(screen.getByTestId("scribe-add"));
    await user.type(screen.getByTestId("scribe-drug-0"), "Tab Paracetamol 500 mg");
    /* Row 1 is left blank — a clerk who added a row and did not fill it has added nothing. */
    await user.click(screen.getByTestId("scribe-save"));

    await waitFor(() => { expect(posted("/api/opd/visits/E-1/prescription-draft")).toHaveLength(1); });
    const body = posted("/api/opd/visits/E-1/prescription-draft")[0] as { lines: unknown[] };
    expect(body.lines).toHaveLength(1);
  });

  it("a slip already waiting on this visit is STATED before the clerk types over it", async () => {
    stub({
      "GET /api/opd/visits/E-1/prescription-draft": {
        draft: { id: "DR-0", encounterId: "E-1", patientId: "P-1", lines: [{ drug: "Tab X", dose: "1", route: "oral", frequency: "OD", durationDays: null, instructions: null, noSubstitution: false }], note: null, status: "pending", draftedBy: "u-other", draftedAt: "x", resolvedBy: null, resolvedAt: null, issuedPrescriptionId: null },
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<OpdScribe />);
    await user.type(screen.getByTestId("scribe-visit"), "V2609120004{Enter}");

    expect(await screen.findByTestId("scribe-already-pending")).toHaveTextContent("already waiting");
  });
});
