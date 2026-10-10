import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

const MODULE = "ordering";
const count = z.number().int().nonnegative();

/**
 * The doctor's tests became orders by themselves because the fee was switched to Free (decision
 * 0065). Counts and the episode number only — what was ordered is on the orders.
 */
export const freeTestsOrdered = defineEvent("ordering.free_tests_ordered", MODULE, z.object({
  encounterNo: z.string().min(1),
  labTests: count,
  imagingTests: count,
  outsideTests: count,
  /** Departments whose order was refused (a consent test, a duplicate): the desk finishes those by hand. */
  skipped: count,
}));

/** An outside-catalogue row was added or changed by the administrator. */
export const outsideTestSaved = defineEvent("ordering.outside_test_saved", MODULE, z.object({
  serviceId: z.string().min(1),
  code: z.string().min(1),
  site: z.enum(["outside", "in_hospital"]),
  active: z.boolean(),
  created: z.boolean(),
}));

export const ORDERING_EVENTS = [freeTestsOrdered, outsideTestSaved] as const;
