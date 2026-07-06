/**
 * Azul — Service Worker
 * Handles push notifications when the app is in the background or closed.
 */

const CACHE_NAME = 'azul-v1';

// ── Push event ─────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Azul', body: event.data?.text() || 'You have a new notification' };
  }

  const title   = data.title || 'Azul';
  const options = {
    body:    data.body    || "It's your turn!",
    icon:    data.icon    || '/icon-192.png',
    badge:   data.badge   || '/badge-72.png',
    tag:     data.tag     || 'azul',
    data:    data.data    || {},
    vibrate: [200, 100, 200],
    requireInteraction: false,
    actions: [
      { action: 'open', title: 'Open Game' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click ─────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus existing tab if open
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new tab
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── Install & activate ─────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});
