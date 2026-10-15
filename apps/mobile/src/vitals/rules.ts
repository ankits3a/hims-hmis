/**
 * The vitals desk's reading rules — the SAME source file the web bay reads
 * (packages/contracts/src/vitals-entry.ts; metro.config.js watches it). Nothing is copied: a rule
 * changed for the counter PC changes on the phone in the same commit.
 */
export * from "../../../../packages/contracts/src/vitals-entry";
