// /api/telegram-webhook.js — receives updates from Telegram when the admin
// taps the "Tayyor" / "Hali tayyor emas" inline buttons under a visa-check
// notification message, and updates that request's status in Upstash Redis
// (connected via Vercel Storage — same database used by /api/kv.js).
//
// IMPORTANT UX FIX: Telegram shows a spinning "loading" state on a tapped
// button until OUR server calls answerCallbackQuery — and only for that
// specific call, nothing else. The previous version did the slow part
// (looking up the record in Redis, saving it, possibly retrying a few
// times) BEFORE answering, so on any small network hiccup the button would
// visibly hang. Now we answer FIRST — within milliseconds of receiving the
// tap — and do the actual database update afterward, then reflect the
// final result by editing the message caption a moment later. The button
// itself is never blocked on anything slow again.
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
//    TELEGRAM_WEBHOOK_SECRET in Vercel to any random string of your
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
  if (!BOT_TOKEN) return null;
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
    return await r.json().catch(() => null);
  } catch (e) {
    return null;
  }
}

async function fetchVisaList() {
  const { url, token } = redisConfig();
  if (!url || !token) return [];
  const r = await fetchWithTimeout(
    `${url}/get/visa_submissions`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
    6000
  );
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
  const r = await fetchWithTimeout(
    `${url}/set/visa_submissions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: JSON.stringify(list),
    },
    6000
  );
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

  const update = req.body;
  const cq = update && update.callback_query;

  if (cq && cq.data && cq.data.startsWith("status:")) {
    // STEP 1 — answer immediately, and WAIT for Telegram to confirm it
    // received the answer. This is the only network call that determines
    // how long the spinner stays on the button, so it happens before any
    // database work — not a fire-and-forget call, so there's no ambiguity
    // about whether it actually went out before we move on.
    await tg("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "Qabul qilindi, yangilanmoqda…",
    });

    // Respond to Telegram's webhook delivery right away too — everything
    // from here on runs as best-effort background work that updates the
    // message a moment later, decoupled from the tap itself.
    res.status(200).end();

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
        return;
      }

      item.status = status;
      const saved = await saveVisaList(list);

      const oldCaption = (cq.message && cq.message.caption) || "";
      const cleanCaption = oldCaption.replace(/\n\nHolat:.*/s, "");
      const statusLine = status === "ready" ? "✅ Tayyor" : "⏳ Hali tayyor emas";
      const finalCaption = saved
        ? `${cleanCaption}\n\nHolat: ${statusLine}`
        : `${cleanCaption}\n\n⚠️ Saqlashda xatolik yuz berdi, qayta bosib ko'ring.`;

      if (cq.message) {
        await tg("editMessageCaption", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          caption: finalCaption,
          reply_markup: cq.message.reply_markup,
        });
      }
    } catch (e) {
      // Already answered the tap and responded to Telegram — nothing left
      // to do but swallow the error so it doesn't create a retry storm.
    }
    return;
  }

  res.status(200).end();
}
