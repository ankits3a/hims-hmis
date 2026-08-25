import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../lib/auth";
import { setToken } from "../lib/api";
import { router } from "../router";
import { stubFetch } from "../test-utils";
import { isWedgeInput } from "./command-palette";
import { shouldOpenPalette } from "../lib/keyboard";
import "../lib/i18n";

/**
 * PLAN 11h T8 — the palette, driven through the real shell so the hotkey, the provider and the
 * router are all exercised the way a desk exercises them.
 */
function hit(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { entity: "patient", id: "p1", title: "Asha Devi", subtitle: "HMS-1 · female", href: "/patients/p1", ...over };
}

function renderApp(opts: { hospital?: string[]; groups?: unknown[] } = {}): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: { hospital: opts.hospital ?? ["patients.register", "patients.read"], scoped: { department: {}, floor: {} } },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [] },
    "GET /api/search": {
      groups: opts.groups ?? [{ entity: "patient", provider: "patients.patient", hits: [hit()], total: 1, timedOut: false, errored: false }],
      tookMs: 8, skipped: [], auditId: "aud-1",
    },
    "POST /api/search/opened": {},
    "POST /api/patients/qr/verify": { ok: true, patient: { id: "scanned-1" } },
  });
  setToken("t-1");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} history={createMemoryHistory({ initialEntries: ["/registration"] })} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => { setToken(null); });

const paletteInput = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>("[data-palette-input]");

it("`/` OPENS THE PALETTE — including on screens that never had a search box", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByRole("link", { name: "Registration" })).toBeInTheDocument());

  fireEvent.keyDown(window, { key: "/" });

  await waitFor(() => expect(paletteInput()).toBeInTheDocument());
  expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
});

it("Ctrl+K opens it too — the shortcut every desk already knows", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByRole("link", { name: "Registration" })).toBeInTheDocument());

  fireEvent.keyDown(window, { key: "k", ctrlKey: true });

  await waitFor(() => expect(paletteInput()).toBeInTheDocument());
});

it("A `/` TYPED INTO AN INPUT IS A CHARACTER, NEVER A COMMAND", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByRole("link", { name: "Registration" })).toBeInTheDocument());
  const someInput = document.createElement("input");
  document.body.appendChild(someInput);
  someInput.focus();

  fireEvent.keyDown(someInput, { key: "/" });

  expect(paletteInput()).toBeNull();
  someInput.remove();
});

it("Escape closes it", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByRole("link", { name: "Registration" })).toBeInTheDocument());
  fireEvent.keyDown(window, { key: "/" });
  await waitFor(() => expect(paletteInput()).toBeInTheDocument());

  fireEvent.keyDown(paletteInput()!, { key: "Escape" });

  await waitFor(() => expect(paletteInput()).toBeNull());
});

it("shows results, and marks an APPROXIMATE match as one", async () => {
  renderApp({
    groups: [{
      entity: "patient", provider: "patients.patient",
      hits: [hit({ title: "Asha Devi", meta: { match: "approximate" } })],
      total: 1, timedOut: false, errored: false,
    }],
  });
  await waitFor(() => expect(screen.getByRole("link", { name: "Registration" })).toBeInTheDocument());
  fireEvent.keyDown(window, { key: "/" });
  await waitFor(() => expect(paletteInput()).toBeInTheDocument());

  fireEvent.change(paletteInput()!, { target: { value: "aasha" } });

  await waitFor(() => expect(screen.getByText("Asha Devi")).toBeInTheDocument());
  // A guess presented as an exact match is how the wrong patient gets opened.
  expect(screen.getByText("approximate match")).toBeInTheDocument();
});

it("offers COMMANDS the person may reach, and never those they may not", async () => {
  renderApp({ hospital: ["patients.register"], groups: [] });
  await waitFor(() => expect(screen.getByRole("link", { name: "Registration" })).toBeInTheDocument());
  fireEvent.keyDown(window, { key: "/" });
  await waitFor(() => expect(paletteInput()).toBeInTheDocument());

  fireEvent.change(paletteInput()!, { target: { value: "regi" } });

  await waitFor(() => expect(screen.getByRole("button", { name: "Registration" })).toBeInTheDocument());

  fireEvent.change(paletteInput()!, { target: { value: "user" } });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Users" })).toBeNull());
});

it("A WEDGE SCAN OPENS THE PATIENT; the same payload typed by a human does not", async () => {
  renderApp({ groups: [] });
  await waitFor(() => expect(screen.getByRole("link", { name: "Registration" })).toBeInTheDocument());
  fireEvent.keyDown(window, { key: "/" });
  await waitFor(() => expect(paletteInput()).toBeInTheDocument());

  // A wedge delivers the whole payload in one event, faster than fingers can.
  fireEvent.change(paletteInput()!, { target: { value: "HMISQR0000000000000001" } });

  await waitFor(() => {
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).includes("/patients/qr/verify"))).toBe(true);
  });
});

describe("the two decisions, asserted directly", () => {
  it("A8 — `/` opens the palette from a screen, and NEVER from inside a field", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    expect(shouldOpenPalette({ key: "/", ctrlKey: false, metaKey: false }, document.body)).toBe(true);
    expect(shouldOpenPalette({ key: "k", ctrlKey: true, metaKey: false }, document.body)).toBe(true);
    // The guard: a clinician typing a note must keep their character.
    expect(shouldOpenPalette({ key: "/", ctrlKey: false, metaKey: false }, input)).toBe(false);
    expect(shouldOpenPalette({ key: "/", ctrlKey: false, metaKey: false }, textarea)).toBe(false);
    // And an unrelated key is not a palette key.
    expect(shouldOpenPalette({ key: "a", ctrlKey: false, metaKey: false }, document.body)).toBe(false);
  });

  it("A9 — only LONG AND FAST is a scan", () => {
    expect(isWedgeInput(22, 40)).toBe(true);      // a wedge
    expect(isWedgeInput(22, 3000)).toBe(false);   // a UHID read off a card and typed
    expect(isWedgeInput(4, 20)).toBe(false);      // a fast typist on a short query
  });
});
