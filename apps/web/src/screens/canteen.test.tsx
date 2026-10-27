import { fireEvent, screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { CanteenBed } from "./canteen-bed";
import { CanteenTill } from "./canteen-till";
import type { CanteenBedMenu, CanteenSale, CanteenSetupView, CanteenTillClose } from "@hmis/contracts";

/**
 * CN-1 CANTEEN (#977) — the till sells what was tapped, by the mode picked, on the cashier's session; the bed page names
 * the bed only, offers "included" only while the bed class has meals left, and the hospital bill only with a family
 * link on this phone. Synthetic data.
 */
const setup: CanteenSetupView = {
  outlets: [{ outletId: "o1", code: "MAIN", name: "Main canteen", kind: "in_house", active: true, catererName: null, monthlyRentPaise: null, tills: [{ tillId: "t1", code: "MAIN-T1", name: "Till 1", active: true }] }],
  costCentres: [], freeRules: [], bedClassMeals: [], staffCategories: [],
};
const session: CanteenTillClose = { sessionId: "s1", tillId: "t1", state: "open", openingCashPaise: 0, cashSalesPaise: 0, expectedCashPaise: 0, countedCashPaise: 0, variancePaise: 0 };
const menu = [{ dishId: "d1", code: "THALI", name: "Veg thali", meal: "lunch", foodType: "veg", allergens: ["milk"], prices: { public: 8_400 } }];
const sold: CanteenSale = {
  saleId: "x", saleNo: "CNT/2627/000001", token: 7, state: "completed", channel: "counter", outletId: "o1", payMode: "cash", totalPaise: 16_800,
  lines: [], staffRule: null, deductionPaise: 0, nightMeal: false,
};
const bedMenu: CanteenBedMenu = { bedLabel: "GW-12", outletId: "o1", bedClassMealsLeft: 1, dishes: [{ dishId: "d1", name: "Veg thali", meal: "lunch", foodType: "veg", allergens: ["milk"], pricePaise: 8_400 }] };

describe("Canteen (CN-1)", () => {
  let posts: { url: string; body: Record<string, unknown> }[];
  beforeEach(() => {
    setToken("t");
    posts = [];
    try { localStorage.removeItem("hmis.family.token"); localStorage.setItem("hmis.family.lang", "en"); } catch { /* none */ }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") posts.push({ url: raw, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const body = raw.endsWith("/canteen/setup") ? setup
        : raw.endsWith("/canteen/my-session") ? session
          : raw.includes("/canteen/outlets/o1/menu") ? menu
            : raw.endsWith("/canteen/bed-orders") ? []
              : raw.endsWith("/canteen/bed/menu") ? bedMenu
                : raw.endsWith("/canteen/sales") || raw.endsWith("/canteen/bed/order") ? sold
                  : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["canteen.sell"], scoped: { department: {}, floor: {} } } }
                    : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the till sells two thalis for cash on the open session and shows the token", async () => {
    renderWithProviders(<CanteenTill />);
    const dish = await screen.findByTestId("cn-dish-THALI");
    fireEvent.click(dish);
    fireEvent.click(dish);
    expect(screen.getByTestId("cn-total")).toHaveTextContent("₹168");
    fireEvent.click(screen.getByTestId("cn-sell"));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/canteen/sales"))).toBe(true));
    const sale = posts.find((p) => p.url.endsWith("/canteen/sales"))!.body;
    expect(sale).toMatchObject({ sessionId: "s1", lines: [{ dishId: "d1", qty: 2 }], pay: { mode: "cash" } });
    expect(await screen.findByTestId("cn-token")).toHaveTextContent("7");
  });

  it("UPI cannot sell without the reference", async () => {
    renderWithProviders(<CanteenTill />);
    fireEvent.click(await screen.findByTestId("cn-dish-THALI"));
    fireEvent.click(screen.getByTestId("cn-mode-upi"));
    expect(screen.getByTestId("cn-sell")).toBeDisabled();
    fireEvent.change(screen.getByTestId("cn-upi-ref"), { target: { value: "UPI12345678" } });
    expect(screen.getByTestId("cn-sell")).not.toBeDisabled();
  });

  it("the bed page names the bed only and offers the included meal; the hospital bill needs a family link", async () => {
    renderWithProviders(<CanteenBed token="tok_aaaaaaaaaaaaaaaaaaaa" />);
    expect(await screen.findByText("Bed GW-12")).toBeInTheDocument();
    expect(screen.getByTestId("cn-bed-included")).toBeInTheDocument();
    expect(screen.queryByText("Hospital bill")).toBeNull();
    fireEvent.click(screen.getByTestId("cn-bed-add-Veg thali"));
    fireEvent.click(screen.getByTestId("cn-bed-included"));
    fireEvent.click(screen.getByTestId("cn-bed-order"));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/canteen/bed/order"))).toBe(true));
    expect(posts.find((p) => p.url.endsWith("/canteen/bed/order"))!.body).toMatchObject({ token: "tok_aaaaaaaaaaaaaaaaaaaa", pay: "bed_class", lines: [{ dishId: "d1", qty: 1 }] });
  });
});
