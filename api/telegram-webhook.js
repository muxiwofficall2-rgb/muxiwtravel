// /api/telegram-webhook.js — receives updates from Telegram when the admin
// taps the "Tayyor" / "Hali tayyor emas" inline buttons under a visa-check
// notification message, and updates that request's status in kvdb.io.
//
// One-time setup (only ever needs to be done once): visit this URL once in
// any browser, replacing YOUR_DOMAIN with this site's real Vercel domain:
//
//   https://api.telegram.org/bot8949050831:AAHP91glGT-3nt7iKceUckAibvtfKohMGKc/setWebhook?url=https://YOUR_DOMAIN/api/telegram-webhook
//
// Telegram will reply {"ok":true,"result":true,...} if it worked.

const BOT_TOKEN = "8949050831:AAHP91glGT-3nt7iKceUckAibvtfKohMGKc";
const BUCKET = "EF2FFoE8tQX1FMenfGZdnK";

async function tg(method, payload) {
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
  const r = await fetch(`https://kvdb.io/${BUCKET}/visa_submissions`, { cache: "no-store" });
  return r.ok ? await r.json() : [];
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).end(); // Telegram just needs a 200
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
      const putRes = await fetch(`https://kvdb.io/${BUCKET}/visa_submissions`, {
        method: "PUT",
        body: JSON.stringify(list),
        cache: "no-store",
      });

      if (!putRes.ok) {
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
