// /api/telegram-webhook.js — receives updates from Telegram when the admin
// taps the "Tayyor" / "Hali tayyor emas" inline buttons under a visa-check
// notification message, and updates that request's status in Upstash Redis
// (connected via Vercel Storage — same database used by /api/kv.js).
//
// ---------------------------------------------------------------------
// SELF-DIAGNOSTIC: open this URL directly in any browser (a plain GET,
// which Telegram itself never sends — it only ever POSTs here) to check,
// in one glance, whether the server-side configuration is actually wired
// up correctly in the CURRENTLY DEPLOYED version:
//
//   https://YOUR_DOMAIN/api/telegram-webhook
//
// It reports true/false for each required setting (never the actual
// secret values) plus whether it can reach Telegram and Redis right now.
// This exists specifically so a broken button can be diagnosed in one
// step instead of guessing — if any of these say false, that is the bug.
// ---------------------------------------------------------------------
//
// IMPORTANT UX NOTE: Telegram shows a spinning "loading" state on a tapped
// button until OUR server calls answerCallbackQuery — and ONLY until that
// specific call completes. If that call never happens (wrong token, wrong
// secret, function crashed before reaching it, etc.), Telegram's client
// clears the spinner on its own after its own internal timeout, with no
// visible error — which looks exactly like "it just stops loading and
// nothing happened." That is why this file now also logs a clear reason
// to Vercel's function logs every time it can't complete the flow, and
// why the diagnostic endpoint above exists — so that failure mode is no
// longer silent.
//
// We call (and await) answerCallbackQuery FIRST, before doing any
// database work, so the button reacts immediately. We do NOT send our own
// HTTP response back to Telegram early and keep working "in the
// background" afterward — Vercel's serverless platform only guarantees
// execution continues until the handler function itself finishes
// (returns), not merely until res.end() is called, so ending the response
// early and continuing afterward is not reliable. Everything therefore
// happens in one continuous sequence, and res.end() is only ever called
// once, at the very end, after the database update has actually finished.
//
// SECURITY:
// 1. The bot token is read from the TELEGRAM_BOT_TOKEN environment variable
//    (never hardcoded) — a token committed to a public repo gets scraped
//    and hijacked within minutes, which is what happened to the original
//    token before this was set up.
// 2. This URL is public on the internet (Telegram must be able to reach
//    it), so anyone who finds it could otherwise POST fake button-press
//    payloads and silently flip the status of any visa request. Telegram
//    lets you attach a "secret token" when you register the webhook, and
//    then includes that same secret in a header on every real request —
//    we reject anything that doesn't match. Whitespace around the value
//    is trimmed before comparing, since that is an easy mistake to make
//    when copy-pasting a value into a form on a phone.
//
// ---------------------------------------------------------------------
// ONE-TIME SETUP (only ever needs to be done once, or again if you rotate
// the secret). Replace YOUR_DOMAIN and YOUR_SECRET, then open this URL
// once in any browser:
//
//   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/telegram-webhook&secret_token=YOUR_SECRET
//
// Telegram will reply {"ok":true,"result":true,...} if it worked.
// (YOUR_SECRET must be the exact same value as the TELEGRAM_WEBHOOK_SECRET
// environment variable in Vercel — check the diagnostic endpoint above if
// unsure whether it's set at all.)
// ---------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET
  ? process.env.TELEGRAM_WEBHOOK_SECRET.trim()
  : "";

export const maxDuration = 20;

function redisConfig() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function tg(method, payload) {
  if (!BOT_TOKEN) {
    console.error("[telegram-webhook] TELEGRAM_BOT_TOKEN is not set — cannot call", method);
    return null;
  }
  try {
    const r = await fetchWithTimeout(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      6000
    );
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || data.ok !== true) {
      console.error(
        `[telegram-webhook] Telegram ${method} failed:`,
        r.status,
        data && data.description
      );
    }
    return data;
  } catch (e) {
    console.error(`[telegram-webhook] Telegram ${method} threw:`, e && e.message);
    return null;
  }
}

async function fetchVisaList() {
  const { url, token } = redisConfig();
  if (!url || !token) {
    console.error("[telegram-webhook] Redis env vars missing (KV_REST_API_URL / KV_REST_API_TOKEN)");
    return [];
  }
  const r = await fetchWithTimeout(
    `${url}/get/visa_submissions`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
    6000
  );
  if (!r.ok) {
    console.error("[telegram-webhook] Redis GET failed:", r.status);
    return [];
  }
  const data = await r.json();
  if (!data.result) return [];
  try {
    return JSON.parse(data.result);
  } catch (e) {
    console.error("[telegram-webhook] Redis GET returned unparseable JSON");
    return [];
  }
}

async function saveVisaList(list) {
  const { url, token } = redisConfig();
  if (!url || !token) return false;
  const r = await fetchWithTimeout(
    `${url}/set/visa_submissions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: JSON.stringify(list),
    },
    6000
  );
  if (!r.ok) {
    console.error("[telegram-webhook] Redis SET failed:", r.status);
  }
  return r.ok;
}

/* ===== MIJOZGA PUSH-BILDIRISHNOMA YUBORISH =====
   Admin "✅ Tayyor" tugmasini bosgan zahoti, mijozning telefon ekranida
   xabar chiqadi — u saytni ochib turmagan bo'lsa ham. SMS o'rnini bosadi,
   butunlay bepul (hech qanday operator yoki to'lov kerak emas).

   Ishlashi uchun Vercel'da 2 ta muhit o'zgaruvchisi bo'lishi kerak:
   VAPID_PUBLIC_KEY va VAPID_PRIVATE_KEY. Agar ular sozlanmagan bo'lsa,
   bu funksiya shunchaki jim o'tadi — qolgan hamma narsa avvalgidek
   ishlayveradi, hech narsa buzilmaydi. */
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function fetchPushSubs() {
  const { url, token } = redisConfig();
  if (!url || !token) return [];
  try {
    const r = await fetchWithTimeout(`${url}/get/push_subs`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }, 6000);
    const data = await r.json().catch(() => null);
    if (!data || !data.result) return [];
    return JSON.parse(data.result) || [];
  } catch (e) {
    return [];
  }
}

async function savePushSubs(list) {
  const { url, token } = redisConfig();
  if (!url || !token) return false;
  try {
    const r = await fetchWithTimeout(
      `${url}/set/push_subs`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
        body: JSON.stringify(list),
      },
      6000
    );
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function sendPushToClient(submissionId, status) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return; // Sozlanmagan — jim o'tamiz.

  const subs = await fetchPushSubs();
  const entry = subs.find((s) => s.submissionId === submissionId);
  if (!entry || !entry.subscription) return;

  let webpush;
  try {
    webpush = (await import("web-push")).default;
  } catch (e) {
    console.warn("[telegram-webhook] web-push kutubxonasi topilmadi");
    return;
  }

  webpush.setVapidDetails("mailto:omadru@bk.ru", pub, priv);

  const payload =
    status === "ready"
      ? {
          title: "✅ Vizangiz tayyor!",
          body: "Anketangiz bo'yicha natija tayyor. Batafsil ko'rish uchun bosing.",
          url: "/",
          tag: "omad-visa-" + submissionId,
        }
      : {
          title: "⏳ So'rovingiz ko'rib chiqilmoqda",
          body: "Anketangiz hali tekshirilmoqda. Tayyor bo'lgach xabar beramiz.",
          url: "/",
          tag: "omad-visa-" + submissionId,
        };

  try {
    await webpush.sendNotification(entry.subscription, JSON.stringify(payload));
    console.log("[telegram-webhook] push sent for submission", submissionId);
  } catch (e) {
    console.warn("[telegram-webhook] push send error:", e && e.statusCode, e && e.body);
  }
}

// GET /api/telegram-webhook — human-facing diagnostic, see comment block above.
async function handleDiagnostic(req, res) {
  const { url: redisUrl, token: redisToken } = redisConfig();
  const report = {
    status: "diagnostic",
    note: "Bu GET so'rovga javob — Telegram bu yerga hech qachon GET yubormaydi, faqat POST. Bu faqat siz uchun tekshiruv sahifasi.",
    TELEGRAM_BOT_TOKEN_configured: !!BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET_configured: !!WEBHOOK_SECRET,
    redis_configured: !!(redisUrl && redisToken),
  };

  if (BOT_TOKEN) {
    const me = await tg("getMe", {});
    report.telegram_bot_reachable = !!(me && me.ok);
    report.telegram_bot_username = me && me.result && me.result.username;
  } else {
    report.telegram_bot_reachable = false;
  }

  if (redisUrl && redisToken) {
    try {
      const list = await fetchVisaList();
      report.redis_reachable = true;
      report.visa_submissions_count = list.length;
    } catch (e) {
      report.redis_reachable = false;
    }
  } else {
    report.redis_reachable = false;
  }

  report.all_ok =
    report.TELEGRAM_BOT_TOKEN_configured &&
    report.TELEGRAM_WEBHOOK_SECRET_configured &&
    report.redis_configured &&
    report.telegram_bot_reachable &&
    report.redis_reachable;

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json(report);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return handleDiagnostic(req, res);
  }
  if (req.method !== "POST") {
    return res.status(200).end();
  }

  if (WEBHOOK_SECRET) {
    const incoming = (req.headers["x-telegram-bot-api-secret-token"] || "").trim();
    // Compared case-insensitively on purpose: iOS (and some other mobile
    // keyboards) auto-capitalize the first letter typed into a plain text
    // field by default, which is exactly what happened when the secret was
    // entered into Vercel's Environment Variables form on a phone — the
    // value silently became "Omadspb" instead of "omadspb" while the copy
    // used to register the webhook with Telegram stayed lowercase, and an
    // exact-case match then rejected every single real request from
    // Telegram with a 401, which is what the "Tayyor" button hanging
    // forever traced back to. A secret's job here is just to stop a
    // random guesser from finding this URL and forging status updates;
    // case doesn't meaningfully add to that for a word-based secret like
    // this, so comparing case-insensitively removes an entire class of
    // this kind of mobile-input friction for free.
    if (incoming.toLowerCase() !== WEBHOOK_SECRET.toLowerCase()) {
      console.error(
        "[telegram-webhook] Secret mismatch — got header of length",
        incoming.length,
        "expected length",
        WEBHOOK_SECRET.length
      );
      return res.status(401).end();
    }
  } else {
    console.error("[telegram-webhook] WARNING: TELEGRAM_WEBHOOK_SECRET is not set — accepting request unverified.");
  }

  const update = req.body;
  const cq = update && update.callback_query;
  const msg = update && update.message;

  /* ===== BOT BUYRUQLARI =====
     Admin Telegram'dan turib butun oqimni boshqara oladi:
       /tayyor      — tayyor bo'lgan so'rovlar ro'yxati
       /kutilmoqda  — hali javob berilmagan so'rovlar ro'yxati
       /tozalash    — FAQAT tayyor bo'lganlarni hamma joydan o'chirish
     "Kutilmoqda" ro'yxatida tayyorlar KO'RINMAYDI — ular avtomatik
     chiqib ketadi, shu tufayli ro'yxat doim faqat qolgan ishni ko'rsatadi. */
  if (msg && typeof msg.text === "string" && msg.text.startsWith("/")) {
    const cmd = msg.text.trim().toLowerCase().split(/[\s@]/)[0];
    const chatId = msg.chat && msg.chat.id;

    if (cmd === "/tayyor" || cmd === "/kutilmoqda" || cmd === "/tozalash" || cmd === "/holat" || cmd === "/start") {
      try {
        const list = await fetchVisaList();
        const ready = list.filter((v) => v.status === "ready");
        const waiting = list.filter((v) => v.status !== "ready");

        if (cmd === "/start" || cmd === "/holat") {
          await tg("sendMessage", {
            chat_id: chatId,
            parse_mode: "HTML",
            text:
              `📊 <b>Umumiy holat</b>\n\n` +
              `✅ Tayyor: <b>${ready.length}</b>\n` +
              `⏳ Kutilmoqda: <b>${waiting.length}</b>\n` +
              `📁 Jami: <b>${list.length}</b>\n\n` +
              `<b>Buyruqlar:</b>\n` +
              `/tayyor — tayyorlar ro'yxati\n` +
              `/kutilmoqda — javob berilmaganlar\n` +
              `/tozalash — tayyorlarni o'chirish`,
          });
          return res.status(200).end();
        }

        if (cmd === "/tozalash") {
          if (!ready.length) {
            await tg("sendMessage", { chat_id: chatId, text: "O'chirish uchun tayyor so'rov yo'q." });
            return res.status(200).end();
          }
          // Xavfsizlik: darhol o'chirmaymiz — avval tasdiq so'raymiz.
          await tg("sendMessage", {
            chat_id: chatId,
            parse_mode: "HTML",
            text:
              `🗑 <b>${ready.length} ta TAYYOR so'rov o'chiriladi.</b>\n\n` +
              `Ular mijozlarning ilovasidan ham yo'qoladi.\n` +
              `⏳ Kutilmoqda holatidagilarga <b>tegilmaydi</b>.\n\n` +
              `Tasdiqlaysizmi?`,
            reply_markup: {
              inline_keyboard: [[
                { text: "🗑 Ha, o'chirilsin", callback_data: "purge:ready" },
                { text: "✖️ Bekor qilish", callback_data: "purge:cancel" },
              ]],
            },
          });
          return res.status(200).end();
        }

        const items = cmd === "/tayyor" ? ready : waiting;
        const title = cmd === "/tayyor" ? "✅ <b>Tayyor so'rovlar</b>" : "⏳ <b>Javob berilmaganlar</b>";
        if (!items.length) {
          await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: `${title}\n\nRo'yxat bo'sh.` });
          return res.status(200).end();
        }
        // Telegram bitta xabarda ~4096 belgi qabul qiladi — uzun ro'yxatni
        // bo'lib yuboramiz, shunda hech narsa kesilib qolmaydi.
        const lines = items.map((v, i) => {
          const bc = v.barcode ? `\n   📋 <code>${escapeHtml(v.barcode)}</code>` : "";
          return `${i + 1}. 📞 <code>${escapeHtml(v.phone || "—")}</code>${bc}\n   🕒 ${escapeHtml(v.date || "")}`;
        });
        let chunk = `${title} — ${items.length} ta\n\n`;
        for (const line of lines) {
          if (chunk.length + line.length > 3500) {
            await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: chunk });
            chunk = "";
          }
          chunk += line + "\n\n";
        }
        if (chunk.trim()) {
          await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: chunk });
        }
        return res.status(200).end();
      } catch (e) {
        console.error("[telegram-webhook] command error:", e && e.message);
        await tg("sendMessage", { chat_id: chatId, text: "Xatolik yuz berdi, qayta urinib ko'ring." });
        return res.status(200).end();
      }
    }
  }

  /* ===== TAYYORLARNI O'CHIRISH (tasdiqlangandan keyin) ===== */
  if (cq && cq.data && cq.data.startsWith("purge:")) {
    const action = cq.data.split(":")[1];
    await tg("answerCallbackQuery", { callback_query_id: cq.id });

    if (action === "cancel") {
      if (cq.message) {
        await tg("editMessageText", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: "✖️ Bekor qilindi. Hech narsa o'chirilmadi.",
        });
      }
      return res.status(200).end();
    }

    try {
      const list = await fetchVisaList();
      const ready = list.filter((v) => v.status === "ready");
      // FAQAT tayyor bo'lganlar o'chiriladi — qolganlariga tegilmaydi.
      const kept = list.filter((v) => v.status !== "ready");
      const saved = await saveVisaList(kept);

      // O'chirilganlarning push obunalarini ham tozalaymiz — keraksiz
      // yozuvlar to'planib qolmasligi uchun.
      if (saved && ready.length) {
        try {
          const removedIds = new Set(ready.map((v) => v.id));
          const subs = await fetchPushSubs();
          const keptSubs = subs.filter((s) => !removedIds.has(s.submissionId));
          if (keptSubs.length !== subs.length) await savePushSubs(keptSubs);
        } catch (e) {
          console.warn("[telegram-webhook] push subs cleanup failed:", e && e.message);
        }
      }

      if (cq.message) {
        await tg("editMessageText", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          parse_mode: "HTML",
          text: saved
            ? `🗑 <b>${ready.length} ta tayyor so'rov o'chirildi.</b>\n\n⏳ Qolgan: <b>${kept.length}</b> ta`
            : "⚠️ O'chirishda xatolik yuz berdi, qayta urinib ko'ring.",
        });
      }
      console.log("[telegram-webhook] purge ready:", { removed: ready.length, kept: kept.length, saved });
    } catch (e) {
      console.error("[telegram-webhook] purge error:", e && e.message);
    }
    return res.status(200).end();
  }

  if (cq && cq.data && cq.data.startsWith("status:")) {
    const ack = await tg("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "Qabul qilindi, yangilanmoqda…",
    });
    if (!ack || ack.ok !== true) {
      console.error("[telegram-webhook] answerCallbackQuery did not succeed — check TELEGRAM_BOT_TOKEN.");
    }

    try {
      const [, idStr, status] = cq.data.split(":");
      const id = parseInt(idStr, 10);

      let list = [];
      let item = null;
      for (let i = 0; i < 3; i++) {
        list = await fetchVisaList();
        item = list.find((n) => n.id === id);
        if (item) break;
        await sleep(400);
      }

      if (!item) {
        console.error("[telegram-webhook] visa submission id not found:", id);
        if (cq.message) {
          await tg("editMessageCaption", {
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            caption:
              (cq.message.caption || "") +
              "\n\n⚠️ Xatolik: bu so'rov bazada topilmadi (eski xabar bo'lishi mumkin).",
            reply_markup: cq.message.reply_markup,
          });
        }
        return res.status(200).end();
      }

      item.status = status;
      const saved = await saveVisaList(list);

      // Xabar rasm bilan bo'lsa — caption tahrirlanadi; matnli bo'lsa
      // (tezkor rejimda rasm keyinroq keladi) — matnning o'zi tahrirlanadi.
      const isPhotoMsg = !!(cq.message && cq.message.photo);
      const oldText = (cq.message && (cq.message.caption || cq.message.text)) || "";
      const cleanText = oldText.replace(/\n\nHolat:.*/s, "");
      const statusLine = status === "ready" ? "✅ Tayyor" : "⏳ Hali tayyor emas";
      const finalText = saved
        ? `${cleanText}\n\nHolat: ${statusLine}`
        : `${cleanText}\n\n⚠️ Saqlashda xatolik yuz berdi, qayta bosib ko'ring.`;

      if (cq.message) {
        await tg(isPhotoMsg ? "editMessageCaption" : "editMessageText", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          [isPhotoMsg ? "caption" : "text"]: finalText,
          reply_markup: cq.message.reply_markup,
        });
      }

      // ===== MIJOZGA AVTOMATIK BILDIRISHNOMA =====
      // Holat saqlangach, mijozning telefoniga push-bildirishnoma
      // yuboriladi — u saytni ochib turmagan bo'lsa ham ko'radi.
      // Bu SMS o'rnini bosadi va butunlay bepul.
      if (saved) {
        sendPushToClient(id, status).catch((err) =>
          console.warn("[telegram-webhook] push notification failed:", err && err.message)
        );
      }

      console.log("[telegram-webhook] status update complete:", { id, status, saved });
    } catch (e) {
      console.error("[telegram-webhook] unexpected error:", e && e.stack);
    }
    return res.status(200).end();
  }

  res.status(200).end();
}
