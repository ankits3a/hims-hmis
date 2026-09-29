import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import { renderWithProviders } from "../test-utils";
import { OpdConsult } from "./opd-consult";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ═══ THE CONSULT WALK OF 2026-09-28 — WHAT A REAL CHROMIUM SESSION FOUND THAT THE SUITE DID NOT ═══
 *
 * Evidence: /opt/hmis-context/reference/2026-09-28-consult-walk/ (screens numbered NN-*). One test
 * per defect, each written to fail against the screen as the walk found it. Self-contained on
 * purpose: a test file never imports another *.test.tsx (the opd-consult.test.tsx convention), and
 * that file already carries a 15 s per-test budget this one shares.
 */
vi.setConfig({ testTimeout: 15_000 });

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

const NOW_ISO = "2026-08-18T04:00:00.000Z";
const TODAY = "2026-08-18";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(): void { /* nothing listens */ }
  close(): void { this.readyState = 3; this.onclose?.(); }
}

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
const PATIENT = { requestedId: "p-1", id: "p-1", uhid: "HMS0000000020", name: "Asha Devi", alias: null, restricted: false, administrativeGender: "female", dob: "1992-03-04" };
const CURRENT = {
  id: "qe-cur", seq: 1, sessionId: "sess-1", encounterId: "enc-1", tokenNo: 5, kind: "walk_in",
  appointmentAt: null, status: "called", danger: false, reEntry: false, perk: false,
  eligibleAt: null, calledAt: NOW_ISO, callCount: 1, skips: 0, doneAt: null, createdAt: NOW_ISO,
  parkedAt: null, parkedBy: null, skipReason: null, skipNote: null, skippedAt: null,
  position: null, queueClass: null,
  encounter: { id: "enc-1", patientId: "p-1", visitType: "new", dangerFlagged: false, status: "waiting" },
  patient: PATIENT,
};
const QUEUE_VIEW = {
  session: SESSION, doctor: DOCTOR, ordered: [], current: CURRENT, inConsult: [], left: [],
  waitingVitals: 0, counts: { waiting: 0, called: 1, inConsult: 0, done: 0, left: 0 },
};
const ENCOUNTER = {
  id: "enc-1", patientId: "p-1", type: "opd_visit", status: "in_consultation", workflowInstanceId: "wf-1",
  departmentId: "dep-1", doctorId: "doc-1", appointmentId: null, serviceDate: TODAY, visitType: "new",
  intendedPayer: "self", referralSource: null, referrerName: null,
  chiefComplaint: null, diagnosis: null, icd10Code: null, advice: null,
  admissionAdvised: false, referralTo: null, referralNote: null,
  followUpDays: null, followUpExtended: false, dangerFlagged: false,
  consultStartedAt: NOW_ISO, consultCompletedAt: null, abandonedAt: null, abandonReason: null,
  openedBy: "u-1", openedAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
};
const VISIT = {
  encounter: ENCOUNTER, queueEntries: [CURRENT], vitals: [], prescriptions: [] as unknown[],
  diagnoses: [] as unknown[], patient: PATIENT,
};
const ALLERGIES = [{
  id: "al-1", substance: "Penicillin", severity: "severe", status: "active",
  source: "consult", recordedAt: "2026-08-17T04:05:00.000Z", correctionReason: null,
}];
const PRINT_DATA = {
  letterhead: CONFIG.letterhead,
  patient: { uhid: "HMS0000000020", name: "Asha Devi", alias: null, restricted: false, ageYears: 34, administrativeGender: "female" },
  doctor: { displayName: "Dr Meera Rao", registrationNo: "BMC/12345", departmentName: "General medicine" },
  encounter: { id: "enc-1", visitNo: "V1", serviceDate: TODAY, diagnosis: null, icd10Code: null, advice: null, followUpDays: null, chiefComplaint: null, advisedTests: [] },
  vitals: null,
  lines: [{ drug: "Crocin 500", dose: "500 mg", route: "oral", frequency: "TDS", durationDays: 3, instructions: null, noSubstitution: false }],
  qrPayload: "rx1.X.Y.1.c2ln", version: 1, issuedAt: "2026-08-18T05:12:00.000Z",
};
/** A row as the editor saves it: the days are the box's TEXT, blanks are blanks. */
const DRAFT_ROW = {
  drug: "Crocin 500", dose: "500 mg", route: "oral", frequency: "TDS", durationDays: "3",
  instructions: "After food", noSubstitution: false, medicineId: null,
};

type Handler = { status: number; body: unknown } | (() => { status: number; body: unknown });

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const h = handlers[key];
    if (h === undefined) return new Response("{}", { status: 404 });
    const { status, body } = typeof h === "function" ? h() : h;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }));
}
function fetchCalls(): { path: string; method: string; body: string }[] {
  const f = fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  return f.mock.calls.map(([input, init]) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    return { path: raw.split("?")[0]!, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" };
  });
}
const callsTo = (method: string, path: string): ReturnType<typeof fetchCalls> => fetchCalls().filter((c) => c.method === method && c.path === path);
const bodiesOf = (method: string, path: string): Record<string, unknown>[] =>
  callsTo(method, path).map((c) => (c.body === "" ? {} : JSON.parse(c.body) as Record<string, unknown>));
const NOTE = "/api/opd/visits/enc-1/consult/note";

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" } } },
    "GET /api/opd/me/doctor": { status: 200, body: DOCTOR },
    "GET /api/opd/config": { status: 200, body: CONFIG },
    "GET /api/opd/queues": { status: 200, body: QUEUE_VIEW },
    "GET /api/opd/visits/enc-1": { status: 200, body: VISIT },
    "GET /api/patients/p-1": { status: 200, body: { patient: PATIENT, resolvedFrom: null } },
    "GET /api/patients/p-1/allergies": { status: 200, body: { items: ALLERGIES } },
    "GET /api/opd/patients/p-1/timeline": { status: 200, body: { items: [] } },
    "POST /api/opd/visits/enc-1/consult/start": { status: 201, body: { encounter: ENCOUNTER, queueEntry: CURRENT } },
    "PUT /api/opd/visits/enc-1/consult/note": { status: 200, body: { encounter: ENCOUNTER } },
    ...over,
  };
}

async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  renderWithProviders(<OpdConsult />);
  await screen.findByTestId("queue-row-qe-cur");
  await user.click(screen.getByRole("button", { name: "Start consultation" }));
  await screen.findByTestId("patient-panel");
}

async function writeLine(user: ReturnType<typeof userEvent.setup>, drug: string): Promise<void> {
  await user.click(screen.getByRole("tab", { name: "Prescription" }));
  await user.type(await screen.findByLabelText("Drug"), drug);
  await user.type(screen.getByLabelText("Dose"), "500 mg");
  await user.click(screen.getByTestId("sig-0-freq-TDS"));
  await user.click(screen.getByTestId("sig-0-days-3"));
}

beforeEach(() => {
  setToken("tok-1");
  localStorage.clear();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  resetRealtimeClientForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
  localStorage.clear();
});

describe("A — the unissued prescription lines survive a reload, a second tab and a lease takeover", () => {
  it("A1: lines written and not issued are saved with the visit — on their own, and by Save draft — carrying the lease", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    await openPanel(user);
    await writeLine(user, "Crocin 500");
    // on their own, a moment after the doctor stops writing — no blur, no button
    await waitFor(() => {
      expect(bodiesOf("PUT", NOTE).some((b) => Array.isArray(b.rxDraft) && (b.rxDraft as { drug: string }[])[0]?.drug === "Crocin 500")).toBe(true);
    }, { timeout: 4000 });
    const auto = bodiesOf("PUT", NOTE).filter((b) => Array.isArray(b.rxDraft)).at(-1)!;
    expect(auto.rxDraft).toEqual([{ drug: "Crocin 500", dose: "500 mg", route: "oral", frequency: "TDS", durationDays: "3", instructions: "", noSubstitution: false, medicineId: null }]);
    // and Save draft saves the lines too, not only the note (walk 35)
    const before = callsTo("PUT", NOTE).length;
    await user.click(screen.getByTestId("save-draft"));
    await waitFor(() => { expect(callsTo("PUT", NOTE).length).toBe(before + 1); });
    expect(bodiesOf("PUT", NOTE).at(-1)!.rxDraft).toEqual(auto.rxDraft);
  });

  it("A2: reopening the visit (a reload, a new tab) puts the saved lines back in the editor, un-issued", async () => {
    mockRoutes(routes({ "GET /api/opd/visits/enc-1": { status: 200, body: { ...VISIT, encounter: { ...ENCOUNTER, rxDraft: [DRAFT_ROW] } } } }));
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    expect(await screen.findByTestId("rx-card-head-0")).toHaveTextContent("Crocin 500");
    expect(screen.getByTestId("rx-card-head-0")).toHaveTextContent("TDS");
    // un-issued, so Complete will issue it rather than drop it
    expect(screen.getByTestId("complete-consult")).toHaveTextContent("Issue & complete");
  });

  it("A3: a lease takeover picks up the lines the other tab saved", async () => {
    let takeover = false;
    let serverDraft: unknown = null;
    mockRoutes(routes({
      "GET /api/opd/visits/enc-1": () => ({ status: 200, body: { ...VISIT, encounter: { ...ENCOUNTER, rxDraft: serverDraft } } }),
      "POST /api/opd/visits/enc-1/consult/lease": () => ({ status: 201, body: takeover
        ? { held: true, until: NOW_ISO, holderIsMe: true, tookOver: true }
        : { held: false, until: NOW_ISO, holderIsMe: false, tookOver: false } }),
      "POST /api/opd/visits/enc-1/consult/lease/release": { status: 201, body: { released: false } },
    }));
    const user = userEvent.setup();
    await openPanel(user);
    expect(await screen.findByTestId("lease-readonly")).toBeInTheDocument();
    // the other tab writes a line while this one reads
    serverDraft = [DRAFT_ROW];
    takeover = true;
    await user.click(screen.getByTestId("lease-takeover"));
    await waitFor(() => { expect(screen.queryByTestId("lease-readonly")).toBeNull(); });
    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    expect(await screen.findByTestId("rx-card-head-0")).toHaveTextContent("Crocin 500");
  });

  it("A4: leaving the page with lines not yet saved asks first; once saved it does not", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    await openPanel(user);
    await writeLine(user, "Crocin 500");
    const leave = (): boolean => {
      const ev = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(leave()).toBe(true);
    await waitFor(() => { expect(bodiesOf("PUT", NOTE).some((b) => Array.isArray(b.rxDraft))).toBe(true); }, { timeout: 4000 });
    await act(async () => { await Promise.resolve(); });
    expect(leave()).toBe(false);
  });

  it("A5: issuing clears the saved draft — the lines are a prescription now, not a draft", async () => {
    mockRoutes(routes({
      "POST /api/opd/visits/enc-1/prescriptions": { status: 201, body: { prescriptionId: "rx-1", version: 1, qrPayload: "q", allergyOverrideCount: 0 } },
      "GET /api/opd/prescriptions/rx-1/print": { status: 200, body: PRINT_DATA },
    }));
    const user = userEvent.setup();
    await openPanel(user);
    await writeLine(user, "Crocin 500");
    await waitFor(() => { expect(bodiesOf("PUT", NOTE).some((b) => Array.isArray(b.rxDraft))).toBe(true); }, { timeout: 4000 });
    await user.click(screen.getByRole("button", { name: "Issue & print" }));
    await waitFor(() => { expect(callsTo("POST", "/api/opd/visits/enc-1/prescriptions")).toHaveLength(1); });
    await waitFor(() => { expect(bodiesOf("PUT", NOTE).at(-1)!.rxDraft).toBeNull(); }, { timeout: 4000 });
  });
});

describe("B — a reopened consult shows the prescription already issued", () => {
  it("B1: the Rx tab shows the issued version read-only, and the strip says it is issued (walk 41)", async () => {
    const issued = (version: number, status: string, drug: string) => ({
      id: `rx-${String(version)}`, encounterId: "enc-1", patientId: "p-1", doctorId: "doc-1", version,
      lines: [{ drug, dose: "500 mg", route: "oral", frequency: "TDS", durationDays: 3, instructions: "After food", noSubstitution: false }],
      document: null, allergyOverrides: [], status, issuedBy: "u-1", issuedAt: "2026-08-18T05:12:00.000Z",
    });
    mockRoutes(routes({ "GET /api/opd/visits/enc-1": { status: 200, body: { ...VISIT, prescriptions: [issued(1, "superseded", "Old drug"), issued(2, "active", "Crocin 500")] } } }));
    const user = userEvent.setup();
    await openPanel(user);
    const strip = await screen.findByTestId("work-rx");
    await waitFor(() => { expect(strip).toHaveTextContent(/Issued · version 2/); });
    expect(strip).toHaveTextContent("Crocin 500");
    expect(strip).not.toHaveTextContent("not yet");
    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    const box = await screen.findByTestId("rx-issued");
    expect(box).toHaveTextContent(/version 2/i);
    expect(box).toHaveTextContent("Crocin 500 · 500 mg · TDS · oral · 3 days · After food");
    expect(box).not.toHaveTextContent("Old drug");
    // nothing un-issued is waiting, so Complete does not offer to issue again
    expect(screen.getByTestId("complete-consult")).not.toHaveTextContent("Issue & complete");
    // amending is a deliberate act: the issued lines come into the editor as the next version
    await user.click(within(box).getByTestId("rx-issued-amend"));
    expect(await screen.findByTestId("rx-card-head-0")).toHaveTextContent("Crocin 500");
    expect(callsTo("POST", "/api/opd/visits/enc-1/prescriptions")).toHaveLength(0);
  });
});

describe("D — My layout has a desktop entry", () => {
  it("D1: the header carries My layout outside the ⋯ menu (which is display:none at ≥900 px)", async () => {
    mockRoutes(routes({ "GET /api/opd/me/layout": { status: 200, body: { departmentId: "dep-1", departmentName: "General", version: null, defaultVersion: null, sections: [], adminHidden: [], audit: [] } } }));
    const user = userEvent.setup();
    await openPanel(user);
    const btn = screen.getByTestId("my-layout-open");
    expect(btn.closest(".cx-more-wrap")).toBeNull();
    expect(btn).toHaveClass("cx-hbtn");
    await user.click(btn);
    expect(await screen.findByTestId("my-layout-dialog")).toBeInTheDocument();
  });
});

describe("E — the allergy typeahead closes", () => {
  const HITS = {
    items: [
      { term: "Penicillins / Beta-Lactams", kind: "class", allergenClass: "Penicillins / Beta-Lactams", saltId: null, blocks: ["Amoxicillin"] },
      { term: "Penicillin", kind: "moiety", allergenClass: null, saltId: "S1", blocks: [] },
    ],
    known: true,
  };
  it("E1: after a pick it stays closed (walk 29b); Esc closes it; Tab out closes it", async () => {
    mockRoutes(routes({ "GET /api/opd/cds/complete/allergen": { status: 200, body: HITS } }));
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(await screen.findByTestId("allergy-add"));
    const box = screen.getByLabelText("Allergy — substance");
    await user.type(box, "pencil");
    await user.click(await screen.findByTestId("allergy-hit-Penicillins / Beta-Lactams"));
    // the pick set the text; the debounced suggester must not re-open the list over Severity
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(screen.queryByTestId("allergy-hits")).toBeNull();

    await user.clear(box);
    await user.type(box, "penic");
    expect(await screen.findByTestId("allergy-hits")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("allergy-hits")).toBeNull();

    await user.type(box, "i");
    expect(await screen.findByTestId("allergy-hits")).toBeInTheDocument();
    await user.tab();
    await waitFor(() => { expect(screen.queryByTestId("allergy-hits")).toBeNull(); });
  });
});

describe("F — the allergy-conflict dialog", () => {
  it("F1: names the DRUG that matched and the allergy's severity, and Cancel goes back with nothing issued", async () => {
    let posts = 0;
    mockRoutes(routes({
      "POST /api/opd/visits/enc-1/prescriptions": () => {
        posts += 1;
        return { status: 409, body: { statusCode: 409, message: "conflict", code: "allergy_conflict", detail: { matches: [{ lineIndex: 0, substance: "Penicillin" }] } } };
      },
    }));
    const user = userEvent.setup();
    await openPanel(user);
    await writeLine(user, "Tab Amoxicillin 500");
    await user.click(screen.getByRole("button", { name: "Issue & print" }));
    const dialog = await screen.findByTestId("override-dialog");
    expect(within(dialog).getByTestId("override-match-0")).toHaveTextContent("Tab Amoxicillin 500");
    expect(within(dialog).getByTestId("override-match-0")).toHaveTextContent("Penicillin");
    expect(within(dialog).getByTestId("override-match-0")).toHaveTextContent(/severe/i);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => { expect(screen.queryByTestId("override-dialog")).toBeNull(); });
    expect(posts).toBe(1);
    expect(screen.getByTestId("rx-card-head-0")).toHaveTextContent("Tab Amoxicillin 500"); // back to the Rx, lines intact
  });
});

describe("G — the small ones", () => {
  it("G1: removing a complaint chip saves at once, without waiting for a blur", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    await openPanel(user);
    const field = screen.getByLabelText("Chief complaint");
    await user.type(field, "fever{Enter}cough{Enter}");
    await user.click(screen.getByRole("heading", { name: "Consultation" }));
    await waitFor(() => { expect(bodiesOf("PUT", NOTE).at(-1)!.chiefComplaint).toMatch(/cough/); });
    const before = callsTo("PUT", NOTE).length;
    await user.click(screen.getByRole("button", { name: "Remove cough" }));
    await waitFor(() => { expect(callsTo("PUT", NOTE).length).toBe(before + 1); });
    expect(bodiesOf("PUT", NOTE).at(-1)!.chiefComplaint).toBe("fever");
  });

  it("G2: an empty dose says so in words, never a raw validator message", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await user.type(await screen.findByLabelText("Drug"), "Crocin 500");
    await user.click(screen.getByTestId("sig-0-freq-TDS"));
    await user.click(screen.getByTestId("sig-0-days-3"));
    await user.click(screen.getByRole("button", { name: "Issue & print" }));
    const alerts = await screen.findAllByRole("alert");
    const text = alerts.map((a) => a.textContent ?? "").join(" | ");
    expect(text).not.toMatch(/Too small|expected string/);
    expect(text).toMatch(/Write the dose/);
  });

  it("G3: a new line pre-selects no frequency — OD is a choice, not a default", async () => {
    mockRoutes(routes());
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(screen.getByRole("tab", { name: "Prescription" }));
    await screen.findByLabelText("Drug");
    for (const f of ["OD", "BD", "TDS", "other"]) {
      expect(screen.getByTestId(`sig-0-freq-${f}`)).toHaveAttribute("aria-checked", "false");
    }
  });

  it("G4: the Summary lists the eye sections with what was recorded", async () => {
    mockRoutes(routes({ "GET /api/opd/visits/enc-1/sections": { status: 200, body: {
      profile: "ophthalmology",
      sections: [{ key: "eye.vision", version: 1, kind: "eye-grid" }, { key: "eye.iop", version: 1, kind: "eye-grid" }],
      records: {
        "eye.vision": { body: { vaUnaided: { od: "6/9", os: "6/12" } }, at: NOW_ISO, authorId: "u-1", sectionVersion: 1, recordId: "r1" },
        "eye.iop": { body: { method: "NCT", od: 14, os: 16 }, at: NOW_ISO, authorId: "u-1", sectionVersion: 1, recordId: "r2" },
      },
    } } }));
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(screen.getByRole("tab", { name: "Summary" }));
    const eye = await screen.findByTestId("summary-eye");
    expect(eye).toHaveTextContent("6/9");
    expect(eye).toHaveTextContent("6/12");
    expect(eye).toHaveTextContent("14");
  });

  it("G5: at desktop widths the tab row wraps as the board draws it; only a phone scrolls it", () => {
    // the rule outside any media query is what 1440 gets (read from disk: vitest hands CSS imports back empty)
    const consultCss = readFileSync(resolve(__dirname, "opd-consult.css"), "utf8");
    expect(consultCss).toMatch(/\[role="tablist"\]/);
    const outside = consultCss.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    expect(outside).not.toMatch(/\[role="tablist"\][^{]*\{[^}]*flex-wrap:\s*nowrap/);
  });
});
