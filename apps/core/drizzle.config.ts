import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/kernel/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_dev" },
});
