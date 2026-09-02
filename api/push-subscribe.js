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

import { readSharded, writeSharded, redisConfig } from "./_store.js";

const SUB_KEY = "push_subs";

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

    const list = await readSharded(SUB_KEY);
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

    // CHEKLOV YO'Q: ro'yxat bo'laklarga bo'lib saqlanadi, shuning uchun
    // mijozlar soni qancha o'ssa ham hech bir obuna o'chib ketmaydi.
    const ok = await writeSharded(SUB_KEY, filtered);
    return res.status(200).json({ ok });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
