import { IPD_CHARGE_COMPONENTS, IPD_CHARGE_SOURCES } from "@hmis/contracts";
import { IPD_CHARGE_COMPONENT_VALUES, IPD_CHARGE_SOURCE_VALUES } from "../../kernel/db/schema";

/**
 * #893 — the running bill's CHECKs are built from retyped lists (drizzle-kit cannot load the contracts package); the
 * contracts own them. A lane that adds a source or a component to one and not the other fails here.
 */
it("the schema's charge component and source lists are the contracts'", () => {
  expect([...IPD_CHARGE_COMPONENT_VALUES]).toEqual([...IPD_CHARGE_COMPONENTS]);
  expect([...IPD_CHARGE_SOURCE_VALUES]).toEqual([...IPD_CHARGE_SOURCES]);
});
