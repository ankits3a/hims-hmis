import { z } from "zod";

/**
 * WASA M-01 — NO STRING IS EVER EVALUATED AS CODE, because the CSP's `script-src 'self'` carries no
 * 'unsafe-eval'. zod v4 otherwise compiles each object schema's fast path with `new Function(...)`,
 * deciding when the schema is BUILT, so this must run before any module that builds one: it is
 * `main.tsx`'s first import (pinned by `zod-jitless.test.ts`). The interpreted path is what zod already
 * falls back to wherever eval is refused; the forms and payloads here are far too small to notice.
 */
z.config({ jitless: true });
