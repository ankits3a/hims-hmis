import { eq } from "drizzle-orm";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { createRole, grantPermissionToRole, assignRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { authManifest } from "../src/kernel/auth/manifest";
import { roles, users } from "../src/kernel/db/schema";

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  await syncPermissions(db, registry);

  const username = requireEnv("ADMIN_USERNAME");
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
  if (existing.length > 0) {
    console.log(`admin "${username}" already exists — nothing to do`);
    await pool.end();
    return;
  }

  const { id } = await createUser(db, {
    username,
    fullName: requireEnv("ADMIN_FULL_NAME"),
    password: requireEnv("ADMIN_PASSWORD"),
  });
  const haveAdminRole = await db.select({ key: roles.key }).from(roles).where(eq(roles.key, "admin"));
  if (haveAdminRole.length === 0) await createRole(db, "admin", "Administrator");
  for (const permission of registry.allPermissions()) {
    await grantPermissionToRole(db, registry, "admin", permission);
  }
  await assignRole(db, { userId: id, roleKey: "admin", scopeType: "hospital" });
  await pool.end();
  console.log(`admin "${username}" created (${id}) with hospital-scope admin role`);
}
main().catch((e) => { console.error(e); process.exit(1); });
