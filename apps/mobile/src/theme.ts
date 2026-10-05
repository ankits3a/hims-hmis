/**
 * The HMIS "paper & pine" palette, ported 1:1 from apps/web/src/styles/paper-pine.css — the file
 * the web login, Desk One and the dashboard all read. `theme.test.ts` re-reads that CSS and fails
 * when a value here drifts from it, so the app and the web counter stay one product.
 */
export const color = {
  paper: "#f4f7f4",
  card: "#ffffff",
  ink: "#132420",
  line: "#dfe7e1",
  line2: "#ecf1ed",
  dim: "#5c6f66",
  faint: "#8ea69a",
  wash: "#eef3ef",
  green: "#0e6b4e",
  greenSoft: "rgba(14, 107, 78, .08)",
  greenLine: "rgba(14, 107, 78, .35)",
  gold: "#dd8f1c",
  goldSoft: "rgba(221, 143, 28, .10)",
  goldLine: "rgba(221, 143, 28, .45)",
  red: "#b23a30",
  redSoft: "rgba(178, 58, 48, .08)",
  redLine: "rgba(178, 58, 48, .4)",
  agent: "#132420",
  agentFg: "#d9efe4",
  agentDim: "#7fa392",
  mint: "#35c48f",
} as const;

/** CSS custom-property name for each token, for the parity test. */
export const cssName: Record<keyof typeof color, string> = {
  paper: "--paper", card: "--card", ink: "--ink", line: "--line", line2: "--line2", dim: "--dim",
  faint: "--faint", wash: "--wash", green: "--green", greenSoft: "--green-soft", greenLine: "--green-line",
  gold: "--gold", goldSoft: "--gold-soft", goldLine: "--gold-line", red: "--red", redSoft: "--red-soft",
  redLine: "--red-line", agent: "--agent", agentFg: "--agent-fg", agentDim: "--agent-dim", mint: "--mint",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14 } as const;

/** Type scale. Body never below 15 on a phone; labels are the web's mono tag style. */
export const type = {
  title: { fontSize: 26, fontWeight: "700" as const, letterSpacing: -0.5 },
  heading: { fontSize: 18, fontWeight: "700" as const },
  body: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 19 },
  tag: { fontSize: 11, fontWeight: "700" as const, letterSpacing: 1.1, textTransform: "uppercase" as const },
} as const;

/** Minimum touch target (Android guidance is 48dp). */
export const TOUCH = 48;
