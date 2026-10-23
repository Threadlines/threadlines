/*
 * Threadlines phone alerts (docs/design/push-alerts.md).
 *
 * Push only, on purpose: there is no fetch handler, so this worker never
 * serves, caches or intercepts the app; every page and request still comes
 * from the network as before. It shows alerts and opens their thread.
 *
 * Alerts arrive in Declarative Web Push's shape:
 *   { "web_push": 8030, "notification": { "title", "body", "navigate" } }
 * iOS 18.4 and later shows those without this worker; everywhere else this
 * worker shows the same thing.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** `url` when it is a page of this app, else null. */
function sameOrigin(url) {
  try {
    const parsed = new URL(url, self.location.origin);
    return parsed.origin === self.location.origin ? parsed.href : null;
  } catch {
    return null;
  }
}

function readAlert(event) {
  try {
    const notification = event.data && event.data.json().notification;
    if (notification && typeof notification.title === "string") return notification;
  } catch {
    // Not JSON: show the generic alert below.
  }
  return null;
}

self.addEventListener("push", (event) => {
  const alert = readAlert(event);
  const navigate = sameOrigin(alert && alert.navigate) || self.registration.scope;
  event.waitUntil(
    self.registration.showNotification(alert ? alert.title : "Threadlines", {
      body: alert && typeof alert.body === "string" ? alert.body : "",
      // One alert per thread: a newer one replaces the last, and still buzzes.
      tag: new URL(navigate).pathname,
      renotify: true,
      data: { navigate },
    }),
  );
});

/** Asks an open window to show `url` itself (no reload); true once it says it did. */
function askToShow(client, url) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 1500);
    channel.port1.addEventListener("message", () => {
      clearTimeout(timer);
      resolve(true);
    });
    // A port listened to with addEventListener delivers only once started.
    channel.port1.start();
    client.postMessage({ type: "threadlines:navigate", url }, [channel.port2]);
  });
}

async function openAlert(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    if ("focus" in client) await client.focus();
    if (await askToShow(client, url)) return;
    if ("navigate" in client) {
      await client.navigate(url);
      return;
    }
  }
  await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = sameOrigin(data.navigate) || self.registration.scope;
  event.waitUntil(openAlert(url));
});
