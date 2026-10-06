/**
 * The slip desk's rules and the document crop's arithmetic — the SAME source files the web desk
 * reads (packages/contracts/src; metro.config.js watches the folder). Nothing is copied.
 */
export * from "../../../../packages/contracts/src/slip-desk";
export * from "../../../../packages/contracts/src/doc-crop/geometry";
export { DETECT_EDGE, detectDocument } from "../../../../packages/contracts/src/doc-crop/detect";
export type { Detection } from "../../../../packages/contracts/src/doc-crop/detect";
