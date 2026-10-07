/**
 * The home screen's rules are the server's — one file, read by path (packages/contracts/src/app-home.ts;
 * metro.config.js watches it). Nothing is copied: `home-rules.test.ts` fails if this grows its own.
 */
export * from "../../../../packages/contracts/src/app-home";
