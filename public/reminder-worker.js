self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("Time to review your words", {
      body: "Open Webcards for your daily vocabulary review.",
      icon: "/icons/icon-192.png",
      tag: "webcards-evening-review",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const today = new URL("/today", self.location.origin).href;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const review = windows.find((client) => client.url === today);
      if (review) await review.focus();
      else await self.clients.openWindow(today);
    })(),
  );
});
