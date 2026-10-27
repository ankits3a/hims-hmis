import {
  CANTEEN_ALLERGENS, CANTEEN_CHARITY_KINDS, CANTEEN_FOOD_TYPES, CANTEEN_GST_TREATMENTS, CANTEEN_MEALS, CANTEEN_OUTLET_KINDS, CANTEEN_PAY_MODES,
  CANTEEN_PRICE_LISTS, CANTEEN_SALE_CHANNELS, CANTEEN_SALE_STATES, CANTEEN_SESSION_STATES, CANTEEN_STAFF_GST, CANTEEN_STAFF_PRICE_BASES,
  allergensInText,
} from "@hmis/contracts";
import {
  CANTEEN_ALLERGEN_VALUES, CANTEEN_CHARITY_KIND_VALUES, CANTEEN_FOOD_TYPE_VALUES, CANTEEN_GST_TREATMENT_VALUES, CANTEEN_MEAL_VALUES,
  CANTEEN_OUTLET_KIND_VALUES, CANTEEN_PAY_MODE_VALUES, CANTEEN_PRICE_LIST_VALUES, CANTEEN_SALE_CHANNEL_VALUES, CANTEEN_SALE_STATE_VALUES,
  CANTEEN_SESSION_STATE_VALUES, CANTEEN_STAFF_GST_VALUES, CANTEEN_STAFF_PRICE_BASIS_VALUES,
} from "../../kernel/db/schema";
import { splitInclusive, addOnTax, fyShort, istMinute } from "./money";

/** The schema's CHECK lists are retyped from the contracts (drizzle-kit loads the schema without them): held equal here. */
describe("canteen — schema lists equal the contracts", () => {
  it.each([
    [CANTEEN_OUTLET_KIND_VALUES, CANTEEN_OUTLET_KINDS], [CANTEEN_MEAL_VALUES, CANTEEN_MEALS], [CANTEEN_FOOD_TYPE_VALUES, CANTEEN_FOOD_TYPES],
    [CANTEEN_ALLERGEN_VALUES, CANTEEN_ALLERGENS], [CANTEEN_PRICE_LIST_VALUES, CANTEEN_PRICE_LISTS], [CANTEEN_STAFF_PRICE_BASIS_VALUES, CANTEEN_STAFF_PRICE_BASES],
    [CANTEEN_STAFF_GST_VALUES, CANTEEN_STAFF_GST], [CANTEEN_PAY_MODE_VALUES, CANTEEN_PAY_MODES], [CANTEEN_GST_TREATMENT_VALUES, CANTEEN_GST_TREATMENTS],
    [CANTEEN_SALE_STATE_VALUES, CANTEEN_SALE_STATES], [CANTEEN_SALE_CHANNEL_VALUES, CANTEEN_SALE_CHANNELS], [CANTEEN_SESSION_STATE_VALUES, CANTEEN_SESSION_STATES],
    [CANTEEN_CHARITY_KIND_VALUES, CANTEEN_CHARITY_KINDS],
  ] as const)("%j", (schema, contract) => { expect([...schema]).toEqual([...contract]); });
});

describe("canteen — money and words", () => {
  it("takes 5% out of an inclusive price, CGST = SGST, to the paisa", () => {
    expect(splitInclusive(8_400, 500)).toEqual({ netPaise: 8_400, taxablePaise: 8_000, cgstPaise: 200, sgstPaise: 200 });
    const odd = splitInclusive(1_000, 500);
    expect(odd.taxablePaise + odd.cgstPaise + odd.sgstPaise).toBe(1_000);
    expect(splitInclusive(1_000, 0)).toEqual({ netPaise: 1_000, taxablePaise: 1_000, cgstPaise: 0, sgstPaise: 0 });
  });
  it("puts 18% on the rent", () => {
    expect(addOnTax(5_000_000, 1_800)).toEqual({ netPaise: 5_900_000, taxablePaise: 5_000_000, cgstPaise: 450_000, sgstPaise: 450_000 });
  });
  it("names the fiscal year and the IST minute", () => {
    expect(fyShort(new Date("2026-03-31T18:29:00Z"))).toBe("2526");
    expect(fyShort(new Date("2026-03-31T18:31:00Z"))).toBe("2627");
    expect(istMinute(new Date("2026-11-02T17:30:00Z"))).toBe(23 * 60);
  });
  it("reads a patient's free-text allergy onto the FSSAI list", () => {
    expect(allergensInText("Groundnut")).toEqual(["peanut"]);
    expect(allergensInText("allergic to dudh and anda")).toEqual(["milk", "egg"]);
    expect(allergensInText("Penicillin")).toEqual([]);
    expect(allergensInText("cashew nuts")).toEqual(["tree_nut"]);
  });
});
