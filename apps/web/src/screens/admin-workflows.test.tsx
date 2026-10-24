import { screen, waitFor } from "@testing-library/react";
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

function mock(board: WireWorkflowBoard, perms: string[], me = "u-owner"): { posts: { path: string; body: unknown }[] } {
  const posts: { path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "");
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: me }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (path === "/workflow/definitions/board") return json(board);
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
});
