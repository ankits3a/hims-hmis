/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHASE O T4 — THE SERVICE WORKER, AND THE TWO THINGS IT IS ALLOWED TO DO
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Show a notification, and open a link when it is clicked. It caches nothing, intercepts no
 * fetch, and holds no state: this hospital's screens are online-first and an offline cache here
 * would be a second, stale copy of a worklist somebody is making decisions from.
 *
 * WHAT THE PAYLOAD MAY CONTAIN (O10, R10, GC6). A push notification renders on a LOCK SCREEN —
 * in a shared house, on a bus, on a phone somebody else is holding. So the body is the spine's
 * four words and nothing else: kind, lane, remaining minutes, a link. Never a patient, never a
 * staff member's health fact, never a rupee amount. That rule is enforced where the message is
 * BUILT (`notify/templates.ts`, with a test that hands it a patient's name and asserts the
 * body does not carry it); this file is the last reader and renders only what it is given.
 *
 * Plain JavaScript on purpose: it is served from `public/` as a static file at the SCOPE ROOT,
 * which a bundled module could not be — a service worker may only control pages at or below its
 * own path, so `/sw.js` is the only place it can live.
 */

self.addEventListener("push", (event) => {
  // A push with no data is a wake-up from the push service, not a message. Rendering "undefined"
  // on somebody's lock screen is worse than rendering nothing.
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: event.data.text() };
  }

  const title = typeof payload.title === "string" && payload.title !== "" ? payload.title : "HMIS";
  const body = typeof payload.body === "string" ? payload.body : "";
  const link = typeof payload.link === "string" ? payload.link : "/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // The tag collapses repeats of the SAME obligation into one row on the lock screen
      // instead of a stack of five. R9's budget in the one place the budget cannot reach.
      tag: typeof payload.tag === "string" ? payload.tag : undefined,
      data: { link },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // FOCUS AN OPEN TAB RATHER THAN OPENING A SIXTH. A nurse who taps four notifications in a
      // row should end up with one window on the fourth thing, not four windows.
      for (const client of clientList) {
        if ("focus" in client) {
          if ("navigate" in client) await client.navigate(link);
          return client.focus();
        }
      }
      return self.clients.openWindow(link);
    })(),
  );
});
