// /api/telegram-webhook.js — receives updates from Telegram when the admin
// taps the "Tayyor" / "Hali tayyor emas" inline buttons under a visa-check
// notification message, and updates that request's status in Upstash Redis
// (connected via Vercel Storage — same database used by /api/kv.js).
//
// SECURITY:
// 1. The bot token is read from the TELEGRAM_BOT_TOKEN environment variable
//    (never hardcoded), for the same reason as notify-telegram.js — a token
//    committed to a public repo gets scraped and hijacked within minutes.
// 2. This URL is public on the internet (Telegram must be able to reach
//    it), so anyone who finds it could otherwise POST fake button-press
//    payloads and silently flip the status of any visa request. To stop
//    that, Telegram lets you attach a "secret token" when you register the
//    webhook; Telegram then includes that same secret in a header on every
//    real request, and we reject anything that doesn't match. Set
//    TELEGRAM_WEBHOOK_SECRET below in Vercel to any random string of your
//    choosing, then register it with Telegram — see the one-time setup
//    instructions below.
//
// ---------------------------------------------------------------------
// ONE-TIME SETUP (only ever needs to be done once, or again if you rotate
// the secret). Replace YOUR_DOMAIN and YOUR_SECRET, then open this URL
// once in any browser:
//
//   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/telegram-webhook&secret_token=YOUR_SECRET
//
// Telegram will reply {"ok":true,"result":true,...} if it worked.
// (YOUR_SECRET must be the exact same value you set as the
// TELEGRAM_WEBHOOK_SECRET environment variable in Vercel.)
// ---------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

function redisConfig() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
  };
}

async function tg(method, payload) {
  if (!BOT_TOKEN) return;
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchVisaList() {
  const { url, token } = redisConfig();
  if (!url || !token) return [];
  const r = await fetch(`${url}/get/visa_submissions`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!r.ok) return [];
  const data = await r.json();
  if (!data.result) return [];
  try {
    return JSON.parse(data.result);
  } catch (e) {
    return [];
  }
}

async function saveVisaList(list) {
  const { url, token } = redisConfig();
  if (!url || !token) return false;
  const r = await fetch(`${url}/set/visa_submissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: JSON.stringify(list),
  });
  return r.ok;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).end(); // Telegram just needs a 200
  }

  // Reject anything that doesn't carry our secret — this is what stops a
  // random visitor (who might guess or find this URL) from forging status
  // updates. Telegram itself always sends this header once the webhook is
  // registered with secret_token (see setup instructions above).
  if (WEBHOOK_SECRET) {
    const incoming = req.headers["x-telegram-bot-api-secret-token"];
    if (incoming !== WEBHOOK_SECRET) {
      return res.status(401).end();
    }
  }

  try {
    const update = req.body;
    const cq = update && update.callback_query;
    if (cq && cq.data && cq.data.startsWith("status:")) {
      const [, idStr, status] = cq.data.split(":");
      const id = parseInt(idStr, 10);

      // A submission created moments ago might not have fully propagated yet
      // in rare cases — retry a few times with short waits before giving up.
      let list = [];
      let item = null;
      for (let i = 0; i < 4; i++) {
        list = await fetchVisaList();
        item = list.find((n) => n.id === id);
        if (item) break;
        await sleep(700);
      }

      if (!item) {
        await tg("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Xatolik: bu so'rov bazada topilmadi (eski xabar bo'lishi mumkin).",
          show_alert: true,
        });
        return res.status(200).end();
      }

      item.status = status;
      const saved = await saveVisaList(list);

      if (!saved) {
        await tg("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: "Xatolik: saqlashda muammo yuz berdi, qayta urinib ko'ring.",
          show_alert: true,
        });
        return res.status(200).end();
      }

      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: status === "ready" ? "Tayyor deb belgilandi ✅" : "Hali tayyor emas deb belgilandi",
      });

      const oldCaption = (cq.message && cq.message.caption) || "";
      const cleanCaption = oldCaption.replace(/\n\nHolat:.*/s, "");
      const statusLine = status === "ready" ? "✅ Tayyor" : "⏳ Hali tayyor emas";
      if (cq.message) {
        await tg("editMessageCaption", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          caption: `${cleanCaption}\n\nHolat: ${statusLine}`,
          reply_markup: cq.message.reply_markup,
        });
      }
    }
  } catch (e) {
    // swallow errors — Telegram will retry on non-200, we don't want retries piling up
  }

  res.status(200).end();
}
