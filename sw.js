// sw.js — Omad Tour uchun Service Worker.
//
// Ikki vazifasi bor:
//   1) Saytni telefon ekraniga "ilova" sifatida o'rnatish imkonini berish.
//   2) PUSH-BILDIRISHNOMA qabul qilish — admin Telegram'da "✅ Tayyor"
//      tugmasini bosgan zahoti, mijozning telefon ekranida xabar chiqadi
//      (u saytni ochib turmagan bo'lsa ham). Bu SMS o'rnini bosadi va
//      butunlay BEPUL.
//
// Bu saytning ma'lumotlari (yangiliklar, viza holati) doim JONLI bo'lishi
// kerak, shuning uchun HECH NARSA keshlanmaydi.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Hech qanday keshlash yo'q — shunchaki oddiy tarmoq so'rovini o'tkazib yuboramiz.
  event.respondWith(fetch(event.request));
});

// ===== PUSH-BILDIRISHNOMA =====
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: "Omad Tour", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "Omad Tour";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icon-192.png",
    badge: payload.icon || "/icon-192.png",
    tag: payload.tag || "omad-visa",
    renotify: true,
    requireInteraction: false,
    data: { url: payload.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Bildirishnoma bosilganda — saytni ochadi (yoki allaqachon ochiq bo'lsa,
// o'sha oynani old planga chiqaradi).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          // Ilova allaqachon ochiq bo'lsa — uni qayta yuklamasdan, to'g'ridan-
          // to'g'ri kerakli ekranga o'tkazish uchun xabar yuboramiz (bu
          // tezroq va mijozning joriy ishini buzmaydi). Agar sayt bu
          // xabarni qabul qila olmasa, oddiy o'tish (navigate) ishlaydi.
          try {
            client.postMessage({ type: "OPEN_SCREEN", url: targetUrl });
          } catch (e) {}
          client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
