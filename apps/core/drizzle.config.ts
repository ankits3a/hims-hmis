import { defineConfig } from "drizzle-kit";
import { requireEnv } from "./src/kernel/config";

export default defineConfig({
  schema: "./src/kernel/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: requireEnv("DATABASE_URL") },
});
