import { fireEvent, screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LinenUniforms } from "./linen-uniforms";
import type { LinenUniformView } from "@hmis/contracts";

/** LD-2 (#979) — the uniform counter: one dirty for one clean by sign-in name; the leavers' no-dues list. */
const view: LinenUniformView = {
  serverNow: new Date().toISOString(), roles: ["housekeeping", "nurse"],
  holdings: [{ userId: "u1", name: "Staff One", staffCode: "S-1", sets: 3, size: "M" }],
  dues: [{ userId: "u2", name: "Leaver Two", staffCode: "S-2", sets: 2, size: "L", firstIssuedAt: new Date().toISOString(), monthsUsed: 3, replacementPaise: 120_000, deductionPaise: 90_000 }],
};

describe("LinenUniforms (LD-2)", () => {
  let posts: { url: string; body: unknown }[];
  beforeEach(() => {
    setToken("t");
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") posts.push({ url: raw, body: JSON.parse(String(init.body)) });
      const body = raw.endsWith("/linen/uniforms") ? view
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["linen.uniform"], scoped: { department: {}, floor: {} } } }
          : { holding: 3 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("Exchange sends the same number dirty and clean, by sign-in name", async () => {
    renderWithProviders(<LinenUniforms />);
    const save = await screen.findByTestId("uniform-save");
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("uniform-who"), { target: { value: "staff.one" } });
    fireEvent.change(screen.getByTestId("uniform-sets"), { target: { value: "2" } });
    fireEvent.click(save);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toMatch(/\/linen\/uniforms\/exchange$/);
    expect(posts[0]!.body).toEqual({ username: "staff.one", dirty: 2, clean: 2 });
    expect(await screen.findByTestId("uniform-notice")).toHaveTextContent("holds 3 sets");
  });

  it("Issue carries the size; the no-dues list shows a leaver's sets and the deduction for HR", async () => {
    renderWithProviders(<LinenUniforms />);
    fireEvent.click(await screen.findByTestId("verb-issue"));
    fireEvent.change(screen.getByTestId("uniform-who"), { target: { value: "staff.one" } });
    fireEvent.change(screen.getByTestId("uniform-size"), { target: { value: "M" } });
    fireEvent.click(screen.getByTestId("uniform-save"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ username: "staff.one", sets: 1, size: "M" });
    const due = screen.getByTestId("due-u2");
    expect(due).toHaveTextContent("Blocks no-dues");
    expect(due).toHaveTextContent("Deduct ₹900 of ₹1,200");
  });
});
