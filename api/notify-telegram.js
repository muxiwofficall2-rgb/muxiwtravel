// /api/notify-telegram.js — sends the visa-check photo directly to the admin's
// Telegram chat as file bytes (multipart), instead of by URL.
//
// WHY BYTES, NOT A URL: the previous version asked Telegram to fetch the
// photo by its freshly-created imgbb URL. Telegram's servers occasionally
// tried to fetch that URL before it had fully propagated across imgbb's
// CDN, and sendPhoto would then fail silently — the very first submission
// of a session could vanish with no error and no retry. Sending the actual
// bytes removes that dependency entirely: nothing outside our own servers
// needs to "catch up" before the photo can be delivered.
//
// SECURITY: the bot token and chat id are read from environment variables
// (set in Vercel -> Project Settings -> Environment Variables) and never
// appear in this file or anywhere the browser can see. This matters:
// tokens hardcoded in source files that get pushed to a public GitHub repo
// are routinely scraped by bots within minutes and hijacked to send spam —
// that is almost certainly what happened to the previous token. Reading it
// from an environment variable at request time means it is never present
// in the repository, the deployed frontend, or the page source at all.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "8mb",
    },
  },
};
// Only takes effect on plans that support extended function duration; on
// plans that don't, Vercel simply caps it — this line is never harmful.
export const maxDuration = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function base64ToBlob(dataUrl) {
  const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  const buffer = Buffer.from(base64, "base64");
  return new Blob([buffer], { type: "image/jpeg" });
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

async function tgSendPhoto(blob, caption, submissionId) {
  const form = new FormData();
  form.append("chat_id", ADMIN_CHAT_ID);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  if (submissionId) {
    form.append(
      "reply_markup",
      JSON.stringify({
        inline_keyboard: [
          [
            { text: "✅ Tayyor", callback_data: `status:${submissionId}:ready` },
            { text: "⏳ Hali tayyor emas", callback_data: `status:${submissionId}:pending` },
          ],
        ],
      })
    );
  }
  form.append("photo", blob, "hujjat.jpg");

  const r = await fetchWithTimeout(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,
    { method: "POST", body: form },
    9000
  );
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || data.ok !== true) {
    throw new Error((data && data.description) || `HTTP ${r.status}`);
  }
  return data;
}

async function tgSendMessage(text, parseMode) {
  const payload = { chat_id: ADMIN_CHAT_ID, text };
  if (parseMode) payload.parse_mode = parseMode;
  const r = await fetchWithTimeout(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    7000
  );
  const data = await r.json().catch(() => null);
  return !!(r.ok && data && data.ok);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    // Fails safe: if the environment variables haven't been set in Vercel
    // yet, we say so clearly instead of silently doing nothing.
    return res.status(200).json({
      ok: false,
      error: "TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID Vercel muhit o'zgaruvchilarida sozlanmagan.",
    });
  }

  try {
    const { imageBase64, phone, submissionId, barcode } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

    const caption = `Viza tekshiruvi so'rovi.\nTelefon: ${escapeHtml(phone) || "—"}`;
    const blob = base64ToBlob(imageBase64);

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await tgSendPhoto(blob, caption, submissionId);

        // OCR orqali (mijoz telefonida, bepul) avtomatik o'qilgan barkod —
        // rasm TAGIDA, ALOHIDA xabar qilib yuboriladi, Telegram'ning <code>
        // formatida — admin ustiga BIR MARTA teginsa, avtomatik nusxalanadi
        // (qo'lda belgilashga hojat yo'q). Bu — best effort: agar bu
        // qo'shimcha xabar ketmay qolsa ham, asosiy rasm va so'rov
        // allaqachon saqlangan/yetkazilgan bo'ladi, hech narsa yo'qolmaydi.
        if (barcode) {
          const msg = `📋 <b>Ariza raqami (barkod):</b>\n<code>${escapeHtml(barcode)}</code>`;
          tgSendMessage(msg, "HTML").catch(() => {});
        }

        return res.status(200).json({ ok: true, method: "photo" });
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await sleep(500);
      }
    }

    // Photo delivery failed twice in a row (extremely rare once we're sending
    // bytes directly) — still make sure the admin gets *something*.
    const fallbackText =
      `Viza tekshiruvi so'rovi.\nTelefon: ${phone || "—"}` +
      (barcode ? `\nAriza raqami (barkod): ${barcode}` : "") +
      `\n\n⚠️ Rasm avtomatik yuborilmadi (${String(lastErr && lastErr.message || lastErr)}). ` +
      `Iltimos, admin panelda ko'ring.`;
    const sent = await tgSendMessage(fallbackText).catch(() => false);
    return res.status(200).json({ ok: sent, method: sent ? "text-fallback" : "failed" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
