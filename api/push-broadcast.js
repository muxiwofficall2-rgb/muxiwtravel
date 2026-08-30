// /api/push-broadcast.js — YANGI E'LON chiqqanda barcha obunachilarga
// bildirishnoma yuboradi.
//
// Admin panelda yangilik qo'shilgan zahoti chaqiriladi. Bildirishnoma
// mijozning telefon ekranida SMS kabi chiqadi — sayt ochiq bo'lmasa ham.
// Butunlay bepul (hech qanday operator yoki to'lov kerak emas).
//
// Kerakli muhit o'zgaruvchilari (Vercel -> Settings -> Environment Variables):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, ADMIN_PASSWORD
// Ular sozlanmagan bo'lsa — funksiya jim o'tadi, hech narsa buzilmaydi.

const SUB_KEY = "push_subs";

/* VAPID kalitlarini muhit o'zgaruvchisidan xavfsiz o'qish.
   Vercel formasiga nusxalaganda oxiriga ko'rinmas bo'shliq, yangi qator
   yoki qo'shtirnoq qo'shilib qolishi juda tez-tez uchraydi — bu esa
   "Vapid public key must be a URL safe Base 64" xatosiga olib keladi.
   Shuning uchun kalitni ishlatishdan oldin har doim tozalaymiz. */
function cleanVapidKey(raw) {
  if (!raw) return "";
  return String(raw)
    .trim()
    .replace(/^["']|["']$/g, "")   // tasodifan qo'shilgan qo'shtirnoqlar
    .replace(/\s+/g, "")           // bo'shliq / yangi qator
    .replace(/=+$/, "")            // oxiridagi "=" (base64 to'ldiruvchisi)
    .replace(/\+/g, "-")           // standart base64 -> URL-safe
    .replace(/\//g, "_");
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

async function redisGet(key) {
  const { url, token } = redisConfig();
  const r = await fetch(`${url}/get/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const data = await r.json().catch(() => null);
  if (!data || !data.result) return null;
  try {
    return JSON.parse(data.result);
  } catch (e) {
    return null;
  }
}

async function redisSet(key, value) {
  const { url, token } = redisConfig();
  const r = await fetch(`${url}/set/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  return r.ok;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const pub = cleanVapidKey(process.env.VAPID_PUBLIC_KEY);
  const priv = cleanVapidKey(process.env.VAPID_PRIVATE_KEY);
  if (!pub || !priv) {
    return res.status(200).json({ ok: false, reason: "VAPID keys not configured" });
  }

  const { url, token } = redisConfig();
  if (!url || !token) {
    return res.status(500).json({ ok: false, error: "Redis not connected" });
  }

  try {
    const { title, body, password } = req.body || {};

    // Oddiy himoya: faqat admin paroli bilan yuborish mumkin, aks holda
    // istalgan odam hamma mijozlarga xabar yuborishi mumkin bo'lardi.
    const expected = process.env.ADMIN_PASSWORD;
    if (expected && password !== expected) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const subs = (await redisGet(SUB_KEY)) || [];
    if (!subs.length) return res.status(200).json({ ok: true, sent: 0, total: 0 });

    let webpush;
    try {
      webpush = (await import("web-push")).default;
    } catch (e) {
      return res.status(200).json({ ok: false, reason: "web-push not installed" });
    }
    webpush.setVapidDetails("mailto:omadru@bk.ru", pub, priv);

    const payload = JSON.stringify({
      title: title || "Omad Tour — yangi e'lon",
      body: body || "Yangi xabar bor. Ko'rish uchun bosing.",
      url: "/",
      tag: "omad-news",
    });

    let sent = 0;
    const dead = new Set();
    // Bir vaqtda hammasiga yuboramiz — tez bo'lishi uchun.
    await Promise.all(
      subs.map(async (s) => {
        if (!s || !s.subscription) return;
        try {
          await webpush.sendNotification(s.subscription, payload);
          sent++;
        } catch (e) {
          // 404/410 — obuna eskirgan (mijoz ilovani o'chirgan yoki
          // ruxsatni bekor qilgan). Ularni ro'yxatdan tozalaymiz.
          if (e && (e.statusCode === 404 || e.statusCode === 410)) {
            dead.add(s.subscription.endpoint);
          }
        }
      })
    );

    if (dead.size) {
      const cleaned = subs.filter((s) => s.subscription && !dead.has(s.subscription.endpoint));
      await redisSet(SUB_KEY, cleaned);
    }

    return res.status(200).json({ ok: true, sent, total: subs.length, removed: dead.size });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
