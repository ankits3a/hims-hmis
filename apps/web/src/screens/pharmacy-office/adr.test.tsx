import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { AdrRegisterView } from "./adr";
import type { WireAdrDetail, WireAdrRow } from "../../lib/adr-api";

/**
 * PHARMACY STAGE D1 — the ADR register as an office page: the list with each report's PvPI state, the
 * record sheet that picks the moiety from the formulary (so the allergy it writes is coded), and the
 * manager's acts. A person without `pharmacy.adr.manage` sees no acts.
 */
type Call = { method: string; path: string; body: unknown; query: string };
function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>, perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const [pathPart, query = ""] = raw.split("?");
    const path = pathPart!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, body, query });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const v = routes[`${method} ${path}`];
    if (v === undefined) return new Response("{}", { status: 404 });
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const ROW: WireAdrRow = {
  id: "r1", no: "ADR-000001", patient: { id: "p1", uhid: "UH-0001", name: "Asha Devi", alias: null, restricted: false, gender: "female", dob: "1996-01-15" },
  onsetDate: "2026-09-01", seriousness: "hospitalisation", outcome: "recovered", suspects: ["Augmentin 625"], reportedByCode: "EMP-0012",
  createdAt: "2026-09-02T05:00:00.000Z", state: { causality: null, sentOn: null, channel: null, pvpiRef: null, closed: false },
};
const DETAIL: WireAdrDetail = {
  ...ROW, reaction: "Generalised urticaria", recoveryDate: null, dechallenge: "yes", rechallenge: "na", weightKg: null, concomitants: [],
  relevantTests: null, relevantHistory: null,
  suspectLines: [{ position: 1, saltId: "s-amox", name: "Augmentin 625", itemId: null, batchNo: "AG11", manufacturer: null, dose: "625 mg", route: "oral", frequency: "BD", indication: null, startDate: "2026-08-30", stopDate: "2026-09-01", dispenseId: null, allergyId: "a1" }],
  events: [],
};

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the ADR register (pharmacy stage D1)", () => {
  it("lists reports with their PvPI state — a serious one past 15 days is red — and the manager records the send", async () => {
    const calls = mock({
      "GET /pharmacy/adr": { items: [ROW] },
      "GET /pharmacy/adr/r1": DETAIL,
      "POST /pharmacy/adr/r1/events": { eventId: "e1" },
    }, ["pharmacy.adr.manage"]);
    renderWithRouter(<AdrRegisterView />);
    const state = await screen.findByTestId("adr-state-ADR-000001");
    expect(state.className).toContain("rd");
    expect(await screen.findByTestId("adr-reaction")).toHaveTextContent("Generalised urticaria");
    // A manager records no reaction of their own here — the record button is the record grant's.
    expect(screen.queryByTestId("adr-record-open")).toBeNull();
    await userEvent.type(screen.getByTestId("adr-ref"), "IN-IPC-3001");
    await userEvent.click(screen.getByTestId("adr-sent-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/pharmacy/adr/r1/events");
    expect(post.body).toMatchObject({ kind: "sent_to_pvpi", channel: "amc", pvpiRef: "IN-IPC-3001" });
  });

  it("a recorder records a reaction: the patient found, the moiety picked from the formulary, the form posted once", async () => {
    let recorded = false;
    const calls = mock({
      "GET /pharmacy/adr": () => ({ items: recorded ? [{ ...ROW, id: "r9", no: "ADR-000009" }] : [] }),
      "GET /patients/search": { items: [{ id: "p1", uhid: "UH-0001", name: "Asha Devi", phone: null, administrativeGender: "female", dob: null, isConfidential: false, hasPhoto: false }] },
      "GET /pharmacy/adr/salts": { items: [{ id: "s-para", name: "Paracetamol" }] },
      "POST /pharmacy/adr": () => { recorded = true; return { reportId: "r9", no: "ADR-000009", allergyIds: ["a9"] }; },
      "GET /pharmacy/adr/r9": { ...DETAIL, id: "r9", no: "ADR-000009" },
    }, ["pharmacy.adr.record", "patients.read"]);
    renderWithRouter(<AdrRegisterView />);
    expect(await screen.findByTestId("adr-empty")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("adr-record-open"));
    expect(screen.getByTestId("adr-record-save")).toBeDisabled();
    await userEvent.type(screen.getByTestId("adr-patient-q"), "Asha");
    await userEvent.click(screen.getByTestId("adr-patient-find"));
    await userEvent.click(await screen.findByTestId("adr-patient-UH-0001"));
    await userEvent.type(screen.getByTestId("adr-salt-q-0"), "para");
    await userEvent.click(await screen.findByTestId("adr-salt-0-Paracetamol"));
    expect(screen.getByTestId("adr-salt-picked-0")).toHaveTextContent("Paracetamol");
    await userEvent.type(screen.getByTestId("adr-brand-0"), "Crocin 500");
    await userEvent.type(screen.getByTestId("adr-reaction-text"), "Rash over the trunk");
    await userEvent.selectOptions(screen.getByTestId("adr-seriousness"), "hospitalisation");
    await userEvent.click(screen.getByTestId("adr-record-save"));
    expect(await screen.findByTestId("adr-notice")).toHaveTextContent("ADR-000009");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      patientId: "p1", reaction: "Rash over the trunk", seriousness: "hospitalisation",
      suspects: [{ saltId: "s-para", name: "Crocin 500" }],
    });
    // A recorder without the manage grant sees no acts on the report.
    expect(await screen.findByTestId("adr-detail")).toBeInTheDocument();
    expect(screen.queryByTestId("adr-actions")).toBeNull();
  });
});
