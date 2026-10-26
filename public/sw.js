// Service worker do nishiADS: só Web Push (sem cache offline, para nunca servir versão velha).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const supportsActions = typeof Notification !== "undefined" && "maxActions" in Notification;

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "nishiADS", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "nishiADS";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.tag,
      silent: Boolean(data.silent),
      // Botões (Chrome, Edge, Android; o Safari não tem). "Pausar" abre o alerta já com a confirmação.
      ...(supportsActions && Array.isArray(data.actions) ? { actions: data.actions.slice(0, 2) } : {}),
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin);
  if (event.action === "pause") url.searchParams.set("acao", "pausar");
  const target = url.href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
