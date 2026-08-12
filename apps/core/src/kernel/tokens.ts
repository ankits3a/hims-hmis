// DI tokens live here, not in app.module.ts: AppModule imports the controllers and
// guards that inject these tokens, so token-in-app-module is a circular import that
// CJS resolves to `undefined` at decorator time. This module imports nothing.
export const DB = Symbol("DB");
export const DB_POOL = Symbol("DB_POOL");
export const CONFIG = Symbol("CONFIG");
