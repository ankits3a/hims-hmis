import { loadEnv } from "../../src/kernel/config";

loadEnv();
// Test-only secret defaults. Never used outside jest; real values come from the environment.
process.env.SECRET_KEY ??= "0".repeat(64);
