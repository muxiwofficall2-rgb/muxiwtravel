// sw.js — Omad Tour uchun eng minimal Service Worker.
//
// Bu saytning deyarli barcha ma'lumotlari (narxlar, yangiliklar, viza
// holati, valyuta kurslari) doim JONLI va yangi bo'lishi kerak, shuning
// uchun bu Service Worker HECH NARSANI keshlamaydi — u faqat brauzerlarga
// "bu sayt ilova sifatida o'rnatilishi mumkin" ekanini bildirish uchun
// mavjud (buni talab qiladigan ba'zi brauzerlar uchun). Barcha so'rovlar
// har doim to'g'ridan-to'g'ri tarmoqdan olinadi.

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
