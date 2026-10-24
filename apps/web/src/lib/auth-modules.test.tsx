import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "./auth";
import { setToken } from "./api";

/**
 * Decision 0085 — `moduleOn` reads the server's switch from `/auth/me`. A module the server ships dark is off unless the
 * server names it on; an older server that sends no `modules` reads as every switchable module off.
 */
function Probe(): React.ReactElement {
  const { moduleOn, ready } = useAuth();
  return <p data-testid="probe">{ready ? `ipd=${String(moduleOn("ipd"))} diet=${String(moduleOn("diet"))} billing=${String(moduleOn("billing"))}` : "…"}</p>;
}

function serve(modules: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (url.endsWith("/api/auth/me")) {
      const body = { actor: { type: "user", id: "asha" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } }, ...(modules === undefined ? {} : { modules }) };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }));
}

async function probe(): Promise<string> {
  setToken("t-asha");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><AuthProvider><Probe /></AuthProvider></QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId("probe")).not.toHaveTextContent("…"));
  return screen.getByTestId("probe").textContent ?? "";
}

afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

const DARK = ["tasks", "ipd", "bmw", "linen", "housekeeping", "maintenance", "passes", "transport", "diet", "emergency"];

it("production (nothing on): a dark module is off; a module the switch cannot hide is on", async () => {
  serve({ dark: DARK, on: [] });
  expect(await probe()).toBe("ipd=false diet=false billing=true");
});

it("a module the server names on is on, and only that one", async () => {
  serve({ dark: DARK, on: ["ipd"] });
  expect(await probe()).toBe("ipd=true diet=false billing=true");
});

it("an older server that sends no `modules`: every switchable module reads off", async () => {
  serve(undefined);
  expect(await probe()).toBe("ipd=false diet=false billing=false");
});
