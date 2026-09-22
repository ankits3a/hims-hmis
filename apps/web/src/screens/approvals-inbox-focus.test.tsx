import { screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { ApprovalsInbox } from "./approvals-inbox";

/**
 * ═══ PHASE O T3 — THE BELL'S DEEP LINK, ARRIVING ═══
 *
 * `alerts-bell.test.tsx` proves the link is BUILT (`/approvals?focus=ap-9`). This proves it is
 * HONOURED, and the two halves are deliberately in different files because they are different
 * claims about different components — a single test that rendered both would pass on a pair that
 * agreed with each other and with nothing else.
 *
 * This file mocks NOTHING of `@tanstack/react-router`: the query string goes into a memory
 * history and comes back out through the screen's own `useSearch`, which is the whole mechanism
 * under test. The sibling suite mocks `useNavigate` and therefore cannot ask this question.
 */
const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

const card = (id: string, name: string): Record<string, unknown> => ({
  id, typeKey: "billing_refund", instanceId: `wi-${id}`, requesterId: "u-sunita", requesterName: "Sunita Verma",
  approverRole: "billing_manager", urgencyClass: "routine", actedFirst: false,
  subjectType: "billing_refund", subjectId: `inv-${id}`, patientId: `p-${id}`, encounterId: null, payeeId: null,
  patient: { id: `p-${id}`, uhid: "U00110234", name, alias: null, restricted: false },
  amountPaise: 125000, cumulativePatientPaise: 125000, cumulativePayeePaise: null,
  requestNote: "Cancelled after paying", status: "pending",
  decisionNote: null, decidedBy: null, decidedByName: null, decidedAt: null, requestedAt: minutesAgo(12),
});

function mockApi(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const body = url.includes("/api/auth/me")
      ? {
          actor: { type: "user", id: "u-1" },
          permissions: { hospital: ["approvals.requests.read", "approvals.requests.decide"], scoped: { department: {}, floor: {} } },
        }
      : { items: [card("ap-1", "Ramesh Kumar"), card("ap-9", "Lakshmi Devi")], total: 2 };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

const focusedIds = (): (string | null)[] =>
  [...document.querySelectorAll("[data-focused='true']")].map((e) => e.getAttribute("data-approval-id"));

describe("approvals inbox — ?focus=", () => {
  beforeEach(() => { setToken("tok-1"); mockApi(); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("marks the one card the bell was about, and scrolls it into view", async () => {
    const scrolled: Element[] = [];
    renderWithRouter(<ApprovalsInbox />, "/approvals?focus=ap-9");
    // Patched AFTER the harness installs its own no-op, so this records rather than replaces it.
    Element.prototype.scrollIntoView = function record(this: Element): void { scrolled.push(this); };

    await screen.findByRole("article", { name: /Lakshmi Devi/ });
    await waitFor(() => { expect(focusedIds()).toEqual(["ap-9"]); });
    await waitFor(() => {
      expect(scrolled.map((e) => e.getAttribute("data-approval-id"))).toContain("ap-9");
    });
  });

  it("marks NOTHING without a focus, and nothing for an id the list does not hold", async () => {
    // NOT-OVER-BROAD. A `focused` flag that were simply always true, or a selector that matched
    // the first card, would pass the test above and fail both of these.
    const plain = renderWithRouter(<ApprovalsInbox />, "/approvals");
    await screen.findByRole("article", { name: /Lakshmi Devi/ });
    expect(focusedIds()).toEqual([]);
    plain.unmount();

    renderWithRouter(<ApprovalsInbox />, "/approvals?focus=ap-does-not-exist");
    await screen.findAllByRole("article", { name: /Lakshmi Devi/ });
    expect(focusedIds()).toEqual([]);
  });
});
