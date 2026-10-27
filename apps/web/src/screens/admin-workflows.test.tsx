import { act, screen, waitFor } from "@testing-library/react";
import i18next from "i18next";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { AdminWorkflows } from "./admin-workflows";
import type { WireBoardDefinition, WireWorkflowBoard } from "./admin-workflows";

/** GO-LIVE SCREENS — the workflow board offers only the acts the viewer can take; the server decides. Fake data. */
const steps = { initialState: "requested", states: [{ name: "requested", terminal: false }, { name: "admitted", terminal: false }], transitions: [{ from: "requested", to: "admitted", roles: ["front_office"] }] };
const draft = (over: Partial<WireBoardDefinition> = {}): WireBoardDefinition => ({
  id: "d1", defKey: "ipd_admission", version: 1, title: "IPD admission", changeClass: "A", status: "draft",
  draftedBy: { id: "ipd-stage-setup", name: null }, draftedAt: "2026-10-13T10:00:00Z", activatedBy: null, activatedAt: null,
  approvals: [], requiredRoles: ["owner", "medical_superintendent"], missingRoles: ["owner", "medical_superintendent"],
  steps, diff: null, ...over,
});

const DARK = ["tasks", "ipd", "bmw", "linen", "housekeeping", "maintenance", "passes", "transport", "diet", "emergency"];
let reads: string[] = [];

/** `ipdOn` — decision 0085: the board is an IPD go-live screen, so every case below runs with `ipd` on unless it says not. */
function mock(board: WireWorkflowBoard, perms: string[], me = "u-owner", ipdOn = true): { posts: { path: string; body: unknown }[] } {
  const posts: { path: string; body: unknown }[] = [];
  reads = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "");
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: me }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } }, modules: { dark: DARK, on: ipdOn ? ["ipd"] : [] } });
    if (path === "/workflow/definitions/board") { reads.push(path); return json(board); }
    if (init?.method === "POST") { posts.push({ path, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) }); return json({ ok: true }); }
    return new Response("{}", { status: 404 });
  }));
  return { posts };
}

describe("/admin/workflows", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("the MS sees the draft waiting for both, and approves as medical superintendent only", async () => {
    const { posts } = mock({ definitions: [draft()], viewer: { policyRoles: ["medical_superintendent"] } },
      ["workflow.definitions.read", "workflow.definitions.approve"], "u-ms");
    renderWithProviders(<AdminWorkflows />);
    expect(await screen.findByTestId("wf-ipd_admission-v1-state")).toHaveTextContent("Draft");
    expect(screen.getByTestId("wf-ipd_admission-v1-approvals")).toHaveTextContent("Owner: Waiting");
    expect(screen.queryByTestId("wf-ipd_admission-v1-approve-owner")).toBeNull();
    expect(screen.queryByTestId("wf-ipd_admission-v1-activate")).toBeNull();
    await userEvent.click(screen.getByTestId("wf-ipd_admission-v1-approve-medical_superintendent"));
    await waitFor(() => expect(posts).toEqual([{ path: "/workflow/definitions/d1/approve", body: { roleKey: "medical_superintendent", note: "Reviewed and approved" } }]));
  });

  it("once both approved, the owner activates", async () => {
    const both = draft({
      missingRoles: [],
      approvals: [
        { approverId: "u-ms", approverName: "MS", roleKey: "medical_superintendent", emergency: false, note: "ok", at: "2026-10-13T11:00:00Z" },
        { approverId: "u-owner", approverName: "Owner", roleKey: "owner", emergency: false, note: "ok", at: "2026-10-13T12:00:00Z" },
      ],
    });
    const { posts } = mock({ definitions: [both], viewer: { policyRoles: ["owner"] } },
      ["workflow.definitions.read", "workflow.definitions.approve", "workflow.definitions.activate"]);
    renderWithProviders(<AdminWorkflows />);
    await userEvent.click(await screen.findByTestId("wf-ipd_admission-v1-activate"));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/workflow/definitions/d1/activate"]));
  });

  it("a reader with no approve permission sees who it waits for, and no buttons", async () => {
    mock({ definitions: [draft()], viewer: { policyRoles: [] } }, ["workflow.definitions.read"]);
    renderWithProviders(<AdminWorkflows />);
    expect(await screen.findByTestId("wf-ipd_admission-v1-waitfor")).toHaveTextContent("Owner, Medical superintendent");
    expect(screen.queryByRole("button", { name: /Approve as/ })).toBeNull();
  });

  it("the person who drafted it sees Approve disabled, with the reason", async () => {
    mock({ definitions: [draft({ draftedBy: { id: "u-owner", name: "Owner" } })], viewer: { policyRoles: ["owner"] } },
      ["workflow.definitions.read", "workflow.definitions.approve"]);
    renderWithProviders(<AdminWorkflows />);
    expect(await screen.findByTestId("wf-ipd_admission-v1-approve-owner")).toBeDisabled();
    expect(screen.getByTestId("wf-ipd_admission-v1-drafter")).toHaveTextContent("You drafted it");
  });
});

/*
  IPD walk 2026-10-14 — a person without the grant saw the server's own sentence, "missing permission
  workflow.definitions.read", in English on a Hindi screen. A 403 is said in the reader's language.
*/
describe("/admin/workflows — refused", () => {
  beforeEach(() => {
    setToken("t");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = raw.replace(/^.*\/api/, "");
      if (path === "/auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } }, modules: { dark: DARK, on: ["ipd"] } }), { status: 200 });
      return new Response(JSON.stringify({ statusCode: 403, message: "missing permission workflow.definitions.read", error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(async () => { vi.unstubAllGlobals(); setToken(null); await act(async () => { await i18next.changeLanguage("en"); }); });

  it("says the person has no access, translated, never the raw permission name", async () => {
    renderWithProviders(<AdminWorkflows />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You don't have access to this screen.");
    expect(alert).not.toHaveTextContent("workflow.definitions.read");
    await act(async () => { await i18next.changeLanguage("hi"); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("आपको इस स्क्रीन की अनुमति नहीं है।"));
  });
});

/** Decision 0085 invariant 1, dark by default — with `ipd` off (production) the board draws nothing and asks for nothing. */
describe("/admin/workflows — dark while ipd is off", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("ipd off: no board, no definitions read, even for the owner", async () => {
    mock({ definitions: [draft()], viewer: { policyRoles: ["owner"] } },
      ["workflow.definitions.read", "workflow.definitions.approve", "workflow.definitions.activate"], "u-owner", false);
    renderWithProviders(<AdminWorkflows />);
    expect(await screen.findByTestId("admin-workflows-off")).toBeInTheDocument();
    expect(screen.queryByTestId("wf-ipd_admission-v1-state")).toBeNull();
    expect(reads).toEqual([]);
  });
});
