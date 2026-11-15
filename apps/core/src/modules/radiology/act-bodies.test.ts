import {
  IMAGING_BEDSIDE_LOCATION_MAX_LENGTH, IMAGING_CONTRAST_ROUTES, IMAGING_CRITICAL_TIERS, IMAGING_HANDOVER_COLLECTOR_KINDS,
  IMAGING_HANDOVER_ID_TYPES, IMAGING_IMAGE_SOURCES, IMAGING_LATERALITIES_REPORTED, imagingScheduleBody,
} from "@hmis/contracts";
import {
  CONTRAST_ROUTES, IMAGE_SOURCES, IMAGING_COLLECTOR_ID_TYPES, IMAGING_COLLECTOR_KINDS, IMAGING_CRITICAL_CATEGORIES,
  IMAGING_LATERALITIES,
} from "../../kernel/db/schema/radiology";
import { BEDSIDE_LOCATION_MAX_LENGTH } from "./kinds";

/**
 * #1077 — the act bodies live in `@hmis/contracts` (`packages/contracts/src/radiology.ts`), which cannot
 * import the server. The vocabularies they name are copies of the server's, whose originals the CHECK
 * constraints use; this holds each copy equal to its original, so the wire and the table cannot drift.
 */
describe("the imaging act bodies' vocabularies are the server's (#1077)", () => {
  it("contrast routes, image sources, reported sides, critical tiers, collectors and ID types match the schema", () => {
    expect([...IMAGING_CONTRAST_ROUTES]).toEqual([...CONTRAST_ROUTES]);
    expect([...IMAGING_IMAGE_SOURCES]).toEqual([...IMAGE_SOURCES]);
    expect([...IMAGING_LATERALITIES_REPORTED]).toEqual([...IMAGING_LATERALITIES]);
    expect([...IMAGING_CRITICAL_TIERS]).toEqual([...IMAGING_CRITICAL_CATEGORIES]);
    expect([...IMAGING_HANDOVER_COLLECTOR_KINDS]).toEqual([...IMAGING_COLLECTOR_KINDS]);
    expect([...IMAGING_HANDOVER_ID_TYPES]).toEqual([...IMAGING_COLLECTOR_ID_TYPES]);
  });

  it("the bedside place's bound is the module's", () => {
    expect(IMAGING_BEDSIDE_LOCATION_MAX_LENGTH).toBe(BEDSIDE_LOCATION_MAX_LENGTH);
    const at = "2026-03-10T04:00:00.000Z";
    expect(imagingScheduleBody.safeParse({ deviceResourceId: "D1", scheduledAt: at, bedsideLocation: "x".repeat(BEDSIDE_LOCATION_MAX_LENGTH) }).success).toBe(true);
    expect(imagingScheduleBody.safeParse({ deviceResourceId: "D1", scheduledAt: at, bedsideLocation: "x".repeat(BEDSIDE_LOCATION_MAX_LENGTH + 1) }).success).toBe(false);
  });
});
