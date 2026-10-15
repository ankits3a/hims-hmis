/**
 * The roster's reading rules — what the clock means for the take, how a duty is named, which
 * requests are mine to answer — are the SAME source file the web board and web My duties read
 * (packages/contracts/src/roster-board.ts; metro.config.js watches it). Nothing is copied.
 */
export * from "../../../../packages/contracts/src/roster-board";
