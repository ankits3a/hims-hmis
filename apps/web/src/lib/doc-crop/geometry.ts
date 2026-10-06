/*
  The pure half of the document crop (corner order, the perspective map, the flat page's size, the
  pixel warp) lives in packages/contracts/src/doc-crop since 2026-10-06, so the phone's slip desk
  crops by the same arithmetic. Re-exported: every import from this path keeps working.
*/
export * from "../../../../../packages/contracts/src/doc-crop/geometry";
