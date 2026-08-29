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

/* Bir necha anketa (oila a'zolari) birga yuborilganda, har bir xabar
   tepasida "Oilaviy blanka N / M" deb ko'rsatiladi — shunda admin qaysi
   biri kimga tegishli ekanini adashtirmaydi. Bitta anketa bo'lsa —
   hech qanday qo'shimcha sarlavha chiqmaydi. */
function groupTitle(index, total) {
  const n = parseInt(index, 10);
  const t = parseInt(total, 10);
  if (!t || t < 2 || !n) return "";
  return `👨‍👩‍👧 <b>Oilaviy blanka ${n} / ${t}</b>\n\n`;
}

async function tgSendMessage(text, parseMode, submissionId) {
  const payload = { chat_id: ADMIN_CHAT_ID, text };
  if (parseMode) payload.parse_mode = parseMode;
  // Agar so'rov ID berilgan bo'lsa — holat tugmalarini ("✅ Tayyor" /
  // "⏳ Hali tayyor emas") shu xabarga biriktiramiz. Bu, ayniqsa, rasm
  // keyinroq keladigan tezkor rejimda muhim: admin javobni rasmni
  // kutmasdan, darhol belgilay oladi.
  if (submissionId) {
    payload.reply_markup = {
      inline_keyboard: [
        [
          { text: "✅ Tayyor", callback_data: `status:${submissionId}:ready` },
          { text: "⏳ Hali tayyor emas", callback_data: `status:${submissionId}:pending` },
        ],
      ],
    };
  }
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
    const { imageBase64, phone, submissionId, barcode, pendingPhoto, photoOnly,
            groupIndex, groupTotal } = req.body || {};

    // ===== REJIM 1: "Rasm keyinroq" xabari =====
    // Mijozning interneti sekin bo'lsa, rasm hali yuklanayotgan bo'ladi.
    // Mijozni kuttirmaslik uchun adminga ENG MUHIM ma'lumot (telefon +
    // barkod) DARHOL, holat tugmalari bilan yuboriladi. Rasm esa fonda
    // tayyor bo'lgach, alohida yetkaziladi (REJIM 2).
    if (pendingPhoto) {
      const lines = [
        groupTitle(groupIndex, groupTotal) + `📥 <b>Yangi viza so'rovi</b>`,
        `📞 Telefon: <code>${escapeHtml(phone) || "—"}</code>`
      ];
      if (barcode) lines.push(`📋 Ariza raqami (barkod):\n<code>${escapeHtml(barcode)}</code>`);
      lines.push(`\n🖼 <i>Rasm yuklanmoqda — bir necha soniyada keladi.</i>`);
      const ok = await tgSendMessage(lines.join("\n"), "HTML", submissionId).catch(() => false);
      return res.status(200).json({ ok, method: "pending-text" });
    }

    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

    // ===== REJIM 2: faqat rasm (matni allaqachon yuborilgan) =====
    if (photoOnly) {
      const blobOnly = base64ToBlob(imageBase64);
      const capOnly = groupTitle(groupIndex, groupTotal) +
        `🖼 So'rov #${submissionId || "—"} uchun hujjat rasmi.`;
      try {
        // Tugmalar allaqachon oldingi (matnli) xabarda yuborilgan, shuning
        // uchun bu yerda ularni takrorlamaymiz.
        await tgSendPhoto(blobOnly, capOnly, null);
        return res.status(200).json({ ok: true, method: "photo-only" });
      } catch (e) {
        const sent = await tgSendMessage(
          `⚠️ So'rov #${submissionId || "—"} uchun rasm yuborilmadi (${String(e && e.message || e)}). Admin panelda ko'ring.`
        ).catch(() => false);
        return res.status(200).json({ ok: sent, method: "photo-only-failed" });
      }
    }

    // ===== REJIM 3 (odatiy): rasm + matn birga =====
    // Barkod rasmning O'Z tagiga (caption ichiga) yoziladi — u yerdagi
    // raqamni Telegram'da bosib turib nusxalash mumkin, shuning uchun
    // alohida takroriy xabar YUBORILMAYDI (u ortiqcha edi).
    // Agar mijoz bir necha anketa (oila a'zolari) yuborgan bo'lsa, har
    // birining tepasida "Oilaviy blanka N" deb ko'rsatiladi — shunda admin
    // qaysi biri kimga tegishli ekanini adashtirmaydi.
    const caption = groupTitle(groupIndex, groupTotal) +
      `Viza tekshiruvi so'rovi.\nTelefon: ${escapeHtml(phone) || "—"}` +
      (barcode ? `\nAriza raqami (barkod): ${escapeHtml(barcode)}` : "");
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
