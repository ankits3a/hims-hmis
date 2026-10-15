/**
 * How an appointment is read on a screen — the row's state, the book's order, what a patient still
 * has booked, the slot's clock, morning / noon / evening, the days a doctor can be booked on, and
 * how a lost answer is settled by reading — the SAME source file the web reads
 * (packages/contracts/src/appointment-book.ts; metro.config.js watches it). Nothing is copied.
 */
export * from "../../../../packages/contracts/src/appointment-book";
/** Tele-call (owner 2026-10-09): the mode and the ten-digit number rule — the server's own file, no imports. */
export * from "../../../../packages/contracts/src/tele-call";
