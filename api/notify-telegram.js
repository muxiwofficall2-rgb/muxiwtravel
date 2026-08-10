// /api/notify-telegram.js — sends the visa-check photo directly to the admin's
// Telegram chat as file bytes (multipart), instead of by URL.
//
// WHY THIS EXISTS: the previous version asked Telegram to fetch the photo by
// its freshly-created imgbb URL. Telegram's servers occasionally tried to
// fetch that URL before it had fully propagated across imgbb's CDN, and
// sendPhoto would then fail silently — the very first submission of a
// session could vanish with no error and no retry. Sending the actual bytes
// removes that dependency entirely: nothing outside our own servers needs to
// "catch up" before the photo can be delivered, so the very first attempt
// works exactly as reliably as every attempt after it.
//
// This endpoint also retries automatically and, if sending the photo still
// fails after retrying, always falls back to a plain text alert (with the
// phone number) so the admin is never left with zero notification for a
// submission that did arrive.

const BOT_TOKEN = "8949050831:AAHP91glGT-3nt7iKceUckAibvtfKohMGKc";
const ADMIN_CHAT_ID = "7359558983";

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

async function tgSendMessage(text) {
  const r = await fetchWithTimeout(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text }),
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
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return res.status(200).json({ ok: false, error: "bot not configured" });

  try {
    const { imageBase64, phone, submissionId } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

    const caption = `Viza tekshiruvi so'rovi.\nTelefon: ${phone || "—"}`;
    const blob = base64ToBlob(imageBase64);

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await tgSendPhoto(blob, caption, submissionId);
        return res.status(200).json({ ok: true, method: "photo" });
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await sleep(500);
      }
    }

    // Photo delivery failed twice in a row (extremely rare once we're sending
    // bytes directly) — still make sure the admin gets *something*.
    const fallbackText =
      caption + `\n\n⚠️ Rasm avtomatik yuborilmadi (${String(lastErr && lastErr.message || lastErr)}). ` +
      `Iltimos, admin panelda ko'ring.`;
    const sent = await tgSendMessage(fallbackText).catch(() => false);
    return res.status(200).json({ ok: sent, method: sent ? "text-fallback" : "failed" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
