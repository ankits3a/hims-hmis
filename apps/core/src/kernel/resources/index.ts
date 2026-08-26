/**
 * PLAN 13 — the resource registry's public surface (spec §4: a module is reached through its
 * index, never by deep-importing its files).
 *
 * T2 exports the seam — kinds, the manifest, the events and the errors. T3 adds the write surface
 * and T4 the read surface; both are named in their own Files lists as modifications to THIS file,
 * so the export list grows exactly three times and in a known order.
 */
export * from "./kinds";
export * from "./errors";
export * from "./events";
export * from "./manifest";
export { ResourcesModule } from "./resources.module";
