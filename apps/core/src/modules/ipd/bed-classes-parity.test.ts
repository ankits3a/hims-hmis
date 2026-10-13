import { IPD_BED_CLASSES } from "@hmis/contracts";
import { IPD_BED_CLASS_VALUES } from "../../kernel/db/schema";

/** The stays table's CHECK is built from a retyped list (drizzle-kit cannot load the contracts package): keep them equal. */
it("the schema's IPD class list is the contract's", () => {
  expect([...IPD_BED_CLASS_VALUES]).toEqual([...IPD_BED_CLASSES]);
});
