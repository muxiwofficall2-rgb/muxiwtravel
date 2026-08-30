// /api/push-subscribe.js — mijozning push-bildirishnoma obunasini saqlaydi.
//
// Mijoz viza so'rovini yuborganda, brauzeri "push obunasi" (subscription)
// yaratadi — bu shunchaki manzil, hech qanday shaxsiy ma'lumot emas.
// Biz uni so'rov ID'siga bog'lab saqlaymiz, shunda keyinchalik admin
// Telegram'da "✅ Tayyor" tugmasini bosganda, aynan O'SHA mijozning
// telefoniga bildirishnoma yubora olamiz.
//
// Bu — SMS o'rnini bosadi va butunlay BEPUL (hech qanday operator yoki
// to'lov kerak emas).

const SUB_KEY = "push_subs";
const MAX_SUBS = 400;

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
  if (!data || data.result === null || data.result === undefined) return null;
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
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
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

  const { url, token } = redisConfig();
  if (!url || !token) {
    return res.status(500).json({ error: "Redis not connected" });
  }

  try {
    const { submissionId, subscription } = req.body || {};
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: "subscription required" });
    }

    const list = (await redisGet(SUB_KEY)) || [];
    // Bir xil qurilmaning takroriy obunasini almashtiramiz (yangisi ustun).
    // Qurilma "endpoint" bo'yicha aniqlanadi — shu tufayli bitta telefon
    // ro'yxatda bir marta turadi, hatto bir necha marta obuna bo'lsa ham.
    const filtered = list.filter(
      (s) => !s.subscription || s.subscription.endpoint !== subscription.endpoint
    );
    // Agar bu qurilma avval biror viza so'roviga bog'langan bo'lsa va
    // hozir umumiy (submissionId'siz) obuna kelayotgan bo'lsa — eski
    // bog'lanishni saqlab qolamiz, aks holda holat xabari yo'qolardi.
    const prev = list.find(
      (s) => s.subscription && s.subscription.endpoint === subscription.endpoint
    );
    const keptId = submissionId || (prev && prev.submissionId) || null;

    filtered.unshift({
      submissionId: keptId,
      subscription,
      created: Date.now(),
    });

    const ok = await redisSet(SUB_KEY, filtered.slice(0, MAX_SUBS));
    return res.status(200).json({ ok });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
