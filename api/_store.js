// /api/_store.js — Redis bilan ishlash uchun umumiy yordamchilar.
//
// MUHIM MASALA: Redis'da bitta yozuv (key) hajmi cheklangan (odatda 1 MB).
// Agar barcha bildirishnoma obunalarini BITTA yozuvda saqlasak, mijozlar
// soni o'sganda o'sha chegaraga urilamiz va yangi obunalar saqlanmay
// qo'yadi (yoki eskilari o'chib ketadi).
//
// YECHIM: ro'yxatni BO'LAKLARGA (shard) bo'lib saqlaymiz:
//     push_subs_0, push_subs_1, push_subs_2, ...
// va nechta bo'lak borligini alohida yozuvda (push_subs_count) saqlaymiz.
// Shu tufayli ro'yxat AMALDA CHEKLANMAGAN bo'ladi — mijozlar soni qancha
// o'ssa, shuncha bo'lak qo'shilaveradi.

export const SHARD_SIZE = 300; // bitta bo'lakdagi yozuvlar soni (xavfsiz chegara)

export function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function kvGet(key, fallback) {
  const { url, token } = redisConfig();
  if (!url || !token) return fallback;
  try {
    const r = await fetchWithTimeout(
      `${url}/get/${key}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
      6000
    );
    if (!r.ok) return fallback;
    const data = await r.json();
    if (data.result === null || data.result === undefined) return fallback;
    return JSON.parse(data.result);
  } catch (e) {
    return fallback;
  }
}

export async function kvSet(key, value) {
  const { url, token } = redisConfig();
  if (!url || !token) return false;
  try {
    const r = await fetchWithTimeout(
      `${url}/set/${key}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
        body: JSON.stringify(value),
      },
      6000
    );
    return r.ok;
  } catch (e) {
    return false;
  }
}

/* ===== BO'LAKLARGA BO'LIB SAQLASH (cheklovsiz ro'yxat) ===== */

// Bo'laklardagi barcha yozuvlarni bitta ro'yxat qilib o'qiydi.
export async function readSharded(baseKey) {
  const count = (await kvGet(`${baseKey}_count`, 0)) || 0;
  if (!count) {
    // Eski (bo'laksiz) ma'lumot bo'lishi mumkin — uni ham o'qiymiz,
    // shunda yangilanishda hech narsa yo'qolmaydi.
    const legacy = await kvGet(baseKey, []);
    return Array.isArray(legacy) ? legacy : [];
  }
  const parts = await Promise.all(
    Array.from({ length: count }, (_, i) => kvGet(`${baseKey}_${i}`, []))
  );
  return parts.flat().filter(Boolean);
}

// Ro'yxatni bo'laklarga bo'lib yozadi. Ortiqcha eski bo'laklar tozalanadi.
export async function writeSharded(baseKey, list) {
  const arr = Array.isArray(list) ? list : [];
  const shards = [];
  for (let i = 0; i < arr.length; i += SHARD_SIZE) {
    shards.push(arr.slice(i, i + SHARD_SIZE));
  }
  if (!shards.length) shards.push([]);

  const prevCount = (await kvGet(`${baseKey}_count`, 0)) || 0;

  const writes = shards.map((chunk, i) => kvSet(`${baseKey}_${i}`, chunk));
  // Endi kerak bo'lmagan eski bo'laklarni bo'shatamiz.
  for (let i = shards.length; i < prevCount; i++) {
    writes.push(kvSet(`${baseKey}_${i}`, []));
  }
  const results = await Promise.all(writes);
  const ok = results.every(Boolean);
  if (ok) await kvSet(`${baseKey}_count`, shards.length);
  return ok;
}
