import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider } from "./auth";
import { PatientInHandProvider, usePatientInHand } from "./patient-in-hand";
import { PatientStrip } from "../components/patient-strip";
import { setToken } from "./api";
import { stubFetch } from "../test-utils";
import "./i18n";

/**
 * PLAN 07b T1 — THE PATIENT IN HAND.
 *
 * Four screens each held their own picked patient in their own `useState`, so the simplest walk-in
 * cost three searches for the same person. These assertions defend the two properties that make a
 * shared context safe rather than merely convenient: it stores IDS ONLY (a cached name outlives a
 * merge and becomes a wrong-patient risk), and it is TAB-SCOPED (a shared counter machine must not
 * hand the next shift the last shift's patient).
 */
const KEY = "hmis.inHand";

function Harness({ children }: { children?: React.ReactNode }): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <PatientInHandProvider>{children}</PatientInHandProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

/** A screen that takes a patient, and a second one that only reads — the cross-screen assertion. */
function Taker(): React.ReactElement {
  const { takePatient, takeEncounter, release } = usePatientInHand();
  return (
    <div>
      <button type="button" onClick={() => takePatient("p-1")}>take</button>
      <button type="button" onClick={() => takeEncounter("enc-1")}>open-visit</button>
      <button type="button" onClick={() => takePatient("p-2")}>take-other</button>
      <button type="button" onClick={release}>put-down</button>
    </div>
  );
}

function Reader(): React.ReactElement {
  const { inHand } = usePatientInHand();
  return <span data-testid="reader">{inHand === null ? "none" : `${inHand.patientId}/${inHand.encounterId ?? "-"}`}</span>;
}

describe("patient in hand (07b T1)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    // The provider only calls `/auth/me` when a token exists, and `api.ts` captures it at module
    // load — so a signed-in session has to be established through `setToken`, not by writing the
    // storage key. Without it `ready` resolves with a null actor, which IS a sign-out, and the
    // sign-out effect correctly clears the patient.
    setToken("test-token");
    stubFetch({ "GET /api/auth/me": { actor: { type: "user", id: "u-1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } } });
  });

  /** A1 — one screen takes the patient, another screen already has them. */
  it("A1: a patient taken in one place is in hand everywhere", async () => {
    render(<Harness><Taker /><Reader /></Harness>);
    const user = userEvent.setup();
    expect(screen.getByTestId("reader")).toHaveTextContent("none");
    await user.click(screen.getByText("take"));
    expect(screen.getByTestId("reader")).toHaveTextContent("p-1/-");
    await user.click(screen.getByText("open-visit"));
    expect(screen.getByTestId("reader")).toHaveTextContent("p-1/enc-1");
  });

  /** A2 — a counter machine loses a tab to an accidental refresh several times a shift. */
  it("A2: it survives a reload in the same tab", async () => {
    const first = render(<Harness><Taker /><Reader /></Harness>);
    const user = userEvent.setup();
    await user.click(screen.getByText("take"));
    await user.click(screen.getByText("open-visit"));
    first.unmount(); // the reload

    render(<Harness><Reader /></Harness>);
    expect(screen.getByTestId("reader")).toHaveTextContent("p-1/enc-1");
  });

  /**
   * A3 — THE SHIFT-CHANGE LEAK, from both directions. `localStorage` would survive the tab and hand
   * the next clerk the last clerk's patient; so would a context that ignored sign-out.
   */
  it("A3: nothing is written to localStorage — only sessionStorage", async () => {
    render(<Harness><Taker /></Harness>);
    await userEvent.setup().click(screen.getByText("take"));
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(Object.keys(localStorage).filter((k) => k.includes("inHand"))).toHaveLength(0);
  });

  /** A5 — IDS ONLY. A cached name outlives a merge; the strip must resolve everything live. */
  it("A5: only ids are persisted — no name, no uhid, nothing that can go stale", async () => {
    render(<Harness><Taker /></Harness>);
    await userEvent.setup().click(screen.getByText("take"));
    const stored: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
    expect(Object.keys(stored as object).sort()).toEqual(["encounterId", "patientId"]);
  });

  it("taking a different patient does not inherit the previous one's visit", async () => {
    render(<Harness><Taker /><Reader /></Harness>);
    const user = userEvent.setup();
    await user.click(screen.getByText("take"));
    await user.click(screen.getByText("open-visit"));
    await user.click(screen.getByText("take-other"));
    expect(screen.getByTestId("reader")).toHaveTextContent("p-2/-");
  });

  it("releasing clears the store as well as the state", async () => {
    render(<Harness><Taker /><Reader /></Harness>);
    const user = userEvent.setup();
    await user.click(screen.getByText("take"));
    await user.click(screen.getByText("put-down"));
    expect(screen.getByTestId("reader")).toHaveTextContent("none");
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  /** A4 — the strip is pinned to every screen, so a VIP's name does not belong on it. */
  describe("the strip", () => {
    const withPatient = (patient: unknown): void => {
      sessionStorage.setItem(KEY, JSON.stringify({ patientId: "p-1", encounterId: null }));
      stubFetch({
        "GET /api/auth/me": { actor: { type: "user", id: "u-1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } },
        "GET /api/patients/p-1": { patient },
      });
    };

    it("A4: a confidential patient shows the ALIAS even though the reader was served the name", async () => {
      withPatient({ id: "p-1", uhid: "UH-1", name: "Asha Devi", sex: "female", isConfidential: true, alias: "Guest One" });
      render(<Harness><PatientStrip /></Harness>);
      expect(await screen.findByText("Guest One")).toBeInTheDocument();
      expect(screen.queryByText("Asha Devi")).toBeNull();
    });

    it("an ordinary patient shows their name and UHID", async () => {
      withPatient({ id: "p-1", uhid: "UH-1", name: "Ramesh Kale", sex: "male", isConfidential: false, alias: null });
      render(<Harness><PatientStrip /></Harness>);
      expect(await screen.findByText("Ramesh Kale")).toBeInTheDocument();
      expect(screen.getByTestId("strip-uhid")).toHaveTextContent("UH-1");
    });

    it("renders nothing at all when nobody is in hand", () => {
      sessionStorage.clear();
      render(<Harness><PatientStrip /></Harness>);
      expect(screen.queryByTestId("patient-strip")).toBeNull();
    });

    it("a sealed record the reader may not open says so rather than showing an endless spinner", async () => {
      sessionStorage.setItem(KEY, JSON.stringify({ patientId: "p-9", encounterId: null }));
      setToken("test-token");
      stubFetch({ "GET /api/auth/me": { actor: { type: "user", id: "u-1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } } });
      render(<Harness><PatientStrip /></Harness>);
      expect(await screen.findByText("Restricted record")).toBeInTheDocument();
    });
  });
});

